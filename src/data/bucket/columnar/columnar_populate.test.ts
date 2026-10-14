import {describe, test, expect, vi, afterEach} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import {decodeTile, encodeTile, GpuVector, SINGLE_PART_GEOMETRY_TYPE, type FeatureTable, type SelectionVector} from '@maplibre/mlt';
import {MLTVectorTileLayer} from '../../../source/vector_tile_mlt.ts';
import {FeatureIndex} from '../../feature_index.ts';
import {OverscaledTileID} from '../../../tile/tile_id.ts';
import {
    columnarTransferOmitList,
    isRowFeatureList,
    loadGeometryOrEmpty,
    materializeSelectedFeatures,
    selectColumnarFeatures
} from './columnar_populate.ts';

import type {FilterSpecification, PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';
import type {BucketFeature} from '../../bucket.ts';

/** Four features of three geometry types; features 0, 1 and 3 have class "a". */
function encodeMixedLayer(): Uint8Array {
    return encodeTile([{
        name: 'mixed',
        extent: 4096,
        features: [
            {id: 10, geometry: {type: 'Point', coordinates: [1, 2]}, properties: {class: 'a'}},
            {id: 11, geometry: {type: 'LineString', coordinates: [[0, 0], [10, 10]]}, properties: {class: 'a'}},
            {id: 12, geometry: {type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]]}, properties: {class: 'b'}},
            {id: 13, geometry: {type: 'Polygon', coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30]]]}, properties: {class: 'a'}}
        ]
    }]);
}

function decodeMixedLayer(): FeatureTable {
    return decodeTile(encodeMixedLayer())[0];
}

const classIsA: FilterSpecification = ['==', 'class', 'a'];

describe('isRowFeatureList', () => {
    test('tells the row list from the feature table', () => {
        expect(isRowFeatureList([])).toBe(true);
        expect(isRowFeatureList(new MLTVectorTileLayer(decodeMixedLayer()))).toBe(false);
    });
});

describe('selectColumnarFeatures', () => {
    test('selects the features the filter matches, in tile order', () => {
        expect(indices(selectColumnarFeatures(decodeMixedLayer(), classIsA, 5))).toEqual([0, 1, 3]);
    });

    test('selects every feature when the layer has no filter', () => {
        expect(indices(selectColumnarFeatures(decodeMixedLayer(), undefined, 5))).toEqual([0, 1, 2, 3]);
    });

    test('narrows the selection to the renderable geometry types', () => {
        const table = decodeMixedLayer();

        expect(indices(selectColumnarFeatures(table, classIsA, 5, [SINGLE_PART_GEOMETRY_TYPE.POLYGON]))).toEqual([3]);
        expect(indices(selectColumnarFeatures(table, classIsA, 5, [
            SINGLE_PART_GEOMETRY_TYPE.LINESTRING,
            SINGLE_PART_GEOMETRY_TYPE.POLYGON
        ]))).toEqual([1, 3]);
        expect(indices(selectColumnarFeatures(table, undefined, 5, [SINGLE_PART_GEOMETRY_TYPE.POINT]))).toEqual([0]);
    });

    test('scans a table for a set of geometry types once, however many layers ask for it', () => {
        const table = decodeMixedLayer();
        const filter = vi.spyOn(table.geometryVector, 'filter');
        const lineTypes = [SINGLE_PART_GEOMETRY_TYPE.LINESTRING, SINGLE_PART_GEOMETRY_TYPE.POLYGON];

        expect(indices(selectColumnarFeatures(table, classIsA, 5, lineTypes))).toEqual([1, 3]);
        expect(indices(selectColumnarFeatures(table, ['==', 'class', 'b'], 5, lineTypes))).toEqual([2]);
        expect(filter).toHaveBeenCalledTimes(2);

        expect(indices(selectColumnarFeatures(table, classIsA, 5, [SINGLE_PART_GEOMETRY_TYPE.POLYGON]))).toEqual([3]);
        expect(filter).toHaveBeenCalledTimes(3);
    });

    test('selects every polygon of a pre-tessellated layer without asking its geometry vector', () => {
        const file = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/22/12.mlt');
        const table = decodeTile(new Uint8Array(readFileSync(file))).find(t => t.geometryVector instanceof GpuVector);
        const filter = vi.spyOn(table.geometryVector, 'filter');

        const selection = selectColumnarFeatures(table, undefined, 5, [SINGLE_PART_GEOMETRY_TYPE.POLYGON]);

        expect(indices(selection)).toEqual(Array.from({length: table.numFeatures}, (_, i) => i));
        expect(filter).not.toHaveBeenCalled();
    });

    test('throws when the filter cannot be planned, since the dispatch should have caught it', () => {
        const unsupported = ['within', {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}] as FilterSpecification;

        expect(() => selectColumnarFeatures(decodeMixedLayer(), unsupported, 5)).toThrow('could not be planned');
    });
});

describe('materializeSelectedFeatures', () => {
    test('reads only the selected rows', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const feature = vi.spyOn(layer, 'feature');
        const selection = selectColumnarFeatures(layer.featureTable, classIsA, 5, [SINGLE_PART_GEOMETRY_TYPE.POLYGON]);

        const features = materializeSelectedFeatures(layer, selection, 7, createFeatureIndex());

        expect(feature.mock.calls.map(call => call[0])).toEqual([3]);
        expect(features).toHaveLength(1);
        expect(features[0]).toMatchObject({index: 3, id: 13, type: 3, sourceLayerIndex: 7, patterns: {}});
        expect(features[0].properties.class).toBe('a');
        // loadGeometry() closes the ring and scales the tile's extent of 4096 to GL JS's 8192.
        expect(features[0].geometry[0]).toHaveLength(5);
        expect(features[0].geometry[0][0]).toMatchObject({x: 40, y: 40});
        expect(features[0].dashes).toBeUndefined();
    });

    test('stores each source feature under its index when asked, so that the bucket can reuse it', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const feature = vi.spyOn(layer, 'feature');
        const selection = selectColumnarFeatures(layer.featureTable, classIsA, 5);
        const sourceFeatures: VectorTileFeatureLike[] = [];

        materializeSelectedFeatures(layer, selection, 0, createFeatureIndex(), {features: sourceFeatures});

        expect(feature).toHaveBeenCalledTimes(3);
        expect([0, 1, 3].map(index => sourceFeatures[index].id)).toEqual([10, 11, 13]);
        expect(sourceFeatures[2]).toBeUndefined();
    });

    test('takes the id from the promoteId of the source', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const selection = selectColumnarFeatures(layer.featureTable, classIsA, 5);

        const features = materializeSelectedFeatures(layer, selection, 0, createFeatureIndex({mixed: 'class'}));

        expect(features.map(feature => feature.id)).toEqual(['a', 'a', 'a']);
    });

    test('gives each feature a dashes object when the bucket asks for it', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const selection = selectColumnarFeatures(layer.featureTable, classIsA, 5);

        const features = materializeSelectedFeatures(layer, selection, 0, createFeatureIndex(), {hasDashes: true});

        expect(features.map(feature => feature.dashes)).toEqual([{}, {}, {}]);
    });

    test('evaluates the sort key per feature only when one is given', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const selection = selectColumnarFeatures(layer.featureTable, classIsA, 5);
        const sortKey = vi.fn((feature: BucketFeature) => feature.index * 10);

        const sorted = materializeSelectedFeatures(layer, selection, 0, createFeatureIndex(), {sortKey});
        const unsorted = materializeSelectedFeatures(layer, selection, 0, createFeatureIndex());

        expect(sorted.map(feature => feature.sortKey)).toEqual([0, 10, 30]);
        expect(sortKey).toHaveBeenCalledTimes(3);
        expect(unsorted.every(feature => feature.sortKey === undefined)).toBe(true);
    });

    test('takes the geometry from the resolver of the bucket instead of decoding the rings', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const selection = selectColumnarFeatures(layer.featureTable, classIsA, 5, [SINGLE_PART_GEOMETRY_TYPE.POLYGON]);
        const resolveGeometry = vi.fn(() => []);

        const features = materializeSelectedFeatures(layer, selection, 0, createFeatureIndex(), {resolveGeometry});

        expect(resolveGeometry).toHaveBeenCalledTimes(1);
        expect(resolveGeometry.mock.calls[0]).toEqual([expect.objectContaining({id: 13}), 3]);
        expect(features[0].geometry).toEqual([]);
    });

    test('returns nothing for an empty selection', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());
        const selection = selectColumnarFeatures(layer.featureTable, ['==', 'class', 'missing'], 5);

        expect(materializeSelectedFeatures(layer, selection, 0, createFeatureIndex())).toEqual([]);
    });
});

describe('loadGeometryOrEmpty', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('decodes the rings of a feature', () => {
        const layer = new MLTVectorTileLayer(decodeMixedLayer());

        // The tile's extent of 4096 is scaled to GL JS's 8192.
        expect(loadGeometryOrEmpty(layer.feature(1), 1)).toMatchObject([[{x: 0, y: 0}, {x: 20, y: 20}]]);
    });

    test('degrades to an empty geometry and warns once instead of aborting the tile', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const broken = {
            id: 4242,
            loadGeometry: () => {
                throw new Error('no ring topology');
            }
        } as unknown as VectorTileFeatureLike;

        expect(loadGeometryOrEmpty(broken, 0)).toEqual([]);
        expect(loadGeometryOrEmpty(broken, 0)).toEqual([]);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('4242');
        expect(warn.mock.calls[0][0]).toContain('no ring topology');
    });
});

describe('columnarTransferOmitList', () => {
    test('adds the worker-only fields to the omit list of the bucket class', () => {
        type Bucket = {layers: unknown; patternFeatures: unknown; isColumnar: boolean; sourceLayerIndex: number};

        expect(columnarTransferOmitList<Bucket>(['layers', 'patternFeatures']))
            .toEqual(['layers', 'patternFeatures', 'isColumnar', 'sourceLayerIndex']);
    });
});

function indices(selection: SelectionVector): number[] {
    return Array.from({length: selection.limit}, (_, i) => selection.getIndex(i));
}

function createFeatureIndex(promoteId?: PromoteIdSpecification): FeatureIndex {
    return new FeatureIndex(new OverscaledTileID(0, 0, 0, 0, 0), promoteId);
}
