import {writeFileSync} from 'fs';
import {Session} from 'node:inspector/promises';
import {test} from 'vitest';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {derefLayers} from '@maplibre/maplibre-gl-style-spec';
import {WorkerTile} from './worker_tile.ts';
import {MLTVectorTile} from './vector_tile_mlt.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {actor} from '../../test/bench/lib/parse_tile.ts';

import type {StyleSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileLike} from '@maplibre/vt-pbf';

const TILE_SERVER = 'http://localhost:8080';

/** The z12 tiles a 1280×1024 map of Cologne at zoom 12 loads, the view the e2e benchmarks use. */
const TILES = [
    '12/2127/1372', '12/2126/1372', '12/2127/1371', '12/2127/1373', '12/2126/1373', '12/2126/1371',
    '12/2128/1372', '12/2128/1371', '12/2125/1372', '12/2125/1373', '12/2125/1371', '12/2128/1373'
];

const STYLES = ['osm-bright', 'positron'];

/** Each tile format the tile server serves, with the file extension of its tiles. */
const FORMATS = [{format: 'mvt', extension: 'pbf'}, {format: 'mlt', extension: 'mlt'}];

const ROUNDS = 20;

/** One style in one tile format, with its tiles read into memory. */
type Variant = {
    id: string;
    format: string;
    layerIndex: StyleLayerIndex;
    tiles: Array<{tileID: OverscaledTileID; buffer: ArrayBuffer}>;
};

/** One layer's entry in a line of the worker timing log, see `TileTimings` in `worker_timing.ts`. */
type LayerTiming = {
    type: string;
    columnar: boolean;
    populate: number;
    addFeatures: number;
    phases: Record<string, number>;
};

/** What one kind of bucket, keyed like `line/columnar`, cost over all rounds, in milliseconds. */
type BucketTotals = Record<string, {populate: number; addFeatures: number; phases: Record<string, number>}>;

async function fetchStyle(style: string, format: string): Promise<StyleSpecification | undefined> {
    const response = await fetch(`${TILE_SERVER}/style/${style}/${format}.json`).catch(() => undefined);
    return response?.ok ? response.json() : undefined;
}

async function fetchTile(format: string, extension: string, tile: string): Promise<ArrayBuffer> {
    const response = await fetch(`${TILE_SERVER}/tiles/${format}/${tile}.${extension}`);
    if (!response.ok) throw new Error(`tile ${format}/${tile} answered ${response.status}`);
    return response.arrayBuffer();
}

/**
 * Reads every style in every format from the tile server, or returns none when it is not running.
 * `only`, a comma-separated list such as `osm-bright/mlt`, narrows the variants, so that one of them
 * can be profiled on its own.
 */
async function loadVariants(only: string | undefined): Promise<Variant[]> {
    const wanted = only?.split(',');
    const variants: Variant[] = [];
    for (const style of STYLES) {
        for (const {format, extension} of FORMATS) {
            if (wanted && !wanted.includes(`${style}/${format}`)) continue;
            const styleJSON = await fetchStyle(style, format);
            if (!styleJSON) return [];
            const tiles = await Promise.all(TILES.map(async (tile) => {
                const [z, x, y] = tile.split('/').map(Number);
                return {tileID: new OverscaledTileID(z, 0, z, x, y), buffer: await fetchTile(format, extension, tile)};
            }));
            variants.push({id: `${style}/${format}`, format, layerIndex: new StyleLayerIndex(derefLayers(styleJSON.layers)), tiles});
        }
    }
    return variants;
}

function decodeTile(format: string, buffer: ArrayBuffer): VectorTileLike {
    return format === 'mlt' ? new MLTVectorTile(buffer) : new VectorTile(new PbfReader(new Uint8Array(buffer)));
}

/** Decodes and parses every tile of the variant once, the way a worker does when the map loads them. */
async function parseVariant(variant: Variant): Promise<void> {
    for (const {tileID, buffer} of variant.tiles) {
        const workerTile = new WorkerTile({
            type: 'benchmark',
            tileID,
            zoom: tileID.overscaledZ,
            tileSize: 512,
            showCollisionBoxes: false,
            source: 'openmaptiles',
            uid: '0',
            maxZoom: 22,
            pixelRatio: 1,
            request: {url: ''},
            returnDependencies: false,
            promoteId: undefined,
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
        });
        await workerTile.parse(decodeTile(variant.format, buffer), variant.layerIndex, [], actor, SubdivisionGranularitySetting.noSubdivision);
    }
}

/** Takes the layers of every tile the worker timing log holds, and leaves the log empty. */
function drainTimingLog(): LayerTiming[] {
    const log: string[] = (globalThis as any).__workerTimingLog ?? [];
    (globalThis as any).__workerTimingLog = [];
    return log.flatMap(line => JSON.parse(line).layers);
}

function addLayers(totals: BucketTotals, layers: LayerTiming[]): void {
    for (const layer of layers) {
        const bucket = totals[`${layer.type}/${layer.columnar ? 'columnar' : 'row'}`] ??= {populate: 0, addFeatures: 0, phases: {}};
        bucket.populate += layer.populate;
        bucket.addFeatures += layer.addFeatures;
        for (const [phase, ms] of Object.entries(layer.phases)) {
            bucket.phases[phase] = (bucket.phases[phase] ?? 0) + ms;
        }
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One block per variant: the median time to parse all its tiles, and each kind of bucket's mean share of it. */
function formatSummary(variants: Variant[], roundTimes: Record<string, number[]>, totals: Record<string, BucketTotals>): string {
    const perRound = (ms: number) => (ms / ROUNDS).toFixed(1).padStart(6);
    return variants.map((variant) => {
        const kinds = Object.entries(totals[variant.id]).sort(([, a], [, b]) => (b.populate + b.addFeatures) - (a.populate + a.addFeatures));
        const rows = kinds.map(([kind, bucket]) => {
            const phases = Object.entries(bucket.phases).map(([phase, ms]) => `${phase} ${perRound(ms).trim()}`).join(', ');
            return `  ${kind.padEnd(16)} populate ${perRound(bucket.populate)}  addFeatures ${perRound(bucket.addFeatures)}${phases ? `  (${phases})` : ''}`;
        });
        return [`${variant.id}: ${median(roundTimes[variant.id]).toFixed(1)} ms per round (median)`, ...rows].join('\n');
    }).join('\n');
}

/** Runs `measure` under the V8 CPU profiler and writes the profile to `file`, or just runs it when no file is given. */
async function withCpuProfile(file: string | undefined, measure: () => Promise<void>): Promise<void> {
    if (!file) return measure();
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    try {
        await measure();
    } finally {
        const {profile} = await session.post('Profiler.stop');
        writeFileSync(file, JSON.stringify(profile));
        session.disconnect();
    }
}

const variants = await loadVariants(process.env.NRW_VARIANTS);

/**
 * Parses the same twelve tiles of the North Rhine-Westphalia tile server in each style and tile format,
 * single-threaded, and splits the time by bucket and by the phases the buckets record in the worker
 * timing log. The variants are interleaved and their order rotated every round, after two rounds that
 * are not counted. Skipped when the tile server does not run. `NRW_VARIANTS` narrows the variants, and
 * with `NRW_CPU_PROFILE` set to a file name the counted rounds are recorded into it as a `.cpuprofile`.
 */
test.skipIf(variants.length === 0)('WorkerTile.parse on NRW tiles, by bucket and phase', async () => {
    for (let round = 0; round < 2; round++) {
        for (const variant of variants) await parseVariant(variant);
    }
    drainTimingLog();

    const roundTimes: Record<string, number[]> = Object.fromEntries(variants.map(v => [v.id, []]));
    const totals: Record<string, BucketTotals> = Object.fromEntries(variants.map(v => [v.id, {}]));
    await withCpuProfile(process.env.NRW_CPU_PROFILE, async () => {
        for (let round = 0; round < ROUNDS; round++) {
            const rotation = round % variants.length;
            for (const variant of [...variants.slice(rotation), ...variants.slice(0, rotation)]) {
                const start = performance.now();
                await parseVariant(variant);
                roundTimes[variant.id].push(performance.now() - start);
                addLayers(totals[variant.id], drainTimingLog());
            }
        }
    });

    console.log(`${TILES.length} tiles per round, ${ROUNDS} rounds, bucket times are means per round in ms\n`);
    console.log(formatSummary(variants, roundTimes, totals));
}, 600_000);
