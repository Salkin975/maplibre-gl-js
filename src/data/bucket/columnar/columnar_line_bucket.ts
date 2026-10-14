import {GpuVector, SINGLE_PART_GEOMETRY_TYPE} from '@maplibre/mlt';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';
import {LineBucket} from '../line_bucket.ts';
import {warnOnce} from '../../../util/util.ts';
import {register} from '../../../util/web_worker_transfer.ts';
import {hasRingTopology} from '../../../source/vector_tile_mlt.ts';
import {selectColumnarFeatures, materializeSelectedFeatures, isRowFeatureList, columnarTransferOmitList} from './columnar_populate.ts';

import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {BucketParameters, BucketFeature, IndexedFeature, PopulateParameters} from '../../bucket.ts';
import type {LineStyleLayer} from '../../../style/style_layer/line_style_layer.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/**
 * A `LineBucket` that selects its features from an MLT feature table's columns; writing them is
 * `LineBucket`'s own `addBucketFeatures()`.
 *
 * Only the LineString and Polygon features a layer's filter selects are ever materialized. Lines have
 * no pre-tessellated form - how many vertices a line yields depends on its joins, caps and
 * subdivision - so only the selection is columnar.
 */
export class ColumnarLineBucket extends LineBucket {
    isColumnar = true;
    sourceLayerIndex: number;

    /**
     * Whether the feature table being written has the columns geojson-vt gives a line it cut. Asking a
     * feature of an MLT layer for a column it does not have is a column lookup each time, so a table
     * without them is asked once instead of once per feature.
     */
    hasLineClipColumns = true;

    constructor(options: BucketParameters<LineStyleLayer>) {
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
        if (geometryVector instanceof GpuVector && !hasRingTopology(geometryVector)) {
            warnOnce(`Line layer "${layer.id}" reads a pre-tessellated source layer that stores only triangles, which holds no line for it to draw, so the layer is skipped.`);
            return;
        }

        this.hasLineClipColumns = !!featureTable.getPropertyVector(GEOJSONVT_CLIP_START) && !!featureTable.getPropertyVector(GEOJSONVT_CLIP_END);
        const lineSortKey = layer.layout.get('line-sort-key');
        const selection = selectColumnarFeatures(featureTable, layer.filter, this.zoom, [
            SINGLE_PART_GEOMETRY_TYPE.LINESTRING,
            SINGLE_PART_GEOMETRY_TYPE.POLYGON,
        ]);
        const sourceFeatures: VectorTileFeatureLike[] = [];
        const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, this.sourceLayerIndex, options.featureIndex, {
            features: sourceFeatures,
            hasDashes: true,
            sortKey: lineSortKey.isConstant() ? undefined : (bucketFeature) => lineSortKey.evaluate(bucketFeature, {}, canonical),
        });

        this.addBucketFeatures(bucketFeatures, index => sourceFeatures[index], options, canonical);
    }

    lineFeatureClips(feature: BucketFeature): ReturnType<LineBucket['lineFeatureClips']> {
        return this.hasLineClipColumns ? super.lineFeatureClips(feature) : undefined;
    }
}

register('ColumnarLineBucket', ColumnarLineBucket, {omit: columnarTransferOmitList<ColumnarLineBucket>(['layers', 'patternFeatures', 'hasLineClipColumns'])});
