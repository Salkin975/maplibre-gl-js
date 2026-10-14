import {defineConfig, type ViteUserConfig} from 'vitest/config';

const config: ViteUserConfig = defineConfig({
    test: {
        name: 'bench',
        environment: 'node',
        benchmark: {
            include: ['src/**/*.bench.ts'],
            /**
             * Bench mode otherwise counts every read of an imported binding in a `Map`, which a
             * bundle never does, and which costs hot loops that reference imports, such as
             * `new Point()` per vertex, a large and uneven share of the time they are measured at.
             */
            suppressExportGetterWarnings: true,
        },
    }
});

export default config;
