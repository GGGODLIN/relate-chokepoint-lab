import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@relate/relate-wasm'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});
