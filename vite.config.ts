import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works from any sub-path (e.g. GitHub Pages)
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
