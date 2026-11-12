import {GpuVector} from '@maplibre/mlt';

/** A {@link GpuVector} over the arrays it is given, with a geometry type per feature. */
class TestGpuVector extends GpuVector {
    constructor(
        private readonly geometryTypes: Uint32Array,
        triangleOffsets: Uint32Array,
        indexBuffer: Uint32Array,
        vertexBuffer: Int32Array
    ) {
        super(triangleOffsets, indexBuffer, vertexBuffer);
    }

    geometryType(index: number): number {
        return this.geometryTypes[index];
    }

    get numGeometries(): number {
        return this.geometryTypes.length;
    }

    containsSingleGeometryType(): boolean {
        return false;
    }
}

/**
 * Returns a pre-tessellated geometry column that stores only triangles, without ring topology.
 * `encodeTile()` writes no pre-tessellated layers, so tests build this case by hand.
 *
 * @param geometryTypes - The geometry type of each feature.
 * @param triangleOffsets - Where each feature's triangles start, counted in triangles, with one more entry for the end.
 * @param indexBuffer - Three vertex indices per triangle.
 * @param vertexBuffer - The x and y of each vertex, interleaved.
 */
export function createTriangleOnlyGpuVector(
    geometryTypes: Uint32Array,
    triangleOffsets: Uint32Array,
    indexBuffer: Uint32Array,
    vertexBuffer: Int32Array
): GpuVector {
    return new TestGpuVector(geometryTypes, triangleOffsets, indexBuffer, vertexBuffer);
}
