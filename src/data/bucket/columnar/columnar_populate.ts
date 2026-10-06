import {filterFeatureTable, unionSelectionVectors, intersectSelectionVectors} from '@maplibre/mlt';
import {loadGeometry} from '../../load_geometry.ts';
import {warnOnce} from '../../../util/util.ts';

import type Point from '@mapbox/point-geometry';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {FeatureTable, SelectionVector, SINGLE_PART_GEOMETRY_TYPE} from '@maplibre/mlt';
import type {BucketFeature, IndexedFeature} from '../../bucket.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/** Resolves one feature's rendered geometry. The default, `loadGeometryOrEmpty`, is a full ring decode. */
export type GeometryResolver = (feature: VectorTileFeatureLike, index: number) => Point[][];

/** Distinguishes `populate()`'s row-based `IndexedFeature[]` input from its columnar `FeatureTable` input. */
export function isRowFeatureList(features: IndexedFeature[] | FeatureTable): features is IndexedFeature[] {
    return Array.isArray(features);
}

/**
 * Applies the layer filter to `featureTable`'s columns and returns the selected feature indices.
 *
 * When `renderableGeometryTypes` is given, the result is narrowed to features of those geometry types -
 * the union of their per-type selections, intersected with the filter selection.
 *
 * Throws if the filter cannot be planned over the columns: `createBucket()` only chose a columnar
 * bucket because `isColumnarBucketSupported()` had already answered the same question with "yes", so a
 * failure here means the two decisions diverged, an error that is meant to be visible.
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
    const geometrySelection = unionSelectionVectors(
        renderableGeometryTypes.map(type => geometryVector.filter(type)),
        featureTable.numFeatures,
    );
    return intersectSelectionVectors(filterSelection, geometrySelection);
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
 * `sortKey` evaluated when one is given.
 *
 * `resolveGeometry` defaults to a full ring decode; pass a cheaper resolver (e.g. a bounding box) when
 * the bucket's write step never reads the geometry back.
 */
export function materializeSelectedFeatures(
    sourceLayer: MLTVectorTileLayer,
    selection: SelectionVector,
    sourceLayerIndex: number,
    options: {
        resolveGeometry?: GeometryResolver;
        /** Gives each feature a `dashes` object, which the line bucket's dash handling assumes is present. */
        hasDashes?: boolean;
        sortKey?: (bucketFeature: BucketFeature) => number | undefined;
    } = {},
): BucketFeature[] {
    const resolveGeometry = options.resolveGeometry ?? loadGeometryOrEmpty;
    const bucketFeatures: BucketFeature[] = [];

    for (let i = 0; i < selection.limit; i++) {
        const index = selection.getIndex(i);
        const feature = sourceLayer.feature(index);
        const bucketFeature: BucketFeature = {
            id: feature.id,
            properties: feature.properties,
            type: feature.type,
            index,
            sourceLayerIndex,
            geometry: resolveGeometry(feature, index),
            patterns: {},
            ...(options.hasDashes ? {dashes: {}} : {}),
        };
        if (options.sortKey) bucketFeature.sortKey = options.sortKey(bucketFeature);
        bucketFeatures.push(bucketFeature);
    }

    return bucketFeatures;
}

/** Fields every columnar bucket carries but never has to send to the main thread - read only worker-side during `populate()`. */
const COLUMNAR_ONLY_FIELDS = ['isColumnar', 'sourceLayerIndex'] as const;

/**
 * Extends a bucket's own `register()` omit list with the fields every columnar bucket must not
 * transfer. `register()` expects a flat list per class, since a subclass does not inherit its base
 * class's omissions, so `baseOmit` (e.g. `FillBucket`'s `['layers', 'patternFeatures']`) has to be
 * passed in explicitly.
 */
export function columnarTransferOmitList<T extends {isColumnar: boolean; sourceLayerIndex: number}>(
    baseOmit: ReadonlyArray<keyof T>,
): Array<keyof T> {
    return [...baseOmit, ...COLUMNAR_ONLY_FIELDS];
}
