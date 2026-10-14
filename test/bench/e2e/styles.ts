import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import st from 'st';
import minimist from 'minimist';
import * as d3 from 'd3';
import {launchPuppeteer} from '../../integration/lib/puppeteer_config.ts';
import {kde, regression, summaryStatistics, type Measurement, type RegressionResults, type Summary} from '../lib/statistics.ts';
import type {Browser, CDPSession, Page, WebWorker} from 'puppeteer';

const PORT = 2901;
const STYLE_BASE = 'http://localhost:8080/style/osm-bright';

/** A library build loaded with one style. `old` and `new` name the two build directories. */
type Variant = {
    id: string;
    label: string;
    build: 'old' | 'new';
    styleUrl: string;
};

type Location = {
    name: string;
    zoom: number;
    center: [number, number];
};

type MetricId = 'layout-cold-load' | 'layout-worker-cpu' | 'layout-main-cpu' | 'layout-tile-load' | 'paint';

/** The raw samples one variant produced at one location, in milliseconds. */
type RawSamples = {
    coldLoad: number[];
    workerCpu: number[];
    mainCpu: number[];
    tileLoad: number[];
    paint: Measurement[];
};

/** What the results page draws for one variant of one metric at one location. */
type VariantResult = {
    samples: number[];
    summary: Summary;
    regression?: RegressionResults;
    density: Array<[number, number]>;
};

const VARIANTS: Variant[] = [
    {id: 'mvt', label: 'MVT', build: 'new', styleUrl: `${STYLE_BASE}/mvt.json`},
    {id: 'mlt-old', label: 'MLT (old)', build: 'old', styleUrl: `${STYLE_BASE}/mlt.json`},
    {id: 'mlt-new', label: 'MLT (new)', build: 'new', styleUrl: `${STYLE_BASE}/mlt.json`},
    {id: 'mlt-new-pre-tess', label: 'MLT (new, pre-tessellated)', build: 'new', styleUrl: `${STYLE_BASE}/mlt-pre-tess.json`}
];

const METRICS: Array<{id: MetricId; label: string}> = [
    {id: 'layout-cold-load', label: 'Layout: cold load to idle'},
    {id: 'layout-worker-cpu', label: 'Layout: worker busy time'},
    {id: 'layout-main-cpu', label: 'Layout: main thread script time'},
    {id: 'layout-tile-load', label: 'Layout: mean tile load time'},
    {id: 'paint', label: 'Paint: repaint time'}
];

/** North Rhine-Westphalia, which is the extent the tile sources serve. */
const LOCATIONS: Location[] = [
    {name: 'Cologne, dense urban, z8', zoom: 8, center: [6.96, 50.94]},
    {name: 'Cologne, dense urban, z10', zoom: 10, center: [6.96, 50.94]},
    {name: 'Cologne, dense urban, z12', zoom: 12, center: [6.96, 50.94]},
    {name: 'Cologne, dense urban, z14 (max)', zoom: 14, center: [6.96, 50.94]},
    {name: 'Eifel, sparse rural, z10', zoom: 10, center: [6.4, 50.55]},
    {name: 'Eifel, sparse rural, z12', zoom: 12, center: [6.4, 50.55]},
    {name: 'Ruhr area, polycentric, z9', zoom: 9, center: [7.2, 51.5]},
    {name: 'Sauerland, mountainous, z11', zoom: 11, center: [8.4, 51.15]}
];

function createServer(oldDist: string, newDist: string): Promise<http.Server> {
    const pageMount = st({path: 'test/bench/e2e', url: '/e2e', cors: true, passthrough: true});
    const oldMount = st({path: path.resolve(oldDist), url: '/builds/old', cors: true, passthrough: true});
    const newMount = st({path: path.resolve(newDist), url: '/builds/new', cors: true, passthrough: true});
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        pageMount(req, res, () => oldMount(req, res, () => newMount(req, res, () => {
            res.writeHead(404);
            res.end('');
        })));
    });
    return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/**
 * Loads the build into the page and keeps a hidden map alive for as long as the page lives, so that the
 * worker pool is not torn down between the maps that are measured.
 */
function loadBuild(page: Page, variant: Variant): Promise<void> {
    const bundleUrl = `http://localhost:${PORT}/builds/${variant.build}/maplibre-gl.mjs`;
    return page.evaluate(async (bundleUrl, styleUrl) => {
        const maplibregl = await import(bundleUrl);
        const benchStyle = await (await fetch(styleUrl)).json();
        const container = document.createElement('div');
        container.style.cssText = 'position:absolute;width:16px;height:16px;visibility:hidden';
        document.body.appendChild(container);
        const keepAlive = new maplibregl.Map({container, style: {version: 8, sources: {}, layers: []}});
        Object.assign(globalThis, {maplibregl, benchStyle, keepAlive});
    }, bundleUrl, variant.styleUrl);
}

/** Cold-loads a fresh map and reports the time to idle and the mean time from a tile's request to its arrival. */
function runLayoutIteration(page: Page, location: Location): Promise<{coldLoad: number; tileLoad: number | null}> {
    return page.evaluate(async (location) => {
        const {maplibregl, benchStyle} = globalThis as any;
        const starts = new Map<string, number>();
        const tileLoadTimes: number[] = [];
        const tileKey = (e: any) => `${e.sourceId}/${e.tile.tileID.key}`;

        const start = performance.now();
        const map = new maplibregl.Map({
            container: 'map',
            style: structuredClone(benchStyle),
            center: location.center,
            zoom: location.zoom
        });
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

        const tileLoad = tileLoadTimes.length > 0 ? tileLoadTimes.reduce((a, b) => a + b, 0) / tileLoadTimes.length : null;
        return {coldLoad, tileLoad};
    }, location);
}

/**
 * Repaints an idle map in batches, growing the batch until it takes long enough to time, and returns the
 * batches. A render ends with a pixel read so that the GPU work is part of the measured time.
 */
function runPaint(page: Page, location: Location, minimumMeasurements: number): Promise<Measurement[]> {
    return page.evaluate(async (location, minimumMeasurements) => {
        const {maplibregl, benchStyle} = globalThis as any;
        const map = new maplibregl.Map({
            container: 'map',
            style: structuredClone(benchStyle),
            center: location.center,
            zoom: location.zoom
        });
        await new Promise(resolve => map.once('idle', resolve));

        const gl = map.painter.context.gl;
        const pixel = new Uint8Array(4);
        function render() {
            map._styleDirty = true;
            map._sourcesDirty = true;
            map._render();
            gl.finish();
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        }

        const minimumBatchTime = 20;
        const measurements: Array<{time: number; iterations: number}> = [];
        let iterations = 1;
        let elapsed = 0;
        render();
        while (elapsed < 500 || measurements.length <= minimumMeasurements) {
            const start = performance.now();
            for (let i = 0; i < iterations; i++) render();
            const time = performance.now() - start;
            elapsed += time;
            if (time >= minimumBatchTime) {
                measurements.push({time, iterations});
            } else {
                iterations = Math.floor((iterations + 1) * 1.2);
            }
        }
        map.remove();
        return measurements;
    }, location, minimumMeasurements);
}

/**
 * Waits for the map's workers to exist, prepares each for sampling and returns them. Worker busy time
 * would read as zero without a worker to sample, so a page that never starts one is an error.
 */
async function instrumentWorkers(page: Page): Promise<WebWorker[]> {
    for (let attempt = 0; attempt < 50 && page.workers().length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const workers = page.workers();
    if (workers.length === 0) throw new Error('the page started no worker to profile');
    for (const worker of workers) {
        await worker.client.send('Profiler.enable');
        await worker.client.send('Profiler.setSamplingInterval', {interval: 100});
    }
    return workers;
}

function startWorkerProfiles(workers: WebWorker[]): Promise<unknown> {
    return Promise.all(workers.map(worker => worker.client.send('Profiler.start')));
}

/**
 * Stops the workers' profiles and returns the milliseconds the workers spent running, which is every
 * sampled interval that was not idle. The profile is a sample, so the figure is accurate to the sampling
 * interval per sample and not to the microsecond.
 */
async function stopWorkerProfiles(workers: WebWorker[]): Promise<number> {
    let microseconds = 0;
    for (const worker of workers) {
        const {profile} = await worker.client.send('Profiler.stop');
        const idleNodes = new Set(profile.nodes.filter(node => node.callFrame.functionName === '(idle)').map(node => node.id));
        for (let i = 0; i < profile.samples.length - 1; i++) {
            if (!idleNodes.has(profile.samples[i])) microseconds += profile.timeDeltas[i + 1];
        }
    }
    return microseconds / 1000;
}

/**
 * Starts a CPU profile of the page's main thread. The session is the page's own, so only the thread
 * that runs the map's scripts is profiled, not the workers.
 */
function startMainProfile(session: CDPSession): Promise<unknown> {
    return session.send('Profiler.start');
}

/**
 * Stops the main thread's profile and returns the milliseconds it spent running scripts or collecting
 * garbage. Idle time and `(program)`, which is native work outside any script such as the software WebGL
 * raster, are left out because they do not depend on the library build.
 */
async function stopMainProfile(session: CDPSession): Promise<number> {
    const {profile} = await session.send('Profiler.stop');
    const excluded = new Set(profile.nodes.filter(node => ['(idle)', '(program)'].includes(node.callFrame.functionName)).map(node => node.id));
    let microseconds = 0;
    for (let i = 0; i < profile.samples.length - 1; i++) {
        if (!excluded.has(profile.samples[i])) microseconds += profile.timeDeltas[i + 1];
    }
    return microseconds / 1000;
}

async function measureVariant(browser: Browser, variant: Variant, location: Location, iterations: number, paintMeasurements: number): Promise<RawSamples> {
    const page = await browser.newPage();
    await page.setViewport({width: 1280, height: 1024});
    try {
        await page.goto(`http://localhost:${PORT}/e2e/index.html`, {waitUntil: 'load'});
        await page.addStyleTag({url: `http://localhost:${PORT}/builds/new/maplibre-gl.css`});
        await loadBuild(page, variant);
        const workers = await instrumentWorkers(page);
        const samples: RawSamples = {coldLoad: [], workerCpu: [], mainCpu: [], tileLoad: [], paint: []};
        const mainSession = await page.createCDPSession();
        await mainSession.send('Profiler.enable');
        await mainSession.send('Profiler.setSamplingInterval', {interval: 100});

        await runLayoutIteration(page, location);
        for (let i = 0; i < iterations; i++) {
            const {coldLoad, tileLoad} = await runLayoutIteration(page, location);
            samples.coldLoad.push(coldLoad);
            if (tileLoad !== null) samples.tileLoad.push(tileLoad);
        }
        for (let i = 0; i < iterations; i++) {
            await startWorkerProfiles(workers);
            await runLayoutIteration(page, location);
            samples.workerCpu.push(await stopWorkerProfiles(workers));
        }
        for (let i = 0; i < iterations; i++) {
            await startMainProfile(mainSession);
            await runLayoutIteration(page, location);
            samples.mainCpu.push(await stopMainProfile(mainSession));
        }
        samples.paint = await runPaint(page, location, paintMeasurements);
        return samples;
    } finally {
        await page.close();
    }
}

/** Summarises samples, and fits a regression when they are timed batches. */
function summarise(samples: number[], measurements?: Measurement[]): VariantResult {
    const summary = summaryStatistics(samples);
    const upper = Math.min(summary.max, summary.q2 + 3 * summary.iqr);
    const ticks = d3.scaleLinear().domain([summary.min, upper]).nice().ticks(50);
    return {
        samples,
        summary,
        regression: measurements ? regression(measurements) : undefined,
        density: kde(samples, summary, ticks)
    };
}

function toResults(raw: RawSamples): Record<MetricId, VariantResult> {
    return {
        'layout-cold-load': summarise(raw.coldLoad),
        'layout-worker-cpu': summarise(raw.workerCpu),
        'layout-main-cpu': summarise(raw.mainCpu),
        'layout-tile-load': summarise(raw.tileLoad),
        'paint': summarise(raw.paint.map(m => m.time / m.iterations), raw.paint)
    };
}

async function main() {
    const argv = minimist(process.argv.slice(2), {
        default: {iterations: 20, 'paint-measurements': 210, 'old-dist': 'bench-builds/old', 'new-dist': 'dist', out: 'bench-results'}
    });
    const iterations = Number(argv.iterations);
    const paintMeasurements = Number(argv['paint-measurements']);
    const locations = LOCATIONS.slice(0, Number(argv.locations ?? LOCATIONS.length));

    const server = await createServer(argv['old-dist'], argv['new-dist']);
    const browser = await launchPuppeteer();
    const results: Array<{location: Location; metric: {id: MetricId; label: string}; variants: Record<string, VariantResult>}> = [];
    try {
        for (const location of locations) {
            const perVariant: Record<string, Record<MetricId, VariantResult>> = {};
            for (const variant of VARIANTS) {
                console.error(`${location.name} | ${variant.label}`);
                perVariant[variant.id] = toResults(await measureVariant(browser, variant, location, iterations, paintMeasurements));
            }
            for (const metric of METRICS) {
                const variants = Object.fromEntries(VARIANTS.map(variant => [variant.id, perVariant[variant.id][metric.id]]));
                results.push({location, metric, variants});
            }
        }
        const report = {
            generatedAt: new Date().toISOString(),
            machine: `${os.cpus()[0].model}, node ${process.version}, ${await browser.version()}`,
            iterations,
            paintMeasurements,
            builds: {old: argv['old-dist'], new: argv['new-dist']},
            variants: VARIANTS.map(({id, label}) => ({id, label})),
            metrics: METRICS,
            results
        };
        fs.mkdirSync(argv.out, {recursive: true});
        const file = path.join(argv.out, `styles-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(report));
        fs.copyFileSync(file, path.join(argv.out, 'styles-latest.json'));
        console.log(`wrote ${file}`);
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch((error) => {
    console.error(`${error}`);
    process.exit(1);
});
