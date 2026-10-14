import {GpuVector, SINGLE_PART_GEOMETRY_TYPE} from '@maplibre/mlt';
import {LineBucket} from '../line_bucket.ts';
import {warnOnce} from '../../../util/util.ts';
import {register} from '../../../util/web_worker_transfer.ts';
import {hasRingTopology} from '../../../source/vector_tile_mlt.ts';
import {addPhase} from '../../../source/worker_timing.ts';
import {selectColumnarFeatures, materializeSelectedFeatures, isRowFeatureList, columnarTransferOmitList} from './columnar_populate.ts';

import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {BucketParameters, IndexedFeature, PopulateParameters} from '../../bucket.ts';
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

        const lineSortKey = layer.layout.get('line-sort-key');
        const selectStart = performance.now();
        const selection = selectColumnarFeatures(featureTable, layer.filter, this.zoom, [
            SINGLE_PART_GEOMETRY_TYPE.LINESTRING,
            SINGLE_PART_GEOMETRY_TYPE.POLYGON,
        ]);
        const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, this.sourceLayerIndex, options.featureIndex, {
            hasDashes: true,
            sortKey: lineSortKey.isConstant() ? undefined : (bucketFeature) => lineSortKey.evaluate(bucketFeature, {}, canonical),
        });
        addPhase('selectMaterialize', selectStart);

        this.addBucketFeatures(bucketFeatures, index => sourceLayer.feature(index), options, canonical);
    }
}

register('ColumnarLineBucket', ColumnarLineBucket, {omit: columnarTransferOmitList<ColumnarLineBucket>(['layers', 'patternFeatures'])});
