import {GpuVector, SINGLE_PART_GEOMETRY_TYPE} from '@maplibre/mlt';
import {FillBucket} from '../fill_bucket.ts';
import {warnOnce} from '../../../util/util.ts';
import {register} from '../../../util/web_worker_transfer.ts';
import {fillLargeMeshArrays} from '../../../render/fill_large_mesh_arrays.ts';
import {selectColumnarFeatures, materializeSelectedFeatures, isRowFeatureList, loadGeometryOrEmpty, columnarTransferOmitList} from './columnar_populate.ts';
import {buildTessellatedFillMesh, buildTessellatedBoundingBox, extentScale} from './columnar_mesh_arrays.ts';
import {hasRingTopology, MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

import type Point from '@mapbox/point-geometry';
import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {ImagePosition} from '../../../render/image_atlas.ts';
import type {BucketParameters, BucketDependencyParameters, BucketFeature, IndexedFeature, PopulateParameters} from '../../bucket.ts';
import type {FillStyleLayer} from '../../../style/style_layer/fill_style_layer.ts';
import type {SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings.ts';

/**
 * A `FillBucket` that selects its features from an MLT feature table's columns. When the tile is
 * pre-tessellated, a feature's triangles come straight from the tile's own mesh instead of from
 * earcut; everything else - sorting, pattern handling, indexing - is `FillBucket`'s own.
 */
export class ColumnarFillBucket extends FillBucket {
    isColumnar = true;
    sourceLayerIndex: number;

    /** Set while a pre-tessellated tile is being written, so `addFeature()` can read its mesh. */
    private tessellatedGeometryVector: GpuVector | undefined;
    private tessellatedScale: number | undefined;

    constructor(options: BucketParameters<FillStyleLayer>) {
        super(options);
        this.sourceLayerIndex = options.sourceLayerIndex;
    }

    populate(features: IndexedFeature[] | FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        if (isRowFeatureList(features)) {
            super.populate(features, options, canonical);
            return;
        }
        const featureTable = features;
        const layer = this.layers[0];

        const geometryVector = featureTable.geometryVector;
        const isTessellated = geometryVector instanceof GpuVector;
        if (isTessellated && !hasRingTopology(geometryVector)) {
            warnOnce(`Fill layer "${layer.id}" is pre-tessellated without ring topology, so it draws no outline and "fill-outline-color" has no effect on it.`);
        }
        const scale = extentScale(featureTable.extent);
        this.tessellatedGeometryVector = isTessellated ? geometryVector : undefined;
        this.tessellatedScale = scale;

        const fillSortKey = layer.layout.get('fill-sort-key');
        const sourceLayer = new MLTVectorTileLayer(featureTable);
        const selection = selectColumnarFeatures(featureTable, layer.filter, this.zoom, [SINGLE_PART_GEOMETRY_TYPE.POLYGON]);
        const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, this.sourceLayerIndex, {
            resolveGeometry: (feature, index) => isTessellated
                ? buildTessellatedBoundingBox(geometryVector, index, scale)
                : loadGeometryOrEmpty(feature, index),
            sortKey: fillSortKey.isConstant()
                ? undefined
                : (bucketFeature) => fillSortKey.evaluate(bucketFeature, {}, canonical, options.availableImages),
        });

        this.addBucketFeatures(bucketFeatures, index => sourceLayer.feature(index), options, canonical);
        if (!this.hasDependencies) this.releaseTessellationState();
    }

    addFeatures(parameters: BucketDependencyParameters): void {
        super.addFeatures(parameters);
        this.releaseTessellationState();
    }

    /**
     * Writes a feature of a pre-tessellated tile from the tile's own mesh, whose `geometry` is only the
     * bounding box `FeatureIndex` needs; any other feature is triangulated by `FillBucket`.
     */
    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: Record<string, ImagePosition>, subdivisionGranularity: SubdivisionGranularitySetting): void {
        if (!this.tessellatedGeometryVector) {
            super.addFeature(feature, geometry, index, canonical, imagePositions, subdivisionGranularity);
            return;
        }

        const mesh = buildTessellatedFillMesh(this.tessellatedGeometryVector, index, this.tessellatedScale);
        fillLargeMeshArrays(
            (x, y) => this.layoutVertexArray.emplaceBack(x, y),
            this.segments,
            this.layoutVertexArray,
            this.indexArray,
            mesh.flattenedVertices,
            mesh.triangleIndices,
            this.segments2,
            this.indexArray2,
            mesh.lineIndexLists,
        );
        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, canonical});
    }

    /**
     * Drops the tile's decoded columns once the bucket has written everything it needs from them.
     *
     * The bucket itself is structure-cloned to the main thread, and a `GpuVector` is not a class
     * `web_worker_transfer` knows how to send.
     */
    private releaseTessellationState(): void {
        this.tessellatedGeometryVector = undefined;
        this.tessellatedScale = undefined;
    }
}

register('ColumnarFillBucket', ColumnarFillBucket, {omit: columnarTransferOmitList<ColumnarFillBucket>(['layers', 'patternFeatures'])});
