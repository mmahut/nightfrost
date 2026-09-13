import '../../light-wallet/src/polyfills.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { NetworkDef } from '../../light-wallet/src/networks.ts';
import {
  CLAIM_TTL_MS,
  errorMessage,
  HttpError,
  MAX_BODY_BYTES,
  MNEMONIC,
  NETWORKS,
  RETRY_MS,
  type Claim,
  type Lifecycle,
  type NetworkId,
} from './faucet-wallet.ts';
import type { WorkerCommand, WorkerEvent } from './wallet-worker.ts';

// Re-exported for the test suite, which drives the wallet in-process.
export { FaucetWallet } from './faucet-wallet.ts';

const PORT = Number(process.env.NIGHTFROST_FAUCET_PORT || '3210');
const HOST = process.env.NIGHTFROST_FAUCET_HOST || '127.0.0.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// Main-thread stand-in for one network's wallet, which lives in a worker
/// thread (see wallet-worker.ts). Mirrors the worker's lifecycle state so
/// /api/status and claim admission stay synchronous and instant, and
/// respawns the worker if it ever dies.
class WalletProxy {
  state: Lifecycle = 'starting';
  message = 'Faucet wallet is starting…';
  activeClaim: string | undefined;
  private worker: Worker | undefined;
  private stopping = false;

  constructor(
    readonly network: NetworkDef,
    private readonly onClaim: (claim: Claim) => void,
  ) {
    if (!network.enabled) {
      this.state = 'error';
      this.message = `${network.name} is unavailable until its indexer is ready.`;
    }
  }

  start(): void {
    const worker = new Worker(new URL('./wallet-worker.js', import.meta.url), {
      workerData: { networkId: this.network.networkId },
    });
    this.worker = worker;
    worker.on('message', (event: WorkerEvent) => {
      if (event.type === 'state') {
        this.state = event.state;
        this.message = event.message;
      } else if (event.type === 'claim') {
        this.onClaim(event.claim);
        if (event.claim.state === 'complete' || event.claim.state === 'failed') {
          this.activeClaim = undefined;
        }
      }
    });
    worker.on('error', (error) => {
      console.error(`[faucet:${this.network.networkId}] wallet worker error`, error);
    });
    worker.on('exit', (code) => {
      if (this.stopping) return;
      this.state = 'error';
      this.message = `Wallet worker exited (code ${code}); restarting…`;
      console.error(`[faucet:${this.network.networkId}]`, this.message);
      if (this.activeClaim) {
        this.onClaim({
          id: this.activeClaim,
          network: this.network.networkId as NetworkId,
          state: 'failed',
          message: 'The faucet wallet restarted while preparing this transfer.',
          createdAt: 0,
        });
        this.activeClaim = undefined;
      }
      setTimeout(() => this.start(), RETRY_MS).unref();
    });
  }

  claim(claim: Claim, address: string): void {
    if (this.state !== 'ready' || !this.worker) throw new HttpError(503, this.message);
    if (this.activeClaim) throw new HttpError(429, 'This network is already preparing a transfer. Try again shortly.');
    this.activeClaim = claim.id;
    claim.state = 'queued';
    claim.message = 'Transfer queued…';
    const command: WorkerCommand = { type: 'claim', claim: { ...claim }, address };
    this.worker.postMessage(command);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    if (!worker) return;
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'stop' } satisfies WorkerCommand);
    await Promise.race([exited, sleep(10_000)]);
    await worker.terminate().catch(() => undefined);
  }
}

const claims = new Map<string, Claim>();
const wallets = Object.fromEntries(
  Object.entries(NETWORKS).map(([id, network]) => [
    id,
    new WalletProxy(network, (update) => {
      const claim = claims.get(update.id);
      if (claim) {
        claim.state = update.state;
        claim.message = update.message;
      }
    }),
  ]),
) as Record<NetworkId, WalletProxy>;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Expected a JSON request body.');
  }
}

function validateClaim(value: unknown): { network: NetworkId; address: string } {
  if (typeof value !== 'object' || value === null) throw new HttpError(400, 'Invalid claim request.');
  const body = value as Record<string, unknown>;
  const network = body.network;
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (network !== 'preview' && network !== 'preprod') throw new HttpError(400, 'Choose Preview or Preprod.');
  const prefix = `mn_addr_${network}1`;
  if (!address.startsWith(prefix) || address.length < prefix.length + 20 || address.length > 180) {
    throw new HttpError(400, `Enter a valid ${network} NIGHT address.`);
  }
  return { network, address };
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, 200, {
        networks: Object.fromEntries(Object.entries(wallets).map(([id, wallet]) => [id, { state: wallet.state, message: wallet.message }])),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/claims') {
      const { network, address } = validateClaim(await readJson(request));
      const claim: Claim = { id: randomUUID(), network, state: 'queued', message: 'Transfer queued…', createdAt: Date.now() };
      claims.set(claim.id, claim);
      try {
        wallets[network].claim(claim, address);
      } catch (error) {
        claims.delete(claim.id);
        throw error;
      }
      json(response, 202, claim);
      return;
    }
    const match = /^\/api\/claims\/([0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      const claim = claims.get(match[1]);
      if (!claim) throw new HttpError(404, 'Claim not found.');
      json(response, 200, claim);
      return;
    }
    throw new HttpError(404, 'Not found.');
  })().catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error('[faucet:http]', error);
    json(response, status, { message: errorMessage(error) });
  });
});

async function shutdown(): Promise<void> {
  server.close();
  await Promise.all(Object.values(wallets).map((wallet) => wallet.stop().catch(() => undefined)));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!MNEMONIC) {
    console.error('NIGHTFROST_FAUCET_SEED_PHRASE is required.');
    process.exit(1);
  }

  for (const wallet of Object.values(wallets)) {
    if (wallet.network.enabled) void wallet.start();
  }
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const [id, claim] of claims) if (claim.createdAt < cutoff) claims.delete(id);
  }, 60 * 60 * 1_000);
  cleanup.unref();

  server.listen(PORT, HOST, () => console.info(`Nightfrost faucet listening on http://${HOST}:${PORT}`));
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
