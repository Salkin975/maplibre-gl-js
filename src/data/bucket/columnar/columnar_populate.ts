import {filterFeatureTable, isColumnarBucketSupported} from '@maplibre/mlt';
import {loadGeometry} from '../../load_geometry.ts';
import {warnOnce} from '../../../util/util.ts';

import type Point from '@mapbox/point-geometry';
import type {FilterSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {FeatureTable, SelectionVector} from '@maplibre/mlt';
import type {BucketFeature, BucketParameters, IndexedFeature} from '../../bucket.ts';
import type {TypedStyleLayer} from '../../../style/style_layer/typed_style_layer.ts';
import type {FeatureIndex} from '../../feature_index.ts';
import type {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';

/** Resolves one feature's rendered geometry. The default, `loadGeometryOrEmpty`, is a full ring decode. */
type GeometryResolver = (feature: VectorTileFeatureLike, index: number) => Point[][];

/**
 * Whether a bucket created with `parameters` populates from the columns of an MLT layer, see
 * `Bucket.isColumnar`: the layer is `'mlt'` and the filter of the bucket's first style layer can
 * be planned over the columns at the bucket's zoom.
 */
export function isColumnarBucket({encoding, layers, zoom}: BucketParameters<TypedStyleLayer>): boolean {
    return isColumnarBucketSupported(encoding, layers[0].filter, zoom, layers[0].id);
}

/** Distinguishes `populate()`'s row-based `IndexedFeature[]` input from its columnar `MLTVectorTileLayer` input. */
export function isRowFeatureList(features: IndexedFeature[] | MLTVectorTileLayer): features is IndexedFeature[] {
    return Array.isArray(features);
}

/**
 * Applies the layer filter to `featureTable`'s columns and returns the selected feature indices.
 *
 * Throws if the filter cannot be planned over the columns. A bucket is columnar only when its
 * constructor found the filter plannable with {@link isColumnarBucket}, so a throw here means
 * the two disagree.
 */
export function selectColumnarFeatures(featureTable: FeatureTable, filter: FilterSpecification | undefined, zoom: number): SelectionVector {
    const selection = filterFeatureTable(featureTable, filter, zoom);
    if (!selection) {
        throw new Error('Columnar bucket filter could not be planned. isColumnarBucket() should have caught this earlier.');
    }
    return selection;
}

/** Degrades to an empty geometry and warns instead of aborting the whole tile over one bad feature. */
export function loadGeometryOrEmpty(feature: VectorTileFeatureLike): Point[][] {
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
