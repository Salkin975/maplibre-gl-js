import {filterFeatureTable, unionSelectionVectors, intersectSelectionVectors, GpuVector, SINGLE_PART_GEOMETRY_TYPE} from '@maplibre/mlt';
import {loadGeometry} from '../../load_geometry.ts';
import {warnOnce} from '../../../util/util.ts';

import type Point from '@mapbox/point-geometry';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {FeatureTable, SelectionVector} from '@maplibre/mlt';
import type {BucketFeature, IndexedFeature} from '../../bucket.ts';
import type {FeatureIndex} from '../../feature_index.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/** Resolves one feature's rendered geometry. The default, `loadGeometryOrEmpty`, is a full ring decode. */
type GeometryResolver = (feature: VectorTileFeatureLike, index: number) => Point[][];

/** Distinguishes `populate()`'s row-based `IndexedFeature[]` input from its columnar `MLTVectorTileLayer` input. */
export function isRowFeatureList(features: IndexedFeature[] | MLTVectorTileLayer): features is IndexedFeature[] {
    return Array.isArray(features);
}

/**
 * Applies the layer filter to `featureTable`'s columns and returns the selected feature indices.
 *
 * When `renderableGeometryTypes` is given, the result is narrowed to features of those geometry types -
 * the union of their per-type selections, intersected with the filter selection. A pre-tessellated layer
 * holds polygons only, so for polygons its filter selection is already the answer and no geometry
 * selection is made.
 *
 * Throws if the filter cannot be planned over the columns. A bucket is columnar only when its
 * constructor found the filter plannable with `isColumnarBucketSupported()`, so a throw here means
 * the two disagree.
 */
export function selectColumnarFeatures(
    featureTable: FeatureTable,
    filter: FilterSpecification | undefined,
    zoom: number,
    renderableGeometryTypes?: SINGLE_PART_GEOMETRY_TYPE[],
): SelectionVector {
    const filterSelection = filterFeatureTable(featureTable, filter, zoom);
    if (!filterSelection) {
        throw new Error('Columnar bucket filter could not be planned. isColumnarBucketSupported() should have caught this earlier.');
    }
    if (!renderableGeometryTypes) return filterSelection;

    const geometryVector = featureTable.geometryVector;
    if (!geometryVector) {
        throw new Error('Columnar bucket needs geometry, but the feature table has no geometry column.');
    }
    const isPolygonOnly = geometryVector instanceof GpuVector && renderableGeometryTypes.includes(SINGLE_PART_GEOMETRY_TYPE.POLYGON);
    if (isPolygonOnly) return filterSelection;

    return intersectSelectionVectors(filterSelection, selectGeometryTypes(geometryVector, renderableGeometryTypes, featureTable.numFeatures));
}

/**
 * The features of each set of geometry types, per geometry vector, keyed by the types joined with
 * commas. Every line layer of a source layer asks for the same set, and finding it is a scan over all
 * features of the table. A table that has released its columns decodes them into a new geometry
 * vector, whose selections are then found anew.
 */
const geometryTypeSelections = new WeakMap<FeatureTable['geometryVector'], Map<string, SelectionVector>>();

/** Returns the features of `geometryVector` whose geometry is one of `types`, scanning for each set of types only once. */
function selectGeometryTypes(geometryVector: FeatureTable['geometryVector'], types: SINGLE_PART_GEOMETRY_TYPE[], numFeatures: number): SelectionVector {
    let selections = geometryTypeSelections.get(geometryVector);
    if (!selections) {
        selections = new Map();
        geometryTypeSelections.set(geometryVector, selections);
    }

    const key = types.join(',');
    let selection = selections.get(key);
    if (!selection) {
        selection = unionSelectionVectors(types.map(type => geometryVector.filter(type)), numFeatures);
        selections.set(key, selection);
    }
    return selection;
}

/** Degrades to an empty geometry and warns instead of aborting the whole tile over one bad feature. */
export function loadGeometryOrEmpty(feature: VectorTileFeatureLike, _index: number): Point[][] {
    try {
        return loadGeometry(feature);
    } catch (error) {
        warnOnce(`MLT feature ${feature.id ?? '(no id)'} could not be decoded into a geometry and was rendered empty: ${(error as Error).message}`);
        return [];
    }
}

/**
 * Materializes every feature `selection` selects out of `sourceLayer` into a `BucketFeature`, with its
 * `sortKey` evaluated when one is given. A feature's id is the one `featureIndex` resolves, which honours
 * the source's `promoteId`, so that feature state finds the feature.
 *
 * `resolveGeometry` defaults to a full ring decode; pass a cheaper resolver (e.g. a bounding box) when
 * the bucket's write step never reads the geometry back.
 *
 * When `features` is given, the source feature of every materialized row is stored in it under the row's
 * index, so that the bucket can hand the same object to the spatial index instead of reading it again.
 */
export function materializeSelectedFeatures(
    sourceLayer: MLTVectorTileLayer,
    selection: SelectionVector,
    sourceLayerIndex: number,
    featureIndex: FeatureIndex,
    options: {
        resolveGeometry?: GeometryResolver;
        /** Gives each feature a `dashes` object, which the line bucket's dash handling assumes is present. */
        hasDashes?: boolean;
        sortKey?: (bucketFeature: BucketFeature) => number | undefined;
        features?: VectorTileFeatureLike[];
    } = {},
): BucketFeature[] {
    const resolveGeometry = options.resolveGeometry ?? loadGeometryOrEmpty;
    const bucketFeatures: BucketFeature[] = [];

    for (let i = 0; i < selection.limit; i++) {
        const index = selection.getIndex(i);
        const feature = sourceLayer.feature(index);
        if (options.features) options.features[index] = feature;
        const bucketFeature: BucketFeature = {
            id: featureIndex.getId(feature, sourceLayer.name),
            properties: feature.properties,
            type: feature.type,
            index,
            sourceLayerIndex,
            geometry: resolveGeometry(feature, index),
            patterns: {},
            dashes: options.hasDashes ? {} : undefined,
        };
        if (options.sortKey) bucketFeature.sortKey = options.sortKey(bucketFeature);
        bucketFeatures.push(bucketFeature);
    }

    return bucketFeatures;
}
