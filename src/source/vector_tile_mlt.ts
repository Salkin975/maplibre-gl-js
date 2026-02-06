import Point from '@mapbox/point-geometry';
import {type FeatureTable, type Feature as MLTFeature, GEOMETRY_TYPE} from '@maplibre/mlt';
import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

class MLTVectorTileFeature implements VectorTileFeatureLike {
    _featureData: MLTFeature;
    properties: {[_: string]: any};
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];

    constructor(feature: MLTFeature, extent: number) {
        this._featureData = feature;
        const rawProps = this._featureData.properties || {};
        this.properties = {};
        for (const key of Object.keys(rawProps)) {
            const val = rawProps[key];
            this.properties[key] = typeof val === 'bigint' ? Number(val) : val;
        }
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
    features: MLTFeature[] = [];

    constructor(featureTable: FeatureTable) {
        this.featureTable = featureTable;
        this.name = featureTable.name;
        this.extent = featureTable.extent;
        this.version = 2;
        this.features = featureTable.getFeatures();
        this.length = this.features.length;
    }

    feature(i: number): VectorTileFeatureLike {
        return new MLTVectorTileFeature(this.features[i], this.extent);
    }
}

export class MLTVectorTile implements VectorTileLike {
    layers: Record<string, VectorTileLayerLike> = {};

    constructor(featureTables: FeatureTable[]) {
        this.layers = featureTables.reduce((acc, f) => ({...acc, [f.name]: new MLTVectorTileLayer(f)}), {});
    }
}
