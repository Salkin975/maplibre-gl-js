import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import st from 'st';
import minimist from 'minimist';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {summaryStatistics} from '../lib/statistics.ts';
import type {CDPSession, Page, Protocol, WebWorker} from 'puppeteer';

const PORT = 2902;
const TILE_SERVER = 'http://localhost:8080';

/** The view every build cold-loads: Cologne, a dense urban extent of the North Rhine-Westphalia tiles. */
const CENTER: [number, number] = [6.96, 50.94];

/** One build loaded with one tile format of one style, which is one row of the results. */
type Variant = {
    id: string;
    build: string;
    format: string;
    styleUrl: string;
};

/** What one cold load of a variant cost, in milliseconds. */
type Sample = {
    coldLoad: number;
    tileLoad: number;
    workerBusy: number;
    mainBusy: number;
};

type Metric = keyof Sample;

const METRICS: Array<{id: Metric; label: string}> = [
    {id: 'coldLoad', label: 'cold load'},
    {id: 'tileLoad', label: 'tile load'},
    {id: 'workerBusy', label: 'worker'},
    {id: 'mainBusy', label: 'main'}
];

/**
 * Lists the rows to measure: `main` with MVT tiles as the reference, then every build once per MLT
 * format, so each build is compared on the same tiles as `main`.
 */
function createVariants(builds: string[], formats: string[], style: string): Variant[] {
    const styleUrl = (format: string) => `${TILE_SERVER}/style/${style}/${format}.json`;
    const variants: Variant[] = [{id: 'main/mvt', build: 'main', format: 'mvt', styleUrl: styleUrl('mvt')}];
    for (const format of formats) {
        for (const build of builds) {
            variants.push({id: `${build}/${format}`, build, format, styleUrl: styleUrl(format)});
        }
    }
    return variants;
}

/** Serves a blank page with a map container, and every build directory under `/builds`. */
function createServer(buildsDir: string): Promise<http.Server> {
    const buildMount = st({path: path.resolve(buildsDir), url: '/builds', cors: true, passthrough: true});
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.url === '/') {
            res.setHeader('content-type', 'text/html');
            res.end('<div id="map" style="width:1280px;height:1024px"></div>');
            return;
        }
        buildMount(req, res, () => {
            res.writeHead(404);
            res.end('');
        });
    });
    return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/**
 * Imports every build into the page under its own name and fetches every style, and keeps a hidden
 * map per build alive so that no build's worker pool is torn down between the maps that are measured.
 */
function loadBuilds(page: Page, builds: string[], variants: Variant[]): Promise<void> {
    const styleUrls = Object.fromEntries(variants.map(v => [v.id, v.styleUrl]));
    return page.evaluate(async (origin, builds, styleUrls) => {
        const libs: Record<string, any> = {};
        const styles: Record<string, unknown> = {};
        for (const build of builds) {
            libs[build] = await import(`${origin}/builds/${build}/maplibre-gl.mjs`);
            const container = document.createElement('div');
            container.style.cssText = 'position:absolute;width:16px;height:16px;visibility:hidden';
            document.body.appendChild(container);
            new libs[build].Map({container, style: {version: 8, sources: {}, layers: []}});
        }
        for (const [id, url] of Object.entries(styleUrls)) {
            styles[id] = await (await fetch(url)).json();
        }
        Object.assign(globalThis, {libs, styles});
    }, `http://localhost:${PORT}`, builds, styleUrls);
}

/**
 * Cold-loads a fresh map of one variant at `center` and `zoom` and reports the time to idle and the
 * mean time from a tile's request to its arrival. It runs in the page, so it names no outer variable.
 */
function coldLoadInPage(page: Page, variant: Variant, zoom: number): Promise<{coldLoad: number; tileLoad: number}> {
    return page.evaluate(async (id, build, zoom, center) => {
        const {libs, styles} = globalThis as any;
        const starts = new Map<string, number>();
        const tileLoadTimes: number[] = [];
        const tileKey = (e: any) => `${e.sourceId}/${e.tile.tileID.key}`;

        const start = performance.now();
        const map = new libs[build].Map({container: 'map', style: structuredClone(styles[id]), center, zoom});
        map.on('dataloading', (e: any) => {
            if (e.tile) starts.set(tileKey(e), performance.now());
        });
        map.on('data', (e: any) => {
            if (!e.tile || e.tile.state !== 'loaded' || !starts.has(tileKey(e))) return;
            tileLoadTimes.push(performance.now() - starts.get(tileKey(e)));
            starts.delete(tileKey(e));
        });
        await new Promise(resolve => map.once('idle', resolve));
        const coldLoad = performance.now() - start;
        map.remove();

        const tileLoad = tileLoadTimes.reduce((a, b) => a + b, 0) / Math.max(tileLoadTimes.length, 1);
        return {coldLoad, tileLoad};
    }, variant.id, variant.build, zoom, CENTER);
}

/**
 * The milliseconds a thread spent running JavaScript or collecting garbage in a CPU profile. Idle time
 * and `(program)`, which is native work outside any script such as the main thread's software WebGL
 * raster, are left out because they do not depend on the build. The profile is a sample, so the figure
 * is accurate to the sampling interval per sample.
 */
function busyMilliseconds(profile: Protocol.Profiler.Profile): number {
    const excluded = new Set(profile.nodes.filter(node => ['(idle)', '(program)'].includes(node.callFrame.functionName)).map(node => node.id));
    let microseconds = 0;
    for (let i = 0; i < profile.samples.length - 1; i++) {
        if (!excluded.has(profile.samples[i])) microseconds += profile.timeDeltas[i + 1];
    }
    return microseconds / 1000;
}

/** Starts a CPU profile on each thread: the page and every worker any build has started. */
async function startProfiles(threads: CDPSession[]): Promise<void> {
    await Promise.all(threads.map(async (thread) => {
        await thread.send('Profiler.enable');
        await thread.send('Profiler.setSamplingInterval', {interval: 1000});
        await thread.send('Profiler.start');
    }));
}

async function stopProfile(thread: CDPSession): Promise<number> {
    const {profile} = await thread.send('Profiler.stop');
    return busyMilliseconds(profile);
}

/** Cold-loads the variant once with the page and all workers profiled, and returns what it cost. */
async function measureOnce(page: Page, pageThread: CDPSession, variant: Variant, zoom: number): Promise<Sample> {
    const workerThreads = page.workers().map((worker: WebWorker) => worker.client);
    await startProfiles([pageThread, ...workerThreads]);
    const {coldLoad, tileLoad} = await coldLoadInPage(page, variant, zoom);
    const mainBusy = await stopProfile(pageThread);
    const workerBusy = (await Promise.all(workerThreads.map(stopProfile))).reduce((a, b) => a + b, 0);
    return {coldLoad, tileLoad, workerBusy, mainBusy};
}

function trimmedMean(samples: number[]): number {
    return summaryStatistics(samples).trimmedMean;
}

/** One line per variant with each metric's trimmed mean and its change against `reference`. */
function formatTable(variants: Variant[], samples: Record<string, Sample[]>, reference: string): string {
    const means = (id: string, metric: Metric) => trimmedMean(samples[id].map(sample => sample[metric]));
    const header = ['', ...METRICS.map(metric => `${metric.label} (ms, vs ${reference})`)];
    const rows = variants.map((variant) => [
        variant.id,
        ...METRICS.map(({id: metric}) => {
            const mean = means(variant.id, metric);
            if (variant.id === reference) return mean.toFixed(0);
            const delta = (mean - means(reference, metric)) / means(reference, metric) * 100;
            return `${mean.toFixed(0)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`;
        })
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    return [header, ...rows]
        .map(row => row.map((cell, i) => cell.padEnd(widths[i] + 2)).join('').trimEnd())
        .join('\n');
}

/**
 * Measures how much worker and main-thread time each build under `--builds-dir` spends cold-loading
 * the same view, with the variants interleaved and their order rotated every round so that drift in
 * the machine or the tile server reaches all of them equally. The tile server must be running.
 *
 * Options: `--builds` (comma-separated directory names), `--style` (a style name on the tile server),
 * `--formats` (comma-separated MLT style files, such as `mlt,mlt-pre-tess`), `--zoom`, `--iterations`
 * and `--out` (the directory the JSON samples are written to).
 */
async function main() {
    const argv = minimist(process.argv.slice(2), {
        string: ['builds', 'formats', 'style', 'builds-dir', 'out'],
        default: {
            builds: 'main,gl1,gl2,gl3,gl4-fill,gl5-line,gl6-symbol',
            formats: 'mlt',
            style: 'osm-bright',
            'builds-dir': 'bench-builds',
            out: 'bench-results',
            zoom: 12,
            iterations: 20
        }
    });
    const builds: string[] = argv.builds.split(',');
    const variants = createVariants(builds, argv.formats.split(','), argv.style);
    const iterations = Number(argv.iterations);
    const zoom = Number(argv.zoom);

    const missing = builds.filter(build => !fs.existsSync(path.join(argv['builds-dir'], build, 'maplibre-gl.mjs')));
    if (missing.length > 0) throw new Error(`no build in ${argv['builds-dir']} for: ${missing.join(', ')}`);
    const tileServer = await fetch(variants[0].styleUrl).catch(() => null);
    if (!tileServer?.ok) throw new Error(`the tile server does not answer at ${variants[0].styleUrl}`);

    const server = await createServer(argv['builds-dir']);
    const browser = await launchPuppeteer();
    try {
        const page = await browser.newPage();
        await page.setViewport({width: 1280, height: 1024});
        await page.goto(`http://localhost:${PORT}/`);
        await page.addStyleTag({url: `http://localhost:${PORT}/builds/${builds[0]}/maplibre-gl.css`});
        await loadBuilds(page, builds, variants);
        const pageThread = await page.createCDPSession();

        const samples: Record<string, Sample[]> = Object.fromEntries(variants.map(v => [v.id, []]));
        for (const variant of variants) await measureOnce(page, pageThread, variant, zoom);
        for (let round = 0; round < iterations; round++) {
            const rotation = round % variants.length;
            for (const variant of [...variants.slice(rotation), ...variants.slice(0, rotation)]) {
                samples[variant.id].push(await measureOnce(page, pageThread, variant, zoom));
            }
        }

        console.log(`${argv.style} at z${zoom}, ${iterations} rounds, trimmed mean\n`);
        console.log(formatTable(variants, samples, `main/${argv.formats.split(',')[0]}`));
        fs.mkdirSync(argv.out, {recursive: true});
        const file = path.join(argv.out, 'builds-latest.json');
        fs.writeFileSync(file, JSON.stringify({style: argv.style, zoom, iterations, samples}, null, 2));
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
