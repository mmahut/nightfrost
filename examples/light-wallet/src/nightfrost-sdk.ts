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
  type LedgerEvent,
  type Tx,
  type TxStatus,
  type Utxo,
} from './api.ts';
import type { NetworkDef } from './networks.ts';

const POLL_INTERVAL_MS = 2_000;
const SUBMISSION_TIMEOUT_MS = 180_000;

type NightfrostConfiguration = DefaultConfiguration & {
  api: NightfrostApi;
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
  events: readonly {
    id: number;
    protocolVersion: number;
    event: ledger.Event;
  }[];
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
}

export interface LocalWalletSession {
  readonly wallet: WalletFacade;
  readonly addressHex: string;
  readonly address: string;
  readonly state: ReturnType<WalletFacade['state']>;
  sendUnshielded(receiver: string, amount: bigint): Promise<SendResult>;
  stop(): Promise<void>;
}

function pollingStream<A>(poll: () => Promise<readonly A[]>, intervalMs: number): Stream.Stream<A> {
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
        try {
          for (const item of await poll()) {
            if (!active) return;
            await emit.single(item);
          }
          synchronized = true;
        } catch (error) {
          if (!synchronized) {
            await emit.die(error);
            return;
          }
          console.warn('Nightfrost wallet sync retrying after an API error', error);
        }
        if (active) await sleep();
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

async function unshieldedTransaction(api: NightfrostApi, hash: string): Promise<UnshieldedTransactionUpdate> {
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
          const page = await config.api.addressTxsSince(state.publicKey.addressHex, appliedId, cursor);
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
          ...updates
            .filter((update) => update.kind === 'transaction')
            .map((update) => update.id),
          appliedId,
        );
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

async function allLedgerEvents(api: NightfrostApi, from: number): Promise<{
  events: LedgerEvent[];
  highestId: number;
  protocolVersion: number;
  timestamp: Date;
}> {
  const [stats, blockData] = await Promise.all([api.stats(), api.ledgerParameters()]);
  let cursor: string | undefined;
  const events: LedgerEvent[] = [];

  do {
    const page = await api.ledgerEvents(from, cursor);
    events.push(...page.results);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);

  return {
    events,
    highestId: Math.max(stats.total_ledger_events, ...events.map((event) => sdkIndex(event.id))),
    protocolVersion: events.at(-1)?.protocol_version ?? blockData.protocol_version,
    timestamp: new Date(blockData.block_time),
  };
}

function makeShieldedSync(config: NightfrostConfiguration) {
  return {
    updates(
      state: ShieldedV1.CoreWallet,
      secretKeys: ledger.ZswapSecretKeys,
    ): Stream.Stream<ShieldedUpdate> {
      let appliedThrough = Number(state.progress.appliedIndex);
      return pollingStream(async () => {
        const batch = await allLedgerEvents(config.api, appliedThrough);
        appliedThrough = batch.highestId;
        return [
          {
            events: batch.events
              .filter((event) => event.grouping === 'Zswap')
              .map((event) => ({
                id: sdkIndex(event.id),
                protocolVersion: event.protocol_version,
                event: ledger.Event.deserialize(hexBytes(event.raw)),
              })),
            secretKeys,
            appliedThrough,
            highestId: batch.highestId,
            protocolVersion: batch.protocolVersion,
          },
        ];
      }, config.pollIntervalMs);
    },
  };
}

function makeShieldedCapability() {
  return {
    applyUpdate(
      state: ShieldedV1.CoreWallet,
      update: ShieldedUpdate,
    ): [ShieldedV1.CoreWallet, ShieldedV1.Sync.ChangesResult] {
      const fresh = update.events.filter((event) => BigInt(event.id) > state.progress.appliedIndex);
      const [wallet, changes] =
        fresh.length === 0
          ? [state, [] as ledger.ZswapStateChanges[]]
          : ShieldedV1.CoreWallet.replayEventsWithChanges(
              state,
              update.secretKeys,
              fresh.map((event) => event.event),
            );
      return [
        ShieldedV1.CoreWallet.updateProgress(wallet, {
          appliedIndex: BigInt(update.appliedThrough),
          highestRelevantWalletIndex: BigInt(update.highestId),
          isConnected: true,
        }),
        {
          changes,
          protocolVersion: fresh.at(-1)?.protocolVersion ?? update.protocolVersion,
        },
      ];
    },
  };
}

function makeDustSync(config: NightfrostConfiguration) {
  return {
    updates(state: DustV1.CoreWallet, secretKey: ledger.DustSecretKey): Stream.Stream<DustUpdate> {
      let appliedThrough = Number(state.progress.appliedIndex);
      return pollingStream(async () => {
        const batch = await allLedgerEvents(config.api, appliedThrough);
        appliedThrough = batch.highestId;
        return [
          {
            events: batch.events
              .filter((event) => event.grouping === 'Dust')
              .map((event) => ({
                id: sdkIndex(event.id),
                event: ledger.Event.deserialize(hexBytes(event.raw)),
              })),
            secretKey,
            appliedThrough,
            highestId: batch.highestId,
            protocolVersion: batch.protocolVersion,
            timestamp: batch.timestamp,
          },
        ];
      }, config.pollIntervalMs);
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
      return [
        DustV1.CoreWallet.updateProgress(wallet, {
          appliedIndex: BigInt(update.appliedThrough),
          highestRelevantWalletIndex: BigInt(update.highestId),
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
        if (error instanceof ApiError && error.status === 404 && Date.now() < deadline) {
          setTimeout(() => void check(), POLL_INTERVAL_MS);
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
    submitTransaction: submit as SubmissionService<ledger.FinalizedTransaction>['submitTransaction'],
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
): Promise<LocalWalletSession> {
  const mnemonic = words.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Enter a valid English BIP39 recovery phrase.');
  }

  const api = new NightfrostApi(network);
  const [blockData] = await Promise.all([
    api.ledgerParameters(),
    api.stats(),
    api.ledgerEvents(0),
  ]);
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
  derived.keys[Roles.Zswap].fill(0);
  derived.keys[Roles.Dust].fill(0);
  const keystore: UnshieldedKeystore = createKeystore(unshieldedSeed, network.networkId);
  const txHistoryStorage = new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
  const configuration: NightfrostConfiguration = {
    networkId: network.networkId,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(network.apiUrl),
    indexerClientConnection: { indexerHttpUrl: network.apiUrl },
    txHistoryStorage,
    api,
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
      provingService: () => makeWasmProvingService(),
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
    await wallet.waitForSyncedState();
  } catch (error) {
    await wallet.stop().catch(() => undefined);
    shieldedKeys.clear();
    dustKey.clear();
    unshieldedSeed.fill(0);
    throw error;
  }

  return {
    wallet,
    addressHex: keystore.getAddress(),
    address: keystore.getBech32Address().asString(),
    state: wallet.state(),
    sendUnshielded: async (receiver, amount) => {
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
      const signed = await wallet.signRecipe(recipe, (payload) => keystore.signData(payload));
      const finalized = await wallet.finalizeRecipe(signed);
      const identifier = await wallet.submitTransaction(finalized);
      return { identifier };
    },
    stop: async () => {
      await wallet.stop();
      shieldedKeys.clear();
      dustKey.clear();
      unshieldedSeed.fill(0);
    },
  };
}
