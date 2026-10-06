import {describe, test, expect, vi, afterEach} from 'vitest';
import {encodeTile, decodeTile, createFlatGpuVector, FeatureTable, GEOMETRY_TYPE, GpuVector} from '@maplibre/mlt';
import {readFileSync} from 'fs';
import path from 'path';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer.ts';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {CollisionBoxArray} from '../../array_types.g.ts';
import {FillBucket} from '../fill_bucket.ts';
import {ColumnarFillBucket} from './columnar_fill_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings.ts';

import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {StructArray} from '../../../util/struct_array.ts';
import type {Bucket, BucketParameters, IndexedFeature, PopulateParameters} from '../../bucket.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

/**
 * A pre-tessellated layer of two polygons that stores only triangles: a square (two triangles, four
 * vertices) and a triangle. No ring topology, so there is no outline and no per-feature vertex count.
 */
function triangleOnlyLayer(): FeatureTable {
    const geometryVector = createFlatGpuVector(
        new Uint32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.POLYGON]),
        new Uint32Array([0, 2, 3]),
        new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 2]),
        new Int32Array([0, 0, 100, 0, 100, 100, 0, 100, 200, 0, 300, 0, 250, 100])
    );
    return new FeatureTable('land', geometryVector, undefined, [], 4096, 2);
}

const ZOOM = 5;
const CANONICAL = {z: ZOOM, x: 0, y: 0} as CanonicalTileID;

/** Three ring-encoded polygons: a square with a hole, a triangle, and another square. */
function encodePolygons(): Uint8Array {
    return encodeTile([{
        name: 'land',
        extent: 4096,
        features: [
            {id: 1, geometry: {type: 'Polygon', coordinates: [[[0, 0], [400, 0], [400, 400], [0, 400]], [[100, 100], [100, 300], [300, 300], [300, 100]]]}, properties: {class: 'a', rank: 3}},
            {id: 2, geometry: {type: 'Polygon', coordinates: [[[500, 0], [900, 0], [700, 400]]]}, properties: {class: 'b', rank: 2}},
            {id: 3, geometry: {type: 'Polygon', coordinates: [[[1000, 1000], [1400, 1000], [1400, 1400], [1000, 1400]]]}, properties: {class: 'a', rank: 1}}
        ]
    }]);
}

function createLayer(filter?: FilterSpecification, layout: Record<string, unknown> = {}): FillStyleLayer {
    const layer = new FillStyleLayer({
        id: 'fill', type: 'fill', source: 's', 'source-layer': 'land', filter, layout, paint: {'fill-color': 'red'}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

function bucketParameters(layer: FillStyleLayer, encoding: 'mlt' | 'mvt' = 'mlt'): BucketParameters<FillStyleLayer> {
    return {
        encoding, index: 0, layers: [layer], zoom: ZOOM, pixelRatio: 1, overscaling: 1,
        collisionBoxArray: new CollisionBoxArray(), sourceLayerIndex: 0, sourceID: 's'
    };
}

function populateOptions() {
    const insert = vi.fn();
    const options = {
        featureIndex: {insert},
        iconDependencies: {}, patternDependencies: {}, glyphDependencies: {}, dashDependencies: {},
        availableImages: [], subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
    } as unknown as PopulateParameters;
    return {options, insert};
}

const rowsOf = (layer: MLTVectorTileLayer): IndexedFeature[] =>
    Array.from({length: layer.length}, (_, index) => ({feature: layer.feature(index), id: index, index, sourceLayerIndex: 0}));

/** The used part of a struct array, byte for byte. */
const bytes = (array: StructArray) => Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));

/** What a bucket wrote: its three arrays and its segments. */
function written(bucket: FillBucket) {
    return {
        vertices: bytes(bucket.layoutVertexArray),
        triangles: bytes(bucket.indexArray),
        outlines: bytes(bucket.indexArray2),
        segments: bucket.segments.get().map(s => ({...s})),
        outlineSegments: bucket.segments2.get().map(s => ({...s}))
    };
}

/** Populates a row-based bucket and a columnar one from the same tile and returns what each wrote and indexed. */
function populateBoth(table: FeatureTable, filter?: FilterSpecification, layout: Record<string, unknown> = {}) {
    const sourceLayer = new MLTVectorTileLayer(table);

    const rowLayer = createLayer(filter, layout);
    const row = new FillBucket(bucketParameters(rowLayer));
    const rowOptions = populateOptions();
    row.populate(rowsOf(sourceLayer), rowOptions.options, CANONICAL);

    const columnarLayer = createLayer(filter, layout);
    const columnar = new ColumnarFillBucket(bucketParameters(columnarLayer));
    const columnarOptions = populateOptions();
    columnar.populate(table, columnarOptions.options, CANONICAL);

    return {
        row: {...written(row), indexed: rowOptions.insert.mock.calls.map(call => call[2])},
        columnar: {...written(columnar), indexed: columnarOptions.insert.mock.calls.map(call => call[2])}
    };
}

describe('ColumnarFillBucket on ring-encoded polygons', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('writes the same arrays and indexes the same features as FillBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodePolygons())[0]);

        expect(row.vertices.length).toBeGreaterThan(0);
        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 1, 2]);
    });

    test('applies the layer filter on the columns, like the row filter does', () => {
        const {row, columnar} = populateBoth(decodeTile(encodePolygons())[0], ['==', 'class', 'a']);

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 2]);
    });

    test('orders the features by a data-driven sort key, like FillBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodePolygons())[0], undefined, {'fill-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([2, 1, 0]);
    });

    test('populates from a row list through FillBucket when it is given one', () => {
        const table = decodeTile(encodePolygons())[0];
        const sourceLayer = new MLTVectorTileLayer(table);
        const {options, insert} = populateOptions();
        const bucket = new ColumnarFillBucket(bucketParameters(createLayer()));

        bucket.populate(rowsOf(sourceLayer), options, CANONICAL);

        expect(insert).toHaveBeenCalledTimes(3);
        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
    });
});

describe('FillStyleLayer.createBucket', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('chooses the columnar bucket for an MLT layer whose filter can be planned', () => {
        const layer = createLayer(['==', 'class', 'a']);

        const bucket: Bucket = layer.createBucket(bucketParameters(layer, 'mlt'));

        expect(bucket).toBeInstanceOf(ColumnarFillBucket);
        expect(bucket.isColumnar).toBe(true);
    });

    test('chooses the row-based bucket for an MVT layer', () => {
        const layer = createLayer(['==', 'class', 'a']);

        const bucket: Bucket = layer.createBucket(bucketParameters(layer, 'mvt'));

        expect(bucket).not.toBeInstanceOf(ColumnarFillBucket);
        expect(bucket.isColumnar).toBeUndefined();
    });

    test('falls back to the row-based bucket and says so once when the filter cannot be planned', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const layer = createLayer(['within', {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}] as FilterSpecification);

        const first = layer.createBucket(bucketParameters(layer, 'mlt'));
        layer.createBucket(bucketParameters(layer, 'mlt'));

        expect(first).not.toBeInstanceOf(ColumnarFillBucket);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('layer "fill": filter is not supported');
    });
});

describe('ColumnarFillBucket on a pre-tessellated tile', () => {
    const tile = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
    const tessellatedTables = () => decodeTile(new Uint8Array(readFileSync(tile)))
        .filter(table => table.geometryVector instanceof GpuVector);

    test('writes the tile\'s own triangles and indexes every feature by its bounding box', () => {
        const tables = tessellatedTables();
        expect(tables.length).toBeGreaterThan(0);

        for (const table of tables) {
            const geometryVector = table.geometryVector as GpuVector;
            const {options, insert} = populateOptions();
            const bucket = new ColumnarFillBucket(bucketParameters(createLayer()));

            bucket.populate(table, options, CANONICAL);

            // Every triangle of the tile is written once, none is added or dropped by a triangulation.
            expect(bucket.indexArray).toHaveLength(geometryVector.triangleOffsets[table.numFeatures]);
            expect(insert).toHaveBeenCalledTimes(table.numFeatures);
            for (const [, geometry] of insert.mock.calls) {
                // The spatial index gets one two-point "ring" with the feature's bounds and nothing else.
                expect(geometry).toHaveLength(1);
                expect(geometry[0]).toHaveLength(2);
                expect(geometry[0][0].x).toBeLessThanOrEqual(geometry[0][1].x);
                expect(geometry[0][0].y).toBeLessThanOrEqual(geometry[0][1].y);
            }
        }
    });
});

describe('ColumnarFillBucket on a pre-tessellated layer without ring topology', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('draws the triangles, has no outline and says so', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {options, insert} = populateOptions();
        const bucket = new ColumnarFillBucket(bucketParameters(createLayer()));

        bucket.populate(triangleOnlyLayer(), options, CANONICAL);

        expect(bucket.indexArray).toHaveLength(3);
        // Four vertices of the square and three of the triangle, each position once per feature.
        expect(bucket.layoutVertexArray).toHaveLength(7);
        expect(bucket.indexArray2).toHaveLength(0);
        expect(insert).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('without ring topology');
    });
});
