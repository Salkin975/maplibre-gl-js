import {GpuVector, SINGLE_PART_GEOMETRY_TYPE} from '@maplibre/mlt';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';
import {warnOnce} from '../../../util/util.ts';
import {hasRingTopology} from '../../../source/vector_tile_mlt.ts';
import {selectColumnarFeatures, materializeSelectedFeatures} from './columnar_populate.ts';

import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {PopulateParameters} from '../../bucket.ts';
import type {LineBucket} from '../line_bucket.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/**
 * Populates a line bucket from an MLT layer: the layer filter selects the features on the feature
 * table's columns, and writing them is the bucket's `addBucketFeatures()`, the same as for row
 * features.
 *
 * Only the LineString and Polygon features a layer's filter selects are ever materialized. Lines have
 * no pre-tessellated form - how many vertices a line yields depends on its joins, caps and
 * subdivision - so only the selection is columnar.
 */
export function populateColumnarLine(bucket: LineBucket, sourceLayer: MLTVectorTileLayer, options: PopulateParameters, canonical: CanonicalTileID): void {
    const {featureTable} = sourceLayer;
    const layer = bucket.layers[0];

    const geometryVector = featureTable.geometryVector;
    if (geometryVector instanceof GpuVector && !hasRingTopology(geometryVector)) {
        warnOnce(`Line layer "${layer.id}" reads a pre-tessellated source layer that stores only triangles, which holds no line for it to draw, so the layer is skipped.`);
        return;
    }

    bucket.hasLineClipColumns = !!featureTable.getPropertyVector(GEOJSONVT_CLIP_START) && !!featureTable.getPropertyVector(GEOJSONVT_CLIP_END);
    const lineSortKey = layer.layout.get('line-sort-key');
    const selection = selectColumnarFeatures(featureTable, layer.filter, bucket.zoom, [
        SINGLE_PART_GEOMETRY_TYPE.LINESTRING,
        SINGLE_PART_GEOMETRY_TYPE.POLYGON,
    ]);
    const sourceFeatures: VectorTileFeatureLike[] = [];
    const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, bucket.sourceLayerIndex, options.featureIndex, {
        features: sourceFeatures,
        hasDashes: true,
        sortKey: lineSortKey.isConstant() ? undefined : (bucketFeature) => lineSortKey.evaluate(bucketFeature, {}, canonical),
    });

    bucket.addBucketFeatures(bucketFeatures, index => sourceFeatures[index], options, canonical);
}
