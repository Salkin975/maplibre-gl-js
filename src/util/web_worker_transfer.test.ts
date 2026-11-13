import {describe, test, expect} from 'vitest';
import {encodeTile, decodeTile} from '@maplibre/mlt';
import {AJAXError} from './ajax.ts';
import {register, serialize, deserialize} from './web_worker_transfer.ts';
import {featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {FillBucket} from '../data/bucket/fill_bucket.ts';
import {LineBucket} from '../data/bucket/line_bucket.ts';
import {SymbolBucket} from '../data/bucket/symbol_bucket.ts';
import {MLTVectorTileLayer} from '../source/vector_tile_mlt.ts';
import {CANONICAL, bucketParameters, createFillLayer, createLineLayer, createSymbolLayer, populateOptions} from './test/columnar_bucket.ts';

/** Returns the MLT layer `name` of a tile with a polygon in `land`, a line in `roads` and a point in `places`. */
function mltLayer(name: string): MLTVectorTileLayer {
    const tables = decodeTile(encodeTile([
        {name: 'land', extent: 4096, features: [{id: 1, geometry: {type: 'Polygon', coordinates: [[[0, 0], [400, 0], [400, 400], [0, 400]]]}, properties: {name: 'Park'}}]},
        {name: 'roads', extent: 4096, features: [{id: 2, geometry: {type: 'LineString', coordinates: [[0, 2000], [3000, 2000]]}, properties: {name: 'Main St'}}]},
        {name: 'places', extent: 4096, features: [{id: 3, geometry: {type: 'Point', coordinates: [100, 100]}, properties: {name: 'Bonn', icon: 'town'}}]}
    ]));
    return new MLTVectorTileLayer(tables.find(table => table.name === name));
}

/** Returns what the main thread receives when the worker sends it `bucket`. */
function transferred<T>(bucket: T): T {
    return deserialize(serialize(bucket, [])) as T;
}

describe('web worker transfer', () => {
    test('round trip', () => {
        class SerializableMock {
            n;
            buffer;
            blob;
            _cached;
            dataView;
            imageData;
            array;

            constructor(n) {
                this.n = n;
                this.buffer = new ArrayBuffer(100);
                this.dataView = new DataView(this.buffer);
                this.imageData = new ImageData(8, 5);
                this.blob = new Blob();
                this.array = [true, 1, 'one', new ArrayBuffer(100)];
                this.squared();
            }

            squared() {
                if (this._cached) {
                    return this._cached;
                }
                this._cached = this.n * this.n;
                return this._cached;
            }
        }

        register('SerializableMock', SerializableMock, {omit: ['_cached']});

        const serializableMock = new SerializableMock(10);
        const transferables = [];
        const deserialized = deserialize(serialize(serializableMock, transferables)) as SerializableMock;
        expect(deserialize(serialize(serializableMock, transferables))).toBeInstanceOf(SerializableMock);
        expect(serializableMock.dataView).toBeInstanceOf(DataView);

        expect(serializableMock !== deserialized).toBeTruthy();
        expect(deserialized.constructor === SerializableMock).toBeTruthy();
        expect(deserialized.n === 10).toBeTruthy();
        expect(deserialized.buffer === serializableMock.buffer).toBeTruthy();
        expect(deserialized.blob === serializableMock.blob).toBeTruthy();
        expect(transferables[0] === serializableMock.buffer).toBeTruthy();
        expect(transferables[1] === serializableMock.dataView.buffer).toBeTruthy();
        expect(deserialized._cached === undefined).toBeTruthy();
        expect(deserialized.squared() === 100).toBeTruthy();
        expect(deserialized.dataView).toBeInstanceOf(DataView);
        expect(deserialized.array).toEqual(serializableMock.array);
    });

    test('anonymous class', () => {
        const Klass = (() => (class {}))();
        expect(!Klass.name).toBeTruthy();
        register('Anon', Klass);
        const x = new Klass();
        const deserialized = deserialize(serialize(x));
        expect(deserialized).toBeInstanceOf(Klass);
    });

    test('null', () => {
        expect(() => serialize(null)).not.toThrow();
    });

    test('custom serialization', () => {
        class CustomSerialization {
            id;
            _deserialized;
            constructor(id) {
                this.id = id;
                this._deserialized = false;
            }

            static serialize(b) {
                return {custom: `custom serialization,${b.id}`};
            }

            static deserialize(input) {
                const b = new CustomSerialization(input.custom.split(',')[1]);
                b._deserialized = true;
                return b;
            }
        }

        register('CustomSerialization', CustomSerialization);

        const customSerialization = new CustomSerialization('a');
        expect(!customSerialization._deserialized).toBeTruthy();

        const deserialized = deserialize(serialize(customSerialization)) as CustomSerialization;
        expect(deserialize(serialize(customSerialization))).toBeInstanceOf(CustomSerialization);
        expect(deserialized.id).toBe(customSerialization.id);
        expect(deserialized._deserialized).toBeTruthy();
    });

    test('AjaxError serialization', () => {
        const status = 404;
        const statusText = 'not found';
        const url = 'https://example.com';

        const ajaxError = new AJAXError(status, statusText, url, new Blob());
        const serialized = serialize(ajaxError);
        const deserialized = deserialize(serialized) as AJAXError;
        expect(deserialized.status).toBe(404);
        expect(deserialized.statusText).toBe(statusText);
        expect(deserialized.url).toBe(url);
    });

    test('serialize Object has _classRegistryKey', () => {
        class BadClass {
            _classRegistryKey: 'foo';
        }
        const trySerialize = () => {
            serialize(new BadClass());
        };
        expect(trySerialize).toThrow('can\'t serialize object of unregistered class BadClass');
    });
    test('serialize can not used reserved property #name', () => {
        class BadClass {
            static serialize() {
                return {
                    '$name': 'foo'
                };
            }
        }
        register('BadClass', BadClass);
        const badObject = new BadClass();
        expect(() => {
            serialize(badObject);
        }).toThrow('$name property is reserved for worker serialization logic.');
    });
    test('deserialize Object has $name', () => {
        const badObject = {
            '$name': 'foo'
        };
        const tryDeserialize = () => {
            deserialize(badObject);
        };
        expect(tryDeserialize).toThrow('can\'t deserialize unregistered class foo');
    });

    test('some objects can not be serialized', () => {
        expect(() => {
            serialize(BigInt(123));
        }).toThrow('can\'t serialize object of type bigint');
    });
    test('some objects can not be deserialized', () => {
        expect(() => {
            deserialize(BigInt(123) as unknown);
        }).toThrow('can\'t deserialize object of type bigint');
    });

    test('"has" filter returns false for undefined or missing properties after serialization', () => {
        const filter = featureFilter(['has', 'testProperty'], 'layers[0].filter');
        const params = new EvaluationParameters(0);

        const makeFeature = (properties: Record<string, unknown>) => ({
            type: 1 as const,
            properties: deserialize(serialize(properties)) as Record<string, unknown>,
            geometry: []
        });

        expect(filter.filter(params, makeFeature({testProperty: 'value'}))).toBe(true);
        expect(filter.filter(params, makeFeature({testProperty: undefined}))).toBe(false);
        expect(filter.filter(params, makeFeature({}))).toBe(false);
    });

    test('a columnar FillBucket reaches the main thread with its arrays and without its worker-only fields', () => {
        const bucket = new FillBucket(bucketParameters(createFillLayer()));
        bucket.populate(mltLayer('land'), populateOptions().options, CANONICAL);
        const vertexCount = bucket.layoutVertexArray.length;

        const received = transferred(bucket);

        expect(bucket.isColumnar).toBe(true);
        expect(vertexCount).toBeGreaterThan(0);
        expect(received).toBeInstanceOf(FillBucket);
        expect(received.layoutVertexArray).toHaveLength(vertexCount);
        expect(received.layerIds).toEqual(['fill']);
        expect(received).not.toHaveProperty('isColumnar');
        expect(received).not.toHaveProperty('sourceLayerIndex');
    });

    test('a columnar LineBucket reaches the main thread with its arrays and without its worker-only fields', () => {
        const bucket = new LineBucket(bucketParameters(createLineLayer()));
        bucket.populate(mltLayer('roads'), populateOptions().options, CANONICAL);
        const vertexCount = bucket.layoutVertexArray.length;

        const received = transferred(bucket);

        expect(bucket.isColumnar).toBe(true);
        expect(vertexCount).toBeGreaterThan(0);
        expect(received).toBeInstanceOf(LineBucket);
        expect(received.layoutVertexArray).toHaveLength(vertexCount);
        expect(received.layerIds).toEqual(['line']);
        expect(received).not.toHaveProperty('isColumnar');
        expect(received).not.toHaveProperty('sourceLayerIndex');
    });

    test('a columnar SymbolBucket reaches the main thread with the source layer placement reads and without isColumnar', () => {
        const bucket = new SymbolBucket({...bucketParameters(createSymbolLayer()), sourceLayerIndex: 2});
        bucket.populate(mltLayer('places'), populateOptions().options, CANONICAL);

        const received = transferred(bucket);

        expect(bucket.isColumnar).toBe(true);
        expect(bucket.features).toHaveLength(1);
        expect(received).toBeInstanceOf(SymbolBucket);
        expect(received.layerIds).toEqual(['symbol']);
        expect(received.sourceLayerIndex).toBe(2);
        expect(received).not.toHaveProperty('isColumnar');
    });
});
