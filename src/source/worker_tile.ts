import {FeatureIndex} from '../data/feature_index.ts';
import {CollisionBoxArray} from '../data/array_types.g.ts';
import {DictionaryCoder} from '../util/dictionary_coder.ts';
import {warnOnce, mapObject} from '../util/util.ts';
import {ImageAtlas} from '../render/image_atlas.ts';
import {GlyphAtlas} from '../render/glyph_atlas.ts';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {type GetDashesResponse, MessageType, type GetImagesResponse} from '../util/actor_messages.ts';
import {hasRingTopology, isMLTVectorTileLayer, isPreTessellated, MLTVectorTile, type MLTVectorTileLayer} from './vector_tile_mlt.ts';
import {LOG_WORKER_TIMING, TileTimings, takePhases} from './worker_timing.ts';

import type {Bucket, IndexedFeature, PopulateParameters} from '../data/bucket.ts';
import type {IActor} from '../util/actor.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {StyleLayerIndex} from '../style/style_layer_index.ts';
import type {GlyphMap} from '../style/style_glyph.ts';
import type {
    WorkerTileParameters,
    WorkerTileResult,
} from './worker_source.ts';
import type {PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileLike} from '@maplibre/vt-pbf';
import type {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
export class WorkerTile {
    tileID: OverscaledTileID;
    uid: string | number;
    zoom: number;
    pixelRatio: number;
    tileSize: number;
    source: string;
    promoteId: PromoteIdSpecification;
    overscaling: number;
    showCollisionBoxes: boolean;
    collectResourceTiming: boolean;
    returnDependencies: boolean;

    data: VectorTileLike;
    collisionBoxArray: CollisionBoxArray;

    abort: AbortController;
    vectorTile: VectorTileLike;
    /**
     * The etag of the response this tile was loaded from. A reload has no new response, so it is returned again
     * to keep the main thread's tile etag intact for the next expiry refresh.
     */
    etag?: string;
    inFlightDependencies: AbortController[];

    constructor(params: WorkerTileParameters) {
        this.tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.showCollisionBoxes = params.showCollisionBoxes;
        this.collectResourceTiming = !!params.collectResourceTiming;
        this.returnDependencies = !!params.returnDependencies;
        this.promoteId = params.promoteId;
        this.inFlightDependencies = [];
    }

    /**
     * Builds the buckets and the feature index of the tile `data` holds, and fetches the glyphs, images
     * and dashes the buckets depend on.
     *
     * A columnar bucket is given the MLT layer whose columns it reads, and every other bucket a row
     * list, also for an MLT layer, see {@link Bucket.isColumnar}. A layer that only a columnar bucket can
     * draw gets no other bucket, see {@link holdsTrianglesOnly}. Once the buckets are complete, an MLT
     * tile's decoded columns are released: the tile stays in the worker for `reloadTile()`, which
     * decodes again what it reads.
     */
    async parse(data: VectorTileLike, layerIndex: StyleLayerIndex, availableImages: string[], actor: IActor, subdivisionGranularity: SubdivisionGranularitySetting): Promise<WorkerTileResult> {
        this.data = data;
        const timings = new TileTimings();

        this.collisionBoxArray = new CollisionBoxArray();
        const sourceLayerCoder = new DictionaryCoder(Object.keys(data.layers).sort());

        const featureIndex = new FeatureIndex(this.tileID, this.promoteId);
        featureIndex.bucketLayerIDs = [];

        const buckets: {[_: string]: Bucket} = {};

        const options: PopulateParameters = {
            featureIndex,
            iconDependencies: {},
            patternDependencies: {},
            glyphDependencies: {},
            dashDependencies: {},
            availableImages,
            subdivisionGranularity
        };

        const layerFamilies = layerIndex.familiesBySource[this.source];
        for (const sourceLayerId in layerFamilies) {
            const accessStart = timings.now();
            const sourceLayer = data.layers[sourceLayerId];
            timings.addSourceLayerAccess(accessStart);
            if (!sourceLayer) {
                continue;
            }

            if (sourceLayer.version === 1) {
                warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" ` +
                    'does not use vector tile spec v2 and therefore may have some rendering errors.');
            }

            const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
            const mltLayer = isMLTVectorTileLayer(sourceLayer) ? sourceLayer : undefined;
            const rowBuildStart = timings.now();
            const features = [];
            if (!mltLayer) {
                for (let index = 0; index < sourceLayer.length; index++) {
                    const feature = sourceLayer.feature(index);
                    const id = featureIndex.getId(feature, sourceLayerId);
                    features.push({feature, id, index, sourceLayerIndex});
                }
            }
            timings.addRowBuild(rowBuildStart);
            let mltRows: IndexedFeature[] | undefined;
            const trianglesOnly = holdsTrianglesOnly(mltLayer);

            for (const family of layerFamilies[sourceLayerId]) {
                const layer = family[0];

                if (layer.source !== this.source) {
                    warnOnce(`layer.source = ${layer.source} does not equal this.source = ${this.source}`);
                }
                if (layer.isHidden(this.zoom, true)) continue;
                recalculateLayers(family, this.zoom, availableImages);

                const createStart = timings.now();
                const bucket = layer.createBucket({
                    encoding: mltLayer ? 'mlt' : 'mvt',
                    index: featureIndex.bucketLayerIDs.length,
                    layers: family,
                    zoom: this.zoom,
                    pixelRatio: this.pixelRatio,
                    overscaling: this.overscaling,
                    collisionBoxArray: this.collisionBoxArray,
                    sourceLayerIndex,
                    sourceID: this.source
                });
                if (trianglesOnly && !bucket.isColumnar) {
                    warnOnce(`Layer "${layer.id}" reads a pre-tessellated source layer that stores only triangles and cannot be drawn from its columns, so the layer is skipped.`);
                    continue;
                }
                buckets[layer.id] = bucket;
                const timing = timings.layer(layer.id, layer.type, sourceLayerId, sourceLayer.length, !!bucket.isColumnar);
                timing.createBucket = timings.now() - createStart;

                let populateFeatures: IndexedFeature[] | MLTVectorTileLayer = features;
                if (mltLayer) {
                    populateFeatures = bucket.isColumnar ?
                        mltLayer :
                        (mltRows ??= mltLayer.indexedFeatures((feature) => featureIndex.getId(feature, sourceLayerId), sourceLayerIndex));
                }
                const populateStart = timings.now();
                bucket.populate(populateFeatures, options, this.tileID.canonical);
                timing.populate = timings.now() - populateStart;
                timing.phases = takePhases();
                featureIndex.bucketLayerIDs.push(family.map((l) => l.id));
            }
        }

        const stacks = mapObject(options.glyphDependencies, variants => mapObject(variants, glyphs => Object.keys(glyphs)));

        for (const request of this.inFlightDependencies) {
            request?.abort();
        }
        this.inFlightDependencies = [];

        let getGlyphsPromise = Promise.resolve<GlyphMap>({});
        if (Object.keys(stacks).length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getGlyphsPromise = actor.sendAsync({type: MessageType.getGlyphs, data: {stacks, source: this.source, tileID: this.tileID, type: 'glyphs'}}, abortController);
        }

        const icons = Object.keys(options.iconDependencies);
        let getIconsPromise = Promise.resolve<GetImagesResponse>({});
        if (icons.length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getIconsPromise = actor.sendAsync({type: MessageType.getImages, data: {icons, source: this.source, tileID: this.tileID, type: 'icons'}}, abortController);
        }

        const patterns = Object.keys(options.patternDependencies);
        let getPatternsPromise = Promise.resolve<GetImagesResponse>({});
        if (patterns.length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getPatternsPromise = actor.sendAsync({type: MessageType.getImages, data: {icons: patterns, source: this.source, tileID: this.tileID, type: 'patterns'}}, abortController);
        }

        const dashes = options.dashDependencies;
        let getDashesPromise = Promise.resolve<GetDashesResponse>({} as GetDashesResponse);
        if (Object.keys(dashes).length) {
            const abortController = new AbortController();
            this.inFlightDependencies.push(abortController);
            getDashesPromise = actor.sendAsync({type: MessageType.getDashes, data: {dashes}}, abortController);
        }

        const dependenciesStart = timings.now();
        const [glyphMap, iconMap, patternMap, dashPositions] = await Promise.all([getGlyphsPromise, getIconsPromise, getPatternsPromise, getDashesPromise]);

        timings.addDependencies(dependenciesStart);

        const glyphAtlas = new GlyphAtlas(glyphMap);
        const imageAtlas = new ImageAtlas(iconMap, patternMap);

        for (const key in buckets) {
            const bucket = buckets[key];
            if (!bucket.hasDependencies) continue;

            recalculateLayers(bucket.layers, this.zoom, availableImages);
            const addFeaturesStart = timings.now();
            bucket.addFeatures({
                options,
                canonical: this.tileID.canonical,
                glyphMap,
                glyphPositions: glyphAtlas.positions,
                iconMap,
                iconPositions: imageAtlas.iconPositions,
                patternMap,
                patternPositions: imageAtlas.patternPositions,
                dashPositions,
                showCollisionBoxes: this.showCollisionBoxes
            });
            timings.addFeatures(key, addFeaturesStart);
        }

        if (LOG_WORKER_TIMING) timings.log(this.tileID.canonical.toString(), data instanceof MLTVectorTile ? 'mlt' : 'mvt');

        if (data instanceof MLTVectorTile) data.releaseDecodedColumns();

        return {
            buckets: Object.values(buckets).filter(b => !b.isEmpty()),
            featureIndex,
            collisionBoxArray: this.collisionBoxArray,
            glyphAtlasImage: glyphAtlas.image,
            imageAtlas,
            dashPositions,
            // Only used for benchmarking:
            glyphMap: this.returnDependencies ? glyphMap : null,
            iconMap: this.returnDependencies ? iconMap : null,
            glyphPositions: this.returnDependencies ? glyphAtlas.positions : null
        };
    }
}

/**
 * Tells whether `mltLayer` is pre-tessellated and stores its triangles without rings, so that only a
 * columnar bucket can draw it.
 *
 * The row view of such a layer has no rings to give, only the tile's triangles, each as a ring of its
 * own: a line layer drawn from the rows outlines every triangle, and a fill layer every triangle's
 * edges. `parse()` therefore skips, with one warning per layer, every style layer over it whose bucket
 * is not columnar: a fill, line or symbol layer whose filter cannot be planned over the columns, and
 * every circle, heatmap and fill-extrusion layer. A line layer over it is skipped on the columnar path
 * as well, since the triangles hold no line to draw, see `populateColumnarLine()`.
 */
function holdsTrianglesOnly(mltLayer: MLTVectorTileLayer | undefined): boolean {
    const geometryVector = mltLayer?.featureTable.geometryVector ?? null;
    return isPreTessellated(geometryVector) && !hasRingTopology(geometryVector);
}

function recalculateLayers(layers: readonly StyleLayer[], zoom: number, availableImages: string[]) {
    // Layers are shared and may have been used by a WorkerTile with a different zoom.
    const parameters = new EvaluationParameters(zoom);
    for (const layer of layers) {
        layer.recalculate(parameters, availableImages);
    }
}
