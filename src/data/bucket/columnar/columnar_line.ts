import {intersectSelectionVectors, SINGLE_PART_GEOMETRY_TYPE, unionSelectionVectors} from '@maplibre/mlt';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';
import {warnOnce} from '../../../util/util.ts';
import {hasRingTopology, isPreTessellated} from '../../../source/vector_tile_mlt.ts';
import {selectColumnarFeatures, materializeSelectedFeatures} from './columnar_populate.ts';
import {addPhase} from '../../../source/worker_timing.ts';

import type {FeatureTable, SelectionVector} from '@maplibre/mlt';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';
import type {PopulateParameters} from '../../bucket.ts';
import type {LineBucket} from '../line_bucket.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/**
 * The LineString and Polygon features of each geometry vector, the features a line layer can draw.
 * Every line layer of a source layer draws from the same ones, and finding them is a scan over all
 * features of the table. A table that has released its columns decodes them into a new geometry
 * vector, whose features are then found anew.
 */
const lineGeometrySelections = new WeakMap<FeatureTable['geometryVector'], SelectionVector>();

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
    if (isPreTessellated(geometryVector) && !hasRingTopology(geometryVector)) {
        warnOnce(`Line layer "${layer.id}" reads a pre-tessellated source layer that stores only triangles, which holds no line for it to draw, so the layer is skipped.`);
        return;
    }

    bucket.hasLineClipColumns = !!featureTable.getPropertyVector(GEOJSONVT_CLIP_START) && !!featureTable.getPropertyVector(GEOJSONVT_CLIP_END);
    const lineSortKey = layer.layout.get('line-sort-key');
    const selectStart = performance.now();
    const selection = selectLineFeatures(featureTable, layer.filter, bucket.zoom);
    const sourceFeatures: VectorTileFeatureLike[] = [];
    const bucketFeatures = materializeSelectedFeatures(sourceLayer, selection, bucket.sourceLayerIndex, options.featureIndex, {
        features: sourceFeatures,
        hasDashes: true,
        sortKey: lineSortKey.isConstant() ? undefined : (bucketFeature) => lineSortKey.evaluate(bucketFeature, {}, canonical),
    });
    addPhase('selectMaterialize', selectStart);

    bucket.addBucketFeatures(bucketFeatures, index => sourceFeatures[index], options, canonical);
}

/**
 * Returns the features of `featureTable` that `filter` selects and that are a LineString or a Polygon.
 * A pre-tessellated table holds polygons only, so its filter selection is already the answer.
 */
function selectLineFeatures(featureTable: FeatureTable, filter: FilterSpecification | undefined, zoom: number): SelectionVector {
    const filterSelection = selectColumnarFeatures(featureTable, filter, zoom);
    const geometryVector = featureTable.geometryVector;
    if (!geometryVector) {
        throw new Error('Columnar bucket needs geometry, but the feature table has no geometry column.');
    }
    if (isPreTessellated(geometryVector)) return filterSelection;

    let lineGeometries = lineGeometrySelections.get(geometryVector);
    if (!lineGeometries) {
        lineGeometries = unionSelectionVectors([
            geometryVector.filter(SINGLE_PART_GEOMETRY_TYPE.LINESTRING),
            geometryVector.filter(SINGLE_PART_GEOMETRY_TYPE.POLYGON),
        ], featureTable.numFeatures);
        lineGeometrySelections.set(geometryVector, lineGeometries);
    }
    return intersectSelectionVectors(filterSelection, lineGeometries);
}
