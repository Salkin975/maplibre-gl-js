import {toEvaluationFeature} from '../../evaluation_feature.ts';
import {selectColumnarFeatures} from './columnar_populate.ts';

import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {PopulateParameters} from '../../bucket.ts';
import type {SymbolBucket} from '../symbol_bucket.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/**
 * Populates a symbol bucket from an MLT layer by selecting its features on the feature table's
 * columns.
 *
 * Only the selection is columnar: every selected feature goes through the bucket's
 * `addSymbolFeature()` and `finishSymbolFeatures()`, so text and icon are resolved, glyphs and images
 * requested, lines merged and features sorted by the same code as for row features. Symbols are not
 * entered into the `FeatureIndex`; `queryRenderedFeatures` reaches them by re-reading the raw tile.
 */
export function populateColumnarSymbol(bucket: SymbolBucket, sourceLayer: MLTVectorTileLayer, options: PopulateParameters, canonical: CanonicalTileID): void {
    const layer = bucket.layers[0];
    const hasText = bucket.layoutHasText();
    const hasIcon = bucket.layoutHasIcon();

    bucket.features = [];
    if (!hasText && !hasIcon) return;

    const needGeometry = layer._featureFilter.needGeometry;
    const selection = selectColumnarFeatures(sourceLayer.featureTable, layer.filter, bucket.zoom);
    for (let i = 0; i < selection.limit; i++) {
        const index = selection.getIndex(i);
        const feature = sourceLayer.feature(index);
        const evaluationFeature = toEvaluationFeature(feature, needGeometry);
        const id = options.featureIndex.getId(feature, sourceLayer.name);
        bucket.addSymbolFeature({feature, id, index, sourceLayerIndex: bucket.sourceLayerIndex}, evaluationFeature, hasText, hasIcon, options, canonical);
    }

    bucket.finishSymbolFeatures();
}
