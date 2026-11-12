import {GpuVector} from '@maplibre/mlt';

/**
 * A pre-tessellated geometry column that stores only triangles, without ring topology.
 * `encodeTile()` writes no pre-tessellated layers, so tests build this case by hand.
 */
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

export function createTriangleOnlyGpuVector(
    geometryTypes: Uint32Array,
    triangleOffsets: Uint32Array,
    indexBuffer: Uint32Array,
    vertexBuffer: Int32Array
): GpuVector {
    return new TestGpuVector(geometryTypes, triangleOffsets, indexBuffer, vertexBuffer);
}
