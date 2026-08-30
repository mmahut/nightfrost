import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  CustomDustWallet,
  CustomShieldedWallet,
  CustomUnshieldedWallet,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  MidnightBech32m,
  PublicKey,
  Roles,
  SerializedTransaction,
  UnshieldedAddress,
  WalletEntrySchema,
  WalletFacade,
  createKeystore,
  mergeWalletEntries,
  type DefaultConfiguration,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk';
import { makeWasmProvingService } from '@midnightntwrk/wallet-sdk/capabilities/proving';
import {
  SubmissionEvent,
  type SubmissionService,
} from '@midnightntwrk/wallet-sdk/capabilities/submission';
import type { PendingTransactionsService } from '@midnightntwrk/wallet-sdk/capabilities/pendingTransactions';
import * as ShieldedV1 from '@midnightntwrk/wallet-sdk/shielded/v1';
import * as DustV1 from '@midnightntwrk/wallet-sdk/dust/v1';
import * as UnshieldedV1 from '@midnightntwrk/wallet-sdk/unshielded/v1';
import { DateTime, Effect, Either, Stream } from 'effect';
import { BehaviorSubject } from 'rxjs';
import { mnemonicToSeedSync } from '@scure/bip39';
import { validateMnemonic } from '@midnightntwrk/wallet-sdk-hd';
import { Buffer } from 'buffer';
import {
  ApiError,
  NightfrostApi,
  type ShieldedSyncUpdate as ApiShieldedSyncUpdate,
  type Tx,
  type TxStatus,
  type Utxo,
} from './api.ts';
import type { NetworkDef } from './networks.ts';

const POLL_INTERVAL_MS = 2_000;
const SUBMISSION_TIMEOUT_MS = 180_000;
const PROVING_MATERIAL_ROOT =
  typeof window === 'undefined'
    ? 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com'
    : '/proving-material';

function makeProvingKeyMaterialProvider() {
  const cache = new Map<string, Promise<Uint8Array>>();
  const material = (path: string): Promise<Uint8Array> => {
    const existing = cache.get(path);
    if (existing) return existing;
    console.info('[nf-material] fetch', path);
    // Without a deadline a stalled connection leaves the prover waiting
    // silently at 0% CPU until the SDK's own timeout kills the whole proof;
    // a named failure here is retryable and diagnosable.
    const request = fetch(PROVING_MATERIAL_ROOT + '/' + path, {
      signal: AbortSignal.timeout(120_000),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(
          'Could not load Midnight proving material ' + path + ' (HTTP ' + response.status + ').',
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      console.info('[nf-material] done', path, bytes.length, 'bytes');
      return bytes;
    });
    cache.set(path, request);
    request.catch(() => cache.delete(path));
    return request;
  };

  return {
    async lookupKey(keyLocation: string) {
      const path = {
        'midnight/zswap/spend': 'zswap/9/spend',
        'midnight/zswap/output': 'zswap/9/output',
        'midnight/zswap/sign': 'zswap/9/sign',
        'midnight/dust/spend': 'dust/9/spend',
      }[keyLocation];
      if (!path) return undefined;
      const [proverKey, verifierKey, ir] = await Promise.all([
        material(path + '.prover'),
        material(path + '.verifier'),
        material(path + '.bzkir'),
      ]);
      return { proverKey, verifierKey, ir };
    },
    getParams(k: number) {
      return material('bls_midnight_2p' + k);
    },
  };
}


export type SyncCore = 'shielded' | 'unshielded' | 'dust';

export interface SyncProgress {
  core: SyncCore;
  scanned: number;
  total: number;
}

type NightfrostConfiguration = DefaultConfiguration & {
  api: NightfrostApi;
  viewingKey: string;
  onProgress?: (progress: SyncProgress) => void;
  pollIntervalMs: number;
};

type UnshieldedTransactionUpdate = {
  kind: 'transaction';
  id: number;
  hash: string;
  protocolVersion: number;
  type: 'RegularTransaction' | 'SystemTransaction';
  identifiers: readonly string[];
  timestamp: Date;
  paidFees: bigint;
  estimatedFees: bigint;
  status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS';
  segments: readonly { id: number; success: boolean }[] | null;
  createdUtxos: readonly UnshieldedV1.UnshieldedState.UtxoWithMeta[];
  spentUtxos: readonly UnshieldedV1.UnshieldedState.UtxoWithMeta[];
};

type UnshieldedProgressUpdate = {
  kind: 'progress';
  appliedId: number;
  highestId: number;
};

type UnshieldedUpdate = UnshieldedTransactionUpdate | UnshieldedProgressUpdate;

type ShieldedUpdate = {
  updates: readonly ApiShieldedSyncUpdate[];
  secretKeys: ledger.ZswapSecretKeys;
  appliedThrough: number;
  highestId: number;
  protocolVersion: number;
};

type DustUpdate = {
  events: readonly {
    id: number;
    event: ledger.Event;
  }[];
  secretKey: ledger.DustSecretKey;
  appliedThrough: number;
  highestId: number;
  protocolVersion: number;
  timestamp: Date;
};

export interface SendResult {
  identifier: string;
  /** Indexed transaction hash; absent when the post-submit lookup failed. */
  hash?: string;
}

export interface DustStatus {
  balance: bigint;
  registeredUtxos: number;
  unregisteredUtxos: number;
}

export type TransactionStageReporter = (message: string) => void;

export interface LocalWalletSession {
  readonly wallet: WalletFacade;
  readonly addressHex: string;
  readonly address: string;
  readonly state: ReturnType<WalletFacade['state']>;
  readonly dustAddress: string;
  readonly ready: Promise<void>;
  dustStatus(): Promise<DustStatus>;
  registerForDustGeneration(onStage?: TransactionStageReporter): Promise<SendResult>;
  sendUnshielded(
    receiver: string,
    amount: bigint,
    onStage?: TransactionStageReporter,
  ): Promise<SendResult>;
  /**
   * Restart the wallet cores' background sync with the key material already
   * held by this tab. Resolves once every core reports a synced state again.
   */
  resync(): Promise<void>;
  stop(): Promise<void>;
}

function pollingStream<A>(
  poll: () => Promise<readonly A[]>,
  intervalMs: number,
  shouldPause: (items: readonly A[]) => boolean = () => true,
): Stream.Stream<A> {
  return Stream.async<A>((emit) => {
    let active = true;
    let synchronized = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;

    const sleep = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });

    void (async () => {
      while (active) {
        let pause = true;
        try {
          const items = await poll();
          for (const item of items) {
            if (!active) return;
            await emit.single(item);
          }
          synchronized = true;
          pause = shouldPause(items);
        } catch (error) {
          if (!synchronized) {
            await emit.die(error);
            return;
          }
          console.warn('Nightfrost wallet sync retrying after an API error', error);
        }
        if (active && pause) await sleep();
      }
    })();

    return Effect.sync(() => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
    });
  });
}

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Nightfrost returned malformed hex.');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function sdkIndex(rawId: number): number {
  return rawId + 1;
}

function sdkStatus(status: TxStatus): 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' {
  if (status === 'partial_success') return 'PARTIAL_SUCCESS';
  return status.toUpperCase() as 'SUCCESS' | 'FAILURE';
}

function walletUtxo(utxo: Utxo, fallbackTime: number): UnshieldedV1.UnshieldedState.UtxoWithMeta {
  return new UnshieldedV1.UnshieldedState.UtxoWithMeta({
    utxo: {
      value: BigInt(utxo.value),
      owner: utxo.owner as ledger.UserAddress,
      type: utxo.token_type as ledger.RawTokenType,
      intentHash: utxo.intent_hash as ledger.IntentHash,
      outputNo: utxo.output_index,
    },
    meta: {
      ctime: new Date((utxo.ctime ?? Math.floor(fallbackTime / 1_000)) * 1_000),
      registeredForDustGeneration: utxo.registered_for_dust_generation,
    },
  });
}

async function unshieldedTransaction(
  api: NightfrostApi,
  hash: string,
): Promise<UnshieldedTransactionUpdate> {
  const [tx, utxos] = await Promise.all([api.tx(hash), api.txUtxos(hash)]);
  return {
    kind: 'transaction',
    id: sdkIndex(tx.id),
    hash: tx.hash,
    protocolVersion: tx.protocol_version,
    type: tx.variant === 'System' ? 'SystemTransaction' : 'RegularTransaction',
    identifiers: tx.identifiers,
    timestamp: new Date(tx.block_time),
    paidFees: BigInt(tx.paid_fees),
    estimatedFees: BigInt(tx.estimated_fees),
    status: tx.variant === 'System' ? 'SUCCESS' : sdkStatus(tx.status),
    segments: tx.segments?.map(([id, success]) => ({ id, success })) ?? null,
    createdUtxos: utxos.outputs.map((utxo) => walletUtxo(utxo, tx.block_time)),
    spentUtxos: utxos.inputs.map((utxo) => walletUtxo(utxo, tx.block_time)),
  };
}

function makeUnshieldedSync(config: NightfrostConfiguration) {
  return {
    updates(state: UnshieldedV1.CoreWallet): Stream.Stream<UnshieldedUpdate> {
      let appliedId = Number(state.progress.appliedId);
      return pollingStream(async () => {
        const stats = await config.api.stats();
        const highestId = stats.total_transactions;
        let cursor: string | undefined;
        const hashes: string[] = [];

        do {
          const page = await config.api.addressTxsSince(
            state.publicKey.addressHex,
            appliedId,
            cursor,
          );
          hashes.push(...page.results);
          cursor = page.next_cursor ?? undefined;
        } while (cursor !== undefined);

        const updates: UnshieldedUpdate[] = [];
        for (const hash of hashes) {
          const update = await unshieldedTransaction(config.api, hash);
          if (update.id > appliedId) updates.push(update);
        }

        appliedId = Math.max(
          highestId,
          ...updates.filter((update) => update.kind === 'transaction').map((update) => update.id),
          appliedId,
        );
        config.onProgress?.({ core: 'unshielded', scanned: appliedId, total: highestId });
        updates.push({ kind: 'progress', appliedId, highestId: appliedId });
        return updates;
      }, config.pollIntervalMs);
    },
  };
}

function makeUnshieldedCapability() {
  return {
    applyUpdate(state: UnshieldedV1.CoreWallet, update: UnshieldedUpdate) {
      if (update.kind === 'progress') {
        return Either.right(
          UnshieldedV1.CoreWallet.updateProgress(state, {
            appliedId: BigInt(update.appliedId),
            highestTransactionId: BigInt(update.highestId),
            isConnected: true,
          }),
        );
      }

      const payload: UnshieldedV1.UnshieldedState.UnshieldedUpdate = {
        createdUtxos: update.createdUtxos,
        spentUtxos: update.spentUtxos,
        status: update.status,
      };
      const result =
        update.status === 'FAILURE'
          ? UnshieldedV1.CoreWallet.applyFailedUpdate(state, payload)
          : UnshieldedV1.CoreWallet.applyUpdate(state, payload);
      return Either.map(result, (wallet) =>
        UnshieldedV1.CoreWallet.updateProgress(wallet, {
          appliedId: BigInt(update.id),
          isConnected: true,
        }),
      );
    },
  };
}

function makeShieldedSync(config: NightfrostConfiguration) {
  return {
    updates(
      state: ShieldedV1.CoreWallet,
      secretKeys: ledger.ZswapSecretKeys,
    ): Stream.Stream<ShieldedUpdate> {
      let appliedThrough = Number(state.progress.appliedIndex);
      let protocolVersion = Number(state.protocolVersion);
      return pollingStream(
        async () => {
          const response = await config.api.walletShieldedSync(config.viewingKey, appliedThrough);
          const result = response.results;
          appliedThrough = result.applied_through;
          protocolVersion = result.updates.at(-1)?.protocol_version ?? protocolVersion;
          config.onProgress?.({
            core: 'shielded',
            scanned: appliedThrough,
            total: result.highest_index,
          });
          return [
            {
              updates: result.updates,
              secretKeys,
              appliedThrough,
              highestId: result.highest_index,
              protocolVersion,
            },
          ];
        },
        config.pollIntervalMs,
        (updates) => {
          const latest = updates.at(-1);
          return latest === undefined || latest.appliedThrough >= latest.highestId;
        },
      );
    },
  };
}

function makeShieldedCapability() {
  return {
    applyUpdate(
      state: ShieldedV1.CoreWallet,
      update: ShieldedUpdate,
    ): [ShieldedV1.CoreWallet, ShieldedV1.Sync.ChangesResult] {
      let wallet = state;
      const changes: ledger.ZswapStateChanges[] = [];
      let protocolVersion = update.protocolVersion;

      for (const item of update.updates) {
        if (item.to_index <= Number(wallet.progress.appliedIndex)) continue;
        protocolVersion = item.protocol_version;
        if (item.type === 'collapsed') {
          wallet = ShieldedV1.CoreWallet.applyCollapsedUpdate(
            wallet,
            ledger.MerkleTreeCollapsedUpdate.deserialize(hexBytes(item.update)),
          );
          continue;
        }
        const [next, itemChanges] = ShieldedV1.CoreWallet.replayEventsWithChanges(
          wallet,
          update.secretKeys,
          item.events.map((event) => ledger.Event.deserialize(hexBytes(event.raw))),
        );
        wallet = next;
        changes.push(...itemChanges);
      }

      const highest = BigInt(update.highestId);
      return [
        ShieldedV1.CoreWallet.updateProgress(wallet, {
          appliedIndex: BigInt(update.appliedThrough),
          highestRelevantWalletIndex: highest,
          highestIndex: highest,
          highestRelevantIndex: highest,
          isConnected: true,
        }),
        { changes, protocolVersion },
      ];
    },
  };
}

function makeDustSync(config: NightfrostConfiguration) {
  return {
    updates(state: DustV1.CoreWallet, secretKey: ledger.DustSecretKey): Stream.Stream<DustUpdate> {
      let appliedThrough = Number(state.progress.appliedIndex);
      return pollingStream(
        async () => {
          const [response, blockData] = await Promise.all([
            config.api.walletDustSync(appliedThrough),
            config.api.ledgerParameters(),
          ]);
          appliedThrough = response.results.scanned_through;
          config.onProgress?.({
            core: 'dust',
            scanned: appliedThrough,
            total: response.results.highest_event_id,
          });
          return [
            {
              events: response.results.events.map((event) => ({
                id: sdkIndex(event.id),
                event: ledger.Event.deserialize(hexBytes(event.raw)),
              })),
              secretKey,
              appliedThrough,
              highestId: response.results.highest_event_id,
              protocolVersion:
                response.results.events.at(-1)?.protocol_version ?? blockData.protocol_version,
              timestamp: new Date(blockData.block_time),
            },
          ];
        },
        config.pollIntervalMs,
        (updates) => {
          const latest = updates.at(-1);
          return latest === undefined || latest.appliedThrough >= latest.highestId;
        },
      );
    },
    blockData() {
      return Effect.tryPromise({
        try: async () => {
          const data = await config.api.ledgerParameters();
          return {
            hash: data.block_hash,
            height: data.block_height,
            ledgerParameters: ledger.LedgerParameters.deserialize(hexBytes(data.ledger_parameters)),
            timestamp: new Date(data.block_time),
          };
        },
        catch: (cause) =>
          new DustV1.WalletError.OtherWalletError({
            message: 'Unable to fetch ledger parameters from Nightfrost',
            cause,
          }),
      });
    },
  };
}

function makeDustCapability() {
  return {
    applyUpdate(
      state: DustV1.CoreWallet,
      update: DustUpdate,
    ): [DustV1.CoreWallet, DustV1.SyncService.ChangesResult] {
      const fresh = update.events.filter((event) => BigInt(event.id) > state.progress.appliedIndex);
      const [wallet, changes] =
        fresh.length === 0
          ? [state, [] as ledger.DustStateChanges[]]
          : DustV1.CoreWallet.applyEventsWithChanges(
              state,
              update.secretKey,
              fresh.map((event) => event.event),
              update.timestamp,
            );
      const highest = BigInt(update.highestId);
      return [
        DustV1.CoreWallet.updateProgress(wallet, {
          appliedIndex: BigInt(update.appliedThrough),
          highestRelevantWalletIndex: highest,
          highestIndex: highest,
          highestRelevantIndex: highest,
          isConnected: true,
        }),
        { changes, protocolVersion: update.protocolVersion },
      ];
    },
  };
}

function makeTransactionHistory(config: NightfrostConfiguration, kind: 'shielded' | 'dust') {
  const getTransactionDetails = (hash: string) =>
    Effect.tryPromise({
      try: async () => {
        const tx = await config.api.tx(hash);
        return {
          hash: tx.hash,
          timestamp: tx.block_time,
          status: sdkStatus(tx.status),
        };
      },
      catch: (cause) => {
        const message = 'Unable to fetch ' + kind + ' transaction metadata from Nightfrost';
        return kind === 'shielded'
          ? new ShieldedV1.WalletError.TransactionHistoryError({ message, cause })
          : new DustV1.WalletError.TransactionHistoryError({ message, cause });
      },
    });

  return {
    put: () => Effect.void,
    getTransactionDetails,
  };
}

function sameTransaction(a: ledger.FinalizedTransaction, b: ledger.FinalizedTransaction): boolean {
  const ids = new Set(a.identifiers());
  return b.identifiers().some((id) => ids.has(id));
}

function makePendingTransactionsService(
  config: NightfrostConfiguration,
): PendingTransactionsService<ledger.FinalizedTransaction> {
  type PendingItem = {
    tx: ledger.FinalizedTransaction;
    creationTime: DateTime.Utc;
    result?: {
      status: 'FAILURE' | 'PARTIAL_SUCCESS';
      segments: readonly { id: number; success: boolean }[];
    };
  };
  type PendingState = { all: readonly PendingItem[] };

  const subject = new BehaviorSubject<PendingState>({ all: [] });
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const next: PendingItem[] = [];
      for (const item of subject.value.all) {
        try {
          const tx = await config.api.txByIdentifier(item.tx.identifiers()[0]);
          if (tx.status === 'success') continue;
          next.push({
            ...item,
            result: {
              status: sdkStatus(tx.status) as 'FAILURE' | 'PARTIAL_SUCCESS',
              segments: tx.segments?.map(([id, success]) => ({ id, success })) ?? [],
            },
          });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          next.push(item);
        }
      }
      subject.next({ all: next });
    } catch (error) {
      console.warn('Nightfrost pending transaction check failed', error);
    } finally {
      checking = false;
    }
  };

  return {
    start: async () => {
      if (timer !== undefined) return;
      void check();
      timer = setInterval(() => void check(), config.pollIntervalMs);
    },
    stop: async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      subject.complete();
    },
    state: () => subject.asObservable(),
    addPendingTransaction: async (tx) => {
      if (subject.value.all.some((item) => sameTransaction(item.tx, tx))) return;
      subject.next({
        all: [...subject.value.all, { tx, creationTime: DateTime.unsafeMake(Date.now()) }],
      });
    },
    clear: async (tx) => {
      subject.next({
        all: subject.value.all.filter((item) => !sameTransaction(item.tx, tx)),
      });
    },
  };
}

function waitForIndexedTransaction(
  api: NightfrostApi,
  identifier: string,
  timeoutMs: number,
): Promise<Tx> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const tx = await api.txByIdentifier(identifier);
        resolve(tx);
      } catch (error) {
        const retryable =
          error instanceof ApiError &&
          (error.status === 0 || error.status === 404 || error.status === 429 || error.status >= 500);
        if (retryable && Date.now() < deadline) {
          setTimeout(() => void check(), POLL_INTERVAL_MS);
          return;
        }
        if (retryable) {
          reject(
            new Error(
              'Transaction was submitted, but Nightfrost confirmation timed out. Check the wallet history before retrying.',
              { cause: error },
            ),
          );
          return;
        }
        reject(error);
      }
    };
    void check();
  });
}

function makeSubmissionService(
  config: NightfrostConfiguration,
): SubmissionService<ledger.FinalizedTransaction> {
  const submit = async (
    transaction: ledger.FinalizedTransaction,
    waitFor: 'Submitted' | 'InBlock' | 'Finalized' = 'InBlock',
  ) => {
    const serialized = SerializedTransaction.from(transaction);
    const submitted = await config.api.submit(serialized);
    if (waitFor === 'Submitted') {
      return SubmissionEvent.Submitted({
        tx: serialized,
        txHash: submitted.tx_hash,
      });
    }

    const identifier = transaction.identifiers().at(-1);
    if (identifier === undefined) throw new Error('Finalized transaction has no identifier.');
    const indexed = await waitForIndexedTransaction(config.api, identifier, SUBMISSION_TIMEOUT_MS);
    const blockEvent = {
      tx: serialized,
      txHash: submitted.tx_hash,
      blockHash: indexed.block_hash,
      blockHeight: BigInt(indexed.block_height),
    };
    return waitFor === 'Finalized'
      ? SubmissionEvent.Finalized(blockEvent)
      : SubmissionEvent.InBlock(blockEvent);
  };

  return {
    submitTransaction:
      submit as SubmissionService<ledger.FinalizedTransaction>['submitTransaction'],
    close: async () => undefined,
  };
}

function walletFactories(config: NightfrostConfiguration) {
  const ShieldedWallet = CustomShieldedWallet(
    config,
    new ShieldedV1.V1Builder()
      .withDefaultTransactionType()
      .withSync(makeShieldedSync, makeShieldedCapability)
      .withSerializationDefaults()
      .withTransactingDefaults()
      .withCoinsAndBalancesDefaults()
      .withTransactionHistory(() => makeTransactionHistory(config, 'shielded'))
      .withKeysDefaults()
      .withCoinSelectionDefaults(),
  );

  const DustWallet = CustomDustWallet(
    config,
    new DustV1.V1Builder()
      .withDefaultTransactionType()
      .withSync(makeDustSync, makeDustCapability)
      .withSerializationDefaults()
      .withTransactingDefaults()
      .withCoinsAndBalancesDefaults()
      .withTransactionHistory(() => makeTransactionHistory(config, 'dust'))
      .withKeysDefaults()
      .withCoinSelectionDefaults(),
  );

  const UnshieldedWallet = CustomUnshieldedWallet(
    config,
    new UnshieldedV1.V1Builder()
      .withSync(makeUnshieldedSync, makeUnshieldedCapability)
      .withSerializationDefaults()
      .withTransactingDefaults()
      .withCoinsAndBalancesDefaults()
      .withTransactionHistory(() => ({ put: () => Effect.void }))
      .withKeysDefaults()
      .withCoinSelectionDefaults(),
  );

  return { ShieldedWallet, DustWallet, UnshieldedWallet };
}

function parseRecipient(input: string, networkId: string): UnshieldedAddress {
  const value = input.trim();
  if (/^(?:0x)?[0-9a-f]{64}$/i.test(value)) {
    return new UnshieldedAddress(Buffer.from(value.replace(/^0x/i, ''), 'hex'));
  }
  return MidnightBech32m.parse(value).decode(UnshieldedAddress, networkId);
}

export async function openNightfrostWallet(
  words: string,
  network: NetworkDef,
  onProgress?: (progress: SyncProgress) => void,
): Promise<LocalWalletSession> {
  const mnemonic = words.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Enter a valid English BIP39 recovery phrase.');
  }

  const api = new NightfrostApi(network);
  // Submission already waited for the transaction to be indexed, so the hash
  // is resolvable immediately; treat a failed lookup as cosmetic (the UI
  // falls back to showing the identifier).
  const lookupTxHash = (identifier: string): Promise<string | undefined> =>
    api
      .txByIdentifier(identifier)
      .then((tx) => tx.hash)
      .catch(() => undefined);
  const blockData = await api.ledgerParameters();
  const ledgerParameters = ledger.LedgerParameters.deserialize(
    hexBytes(blockData.ledger_parameters),
  );

  const seed = mnemonicToSeedSync(mnemonic);
  const hdResult = HDWallet.fromSeed(seed);
  if (hdResult.type !== 'seedOk') {
    seed.fill(0);
    throw new Error('The recovery phrase could not initialize a Midnight HD wallet.');
  }

  const derived = hdResult.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  hdResult.hdWallet.clear();
  seed.fill(0);
  if (derived.type !== 'keysDerived') {
    throw new Error('The Midnight wallet keys could not be derived.');
  }

  const unshieldedSeed = derived.keys[Roles.NightExternal];
  const shieldedKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const encryptionKey = shieldedKeys.encryptionSecretKey;
  const viewingKeyBytes = encryptionKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
  const viewingKey = Buffer.from(viewingKeyBytes).toString('hex');
  viewingKeyBytes.fill(0);
  // The getter is a live handle owned by shieldedKeys; shieldedKeys.clear()
  // clears it when the wallet session stops.
  derived.keys[Roles.Zswap].fill(0);
  derived.keys[Roles.Dust].fill(0);
  const keystore: UnshieldedKeystore = createKeystore(unshieldedSeed, network.networkId);
  const txHistoryStorage = new InMemoryTransactionHistoryStorage(
    WalletEntrySchema,
    mergeWalletEntries,
  );
  const configuration: NightfrostConfiguration = {
    networkId: network.networkId,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(network.apiUrl),
    indexerClientConnection: { indexerHttpUrl: network.apiUrl },
    txHistoryStorage,
    api,
    viewingKey,
    onProgress,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
  const factories = walletFactories(configuration);

  let wallet: WalletFacade;
  try {
    wallet = await WalletFacade.init({
      configuration,
      shielded: () => factories.ShieldedWallet.startWithSecretKeys(shieldedKeys),
      unshielded: () =>
        factories.UnshieldedWallet.startWithPublicKey(PublicKey.fromKeyStore(keystore)),
      dust: () => factories.DustWallet.startWithSecretKey(dustKey, ledgerParameters.dust),
      provingService: () =>
        makeWasmProvingService({ keyMaterialProvider: makeProvingKeyMaterialProvider() }),
      submissionService: () => makeSubmissionService(configuration),
      pendingTransactionsService: () => makePendingTransactionsService(configuration),
    });
  } catch (error) {
    shieldedKeys.clear();
    dustKey.clear();
    unshieldedSeed.fill(0);
    throw error;
  }

  try {
    await wallet.start(shieldedKeys, dustKey);
  } catch (error) {
    await wallet.stop().catch(() => undefined);
    shieldedKeys.clear();
    dustKey.clear();
    unshieldedSeed.fill(0);
    throw error;
  }

  const ready = wallet.waitForSyncedState().then(() => undefined);
  void ready.catch(() => undefined);

  const dustAddress = MidnightBech32m.encode(
    network.networkId,
    await wallet.dust.getAddress(),
  ).asString();
  const availableNightUtxos = async () => {
    const state = await wallet.unshielded.waitForSyncedState();
    const native = ledger.unshieldedToken().raw;
    return state.availableCoins.filter((coin) => coin.utxo.type === native);
  };

  return {
    wallet,
    addressHex: keystore.getAddress(),
    address: keystore.getBech32Address().asString(),
    state: wallet.state(),
    dustAddress,
    ready,
    dustStatus: async () => {
      const [nightUtxos, dustState] = await Promise.all([
        availableNightUtxos(),
        wallet.dust.waitForSyncedState(),
      ]);
      return {
        balance: dustState.balance(new Date()),
        registeredUtxos: nightUtxos.filter((coin) => coin.meta.registeredForDustGeneration).length,
        unregisteredUtxos: nightUtxos.filter((coin) => !coin.meta.registeredForDustGeneration)
          .length,
      };
    },
    registerForDustGeneration: async (onStage) => {
      onStage?.('Checking available NIGHT outputs…');
      const nightUtxos = (await availableNightUtxos()).filter(
        (coin) => !coin.meta.registeredForDustGeneration,
      );
      if (nightUtxos.length === 0) {
        throw new Error(
          'No unregistered NIGHT UTXO is available. Fund this address and wait for wallet sync first.',
        );
      }
      onStage?.('Estimating the DUST registration fee…');
      const { fee } = await wallet.estimateRegistration(nightUtxos);
      onStage?.('Waiting until the NIGHT output has generated ' + fee + ' DUST specks…');
      await wallet.waitForGeneratedDust(nightUtxos, fee, { timeoutMs: 15 * 60 * 1_000 });
      onStage?.('Building and signing the DUST registration…');
      const recipe = await wallet.registerNightUtxosForDustGeneration(
        nightUtxos,
        keystore.getPublicKey(),
        (payload) => keystore.signData(payload),
      );
      onStage?.('Generating the zero-knowledge proof locally…');
      const finalized = await wallet.finalizeRecipe(recipe);
      onStage?.('Submitting the registration and waiting for confirmation…');
      const identifier = await wallet.submitTransaction(finalized);
      return { identifier, hash: await lookupTxHash(identifier) };
    },
    sendUnshielded: async (receiver, amount, onStage) => {
      onStage?.('Selecting NIGHT and DUST inputs…');
      if (amount <= 0n) throw new Error('Amount must be greater than zero.');
      const recipe = await wallet.transferTransaction(
        [
          {
            type: 'unshielded',
            outputs: [
              {
                amount,
                receiverAddress: parseRecipient(receiver, network.networkId),
                type: ledger.unshieldedToken().raw,
              },
            ],
          },
        ],
        { shieldedSecretKeys: shieldedKeys, dustSecretKey: dustKey },
        { ttl: new Date(Date.now() + 30 * 60 * 1_000), payFees: true },
      );
      onStage?.('Signing the transaction locally…');
      const signed = await wallet.signRecipe(recipe, (payload) => keystore.signData(payload));
      onStage?.('Generating the zero-knowledge proof locally…');
      const finalized = await wallet.finalizeRecipe(signed);
      onStage?.('Submitting the transaction and waiting for confirmation…');
      const identifier = await wallet.submitTransaction(finalized);
      return { identifier, hash: await lookupTxHash(identifier) };
    },
    resync: async () => {
      // Key material is still held by this tab (it's only cleared in stop()),
      // so the cores can relaunch their background sync in place. The facade's
      // state observables survive the restart, which keeps `ready` and every
      // existing subscription working.
      await wallet.stop().catch((error) => {
        console.warn('Nightfrost resync: stopping the stuck cores failed', error);
      });
      await wallet.start(shieldedKeys, dustKey);
      await wallet.waitForSyncedState();
    },
    stop: async () => {
      await wallet.stop();
      shieldedKeys.clear();
      dustKey.clear();
      unshieldedSeed.fill(0);
    },
  };
}
