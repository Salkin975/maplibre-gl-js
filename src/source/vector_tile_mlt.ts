import Point from '@mapbox/point-geometry';
import {type FeatureTable, type LayerBlock, createRowView, decodeTile, GEOMETRY_TYPE, GeometryVector, GpuVector, scanLayerBlocks} from '@maplibre/mlt';

import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';
import type {IndexedFeature} from '../data/bucket.ts';

/** The geometry, part and ring offsets that tell which vertices belong to which feature. */
type TopologyVector = GeometryVector['topologyVector'];

/** Options for {@link MLTVectorTile}. */
export type MLTVectorTileOptions = {
    /**
     * Gives every feature a plain copy of its properties instead of a view that reads the columns on
     * access. A copy can be written to, cloned and posted, and does not hold the tile's columns, which
     * is what a feature handed to a caller of the public API needs.
     */
    copyProperties?: boolean;
};

/**
 * Installs the block's layer on `layers` as an enumerable getter that decodes the block on first
 * access and then replaces itself with a plain data property holding the layer.
 *
 * Keys and spread behave as on a fully decoded object, while a layer nobody reads is never decoded.
 */
function defineLazyLayer(layers: Record<string, VectorTileLayerLike>, layerBlock: LayerBlock, options: MLTVectorTileOptions) {
    Object.defineProperty(layers, layerBlock.name, {
        configurable: true,
        enumerable: true,
        get() {
            const layer = new MLTVectorTileLayer(decodeTile(layerBlock.bytes)[0], options);
            Object.defineProperty(layers, layerBlock.name, {value: layer, configurable: true, enumerable: true, writable: true});
            return layer;
        }
    });
}

/**
 * Reads a feature id the way `@mapbox/vector-tile` reports it: a 64-bit id becomes a JS number,
 * rounded when it is outside the safe-integer range, and a missing id is `undefined`.
 */
function toMvtId(id: number | bigint | null | undefined): number | undefined {
    if (typeof id === 'bigint') return Number(id);
    return id ?? undefined;
}

/**
 * A feature of an {@link MLTVectorTileLayer}, backed by the layer's columns and read from them
 * only when asked.
 */
class MLTVectorTileFeature implements VectorTileFeatureLike {
    layer: MLTVectorTileLayer;
    index: number;
    /**
     * Reads through to the layer's property columns, see `createRowView` in `@maplibre/mlt`, unless the
     * layer copies them, see {@link MLTVectorTileOptions.copyProperties}.
     */
    properties: VectorTileFeatureLike['properties'];
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];

    constructor(layer: MLTVectorTileLayer, index: number) {
        const {featureTable} = layer;
        this.layer = layer;
        this.index = index;
        this.extent = layer.extent;
        const rowView = createRowView(featureTable, index) as VectorTileFeatureLike['properties'];
        this.properties = layer.copyProperties ? {...rowView} : rowView;
        this.type = toVectorTileGeometryType(featureTable.geometryVector?.geometryType(index));
        this.id = toMvtId(featureTable.idVector?.getValue(index));
    }

    /**
     * Returns new points, which bucket code is free to modify. A pre-tessellated layer without ring
     * topology has no rings to decode, so its triangles stand in.
     */
    loadGeometry(): Point[][] {
        const geometryVector = this.layer.featureTable.geometryVector;
        if (!geometryVector) return [];
        if (geometryVector instanceof GpuVector && !hasRingTopology(geometryVector)) {
            return trianglesAsRings(geometryVector, this.index);
        }
        if (geometryVector instanceof GeometryVector && geometryVector.vertexOffsets && geometryVector.mortonSettings) {
            const rings = geometryVector.getGeometry(this.index);
            return rings.map(ring => ring.map(point => new Point(point.x, point.y)));
        }
        return readGeometry(geometryVector, this.index);
    }
}

/**
 * Returns the vertices `[start, end)` of `vertexBuffer`, a flat list of x and y, as new points, read
 * through `vertexOffsets` when the layer stores its vertices in a dictionary. A ring is closed by
 * repeating its first point.
 */
function readVertices(vertexBuffer: Int32Array | Uint32Array, vertexOffsets: Uint32Array | undefined, start: number, end: number, closeRing: boolean): Point[] {
    const count = end - start;
    const closed = closeRing && count > 0;
    const points = new Array<Point>(closed ? count + 1 : count);
    for (let i = 0; i < count; i++) {
        const offset = vertexOffsets ? vertexOffsets[start + i] * 2 : (start + i) * 2;
        points[i] = new Point(vertexBuffer[offset], vertexBuffer[offset + 1]);
    }
    if (closed) points[count] = new Point(points[0].x, points[0].y);
    return points;
}

/**
 * Returns where the vertices of the parts `[start, end)` begin and end: through the ring offsets when
 * the layer has rings, else through the part offsets, else the parts are single vertices.
 */
function vertexRange(topology: TopologyVector, start: number, end: number): [number, number] {
    const {partOffsets, ringOffsets} = topology;
    if (ringOffsets) return [ringOffsets[partOffsets?.[start] ?? start], ringOffsets[partOffsets?.[end] ?? end]];
    if (partOffsets) return [partOffsets[start], partOffsets[end]];
    return [start, end];
}

/** Returns every ring of the polygons `[start, end)`, each closed. */
function readPolygonRings(vertexBuffer: Int32Array | Uint32Array, vertexOffsets: Uint32Array | undefined, topology: TopologyVector, start: number, end: number): Point[][] {
    const {partOffsets, ringOffsets} = topology;
    if (!partOffsets || !ringOffsets) throw new Error('Missing topology offsets for Polygon');

    const rings: Point[][] = [];
    for (let ring = partOffsets[start]; ring < partOffsets[end]; ring++) {
        rings.push(readVertices(vertexBuffer, vertexOffsets, ringOffsets[ring], ringOffsets[ring + 1], true));
    }
    return rings;
}

/**
 * Reads the points, lines or rings of feature `index` from the vertex buffer of `geometryVector` straight
 * into new points, with the coordinates `getGeometry()` returns. `getGeometry()` itself returns points of
 * the MLT package's own `Point` class. The vertices must be stored as x and y pairs, not Morton codes.
 */
function readGeometry(geometryVector: GeometryVector | GpuVector, index: number): Point[][] {
    const vertexBuffer = geometryVector.vertexBuffer;
    const vertexOffsets = geometryVector instanceof GeometryVector ? geometryVector.vertexOffsets : undefined;
    const topology: TopologyVector = geometryVector.topologyVector ?? {};
    const rootStart = topology.geometryOffsets?.[index] ?? index;
    const rootEnd = topology.geometryOffsets?.[index + 1] ?? index + 1;

    switch (geometryVector.geometryType(index)) {
        case GEOMETRY_TYPE.POINT: {
            const [start] = vertexRange(topology, rootStart, rootEnd);
            return [readVertices(vertexBuffer, vertexOffsets, start, start + 1, false)];
        }
        case GEOMETRY_TYPE.MULTIPOINT: {
            const [start, end] = vertexRange(topology, rootStart, rootEnd);
            return readVertices(vertexBuffer, vertexOffsets, start, end, false).map(point => [point]);
        }
        case GEOMETRY_TYPE.LINESTRING: {
            const [start, end] = vertexRange(topology, rootStart, rootEnd);
            return [readVertices(vertexBuffer, vertexOffsets, start, end, false)];
        }
        case GEOMETRY_TYPE.MULTILINESTRING: {
            const lines: Point[][] = [];
            for (let line = rootStart; line < rootEnd; line++) {
                const [start, end] = vertexRange(topology, line, line + 1);
                lines.push(readVertices(vertexBuffer, vertexOffsets, start, end, false));
            }
            return lines;
        }
        case GEOMETRY_TYPE.POLYGON:
        case GEOMETRY_TYPE.MULTIPOLYGON:
            return readPolygonRings(vertexBuffer, vertexOffsets, topology, rootStart, rootEnd);
        default:
            throw new Error(`The geometry type ${geometryVector.geometryType(index)} is not supported.`);
    }
}

/**
 * Tells whether a tessellated layer stores its polygons' rings next to their triangles. A layer
 * without them has no outline to draw, and `getGeometry()` throws on it.
 */
export function hasRingTopology(geometryVector: GpuVector): boolean {
    return !!geometryVector.topologyVector?.ringOffsets;
}

/** Caches {@link inferVertexBases} per layer, since every feature's base depends on all features before it. */
const inferredVertexBases = new WeakMap<GpuVector, Uint32Array>();

/**
 * Returns the position in `vertexBuffer` of feature `index`'s first vertex in a layer without ring
 * topology, or of the end of the last feature when `index` is the number of features. The feature's
 * entries in `indexBuffer` count from 0, so they address `vertexBuffer` only once this base is added.
 *
 * Such a layer does not store how many vertices a feature has; see {@link inferVertexBases}.
 */
export function tessellatedVertexBase(geometryVector: GpuVector, index: number): number {
    let bases = inferredVertexBases.get(geometryVector);
    if (!bases) {
        bases = inferVertexBases(geometryVector);
        inferredVertexBases.set(geometryVector, bases);
    }
    return bases[index];
}

/**
 * Returns the vertex base of every feature of a layer without ring topology, and the end of the last
 * feature after them, counting each feature's vertices as one more than the highest index its triangles use.
 *
 * The count comes out short when earcut dropped a feature's last vertex as a duplicate or collinear
 * point, and every feature after it is then read from the wrong vertices.
 */
function inferVertexBases(geometryVector: GpuVector): Uint32Array {
    const {triangleOffsets, indexBuffer} = geometryVector;
    const numFeatures = triangleOffsets.length - 1;
    const bases = new Uint32Array(numFeatures + 1);
    for (let feature = 0; feature < numFeatures; feature++) {
        let numVertices = 0;
        for (let i = triangleOffsets[feature] * 3; i < triangleOffsets[feature + 1] * 3; i++) {
            numVertices = Math.max(numVertices, indexBuffer[i] + 1);
        }
        bases[feature + 1] = bases[feature] + numVertices;
    }
    return bases;
}

/**
 * Returns a feature's triangles, each closed into a ring of its own. A layer without ring topology
 * stores nothing else of a polygon, and the triangles cover the same area as its rings, so
 * `queryRenderedFeatures` hits the same features.
 *
 * Every ring winds the way an MVT exterior ring does, whichever way the tile wound its triangle:
 * `classifyRings()` takes a ring that winds against the first one for a hole in the polygon before it,
 * and a fill bucket would then cut the triangle out of its neighbour instead of filling it.
 */
function trianglesAsRings(geometryVector: GpuVector, index: number): Point[][] {
    const {triangleOffsets, indexBuffer, vertexBuffer} = geometryVector;
    const vertexBase = tessellatedVertexBase(geometryVector, index);
    const rings: Point[][] = [];
    for (let i = triangleOffsets[index] * 3; i < triangleOffsets[index + 1] * 3; i += 3) {
        const ring = [0, 1, 2].map(corner => {
            const vertex = (vertexBase + indexBuffer[i + corner]) * 2;
            return new Point(vertexBuffer[vertex], vertexBuffer[vertex + 1]);
        });
        const [a, b, c] = ring;
        if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0) ring.reverse();
        ring.push(ring[0].clone());
        rings.push(ring);
    }
    return rings;
}

/** Maps an MLT geometry type onto the 0-3 codes of `VectorTileFeatureLike['type']`. */
function toVectorTileGeometryType(geometryType: number | undefined): VectorTileFeatureLike['type'] {
    switch (geometryType) {
        case GEOMETRY_TYPE.POINT:
        case GEOMETRY_TYPE.MULTIPOINT:
            return 1;
        case GEOMETRY_TYPE.LINESTRING:
        case GEOMETRY_TYPE.MULTILINESTRING:
            return 2;
        case GEOMETRY_TYPE.POLYGON:
        case GEOMETRY_TYPE.MULTIPOLYGON:
            return 3;
        default:
            return 0;
    }
}

/**
 * A decoded MLT feature table with a row view of its features. Geometry, ids and property columns
 * stay in the table until a feature reads them.
 */
export class MLTVectorTileLayer implements VectorTileLayerLike {
    featureTable: FeatureTable;
    name: string;
    length: number;
    version: number;
    extent: number;
    /** See {@link MLTVectorTileOptions.copyProperties}. */
    copyProperties: boolean;

    constructor(featureTable: FeatureTable, options: MLTVectorTileOptions = {}) {
        this.featureTable = featureTable;
        this.copyProperties = !!options.copyProperties;
        this.name = featureTable.name;
        this.extent = featureTable.extent;
        this.version = 2;
        this.length = featureTable.numFeatures;
    }

    feature(i: number): VectorTileFeatureLike {
        return new MLTVectorTileFeature(this, i);
    }

    /**
     * Reads every feature into the row list a row-based bucket populates from. A columnar bucket
     * reads `featureTable` directly and never needs it.
     *
     * @param getId - resolves a feature's id, which depends on the source's `promoteId`
     */
    indexedFeatures(getId: (feature: VectorTileFeatureLike) => string | number, sourceLayerIndex: number): IndexedFeature[] {
        const features: IndexedFeature[] = [];
        for (let index = 0; index < this.length; index++) {
            const feature = this.feature(index);
            features.push({feature, id: getId(feature), index, sourceLayerIndex});
        }
        return features;
    }

    /**
     * Frees the decoded id, geometry and property columns and keeps only their positions in the tile
     * bytes. The next read decodes the column again, so this trades memory for a re-decode.
     */
    releaseDecodedColumns(): void {
        this.featureTable.releaseDecodedColumns();
    }
}

/** Whether `layer` is a decoded MLT layer, as opposed to a layer of an MVT `VectorTile`. */
export function isMLTVectorTileLayer(layer: VectorTileLayerLike): layer is MLTVectorTileLayer {
    return layer instanceof MLTVectorTileLayer;
}

/**
 * An MLT tile that works wherever a `VectorTileLike` is expected. Its layers are decoded on first
 * access, and the tile bytes must stay unmodified for as long as any layer may still be read.
 */
export class MLTVectorTile implements VectorTileLike {
    /**
     * The tile's layers by name, see {@link defineLazyLayer}.
     *
     * The object has no prototype. A layer turns from a getter into a data property on its first read,
     * and on an object built from `{}` that reconfigures hidden classes V8 shares with every other such
     * object, among them the ones keyed by style layer ids, which keeps deoptimizing the code that loops
     * over those with `for...in`.
     */
    layers: Record<string, VectorTileLayerLike> = Object.create(null);

    constructor(buffer: ArrayBuffer, options: MLTVectorTileOptions = {}) {
        for (const layerBlock of scanLayerBlocks(new Uint8Array(buffer))) {
            defineLazyLayer(this.layers, layerBlock, options);
        }
    }

    /**
     * Releases the decoded columns of every layer that has been read, see
     * {@link MLTVectorTileLayer.releaseDecodedColumns}. A layer nobody read has decoded nothing and
     * is left alone, so this never causes a decode.
     */
    releaseDecodedColumns(): void {
        for (const name of Object.keys(this.layers)) {
            // Inspect the descriptor, a plain read would run the getter and decode the layer.
            const layer = Object.getOwnPropertyDescriptor(this.layers, name)?.value;
            if (layer && isMLTVectorTileLayer(layer)) layer.releaseDecodedColumns();
        }
    }
}
