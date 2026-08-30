// The upstream worker rethrows asynchronous prover errors. Some browsers do
// not surface that rejection through the module worker's `error` event, which
// leaves the SDK parent with only “Failed to prove transaction”. Implement the
// small upstream protocol here and return the rejection explicitly instead.
import type { ProvingKeyMaterial } from '@midnight-ntwrk/zkir-v2';

// Boot beacons: load each dependency dynamically and report the stage to the
// parent page, so a stalled import (the zkir WASM fetch in particular) is
// visible instead of an indefinitely silent worker.
// The built worker shares chunks with the page bundle, so a dynamic import
// during proving runs Vite's module-preload helper, which dereferences
// `document` and crashes in a worker. Give it just enough DOM to no-op.
(globalThis as { document?: unknown }).document ??= {
  createElement: () => ({ relList: undefined, addEventListener: () => undefined }),
  getElementsByTagName: () => [],
  querySelector: () => null,
  head: { appendChild: () => undefined },
};

const boot = (stage: string) => postMessage({ op: 'boot', stage });
// With dynamic imports the page's first message can arrive while dependencies
// are still loading; hold it until the real handler is registered below.
const earlyMessages: MessageEvent[] = [];
const earlyListener = (event: MessageEvent) => earlyMessages.push(event);
addEventListener('message', earlyListener);
boot('worker-start');
const { Schema } = await import('effect');
boot('effect-loaded');
const { check, prove } = await import('@midnight-ntwrk/zkir-v2');
boot('zkir-wasm-loaded');
const {
  CheckOperationSchema,
  GetParamsOperationResultSchema,
  GetParamsRequestSchema,
  LookupKeyOperationResultSchema,
  LookupKeyRequestSchema,
  ProveOperationSchema,
  ResponseFromWorkerSchema,
} = await import(
  '../node_modules/@midnightntwrk/wallet-sdk-prover-client/dist/effect/WasmProver.js'
);
boot('wasmprover-loaded');

const MAX_TIME_TO_PROCESS = 10 * 60 * 1_000;

const MessageDataSchema = Schema.Union(
  CheckOperationSchema,
  ProveOperationSchema,
  LookupKeyOperationResultSchema,
  GetParamsOperationResultSchema,
);

const keyMaterialProvider = {
  lookupKey(keyLocation: string): Promise<ProvingKeyMaterial | undefined> {
    return new Promise((resolve, reject) => {
      console.info('[nf-worker] lookupKey request', keyLocation);
      postMessage(Schema.encodeSync(LookupKeyRequestSchema)({ op: 'lookupKey', keyLocation }));
      const subscription = ({ data }: MessageEvent) => {
        const decoded = Schema.decodeUnknownSync(MessageDataSchema)(data);
        if (decoded.op === 'lookupKey' && decoded.keyLocation === keyLocation) {
          removeEventListener('message', subscription);
          console.info('[nf-worker] lookupKey resolved', keyLocation);
          resolve(decoded.result);
        }
      };
      addEventListener('message', subscription);
      setTimeout(() => reject(new Error(`Promise timed out for lookupKey: ${keyLocation}`)), MAX_TIME_TO_PROCESS);
    });
  },
  getParams(k: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      console.info('[nf-worker] getParams request', k);
      postMessage(Schema.encodeSync(GetParamsRequestSchema)({ op: 'getParams', k }));
      const subscription = ({ data }: MessageEvent) => {
        const decoded = Schema.decodeUnknownSync(MessageDataSchema)(data);
        if (decoded.op === 'getParams' && decoded.k === k) {
          removeEventListener('message', subscription);
          console.info('[nf-worker] getParams resolved', k);
          resolve(decoded.result);
        }
      };
      addEventListener('message', subscription);
      setTimeout(() => reject(new Error(`Promise timed out for getParams: ${k}`)), MAX_TIME_TO_PROCESS);
    });
  },
};

function reportError(cause: unknown): void {
  const detail = cause instanceof Error ? cause.stack || cause.message : String(cause);
  postMessage({ op: 'error', detail });
}

const handleMessage = ({ data }: MessageEvent) => {
  const decoded = Schema.decodeUnknownSync(MessageDataSchema)(data);
  console.info('[nf-worker] recv', decoded.op);
  if (decoded.op === 'check') {
    check(decoded.args[0], keyMaterialProvider)
      .then((value) => {
        console.info('[nf-worker] check done');
        postMessage(Schema.encodeSync(ResponseFromWorkerSchema)({ op: 'result', value }));
      })
      .catch(reportError);
  } else if (decoded.op === 'prove') {
    console.info('[nf-worker] prove starting');
    prove(decoded.args[0], keyMaterialProvider, decoded.args[1])
      .then((value) => {
        console.info('[nf-worker] prove done');
        postMessage(Schema.encodeSync(ResponseFromWorkerSchema)({ op: 'result', value }));
      })
      .catch(reportError);
  }
};

addEventListener('message', handleMessage);
removeEventListener('message', earlyListener);
boot('worker-ready');
for (const event of earlyMessages) handleMessage(event);
