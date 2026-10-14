import {describe, test, expect, vi, afterEach} from 'vitest';
import {encodeTile, decodeTile} from '@maplibre/mlt';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';
import {LineStyleLayer} from '../../../style/style_layer/line_style_layer.ts';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {CollisionBoxArray} from '../../array_types.g.ts';
import {LineBucket} from '../line_bucket.ts';
import {ColumnarLineBucket} from './columnar_line_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {FeatureIndex} from '../../feature_index.ts';
import {OverscaledTileID} from '../../../tile/tile_id.ts';
import {SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {StructArray} from '../../../util/struct_array.ts';
import type {BucketParameters, IndexedFeature, PopulateParameters} from '../../bucket.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

const ZOOM = 5;
const CANONICAL = {z: ZOOM, x: 0, y: 0} as CanonicalTileID;

/** A zigzag with sharp and obtuse corners and a duplicate vertex, a straight line, a polygon. */
function encodeFeatures(): Uint8Array {
    return encodeTile([{
        name: 'roads',
        extent: 4096,
        features: [
            {id: 1, geometry: {type: 'LineString', coordinates: [[0, 0], [800, 40], [800, 40], [30, 90], [900, 700], [1500, 700], [1500, 1800]]}, properties: {class: 'a', rank: 3}},
            {id: 2, geometry: {type: 'LineString', coordinates: [[100, 2000], [3000, 2000]]}, properties: {class: 'b', rank: 2}},
            {id: 3, geometry: {type: 'Polygon', coordinates: [[[500, 500], [900, 500], [900, 900], [500, 900]]]}, properties: {class: 'a', rank: 1}}
        ]
    }]);
}

function createLayer(filter?: FilterSpecification, layout: Record<string, unknown> = {}): LineStyleLayer {
    const layer = new LineStyleLayer({
        id: 'line', type: 'line', source: 's', 'source-layer': 'roads', filter, layout, paint: {'line-color': 'red'}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

function bucketParameters(layer: LineStyleLayer): BucketParameters<LineStyleLayer> {
    return {
        encoding: 'mlt', index: 0, layers: [layer], zoom: ZOOM, pixelRatio: 1, overscaling: 1,
        collisionBoxArray: new CollisionBoxArray(), sourceLayerIndex: 0, sourceID: 's'
    };
}

function populateOptions() {
    const featureIndex = new FeatureIndex(new OverscaledTileID(ZOOM, 0, ZOOM, 0, 0));
    const insert = vi.spyOn(featureIndex, 'insert').mockImplementation(() => {});
    const options = {
        featureIndex,
        iconDependencies: {}, patternDependencies: {}, glyphDependencies: {}, dashDependencies: {},
        availableImages: [], subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
    } as unknown as PopulateParameters;
    return {options, insert};
}

function rowsOf(layer: MLTVectorTileLayer): IndexedFeature[] {
    return Array.from({length: layer.length}, (_, index) => ({feature: layer.feature(index), id: index, index, sourceLayerIndex: 0}));
}

/** The used part of a struct array, byte for byte. */
function bytes(array: StructArray) {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function written(bucket: LineBucket) {
    return {
        vertices: bytes(bucket.layoutVertexArray),
        triangles: bytes(bucket.indexArray),
        segments: bucket.segments.get().map(s => ({...s}))
    };
}

/** Populates a row-based bucket and a columnar one from the same tile and returns what each wrote and indexed. */
function populateBoth(table: FeatureTable, filter?: FilterSpecification, layout: Record<string, unknown> = {}) {
    const sourceLayer = new MLTVectorTileLayer(table);

    const row = new LineBucket(bucketParameters(createLayer(filter, layout)));
    const rowOptions = populateOptions();
    row.populate(rowsOf(sourceLayer), rowOptions.options, CANONICAL);

    const columnar = new ColumnarLineBucket(bucketParameters(createLayer(filter, layout)));
    const columnarOptions = populateOptions();
    columnar.populate(sourceLayer, columnarOptions.options, CANONICAL);

    return {
        row: {...written(row), indexed: rowOptions.insert.mock.calls.map(call => call[2])},
        columnar: {...written(columnar), indexed: columnarOptions.insert.mock.calls.map(call => call[2])}
    };
}

describe('ColumnarLineBucket', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('writes the same arrays and indexes the same features as LineBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0]);

        expect(row.vertices.length).toBeGreaterThan(0);
        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 1, 2]);
    });

    test.each([
        ['miter', 'butt'],
        ['bevel', 'square'],
        ['round', 'round'],
    ])('writes the same arrays as LineBucket for %s joins and %s caps', (join, cap) => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0], undefined, {'line-join': join, 'line-cap': cap});

        expect(columnar).toEqual(row);
    });

    test('applies the layer filter on the columns, like the row filter does', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0], ['==', 'class', 'a']);

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 2]);
    });

    test('orders the features by a data-driven sort key, like LineBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0], undefined, {'line-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([2, 1, 0]);
    });

    test('reads each selected feature once and hands the same object to the spatial index', () => {
        const feature = vi.spyOn(MLTVectorTileLayer.prototype, 'feature');
        const {options, insert} = populateOptions();
        const bucket = new ColumnarLineBucket(bucketParameters(createLayer()));

        bucket.populate(decodeTile(encodeFeatures())[0], options, CANONICAL);

        expect(feature).toHaveBeenCalledTimes(3);
        expect(insert.mock.calls.map(call => call[0])).toEqual(feature.mock.results.map(result => result.value));
    });

    test('reads the clips of a line that geojson-vt cut, like LineBucket', () => {
        const table = decodeTile(encodeTile([{
            name: 'roads',
            extent: 4096,
            features: [
                {id: 1, geometry: {type: 'LineString', coordinates: [[0, 0], [1000, 0], [1000, 800]]}, properties: {[GEOJSONVT_CLIP_START]: 0.25, [GEOJSONVT_CLIP_END]: 0.75}}
            ]
        }]))[0];
        const row = new LineBucket(bucketParameters(createLayer()));
        row.populate(rowsOf(new MLTVectorTileLayer(table)), populateOptions().options, CANONICAL);
        const columnar = new ColumnarLineBucket(bucketParameters(createLayer()));

        columnar.populate(table, populateOptions().options, CANONICAL);

        expect(columnar.lineClipsArray).toEqual([{start: 0.25, end: 0.75}]);
        expect(bytes(columnar.layoutVertexArray2)).toEqual(bytes(row.layoutVertexArray2));
        expect(written(columnar)).toEqual(written(row));
    });

    test('populates from a row list through LineBucket when it is given one', () => {
        const table = decodeTile(encodeFeatures())[0];
        const {options, insert} = populateOptions();
        const bucket = new ColumnarLineBucket(bucketParameters(createLayer()));

        bucket.populate(rowsOf(new MLTVectorTileLayer(table)), options, CANONICAL);

        expect(bucket.isEmpty()).toBe(false);
        expect(insert).toHaveBeenCalled();
    });
});
