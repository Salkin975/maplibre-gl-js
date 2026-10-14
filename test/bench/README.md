# Benchmarks

Benchmarks help us catch performance regressions and improve performance.

There are two kinds of benchmarks in this repository:

* **Micro benchmarks** live next to the code they measure as `src/**/*.bench.ts` files and run under [Vitest bench mode](https://vitest.dev/guide/features.html#benchmarking). They answer "did my change make this code path faster on my machine, right now" while you work on it.
* **End-to-end benchmarks** under `test/bench/e2e/` load real production artifacts (your `dist/` build, a release from the CDN) in headless Chrome and time a map through the public API. They answer "did the library get slower between versions".

## Micro benchmarks

Run all micro benchmarks:

```bash
npm run bench
```

Run a single file, or only the benchmark tests matching a name:

```bash
npm run bench -- src/render/subdivision.bench.ts
npm run bench -- -t coveringTiles
```

To measure a change, record a baseline before it and read that baseline back after. Add `writeResult` to the benchmark you are working on and run it on `main`:

```ts
test('subdividePolygon', async ({bench}) => {
    await bench('subdividePolygon', {writeResult: './bench-baseline.json'}, () => {
        subdividePolygon(polygon, tileID, granularity, true);
    }).run();
});
```

```bash
git checkout main && npm run bench -- src/render/subdivision.bench.ts
```

Then compare your branch against the recorded file with `bench.from()`:

```ts
test('subdividePolygon', async ({bench}) => {
    await bench.compare(
        bench.from('baseline', './bench-baseline.json'),
        bench('subdividePolygon', () => {
            subdividePolygon(polygon, tileID, granularity, true);
        }),
    );
});
```

```bash
git checkout your-branch && npm run bench -- src/render/subdivision.bench.ts
```

`bench.compare()` runs both entries in one table and marks the fastest, so a single run shows the before/after difference. If your PR claims a performance effect, paste that table into the PR description, along with the `writeResult`/`bench.from()` edit you used, so reviewers can reproduce it. Drop that edit again before committing.

Results are only comparable on the same machine in the same session: identical code routinely drifts a few percent between runs, so treat small deltas as noise. Vitest also runs the source through its own transform rather than the production build, which makes micro benchmark numbers useful for relative comparison but not as absolute production numbers.

To write a micro benchmark, create a `*.bench.ts` file next to the code you are measuring. Benchmarks are registered inside a regular `test()` through the `bench` fixture, and a single benchmark is started with `.run()`:

```ts
import {test} from 'vitest';
import {subdividePolygon} from './subdivision.ts';

test('subdividePolygon', async ({bench}) => {
    await bench('subdividePolygon', () => {
        subdividePolygon(polygon, tileID, granularity, true);
    }).run();
});
```

Benchmarks that belong together go through `bench.compare()` instead, which runs them with interleaved iterations and prints them as one table:

```ts
test('coveringTiles', async ({bench}) => {
    await bench.compare(
        bench('mercator', () => {
            coverWithPitch(createMercatorTransform(), 0);
        }),
        bench('globe', () => {
            coverWithPitch(createGlobeTransform(), 0);
        }),
    );
});
```

Keep setup work (building fixtures, parsing data) at module level so the measured call is the only thing inside `bench()`. See `src/geo/projection/covering_tiles.bench.ts` and `src/render/subdivision.bench.ts` for examples.

## End-to-end benchmarks

The e2e runner measures the real built library. It loads production `.mjs` artifacts in headless Chrome, drives a map through the public API against fully local fixtures (style, tiles, glyphs, sprite; zero network), and reads the timeline through the map's own events: bundle import, style load, first tile, load, first idle.

Compare the latest release against your working copy (run `npm run build-dist` first):

```bash
npm run bench-e2e
```

Artifacts are positional: `dist` is the local build, `latest` resolves through unpkg, a bare version like `6.0.0` fetches that release, and any URL to a `maplibre-gl.mjs` is used as-is. `--runs N` controls samples per artifact (default 8):

```bash
npm run bench-e2e -- 6.0.0 dist --runs 16
```

Columns are labeled by each artifact's own reported version. With exactly two artifacts the table adds a delta column. Artifacts run sequentially on one machine, and the same-session noise caveat from micro benchmarks applies here unchanged.

### Style and tile format comparison

`npm run bench-e2e-styles` compares MVT and MLT tiles across two builds of the library at eight locations in North Rhine-Westphalia. It needs the tile and style server on `localhost:8080`, which serves `osm-bright/mvt.json`, `mlt.json` and `mlt-pre-tess.json`.

| Column | Build | Style |
| --- | --- | --- |
| MVT | new | `mvt.json` |
| MLT (old) | old | `mlt.json` |
| MLT (new) | new | `mlt.json` |
| MLT (new, pre-tessellated) | new | `mlt-pre-tess.json` |

Each variant is measured with four benchmarks per location:

* **Layout: cold load to idle** is the time from creating a map with an empty tile cache to its first idle.
* **Layout: worker busy time** is the time the workers spend running during that load, sampled with the DevTools profiler. It is the figure closest to the cost of parsing and bucket building, because it leaves out the tile server.
* **Layout: mean tile load time** is the mean time from a tile's request to its arrival.
* **Paint: repaint time** is the time of one render of an idle map, including the GPU work.

The new build is `dist`, and the old build is read from `bench-builds/old`. Build the old one from `main` in a separate worktree so that your branch stays untouched:

```bash
git worktree add ../maplibre-gl-js-main main
cd ../maplibre-gl-js-main
npm run generate-style-code && npm run generate-unicode-data && npm run generate-struct-arrays && npm run generate-shaders && npm run build-prod
cp dist/*.mjs ../maplibre-gl-js/bench-builds/old/
```

Then build the branch under test with `npm run build-prod` and run:

```bash
npm run bench-e2e-styles -- --iterations 20
```

### Run it in the browser

Open the page through the dev server (`npm run start-server`, port 9966). It runs the benchmarks when it loads and fills in the results as they finish:

```
http://localhost:9966/test/bench/e2e/benchmarks.html
```

The page measures the built bundles, not the sources: `dist/maplibre-gl.mjs` for the new build and `bench-builds/old/maplibre-gl.mjs` for the old one. Run `npm run build-prod` after changing the code under test. `?new=` and `?old=` take another bundle URL, such as `?new=/dist/maplibre-gl-dev.mjs` for the build that `npm start` rebuilds, which is slower and not suited for timing.

Keep the tab in the foreground while it runs, since a hidden tab stops the map from rendering. The query parameters `iterations` (cold loads per variant and location, default 5; the page also has a field for it), `paint` (timed repaint batches, default 210), `memory` (cold loads sampled for memory, default 5) and `locations` (the first N locations) shorten a run, for example `?iterations=3&paint=30&locations=1&memory=2`. `baseline` chooses the variant the others are compared against. `types` (for example `?types=layout,paint`) chooses which of the three benchmarks run: `layout`, `paint` and `memory`, all of them by default. The page has a checkbox for each, and "Run again" applies them.

The memory benchmark samples the JS heap of the page and of its workers every 25 ms, and it cannot see off-heap array buffers. Start Chrome with `--js-flags=--expose-gc --enable-precise-memory-info` so that the page can collect garbage before each load and read exact sizes. The page has no worker busy time, because the profiler is only reachable from the command line runner.

### Run it from the command line

`npm run bench-e2e-styles -- --iterations 20` runs the same variants and locations in headless Chrome and adds the worker busy time. `--iterations` is the number of cold loads per variant and location, `--paint-measurements` the number of timed repaint batches (default 210), `--locations N` limits the run to the first N locations, and `--old-dist` and `--new-dist` choose the build directories. The results are written to `bench-results/styles-latest.json` and shown by the page with `?file=/bench-results/styles-latest.json`.

### Where the worker spends a tile

With `LOG_WORKER_TIMING` switched on in `src/source/worker_timing.ts`, `WorkerTile.parse()` appends one JSON line per tile to its worker's timing log: the parse time, the wait for glyphs, icons, patterns and dashes, and per layer the time to create and populate the bucket and to lay it out once its dependencies arrived, split into the phases the bucket records.

`npm run bench-e2e-timings` cold-loads `osm-bright` and `positron` in MVT and MLT with the build in `dist`, collects those lines from the workers into `bench-results/worker-timing.jsonl` and prints them summed by bucket. Headless Chrome runs the main thread, the workers and the tile server on the same cores, so these times are noisy.

`npm run bench -- src/source/worker_tile_nrw.bench.ts` parses the same twelve tiles of Cologne single-threaded in Node instead, which is steadier and is the one to compare changes with. Set `NRW_VARIANTS=osm-bright/mlt` to run one variant, and `NRW_CPU_PROFILE=<file>.cpuprofile` to record a CPU profile of the measured rounds.
