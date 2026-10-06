import Point from '@mapbox/point-geometry';
import {clamp} from '../../../util/util.ts';
import {EXTENT} from '../../extent.ts';
import {hasRingTopology, tessellatedVertexBase} from '../../../source/vector_tile_mlt.ts';
import {fixWindingOrder} from '../../../render/subdivision.ts';

import type {GpuVector} from '@maplibre/mlt';

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
