import Point from '@mapbox/point-geometry';
import {type FeatureTable, type LayerBlock, type RowViewOptions, createRowView, decodeTile, GEOMETRY_TYPE, readSafeValue, scanLayerBlocks} from '@maplibre/mlt';
import {warnOnce} from '../util/util';

import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

/** Reports a property value that does not fit a JS number, once per column name. */
const ROW_VIEW_OPTIONS: RowViewOptions = {
    onUnsafeValue: (columnName) => warnOnce(`MLT property "${columnName}" is outside the safe integer range and was omitted.`)
};

/**
 * Installs the block's layer on `layers` as an enumerable getter that decodes the block on first
 * access and then replaces itself with a plain data property holding the layer.
 *
 * Keys and spread behave as on a fully decoded object, while a layer nobody reads is never decoded.
 */
function defineLazyLayer(layers: Record<string, VectorTileLayerLike>, layerBlock: LayerBlock) {
    Object.defineProperty(layers, layerBlock.name, {
        configurable: true,
        enumerable: true,
        get() {
            const layer = new MLTVectorTileLayer(decodeTile(layerBlock.bytes, undefined, false)[0]);
            Object.defineProperty(layers, layerBlock.name, {value: layer, configurable: true, enumerable: true, writable: true});
            return layer;
        }
    });
}

/**
 * Narrows a 64-bit feature id to a JS number. An id outside the safe integer range is omitted
 * with a warning, since any number standing in for it would identify the wrong feature.
 */
function toFeatureId(id: number | bigint | null | undefined): number | undefined {
    return readSafeValue(id, () => warnOnce('MLT feature id is outside the safe integer range and was omitted.')) as number | undefined;
}

/**
 * A feature of an {@link MLTVectorTileLayer}, backed by the layer's columns and read from them
 * only when asked.
 */
class MLTVectorTileFeature implements VectorTileFeatureLike {
    layer: MLTVectorTileLayer;
    index: number;
    /** Reads through to the layer's property columns, see `createRowView` in `@maplibre/mlt`. */
    properties: VectorTileFeatureLike['properties'];
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];

    constructor(layer: MLTVectorTileLayer, index: number) {
        const {featureTable} = layer;
        this.layer = layer;
        this.index = index;
        this.extent = layer.extent;
        this.properties = createRowView(featureTable, index, ROW_VIEW_OPTIONS) as VectorTileFeatureLike['properties'];
        this.type = toVectorTileGeometryType(featureTable.geometryVector?.geometryType(index));
        this.id = toFeatureId(featureTable.idVector?.getValue(index));
    }

    /** Returns copies of the decoded points, because bucket code is free to modify them. */
    loadGeometry(): Point[][] {
        const rings = this.layer.featureTable.geometryVector?.getGeometry(this.index) ?? [];
        return rings.map(ring => ring.map(point => new Point(point.x, point.y)));
    }
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

    constructor(featureTable: FeatureTable) {
        this.featureTable = featureTable;
        this.name = featureTable.name;
        this.extent = featureTable.extent;
        this.version = 2;
        this.length = featureTable.numFeatures;
    }

    feature(i: number): VectorTileFeatureLike {
        return new MLTVectorTileFeature(this, i);
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
    layers: Record<string, VectorTileLayerLike> = {};

    constructor(buffer: ArrayBuffer) {
        for (const layerBlock of scanLayerBlocks(new Uint8Array(buffer))) {
            defineLazyLayer(this.layers, layerBlock);
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
