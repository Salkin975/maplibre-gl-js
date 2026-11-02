/**
 * Switches the per-tile timing lines that `WorkerTile.parse()` appends to the worker's timing log, and
 * with them every clock read the timing takes. A benchmark build switches it on; while it is off, the
 * timing reads no clock and keeps no log.
 */
export const LOG_WORKER_TIMING = false;

/** The most lines the worker keeps for a reader that has not collected them yet. */
const MAX_LOGGED_TILES = 5000;

/**
 * The milliseconds the phases inside the bucket being populated have taken so far, by phase name. A
 * bucket adds to it with {@link addPhase}; `WorkerTile.parse()` moves it onto the layer's row with
 * {@link takePhases} once `populate()` returns, which it does synchronously.
 */
const phases: Record<string, number> = {};

/** Returns the time a phase starts at, to be handed to {@link addPhase}; 0 while the timing is off. */
export function phaseStart(): number {
    return LOG_WORKER_TIMING ? performance.now() : 0;
}

/** Adds the time since `since`, a value from {@link phaseStart}, to the named phase of the bucket being populated. */
export function addPhase(name: string, since: number): void {
    if (!LOG_WORKER_TIMING) return;
    phases[name] = (phases[name] ?? 0) + performance.now() - since;
}

/** Returns the phases recorded since the last call and starts the next bucket from none. */
export function takePhases(): Record<string, number> {
    const taken = {...phases};
    for (const name in phases) delete phases[name];
    return taken;
}

/** The milliseconds one style layer's bucket cost in the worker while a tile was parsed. */
type LayerTiming = {
    layer: string;
    type: string;
    sourceLayer: string;
    features: number;
    columnar: boolean;
    createBucket: number;
    populate: number;
    addFeatures: number;
    phases: Record<string, number>;
};

/**
 * Collects where the worker spends the time of one tile and appends it as one JSON line to
 * `globalThis.__workerTimingLog`, which a reader drains from outside the worker, because a worker has
 * no file to write to. The log holds at most {@link MAX_LOGGED_TILES} lines and drops the oldest.
 *
 * `sourceLayerAccess` is the time to reach a source layer on the decoded tile, `rowBuild` the time to
 * build the row-based feature list an MVT layer's buckets share, and `dependencies` the time spent
 * waiting for glyphs, icons, patterns and dashes.
 */
export class TileTimings {
    private readonly start = performance.now();
    private readonly layers = new Map<string, LayerTiming>();
    private sourceLayerAccess = 0;
    private rowBuild = 0;
    private dependencies = 0;

    /** Returns the current time, to be handed back to one of the `add*` methods as `since`. */
    now(): number {
        return phaseStart();
    }

    /** The milliseconds since `since`; 0 while the timing is off. */
    elapsed(since: number): number {
        return LOG_WORKER_TIMING ? performance.now() - since : 0;
    }

    addSourceLayerAccess(since: number): void {
        this.sourceLayerAccess += this.elapsed(since);
    }

    addRowBuild(since: number): void {
        this.rowBuild += this.elapsed(since);
    }

    addDependencies(since: number): void {
        this.dependencies += this.elapsed(since);
    }

    /** Starts the row for a layer's bucket and returns it, so the phases that follow add to it. */
    layer(id: string, type: string, sourceLayer: string, features: number, columnar: boolean): LayerTiming {
        const timing: LayerTiming = {layer: id, type, sourceLayer, features, columnar, createBucket: 0, populate: 0, addFeatures: 0, phases: {}};
        this.layers.set(id, timing);
        return timing;
    }

    /** Adds the time of the dependency-resolved layout pass to the layer it belongs to. */
    addFeatures(id: string, since: number): void {
        const timing = this.layers.get(id);
        if (timing) timing.addFeatures += this.elapsed(since);
    }

    /** Appends the tile's line: the total, the tile-level phases and one entry per layer. */
    log(tile: string, encoding: string): void {
        const round = (value: number) => Math.round(value * 100) / 100;
        const log: string[] = ((globalThis as any).__workerTimingLog ??= []);
        if (log.length >= MAX_LOGGED_TILES) log.shift();
        log.push(JSON.stringify({
            tile,
            encoding,
            total: round(performance.now() - this.start),
            sourceLayerAccess: round(this.sourceLayerAccess),
            rowBuild: round(this.rowBuild),
            dependencies: round(this.dependencies),
            layers: [...this.layers.values()].map(l => ({
                ...l,
                createBucket: round(l.createBucket),
                populate: round(l.populate),
                addFeatures: round(l.addFeatures),
                phases: Object.fromEntries(Object.entries(l.phases).map(([name, ms]) => [name, round(ms)]))
            }))
        }));
    }
}
