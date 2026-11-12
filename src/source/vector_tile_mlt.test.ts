import {describe, test, expect, vi, afterEach} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import {decodeTile, encodeTile} from '@maplibre/mlt';
import {MLTVectorTile, isMLTVectorTileLayer, type MLTVectorTileLayer} from './vector_tile_mlt';

function encode(): ArrayBuffer {
    const bytes = encodeTile([
        {
            name: 'places',
            extent: 4096,
            features: [
                {id: 7, geometry: {type: 'Point', coordinates: [10, 20]}, properties: {name: 'a', rank: 1}},
                {id: 8, geometry: {type: 'Point', coordinates: [30, 40]}, properties: {name: 'b'}},
                {id: 2n ** 62n, geometry: {type: 'Point', coordinates: [50, 60]}, properties: {name: 'c', big: 2n ** 60n}}
            ]
        },
        {
            name: 'roads',
            extent: 4096,
            features: [
                {geometry: {type: 'LineString', coordinates: [[0, 0], [100, 100]]}, properties: {class: 'main'}}
            ]
        }
    ], {propertyTypes: {big: 'int64'}});
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readAll(layer: MLTVectorTileLayer) {
    const rows = [];
    for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        rows.push({id: feature.id, type: feature.type, geometry: feature.loadGeometry(), properties: {...feature.properties}});
    }
    return rows;
}

/** Expects every layer of a tile from the integration assets to read as `decodeTile()` decodes it eagerly. */
function expectEagerlyDecodedFeatures(file: string) {
    const buffer = readFileSync(path.join(__dirname, '../../test/integration/assets/tiles', file)).buffer.slice(0);
    const expected = decodeTile(new Uint8Array(buffer.slice(0)));
    const tile = new MLTVectorTile(buffer);

    expect(Object.keys(tile.layers).sort()).toEqual(expected.map(table => table.name).sort());

    for (const table of expected) {
        const layer = tile.layers[table.name];
        const features = table.getFeatures();
        expect(layer).toHaveLength(features.length);
        expect(layer.extent).toBe(table.extent);

        for (let i = 0; i < features.length; i++) {
            const feature = layer.feature(i);
            const expectedGeometry = features[i].geometry.coordinates.map(ring => ring.map(({x, y}) => ({x, y})));

            expect(feature.loadGeometry()).toMatchObject(expectedGeometry);
            expect(feature.id).toBe(features[i].id === undefined ? undefined : Number(features[i].id));
            expect({...feature.properties}).toEqual(features[i].properties);
        }
    }
}

describe('MLTVectorTile', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('lists layers as keys and spread and decodes each one once', () => {
        const tile = new MLTVectorTile(encode());

        expect(Object.keys(tile.layers)).toEqual(['places', 'roads']);

        const first = tile.layers.places;
        expect(first).toHaveLength(3);
        expect(first.extent).toBe(4096);
        expect(tile.layers.places).toBe(first);
        expect({...tile.layers}.places).toBe(first);
    });

    test('reads geometry, type and id of a feature', () => {
        const feature = new MLTVectorTile(encode()).layers.places.feature(0);

        expect(feature.type).toBe(1);
        expect(feature.id).toBe(7);
        expect(feature.loadGeometry()).toMatchObject([[{x: 10, y: 20}]]);
        expect(new MLTVectorTile(encode()).layers.roads.feature(0).type).toBe(2);
    });

    test('reads and enumerates properties through the proxy', () => {
        const layer = new MLTVectorTile(encode()).layers.places;
        const first = layer.feature(0).properties;
        const second = layer.feature(1).properties;

        expect(first.name).toBe('a');
        expect(first.rank).toBe(1);
        expect(second.rank).toBeUndefined();
        expect('rank' in second).toBe(false);
        expect(Object.keys(first).sort()).toEqual(['name', 'rank']);
        expect({...second}).toEqual({name: 'b'});
    });

    test('reads 64-bit values outside the safe range as the nearest number, as MVT does', () => {
        const feature = new MLTVectorTile(encode()).layers.places.feature(2);

        expect(feature.id).toBe(Number(2n ** 62n));
        expect(feature.properties.big).toBe(Number(2n ** 60n));
        expect(feature.properties.name).toBe('c');
    });

    test('gives features plain properties that keep what is written to them when asked to copy', () => {
        const properties = new MLTVectorTile(encode(), {copyProperties: true}).layers.places.feature(0).properties;

        properties.name = 'changed';

        expect(properties.name).toBe('changed');
        expect(structuredClone(properties)).toEqual({name: 'changed', rank: 1});
    });
});

describe('MLTVectorTile.releaseDecodedColumns', () => {
    test('decodes again after the release and reads the same values', () => {
        const layer = new MLTVectorTile(encode()).layers.places as MLTVectorTileLayer;
        const before = readAll(layer);
        const columnBefore = layer.featureTable.getPropertyVector('name');

        layer.releaseDecodedColumns();

        expect(layer.featureTable.getPropertyVector('name')).not.toBe(columnBefore);
        expect(readAll(layer)).toEqual(before);
    });

    test('releases every layer that was read and never decodes one that was not', () => {
        const tile = new MLTVectorTile(encode());
        const places = tile.layers.places;
        expect(isMLTVectorTileLayer(places)).toBe(true);
        const release = vi.spyOn(places as MLTVectorTileLayer, 'releaseDecodedColumns');

        tile.releaseDecodedColumns();

        expect(release).toHaveBeenCalledTimes(1);
        // 'roads' was never read, so its property is still the lazy getter and not a decoded layer.
        expect(Object.getOwnPropertyDescriptor(tile.layers, 'roads')?.get).toBeTypeOf('function');
    });

    test('keeps a feature obtained before the release readable', () => {
        const layer = new MLTVectorTile(encode()).layers.places as MLTVectorTileLayer;
        const feature = layer.feature(0);

        layer.releaseDecodedColumns();

        expect(feature.properties.name).toBe('a');
        expect(feature.loadGeometry()).toMatchObject([[{x: 10, y: 20}]]);
    });

    test('can be released repeatedly and before any read', () => {
        const tile = new MLTVectorTile(encode());
        tile.releaseDecodedColumns();
        tile.releaseDecodedColumns();

        expect(tile.layers.places.feature(0).properties.name).toBe('a');
    });
});

describe('MLTVectorTile on real tiles', () => {
    test('matches the eagerly decoded features of a tile whose polygon layers store their one geometry type once', () => {
        expectEagerlyDecodedFeatures('mlt/5/22/12.mlt');
    });

    test('matches the eagerly decoded features of a street-level tile with a pre-tessellated layer of lines and polygons', () => {
        expectEagerlyDecodedFeatures('mlt/14/8716/5685.mlt');
    });

    test('matches the eagerly decoded features of a tile whose line layer stores its one geometry type once', () => {
        expectEagerlyDecodedFeatures('mlt/5/17/10.mlt');
    });
});
