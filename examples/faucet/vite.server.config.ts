import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Two Node entries: the HTTP server and the per-network wallet worker it
// spawns as `./wallet-worker.js` next to itself. Rollup may split shared
// modules into sibling chunks, so deploy the whole server-dist directory.
export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'server-dist',
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      input: {
        server: fileURLToPath(new URL('./src/server.ts', import.meta.url)),
        'wallet-worker': fileURLToPath(new URL('./src/wallet-worker.ts', import.meta.url)),
      },
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
    },
  },
});
