import {GeometryVector, GpuVector} from '@maplibre/mlt';
import {FillBucket} from '../fill_bucket.ts';
import {warnOnce} from '../../../util/util.ts';
import {register} from '../../../util/web_worker_transfer.ts';
import {selectColumnarFeatures, materializeSelectedFeatures, isRowFeatureList, loadGeometryOrEmpty, columnarTransferOmitList} from './columnar_populate.ts';
import {writeTessellatedFill, reserveTessellatedFill, buildTessellatedBoundingBox, extentScale, canWriteEarcutFill, writeEarcutFill, reserveEarcutFill, buildRingBoundingBoxes} from './columnar_mesh_arrays.ts';
import {hasRingTopology} from '../../../source/vector_tile_mlt.ts';

import type Point from '@mapbox/point-geometry';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {ImagePosition} from '../../../render/image_atlas.ts';
import type {BucketParameters, BucketDependencyParameters, BucketFeature, IndexedFeature, PopulateParameters} from '../../bucket.ts';
import type {FillStyleLayer} from '../../../style/style_layer/fill_style_layer.ts';
import type {SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings.ts';

/**
 * A `FillBucket` that selects its features from an MLT feature table's columns and writes them straight
 * from the table's vertex buffer: a pre-tessellated tile's triangles come from the tile's own mesh, and
 * any other tile's polygons are triangulated by earcut on the buffer, without making a point of each
 * vertex. A tile that `subdividePolygon()` would change - on the globe, or at the edge of the world - is
 * triangulated by `FillBucket`, and so is a line or point, which `FillBucket` fills as the area it
 * encloses. Sorting, pattern handling and indexing are `FillBucket`'s own.
 */
export class ColumnarFillBucket extends FillBucket {
    isColumnar = true;
    sourceLayerIndex: number;

    /** Set while the bucket writes features straight from the tile's geometry, so `addFeature()` can read it. */
    private direct: {geometryVector: GpuVector | GeometryVector; scale: number} | undefined;

    constructor(options: BucketParameters<FillStyleLayer>) {
        super(options);
        this.sourceLayerIndex = options.sourceLayerIndex;
    }

    populate(features: IndexedFeature[] | MLTVectorTileLayer, options: PopulateParameters, canonical: CanonicalTileID): void {
        if (isRowFeatureList(features)) {
            super.populate(features, options, canonical);
            return;
        }
        const sourceLayer = features;
        const {featureTable} = sourceLayer;
        const layer = this.layers[0];

        const geometryVector = featureTable.geometryVector;
        const isTessellated = geometryVector instanceof GpuVector;
        if (isTessellated && !hasRingTopology(geometryVector)) {
            warnOnce(`Fill layer "${layer.id}" is pre-tessellated without ring topology, so it draws no outline and "fill-outline-color" has no effect on it.`);
        }
        const granularity = options.subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z);
        const isEarcut = geometryVector instanceof GeometryVector && canWriteEarcutFill(geometryVector, canonical, granularity);
        this.direct = isTessellated || isEarcut ? {geometryVector, scale: extentScale(featureTable.extent)} : undefined;

        const fillSortKey = layer.layout.get('fill-sort-key');
        const selection = selectColumnarFeatures(featureTable, layer.filter, this.zoom);
        const sourceFeatures: VectorTileFeatureLike[] = [];
        const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, this.sourceLayerIndex, options.featureIndex, {
            features: sourceFeatures,
            resolveGeometry: (feature, index) => this.indexedGeometry(feature, index),
            sortKey: fillSortKey.isConstant()
                ? undefined
                : (bucketFeature) => fillSortKey.evaluate(bucketFeature, {}, canonical, options.availableImages),
        });

        if (isTessellated) reserveTessellatedFill(this, geometryVector, bucketFeatures);
        else if (isEarcut) reserveEarcutFill(this, geometryVector, bucketFeatures.filter(isPolygon));
        this.addBucketFeatures(bucketFeatures, index => sourceFeatures[index], options, canonical);
        if (!this.hasDependencies) this.releaseDirectGeometry();
    }

    addFeatures(parameters: BucketDependencyParameters): void {
        super.addFeatures(parameters);
        this.releaseDirectGeometry();
    }

    /**
     * Writes a polygon straight from the tile's geometry when the bucket does so, see the class; its
     * `geometry` is then only the bounding boxes `FeatureIndex` needs. Any other feature is triangulated
     * by `FillBucket`.
     */
    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: Record<string, ImagePosition>, subdivisionGranularity: SubdivisionGranularitySetting): void {
        if (!this.direct || !isPolygon(feature)) {
            super.addFeature(feature, geometry, index, canonical, imagePositions, subdivisionGranularity);
            return;
        }

        const {geometryVector, scale} = this.direct;
        if (geometryVector instanceof GpuVector) writeTessellatedFill(this, geometryVector, index, scale);
        else writeEarcutFill(this, geometryVector, index, scale);
        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, canonical});
    }

    /**
     * The geometry a feature is indexed with for `queryRenderedFeatures`: its bounding boxes when the
     * bucket writes it straight from the tile's geometry, else its rings.
     */
    private indexedGeometry(feature: VectorTileFeatureLike, index: number): Point[][] {
        if (!this.direct || !isPolygon(feature)) return loadGeometryOrEmpty(feature, index);

        const {geometryVector, scale} = this.direct;
        return geometryVector instanceof GpuVector ?
            buildTessellatedBoundingBox(geometryVector, index, scale) :
            buildRingBoundingBoxes(geometryVector, index, scale);
    }

    /**
     * Drops the tile's geometry once the bucket has written everything it needs from it.
     *
     * The bucket itself is structure-cloned to the main thread, and neither a `GpuVector` nor a
     * `GeometryVector` is a class `web_worker_transfer` knows how to send.
     */
    private releaseDirectGeometry(): void {
        this.direct = undefined;
    }
}

/** Whether a feature is a polygon, the only geometry the bucket writes straight from the tile. */
function isPolygon(feature: {type: VectorTileFeatureLike['type']}): boolean {
    return feature.type === 3;
}

register('ColumnarFillBucket', ColumnarFillBucket, {omit: columnarTransferOmitList<ColumnarFillBucket>(['layers', 'patternFeatures'])});
