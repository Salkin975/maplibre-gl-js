import {GeometryVector, GpuVector} from '@maplibre/mlt';
import {warnOnce} from '../../../util/util.ts';
import {selectColumnarFeatures, materializeSelectedFeatures, loadGeometryOrEmpty} from './columnar_populate.ts';
import {writeTessellatedFill, reserveTessellatedFill, buildTessellatedBoundingBox, extentScale, canWriteEarcutFill, writeEarcutFill, reserveEarcutFill, buildRingBoundingBoxes, needsSubdivision} from './columnar_mesh_arrays.ts';
import {hasRingTopology} from '../../../source/vector_tile_mlt.ts';

import type Point from '@mapbox/point-geometry';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {PopulateParameters} from '../../bucket.ts';
import type {FillBucket} from '../fill_bucket.ts';
import type {FillMeshTarget} from './columnar_mesh_arrays.ts';

/**
 * The geometry column of an MLT tile whose polygons a fill bucket writes straight from the column's
 * vertex buffer, and the factor that scales the tile's extent to the internal one.
 *
 * Neither a `GpuVector` nor a `GeometryVector` is a class `web_worker_transfer` knows how to send, so
 * a bucket must have let go of this before it is structure-cloned to the main thread.
 */
export type TileFillGeometry = {
    geometryVector: GpuVector | GeometryVector;
    scale: number;
};

/**
 * Populates a fill bucket from an MLT layer: the layer filter selects the features on the feature
 * table's columns, and polygons are written straight from the table's vertex buffer. A
 * pre-tessellated tile's triangles come from the tile's own mesh, and any other tile's polygons are
 * triangulated by earcut on the buffer, without making a point of each vertex.
 *
 * A tile that `subdividePolygon()` would change - on the globe, or at the edge of the world - is
 * triangulated by the bucket from its rings, a pre-tessellated tile included, whose mesh is not
 * subdivided and is then not used; so is a line or point, which a fill layer fills as the area it
 * encloses. Sorting, pattern handling and indexing are the bucket's `addBucketFeatures()`, the same
 * as for row features.
 *
 * `bucket.tileGeometry` is set while features are written. A bucket that waits for its patterns
 * keeps it until `addFeatures()` has written them.
 */
export function populateColumnarFill(bucket: FillBucket, sourceLayer: MLTVectorTileLayer, options: PopulateParameters, canonical: CanonicalTileID): void {
    const {featureTable} = sourceLayer;
    const layer = bucket.layers[0];

    const geometryVector = featureTable.geometryVector;
    const granularity = options.subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z);
    const usesTileMesh = geometryVector instanceof GpuVector && !needsSubdivision(canonical, granularity);
    if (usesTileMesh && !hasRingTopology(geometryVector)) {
        warnOnce(`Fill layer "${layer.id}" is pre-tessellated without ring topology, so it draws no outline and "fill-outline-color" has no effect on it.`);
    }
    const isEarcut = geometryVector instanceof GeometryVector && canWriteEarcutFill(geometryVector, canonical, granularity);
    const tileGeometry: TileFillGeometry | undefined = usesTileMesh || isEarcut ? {geometryVector, scale: extentScale(featureTable.extent)} : undefined;
    bucket.tileGeometry = tileGeometry;

    const fillSortKey = layer.layout.get('fill-sort-key');
    const selection = selectColumnarFeatures(featureTable, layer.filter, bucket.zoom);
    const sourceFeatures: VectorTileFeatureLike[] = [];
    const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, bucket.sourceLayerIndex, options.featureIndex, {
        features: sourceFeatures,
        resolveGeometry: (feature, index) => indexedGeometry(tileGeometry, feature, index),
        sortKey: fillSortKey.isConstant()
            ? undefined
            : (bucketFeature) => fillSortKey.evaluate(bucketFeature, {}, canonical, options.availableImages),
    });

    if (usesTileMesh) reserveTessellatedFill(bucket, geometryVector, bucketFeatures);
    else if (isEarcut) reserveEarcutFill(bucket, geometryVector, bucketFeatures.filter(isPolygon));
    bucket.addBucketFeatures(bucketFeatures, index => sourceFeatures[index], options, canonical);
    if (!bucket.hasDependencies) bucket.tileGeometry = undefined;
}

/**
 * Writes the triangles and outline of polygon `index` straight from the tile's geometry into
 * `target`. The feature's own `geometry` is then only the bounding boxes `FeatureIndex` needs, see
 * {@link populateColumnarFill}.
 */
export function writeFillFromTile(target: FillMeshTarget, tileGeometry: TileFillGeometry, index: number): void {
    const {geometryVector, scale} = tileGeometry;
    if (geometryVector instanceof GpuVector) writeTessellatedFill(target, geometryVector, index, scale);
    else writeEarcutFill(target, geometryVector, index, scale);
}

/** Whether a feature is a polygon, the only geometry a fill bucket writes straight from the tile. */
export function isPolygon(feature: {type: VectorTileFeatureLike['type']}): boolean {
    return feature.type === 3;
}

/**
 * The geometry a feature is indexed with for `queryRenderedFeatures`: its bounding boxes when the
 * bucket writes it straight from the tile's geometry, else its rings.
 */
function indexedGeometry(tileGeometry: TileFillGeometry | undefined, feature: VectorTileFeatureLike, index: number): Point[][] {
    if (!tileGeometry || !isPolygon(feature)) return loadGeometryOrEmpty(feature);

    const {geometryVector, scale} = tileGeometry;
    return geometryVector instanceof GpuVector ?
        buildTessellatedBoundingBox(geometryVector, index, scale) :
        buildRingBoundingBoxes(geometryVector, index, scale);
}
