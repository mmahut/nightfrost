import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';

const browserAssert = fileURLToPath(new URL('./src/assert.ts', import.meta.url));
const main = fileURLToPath(new URL('./index.html', import.meta.url));
const proofWorker = fileURLToPath(
  new URL(
    './src/proof-worker.ts',
    import.meta.url,
  ),
);

// Keep this URL versioned. The worker is fetched independently of the hashed
// application bundle; reusing a filename lets a CDN retain an older worker
// after the main application has been redeployed.
const proofWorkerPublicPath = '/dist/proof-worker-v6.js';

const proofWorkerDevPlugin: Plugin = {
  name: 'nightfrost-proof-worker',
  transform(code, rawId) {
    // Dev-served node_modules ids carry a ?v=<hash> query; match on the path.
    const id = rawId.split('?')[0];
    // The wallet proves through the capabilities proving service, whose own
    // catch discards the underlying cause behind a generic message. Surface
    // the detail there too — this is the path the send flow actually takes.
    if (id.endsWith('/wallet-sdk-capabilities/dist/proving/provingService.js')) {
      const genericServiceError = [
        '                catch: (error) => error instanceof ClientError || error instanceof ServerError',
        '                    ? error',
        "                    : new ClientError({ message: 'Failed to prove transaction', cause: error }),",
      ].join('\n');
      const diagnosticServiceError = [
        '                catch: (error) => {',
        "                    const detail = error instanceof Error ? error.stack || error.message : String(error);",
        "                    console.error('Nightfrost proving service failed', error);",
        '                    if (error instanceof ClientError || error instanceof ServerError) return error;',
        "                    return new ClientError({ message: 'Failed to prove transaction: ' + detail, cause: error });",
        '                },',
      ].join('\n');
      const patched = code.replace(genericServiceError, diagnosticServiceError);
      if (patched === code) {
        throw new Error('Could not install Nightfrost proving-service diagnostics.');
      }
      return patched;
    }
    if (id.endsWith('/wallet-sdk-prover-client/dist/effect/WasmProver.js')) {
      const upstreamMessageHandler = [
        "worker.addEventListener('message', ({ data }) => {",
        '            const decoded = Schema.decodeUnknownSync(MessageDataSchema)(data);',
      ].join('\n');
      const diagnosticMessageHandler = [
        "worker.addEventListener('message', ({ data }) => {",
        "            console.info('[nf-prover] page recv', data && typeof data === 'object' ? data.op : typeof data, data && data.keyLocation ? data.keyLocation : '', data && data.k !== undefined ? data.k : '');",
        "            if (data && typeof data === 'object' && data.op === 'error') {",
        "                const detail = typeof data.detail === 'string' ? data.detail : 'Proof worker failed without an error message.';",
        "                console.error('Nightfrost local prover failed', detail);",
        '                worker.terminate();',
        '                reject(Error(detail));',
        '                return;',
        '            }',
        '            const decoded = Schema.decodeUnknownSync(MessageDataSchema)(data);',
      ].join('\n');
      const rewritten = code
        .replace(
          '../../dist/proof-worker.js',
          '../../dist/proof-worker-v6.js',
        )
        .replace(upstreamMessageHandler, diagnosticMessageHandler);
      const upstreamHandler = [
        "worker.addEventListener('error', (e) => {",
        '            worker.terminate();',
        '            reject(Error(e.message));',
        '        });',
      ].join('\n');
      const diagnosticHandler = [
        "worker.addEventListener('error', (event) => {",
        "            const location = event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : '';",
        "            const nested = event.error instanceof Error ? event.error.stack || event.error.message : String(event.error || '');",
        "            const message = [event.message, location, nested].filter(Boolean).join('\\n');",
        "            console.error('Nightfrost local prover worker failed', event.error || event);",
        '            worker.terminate();',
        "            reject(Error(message || 'Proof worker failed without an error message.'));",
        '        });',
      ].join('\n');
      const genericProverError = [
        '            catch: (error) => error instanceof ClientError',
        '                ? error',
        "                : new ClientError({ message: 'Failed to prove transaction', cause: error }),",
      ].join('\n');
      const diagnosticProverError = [
        '            catch: (error) => {',
        "                const detail = error instanceof Error ? error.stack || error.message : String(error);",
        "                console.error('Nightfrost transaction proof failed', error);",
        '                return error instanceof ClientError',
        '                    ? error',
        "                    : new ClientError({ message: 'Failed to prove transaction: ' + detail, cause: error });",
        '            },',
      ].join('\n');
      // The SDK kills the prover worker after a hard 10 minutes, which is
      // shorter than a browser legitimately needs for the larger circuits —
      // the wallet UI already tells people proving takes several minutes,
      // so give it a real ceiling instead.
      const upstreamTimeout = 'const MAX_TIME_TO_PROCESS = 10 * 60 * 1000;';
      const extendedTimeout = 'const MAX_TIME_TO_PROCESS = 60 * 60 * 1000;';
      const patched = rewritten
        .replace(upstreamHandler, diagnosticHandler)
        .replace(genericProverError, diagnosticProverError)
        .replace(upstreamTimeout, extendedTimeout);
      if (patched === rewritten) {
        throw new Error('Could not install Nightfrost proof-worker diagnostics.');
      }
      if (!patched.includes(extendedTimeout)) {
        throw new Error('Could not extend the Nightfrost prover timeout.');
      }
      if (!patched.includes("Nightfrost transaction proof failed")) {
        throw new Error('Could not install Nightfrost transaction proof diagnostics.');
      }
      return patched;
    }
  },
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      // In the build the prover chunk lives under /assets/, so the worker URL
      // resolves to the public path exactly; in dev WasmProver.js is served
      // from its real node_modules path and the relative URL resolves under
      // the package instead, so match by suffix.
      if (request.url?.split('?')[0].endsWith(proofWorkerPublicPath)) {
        request.url = '/@fs/' + proofWorker;
      }
      next();
    });
  },
};

// The wallet proves through a Midnight proof server on its own origin: the
// SDK's HTTP prover client posts to the absolute paths /prove and /check, so
// they are proxied at the root rather than under a prefix. Run one locally
// with `podman run --rm -p 127.0.0.1:6300:6300 docker.io/midnightntwrk/proof-server:8.1.0 midnight-proof-server`
// (or build with VITE_PROVING_SERVER_URL=browser to prove in the tab instead).
const proofServerProxy = {
  target: process.env.NIGHTFROST_PROOF_SERVER || 'http://127.0.0.1:6300',
  changeOrigin: true,
  // Proving a transaction on the server can take a while; the SDK waits.
  timeout: 15 * 60 * 1_000,
  proxyTimeout: 15 * 60 * 1_000,
};

export default defineConfig({
  plugins: [wasm(), proofWorkerDevPlugin],
  resolve: {
    alias: { assert: browserAssert },
  },
  optimizeDeps: {
    // The proof-worker plugin patches these packages' dist files inside
    // transform(), and WasmProver resolves the worker URL relative to its own
    // file. Pre-bundling would skip the transform hook and re-anchor that URL
    // under .vite/deps, so serve them from source in dev.
    exclude: [
      '@midnightntwrk/wallet-sdk-capabilities',
      '@midnightntwrk/wallet-sdk-prover-client',
    ],
    // Bare imports reached only through the excluded packages must still be
    // optimized up front, or their late discovery invalidates the dep hashes
    // mid-load (503 "outdated optimize dep").
    include: [
      'effect',
      'rxjs',
      'web-worker',
      '@effect/platform',
      // Reached from the excluded capabilities package; keep it pre-bundled
      // so its CommonJS deps (bn.js via @polkadot) get ESM interop.
      '@midnightntwrk/wallet-sdk-node-client/effect',
    ],
  },
  server: {
    proxy: {
      // Lets a local test build point apiUrl at this server (VITE_NETWORKS)
      // so the browser only ever talks to localhost.
      '/api': {
        target: 'https://preview.nightfrost.dev',
        changeOrigin: true,
      },
      '/proving-material': {
        target: 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com',
        changeOrigin: true,
        rewrite: (path) => path.slice('/proving-material'.length),
      },
      '/prove': proofServerProxy,
      '/check': proofServerProxy,
    },
  },
  preview: {
    proxy: {
      '/prove': proofServerProxy,
      '/check': proofServerProxy,
    },
  },
  build: {
    // The Midnight ledger WASM wrapper initializes through top-level await.
    // Wallet-capable browsers already support it, so preserve it in output.
    target: 'esnext',
    rollupOptions: {
      input: { main, 'dist/proof-worker-v6': proofWorker },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'dist/proof-worker-v6'
            ? 'dist/proof-worker-v6.js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
});
