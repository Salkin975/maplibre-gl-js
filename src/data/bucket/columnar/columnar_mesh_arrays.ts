import Point from '@mapbox/point-geometry';
import earcut from 'earcut';
import {clamp, warnOnce} from '../../../util/util.ts';
import {EXTENT} from '../../extent.ts';
import {SegmentVector} from '../../segment.ts';
import {tessellatedVertexBase} from '../../../source/vector_tile_mlt.ts';
import {fixWindingOrder} from '../../../render/subdivision.ts';
import {fillLargeMeshArrays} from '../../../render/fill_large_mesh_arrays.ts';

import type {GeometryVector, GpuVector} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {FillLayoutArray, LineIndexArray, TriangleIndexArray} from '../../array_types.g.ts';

/** The ring, part and geometry offsets of a layer. */
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
type FillMesh = {
    /** Flattened vertex positions (xyxyxy…), already scaled to the internal `EXTENT`. */
    flattenedVertices: number[];
    /** Triangle indices into `flattenedVertices`' vertex pairs. */
    triangleIndices: number[];
    /** One index list per ring, for the polygon's outline. */
    lineIndexLists: number[][];
};

/** Takes the outline edges {@link appendRingOutline} writes, as a `LineIndexArray` does. */
type OutlineEdges = {
    emplaceBack(from: number, to: number): unknown;
};

/** The rings of a polygon feature, scaled the way `loadGeometry()` scales them. */
type ScaledRings = {
    /** Flattened vertex positions (xyxyxy…) of all rings, each ring closed by repeating its first vertex. */
    coordinates: number[];
    /** The vertex each ring begins at, followed by the number of vertices. */
    ringStarts: number[];
};

/** The number of bits a vertex coordinate is stored in, which bounds the range `loadGeometry()` clamps to. */
const COORDINATE_BITS = 15;
const MAX_COORDINATE = 2 ** (COORDINATE_BITS - 1) - 1;
const MIN_COORDINATE = -MAX_COORDINATE - 1;

/** The most rings one polygon is triangulated with, the limit `FillBucket` hands `classifyRings()`. */
const EARCUT_MAX_RINGS = 500;

/** The factor that carries a coordinate of a layer with the given extent into the internal `EXTENT`. */
export function extentScale(extent: number): number {
    return EXTENT / extent;
}

/**
 * Writes an outline edge between each pair of neighbouring vertices of the ring `[start, end)` to
 * `edges`, and one from the last vertex back to the first when `closeRing` is set, for a ring that
 * does not repeat its first vertex at the end.
 */
function appendRingOutline(edges: OutlineEdges, start: number, end: number, closeRing: boolean): void {
    for (let vertex = start + 1; vertex < end; vertex++) edges.emplaceBack(vertex - 1, vertex);
    if (closeRing) edges.emplaceBack(end - 1, start);
}

/** Collects the edges of one ring into `line`, a ring's list in {@link FillMesh.lineIndexLists}. */
function lineIndexList(line: number[]): OutlineEdges {
    return {emplaceBack: (from, to) => line.push(from, to)};
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
 * Where a feature of a pre-tessellated layer lies in the layer's buffers.
 *
 * A feature's vertices are its rings in order, each without the point that closes it, and its triangle
 * indices count from the feature's first vertex. A layer without ring topology stores no rings, so its
 * ring range is empty and its vertex count is read off the highest index its triangles use.
 */
type TessellatedFeature = {
    /** The feature's first vertex in `vertexBuffer`. */
    vertexBase: number;
    numVertices: number;
    /** The range of the feature's triangle indices in `indexBuffer`. */
    triangleStart: number;
    triangleEnd: number;
    /** The range of the feature's rings in `ringOffsets`. */
    firstRing: number;
    endRing: number;
};

/** Finds feature `index` of a pre-tessellated layer in the layer's buffers. */
function locateTessellatedFeature(geometryVector: GpuVector, index: number): TessellatedFeature {
    const {triangleOffsets, topologyVector} = geometryVector;
    const ringOffsets = topologyVector?.ringOffsets;
    const triangleStart = triangleOffsets[index] * 3;
    const triangleEnd = triangleOffsets[index + 1] * 3;
    if (!ringOffsets) {
        const vertexBase = tessellatedVertexBase(geometryVector, index);
        const numVertices = tessellatedVertexBase(geometryVector, index + 1) - vertexBase;
        return {vertexBase, numVertices, triangleStart, triangleEnd, firstRing: 0, endRing: 0};
    }

    const firstRing = firstRingOf(topologyVector, index);
    const endRing = endRingOf(topologyVector, index);
    const vertexBase = ringOffsets[firstRing];
    const numVertices = ringOffsets[endRing] - vertexBase;
    return {vertexBase, numVertices, triangleStart, triangleEnd, firstRing, endRing};
}

/**
 * Builds one feature's pre-tessellated mesh from a `GpuVector`, in the shape `fillLargeMeshArrays()`
 * consumes: the feature's vertices scaled to the internal `EXTENT`, its triangles, and an outline edge
 * between each pair of neighbouring vertices of a ring.
 *
 * The tile guarantees no particular triangle orientation, so the triangles go through the same
 * `fixWindingOrder()` that an earcut-tessellated feature does. A layer without ring topology yields an
 * empty `lineIndexLists`, since its triangles are all it stores of a polygon's shape.
 */
export function buildTessellatedFillMesh(geometryVector: GpuVector, index: number, scale: number): FillMesh {
    const {indexBuffer, vertexBuffer, topologyVector} = geometryVector;
    const {vertexBase, numVertices, triangleStart, triangleEnd, firstRing, endRing} = locateTessellatedFeature(geometryVector, index);

    const flattenedVertices: number[] = [];
    for (let v = vertexBase * 2; v < (vertexBase + numVertices) * 2; v++) {
        flattenedVertices.push(scaleCoordinate(vertexBuffer[v], scale));
    }
    const triangleIndices = fixWindingOrder(flattenedVertices, Array.from(indexBuffer.subarray(triangleStart, triangleEnd)));

    const lineIndexLists: number[][] = [];
    for (let ring = firstRing; ring < endRing; ring++) {
        const start = topologyVector.ringOffsets[ring] - vertexBase;
        const end = topologyVector.ringOffsets[ring + 1] - vertexBase;
        const line: number[] = [];
        appendRingOutline(lineIndexList(line), start, end, true);
        lineIndexLists.push(line);
    }

    return {flattenedVertices, triangleIndices, lineIndexLists};
}

/** Writes `mesh` into the arrays of a fill bucket, split over as many segments as its vertices need. */
function writeMesh(target: FillMeshTarget, mesh: FillMesh): void {
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

/**
 * Writes one feature of a pre-tessellated layer straight into the arrays of a fill bucket.
 *
 * The result draws the same triangles and the same outline as {@link buildTessellatedFillMesh} followed by
 * `fillLargeMeshArrays()`, without building the mesh in between. Triangles are written counter-clockwise,
 * as `fixWindingOrder()` makes them; the winding is read off the tile's own coordinates, because scaling by
 * a positive factor keeps it.
 *
 * A feature with more vertices than one segment holds goes through {@link buildTessellatedFillMesh} and
 * `fillLargeMeshArrays()`, which split it over several segments. A layer without ring topology gets no
 * outline, but its vertex and segment bookkeeping is kept in step with the outline segments all the same.
 */
export function writeTessellatedFill(target: FillMeshTarget, geometryVector: GpuVector, index: number, scale: number): void {
    const {indexBuffer, vertexBuffer, topologyVector} = geometryVector;
    const {vertexBase, numVertices, triangleStart, triangleEnd, firstRing, endRing} = locateTessellatedFeature(geometryVector, index);
    if (numVertices === 0) return;

    if (numVertices >= SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
        writeMesh(target, buildTessellatedFillMesh(geometryVector, index, scale));
        return;
    }

    const ringOffsets = topologyVector?.ringOffsets;
    const {layoutVertexArray, indexArray, indexArray2} = target;
    const triangleSegment = target.segments.prepareSegment(numVertices, layoutVertexArray, indexArray);
    const triangleBase = triangleSegment.vertexLength;
    for (let i = triangleStart; i < triangleEnd; i += 3) {
        const a = indexBuffer[i], b = indexBuffer[i + 1], c = indexBuffer[i + 2];
        const ax = vertexBuffer[(vertexBase + a) * 2], ay = vertexBuffer[(vertexBase + a) * 2 + 1];
        const bx = vertexBuffer[(vertexBase + b) * 2], by = vertexBuffer[(vertexBase + b) * 2 + 1];
        const cx = vertexBuffer[(vertexBase + c) * 2], cy = vertexBuffer[(vertexBase + c) * 2 + 1];
        const clockwise = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0;
        indexArray.emplaceBack(triangleBase + a, triangleBase + (clockwise ? c : b), triangleBase + (clockwise ? b : c));
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
        appendRingOutline(indexArray2, start, end, true);
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
 * Makes room in the arrays of a fill bucket for the polygons `features` of `geometryVector`, which
 * {@link writeEarcutFill} writes, so that writing them does not grow the arrays step by step.
 *
 * The counts come from the ring offsets: every ring is written closed, so with one vertex more, and has
 * one outline edge per stored vertex. Earcut makes about one triangle per vertex, which is the estimate.
 */
export function reserveEarcutFill(target: FillMeshTarget, geometryVector: GeometryVector, features: ReadonlyArray<{index: number}>): void {
    const {topologyVector} = geometryVector;
    const ringOffsets = topologyVector.ringOffsets;
    let vertices = 0;
    let rings = 0;
    for (const {index} of features) {
        const firstRing = firstRingOf(topologyVector, index);
        const endRing = endRingOf(topologyVector, index);
        vertices += ringOffsets[endRing] - ringOffsets[firstRing];
        rings += endRing - firstRing;
    }
    target.layoutVertexArray.reserve(target.layoutVertexArray.length + vertices + rings);
    target.indexArray.reserve(target.indexArray.length + vertices + rings);
    target.indexArray2.reserve(target.indexArray2.length + vertices);
}

/**
 * Tells whether `subdividePolygon()` changes the polygons of tile `canonical`: it subdivides them at a
 * granularity of 2 or more, which the globe uses at every zoom, and it extends the polygons of a tile on
 * the north or south edge of the world to the poles, in every projection. Neither write straight from
 * the tile does either, so such a tile is triangulated by `FillBucket`.
 */
export function needsSubdivision(canonical: CanonicalTileID, granularity: number): boolean {
    return granularity >= 2 || canonical.y === 0 || canonical.y === (1 << canonical.z) - 1;
}

/**
 * Tells whether {@link writeEarcutFill} can write the polygons of `geometryVector` in tile `canonical`.
 *
 * It can when the vertices are stored as x and y pairs with ring offsets, and `subdividePolygon()` would
 * leave the polygons as they are ({@link needsSubdivision}).
 */
export function canWriteEarcutFill(geometryVector: GeometryVector, canonical: CanonicalTileID, granularity: number): boolean {
    const {partOffsets, ringOffsets} = geometryVector.topologyVector;
    const isMortonEncoded = !!geometryVector.vertexOffsets && !!geometryVector.mortonSettings;
    return !needsSubdivision(canonical, granularity) && !!partOffsets && !!ringOffsets && !isMortonEncoded;
}

/**
 * Triangulates polygon feature `index` of `geometryVector` with earcut and writes it straight into the
 * arrays of a fill bucket, without making a point of each vertex.
 *
 * The rings are grouped into polygons as `classifyRings()` groups them, and each polygon gets the
 * triangles and outline `FillBucket.addFeature()` gives it when there is no subdivision, counter-clockwise
 * as `fixWindingOrder()` makes them. A vertex that repeats a position, like the one that closes a ring, is
 * written again rather than shared, which draws the same.
 */
export function writeEarcutFill(target: FillMeshTarget, geometryVector: GeometryVector, index: number, scale: number): void {
    const rings = readScaledRings(geometryVector, index, scale);
    for (const polygon of classifyRingRanges(rings)) {
        writeMesh(target, buildEarcutMesh(rings, polygon));
    }
}

/**
 * Reads the rings of polygon feature `index` from the vertex buffer, scaled and clamped like
 * `loadGeometry()` does it, with its warning when a coordinate lies outside the range.
 */
function readScaledRings(geometryVector: GeometryVector, index: number, scale: number): ScaledRings {
    const {vertexBuffer, vertexOffsets, topologyVector} = geometryVector;
    const ringOffsets = topologyVector.ringOffsets;
    const coordinates: number[] = [];
    const ringStarts: number[] = [];

    const endRing = endRingOf(topologyVector, index);
    for (let ring = firstRingOf(topologyVector, index); ring < endRing; ring++) {
        const start = ringOffsets[ring];
        const end = ringOffsets[ring + 1];
        ringStarts.push(coordinates.length / 2);
        if (end === start) continue;

        const first = coordinates.length;
        for (let vertex = start; vertex < end; vertex++) {
            const offset = (vertexOffsets ? vertexOffsets[vertex] : vertex) * 2;
            coordinates.push(scaleCheckedCoordinate(vertexBuffer[offset], scale), scaleCheckedCoordinate(vertexBuffer[offset + 1], scale));
        }
        coordinates.push(coordinates[first], coordinates[first + 1]);
    }
    ringStarts.push(coordinates.length / 2);
    return {coordinates, ringStarts};
}

/** {@link scaleCoordinate}, warning like `loadGeometry()` when the coordinate had to be clamped by more than a unit. */
function scaleCheckedCoordinate(value: number, scale: number): number {
    const scaled = Math.round(value * scale);
    if (scaled < MIN_COORDINATE || scaled > MAX_COORDINATE + 1) {
        warnOnce('Geometry exceeds allowed extent, reduce your vector tile buffer size');
    }
    return clamp(scaled, MIN_COORDINATE, MAX_COORDINATE);
}

/**
 * Groups the rings into polygons by index, as `classifyRings()` groups them: a ring that winds like the
 * first one begins a polygon and every other ring is a hole of the polygon before it. Rings without area
 * are left out unless there is only one ring, and a polygon keeps its {@link EARCUT_MAX_RINGS} largest rings.
 */
function classifyRingRanges({coordinates, ringStarts}: ScaledRings): number[][] {
    const ringCount = ringStarts.length - 1;
    if (ringCount <= 1) return [ringCount === 1 ? [0] : []];

    const polygons: number[][] = [];
    const areas: number[] = [];
    let polygon: number[] | undefined;
    let ccw: boolean | undefined;
    for (let ring = 0; ring < ringCount; ring++) {
        const area = signedArea(coordinates, ringStarts[ring], ringStarts[ring + 1]);
        if (area === 0) continue;

        areas[ring] = Math.abs(area);
        ccw ??= area < 0;
        if (polygon && ccw !== area < 0) {
            polygon.push(ring);
            continue;
        }
        if (polygon) polygons.push(polygon);
        polygon = [ring];
    }
    if (polygon) polygons.push(polygon);

    return polygons.map(rings => rings.length <= EARCUT_MAX_RINGS ? rings :
        [rings[0], ...rings.slice(1).sort((a, b) => areas[b] - areas[a]).slice(0, EARCUT_MAX_RINGS - 1)]);
}

/** The signed area of the ring of vertices `[start, end)`, as `calculateSignedArea()` computes it for a ring of points. */
function signedArea(coordinates: number[], start: number, end: number): number {
    let sum = 0;
    for (let i = start, j = end - 1; i < end; j = i++) {
        sum += (coordinates[j * 2] - coordinates[i * 2]) * (coordinates[i * 2 + 1] + coordinates[j * 2 + 1]);
    }
    return sum;
}

/**
 * Triangulates the rings `polygon` lists, the first being the outer ring, and lists their outline edges.
 * A polygon of all the feature's rings in order, the common case, is triangulated on the feature's
 * coordinates as they are; any other gets a copy of its own rings.
 */
function buildEarcutMesh({coordinates, ringStarts}: ScaledRings, polygon: number[]): FillMesh {
    const allRings = polygon.length === ringStarts.length - 1 && polygon.every((ring, i) => ring === i);
    const flattenedVertices: number[] = allRings ? coordinates : [];
    const holeIndices: number[] = [];
    const lineIndexLists: number[][] = [];
    for (const ring of polygon) {
        const first = allRings ? ringStarts[ring] : flattenedVertices.length / 2;
        const count = ringStarts[ring + 1] - ringStarts[ring];
        if (ring !== polygon[0] && count > 0) holeIndices.push(first);

        if (!allRings) {
            for (let i = ringStarts[ring] * 2; i < ringStarts[ring + 1] * 2; i++) flattenedVertices.push(coordinates[i]);
        }
        const line: number[] = [];
        appendRingOutline(lineIndexList(line), first, first + count, false);
        lineIndexLists.push(line);
    }
    const triangleIndices = fixWindingOrder(flattenedVertices, earcut(flattenedVertices, holeIndices));
    return {flattenedVertices, triangleIndices, lineIndexLists};
}

/**
 * The bounding box of the vertices `[start, end)` of `vertexBuffer`, read through `vertexOffsets` when
 * the layer stores its vertices in a dictionary, as a two-point "ring" of its min and max corners - what
 * `FeatureIndex.insert()` reads from a ring, without making a point of each vertex. Only the two corners
 * are scaled, since {@link scaleCoordinate} keeps the order of coordinates; no vertices give no corners.
 */
function buildBoundingBox(vertexBuffer: Int32Array | Uint32Array, vertexOffsets: Uint32Array | undefined, start: number, end: number, scale: number): Point[] {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let vertex = start; vertex < end; vertex++) {
        const offset = (vertexOffsets ? vertexOffsets[vertex] : vertex) * 2;
        const x = vertexBuffer[offset];
        const y = vertexBuffer[offset + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return minX > maxX ? [] : [
        new Point(scaleCoordinate(minX, scale), scaleCoordinate(minY, scale)),
        new Point(scaleCoordinate(maxX, scale), scaleCoordinate(maxY, scale)),
    ];
}

/** The {@link buildBoundingBox} of each ring of polygon feature `index`. */
export function buildRingBoundingBoxes(geometryVector: GeometryVector, index: number, scale: number): Point[][] {
    const {vertexBuffer, vertexOffsets, topologyVector} = geometryVector;
    const ringOffsets = topologyVector.ringOffsets;
    const boxes: Point[][] = [];
    const endRing = endRingOf(topologyVector, index);
    for (let ring = firstRingOf(topologyVector, index); ring < endRing; ring++) {
        boxes.push(buildBoundingBox(vertexBuffer, vertexOffsets, ringOffsets[ring], ringOffsets[ring + 1], scale));
    }
    return boxes;
}

/**
 * The {@link buildBoundingBox} of all vertices of feature `index` of a pre-tessellated layer, as its
 * single ring - all `FeatureIndex.insert()` needs for pre-tessellated tiles, whose rings are otherwise
 * never decoded. A feature without vertices has no ring.
 */
export function buildTessellatedBoundingBox(geometryVector: GpuVector, index: number, scale: number): Point[][] {
    const {vertexBase, numVertices} = locateTessellatedFeature(geometryVector, index);
    const box = buildBoundingBox(geometryVector.vertexBuffer, undefined, vertexBase, vertexBase + numVertices, scale);
    return box.length ? [box] : [];
}
