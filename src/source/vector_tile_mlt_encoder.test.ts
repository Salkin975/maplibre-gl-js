import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {encodeMLTVectorTile} from './vector_tile_mlt_encoder.ts';
import {MLTVectorTile} from './vector_tile_mlt.ts';

import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

type FeatureInput = {
    type: VectorTileFeatureLike['type'];
    geometry: number[][][];
    properties?: Record<string, unknown>;
    id?: number;
};

/** A vector tile whose features hold the given rings, each as a list of `[x, y]`. */
function createTile(layers: Record<string, FeatureInput[]>): VectorTileLike {
    const tile: VectorTileLike = {layers: {}};
    for (const [name, features] of Object.entries(layers)) {
        tile.layers[name] = {
            name,
            extent: 4096,
            version: 2,
            length: features.length,
            feature: (index: number) => ({
                type: features[index].type,
                id: features[index].id,
                extent: 4096,
                properties: (features[index].properties ?? {}) as VectorTileFeatureLike['properties'],
                loadGeometry: () => features[index].geometry.map(ring => ring.map(([x, y]) => new Point(x, y)))
            })
        };
    }
    return tile;
}

function featuresOf(layer: VectorTileLayerLike) {
    return Array.from({length: layer.length}, (_, index) => {
        const feature = layer.feature(index);
        return {
            type: feature.type,
            id: feature.id,
            properties: {...feature.properties},
            geometry: feature.loadGeometry().map(ring => ring.map(point => [point.x, point.y]))
        };
    });
}

describe('encodeMLTVectorTile', () => {
    test('encodes points, lines and polygons so that an MLT tile reads the same features back', () => {
        const square = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
        const hole = [[20, 20], [20, 40], [40, 40], [40, 20], [20, 20]];
        const island = [[200, 200], [300, 200], [300, 300], [200, 200]];
        const tile = createTile({
            mixed: [
                {type: 1, id: 1, geometry: [[[10, 20]]], properties: {name: 'a'}},
                {type: 1, id: 2, geometry: [[[10, 20]], [[30, 40]]], properties: {name: 'b'}},
                {type: 2, id: 3, geometry: [[[0, 0], [50, 50]]], properties: {name: 'c'}},
                {type: 2, id: 4, geometry: [[[0, 0], [50, 50]], [[60, 60], [70, -70]]], properties: {name: 'd'}},
                {type: 3, id: 5, geometry: [square, hole], properties: {name: 'e'}},
                {type: 3, id: 6, geometry: [square, hole, island], properties: {name: 'f'}}
            ]
        });

        const encoded = new MLTVectorTile(encodeMLTVectorTile(tile));

        expect(featuresOf(encoded.layers.mixed)).toEqual(featuresOf(tile.layers.mixed));
    });

    test('keeps a nested property, and the features without an id or without a property', () => {
        const tile = createTile({
            places: [
                {type: 1, id: 7, geometry: [[[1, 2]]], properties: {names: {de: 'Köln', en: 'Cologne'}, rank: 1}},
                {type: 1, geometry: [[[3, 4]]], properties: {names: {de: 'Bonn'}}}
            ]
        });

        const places = new MLTVectorTile(encodeMLTVectorTile(tile), {copyProperties: true}).layers.places;

        expect(places.feature(0).id).toBe(7);
        expect(places.feature(0).properties).toEqual({names: {de: 'Köln', en: 'Cologne'}, rank: 1});
        expect(places.feature(1).id).toBeUndefined();
        expect(places.feature(1).properties.names).toEqual({de: 'Bonn'});
    });

    test('rounds the coordinates a clipped geometry has between the integers', () => {
        const tile = createTile({roads: [{type: 2, geometry: [[[0.4, -127.6], [10.5, 20.49]]]}]});

        const roads = new MLTVectorTile(encodeMLTVectorTile(tile)).layers.roads;

        expect(featuresOf(roads)[0].geometry).toEqual([[[0, -128], [11, 20]]]);
    });

    test('leaves out a feature without a geometry to store, and a layer that is left empty', () => {
        const tile = createTile({
            roads: [
                {type: 0, geometry: [[[0, 0]]]},
                {type: 2, geometry: [[[0, 0]]]},
                {type: 2, geometry: [[[0, 0], [5, 5]]], properties: {class: 'main'}}
            ],
            empty: [{type: 3, geometry: []}]
        });

        const encoded = new MLTVectorTile(encodeMLTVectorTile(tile));

        expect(Object.keys(encoded.layers)).toEqual(['roads']);
        expect(featuresOf(encoded.layers.roads).map(feature => feature.properties)).toEqual([{class: 'main'}]);
    });

    test('throws when a property holds values of different types', () => {
        const tile = createTile({
            places: [
                {type: 1, geometry: [[[1, 2]]], properties: {rank: 1}},
                {type: 1, geometry: [[[3, 4]]], properties: {rank: 'first'}}
            ]
        });

        expect(() => encodeMLTVectorTile(tile)).toThrow('Property "rank" mixes value types');
    });
});
