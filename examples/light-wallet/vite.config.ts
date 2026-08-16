import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

const browserAssert = fileURLToPath(new URL('./src/assert.ts', import.meta.url));

export default defineConfig({
  plugins: [wasm()],
  resolve: {
    alias: { assert: browserAssert },
  },
  build: {
    // The Midnight ledger WASM wrapper initializes through top-level await.
    // Wallet-capable browsers already support it, so preserve it in output.
    target: 'esnext',
  },
});
