import {describe, test, expect, vi, afterEach} from 'vitest';
import {encodeTile, decodeTile, type GpuVector} from '@maplibre/mlt';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer.ts';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {FillBucket} from '../fill_bucket.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {SubdivisionGranularityExpression, SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings.ts';
import {preTessellatedTables, triangleOnlyLayer} from '../../../util/test/mlt.ts';
import {CANONICAL, FILL_BUCKETS, ZOOM, bucketParameters, createFillLayer, fillArrays, populateBoth, populateOptions, rowsOf} from '../../../util/test/columnar_bucket.ts';

import type Point from '@mapbox/point-geometry';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Bucket, IndexedFeature} from '../../bucket.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

/** A tile that borders neither edge of the world, so `subdividePolygon()` adds no pole geometry to it. */
const INNER_CANONICAL = {z: ZOOM, x: 3, y: 4} as CanonicalTileID;

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

/** A multipolygon of a square with a hole and a triangle, and a polygon that reaches past the clamped range. */
function encodeMultiPolygons(): Uint8Array {
    return encodeTile([{
        name: 'land',
        extent: 4096,
        features: [
            {id: 1, geometry: {type: 'MultiPolygon', coordinates: [
                [[[0, 0], [400, 0], [400, 400], [0, 400]], [[100, 100], [100, 300], [300, 300], [300, 100]]],
                [[[500, 0], [900, 0], [700, 400]]]
            ]}, properties: {class: 'a'}},
            {id: 2, geometry: {type: 'Polygon', coordinates: [[[1000, 1000], [9000, 1000], [9000, 1400], [1000, 1400]]]}, properties: {class: 'b'}}
        ]
    }]);
}

/**
 * The triangles and outline edges a fill bucket draws, as coordinates, each in a canonical order, so that
 * buckets that share vertices differently compare equal. A triangle keeps its winding.
 */
function drawn(bucket: FillBucket) {
    const vertices = bucket.layoutVertexArray.int16;
    function position(vertex: number): string {
        return `${vertices[vertex * 2]},${vertices[vertex * 2 + 1]}`;
    }

    const triangles: string[] = [];
    for (const segment of bucket.segments.get()) {
        for (let i = segment.primitiveOffset; i < segment.primitiveOffset + segment.primitiveLength; i++) {
            const corners = [0, 1, 2].map(k => position(segment.vertexOffset + bucket.indexArray.uint16[i * 3 + k]));
            const rotations = [0, 1, 2].map(r => [...corners.slice(r), ...corners.slice(0, r)].join(' '));
            triangles.push(rotations.sort()[0]);
        }
    }
    const edges: string[] = [];
    for (const segment of bucket.segments2.get()) {
        for (let i = segment.primitiveOffset; i < segment.primitiveOffset + segment.primitiveLength; i++) {
            const ends = [0, 1].map(k => position(segment.vertexOffset + bucket.indexArray2.uint16[i * 2 + k]));
            edges.push(ends.sort().join(' '));
        }
    }
    return {triangles: triangles.sort(), edges: edges.sort()};
}

/** The bounding box `FeatureIndex.insert()` computes for each ring it is given. */
function ringBoxes(geometry: Point[][]): number[][] {
    return geometry.map(ring => [
        Math.min(...ring.map(p => p.x)), Math.min(...ring.map(p => p.y)),
        Math.max(...ring.map(p => p.x)), Math.max(...ring.map(p => p.y)),
    ]);
}

function patternLayer(): FillStyleLayer {
    const layer = new FillStyleLayer({
        id: 'fill', type: 'fill', source: 's', 'source-layer': 'land', paint: {'fill-pattern': 'stripes'}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

/** The boxes of each insert at the time of the call, before anything could fill them in. */
function indexedBoxes(bucket: Bucket, features: IndexedFeature[] | MLTVectorTileLayer): number[][][] {
    const {options, insert} = populateOptions();
    const boxes: number[][][] = [];
    insert.mockImplementation((_feature, geometry: Point[][]) => {
        boxes.push(ringBoxes(geometry));
    });
    bucket.populate(features, options, INNER_CANONICAL);
    expect(bucket.hasDependencies).toBe(true);
    return boxes;
}

describe('FillBucket populated from the columns of ring-encoded polygons', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('writes the same arrays and indexes the same features as from the rows', () => {
        const {row, columnar} = populateBoth(FILL_BUCKETS, decodeTile(encodePolygons())[0]);

        expect(row.vertices.length).toBeGreaterThan(0);
        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 1, 2]);
    });

    test('applies the layer filter on the columns, like the row filter does', () => {
        const {row, columnar} = populateBoth(FILL_BUCKETS, decodeTile(encodePolygons())[0], ['==', 'class', 'a']);

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 2]);
    });

    test('orders the features by a data-driven sort key, like the rows', () => {
        const {row, columnar} = populateBoth(FILL_BUCKETS, decodeTile(encodePolygons())[0], undefined, {'fill-sort-key': ['get', 'rank']});

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([2, 1, 0]);
    });

    test('reads each selected feature once and hands the same object to the spatial index', () => {
        const feature = vi.spyOn(MLTVectorTileLayer.prototype, 'feature');
        const table = decodeTile(encodePolygons())[0];
        const {options, insert} = populateOptions();
        const bucket = new FillBucket(bucketParameters(createFillLayer()));

        bucket.populate(new MLTVectorTileLayer(table), options, CANONICAL);

        expect(feature).toHaveBeenCalledTimes(3);
        expect(insert.mock.calls.map(call => call[0])).toEqual(feature.mock.results.map(result => result.value));
    });

    test('fills lines and indexes points like the rows, since a fill does not tell geometry types apart', () => {
        const table = decodeTile(encodeTile([{
            name: 'land',
            extent: 4096,
            features: [
                {id: 1, geometry: {type: 'LineString', coordinates: [[0, 0], [400, 0], [400, 400], [0, 0]]}, properties: {}},
                {id: 2, geometry: {type: 'Polygon', coordinates: [[[500, 0], [900, 0], [700, 400]]]}, properties: {}},
                {id: 3, geometry: {type: 'Point', coordinates: [1000, 1000]}, properties: {}}
            ]
        }]))[0];

        const {row, columnar} = populateBoth(FILL_BUCKETS, table);

        expect(columnar).toEqual(row);
        expect(columnar.indexed).toEqual([0, 1, 2]);
    });

    test('populates a columnar bucket from a row list when it is given one', () => {
        const table = decodeTile(encodePolygons())[0];
        const sourceLayer = new MLTVectorTileLayer(table);
        const {options, insert} = populateOptions();
        const bucket = new FillBucket(bucketParameters(createFillLayer()));

        bucket.populate(rowsOf(sourceLayer), options, CANONICAL);

        expect(insert).toHaveBeenCalledTimes(3);
        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
    });
});

describe('FillBucket populated from the columns of ring-encoded polygons in a tile away from the poles', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('draws the same triangles and outlines and indexes the same boxes as from the rows', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const table of [decodeTile(encodePolygons())[0], decodeTile(encodeMultiPolygons())[0]]) {
            const rowOptions = populateOptions();
            const row = new FillBucket(bucketParameters(createFillLayer()));
            row.populate(rowsOf(new MLTVectorTileLayer(table)), rowOptions.options, INNER_CANONICAL);
            const columnarOptions = populateOptions();
            const columnar = new FillBucket(bucketParameters(createFillLayer()));
            columnar.populate(new MLTVectorTileLayer(table), columnarOptions.options, INNER_CANONICAL);

            expect(drawn(row).triangles.length).toBeGreaterThan(0);
            expect(drawn(columnar)).toEqual(drawn(row));
            expect(columnarOptions.insert.mock.calls.map(call => [call[2], ringBoxes(call[1])]))
                .toEqual(rowOptions.insert.mock.calls.map(call => [call[2], ringBoxes(call[1])]));
        }
    });

    test('indexes a pattern fill, which it writes only later, with the same boxes as from the rows', () => {
        const table = decodeTile(encodeMultiPolygons())[0];
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const row = indexedBoxes(new FillBucket(bucketParameters(patternLayer())), rowsOf(new MLTVectorTileLayer(table)));
        const columnar = indexedBoxes(new FillBucket(bucketParameters(patternLayer())), new MLTVectorTileLayer(table));

        expect(columnar).toEqual(row);
        expect(columnar.flat().length).toBeGreaterThan(0);
    });

    test('writes what the rows give when the tile is subdivided', () => {
        const table = decodeTile(encodePolygons())[0];
        const subdivided = new SubdivisionGranularitySetting({
            fill: new SubdivisionGranularityExpression(128, 2),
            line: new SubdivisionGranularityExpression(128, 2),
            tile: new SubdivisionGranularityExpression(128, 2),
            stencil: new SubdivisionGranularityExpression(128, 2),
            circle: 3
        });
        const rowOptions = populateOptions();
        rowOptions.options.subdivisionGranularity = subdivided;
        const row = new FillBucket(bucketParameters(createFillLayer()));
        row.populate(rowsOf(new MLTVectorTileLayer(table)), rowOptions.options, INNER_CANONICAL);
        const columnarOptions = populateOptions();
        columnarOptions.options.subdivisionGranularity = subdivided;
        const columnar = new FillBucket(bucketParameters(createFillLayer()));
        columnar.populate(new MLTVectorTileLayer(table), columnarOptions.options, INNER_CANONICAL);

        expect(fillArrays(columnar)).toEqual(fillArrays(row));
    });
});

describe('FillStyleLayer.createBucket', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('creates a columnar bucket for an MLT layer whose filter can be planned', () => {
        const layer = createFillLayer(['==', 'class', 'a']);

        const bucket: Bucket = layer.createBucket(bucketParameters(layer, 'mlt'));

        expect(bucket.isColumnar).toBe(true);
    });

    test('creates a row-based bucket for an MVT layer', () => {
        const layer = createFillLayer(['==', 'class', 'a']);

        const bucket: Bucket = layer.createBucket(bucketParameters(layer, 'mvt'));

        expect(bucket.isColumnar).toBe(false);
    });

    test('falls back to the row-based bucket and says so once when the filter cannot be planned', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const layer = createFillLayer(['within', {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}] as FilterSpecification);

        const first = layer.createBucket(bucketParameters(layer, 'mlt'));
        layer.createBucket(bucketParameters(layer, 'mlt'));

        expect(first.isColumnar).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('layer "fill": filter is not supported');
    });
});

describe('FillBucket populated from the columns of a pre-tessellated tile', () => {
    test('writes the tile\'s own triangles and indexes every feature by its bounding box', () => {
        const tables = preTessellatedTables();
        expect(tables.length).toBeGreaterThan(0);

        for (const table of tables) {
            const geometryVector = table.geometryVector as GpuVector;
            const {options, insert} = populateOptions();
            const bucket = new FillBucket(bucketParameters(createFillLayer()));

            bucket.populate(new MLTVectorTileLayer(table), options, INNER_CANONICAL);

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

    test('ignores the tile\'s triangles and writes what FillBucket writes on the globe and at the poles', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const globe = new SubdivisionGranularitySetting({
            fill: new SubdivisionGranularityExpression(128, 2),
            line: new SubdivisionGranularityExpression(128, 2),
            tile: new SubdivisionGranularityExpression(128, 2),
            stencil: new SubdivisionGranularityExpression(128, 2),
            circle: 3
        });
        const cases: Array<[CanonicalTileID, SubdivisionGranularitySetting]> = [
            [INNER_CANONICAL, globe],
            [CANONICAL, SubdivisionGranularitySetting.noSubdivision]
        ];
        for (const table of preTessellatedTables()) {
            for (const [canonical, granularity] of cases) {
                const rowOptions = populateOptions();
                rowOptions.options.subdivisionGranularity = granularity;
                const row = new FillBucket(bucketParameters(createFillLayer()));
                row.populate(rowsOf(new MLTVectorTileLayer(table)), rowOptions.options, canonical);
                const columnarOptions = populateOptions();
                columnarOptions.options.subdivisionGranularity = granularity;
                const columnar = new FillBucket(bucketParameters(createFillLayer()));
                columnar.populate(new MLTVectorTileLayer(table), columnarOptions.options, canonical);

                expect(fillArrays(row).triangles.length).toBeGreaterThan(0);
                expect(fillArrays(columnar)).toEqual(fillArrays(row));
                expect(columnarOptions.insert.mock.calls.map(call => [call[2], ringBoxes(call[1])]))
                    .toEqual(rowOptions.insert.mock.calls.map(call => [call[2], ringBoxes(call[1])]));
            }
        }
    });
});

describe('FillBucket populated from the columns of a pre-tessellated layer without ring topology', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('draws the triangles, has no outline and says so', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {options, insert} = populateOptions();
        const bucket = new FillBucket(bucketParameters(createFillLayer()));

        bucket.populate(triangleOnlyLayer(), options, INNER_CANONICAL);

        expect(bucket.indexArray).toHaveLength(3);
        // Four vertices of the square and three of the triangle, each position once per feature.
        expect(bucket.layoutVertexArray).toHaveLength(7);
        expect(bucket.indexArray2).toHaveLength(0);
        expect(insert).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('without ring topology');
    });
});

