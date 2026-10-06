import {describe, test, expect} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import {decodeTile, GpuVector} from '@maplibre/mlt';
import {buildTessellatedFillMesh, extentScale} from './columnar_mesh_arrays.ts';

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
