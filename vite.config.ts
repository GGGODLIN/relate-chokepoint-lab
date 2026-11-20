import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const GRAPH_WASM_VIRTUAL_ID = 'virtual:graph-wasm-url';
const GRAPH_WASM_RESOLVED_ID = `\0${GRAPH_WASM_VIRTUAL_ID}`;

function hashedGraphWasmPlugin(): Plugin {
  let command: 'serve' | 'build' = 'build';
  let base = '/';
  let rootDir = process.cwd();
  let emittedRefId: string | null = null;

  return {
    name: 'hashed-graph-wasm-url',
    configResolved(config) {
      command = config.command;
      base = config.base;
      rootDir = config.root;
    },
    resolveId(id) {
      if (id === GRAPH_WASM_VIRTUAL_ID) {
        return GRAPH_WASM_RESOLVED_ID;
      }
      return undefined;
    },
    load(id) {
      if (id !== GRAPH_WASM_RESOLVED_ID) {
        return undefined;
      }
      if (command === 'serve') {
        return `export default ${JSON.stringify(`${base}data/graph.wasm.json`)};`;
      }
      const source = readFileSync(resolve(rootDir, 'public/data/graph.wasm.json'));
      emittedRefId = this.emitFile({
        type: 'asset',
        name: 'graph.wasm.json',
        source,
      });
      return `export default import.meta.ROLLUP_FILE_URL_${emittedRefId};`;
    },
    resolveFileUrl({ referenceId, fileName }) {
      if (referenceId === emittedRefId) {
        return JSON.stringify(`${base}${fileName}`);
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), hashedGraphWasmPlugin()],
  optimizeDeps: {
    exclude: ['@relate/relate-wasm'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // MapLibre ships as one prebuilt ~1 MB bundle that cannot be split further; the limit
    // still flags any application chunk that grows past it.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/maplibre-gl/')) {
            return 'maplibre';
          }
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
