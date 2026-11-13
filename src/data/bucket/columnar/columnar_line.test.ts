import {describe, test, expect, vi, afterEach} from 'vitest';
import {encodeTile, decodeTile} from '@maplibre/mlt';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';
import {LineBucket} from '../line_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {preTessellatedTables} from '../../../util/test/mlt.ts';
import {CANONICAL, LINE_BUCKETS, bucketParameters, bytes, createLineLayer, lineArrays, populateBoth, populateOptions, rowsOf} from '../../../util/test/columnar_bucket.ts';

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

describe('LineBucket populated from the columns of an MLT layer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('writes the same arrays and indexes the same features as from the rows', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0]);

        expect(row.vertices.length).toBeGreaterThan(0);
        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 1, 2]);
    });

    test('writes the same arrays as LineBucket for miter joins and butt caps', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0], undefined, {'line-join': 'miter', 'line-cap': 'butt'});

        expect(columnar).toEqual(row);
    });

    test('writes the same arrays as LineBucket for bevel joins and square caps', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0], undefined, {'line-join': 'bevel', 'line-cap': 'square'});

        expect(columnar).toEqual(row);
    });

    test('writes the same arrays as LineBucket for round joins and round caps', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0], undefined, {'line-join': 'round', 'line-cap': 'round'});

        expect(columnar).toEqual(row);
    });

    test('applies the layer filter on the columns, like the row filter does', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0], ['==', 'class', 'a']);

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 2]);
    });

    test('orders the features by a data-driven sort key, like the rows', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0], undefined, {'line-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([2, 1, 0]);
    });

    test('draws the lines and polygons of a layer that also holds points, and not the points', () => {
        const table = decodeTile(encodeTile([{
            name: 'roads',
            extent: 4096,
            features: [
                {id: 1, geometry: {type: 'Point', coordinates: [100, 100]}, properties: {}},
                {id: 2, geometry: {type: 'LineString', coordinates: [[0, 0], [1000, 0]]}, properties: {}},
                {id: 3, geometry: {type: 'Polygon', coordinates: [[[500, 500], [900, 500], [900, 900], [500, 900]]]}, properties: {}}
            ]
        }]))[0];
        const {options, insert} = populateOptions();
        const bucket = new LineBucket(bucketParameters(createLineLayer()));

        bucket.populate(new MLTVectorTileLayer(table), options, CANONICAL);

        expect(insert.mock.calls.map(call => call[2])).toEqual([1, 2]);
    });

    test('finds the lines and polygons of a table once, however many line layers draw it', () => {
        const sourceLayer = new MLTVectorTileLayer(decodeTile(encodeFeatures())[0]);
        const filter = vi.spyOn(sourceLayer.featureTable.geometryVector, 'filter');
        new LineBucket(bucketParameters(createLineLayer(['==', 'class', 'a']))).populate(sourceLayer, populateOptions().options, CANONICAL);
        const scans = filter.mock.calls.length;
        const {options, insert} = populateOptions();

        new LineBucket(bucketParameters(createLineLayer(['==', 'class', 'b']))).populate(sourceLayer, options, CANONICAL);

        expect(scans).toBeGreaterThan(0);
        expect(filter).toHaveBeenCalledTimes(scans);
        expect(insert.mock.calls.map(call => call[2])).toEqual([1]);
    });

    test('outlines every polygon of a pre-tessellated layer without scanning its geometry types', () => {
        const [table] = preTessellatedTables();
        const filter = vi.spyOn(table.geometryVector, 'filter');
        const {options, insert} = populateOptions();

        new LineBucket(bucketParameters(createLineLayer())).populate(new MLTVectorTileLayer(table), options, CANONICAL);

        expect(filter).not.toHaveBeenCalled();
        expect(insert).toHaveBeenCalledTimes(table.numFeatures);
    });

    test('reads each selected feature once and hands the same object to the spatial index', () => {
        const feature = vi.spyOn(MLTVectorTileLayer.prototype, 'feature');
        const {options, insert} = populateOptions();
        const bucket = new LineBucket(bucketParameters(createLineLayer()));

        bucket.populate(new MLTVectorTileLayer(decodeTile(encodeFeatures())[0]), options, CANONICAL);

        expect(feature).toHaveBeenCalledTimes(3);
        expect(insert.mock.calls.map(call => call[0])).toEqual(feature.mock.results.map(result => result.value));
    });

    test('reads the clips of a line that geojson-vt cut, like the rows', () => {
        const table = decodeTile(encodeTile([{
            name: 'roads',
            extent: 4096,
            features: [
                {id: 1, geometry: {type: 'LineString', coordinates: [[0, 0], [1000, 0], [1000, 800]]}, properties: {[GEOJSONVT_CLIP_START]: 0.25, [GEOJSONVT_CLIP_END]: 0.75}}
            ]
        }]))[0];
        const row = new LineBucket(bucketParameters(createLineLayer()));
        row.populate(rowsOf(new MLTVectorTileLayer(table)), populateOptions().options, CANONICAL);
        const columnar = new LineBucket(bucketParameters(createLineLayer()));

        columnar.populate(new MLTVectorTileLayer(table), populateOptions().options, CANONICAL);

        expect(columnar.lineClipsArray).toEqual([{start: 0.25, end: 0.75}]);
        expect(bytes(columnar.layoutVertexArray2)).toEqual(bytes(row.layoutVertexArray2));
        expect(lineArrays(columnar)).toEqual(lineArrays(row));
    });

    test('populates a columnar bucket from a row list when it is given one', () => {
        const table = decodeTile(encodeFeatures())[0];
        const {options, insert} = populateOptions();
        const bucket = new LineBucket(bucketParameters(createLineLayer()));

        bucket.populate(rowsOf(new MLTVectorTileLayer(table)), options, CANONICAL);

        expect(bucket.isEmpty()).toBe(false);
        expect(insert).toHaveBeenCalled();
    });
});
