import {encodeTile} from '@maplibre/mlt';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';

import type Point from '@mapbox/point-geometry';
import type {FeatureGeometry, FeatureInput, Layer, Position} from '@maplibre/mlt';
import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

/**
 * Encodes a vector tile as MLT, as `fromVectorTileJs()` of `@maplibre/vt-pbf` encodes one as MVT.
 *
 * A property keeps the value its feature reports, a nested map or list included, which MVT has no
 * column for. A feature without a geometry MLT can store - an unknown geometry type, or a polygon
 * whose rings enclose no area - is left out, and so is a layer that is left without features.
 *
 * Throws when a property holds values of different types within a layer, since an MLT column has a
 * single type.
 */
export function encodeMLTVectorTile(vectorTile: VectorTileLike): ArrayBuffer {
    const layers: Layer[] = [];
    for (const sourceLayer of Object.values(vectorTile.layers)) {
        const layer = toEncoderLayer(sourceLayer);
        if (layer.features.length > 0) layers.push(layer);
    }

    const bytes = encodeTile(layers);
    const isWholeBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    return (isWholeBuffer ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

/** Reads every feature of `sourceLayer` into the layer the MLT encoder takes. */
function toEncoderLayer(sourceLayer: VectorTileLayerLike): Layer {
    const features: FeatureInput[] = [];
    for (let index = 0; index < sourceLayer.length; index++) {
        const feature = sourceLayer.feature(index);
        const geometry = toEncoderGeometry(feature.type, feature.loadGeometry());
        if (!geometry) continue;

        features.push({
            id: feature.id,
            geometry,
            properties: feature.properties
        });
    }
    return {name: sourceLayer.name, extent: sourceLayer.extent, features};
}

/**
 * Turns the rings of a vector tile feature into the geometry the MLT encoder takes, or returns
 * `undefined` when there is none to encode.
 *
 * A vector tile feature only says whether it holds points, lines or polygons, so the single and the
 * multi form are told apart by the number of parts, and a polygon's rings are grouped into polygons by
 * their winding order, the way a fill layer reads them.
 */
function toEncoderGeometry(type: VectorTileFeatureLike['type'], rings: Point[][]): FeatureGeometry | undefined {
    switch (type) {
        case 1: {
            const points = rings.flat().map(toPosition);
            if (points.length === 0) return undefined;
            return points.length === 1 ?
                {type: 'Point', coordinates: points[0]} :
                {type: 'MultiPoint', coordinates: points};
        }
        case 2: {
            const lines = rings.filter(ring => ring.length > 1).map(toPositions);
            if (lines.length === 0) return undefined;
            return lines.length === 1 ?
                {type: 'LineString', coordinates: lines[0]} :
                {type: 'MultiLineString', coordinates: lines};
        }
        case 3: {
            const polygons = classifyRings(rings).map(polygon => polygon.map(toPositions));
            if (polygons.length === 0 || polygons[0].length === 0) return undefined;
            return polygons.length === 1 ?
                {type: 'Polygon', coordinates: polygons[0]} :
                {type: 'MultiPolygon', coordinates: polygons};
        }
        default:
            return undefined;
    }
}

function toPositions(ring: Point[]): Position[] {
    return ring.map(toPosition);
}

/** MLT stores integer coordinates, and a geometry that was clipped has vertices between them. */
function toPosition(point: Point): Position {
    return [Math.round(point.x), Math.round(point.y)];
}
