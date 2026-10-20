import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

import { rangeReaderPlugin } from '@ar-io/index-client/vite';

export default defineConfig({
  // Served from an Arweave manifest under /<id>/ or an ArNS name: every URL relative.
  base: './',
  plugins: [preact(), rangeReaderPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@duckdb/duckdb-wasm')) return 'duckdb';
          if (id.includes('apache-arrow')) return 'arrow';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  server: { headers: { 'Service-Worker-Allowed': '/' } },
});
