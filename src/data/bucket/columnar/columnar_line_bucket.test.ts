import {describe, test, expect} from 'vitest';
import {encodeTile, decodeTile} from '@maplibre/mlt';
import {ColumnarLineBucket} from './columnar_line_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {CANONICAL, LINE_BUCKETS, bucketParameters, createLineLayer, populateBoth, populateOptions, rowsOf} from '../../../util/test/columnar_bucket.ts';

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

describe('ColumnarLineBucket', () => {
    test('writes the same arrays and indexes the same features as LineBucket', () => {
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

    test('orders the features by a data-driven sort key, like LineBucket', () => {
        const {row, columnar} = populateBoth(LINE_BUCKETS, decodeTile(encodeFeatures())[0], undefined, {'line-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([2, 1, 0]);
    });

    test('populates from a row list through LineBucket when it is given one', () => {
        const table = decodeTile(encodeFeatures())[0];
        const {options, insert} = populateOptions();
        const bucket = new ColumnarLineBucket(bucketParameters(createLineLayer()));

        bucket.populate(rowsOf(new MLTVectorTileLayer(table)), options, CANONICAL);

        expect(bucket.isEmpty()).toBe(false);
        expect(insert).toHaveBeenCalled();
    });
});
