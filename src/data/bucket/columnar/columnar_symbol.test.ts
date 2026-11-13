import {describe, test, expect, vi, afterEach} from 'vitest';
import {encodeTile, decodeTile} from '@maplibre/mlt';
import {SymbolBucket} from '../symbol_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {FeatureIndex} from '../../feature_index.ts';
import {OverscaledTileID} from '../../../tile/tile_id.ts';
import {createPopulateOptions} from '../../../../test/unit/lib/tile.ts';
import {CANONICAL, SYMBOL_BUCKETS, bucketParameters, createSymbolLayer, populateBoth, rowsOf} from '../../../util/test/columnar_bucket.ts';

import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Bucket} from '../../bucket.ts';

/** Three points, and two collinear segments of one road that carry the same name. */
function encodeFeatures(): Uint8Array {
    return encodeTile([{
        name: 'places',
        extent: 4096,
        features: [
            {id: 1, geometry: {type: 'Point', coordinates: [100, 100]}, properties: {name: 'Berlin', icon: 'city', class: 'a', rank: 3}},
            {id: 2, geometry: {type: 'Point', coordinates: [300, 100]}, properties: {name: 'Bonn', icon: 'town', class: 'b', rank: 2}},
            {id: 3, geometry: {type: 'Point', coordinates: [500, 100]}, properties: {name: 'Ulm', icon: 'town', class: 'a', rank: 1}},
            {id: 4, geometry: {type: 'LineString', coordinates: [[0, 900], [400, 900]]}, properties: {name: 'Main St', icon: 'road', class: 'a', rank: 0}},
            {id: 5, geometry: {type: 'LineString', coordinates: [[400, 900], [800, 900]]}, properties: {name: 'Main St', icon: 'road', class: 'a', rank: 0}}
        ]
    }]);
}

describe('SymbolBucket populated from the columns of an MLT layer', () => {
    test('selects, resolves and requests the same as from the rows', () => {
        const {row, columnar} = populateBoth(SYMBOL_BUCKETS, decodeTile(encodeFeatures())[0]);

        expect(row.features).toHaveLength(5);
        expect(columnar).toEqual(row);
        expect(Object.keys(columnar.icons).sort()).toEqual(['city', 'road', 'town']);
        expect(Object.keys(columnar.glyphs.Test.default)).toContain('B');
    });

    test('applies the layer filter on the columns, like the row filter does', () => {
        const {row, columnar} = populateBoth(SYMBOL_BUCKETS, decodeTile(encodeFeatures())[0], ['==', 'class', 'a']);

        expect(columnar).toEqual(row);
        expect(columnar.features.map(f => f.text)).toEqual(['Berlin', 'Ulm', 'Main St', 'Main St']);
    });

    test('sorts by a data-driven symbol-sort-key, like the rows', () => {
        const {row, columnar} = populateBoth(SYMBOL_BUCKETS, decodeTile(encodeFeatures())[0], undefined, {'symbol-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.features.map(f => f.sortKey)).toEqual([0, 0, 1, 2, 3]);
    });

    test('merges adjacent segments of one name for symbol-placement: line, like the rows', () => {
        const {row, columnar} = populateBoth(SYMBOL_BUCKETS, decodeTile(encodeFeatures())[0], ['==', 'icon', 'road'], {'symbol-placement': 'line'});

        expect(columnar).toEqual(row);
        expect(columnar.features).toHaveLength(1);
    });

    test('takes the ids from the promoteId of the source', () => {
        const options = createPopulateOptions([]);
        options.featureIndex = new FeatureIndex(new OverscaledTileID(0, 0, 0, 0, 0), 'name');
        const bucket = new SymbolBucket(bucketParameters(createSymbolLayer(['==', 'class', 'b'])));

        bucket.populate(new MLTVectorTileLayer(decodeTile(encodeFeatures())[0]), options, CANONICAL);

        expect(bucket.features.map(f => f.id)).toEqual(['Bonn']);
    });

    test('populates a columnar bucket from a row list when it is given one', () => {
        const table = decodeTile(encodeFeatures())[0];
        const options = createPopulateOptions([]);
        const bucket = new SymbolBucket(bucketParameters(createSymbolLayer()));

        bucket.populate(rowsOf(new MLTVectorTileLayer(table)), options, CANONICAL);

        expect(bucket.features).toHaveLength(5);
    });
});

describe('SymbolStyleLayer.createBucket', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('creates a columnar bucket for an MLT layer whose filter can be planned', () => {
        const layer = createSymbolLayer(['==', 'class', 'a']);

        const bucket: Bucket = layer.createBucket(bucketParameters(layer, 'mlt'));

        expect(bucket.isColumnar).toBe(true);
    });

    test('creates a row-based bucket for an MVT layer', () => {
        const layer = createSymbolLayer(['==', 'class', 'a']);

        const bucket: Bucket = layer.createBucket(bucketParameters(layer, 'mvt'));

        expect(bucket.isColumnar).toBe(false);
    });

    test('falls back to the row-based bucket and says so once when the filter cannot be planned', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const layer = createSymbolLayer(['within', {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}] as FilterSpecification);

        const first = layer.createBucket(bucketParameters(layer, 'mlt'));
        layer.createBucket(bucketParameters(layer, 'mlt'));

        expect(first.isColumnar).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('layer "symbol": filter is not supported');
    });
});
