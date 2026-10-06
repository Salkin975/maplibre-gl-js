import {describe, test, expect, vi} from 'vitest';
import {encodeTile} from '@maplibre/mlt';
import {type Feature, GeoJSONWrapper} from '@maplibre/vt-pbf';
import {WorkerTile} from './worker_tile.ts';
import {MLTVectorTile, type MLTVectorTileLayer} from './vector_tile_mlt.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';

import type {Bucket} from '../data/bucket.ts';
import type {BucketParameters} from '../data/bucket.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {WorkerTileParameters} from './worker_source.ts';

function createWorkerTile(): WorkerTile {
    return new WorkerTile({
        uid: '',
        zoom: 0,
        maxZoom: 20,
        tileSize: 512,
        source: 'source',
        tileID: new OverscaledTileID(1, 0, 1, 1, 1),
        overscaling: 1,
        encoding: 'mlt'
    } as any as WorkerTileParameters);
}

function createMltTile(): MLTVectorTile {
    const bytes = encodeTile([{
        name: 'places',
        extent: 4096,
        features: [
            {id: 1, geometry: {type: 'Point', coordinates: [10, 20]}, properties: {name: 'a'}},
            {id: 2, geometry: {type: 'Point', coordinates: [30, 40]}, properties: {name: 'b'}}
        ]
    }]);
    return new MLTVectorTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** A tile of row-based features, as an overzoomed MLT tile is after it was re-encoded to MVT. */
function createRowTile(): GeoJSONWrapper {
    return new GeoJSONWrapper([{type: 1, geometry: [0, 0], tags: {name: 'a'}} as any as Feature], {version: 2, extent: 4096});
}

/** Circle layers in one source layer, each a family of its own (their filters differ). */
function createLayerIndex(layerIds: string[], sourceLayer = 'places'): StyleLayerIndex {
    return new StyleLayerIndex(layerIds.map((id, i) => ({
        id,
        source: 'source',
        'source-layer': sourceLayer,
        type: 'circle',
        filter: ['==', 'index', i]
    })));
}

function families(layerIndex: StyleLayerIndex): StyleLayer[][] {
    return Object.values(layerIndex.familiesBySource.source).flat();
}

type FakeBucket = Bucket & {populate: ReturnType<typeof vi.fn>; addFeatures: ReturnType<typeof vi.fn>};

function fakeBucket(isColumnar: boolean, hasDependencies = false): FakeBucket {
    return {
        isColumnar,
        hasDependencies,
        layers: [],
        populate: vi.fn(),
        addFeatures: vi.fn(),
        isEmpty: () => true
    } as unknown as FakeBucket;
}

/** Replaces `createBucket` of every family with one that returns `buckets[i]` and records its parameters. */
function serveBuckets(layerIndex: StyleLayerIndex, buckets: FakeBucket[]) {
    const parameters: Array<BucketParameters<any>> = [];
    for (const [i, family] of families(layerIndex).entries()) {
        family[0].createBucket = (p: BucketParameters<any>) => {
            parameters.push(p);
            return buckets[i];
        };
    }
    return parameters;
}

const parse = (tile: WorkerTile, data: MLTVectorTile | GeoJSONWrapper, layerIndex: StyleLayerIndex) =>
    tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);

describe('WorkerTile dispatch', () => {
    test('hands a columnar bucket the feature table and a row-based bucket the rows', async () => {
        const data = createMltTile();
        const layerIndex = createLayerIndex(['columnar', 'row']);
        const [columnar, row] = [fakeBucket(true), fakeBucket(false)];
        serveBuckets(layerIndex, [columnar, row]);

        await parse(createWorkerTile(), data, layerIndex);

        expect(columnar.populate.mock.calls[0][0]).toBe((data.layers.places as MLTVectorTileLayer).featureTable);
        const rows = row.populate.mock.calls[0][0];
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({index: 0, id: 1});
    });

    test('never builds the row list when every bucket is columnar', async () => {
        const data = createMltTile();
        const layerIndex = createLayerIndex(['a', 'b']);
        serveBuckets(layerIndex, [fakeBucket(true), fakeBucket(true)]);
        const feature = vi.spyOn(data.layers.places, 'feature');

        await parse(createWorkerTile(), data, layerIndex);

        expect(feature).not.toHaveBeenCalled();
    });

    test('builds the row list once for all row-based buckets of a source layer', async () => {
        const data = createMltTile();
        const layerIndex = createLayerIndex(['a', 'b', 'columnar']);
        const [a, b, columnar] = [fakeBucket(false), fakeBucket(false), fakeBucket(true)];
        serveBuckets(layerIndex, [a, b, columnar]);
        const feature = vi.spyOn(data.layers.places, 'feature');

        await parse(createWorkerTile(), data, layerIndex);

        expect(a.populate.mock.calls[0][0]).toBe(b.populate.mock.calls[0][0]);
        expect(feature).toHaveBeenCalledTimes(2);
    });

    test('keeps a row-based bucket of an MLT layer on rows', async () => {
        // A filter that cannot be planned makes createBucket() return a row-based bucket for MLT.
        const data = createMltTile();
        const layerIndex = createLayerIndex(['unsupported']);
        const bucket = fakeBucket(false);
        serveBuckets(layerIndex, [bucket]);

        await parse(createWorkerTile(), data, layerIndex);

        expect(Array.isArray(bucket.populate.mock.calls[0][0])).toBe(true);
    });
});

describe('WorkerTile encoding of the parsed layer', () => {
    test('says mlt for a layer that has a feature table', async () => {
        const layerIndex = createLayerIndex(['a']);
        const parameters = serveBuckets(layerIndex, [fakeBucket(true)]);

        await parse(createWorkerTile(), createMltTile(), layerIndex);

        expect(parameters[0].encoding).toBe('mlt');
    });

    test('says mvt for a layer of a re-encoded tile although the request was for mlt', async () => {
        // The overzoom case: the WorkerTile was created for 'mlt', but the data is row-based.
        const layerIndex = createLayerIndex(['a'], '_geojsonTileLayer');
        const bucket = fakeBucket(true);
        const parameters = serveBuckets(layerIndex, [bucket]);

        await parse(createWorkerTile(), createRowTile(), layerIndex);

        expect(parameters[0].encoding).toBe('mvt');
        // Whatever the bucket claims, without a feature table it can only be given rows.
        expect(Array.isArray(bucket.populate.mock.calls[0][0])).toBe(true);
    });
});

describe('WorkerTile release of decoded columns', () => {
    test('releases the decoded columns of an MLT tile after the last bucket was added to', async () => {
        const data = createMltTile();
        const layerIndex = createLayerIndex(['symbol-like']);
        const bucket = fakeBucket(false, true);
        serveBuckets(layerIndex, [bucket]);
        const release = vi.spyOn(data, 'releaseDecodedColumns');

        await parse(createWorkerTile(), data, layerIndex);

        expect(release).toHaveBeenCalledTimes(1);
        expect(bucket.addFeatures).toHaveBeenCalledTimes(1);
        expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(bucket.addFeatures.mock.invocationCallOrder[0]);
    });

    test('parses the same tile again after the release, as reloadTile does', async () => {
        const data = createMltTile();
        const layerIndex = createLayerIndex(['columnar']);
        const bucket = fakeBucket(true);
        serveBuckets(layerIndex, [bucket]);
        const tile = createWorkerTile();
        const table = (data.layers.places as MLTVectorTileLayer).featureTable;
        const decodedBefore = table.getPropertyVector('name');

        await parse(tile, data, layerIndex);
        const afterFirst = table.getPropertyVector('name');
        await parse(tile, data, layerIndex);
        const afterSecond = table.getPropertyVector('name');

        // Each parse ended with a release, so the column was decoded anew each time and reads the same.
        expect(afterFirst).not.toBe(decodedBefore);
        expect(afterSecond).not.toBe(afterFirst);
        expect(afterSecond?.getValue(1)).toBe('b');
        expect(bucket.populate.mock.calls.map(call => call[0])).toEqual([table, table]);
    });

    test('leaves a row-based tile alone', async () => {
        const layerIndex = createLayerIndex(['a']);
        serveBuckets(layerIndex, [fakeBucket(false)]);
        const data = createRowTile();

        await expect(parse(createWorkerTile(), data, layerIndex)).resolves.toBeDefined();
    });
});
