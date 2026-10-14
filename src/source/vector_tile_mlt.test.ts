import {describe, test, expect, vi, afterEach} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import Point from '@mapbox/point-geometry';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {GEOMETRY_TYPE, FeatureTable, GeometryVector, createFlatGpuVector, decodeTile, encodeTile} from '@maplibre/mlt';
import {MLTVectorTile, MLTVectorTileLayer, hasRingTopology, isMLTVectorTileLayer, tessellatedVertexBase} from './vector_tile_mlt';

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

/** One line of four vertices that share three positions, which it reads through a vertex dictionary. */
class DictionaryLineVector extends GeometryVector {
    constructor() {
        super(1, {partOffsets: new Uint32Array([0, 4])}, new Uint32Array([2, 0, 1, 2]), new Int32Array([0, 0, 10, 0, 10, 10]));
    }

    get numGeometries(): number {
        return 1;
    }

    geometryType(): number {
        return GEOMETRY_TYPE.LINESTRING;
    }

    containsPolygonGeometry(): boolean {
        return false;
    }

    containsSingleGeometryType(): boolean {
        return true;
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

    test('reads every geometry type as the MLT package decodes it, into points of its own', () => {
        const bytes = encodeTile([{
            name: 'mixed',
            extent: 4096,
            features: [
                {geometry: {type: 'Point', coordinates: [1, 2]}, properties: {}},
                {geometry: {type: 'MultiPoint', coordinates: [[1, 2], [3, 4]]}, properties: {}},
                {geometry: {type: 'LineString', coordinates: [[0, 0], [5, 5], [9, 0]]}, properties: {}},
                {geometry: {type: 'MultiLineString', coordinates: [[[0, 0], [5, 5]], [[10, 10], [20, 20], [30, 10]]]}, properties: {}},
                {geometry: {type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 4], [4, 4], [2, 2]]]}, properties: {}},
                {geometry: {type: 'MultiPolygon', coordinates: [[[[0, 0], [10, 0], [10, 10], [0, 0]]], [[[20, 20], [30, 20], [30, 30], [20, 20]]]]}, properties: {}}
            ]
        }]);
        const table = decodeTile(bytes)[0];
        const layer = new MLTVectorTileLayer(table);
        const geometryVector = table.geometryVector as GeometryVector;

        for (let i = 0; i < table.numFeatures; i++) {
            const geometry = layer.feature(i).loadGeometry();

            expect(geometry).toEqual(geometryVector.getGeometry(i).map(ring => ring.map(({x, y}) => ({x, y}))));
            expect(geometry.flat().every(point => point instanceof Point)).toBe(true);
        }
    });

    test('reads vertices through the dictionary of a layer that stores them once', () => {
        const table = new FeatureTable('roads', new DictionaryLineVector(), undefined, [], 4096, 1);

        const geometry = new MLTVectorTileLayer(table).feature(0).loadGeometry();

        expect(geometry).toEqual([[{x: 10, y: 10}, {x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}]]);
        expect(geometry).toEqual((table.geometryVector as GeometryVector).getGeometry(0).map(line => line.map(({x, y}) => ({x, y}))));
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
    const tiles = ['mlt/5/22/12.mlt', 'mlt/14/8716/5685.mlt', 'mlt/5/17/10.mlt'];

    test.each(tiles)('matches the eagerly decoded features of %s', (file) => {
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
    });
});

describe('MLTVectorTileLayer on a pre-tessellated layer', () => {
    /** Two polygons, a square and a triangle, stored as triangles only: no ring topology. */
    function triangleOnlyLayer() {
        const geometryVector = createFlatGpuVector(
            new Uint32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.POLYGON]),
            new Uint32Array([0, 2, 3]),
            new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 2]),
            new Int32Array([0, 0, 100, 0, 100, 100, 0, 100, 200, 0, 300, 0, 250, 100])
        );
        return new MLTVectorTileLayer(new FeatureTable('land', geometryVector, undefined, [], 4096, 2));
    }

    test('knows that a layer of triangles has no ring topology', () => {
        const layer = triangleOnlyLayer();

        expect(hasRingTopology(layer.featureTable.geometryVector as any)).toBe(false);
    });

    test('gives a feature its triangles as closed rings when it has no rings', () => {
        const layer = triangleOnlyLayer();

        const square = layer.feature(0).loadGeometry();
        const triangle = layer.feature(1).loadGeometry();

        expect(square).toHaveLength(2);
        expect(triangle).toHaveLength(1);
        // Every triangle is a ring of its own, closed by repeating its first corner.
        expect(triangle[0]).toMatchObject([{x: 200, y: 0}, {x: 300, y: 0}, {x: 250, y: 100}, {x: 200, y: 0}]);
        expect(square[1]).toMatchObject([{x: 0, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}, {x: 0, y: 0}]);
    });

    test('winds every triangle as an exterior ring, so that each one stays a polygon of its own', () => {
        const square = createFlatGpuVector(
            new Uint32Array([GEOMETRY_TYPE.POLYGON]),
            new Uint32Array([0, 2]),
            // The second triangle winds against the first.
            new Uint32Array([0, 1, 2, 0, 3, 2]),
            new Int32Array([0, 0, 100, 0, 100, 100, 0, 100])
        );
        const layer = new MLTVectorTileLayer(new FeatureTable('land', square, undefined, [], 4096, 1));

        const polygons = classifyRings(layer.feature(0).loadGeometry());

        expect(polygons).toHaveLength(2);
        expect(polygons.every(polygon => polygon.length === 1)).toBe(true);
    });

    test('finds where the vertices of a feature start when the tile does not say', () => {
        const geometryVector = triangleOnlyLayer().featureTable.geometryVector as any;

        // The square uses vertices 0 to 3, so the triangle starts at 4.
        expect(tessellatedVertexBase(geometryVector, 0)).toBe(0);
        expect(tessellatedVertexBase(geometryVector, 1)).toBe(4);
    });
});

function readAll(layer: MLTVectorTileLayer) {
    const rows = [];
    for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        rows.push({id: feature.id, type: feature.type, geometry: feature.loadGeometry(), properties: {...feature.properties}});
    }
    return rows;
}
