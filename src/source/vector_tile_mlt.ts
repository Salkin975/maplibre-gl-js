import Point from '@mapbox/point-geometry';
import {type FeatureTable, decodeTile, type Feature as MLTFeature, GEOMETRY_TYPE} from '@maplibre/mlt';
import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

// TODO(mlt-pipeline): Remove MLTVectorTileFeature once MLT has its own worker pipeline separate from MVT.
// Bridges MLT features into the VectorTileFeatureLike interface so the shared MVT pipeline can process
// layer types (symbol, circle, fill-extrusion, ...) that do not yet have a dedicated MLT bucket implementation.
class MLTVectorTileFeature implements VectorTileFeatureLike {
    _featureData: MLTFeature;
    properties: {[_: string]: any};
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];

    constructor(feature: MLTFeature, extent: number) {
        this._featureData = feature;
        this.properties = this._featureData.properties || {};
        switch (this._featureData.geometry?.type) {
            case GEOMETRY_TYPE.POINT:
            case GEOMETRY_TYPE.MULTIPOINT:
                this.type = 1;
                break;
            case GEOMETRY_TYPE.LINESTRING:
            case GEOMETRY_TYPE.MULTILINESTRING:
                this.type = 2;
                break;
            case GEOMETRY_TYPE.POLYGON:
            case GEOMETRY_TYPE.MULTIPOLYGON:
                this.type = 3;
                break;
            default:
                this.type = 0;
        };
        this.extent = extent;
        this.id = Number(this._featureData.id);
    }

    loadGeometry(): Point[][] {
        const points: Point[][] = [];
        for (const ring of this._featureData.geometry.coordinates) {
            const pointRing: Point[] = [];
            for (const coord of ring) {
                pointRing.push(new Point(coord.x, coord.y));
            }
            points.push(pointRing);
        }
        return points;
    }
}

class MLTVectorTileLayer implements VectorTileLayerLike {
    featureTable: FeatureTable;
    name: string;
    length: number;
    version: number;
    extent: number;
    // TODO(mlt-full-support): Remove _features and feature() once all layer types have columnar bucket implementations.
    // Lazy materialization is only needed for non-columnar buckets that call feature(i).
    private _features: MLTFeature[] | null = null;

    constructor(featureTable: FeatureTable) {
        this.featureTable = featureTable;
        this.name = featureTable.name;
        this.extent = featureTable.extent;
        this.version = 2;
        this.length = featureTable.numFeatures;
    }

    // TODO(mlt-full-support): Remove once all layer types have columnar bucket implementations.
    feature(i: number): VectorTileFeatureLike {
        if (!this._features) {
            this._features = this.featureTable.getFeatures();
        }
        return new MLTVectorTileFeature(this._features[i], this.extent);
    }
}

export class MLTVectorTile implements VectorTileLike {
    layers: Record<string, VectorTileLayerLike> = {};

    constructor(buffer: ArrayBuffer) {
        const features = decodeTile(new Uint8Array(buffer));
        this.layers = features.reduce((acc, f) => ({...acc, [f.name]: new MLTVectorTileLayer(f)}), {});
    }
}
