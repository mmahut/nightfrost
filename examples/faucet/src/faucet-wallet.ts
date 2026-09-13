import { NightfrostApi } from '../../light-wallet/src/api.ts';
import { isNativeToken } from '../../light-wallet/src/format.ts';
import { openNightfrostWallet, type LocalWalletSession } from '../../light-wallet/src/nightfrost-sdk.ts';
import type { NetworkDef } from '../../light-wallet/src/networks.ts';

export type NetworkId = 'preview' | 'preprod';
export type Lifecycle = 'starting' | 'syncing' | 'waiting_funds' | 'registering' | 'waiting_dust' | 'ready' | 'error';
export type ClaimState = 'queued' | 'sending' | 'complete' | 'failed';
export type Claim = { id: string; network: NetworkId; state: ClaimState; message: string; createdAt: number };

export const MNEMONIC = process.env.NIGHTFROST_FAUCET_SEED_PHRASE?.trim() || '';
export const PROVING_SERVER_URL = new URL(
  process.env.NIGHTFROST_FAUCET_PROVING_SERVER_URL || 'http://127.0.0.1:6300',
);
export const CLAIM_STAR = 1_337_000n; // 1.337 NIGHT per claim
export const RETRY_MS = 15_000;
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_BODY_BYTES = 4_096;

export const NETWORKS: Record<NetworkId, NetworkDef> = {
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/// Change notifications, used by the worker to mirror state into the HTTP
/// process. Defaults are no-ops so the class is also usable in-process.
export interface FaucetWalletHooks {
  onState?: (state: Lifecycle, message: string) => void;
  onClaim?: (claim: Claim) => void;
}

export class FaucetWallet {
  #state: Lifecycle = 'starting';
  #message = 'Faucet wallet is starting…';
  session: LocalWalletSession | undefined;
  activeClaim: string | undefined;

  get state(): Lifecycle {
    return this.#state;
  }
  set state(value: Lifecycle) {
    this.#state = value;
    this.hooks.onState?.(this.#state, this.#message);
  }
  get message(): string {
    return this.#message;
  }
  set message(value: string) {
    this.#message = value;
    this.hooks.onState?.(this.#state, this.#message);
  }
  /// Resolves the idle wait in start(), so a wallet that could not recover
  /// from a rejected transfer is rebuilt from scratch instead of staying
  /// in error until someone restarts the service.
  private requestRestart: (() => void) | undefined;

  constructor(
    readonly network: NetworkDef,
    private readonly hooks: FaucetWalletHooks = {},
  ) {
    if (!network.enabled) {
      this.state = 'error';
      this.message = `${network.name} is unavailable until its indexer is ready.`;
    }
  }

  async start(): Promise<never> {
    for (;;) {
      try {
        await this.initialize();
        await new Promise<void>((resolve) => {
          this.requestRestart = resolve;
        });
        this.requestRestart = undefined;
        console.info(`[faucet:${this.network.networkId}] rebuilding the wallet after a failed recovery`);
        await this.session?.stop().catch(() => undefined);
        this.session = undefined;
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
    const session = await openNightfrostWallet(
      MNEMONIC,
      this.network,
      undefined,
      PROVING_SERVER_URL,
    );
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
    this.updateClaim(claim, { state: 'queued', message: 'Transfer queued…' });
    void this.send(claim, address);
  }

  private updateClaim(claim: Claim, patch: Partial<Pick<Claim, 'state' | 'message'>>): void {
    Object.assign(claim, patch);
    this.hooks.onClaim?.(claim);
  }

  private async send(claim: Claim, address: string): Promise<void> {
    try {
      this.updateClaim(claim, { state: 'sending' });
      const result = await this.session!.sendUnshielded(address, CLAIM_STAR, (stage) => {
        this.updateClaim(claim, { message: stage });
        console.info(`[faucet:${this.network.networkId}:${claim.id}] ${stage}`);
      });
      this.updateClaim(claim, { state: 'complete', message: result.hash || result.identifier });
    } catch (error) {
      this.updateClaim(claim, { state: 'failed', message: errorMessage(error) });
      console.error(`[faucet:${this.network.networkId}:${claim.id}]`, error);
      this.state = 'syncing';
      this.message = 'Faucet wallet is recovering from a rejected transaction…';
      try {
        await this.session!.resync();
        this.state = 'ready';
        this.message = 'Faucet is ready.';
        console.info(`[faucet:${this.network.networkId}] wallet resynced after failed transfer`);
      } catch (recoveryError) {
        this.state = 'syncing';
        this.message = `Wallet recovery failed (${errorMessage(recoveryError)}); rebuilding the wallet…`;
        console.error(`[faucet:${this.network.networkId}]`, this.message);
        this.requestRestart?.();
      }
    } finally {
      this.activeClaim = undefined;
    }
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
