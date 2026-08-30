import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'server-dist',
    emptyOutDir: true,
    ssr: fileURLToPath(new URL('./src/server.ts', import.meta.url)),
    rollupOptions: {
      output: { entryFileNames: 'server.js' },
    },
  },
});
