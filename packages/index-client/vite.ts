/**
 * A Vite plugin that builds the range reader (`src/range/sw.ts`) as its own
 * classic script, `sw.js`, beside the page: in `vite build` into the output
 * directory, and in `vite dev` on request. A service worker cannot share the
 * page's module graph, and its URL must be stable (no hash) so the
 * registration survives rebuilds.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

const SW_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/range/sw.ts');

async function bundleWorker(outDir: string, minify: boolean): Promise<void> {
  await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      minify,
      sourcemap: false,
      target: 'es2022',
      lib: { entry: SW_ENTRY, formats: ['iife'], name: 'rangeReader', fileName: () => 'sw.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

export function rangeReaderPlugin(): Plugin {
  let outDir = 'dist';
  let minify = true;
  let devBuild: Promise<string> | null = null;
  return {
    name: 'ar-io-range-reader',
    configResolved(config) {
      outDir = config.build.outDir;
      minify = config.build.minify !== false;
    },
    async closeBundle() {
      await bundleWorker(outDir, minify);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || req.url.split('?')[0] !== '/sw.js') return next();
        devBuild ??= (async () => {
          const dir = path.join(server.config.cacheDir, 'range-reader');
          await bundleWorker(dir, false);
          return path.join(dir, 'sw.js');
        })();
        const file = await devBuild;
        const { readFile } = await import('node:fs/promises');
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(await readFile(file));
      });
      server.watcher.on('change', (f) => {
        if (f.includes(path.join('index-client', 'src', 'range'))) devBuild = null;
      });
    },
  };
}
