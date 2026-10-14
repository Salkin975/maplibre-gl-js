import {describe, test, expect} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import {decodeTile, GpuVector} from '@maplibre/mlt';
import {FillLayoutArray, LineIndexArray, TriangleIndexArray} from '../../array_types.g.ts';
import {SegmentVector} from '../../segment.ts';
import {fillLargeMeshArrays} from '../../../render/fill_large_mesh_arrays.ts';
import {buildTessellatedFillMesh, extentScale, reserveTessellatedFill, writeTessellatedFill, type FillMeshTarget} from './columnar_mesh_arrays.ts';

describe('buildTessellatedFillMesh', () => {
    test('draws every feature\'s triangles from that feature\'s own vertices', () => {
        const file = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
        const tables = decodeTile(new Uint8Array(readFileSync(file)));
        const tessellated = tables.filter(table => table.geometryVector instanceof GpuVector);
        expect(tessellated.length).toBeGreaterThan(0);

        for (const table of tessellated) {
            const geometryVector = table.geometryVector as GpuVector;
            const scale = extentScale(table.extent);
            for (let index = 1; index < table.numFeatures; index++) {
                const mesh = buildTessellatedFillMesh(geometryVector, index, scale);
                const ringVertices = mesh.lineIndexLists.flat();

                expect(mesh.triangleIndices.length).toBeGreaterThan(0);
                expect(mesh.flattenedVertices.length / 2).toBe(new Set(ringVertices).size);
            }
        }
    });
});

describe('writeTessellatedFill', () => {
    const tile = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
    const tessellatedTables = () => decodeTile(new Uint8Array(readFileSync(tile)))
        .filter(table => table.geometryVector instanceof GpuVector);

    test('draws the triangles and the outline of the mesh builder, counter-clockwise', () => {
        const tables = tessellatedTables();
        expect(tables.length).toBeGreaterThan(0);

        for (const table of tables) {
            const geometryVector = table.geometryVector as GpuVector;
            const scale = extentScale(table.extent);
            for (let index = 0; index < table.numFeatures; index++) {
                const written = createTarget();
                writeTessellatedFill(written, geometryVector, index, scale);

                const mesh = buildTessellatedFillMesh(geometryVector, index, scale);
                const reference = createTarget();
                fillLargeMeshArrays(
                    (x, y) => reference.layoutVertexArray.emplaceBack(x, y),
                    reference.segments,
                    reference.layoutVertexArray,
                    reference.indexArray,
                    mesh.flattenedVertices,
                    mesh.triangleIndices,
                    reference.segments2,
                    reference.indexArray2,
                    mesh.lineIndexLists,
                );

                expect(trianglesOf(written).length).toBeGreaterThan(0);
                expect(trianglesOf(written)).toEqual(trianglesOf(reference));
                expect(edgesOf(written)).toEqual(edgesOf(reference));
                for (const [a, b, c] of trianglesOf(written)) {
                    expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeLessThanOrEqual(0);
                }
            }
        }
    });

    test('splits a feature that does not fit one segment over several, like fillLargeMeshArrays', () => {
        const numVertices = SegmentVector.MAX_VERTEX_ARRAY_LENGTH + 5000;
        const target = createTarget();

        writeTessellatedFill(target, ringOfVertices(numVertices), 0, 1);

        expect(target.indexArray).toHaveLength(numVertices - 2);
        expect(target.segments.segments.length).toBeGreaterThan(1);
        expect(target.indexArray2).toHaveLength(numVertices);
    });

    test('draws no outline for a layer without ring topology', () => {
        const target = createTarget();
        const geometryVector = {
            triangleOffsets: new Uint32Array([0, 1]),
            indexBuffer: new Uint32Array([0, 1, 2]),
            vertexBuffer: new Int32Array([0, 0, 10, 0, 0, 10]),
            topologyVector: undefined
        } as unknown as GpuVector;

        writeTessellatedFill(target, geometryVector, 0, 1);

        expect(target.indexArray).toHaveLength(1);
        expect(target.layoutVertexArray).toHaveLength(3);
        expect(target.indexArray2).toHaveLength(0);
    });

    test('scales and clamps the vertices of the tile alike for an integer and a fractional scale', () => {
        const geometryVector = {
            triangleOffsets: new Uint32Array([0, 1]),
            indexBuffer: new Uint32Array([0, 1, 2]),
            vertexBuffer: new Int32Array([1, 3, 20000, -20000, 0, 0]),
            topologyVector: undefined
        } as unknown as GpuVector;
        const integer = createTarget();
        const fractional = createTarget();

        writeTessellatedFill(integer, geometryVector, 0, 2);
        writeTessellatedFill(fractional, geometryVector, 0, 1.5);

        // The integer scale doubles, and both clamp what leaves the 15 bit range that loadGeometry() uses.
        expect(Array.from(integer.layoutVertexArray.int16.slice(0, 6))).toEqual([2, 6, 16383, -16384, 0, 0]);
        // The fractional scale rounds half up: 1.5 -> 2, 4.5 -> 5.
        expect(Array.from(fractional.layoutVertexArray.int16.slice(0, 6))).toEqual([2, 5, 16383, -16384, 0, 0]);
    });

    test('flips the triangles of a feature that winds clockwise, and only that feature', () => {
        const target = createTarget();
        const geometryVector = {
            triangleOffsets: new Uint32Array([0, 1, 2]),
            indexBuffer: new Uint32Array([0, 1, 2, 0, 1, 2]),
            // The first triangle has a negative cross product (kept), the second a positive one (flipped).
            vertexBuffer: new Int32Array([0, 0, 0, 10, 10, 0, 0, 0, 10, 0, 0, 10]),
            topologyVector: undefined
        } as unknown as GpuVector;

        writeTessellatedFill(target, geometryVector, 0, 1);
        writeTessellatedFill(target, geometryVector, 1, 1);

        for (const [a, b, c] of trianglesOf(target)) {
            expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeLessThanOrEqual(0);
        }
    });
});

describe('reserveTessellatedFill', () => {
    test('makes room for the triangles and the vertices of the features, without writing any', () => {
        const file = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
        const table = decodeTile(new Uint8Array(readFileSync(file))).find(t => t.geometryVector instanceof GpuVector);
        const geometryVector = table.geometryVector as GpuVector;
        const target = createTarget();
        const features = Array.from({length: table.numFeatures}, (_, index) => ({index}));

        reserveTessellatedFill(target, geometryVector, features);

        expect(target.indexArray.capacity).toBeGreaterThanOrEqual(geometryVector.triangleOffsets[table.numFeatures]);
        expect(target.layoutVertexArray.capacity).toBeGreaterThanOrEqual(geometryVector.topologyVector.ringOffsets.at(-1));
        expect(target.indexArray).toHaveLength(0);
        expect(target.layoutVertexArray).toHaveLength(0);
    });
});

type Position = [number, number];

function createTarget(): FillMeshTarget {
    return {
        layoutVertexArray: new FillLayoutArray(),
        indexArray: new TriangleIndexArray(),
        indexArray2: new LineIndexArray(),
        segments: new SegmentVector(),
        segments2: new SegmentVector()
    };
}

/** The triangles a target holds, as vertex positions in the order they are drawn. */
function trianglesOf(target: FillMeshTarget): Position[][] {
    const {int16} = target.layoutVertexArray;
    const {uint16} = target.indexArray;
    const position = (vertex: number): Position => [int16[vertex * 2], int16[vertex * 2 + 1]];
    return Array.from({length: target.indexArray.length}, (_, i) => [0, 1, 2].map(corner => position(uint16[i * 3 + corner])));
}

/** The outline edges a target holds, as pairs of vertex positions. */
function edgesOf(target: FillMeshTarget): Position[][] {
    const {int16} = target.layoutVertexArray;
    const {uint16} = target.indexArray2;
    const position = (vertex: number): Position => [int16[vertex * 2], int16[vertex * 2 + 1]];
    return Array.from({length: target.indexArray2.length}, (_, i) => [position(uint16[i * 2]), position(uint16[i * 2 + 1])]);
}

/**
 * A feature that is one ring of `numVertices` vertices, covered by a triangle fan. The vertices lie on
 * a grid, so that every one has a position of its own.
 */
function ringOfVertices(numVertices: number): GpuVector {
    const vertexBuffer = new Int32Array(numVertices * 2);
    for (let i = 0; i < numVertices; i++) {
        vertexBuffer[i * 2] = i % 300;
        vertexBuffer[i * 2 + 1] = Math.floor(i / 300);
    }
    const indexBuffer = new Uint32Array((numVertices - 2) * 3);
    for (let i = 0; i < numVertices - 2; i++) indexBuffer.set([0, i + 1, i + 2], i * 3);

    return {
        triangleOffsets: new Uint32Array([0, numVertices - 2]),
        indexBuffer,
        vertexBuffer,
        topologyVector: {ringOffsets: new Uint32Array([0, numVertices])},
        getGeometry: () => {
            const ring = Array.from({length: numVertices}, (_, i) => ({x: vertexBuffer[i * 2], y: vertexBuffer[i * 2 + 1]}));
            return [[...ring, ring[0]]];
        }
    } as unknown as GpuVector;
}
