import Point from '@mapbox/point-geometry';
import {clamp} from '../../../util/util.ts';
import {EXTENT} from '../../extent.ts';
import {SegmentVector} from '../../segment.ts';
import {hasRingTopology, tessellatedVertexBase} from '../../../source/vector_tile_mlt.ts';
import {fixWindingOrder} from '../../../render/subdivision.ts';
import {fillLargeMeshArrays} from '../../../render/fill_large_mesh_arrays.ts';

import type {GpuVector} from '@maplibre/mlt';
import type {FillLayoutArray, LineIndexArray, TriangleIndexArray} from '../../array_types.g.ts';

/** The ring, part and geometry offsets of a pre-tessellated layer. */
type Topology = NonNullable<GpuVector['topologyVector']>;

/** The arrays and segments a fill bucket writes a feature's triangles and outline into. */
export type FillMeshTarget = {
    layoutVertexArray: FillLayoutArray;
    indexArray: TriangleIndexArray;
    indexArray2: LineIndexArray;
    segments: SegmentVector;
    segments2: SegmentVector;
};

/** A fill polygon's triangles and outline edges, in the shape `fillLargeMeshArrays()` consumes. */
export type FillMesh = {
    /** Flattened vertex positions (xyxyxy…), already scaled to the internal `EXTENT`. */
    flattenedVertices: number[];
    /** Triangle indices into `flattenedVertices`' vertex pairs. */
    triangleIndices: number[];
    /** One index list per ring, for the polygon's outline. */
    lineIndexLists: number[][];
};

/** The number of bits a vertex coordinate is stored in, which bounds the range `loadGeometry()` clamps to. */
const COORDINATE_BITS = 15;
const MAX_COORDINATE = 2 ** (COORDINATE_BITS - 1) - 1;
const MIN_COORDINATE = -MAX_COORDINATE - 1;

/** The factor that carries a coordinate of a layer with the given extent into the internal `EXTENT`. */
export function extentScale(extent: number): number {
    return EXTENT / extent;
}

/** Scales one coordinate and clamps it, matching `loadGeometry()`'s per-point transform. */
function scaleCoordinate(value: number, scale: number): number {
    return clamp(Math.round(value * scale), MIN_COORDINATE, MAX_COORDINATE);
}

/**
 * Appends the vertices `[start, end)` of `vertexBuffer`, a flat list of x and y, to `layoutVertexArray`
 * scaled by `scale`, with the same result as {@link scaleCoordinate} for each coordinate.
 *
 * An integer scale, which is what every layer whose extent divides `EXTENT` has, keeps whole numbers
 * whole, so the rounding is left out and the clamp is two comparisons.
 */
function appendScaledVertices(layoutVertexArray: FillLayoutArray, vertexBuffer: Int32Array | Uint32Array, start: number, end: number, scale: number): void {
    if (!Number.isInteger(scale)) {
        for (let v = start; v < end; v += 2) {
            layoutVertexArray.emplaceBack(scaleCoordinate(vertexBuffer[v], scale), scaleCoordinate(vertexBuffer[v + 1], scale));
        }
        return;
    }

    for (let v = start; v < end; v += 2) {
        const x = vertexBuffer[v] * scale;
        const y = vertexBuffer[v + 1] * scale;
        layoutVertexArray.emplaceBack(
            x > MAX_COORDINATE ? MAX_COORDINATE : x < MIN_COORDINATE ? MIN_COORDINATE : x,
            y > MAX_COORDINATE ? MAX_COORDINATE : y < MIN_COORDINATE ? MIN_COORDINATE : y);
    }
}

/**
 * Packs a scaled coordinate pair into one number, so that vertices can be deduplicated by position
 * in a `Map` without the cost of a string key.
 */
function coordinateKey(x: number, y: number): number {
    const span = MAX_COORDINATE - MIN_COORDINATE + 1;
    return (x - MIN_COORDINATE) * span + (y - MIN_COORDINATE);
}

/**
 * Builds one feature's pre-tessellated mesh from a `GpuVector`: triangles from its shared triangle and
 * vertex buffers, outline rings via its own `getGeometry()` (which already walks the ring/part/geometry
 * offset hierarchy correctly, including the Polygon/MultiPolygon distinction).
 *
 * Vertices are deduplicated by their scaled coordinate rather than by buffer position, so a ring point
 * that coincides with a triangle vertex after scaling becomes the same output vertex - the fill and its
 * outline never separate at a seam. The tile guarantees no particular triangle orientation, so the
 * triangles go through the same `fixWindingOrder()` that an earcut-tessellated feature does.
 *
 * A layer without ring topology yields an empty `lineIndexLists`, since its triangles are all it
 * stores of a polygon's shape.
 */
export function buildTessellatedFillMesh(geometryVector: GpuVector, index: number, scale: number): FillMesh {
    const {triangleOffsets, indexBuffer, vertexBuffer} = geometryVector;

    const flattenedVertices: number[] = [];
    const localIndexByCoordinate = new Map<number, number>();

    function localIndexOf(x: number, y: number): number {
        const key = coordinateKey(x, y);
        let local = localIndexByCoordinate.get(key);
        if (local === undefined) {
            local = localIndexByCoordinate.size;
            localIndexByCoordinate.set(key, local);
            flattenedVertices.push(x, y);
        }
        return local;
    }

    const vertexBase = tessellatedVertexBase(geometryVector, index);
    function localIndexOfBufferVertex(featureVertexIndex: number): number {
        const vertex = vertexBase + featureVertexIndex;
        return localIndexOf(
            scaleCoordinate(vertexBuffer[vertex * 2], scale),
            scaleCoordinate(vertexBuffer[vertex * 2 + 1], scale),
        );
    }

    const triangleStart = triangleOffsets[index] * 3;
    const triangleEnd = triangleOffsets[index + 1] * 3;
    const tileTriangles: number[] = [];
    for (let i = triangleStart; i < triangleEnd; i += 3) {
        tileTriangles.push(
            localIndexOfBufferVertex(indexBuffer[i]),
            localIndexOfBufferVertex(indexBuffer[i + 1]),
            localIndexOfBufferVertex(indexBuffer[i + 2]),
        );
    }
    const triangleIndices = fixWindingOrder(flattenedVertices, tileTriangles);

    const rings = hasRingTopology(geometryVector) ? geometryVector.getGeometry(index) : [];
    const lineIndexLists: number[][] = [];
    for (const ring of rings) {
        // Rings close by repeating their first point, so consecutive pairs already include the closing edge.
        const line: number[] = [];
        let previous = localIndexOf(scaleCoordinate(ring[0].x, scale), scaleCoordinate(ring[0].y, scale));
        for (let i = 1; i < ring.length; i++) {
            const current = localIndexOf(scaleCoordinate(ring[i].x, scale), scaleCoordinate(ring[i].y, scale));
            line.push(previous, current);
            previous = current;
        }
        lineIndexLists.push(line);
    }

    return {flattenedVertices, triangleIndices, lineIndexLists};
}

/** The index of the first ring of feature `index`. */
function firstRingOf(topology: Topology | undefined, index: number): number {
    const part = topology?.geometryOffsets?.[index] ?? index;
    return topology?.partOffsets?.[part] ?? part;
}

/** The index one past the last ring of feature `index`. */
function endRingOf(topology: Topology | undefined, index: number): number {
    const part = topology?.geometryOffsets?.[index + 1] ?? index + 1;
    return topology?.partOffsets?.[part] ?? part;
}

/** One more than the highest vertex index the triangles in `[start, end)` of `indexBuffer` use, or 0 for none. */
function highestVertexCount(indexBuffer: Uint32Array, start: number, end: number): number {
    let count = 0;
    for (let i = start; i < end; i++) {
        if (indexBuffer[i] >= count) count = indexBuffer[i] + 1;
    }
    return count;
}

/**
 * Tells whether the triangles of a feature wind the way that `fixWindingOrder()` flips: the sign of the
 * cross product of the first triangle that has an area.
 *
 * A tessellator gives all triangles of a polygon one orientation, so one triangle speaks for the feature.
 * The test runs on the tile's own coordinates, because scaling by a positive factor keeps the sign.
 */
function windsClockwise(vertexBuffer: Int32Array | Uint32Array, vertexBase: number, indexBuffer: Uint32Array, start: number, end: number): boolean {
    for (let i = start; i < end; i += 3) {
        const a = (vertexBase + indexBuffer[i]) * 2;
        const b = (vertexBase + indexBuffer[i + 1]) * 2;
        const c = (vertexBase + indexBuffer[i + 2]) * 2;
        const cross = (vertexBuffer[b] - vertexBuffer[a]) * (vertexBuffer[c + 1] - vertexBuffer[a + 1]) -
            (vertexBuffer[b + 1] - vertexBuffer[a + 1]) * (vertexBuffer[c] - vertexBuffer[a]);
        if (cross !== 0) return cross > 0;
    }
    return false;
}

/**
 * Writes one feature of a pre-tessellated layer straight into the arrays of a fill bucket.
 *
 * A feature's vertices are its rings in order, each without the point that closes it, and its triangle
 * indices count from the feature's first vertex. The vertices are therefore copied as they are, scaled to
 * the internal `EXTENT`, and an outline edge is a pair of neighbouring vertices of a ring, so nothing has
 * to be matched by position. The result draws the same triangles and the same outline as
 * {@link buildTessellatedFillMesh} followed by `fillLargeMeshArrays()`, with the vertices in the tile's
 * order. Triangles are written counter-clockwise, flipping the whole feature when its first triangle is not.
 *
 * A feature with more vertices than one segment holds goes through {@link buildTessellatedFillMesh} and
 * `fillLargeMeshArrays()`, which split it over several segments. A layer without ring topology gets no
 * outline, but its vertex and segment bookkeeping is kept in step with the outline segments all the same.
 */
export function writeTessellatedFill(target: FillMeshTarget, geometryVector: GpuVector, index: number, scale: number): void {
    const {triangleOffsets, indexBuffer, vertexBuffer, topologyVector} = geometryVector;
    const ringOffsets = topologyVector?.ringOffsets;
    const vertexBase = tessellatedVertexBase(geometryVector, index);
    const triangleStart = triangleOffsets[index] * 3;
    const triangleEnd = triangleOffsets[index + 1] * 3;
    const firstRing = ringOffsets ? firstRingOf(topologyVector, index) : 0;
    const endRing = ringOffsets ? endRingOf(topologyVector, index) : 0;
    const numVertices = ringOffsets ?
        ringOffsets[endRing] - vertexBase :
        highestVertexCount(indexBuffer, triangleStart, triangleEnd);
    if (numVertices === 0) return;

    if (numVertices >= SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
        const mesh = buildTessellatedFillMesh(geometryVector, index, scale);
        fillLargeMeshArrays(
            (x, y) => target.layoutVertexArray.emplaceBack(x, y),
            target.segments,
            target.layoutVertexArray,
            target.indexArray,
            mesh.flattenedVertices,
            mesh.triangleIndices,
            target.segments2,
            target.indexArray2,
            mesh.lineIndexLists,
        );
        return;
    }

    const {layoutVertexArray, indexArray, indexArray2} = target;
    const triangleSegment = target.segments.prepareSegment(numVertices, layoutVertexArray, indexArray);
    const triangleBase = triangleSegment.vertexLength;
    const second = windsClockwise(vertexBuffer, vertexBase, indexBuffer, triangleStart, triangleEnd) ? 2 : 1;
    const third = 3 - second;
    for (let i = triangleStart; i < triangleEnd; i += 3) {
        indexArray.emplaceBack(triangleBase + indexBuffer[i], triangleBase + indexBuffer[i + second], triangleBase + indexBuffer[i + third]);
    }
    triangleSegment.vertexLength += numVertices;
    triangleSegment.primitiveLength += (triangleEnd - triangleStart) / 3;

    const lineSegment = target.segments2.prepareSegment(numVertices, layoutVertexArray, indexArray2);
    const lineBase = lineSegment.vertexLength;
    lineSegment.vertexLength += numVertices;

    appendScaledVertices(layoutVertexArray, vertexBuffer, vertexBase * 2, (vertexBase + numVertices) * 2, scale);

    for (let ring = firstRing; ring < endRing; ring++) {
        const start = lineBase + ringOffsets[ring] - vertexBase;
        const end = lineBase + ringOffsets[ring + 1] - vertexBase;
        for (let v = start + 1; v < end; v++) indexArray2.emplaceBack(v - 1, v);
        indexArray2.emplaceBack(end - 1, start);
        lineSegment.primitiveLength += end - start;
    }
}

/**
 * Makes room in the arrays of a fill bucket for `features` of a pre-tessellated layer, so that writing
 * them does not grow the arrays step by step.
 *
 * The triangle count comes from the layer's triangle offsets and the vertex and outline-edge counts from
 * its ring offsets, so no pass over the geometry is needed. A layer without ring topology only gets its
 * triangle index array sized, since its vertex count is not stored.
 */
export function reserveTessellatedFill(target: FillMeshTarget, geometryVector: GpuVector, features: ReadonlyArray<{index: number}>): void {
    const {triangleOffsets, topologyVector} = geometryVector;
    const ringOffsets = topologyVector?.ringOffsets;
    let triangles = 0;
    let vertices = 0;
    for (const {index} of features) {
        triangles += triangleOffsets[index + 1] - triangleOffsets[index];
        if (ringOffsets) vertices += ringOffsets[endRingOf(topologyVector, index)] - ringOffsets[firstRingOf(topologyVector, index)];
    }
    target.indexArray.reserve(target.indexArray.length + triangles);
    if (!ringOffsets) return;

    target.layoutVertexArray.reserve(target.layoutVertexArray.length + vertices);
    target.indexArray2.reserve(target.indexArray2.length + vertices);
}

/**
 * A feature's bounding box as a single degenerate "ring" of its min and max corners - all
 * `FeatureIndex.insert()` needs for pre-tessellated tiles, whose rings are otherwise never decoded.
 */
export function buildTessellatedBoundingBox(geometryVector: GpuVector, index: number, scale: number): Point[][] {
    const {triangleOffsets, indexBuffer, vertexBuffer} = geometryVector;
    const start = triangleOffsets[index] * 3;
    const end = triangleOffsets[index + 1] * 3;
    const vertexBase = tessellatedVertexBase(geometryVector, index);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = start; i < end; i++) {
        const vertexIndex = vertexBase + indexBuffer[i];
        const x = scaleCoordinate(vertexBuffer[vertexIndex * 2], scale);
        const y = scaleCoordinate(vertexBuffer[vertexIndex * 2 + 1], scale);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return [[new Point(minX, minY), new Point(maxX, maxY)]];
}
