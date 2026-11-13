import {describe, test, expect, vi, afterEach} from 'vitest';
import {encodeTile} from '@maplibre/mlt';
import {type Feature, GeoJSONWrapper, type VectorTileLike} from '@maplibre/vt-pbf';
import {WorkerTile} from './worker_tile.ts';
import {MLTVectorTile, type MLTVectorTileLayer} from './vector_tile_mlt.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {triangleOnlyLayer} from '../util/test/mlt.ts';

import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Bucket} from '../data/bucket.ts';
import type {FillBucket} from '../data/bucket/fill_bucket.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {WorkerTileParameters, WorkerTileWithData} from './worker_source.ts';

/** A filter that evaluates on rows but cannot be planned over the columns, and keeps every feature. */
const UNPLANNABLE_FILTER: FilterSpecification = ['!=', ['to-string', ['get', 'class']], 'water'];

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

/** A tile whose `land` layer is pre-tessellated and stores only triangles, without rings. */
function createTriangleOnlyTile(): VectorTileLike {
    return {layers: {land: triangleOnlyLayer()}};
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

/** Makes `createBucket` of the i-th family return `buckets[i]`, and returns the mock of each family's `createBucket`. */
function serveBuckets(layerIndex: StyleLayerIndex, buckets: FakeBucket[]) {
    return families(layerIndex).map((family, i) => vi.spyOn(family[0], 'createBucket').mockReturnValue(buckets[i]));
}

async function parse(tile: WorkerTile, data: VectorTileLike, layerIndex: StyleLayerIndex): Promise<WorkerTileWithData> {
    return await tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision) as WorkerTileWithData;
}

describe('WorkerTile dispatch', () => {
    test('hands a columnar bucket the MLT layer and a row-based bucket the rows', async () => {
        const data = createMltTile();
        const layerIndex = createLayerIndex(['columnar', 'row']);
        const [columnar, row] = [fakeBucket(true), fakeBucket(false)];
        serveBuckets(layerIndex, [columnar, row]);

        await parse(createWorkerTile(), data, layerIndex);

        expect(columnar.populate.mock.calls[0][0]).toBe(data.layers.places);
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
        const [createBucket] = serveBuckets(layerIndex, [fakeBucket(true)]);

        await parse(createWorkerTile(), createMltTile(), layerIndex);

        expect(createBucket).toHaveBeenCalledWith(expect.objectContaining({encoding: 'mlt'}));
    });

    test('says mvt for a layer of a re-encoded tile although the request was for mlt', async () => {
        // The overzoom case: the WorkerTile was created for 'mlt', but the data is row-based.
        const layerIndex = createLayerIndex(['a'], '_geojsonTileLayer');
        const bucket = fakeBucket(true);
        const [createBucket] = serveBuckets(layerIndex, [bucket]);

        await parse(createWorkerTile(), createRowTile(), layerIndex);

        expect(createBucket).toHaveBeenCalledWith(expect.objectContaining({encoding: 'mvt'}));
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
        expect(bucket.populate.mock.calls.map(call => call[0])).toEqual([data.layers.places, data.layers.places]);
    });

    test('leaves a row-based tile alone', async () => {
        const layerIndex = createLayerIndex(['a']);
        serveBuckets(layerIndex, [fakeBucket(false)]);
        const data = createRowTile();

        await expect(parse(createWorkerTile(), data, layerIndex)).resolves.toBeDefined();
    });
});

describe('WorkerTile on a pre-tessellated layer without rings', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('skips a layer whose filter cannot be planned and says so once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const layerIndex = new StyleLayerIndex([{id: 'outline', type: 'line', source: 'source', 'source-layer': 'land', filter: UNPLANNABLE_FILTER}]);
        const tile = createWorkerTile();

        const first = await parse(tile, createTriangleOnlyTile(), layerIndex);
        const second = await parse(tile, createTriangleOnlyTile(), layerIndex);

        expect(first.buckets).toHaveLength(0);
        expect(second.buckets).toHaveLength(0);
        expect(first.featureIndex.bucketLayerIDs).toEqual([]);
        const skipped = warn.mock.calls.filter(([message]) => message.includes('"outline"') && message.includes('pre-tessellated'));
        expect(skipped).toHaveLength(1);
    });

    test('draws the tile\'s triangles for a layer whose filter can be planned', async () => {
        const layerIndex = new StyleLayerIndex([{id: 'land', type: 'fill', source: 'source', 'source-layer': 'land', filter: ['!=', 'class', 'water']}]);

        const {buckets} = await parse(createWorkerTile(), createTriangleOnlyTile(), layerIndex);

        expect(buckets).toHaveLength(1);
        const bucket = buckets[0] as FillBucket;
        expect(bucket.isColumnar).toBe(true);
        expect(bucket.indexArray).toHaveLength(3);
    });

    test('parses a layer of an MVT tile whose filter cannot be planned as before', async () => {
        const layerIndex = new StyleLayerIndex([{id: 'road', type: 'line', source: 'source', 'source-layer': '_geojsonTileLayer', filter: UNPLANNABLE_FILTER}]);
        const data = new GeoJSONWrapper([{type: 2, geometry: [[[0, 0], [100, 100]]], tags: {class: 'road'}} as any as Feature], {version: 2, extent: 4096});

        const {buckets} = await parse(createWorkerTile(), data, layerIndex);

        expect(buckets).toHaveLength(1);
        expect(buckets[0].isColumnar).toBe(false);
    });
});
