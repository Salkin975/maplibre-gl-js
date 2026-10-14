import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import st from 'st';
import minimist from 'minimist';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import type {Page} from 'puppeteer';

const PORT = 2903;
const TILE_SERVER = 'http://localhost:8080';

/** The view every variant cold-loads: Cologne, a dense urban extent of the North Rhine-Westphalia tiles. */
const CENTER: [number, number] = [6.96, 50.94];

/** One style in one tile format, such as `osm-bright/mlt`. */
type Variant = {
    id: string;
    styleUrl: string;
};

/** One layer's entry in a tile's line, see `TileTimings` in `src/source/worker_timing.ts`. */
type LayerLine = {
    layer: string;
    type: string;
    columnar: boolean;
    createBucket: number;
    populate: number;
    addFeatures: number;
    phases: Record<string, number>;
};

/** One tile's line of the worker timing log, labelled with the variant and the round it was measured in. */
type TileLine = {
    style: string;
    iteration: number;
    tile: string;
    encoding: string;
    total: number;
    dependencies: number;
    layers: LayerLine[];
};

/** What one kind of bucket cost over all tiles of a variant, in milliseconds. */
type BucketTotals = {
    count: number;
    populate: number;
    addFeatures: number;
    phases: Record<string, number>;
};

/** Serves a blank page with a map container, and the build under `/dist`. */
function createServer(distDir: string): Promise<http.Server> {
    const distMount = st({path: path.resolve(distDir), url: '/dist', cors: true, passthrough: true});
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.url === '/') {
            res.setHeader('content-type', 'text/html');
            res.end('<div id="map" style="width:1280px;height:1024px"></div>');
            return;
        }
        distMount(req, res, () => {
            res.writeHead(404);
            res.end('');
        });
    });
    return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/**
 * Imports the build and fetches every style, and keeps a hidden map alive so that the worker pool, and
 * the timing log each worker holds, outlives the maps that are measured.
 */
function loadBuild(page: Page, variants: Variant[]): Promise<void> {
    const styleUrls = Object.fromEntries(variants.map(v => [v.id, v.styleUrl]));
    return page.evaluate(async (origin, styleUrls) => {
        const lib = await import(`${origin}/dist/maplibre-gl.mjs`);
        const container = document.createElement('div');
        container.style.cssText = 'position:absolute;width:16px;height:16px;visibility:hidden';
        document.body.appendChild(container);
        new lib.Map({container, style: {version: 8, sources: {}, layers: []}});

        const styles: Record<string, unknown> = {};
        for (const [id, url] of Object.entries(styleUrls)) {
            styles[id] = await (await fetch(url)).json();
        }
        Object.assign(globalThis, {lib, styles});
    }, `http://localhost:${PORT}`, styleUrls);
}

/** Cold-loads a fresh map of one variant to its first idle and removes it again. */
function coldLoadInPage(page: Page, variant: Variant, zoom: number): Promise<void> {
    return page.evaluate(async (id, zoom, center) => {
        const {lib, styles} = globalThis as any;
        const map = new lib.Map({container: 'map', style: structuredClone(styles[id]), center, zoom});
        await new Promise(resolve => map.once('idle', resolve));
        map.remove();
    }, variant.id, zoom, CENTER);
}

/** Takes every line the workers have logged since the last call, and leaves their logs empty. */
async function drainTimingLog(page: Page): Promise<Array<Omit<TileLine, 'style' | 'iteration'>>> {
    const logs = await Promise.all(page.workers().map(worker => worker.evaluate(() => {
        const log: string[] = (globalThis as any).__workerTimingLog ?? [];
        (globalThis as any).__workerTimingLog = [];
        return log;
    })));
    return logs.flat().map(line => JSON.parse(line));
}

/** Adds one layer's entry to the totals of its kind of bucket, keyed like `line/columnar`. */
function addLayer(totals: Record<string, BucketTotals>, layer: LayerLine): void {
    const key = `${layer.type}/${layer.columnar ? 'columnar' : 'row'}`;
    const bucket = totals[key] ??= {count: 0, populate: 0, addFeatures: 0, phases: {}};
    bucket.count++;
    bucket.populate += layer.populate;
    bucket.addFeatures += layer.addFeatures;
    for (const [phase, ms] of Object.entries(layer.phases)) {
        bucket.phases[phase] = (bucket.phases[phase] ?? 0) + ms;
    }
}

/**
 * Sums each variant's parse time without the wait for glyphs, icons, patterns and dashes, and what each
 * kind of bucket cost of it, split into the phases the bucket records.
 */
function formatSummary(variants: Variant[], lines: TileLine[]): string {
    const out: string[] = [];
    for (const variant of variants) {
        const tiles = lines.filter(line => line.style === variant.id);
        const parse = tiles.reduce((sum, tile) => sum + tile.total - tile.dependencies, 0);
        const wait = tiles.reduce((sum, tile) => sum + tile.dependencies, 0);
        out.push(`${variant.id}: ${tiles.length} tiles, parse ${parse.toFixed(0)} ms, dependency wait ${wait.toFixed(0)} ms`);

        const totals: Record<string, BucketTotals> = {};
        for (const tile of tiles) {
            for (const layer of tile.layers) addLayer(totals, layer);
        }
        const kinds = Object.entries(totals).sort(([, a], [, b]) => (b.populate + b.addFeatures) - (a.populate + a.addFeatures));
        for (const [kind, bucket] of kinds) {
            const phases = Object.entries(bucket.phases).map(([phase, ms]) => `${phase} ${ms.toFixed(0)}`).join(', ');
            out.push(`  ${kind.padEnd(16)} populate ${bucket.populate.toFixed(0).padStart(6)}  addFeatures ${bucket.addFeatures.toFixed(0).padStart(6)}${phases ? `  (${phases})` : ''}`);
        }
    }
    return out.join('\n');
}

/**
 * Cold-loads every style in every tile format with the build in `--dist` and collects the lines that
 * `WorkerTile.parse()` appends to each worker's timing log, so that the time a tile spends in the worker
 * can be split by bucket and by phase. The build must have `LOG_WORKER_TIMING` switched on, and the tile
 * server must be running. The variants are interleaved and their order rotated every round, after one
 * round that is not recorded.
 *
 * Options: `--dist` (the build directory), `--styles` and `--formats` (comma-separated names on the tile
 * server), `--zoom`, `--iterations` and `--out` (the directory the JSON lines are written to).
 */
async function main() {
    const argv = minimist(process.argv.slice(2), {
        string: ['dist', 'styles', 'formats', 'out'],
        default: {
            dist: 'dist',
            styles: 'osm-bright,positron',
            formats: 'mvt,mlt',
            out: 'bench-results',
            zoom: 12,
            iterations: 8
        }
    });
    const variants: Variant[] = argv.styles.split(',').flatMap((style: string) => argv.formats.split(',').map((format: string) => ({
        id: `${style}/${format}`,
        styleUrl: `${TILE_SERVER}/style/${style}/${format}.json`
    })));
    const iterations = Number(argv.iterations);
    const zoom = Number(argv.zoom);

    if (!fs.existsSync(path.join(argv.dist, 'maplibre-gl.mjs'))) throw new Error(`no build in ${argv.dist}`);
    const tileServer = await fetch(variants[0].styleUrl).catch(() => null);
    if (!tileServer?.ok) throw new Error(`the tile server does not answer at ${variants[0].styleUrl}`);

    const server = await createServer(argv.dist);
    const browser = await launchPuppeteer();
    try {
        const page = await browser.newPage();
        await page.setViewport({width: 1280, height: 1024});
        await page.goto(`http://localhost:${PORT}/`);
        await loadBuild(page, variants);

        for (const variant of variants) await coldLoadInPage(page, variant, zoom);
        await drainTimingLog(page);

        const lines: TileLine[] = [];
        for (let iteration = 0; iteration < iterations; iteration++) {
            const rotation = iteration % variants.length;
            for (const variant of [...variants.slice(rotation), ...variants.slice(0, rotation)]) {
                await coldLoadInPage(page, variant, zoom);
                const tiles = await drainTimingLog(page);
                lines.push(...tiles.map(tile => ({style: variant.id, iteration, ...tile})));
            }
        }
        if (lines.length === 0) throw new Error('the workers logged no tiles; is LOG_WORKER_TIMING switched on in the build?');

        console.log(`z${zoom}, ${iterations} rounds, summed over all tiles\n`);
        console.log(formatSummary(variants, lines));
        fs.mkdirSync(argv.out, {recursive: true});
        const file = path.join(argv.out, 'worker-timing.jsonl');
        fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
        console.log(`\nwrote ${file}`);
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch((error) => {
    console.error(`${error}`);
    process.exit(1);
});
