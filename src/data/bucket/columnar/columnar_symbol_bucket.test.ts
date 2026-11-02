import {describe, test, expect} from 'vitest';
import {encodeTile, decodeTile} from '@maplibre/mlt';
import {SymbolStyleLayer} from '../../../style/style_layer/symbol_style_layer.ts';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {CollisionBoxArray} from '../../array_types.g.ts';
import {SymbolBucket} from '../symbol_bucket.ts';
import {ColumnarSymbolBucket} from './columnar_symbol_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {FeatureIndex} from '../../feature_index.ts';
import {OverscaledTileID} from '../../../tile/tile_id.ts';
import {createPopulateOptions} from '../../../../test/unit/lib/tile.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type {Formatted} from '@maplibre/maplibre-gl-style-spec';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {BucketParameters, IndexedFeature, PopulateParameters} from '../../bucket.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

const ZOOM = 5;
const CANONICAL = {z: ZOOM, x: 0, y: 0} as CanonicalTileID;

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

function createLayer(filter?: FilterSpecification, layout: Record<string, unknown> = {}): SymbolStyleLayer {
    const layer = new SymbolStyleLayer({
        id: 'symbol', type: 'symbol', source: 's', 'source-layer': 'places', filter,
        layout: {'text-field': ['get', 'name'], 'text-font': ['Test'], 'icon-image': ['get', 'icon'], ...layout}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

function bucketParameters(layer: SymbolStyleLayer): BucketParameters<SymbolStyleLayer> {
    return {
        encoding: 'mlt', index: 0, layers: [layer], zoom: ZOOM, pixelRatio: 1, overscaling: 1,
        collisionBoxArray: new CollisionBoxArray(), sourceLayerIndex: 0, sourceID: 's'
    };
}

function rowsOf(layer: MLTVectorTileLayer): IndexedFeature[] {
    return Array.from({length: layer.length}, (_, index) => ({feature: layer.feature(index), id: layer.feature(index).id, index, sourceLayerIndex: 0}));
}

/** Populates a row-based bucket and a columnar one from the same tile and returns what each selected and requested. */
function populateBoth(table: FeatureTable, filter?: FilterSpecification, layout: Record<string, unknown> = {}) {
    const rowOptions = createPopulateOptions([]);
    const row = new SymbolBucket(bucketParameters(createLayer(filter, layout)));
    row.populate(rowsOf(new MLTVectorTileLayer(table)), rowOptions, CANONICAL);

    const columnarOptions = createPopulateOptions([]);
    const columnar = new ColumnarSymbolBucket(bucketParameters(createLayer(filter, layout)));
    columnar.populate(new MLTVectorTileLayer(table), columnarOptions, CANONICAL);

    return {row: summarize(row, rowOptions), columnar: summarize(columnar, columnarOptions)};
}

describe('ColumnarSymbolBucket', () => {
    test('selects, resolves and requests the same as SymbolBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0]);

        expect(row.features).toHaveLength(5);
        expect(columnar).toEqual(row);
        expect(Object.keys(columnar.icons).sort()).toEqual(['city', 'road', 'town']);
        expect(Object.keys(columnar.glyphs.Test.default)).toContain('B');
    });

    test('applies the layer filter on the columns, like the row filter does', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0], ['==', 'class', 'a']);

        expect(columnar).toEqual(row);
        expect(columnar.features.map(f => f.text)).toEqual(['Berlin', 'Ulm', 'Main St', 'Main St']);
    });

    test('sorts by a data-driven symbol-sort-key, like SymbolBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0], undefined, {'symbol-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.features.map(f => f.sortKey)).toEqual([0, 0, 1, 2, 3]);
    });

    test('merges adjacent segments of one name for symbol-placement: line, like SymbolBucket', () => {
        const {row, columnar} = populateBoth(decodeTile(encodeFeatures())[0], ['==', 'icon', 'road'], {'symbol-placement': 'line'});

        expect(columnar).toEqual(row);
        expect(columnar.features).toHaveLength(1);
    });

    test('takes the ids from the promoteId of the source', () => {
        const options = createPopulateOptions([]);
        options.featureIndex = new FeatureIndex(new OverscaledTileID(0, 0, 0, 0, 0), 'name');
        const bucket = new ColumnarSymbolBucket(bucketParameters(createLayer(['==', 'class', 'b'])));

        bucket.populate(new MLTVectorTileLayer(decodeTile(encodeFeatures())[0]), options, CANONICAL);

        expect(bucket.features.map(f => f.id)).toEqual(['Bonn']);
    });

    test('populates from a row list through SymbolBucket when it is given one', () => {
        const table = decodeTile(encodeFeatures())[0];
        const options = createPopulateOptions([]);
        const bucket = new ColumnarSymbolBucket(bucketParameters(createLayer()));

        bucket.populate(rowsOf(new MLTVectorTileLayer(table)), options, CANONICAL);

        expect(bucket.features).toHaveLength(5);
    });
});

/** What a symbol bucket selected and resolved, and what it asked the main thread for. */
function summarize(bucket: SymbolBucket, options: PopulateParameters) {
    return {
        features: bucket.features.map(f => ({...f, text: (f.text as Formatted | undefined)?.toString(), icon: f.icon?.name})),
        icons: options.iconDependencies,
        glyphs: options.glyphDependencies
    };
}
