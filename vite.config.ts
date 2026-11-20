import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
