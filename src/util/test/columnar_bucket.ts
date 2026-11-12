import {vi, type MockInstance} from 'vitest';
import {FillStyleLayer} from '../../style/style_layer/fill_style_layer.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {CollisionBoxArray} from '../../data/array_types.g.ts';
import {FillBucket} from '../../data/bucket/fill_bucket.ts';
import {ColumnarFillBucket} from '../../data/bucket/columnar/columnar_fill_bucket.ts';
import {LineStyleLayer} from '../../style/style_layer/line_style_layer.ts';
import {LineBucket} from '../../data/bucket/line_bucket.ts';
import {ColumnarLineBucket} from '../../data/bucket/columnar/columnar_line_bucket.ts';
import {SymbolStyleLayer} from '../../style/style_layer/symbol_style_layer.ts';
import {SymbolBucket, type SymbolFeature} from '../../data/bucket/symbol_bucket.ts';
import {ColumnarSymbolBucket} from '../../data/bucket/columnar/columnar_symbol_bucket.ts';
import {MLTVectorTileLayer} from '../../source/vector_tile_mlt.ts';
import {FeatureIndex} from '../../data/feature_index.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';
import {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';

import type {FeatureTable} from '@maplibre/mlt';
import type {FilterSpecification, Formatted} from '@maplibre/maplibre-gl-style-spec';
import type {TypedStyleLayer} from '../../style/style_layer/typed_style_layer.ts';
import type {StructArray} from '../struct_array.ts';
import type {Bucket, BucketParameters, IndexedFeature, PopulateParameters} from '../../data/bucket.ts';
import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {Segment} from '../../data/segment.ts';

/** The zoom level at which the columnar bucket tests evaluate their style layers and place their tile. */
export const ZOOM = 5;

/** The tile the columnar bucket tests populate their buckets for, at the top left corner of the world. */
export const CANONICAL = {z: ZOOM, x: 0, y: 0} as CanonicalTileID;

/**
 * A row-based bucket class and its columnar counterpart, with what a test compares between the two
 * after populating one from a tile's rows and the other from its columns.
 */
export type BucketPair<Layer extends TypedStyleLayer, B extends Bucket, Summary> = {
    createLayer(filter?: FilterSpecification, layout?: Record<string, unknown>): Layer;
    RowBucket: new (parameters: BucketParameters<Layer>) => B;
    ColumnarBucket: new (parameters: BucketParameters<Layer>) => B;
    summarize(bucket: B, options: PopulateParameters): Summary;
};

/** What a test compares of one bucket of a {@link BucketPair}, with the indices of the features it handed to the spatial index. */
export type Populated<Summary> = Summary & {indexed: number[]};

/** The arrays a fill bucket writes, byte for byte, and its segments. */
export type FillArrays = {
    vertices: number[];
    triangles: number[];
    outlines: number[];
    segments: Segment[];
    outlineSegments: Segment[];
};

/** Returns a fill layer on the source layer `land`, evaluated at {@link ZOOM}. */
export function createFillLayer(filter?: FilterSpecification, layout: Record<string, unknown> = {}): FillStyleLayer {
    const layer = new FillStyleLayer({
        id: 'fill', type: 'fill', source: 's', 'source-layer': 'land', filter, layout, paint: {'fill-color': 'red'}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

/** Returns the parameters a worker tile creates a bucket of `layer` with, for a tile of the given encoding. */
export function bucketParameters<Layer extends TypedStyleLayer>(layer: Layer, encoding: 'mlt' | 'mvt' = 'mlt'): BucketParameters<Layer> {
    return {
        encoding, index: 0, layers: [layer], zoom: ZOOM, pixelRatio: 1, overscaling: 1,
        collisionBoxArray: new CollisionBoxArray(), sourceLayerIndex: 0, sourceID: 's'
    };
}

/**
 * Returns populate options without subdivision, and the mock of their feature index's `insert()`,
 * which records what a bucket indexes instead of indexing it.
 */
export function populateOptions(): {options: PopulateParameters; insert: MockInstance<FeatureIndex['insert']>} {
    const featureIndex = new FeatureIndex(new OverscaledTileID(ZOOM, 0, ZOOM, 0, 0));
    const insert = vi.spyOn(featureIndex, 'insert').mockImplementation(() => {});
    const options = {
        featureIndex,
        iconDependencies: {}, patternDependencies: {}, glyphDependencies: {}, dashDependencies: {},
        availableImages: [], subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
    } as unknown as PopulateParameters;
    return {options, insert};
}

/** Returns the row list a worker tile builds from `layer` for a row-based bucket. */
export function rowsOf(layer: MLTVectorTileLayer): IndexedFeature[] {
    return Array.from({length: layer.length}, (_, index) => {
        const feature = layer.feature(index);
        return {feature, id: feature.id, index, sourceLayerIndex: 0};
    });
}

/** Returns the used part of a struct array, byte for byte. */
export function bytes(array: StructArray): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

/** Returns what a fill bucket wrote. */
export function fillArrays(bucket: FillBucket): FillArrays {
    return {
        vertices: bytes(bucket.layoutVertexArray),
        triangles: bytes(bucket.indexArray),
        outlines: bytes(bucket.indexArray2),
        segments: bucket.segments.get().map(s => ({...s})),
        outlineSegments: bucket.segments2.get().map(s => ({...s}))
    };
}

/** `FillBucket` and `ColumnarFillBucket`, compared by the arrays they write. */
export const FILL_BUCKETS: BucketPair<FillStyleLayer, FillBucket, FillArrays> = {
    createLayer: createFillLayer,
    RowBucket: FillBucket,
    ColumnarBucket: ColumnarFillBucket,
    summarize: fillArrays
};

/** The arrays a line bucket writes, byte for byte, and its segments. */
export type LineArrays = {
    vertices: number[];
    triangles: number[];
    segments: Segment[];
};

/** Returns a line layer on the source layer `roads`, evaluated at {@link ZOOM}. */
export function createLineLayer(filter?: FilterSpecification, layout: Record<string, unknown> = {}): LineStyleLayer {
    const layer = new LineStyleLayer({
        id: 'line', type: 'line', source: 's', 'source-layer': 'roads', filter, layout, paint: {'line-color': 'red'}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

/** Returns what a line bucket wrote. */
export function lineArrays(bucket: LineBucket): LineArrays {
    return {
        vertices: bytes(bucket.layoutVertexArray),
        triangles: bytes(bucket.indexArray),
        segments: bucket.segments.get().map(s => ({...s}))
    };
}

/** `LineBucket` and `ColumnarLineBucket`, compared by the arrays they write. */
export const LINE_BUCKETS: BucketPair<LineStyleLayer, LineBucket, LineArrays> = {
    createLayer: createLineLayer,
    RowBucket: LineBucket,
    ColumnarBucket: ColumnarLineBucket,
    summarize: lineArrays
};

/** What a symbol bucket selected and resolved, and what it asked the main thread for. */
export type SymbolSummary = {
    features: Array<Omit<SymbolFeature, 'text' | 'icon'> & {text?: string; icon?: string}>;
    icons: PopulateParameters['iconDependencies'];
    glyphs: PopulateParameters['glyphDependencies'];
};

/** Returns a symbol layer on the source layer `places` that labels with `name` and draws the icon `icon`, evaluated at {@link ZOOM}. */
export function createSymbolLayer(filter?: FilterSpecification, layout: Record<string, unknown> = {}): SymbolStyleLayer {
    const layer = new SymbolStyleLayer({
        id: 'symbol', type: 'symbol', source: 's', 'source-layer': 'places', filter,
        layout: {'text-field': ['get', 'name'], 'text-font': ['Test'], 'icon-image': ['get', 'icon'], ...layout}
    } as any, {});
    layer.recalculate(new EvaluationParameters(ZOOM), []);
    return layer;
}

/** Returns what a symbol bucket selected and resolved, and what it asked for in `options`. */
export function symbolSummary(bucket: SymbolBucket, options: PopulateParameters): SymbolSummary {
    return {
        features: bucket.features.map(f => ({...f, text: (f.text as Formatted | undefined)?.toString(), icon: f.icon?.name})),
        icons: options.iconDependencies,
        glyphs: options.glyphDependencies
    };
}

/** `SymbolBucket` and `ColumnarSymbolBucket`, compared by what they select and request. */
export const SYMBOL_BUCKETS: BucketPair<SymbolStyleLayer, SymbolBucket, SymbolSummary> = {
    createLayer: createSymbolLayer,
    RowBucket: SymbolBucket,
    ColumnarBucket: ColumnarSymbolBucket,
    summarize: symbolSummary
};

/**
 * Populates a row-based bucket from the rows of `table` and a columnar one from its columns, both of
 * a layer with the given filter and layout, and returns what each wrote along with the indices of the
 * features each handed to the spatial index.
 */
export function populateBoth<Layer extends TypedStyleLayer, B extends Bucket, Summary>(
    pair: BucketPair<Layer, B, Summary>,
    table: FeatureTable,
    filter?: FilterSpecification,
    layout: Record<string, unknown> = {}
): {row: Populated<Summary>; columnar: Populated<Summary>} {
    const sourceLayer = new MLTVectorTileLayer(table);

    const row = new pair.RowBucket(bucketParameters(pair.createLayer(filter, layout)));
    const rowOptions = populateOptions();
    row.populate(rowsOf(sourceLayer), rowOptions.options, CANONICAL);

    const columnar = new pair.ColumnarBucket(bucketParameters(pair.createLayer(filter, layout)));
    const columnarOptions = populateOptions();
    columnar.populate(sourceLayer, columnarOptions.options, CANONICAL);

    return {
        row: {...pair.summarize(row, rowOptions.options), indexed: rowOptions.insert.mock.calls.map(call => call[2])},
        columnar: {...pair.summarize(columnar, columnarOptions.options), indexed: columnarOptions.insert.mock.calls.map(call => call[2])}
    };
}
