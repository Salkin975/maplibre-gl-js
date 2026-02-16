import {FillLayoutArray} from '../../array_types.g';
import {EXTENT} from '../../extent';

import {members as layoutAttributes} from '../fill_attributes';
import {SegmentVector} from '../../segment';
import {ProgramConfigurationSet} from '../../program_configuration';
import {LineIndexArray, TriangleIndexArray} from '../../array_types.g';
import {register} from '../../../util/web_worker_transfer';
import {hasPattern} from '../pattern_bucket_features';

import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    PopulateParameters
} from '../../bucket';
import type {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import type {Context} from '../../../gl/context';
import type {IndexBuffer} from '../../../gl/index_buffer';
import type {VertexBuffer} from '../../../gl/vertex_buffer';
import type {FeatureStates} from '../../../source/source_state';
import type {ImagePosition} from '../../../render/image_atlas';
import {type FeatureTable, filter, type IGeometryVector, type SelectionVector} from '@maplibre/mlt';
import {type VectorTileLayer} from '@mapbox/vector-tile';
import earcut from 'earcut';
import {type Feature} from '@maplibre/maplibre-gl-style-spec';
import {type DashEntry} from '../../../render/line_atlas';
import {type CanonicalTileID} from '../../../tile/tile_id';

export class ColumnarFillBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: Array<FillStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<FillStyleLayer>;
    stateDependentLayerIds: Array<string>;
    patternFeatures: Array<BucketFeature>;

    layoutVertexArray: FillLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    indexArray2: LineIndexArray;
    indexBuffer2: IndexBuffer;

    hasDependencies: boolean;
    programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
    segments: SegmentVector;
    segments2: SegmentVector;
    uploaded: boolean;

    constructor(options: BucketParameters<FillStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasDependencies = false;
        this.patternFeatures = [];

        this.layoutVertexArray = new FillLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.indexArray2 = new LineIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.segments2 = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate<T>(data: T, options: PopulateParameters, canonical: CanonicalTileID): void {
        // ColumnarFillBucket only supports FeatureTable
        this.populateColumnar(data as FeatureTable, options, canonical);
    }

    update<T>(states: FeatureStates, layerData: T, imagePositions: Record<string, ImagePosition>, dashPositions?: Record<string, DashEntry>): void {
        // ColumnarFillBucket only supports FeatureTable
        this.updateColumnar(states, layerData as VectorTileLayer, imagePositions);
    }

    private createFeature(featureTable: FeatureTable, featureIndex: number): Feature {
        const properties: Record<string, unknown> = {};
        const propertyVectors = featureTable.propertyVectors;
        if (propertyVectors) {
            for (const propertyColumn of propertyVectors) {
                if (!propertyColumn) continue;
                const value = propertyColumn.getValue(featureIndex);
                if (value !== null) {
                    properties[propertyColumn.name] = typeof value === 'bigint' ? Number(value) : value;
                }
            }
        }
        const id = featureTable.idVector ? Number(featureTable.idVector.getValue(featureIndex)) : featureIndex;
        return {
            type: 'Polygon',
            id,
            properties,
            geometry: []
        } as Feature;
    }

    populateColumnar(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID) {
        this.populatePolygon(featureTable, options, canonical);

    }

    populatePolygon(featureTable: FeatureTable, options: PopulateParameters, canonical: CanonicalTileID) {
        this.hasDependencies = hasPattern('fill', this.layers, options);
        const fillSortKey = this.layers[0].layout.get('fill-sort-key');
        const sortFeaturesByKey = !fillSortKey.isConstant();
        if (sortFeaturesByKey) {
            throw new Error('Sorting features is not yet supported.');
        }

        const filterSpecification = this.layers[0].filter as any;
        const geometryVector = featureTable.geometryVector as IGeometryVector;

        if (!filterSpecification) {
            this.addGeometryPolygonsWithoutSelectionVector(geometryVector, featureTable.extent, 0, canonical, {}, featureTable);

            if (!geometryVector.topologyVector) {
                return;
            }

            if (geometryVector.topologyVector.geometryOffsets && geometryVector.topologyVector.partOffsets
                && geometryVector.topologyVector.ringOffsets) {
                this.addMultiPolygonOutlinesWithoutSelectionVector(featureTable, geometryVector.numGeometries, canonical);
                return;
            }

            if (geometryVector.topologyVector.partOffsets && geometryVector.topologyVector.ringOffsets) {
                this.addPolygonOutlinesWithoutSelectionVector(featureTable, geometryVector.numGeometries, canonical);
                return;
            }
            return;
        }

        const selectionVector = filter(featureTable, filterSpecification);

        if (selectionVector.limit === 0) {
            return;
        }

        this.addGeometryPolygons(selectionVector, geometryVector, featureTable, featureTable.extent, canonical, {});
        if (!geometryVector.topologyVector) {
            return;
        }

        if (geometryVector.topologyVector.geometryOffsets && geometryVector.topologyVector.partOffsets
            && geometryVector.topologyVector.ringOffsets) {
            this.addMultiPolygonOutlinesWithSelectionVector(featureTable, selectionVector, canonical);
            return;
        }

        if (geometryVector.topologyVector.partOffsets && geometryVector.topologyVector.ringOffsets) {
            this.addPolygonOutlinesWithSelectionVector(featureTable, selectionVector, canonical);
            return;
        }
    }

    updateColumnar(states: FeatureStates, vtLayer: VectorTileLayer, imagePositions: {
        [_: string]: ImagePosition;
    }) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {imagePositions});
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
            this.indexBuffer2 = context.createIndexBuffer(this.indexArray2);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.indexBuffer2.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.segments2.destroy();
    }

    addGeometryPolygons(
        selectionVector: SelectionVector,
        geometryVector: IGeometryVector,
        featureTable: FeatureTable,
        extent: number,
        canonical: CanonicalTileID,
        imagePositions: { [_: string]: ImagePosition }
    ) {
        const topologyVector = geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const partOffsets = topologyVector.partOffsets;
        const ringOffsets = topologyVector.ringOffsets;

        if (!partOffsets || !ringOffsets) {
            return;
        }

        const paintOptions = {
            imagePositions,
            canonical
        };

        let vertexBufferOffset = 0;

        if (!geometryOffsets) {
            for (let i = 0; i < selectionVector.limit; i++) {
                const featureOffset = Number(selectionVector.getIndex(i));
                const secondFeatureOffset = featureOffset + 1;
                vertexBufferOffset = this.updateVertexBuffer(featureOffset, secondFeatureOffset, partOffsets, ringOffsets, geometryVector, vertexBufferOffset, extent);
                const feature = this.createFeature(featureTable, featureOffset);
                this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureOffset, paintOptions);
            }
        } else {
            for (let i = 0; i < selectionVector.limit; i++) {
                const featureOffset = Number(selectionVector.getIndex(i));
                vertexBufferOffset = this.updateVertexBuffer(geometryOffsets[featureOffset], geometryOffsets[featureOffset + 1], partOffsets, ringOffsets, geometryVector, vertexBufferOffset, extent);
                const feature = this.createFeature(featureTable, featureOffset);
                this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, featureOffset, paintOptions);
            }
        }
    }

    addGeometryPolygonsWithoutSelectionVector(geometryVector: IGeometryVector, extent: number, index: number, canonical: CanonicalTileID, imagePositions: {
        [_: string]: ImagePosition;
    }, featureTable: FeatureTable) {
        const topologyVector = geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const partOffsets = topologyVector.partOffsets;
        const ringOffsets = topologyVector.ringOffsets;
        const numGeometries = geometryVector.numGeometries;

        if (!partOffsets || !ringOffsets) {
            return;
        }

        const paintOptions = {
            imagePositions,
            canonical
        };

        let vertexBufferOffset = 0;
        //Fix: create features when paintOptions exist
        if (!geometryOffsets) {
            for (let i = 0; i < numGeometries; i++) {
                vertexBufferOffset = this.updateVertexBuffer(i, i + 1, partOffsets, ringOffsets, geometryVector, vertexBufferOffset, extent);
                const feature = this.createFeature(featureTable, i);
                this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, i, paintOptions);
            }
        }
        else {
            for (let i = 0; i < numGeometries; i++) {
                const firstGeometryOffset = geometryOffsets[i];
                const secondGeometryOffset = geometryOffsets[i + 1];
                vertexBufferOffset = this.updateVertexBuffer(firstGeometryOffset, secondGeometryOffset, partOffsets, ringOffsets, geometryVector, vertexBufferOffset, extent);
                const feature = this.createFeature(featureTable, i);
                this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, i, paintOptions);
            }
        }
    }

    updateVertexBuffer(firstGeometryOffset: number, secondGeometryOffset: number, partOffsets: Uint32Array, ringOffsets: Uint32Array, geometryVector: IGeometryVector, vertexBufferOffset: number, extent: number): number {
        const scaleFactor = EXTENT / extent;

        for (let polygonIndex = firstGeometryOffset; polygonIndex < secondGeometryOffset; polygonIndex++) {
            const firstPartOffset = partOffsets[polygonIndex];
            const secondPartOffset = partOffsets[polygonIndex + 1];

            if (firstPartOffset === undefined || secondPartOffset === undefined ||
                firstPartOffset >= secondPartOffset) {
                continue;
            }

            const vertices = [];
            const holeIndices = [];
            let actualVertexCount = 0;

            for (let part = firstPartOffset; part < secondPartOffset; part++) {
                const firstRingOffset = ringOffsets[part];
                const secondRingOffset = ringOffsets[part + 1];

                if (firstRingOffset === undefined || secondRingOffset === undefined ||
                    firstRingOffset >= secondRingOffset) {
                    continue;
                }

                // Hole-Index vor dem Ring hinzufügen
                if (part > firstPartOffset) {
                    holeIndices.push(vertices.length / 2);
                }

                for (let vertexIndex = firstRingOffset; vertexIndex < secondRingOffset; vertexIndex++) {
                    const vertex = geometryVector.getVertex(vertexIndex);

                    if (!vertex || !Array.isArray(vertex) || vertex.length < 2) {
                        continue;
                    }

                    const scaledX = vertex[0] * scaleFactor;
                    const scaledY = vertex[1] * scaleFactor;

                    if (isNaN(scaledX) || isNaN(scaledY)) {
                        continue;
                    }

                    vertices.push(scaledX);
                    vertices.push(scaledY);
                    actualVertexCount++;
                }
            }

            // Skip degenerate polygons (e.g. from tile boundary clipping)
            if (vertices.length < 6) {
                continue;
            }

            // Prepare Segment mit tatsächlicher Vertex-Anzahl
            const triangleSegment = this.segments.prepareSegment(
                actualVertexCount,
                this.layoutVertexArray,
                this.indexArray
            );

            // Vertices zum Layout-Array hinzufügen
            for (let i = 0; i < vertices.length; i += 2) {
                this.layoutVertexArray.emplaceBack(vertices[i], vertices[i + 1]);
            }

            let indices;
            try {
                indices = earcut(vertices, holeIndices);
            } catch (error) {
                triangleSegment.vertexLength += actualVertexCount;
                vertexBufferOffset = triangleSegment.vertexLength;
                continue;
            }

            if (!indices || !Array.isArray(indices) || indices.length === 0) {
                triangleSegment.vertexLength += actualVertexCount;
                vertexBufferOffset = triangleSegment.vertexLength;
                continue;
            }

            for (let i = 0; i < indices.length; i += 3) {
                this.indexArray.emplaceBack(
                    vertexBufferOffset + indices[i],
                    vertexBufferOffset + indices[i + 2],
                    vertexBufferOffset + indices[i + 1]
                );
            }

            // Update Segment-Statistiken
            triangleSegment.vertexLength += actualVertexCount;
            triangleSegment.primitiveLength += indices.length / 3;
            vertexBufferOffset = triangleSegment.vertexLength;
        }

        return vertexBufferOffset;
    }

    addPolygonOutlinesWithoutSelectionVector(featureTable: FeatureTable, numGeometries: number,
        canonical: CanonicalTileID) {
        const geometryVector = featureTable.geometryVector as IGeometryVector;
        const topologyVector = geometryVector.topologyVector;
        const ringOffsets = topologyVector.ringOffsets;
        const partOffsets = topologyVector.partOffsets;
        const scaleFactor = EXTENT / featureTable.extent;

        for (let featureOffset = 0; featureOffset < numGeometries; featureOffset++) {
            let ringOffset = partOffsets[featureOffset];
            const numRings = partOffsets[featureOffset + 1] - ringOffset;

            for (let j = 0; j < numRings; j++) {
                const ringOffsetStart = ringOffsets[ringOffset++];
                const ringOffsetEnd = ringOffsets[ringOffset];
                const numVertices = ringOffsetEnd - ringOffsetStart;

                // Use the shared layoutVertexArray, not a new one
                const lineSegment = this.segments2.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray2);
                const lineIndex = lineSegment.vertexLength;

                // ADD THE ACTUAL VERTICES
                for (let k = ringOffsetStart; k < ringOffsetEnd; k++) {
                    const vertex = geometryVector.getVertex(k);
                    this.layoutVertexArray.emplaceBack(
                        vertex[0] * scaleFactor,
                        vertex[1] * scaleFactor
                    );
                }

                // Now add indices
                this.indexArray2.emplaceBack(lineIndex + numVertices - 1, lineIndex);
                for (let k = 1; k < numVertices; k++) {
                    this.indexArray2.emplaceBack(lineIndex + k - 1, lineIndex + k);
                }

                lineSegment.vertexLength += numVertices;
                lineSegment.primitiveLength += numVertices;
            }

            const id = featureTable.idVector ? Number(featureTable.idVector.getValue(featureOffset)) : featureOffset;
            const feature = {id} as any;
            const paintOptions = {
                imagePositions: null,
                canonical
            };

            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, id, paintOptions);
        }
    }

    addMultiPolygonOutlinesWithoutSelectionVector(featureTable: FeatureTable, numGeometries: number,
        canonical: CanonicalTileID) {
        const geometryVector = featureTable.geometryVector as IGeometryVector;
        const topologyVector = geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const ringOffsets = topologyVector.ringOffsets;
        const partOffsets = topologyVector.partOffsets;
        const scaleFactor = EXTENT / featureTable.extent;

        for (let featureOffset = 0; featureOffset < numGeometries; featureOffset++) {
            let partOffset = geometryOffsets[featureOffset];
            const numPolygons = geometryOffsets[featureOffset + 1] - partOffset;

            for (let l = 0; l < numPolygons; l++) {
                let ringOffset = partOffsets[partOffset++];
                const numRings = partOffsets[partOffset] - ringOffset;

                for (let j = 0; j < numRings; j++) {
                    const ringOffsetStart = ringOffsets[ringOffset++];
                    const ringOffsetEnd = ringOffsets[ringOffset];
                    const numVertices = ringOffsetEnd - ringOffsetStart;

                    // FIXED: Use shared layoutVertexArray instead of creating new array
                    const lineSegment = this.segments2.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray2);
                    const lineIndex = lineSegment.vertexLength;

                    // ADD THE ACTUAL VERTICES
                    for (let k = ringOffsetStart; k < ringOffsetEnd; k++) {
                        const vertex = geometryVector.getVertex(k);
                        this.layoutVertexArray.emplaceBack(
                            vertex[0] * scaleFactor,
                            vertex[1] * scaleFactor
                        );
                    }

                    // Add line indices
                    this.indexArray2.emplaceBack(lineIndex + numVertices - 1, lineIndex);
                    for (let k = 1; k < numVertices; k++) {
                        this.indexArray2.emplaceBack(lineIndex + k - 1, lineIndex + k);
                    }

                    lineSegment.vertexLength += numVertices;
                    lineSegment.primitiveLength += numVertices;
                }
            }

            const id = featureTable.idVector ? Number(featureTable.idVector.getValue(featureOffset)) : featureOffset;
            const feature = {id} as any;
            const paintOptions = {
                imagePositions: null,
                canonical
            };

            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, id, paintOptions);
        }
    }

    addPolygonOutlinesWithSelectionVector(featureTable: FeatureTable, selectionVector: SelectionVector,
        canonical: CanonicalTileID) {
        const geometryVector = featureTable.geometryVector as IGeometryVector;
        const topologyVector = geometryVector.topologyVector;
        const ringOffsets = topologyVector.ringOffsets;
        const partOffsets = topologyVector.partOffsets;
        const scaleFactor = EXTENT / featureTable.extent;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            let ringOffset = partOffsets[index];
            const numRings = partOffsets[index + 1] - ringOffset;

            for (let j = 0; j < numRings; j++) {
                const ringOffsetStart = ringOffsets[ringOffset++];
                const ringOffsetEnd = ringOffsets[ringOffset];
                const numVertices = ringOffsetEnd - ringOffsetStart;

                // FIXED: Use shared layoutVertexArray
                const lineSegment = this.segments2.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray2);
                const lineIndex = lineSegment.vertexLength;

                // ADD THE ACTUAL VERTICES
                for (let k = ringOffsetStart; k < ringOffsetEnd; k++) {
                    const vertex = geometryVector.getVertex(k);
                    this.layoutVertexArray.emplaceBack(
                        vertex[0] * scaleFactor,
                        vertex[1] * scaleFactor
                    );
                }

                this.indexArray2.emplaceBack(lineIndex + numVertices - 1, lineIndex);
                for (let k = 1; k < numVertices; k++) {
                    this.indexArray2.emplaceBack(lineIndex + k - 1, lineIndex + k);
                }

                lineSegment.vertexLength += numVertices;
                lineSegment.primitiveLength += numVertices;
            }

            const id = featureTable.idVector ? Number(featureTable.idVector.getValue(i)) : i;
            const feature = {id} as any;
            const paintOptions = {
                imagePositions: null,
                canonical
            };

            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, paintOptions);
        }
    }

    addMultiPolygonOutlinesWithSelectionVector(featureTable: FeatureTable, selectionVector: SelectionVector,
        canonical: CanonicalTileID) {
        const geometryVector = featureTable.geometryVector as IGeometryVector;
        const topologyVector = geometryVector.topologyVector;
        const geometryOffsets = topologyVector.geometryOffsets;
        const ringOffsets = topologyVector.ringOffsets;
        const partOffsets = topologyVector.partOffsets;
        const scaleFactor = EXTENT / featureTable.extent;

        for (let i = 0; i < selectionVector.limit; i++) {
            const index = selectionVector.getIndex(i);
            let partOffset = geometryOffsets[index];
            const numPolygons = geometryOffsets[index + 1] - partOffset;

            for (let l = 0; l < numPolygons; l++) {
                let ringOffset = partOffsets[partOffset++];
                const numRings = partOffsets[partOffset] - ringOffset;

                for (let j = 0; j < numRings; j++) {
                    const ringOffsetStart = ringOffsets[ringOffset++];
                    const ringOffsetEnd = ringOffsets[ringOffset];
                    const numVertices = ringOffsetEnd - ringOffsetStart;

                    // FIXED: Use shared layoutVertexArray
                    const lineSegment = this.segments2.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray2);
                    const lineIndex = lineSegment.vertexLength;

                    // ADD THE ACTUAL VERTICES
                    for (let k = ringOffsetStart; k < ringOffsetEnd; k++) {
                        const vertex = geometryVector.getVertex(k);
                        this.layoutVertexArray.emplaceBack(
                            vertex[0] * scaleFactor,
                            vertex[1] * scaleFactor
                        );
                    }

                    this.indexArray2.emplaceBack(lineIndex + numVertices - 1, lineIndex);
                    for (let k = 1; k < numVertices; k++) {
                        this.indexArray2.emplaceBack(lineIndex + k - 1, lineIndex + k);
                    }

                    lineSegment.vertexLength += numVertices;
                    lineSegment.primitiveLength += numVertices;
                }
            }

            const id = featureTable.idVector ? Number(featureTable.idVector.getValue(i)) : i;
            const feature = {id} as any;
            const paintOptions = {
                imagePositions: null,
                canonical
            };

            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, paintOptions);
        }
    }
}

register('ColumnarFillBucket', ColumnarFillBucket, {omit: ['layers', 'patternFeatures']});
