import {SymbolBucket} from '../symbol_bucket.ts';
import {register} from '../../../util/web_worker_transfer.ts';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {toEvaluationFeature} from '../../evaluation_feature.ts';
import {selectColumnarFeatures, isRowFeatureList} from './columnar_populate.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {IndexedFeature, PopulateParameters} from '../../bucket.ts';

/**
 * A `SymbolBucket` that selects its features from an MLT feature table's columns.
 *
 * It replaces only the selection: the layer filter runs over the columns, and every selected feature
 * then goes through `SymbolBucket`'s own `addSymbolFeature()` and `finishSymbolFeatures()`, so text and
 * icon are resolved, glyphs and images requested, lines merged and features sorted by the same code as
 * on the row path. Layout and collision are inherited, as is `performSymbolLayout()`. Symbols are not
 * entered into the `FeatureIndex`; `queryRenderedFeatures` reaches them by re-reading the raw tile, so
 * `sourceLayerIndex` is part of what the bucket sends to the main thread.
 */
export class ColumnarSymbolBucket extends SymbolBucket {
    isColumnar = true;

    populate(features: IndexedFeature[] | FeatureTable, options: PopulateParameters, canonical: CanonicalTileID): void {
        if (isRowFeatureList(features)) {
            super.populate(features, options, canonical);
            return;
        }
        const featureTable = features;
        const hasText = this.layoutHasText();
        const hasIcon = this.layoutHasIcon();

        this.features = [];
        if (!hasText && !hasIcon) return;

        const needGeometry = this.layers[0]._featureFilter.needGeometry;
        const sourceLayer = new MLTVectorTileLayer(featureTable);
        const selection = selectColumnarFeatures(featureTable, this.layers[0].filter, this.zoom);
        for (let i = 0; i < selection.limit; i++) {
            const index = selection.getIndex(i);
            const feature = sourceLayer.feature(index);
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);
            this.addSymbolFeature(feature, evaluationFeature, feature.id, index, this.sourceLayerIndex, hasText, hasIcon, options, canonical);
        }

        this.finishSymbolFeatures();
    }
}

register('ColumnarSymbolBucket', ColumnarSymbolBucket, {
    omit: ['layers', 'collisionBoxArray', 'features', 'compareText', 'isColumnar']
});
