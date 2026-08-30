import '../../light-wallet/src/polyfills.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { NightfrostApi } from '../../light-wallet/src/api.ts';
import { isNativeToken } from '../../light-wallet/src/format.ts';
import { openNightfrostWallet, type LocalWalletSession } from '../../light-wallet/src/nightfrost-sdk.ts';
import type { NetworkDef } from '../../light-wallet/src/networks.ts';

type NetworkId = 'preview' | 'preprod';
type Lifecycle = 'starting' | 'syncing' | 'waiting_funds' | 'registering' | 'waiting_dust' | 'ready' | 'error';
type ClaimState = 'queued' | 'sending' | 'complete' | 'failed';
type Claim = { id: string; network: NetworkId; state: ClaimState; message: string; createdAt: number };

const PORT = Number(process.env.NIGHTFROST_FAUCET_PORT || '3210');
const HOST = process.env.NIGHTFROST_FAUCET_HOST || '127.0.0.1';
const MNEMONIC = process.env.NIGHTFROST_FAUCET_SEED_PHRASE?.trim() || '';
const CLAIM_STAR = 1_337_000n; // 1.337 NIGHT per claim
const RETRY_MS = 15_000;
const CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 4_096;

const NETWORKS: Record<NetworkId, NetworkDef> = {
  preview: {
    name: 'Preview',
    networkId: 'preview',
    apiUrl: process.env.NIGHTFROST_FAUCET_PREVIEW_API || 'https://preview.nightfrost.dev',
    faucetUrl: null,
    color: '#f0b429',
    enabled: true,
  },
  preprod: {
    name: 'Preprod',
    networkId: 'preprod',
    apiUrl: process.env.NIGHTFROST_FAUCET_PREPROD_API || 'https://preprod.nightfrost.dev',
    faucetUrl: null,
    color: '#8fd0e4',
    enabled: true,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

class FaucetWallet {
  state: Lifecycle = 'starting';
  message = 'Faucet wallet is starting…';
  session: LocalWalletSession | undefined;
  activeClaim: string | undefined;

  constructor(readonly network: NetworkDef) {}

  async start(): Promise<never> {
    for (;;) {
      try {
        await this.initialize();
        await new Promise<never>(() => undefined);
      } catch (error) {
        this.state = 'error';
        this.message = `Wallet startup failed; retrying: ${errorMessage(error)}`;
        console.error(`[faucet:${this.network.networkId}]`, this.message);
        await this.session?.stop().catch(() => undefined);
        this.session = undefined;
        await sleep(RETRY_MS);
      }
    }
  }

  private async initialize(): Promise<void> {
    this.state = 'syncing';
    this.message = 'Faucet wallet is syncing…';
    const session = await openNightfrostWallet(MNEMONIC, this.network);
    this.session = session;
    console.info(`[faucet:${this.network.networkId}] funding address ${session.address}`);
    await session.ready;

    const api = new NightfrostApi(this.network);
    this.state = 'waiting_funds';
    this.message = 'Faucet is waiting to be funded…';
    for (;;) {
      const balances = await api.addressBalances(session.addressHex);
      const night = BigInt(balances.find((balance) => /^(?:0x)?0{64}$/i.test(balance.token_type))?.amount ?? '0');
      if (night >= CLAIM_STAR) break;
      await sleep(RETRY_MS);
    }

    // Decide registration from the indexer's UTXO flags, not the wallet
    // session's dustStatus(): the session's view can lag behind the indexer
    // funding check above, which once made the faucet skip registration and
    // then wait forever for DUST that unregistered NIGHT never generates.
    const needsRegistration = async () => {
      const utxos = await api.addressUtxos(session.addressHex);
      return utxos.some(
        (utxo) => isNativeToken(utxo.token_type) && !utxo.registered_for_dust_generation,
      );
    };
    const dust = await session.dustStatus();
    console.info(
      `[faucet:${this.network.networkId}] dust status registered=${dust.registeredUtxos} unregistered=${dust.unregisteredUtxos} balance=${dust.balance} indexerNeedsRegistration=${await needsRegistration()}`,
    );
    if (await needsRegistration()) {
      this.state = 'registering';
      this.message = 'Faucet is registering its NIGHT for DUST generation…';
      // The wallet must see the unregistered UTXO itself before it can build
      // the registration transaction; give its sync a bounded head start and
      // throw into the retry loop if it never settles.
      const deadline = Date.now() + 10 * 60 * 1_000;
      while ((await session.dustStatus()).unregisteredUtxos === 0) {
        if (Date.now() > deadline) {
          throw new Error('Wallet never saw the unregistered NIGHT UTXO the indexer reports.');
        }
        await sleep(RETRY_MS);
      }
      await session.registerForDustGeneration((stage) => {
        this.message = stage;
        console.info(`[faucet:${this.network.networkId}] ${stage}`);
      });
    }

    this.state = 'waiting_dust';
    this.message = 'Faucet is waiting for transaction DUST…';
    while ((await session.dustStatus()).balance <= 0n) await sleep(RETRY_MS);
    this.state = 'ready';
    this.message = 'Faucet is ready.';
    console.info(`[faucet:${this.network.networkId}] ready`);
  }

  claim(claim: Claim, address: string): void {
    if (this.state !== 'ready' || !this.session) throw new HttpError(503, this.message);
    if (this.activeClaim) throw new HttpError(429, 'This network is already preparing a transfer. Try again shortly.');
    this.activeClaim = claim.id;
    claim.state = 'queued';
    claim.message = 'Transfer queued…';
    void this.send(claim, address);
  }

  private async send(claim: Claim, address: string): Promise<void> {
    try {
      claim.state = 'sending';
      const result = await this.session!.sendUnshielded(address, CLAIM_STAR, (stage) => {
        claim.message = stage;
        console.info(`[faucet:${this.network.networkId}:${claim.id}] ${stage}`);
      });
      claim.state = 'complete';
      claim.message = result.hash || result.identifier;
    } catch (error) {
      claim.state = 'failed';
      claim.message = errorMessage(error);
      console.error(`[faucet:${this.network.networkId}:${claim.id}]`, error);
    } finally {
      this.activeClaim = undefined;
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const wallets = Object.fromEntries(
  Object.entries(NETWORKS).map(([id, network]) => [id, new FaucetWallet(network)]),
) as Record<NetworkId, FaucetWallet>;
const claims = new Map<string, Claim>();

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

if (!MNEMONIC) {
  console.error('NIGHTFROST_FAUCET_SEED_PHRASE is required.');
  process.exit(1);
}

for (const wallet of Object.values(wallets)) void wallet.start();
const cleanup = setInterval(() => {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [id, claim] of claims) if (claim.createdAt < cutoff) claims.delete(id);
}, 60 * 60 * 1_000);
cleanup.unref();

server.listen(PORT, HOST, () => console.info(`Nightfrost faucet listening on http://${HOST}:${PORT}`));

async function shutdown(): Promise<void> {
  server.close();
  await Promise.all(Object.values(wallets).map((wallet) => wallet.session?.stop().catch(() => undefined)));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
