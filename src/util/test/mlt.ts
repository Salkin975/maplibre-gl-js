import {readFileSync} from 'fs';
import path from 'path';
import {decodeTile, FeatureTable, GEOMETRY_TYPE, GpuVector} from '@maplibre/mlt';
import {MLTVectorTileLayer} from '../../source/vector_tile_mlt.ts';

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

/**
 * Returns a pre-tessellated layer of two polygons that stores only triangles: a square (two
 * triangles, four vertices) and a triangle. No ring topology, so there is no outline and no
 * per-feature vertex count.
 */
export function triangleOnlyLayer(): MLTVectorTileLayer {
    const geometryVector = createTriangleOnlyGpuVector(
        new Uint32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.POLYGON]),
        new Uint32Array([0, 2, 3]),
        new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 2]),
        new Int32Array([0, 0, 100, 0, 100, 100, 0, 100, 200, 0, 300, 0, 250, 100])
    );
    return new MLTVectorTileLayer(new FeatureTable('land', geometryVector, undefined, [], 4096, 2));
}

/** Returns the pre-tessellated layers of a zoom-5 tile from the integration assets, all of them with ring topology. */
export function preTessellatedTables(): FeatureTable[] {
    const file = path.join(__dirname, '../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
    return decodeTile(new Uint8Array(readFileSync(file))).filter(table => table.geometryVector instanceof GpuVector);
}
