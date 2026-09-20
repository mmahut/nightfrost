// The chain-follow pipeline: streams finalized blocks from the node, replays
// every transaction through the ledger facade, verifies the recomputed roots
// against the node's (the correctness oracle — proof verification is off),
// and writes all derived entities in one atomic fjall batch per block.
// Reshaped from midnight-indexer's chain-indexer/src/application.rs.

use crate::{
    domain::{Block, BlockRef, Transaction},
    subxt_node::SubxtNode,
};
use anyhow::{Context, bail};
use async_stream::stream;
use futures::{Stream, StreamExt, TryStreamExt, future::ok};
use sha2::{Digest, Sha256};

use nightfrost_core::metrics as m;
use nightfrost_core::{
    domain::{
        LedgerEventAttributes, LedgerVersion, NetworkId, TransactionResult, TransactionVariant,
        UnshieldedUtxo,
        dust::DustRegistrationEvent,
        ledger::{ContractState, Error as LedgerError, LedgerState},
    },
    store::{
        self, BlockRecord, CnightRegistrationRecord, ContractActionRecord, ContractRecord,
        DustGenerationRecord, EventRecord, LedgerStateWindow, Store, TxRecord, meta_keys,
        prefixed_u64_key, utxo_key,
    },
};
use std::{
    collections::HashMap,
    future::ready,
    pin::pin,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tokio::{task, time::sleep};

/// Amount, in milliseconds, by which the first regular transaction's dust-validity
/// `tblock` is bumped ahead of block time. The node validates mempool transactions
/// against a `tblock` bumped `slot_duration_secs + skipped_slots_margin` (one slot
/// each, two slots by default) ahead of the PARENT block time and caches that
/// well-formed result; at inclusion only the first regular transaction still hits
/// the cache. Midnight slots are 6s; timestamps are milliseconds.
const MEMPOOL_TBLOCK_BUMP_MILLIS: u64 = 2 * 6_000;

const BLOCKS_BUFFER: usize = 32;
const CAUGHT_UP_MAX_DISTANCE: u64 = 10;
const GC_BOUND: Duration = Duration::from_millis(200);
/// During catch-up the gc sweep runs every this many blocks instead of every
/// block; see the comment at the call site.
const CATCH_UP_GC_INTERVAL: u64 = 16;
const LEDGER_STATE_RETENTION: usize = 32;
const PROGRESS_LOG_INTERVAL: u64 = 1_000;

/// If no block has been successfully indexed for this long, the pipeline is
/// considered stalled and the process exits for systemd to restart it. Real
/// per-block work (including catch-up chunk fetches) always completes in
/// well under a minute even under heavy contention; this only fires on a
/// genuine stall. One real cause seen in production: fjall's write-halt
/// backoff (a plain blocking sleep loop waiting for background compaction
/// to free up journal space) can spin forever if compaction never catches
/// up, silently wedging the whole indexing task with no further logging
/// (the same task also owns the node-stream recovery/resubscribe logic, so
/// a stuck write blocks that too, indefinitely). A restart consistently
/// clears it.
const WATCHDOG_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const STALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub async fn run(
    store: Arc<Store>,
    node: SubxtNode,
    network_id: NetworkId,
    highest_block_on_node: store::NodeTipHeight,
) -> anyhow::Result<()> {
    // A reused data directory must belong to this chain; anything else would
    // fail later with a confusing parent-hash mismatch loop.
    if let Some(stored) = store
        .meta
        .get(meta_keys::GENESIS_HASH)
        .context("read genesis hash")?
    {
        let node_genesis = node.genesis_hash();
        if stored.as_ref() != node_genesis {
            bail!(
                "data directory belongs to a different chain: stored genesis {}, node genesis {}",
                const_hex::encode(stored.as_ref()),
                const_hex::encode(node_genesis),
            );
        }
    }

    let last_height = store.last_indexed_height().context("read last height")?;
    let resume_from = match last_height {
        Some(height) => {
            let record = store
                .block(height)?
                .context("last indexed block record missing")?;
            Some(BlockRef {
                hash: record.hash.into(),
                height,
            })
        }
        None => None,
    };
    tracing::info!(?last_height, "starting indexing");

    // Seed the parent-block timestamp from the stored tip so the first block after
    // a restart bumps its first regular transaction's tblock off the true parent
    // block time (0 keeps the genesis behavior).
    let mut parent_block_timestamp = store.tip_timestamp()?.unwrap_or(0);

    // Load or initialize the ledger state from the retention window, repairing
    // under-counted gc roots first (idempotent) and skipping keys whose roots are
    // no longer persisted, exactly like the official chain-indexer.
    let mut window = store.ledger_state_window()?;
    let repair = LedgerState::repair_root_counts(
        window
            .0
            .iter()
            .map(|(key, version)| (key, LedgerVersion::from(*version))),
    )
    .context("repair ledger state root counts")?;
    tracing::info!(?repair, "ledger state gc root counts checked");

    let persisted = LedgerState::persisted_root_hashes();
    window.0.retain(|(key, version)| {
        LedgerState::root_hash_bytes(key, LedgerVersion::from(*version))
            .map(|hash| persisted.contains(&hash))
            .unwrap_or(false)
    });

    let mut ledger_state = match window.0.last() {
        Some((key, version)) => LedgerState::load(key, LedgerVersion::from(*version))
            .context("load ledger state from retention window")?,
        None if resume_from.is_some() => {
            bail!("blocks are indexed but no loadable ledger state root remains")
        }
        None => LedgerState::new(network_id.clone(), LedgerVersion::OLDEST)
            .context("create ledger state")?,
    };

    // Last time a block was successfully indexed; watched below to detect a
    // stalled pipeline.
    let last_progress = Arc::new(RwLock::new(Instant::now()));

    // Watch the node's finalized tip for caught-up/sync-status reporting.
    let watcher_node = node.clone();
    let watcher_highest = highest_block_on_node.clone();
    let mut highest_task = task::spawn(async move {
        let highest_blocks = watcher_node
            .highest_blocks()
            .await
            .context("subscribe to highest blocks")?;
        highest_blocks
            .try_for_each(|block_ref| {
                *watcher_highest.write().expect("lock highest block") = Some(block_ref.height);
                ok(())
            })
            .await
            .context("highest blocks stream failed")?;
        Ok::<_, anyhow::Error>(())
    });

    let watchdog_progress = last_progress.clone();
    let watchdog_task = task::spawn(async move {
        loop {
            sleep(WATCHDOG_CHECK_INTERVAL).await;
            let elapsed = watchdog_progress
                .read()
                .expect("lock last progress")
                .elapsed();
            if elapsed > STALL_TIMEOUT {
                // A normal `return Err(..)` here would go through the async
                // runtime's ordinary error propagation and shutdown, which
                // waits for every outstanding blocking-pool thread to finish
                // naturally before the process can exit — including the one
                // permanently wedged in index_block's task::block_in_place
                // call, which is the exact failure this watchdog exists to
                // route around. That combination doesn't hang indexing
                // anymore, it hangs in shutdown instead: same symptom
                // (unreachable, never recovers), confirmed live by a stack
                // sample showing the main thread parked in
                // BlockingPool::shutdown. Only an immediate, unconditional
                // process exit, bypassing graceful async teardown entirely,
                // actually terminates the process here.
                tracing::error!(
                    ?elapsed,
                    ?STALL_TIMEOUT,
                    "indexing pipeline stalled; exiting immediately so systemd restarts it"
                );
                std::process::exit(1);
            }
        }
    });

    let mut index_task = task::spawn(async move {
        let mut ids = Counters::load(&store)?;
        let genesis_node = node.clone();
        let blocks = node_blocks(resume_from, node)
            .map(ready)
            .buffered(BLOCKS_BUFFER);
        let mut blocks = pin!(blocks);

        let mut stages = StageTimes::default();
        loop {
            let stage_start = Instant::now();
            let block = blocks
                .try_next()
                .await
                .context("get next block from node")?
                .context("finalized block stream ended")?;
            stages.fetch += m::stage(&m::STAGE_FETCH_NANOS, stage_start.elapsed());

            // The genesis ledger state comes from the node's system properties.
            let genesis_ledger_state = if block.height == 0 {
                Some(
                    genesis_node
                        .fetch_genesis_ledger_state()
                        .await
                        .context("fetch genesis ledger state")?,
                )
            } else {
                None
            };

            let height = block.height;
            let hash = block.hash;
            let block_timestamp_ms = block.timestamp;
            let (next_state, new_key) = task::block_in_place(|| {
                index_block(
                    &store,
                    block,
                    genesis_ledger_state,
                    ledger_state,
                    &network_id,
                    &mut parent_block_timestamp,
                    &window,
                    &mut ids,
                    &mut stages,
                )
            })
            .with_context(|| format!("index block {hash} at height {height}"))?;
            ledger_state = next_state;
            *last_progress.write().expect("lock last progress") = Instant::now();

            // Unpersist keys that aged out of the retention window (the window
            // stored in meta was already updated in the block's batch), then run
            // a time-bounded gc pass.
            let stage_start = Instant::now();
            window
                .0
                .push((new_key, ledger_state.ledger_version().into()));
            while window.0.len() > LEDGER_STATE_RETENTION {
                let (key, version) = window.0.remove(0);
                let _arena = LedgerState::exclusive_arena();
                LedgerState::unpersist(&key, LedgerVersion::from(version))
                    .context("unpersist ledger state beyond retention window")?;
            }

            let node_height = *highest_block_on_node.read().expect("lock highest block");
            let distance = node_height.map(|h| h.saturating_sub(height));
            let caught_up = distance.is_some_and(|d| d <= CAUGHT_UP_MAX_DISTANCE);

            // The arena gc sweep dominated catch-up in production (460-550ms
            // per block against replay's ~2ms, measured via the stage times
            // below), so during catch-up it runs amortized every Nth block.
            // Garbage accumulates on disk between sweeps but each sweep still
            // collects it; at the tip the per-block cadence keeps the arena
            // tight.
            if caught_up || height.is_multiple_of(CATCH_UP_GC_INTERVAL) {
                LedgerState::gc(GC_BOUND);
            }
            stages.gc += m::stage(&m::STAGE_GC_NANOS, stage_start.elapsed());
            stages.blocks += 1;
            m::BLOCKS_INDEXED.inc();
            m::LAST_BLOCK_INDEXED_UNIX_SECS.set(m::unix_now_secs());
            m::LAST_BLOCK_CHAIN_UNIX_SECS.set(block_timestamp_ms / 1000);
            if caught_up || height % PROGRESS_LOG_INTERVAL == 0 {
                tracing::info!(height, ?distance, caught_up, "block indexed");
            }
            if height % PROGRESS_LOG_INTERVAL == 0 && stages.blocks > 0 {
                tracing::info!(
                    blocks = stages.blocks,
                    fetch_ms = stages.fetch.as_millis() as u64,
                    replay_ms = stages.replay.as_millis() as u64,
                    roots_ms = stages.roots.as_millis() as u64,
                    persist_ms = stages.persist.as_millis() as u64,
                    write_ms = stages.write.as_millis() as u64,
                    gc_ms = stages.gc.as_millis() as u64,
                    "pipeline stage times"
                );
                stages = StageTimes::default();
            }
        }
    });

    // watchdog_task never completes through normal means (see above); it
    // only needs aborting here so it doesn't outlive a normal shutdown.
    tokio::select! {
        result = &mut highest_task => {
            index_task.abort();
            watchdog_task.abort();
            result.context("highest-block task panicked")?
        }
        result = &mut index_task => {
            highest_task.abort();
            watchdog_task.abort();
            result.context("index task panicked")?
        }
    }
}

/// Monotonic id counters, loaded from meta at startup and written back with
/// every block's batch.
struct Counters {
    next_tx_id: u64,
    next_action_id: u64,
    next_event_id: u64,
}

impl Counters {
    fn load(store: &Store) -> anyhow::Result<Self> {
        Ok(Self {
            next_tx_id: store.next_id(meta_keys::NEXT_TX_ID)?,
            next_action_id: store.next_id(meta_keys::NEXT_ACTION_ID)?,
            next_event_id: store.next_id(meta_keys::NEXT_EVENT_ID)?,
        })
    }
}

/// Wall time accumulated per pipeline stage, logged and reset every
/// PROGRESS_LOG_INTERVAL blocks so catch-up bottlenecks show up in the logs.
#[derive(Default)]
struct StageTimes {
    fetch: Duration,
    replay: Duration,
    roots: Duration,
    persist: Duration,
    write: Duration,
    gc: Duration,
    blocks: u64,
}

/// An infinite stream of node blocks without duplicates, gaps or unexpected
/// parents; re-subscribes when the node misbehaves.
fn node_blocks(
    mut highest_block: Option<BlockRef>,
    mut node: SubxtNode,
) -> impl Stream<Item = anyhow::Result<Block>> {
    stream! {
        loop {
            let blocks = node.finalized_blocks(highest_block);
            let mut blocks = pin!(blocks);

            while let Some(block) = blocks.next().await {
                if let Ok(block) = &block {
                    let expected = highest_block.map(|b| b.hash).unwrap_or_default();
                    if block.parent_hash != expected {
                        tracing::warn!(
                            height = block.height,
                            parent_hash = %block.parent_hash,
                            expected = %expected,
                            "unexpected block, re-subscribing"
                        );
                        m::RESUBSCRIBES.inc();
                        break;
                    }
                    highest_block = Some(BlockRef::from(block));
                }

                yield block.map_err(Into::into);
            }

            sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Replay one block: apply all transactions to the ledger state, verify the
/// recomputed roots against the node's, persist the arena, and commit all
/// derived entities in one atomic batch.
#[allow(clippy::too_many_arguments)]
fn index_block(
    store: &Store,
    block: Block,
    genesis_ledger_state: Option<nightfrost_core::domain::ByteVec>,
    mut ledger_state: LedgerState,
    network_id: &NetworkId,
    parent_block_timestamp: &mut u64,
    window: &LedgerStateWindow,
    ids: &mut Counters,
    stages: &mut StageTimes,
) -> anyhow::Result<(
    LedgerState,
    nightfrost_core::domain::SerializedLedgerStateKey,
)> {
    // API handlers read persisted ledger states through the same arena;
    // keep them out for the duration of this block's ledger mutations.
    let _arena = LedgerState::exclusive_arena();
    let ledger_version = block.protocol_version.ledger_version();

    ledger_state = if block.height == 0 {
        // The genesis block establishes the chain's ledger version; the bootstrap
        // state created at OLDEST is replaced rather than translated.
        LedgerState::new(network_id.clone(), ledger_version).context("create ledger state")?
    } else {
        ledger_state
            .translate(ledger_version)
            .context("translate ledger state")?
    };

    if *parent_block_timestamp == 0 {
        *parent_block_timestamp = block.timestamp;
    }

    // Genesis needs special handling: depending on whether the chain's genesis
    // state already includes the block-0 transactions (post-block-0) or not
    // (pre-block-0), transactions apply to a fresh state or to the genesis state.
    let genesis_state = if block.height == 0 {
        let raw = genesis_ledger_state
            .as_ref()
            .context("genesis block without genesis ledger state")?;
        let genesis_state = LedgerState::from_genesis(raw, ledger_version)
            .context("create ledger state from genesis")?;
        let genesis_root = genesis_state.root().context("genesis state root")?;
        let node_root = block
            .ledger_state_root
            .as_ref()
            .context("genesis block without ledger state root")?;

        if *node_root == genesis_root {
            tracing::info!("post-block-0 genesis: transactions apply to fresh state");
            Some(genesis_state)
        } else {
            tracing::info!("pre-block-0 genesis: transactions apply to genesis state");
            ledger_state = genesis_state;
            None
        }
    } else {
        None
    };

    // Apply all transactions, deriving one TxRecord (+ children) per transaction.
    let stage_start = Instant::now();
    let mut derived = Vec::with_capacity(block.transactions.len());
    let mut first_regular = true;
    for transaction in &block.transactions {
        let bump_tblock = block.height > 0 && first_regular;
        let applied = apply_transaction(
            &mut ledger_state,
            transaction,
            &block,
            *parent_block_timestamp,
            bump_tblock,
        )?;
        if matches!(transaction, Transaction::Regular(_)) {
            first_regular = false;
        }
        derived.push(applied);
    }
    ledger_state
        .finalize_apply_transactions(block.timestamp)
        .context("finalize transaction application")?;
    stages.replay += m::stage(&m::STAGE_REPLAY_NANOS, stage_start.elapsed());

    // Post-block-0 genesis: the fresh state was only used to derive transaction
    // outcomes; the chain continues from the genesis state.
    if let Some(genesis_state) = genesis_state {
        ledger_state = genesis_state;
    }

    *parent_block_timestamp = block.timestamp;

    // The root-match guard: with proof verification off this is the proof that
    // the replay matches the node bit-for-bit. Halt on mismatch.
    let stage_start = Instant::now();
    let ledger_state_root = ledger_state.root().context("ledger state root")?;
    if block
        .ledger_state_root
        .as_ref()
        .is_some_and(|root| *root != ledger_state_root)
    {
        bail!(
            "ledger state root mismatch for block {} at height {}",
            block.hash,
            block.height
        );
    }
    if ledger_state.zswap_merkle_tree_root() != block.zswap_merkle_tree_root {
        bail!(
            "zswap state root mismatch for block {} at height {}",
            block.hash,
            block.height
        );
    }
    stages.roots += m::stage(&m::STAGE_ROOTS_NANOS, stage_start.elapsed());

    // Persist the arena BEFORE the entity batch: on a crash in between, the arena
    // is at most one block ahead and the orphan root is bounded (mirrors the
    // official indexer's recovery model).
    let stage_start = Instant::now();
    let (ledger_state, ledger_state_key) =
        ledger_state.persist().context("persist ledger state")?;
    stages.persist += m::stage(&m::STAGE_PERSIST_NANOS, stage_start.elapsed());

    let stage_start = Instant::now();
    write_block(store, &block, derived, &ledger_state_key, window, ids)
        .context("write block batch")?;
    stages.write += m::stage(&m::STAGE_WRITE_NANOS, stage_start.elapsed());

    Ok((ledger_state, ledger_state_key))
}

/// Everything derived from applying one transaction.
struct AppliedTransaction {
    hash: [u8; 32],
    protocol_version: u32,
    zswap_start_index: u64,
    zswap_end_index: u64,
    variant: TransactionVariant,
    result: TransactionResult,
    fees: u128,
    identifiers: Vec<nightfrost_core::domain::SerializedTransactionIdentifier>,
    /// (address, record, state blob) — the blob rides along so write_block
    /// can insert it into contract_states keyed by the record's state_hash.
    contract_actions: Vec<(
        nightfrost_core::domain::ByteVec,
        ContractActionRecord,
        nightfrost_core::domain::ByteVec,
    )>,
    created_utxos: Vec<UnshieldedUtxo>,
    spent_utxos: Vec<UnshieldedUtxo>,
    ledger_events: Vec<nightfrost_core::domain::LedgerEvent>,
    raw: nightfrost_core::domain::ByteVec,
}

fn apply_transaction(
    ledger_state: &mut LedgerState,
    transaction: &Transaction,
    block: &Block,
    parent_block_timestamp: u64,
    bump_tblock: bool,
) -> anyhow::Result<AppliedTransaction> {
    let zswap_start_index = ledger_state.zswap_first_free();
    let protocol_version = u32::from(block.protocol_version);
    match transaction {
        Transaction::Regular(tx) => {
            // Reproduce the node's mempool-cached tblock bump for the first
            // regular transaction of non-genesis blocks (see constant above).
            let well_formed_timestamp = if bump_tblock {
                parent_block_timestamp + MEMPOOL_TBLOCK_BUMP_MILLIS
            } else {
                block.timestamp
            };

            let outcome = match ledger_state.apply_regular_transaction(
                &tx.raw,
                block.parent_hash,
                block.timestamp,
                parent_block_timestamp,
                well_formed_timestamp,
            ) {
                Ok(outcome) => outcome,
                // The bump above is itself a workaround for a node bug
                // (midnightntwrk/midnight-node#1924): the node's own tblock
                // handling was inconsistent for some already-mined blocks,
                // so a single fixed +2-slots correction helps the common
                // case but overshoots others, where the real fix would need
                // to go the other way. Confirmed live on preprod at height
                // 164460: a transaction whose declared TTL is 2s short of
                // the bumped timestamp, but comfortably valid (4s to spare)
                // against the real, unbumped block time. well_formed()
                // hasn't mutated ledger_state when it fails (the mutating
                // apply() call is never reached), so retrying is free of
                // side effects; if the plain timestamp also fails, the
                // original bumped-timestamp error is almost certainly the
                // more informative one to report.
                Err(LedgerError::MalformedTransaction(_)) if bump_tblock => ledger_state
                    .apply_regular_transaction(
                        &tx.raw,
                        block.parent_hash,
                        block.timestamp,
                        parent_block_timestamp,
                        block.timestamp,
                    )
                    .with_context(|| format!("apply regular transaction {}", tx.hash))?,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("apply regular transaction {}", tx.hash));
                }
            };

            let ledger_version = tx.protocol_version.ledger_version();
            let contract_actions = tx
                .contract_actions
                .iter()
                .map(|action| {
                    // Empty state means the action failed (official workaround
                    // until failed actions are filtered).
                    let balances = if action.state.is_empty() {
                        vec![]
                    } else {
                        match ContractState::deserialize(&action.state, ledger_version)
                            .and_then(|state| state.balances())
                        {
                            Ok(balances) => balances,
                            Err(error) => {
                                // A handful of real contract states on live networks
                                // trip an overly strict merkle-patricia-trie
                                // canonicalization invariant in the vendored
                                // midnight-storage decoder (an upstream decoder
                                // issue, not something wrong in our own replay):
                                // extension-node chains not maximally merged to
                                // exactly 255 nibbles. Losing balances for this one
                                // action is far better than permanently wedging the
                                // indexer on this block forever, so treat it like
                                // the empty-state case above instead of aborting.
                                tracing::warn!(
                                    address = %const_hex::encode(&action.address.0),
                                    block_height = block.height,
                                    error = format!("{:#}", anyhow::Error::new(error)),
                                    "failed to deserialize contract state; recording zero balances"
                                );
                                vec![]
                            }
                        }
                    };
                    let state_hash = if action.state.is_empty() {
                        None
                    } else {
                        Some(Sha256::digest(action.state.as_ref()).into())
                    };
                    let record = ContractActionRecord {
                        address: action.address.clone(),
                        attributes: action.attributes.clone(),
                        state_hash,
                        balances,
                        tx_id: 0, // assigned in write_block
                        block_height: block.height,
                    };
                    Ok((action.address.clone(), record, action.state.clone()))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;

            Ok(AppliedTransaction {
                hash: tx.hash.0,
                protocol_version,
                zswap_start_index,
                zswap_end_index: ledger_state.zswap_first_free(),
                variant: TransactionVariant::Regular,
                result: outcome.transaction_result,
                fees: outcome.fees,
                identifiers: tx.identifiers.clone(),
                contract_actions,
                created_utxos: outcome.created_unshielded_utxos,
                spent_utxos: outcome.spent_unshielded_utxos,
                ledger_events: outcome.ledger_events,
                raw: tx.raw.clone(),
            })
        }

        Transaction::System(tx) => {
            let outcome = ledger_state
                .apply_system_transaction(&tx.raw, block.timestamp)
                .with_context(|| format!("apply system transaction {}", tx.hash))?;

            Ok(AppliedTransaction {
                hash: tx.hash.0,
                protocol_version,
                zswap_start_index,
                zswap_end_index: ledger_state.zswap_first_free(),
                variant: TransactionVariant::System,
                result: TransactionResult::Success,
                fees: 0,
                identifiers: vec![],
                contract_actions: vec![],
                created_utxos: outcome.created_unshielded_utxos,
                spent_utxos: vec![],
                ledger_events: outcome.ledger_events,
                raw: tx.raw.clone(),
            })
        }
    }
}

/// Write all entities derived from one block in a single atomic batch.
fn write_block(
    store: &Store,
    block: &Block,
    transactions: Vec<AppliedTransaction>,
    ledger_state_key: &nightfrost_core::domain::SerializedLedgerStateKey,
    window: &LedgerStateWindow,
    ids: &mut Counters,
) -> anyhow::Result<()> {
    let mut batch = store.batch();
    let height_key = block.height.to_be_bytes();
    let first_tx_id = ids.next_tx_id;

    // In-block caches so later transactions see earlier ones' effects without
    // reading pending batch writes (fjall batches are write-only).
    let mut created_this_block: HashMap<[u8; 36], store::UtxoRecord> = HashMap::new();
    let mut balance_deltas: HashMap<([u8; 32], [u8; 32]), i128> = HashMap::new();
    let mut touched_addresses: HashMap<[u8; 32], Vec<u64>> = HashMap::new();
    let mut contracts_this_block: HashMap<Vec<u8>, ContractRecord> = HashMap::new();
    let mut states_this_block: std::collections::HashSet<[u8; 32]> =
        std::collections::HashSet::new();

    for (index, applied) in transactions.iter().enumerate() {
        let tx_id = ids.next_tx_id;
        ids.next_tx_id += 1;
        let first_event_id = ids.next_event_id;

        batch.insert(
            &store.wallet_tx_indices,
            tx_id.to_be_bytes(),
            store::encode(&store::WalletTxIndexRecord {
                zswap_start_index: applied.zswap_start_index,
                zswap_end_index: applied.zswap_end_index,
                protocol_version: applied.protocol_version,
            }),
        );

        // Secondary key indexes.
        batch.insert(
            &store.txs_by_hash,
            prefixed_u64_key(&applied.hash, tx_id),
            [],
        );
        for identifier in &applied.identifiers {
            batch.insert(
                &store.txs_by_identifier,
                prefixed_u64_key(identifier, tx_id),
                [],
            );
        }

        // Created UTXOs.
        for utxo in &applied.created_utxos {
            let key = utxo_key(&utxo.intent_hash.0, utxo.output_index);
            let record = store::UtxoRecord {
                utxo: *utxo,
                creating_tx_id: tx_id,
                spending_tx_id: None,
            };
            batch.insert(&store.utxos, key, store::encode(&record));
            batch.insert(&store.utxos_unspent_by_owner, unspent_key(utxo), key);
            created_this_block.insert(key, record);
            *balance_deltas
                .entry((utxo.owner.0, utxo.token_type.0))
                .or_default() += utxo.value as i128;
            touched_addresses
                .entry(utxo.owner.0)
                .or_default()
                .push(tx_id);
        }

        // Spent UTXOs: mark spent and drop from the unspent index.
        for utxo in &applied.spent_utxos {
            let key = utxo_key(&utxo.intent_hash.0, utxo.output_index);
            let mut record = match created_this_block.get(&key) {
                Some(record) => record.clone(),
                None => store
                    .utxos
                    .get(key)?
                    .map(|v| store::decode(&v))
                    .with_context(|| {
                        format!(
                            "spent utxo {}/{} not found",
                            utxo.intent_hash, utxo.output_index
                        )
                    })?,
            };
            record.spending_tx_id = Some(tx_id);
            batch.insert(&store.utxos, key, store::encode(&record));
            batch.remove(&store.utxos_unspent_by_owner, unspent_key(utxo));
            created_this_block.insert(key, record);
            *balance_deltas
                .entry((utxo.owner.0, utxo.token_type.0))
                .or_default() -= utxo.value as i128;
            touched_addresses
                .entry(utxo.owner.0)
                .or_default()
                .push(tx_id);
        }

        // Contract actions.
        let mut contract_action_ids = Vec::with_capacity(applied.contract_actions.len());
        for (address, record, state) in &applied.contract_actions {
            let action_id = ids.next_action_id;
            ids.next_action_id += 1;
            contract_action_ids.push(action_id);

            let mut record = record.clone();
            record.tx_id = tx_id;
            batch.insert(
                &store.contract_actions,
                action_id.to_be_bytes(),
                store::encode(&record),
            );
            batch.insert(
                &store.contract_actions_by_addr,
                prefixed_u64_key(address, action_id),
                [],
            );

            // Insert the state blob only if this exact content is new. With
            // key-value separation a redundant insert is not collapsed by
            // compaction: it sits in the blob log until a manual GC, so the
            // skip is a correctness requirement, not an optimization. The
            // in-block set covers duplicates within this batch, which
            // contains_key cannot see (fjall batches are write-only).
            if let Some(hash) = record.state_hash
                && !states_this_block.contains(&hash)
                && !store.contract_states.contains_key(hash)?
            {
                batch.insert(&store.contract_states, hash, state.as_ref());
                states_this_block.insert(hash);
            }

            // Failed actions (no state) stay indexed for parity with the
            // official indexer, but never become a contract's deploy/latest
            // pointer — /contracts/{addr}/state must not serve an empty state.
            if record.state_hash.is_none() {
                continue;
            }

            let contract = match contracts_this_block.get(&address.0) {
                Some(contract) => Some(contract.clone()),
                None => store
                    .contracts
                    .get(&address.0)?
                    .map(|v| store::decode::<ContractRecord>(&v)),
            };
            let contract = match contract {
                Some(mut contract) => {
                    contract.latest_action_id = action_id;
                    contract
                }
                None => ContractRecord {
                    deploy_action_id: action_id,
                    latest_action_id: action_id,
                },
            };
            batch.insert(&store.contracts, &address.0, store::encode(&contract));
            contracts_this_block.insert(address.0.clone(), contract);
        }

        // Ledger events (also feeding the per-contract and dust generation
        // indexes). Contract events are correlated with the emitting
        // `ContractCall` of the same transaction by (address, entry_point),
        // exactly like the official chain-indexer (ticket #1162).
        for event in &applied.ledger_events {
            let event_id = ids.next_event_id;
            ids.next_event_id += 1;

            let mut event = event.clone();
            event.contract_action_id = nightfrost_core::domain::correlate_contract_action_id(
                &event,
                applied
                    .contract_actions
                    .iter()
                    .zip(&contract_action_ids)
                    .map(|((address, record, _), &action_id)| {
                        (action_id, address, &record.attributes)
                    }),
            )
            .or(event.contract_action_id);
            if let Some(address) = &event.contract_address {
                batch.insert(
                    &store.events_by_contract,
                    prefixed_u64_key(address, event_id),
                    [],
                );
            }

            let record = EventRecord {
                event,
                tx_id,
                block_height: block.height,
            };
            batch.insert(
                &store.ledger_events,
                event_id.to_be_bytes(),
                store::encode(&record),
            );
            let event = &record.event;
            if matches!(
                event.grouping,
                nightfrost_core::domain::LedgerEventGrouping::Dust
            ) {
                batch.insert(&store.wallet_dust_events, event_id.to_be_bytes(), []);
            }

            match &event.attributes {
                // Keyed by night_utxo_hash, NOT generation_index/mt_index: the
                // latter is recomputed from a merkle tree-insertion path on
                // DustGenerationDtimeUpdate and does not reproduce the original
                // leaf's index (verified against real preview data — a
                // multi-billion garbage value vs. the true ~1000s-range
                // index), so keying by it would silently leave the original
                // "active" entry un-updated instead of applying the dtime.
                // night_utxo_hash is stable across the create/update pair
                // (confirmed byte-identical), matching the official
                // chain-indexer's own `UPDATE ... WHERE night_utxo_hash = ?`.
                LedgerEventAttributes::DustInitialUtxo {
                    generation_info, ..
                }
                | LedgerEventAttributes::DustGenerationDtimeUpdate {
                    generation_info, ..
                } => {
                    let record = DustGenerationRecord {
                        info: generation_info.clone(),
                        tx_id,
                    };
                    batch.insert(
                        &store.dust_generation,
                        generation_info.night_utxo_hash.0,
                        store::encode(&record),
                    );
                    batch.insert(
                        &store.dust_gen_by_owner,
                        dust_gen_owner_key(
                            &generation_info.owner,
                            &generation_info.night_utxo_hash.0,
                        ),
                        [],
                    );
                }
                _ => {}
            }
        }

        let record = TxRecord {
            hash: applied.hash,
            block_height: block.height,
            index_in_block: index as u32,
            variant: applied.variant,
            result: applied.result.clone(),
            paid_fees: applied.fees,
            estimated_fees: applied.fees,
            identifiers: applied.identifiers.clone(),
            contract_action_ids,
            first_event_id,
            event_count: (ids.next_event_id - first_event_id) as u32,
            created_utxos: applied.created_utxos.clone(),
            spent_utxos: applied.spent_utxos.clone(),
            raw: applied.raw.clone(),
        };
        batch.insert(&store.txs, tx_id.to_be_bytes(), store::encode(&record));
    }

    // Balances: read current values and apply this block's deltas.
    for ((owner, token_type), delta) in balance_deltas {
        let mut key = [0u8; 64];
        key[..32].copy_from_slice(&owner);
        key[32..].copy_from_slice(&token_type);
        let current = store
            .balances
            .get(key)?
            .map(|v| u128::from_be_bytes(v.as_ref().try_into().expect("16-byte balance")))
            .unwrap_or(0);
        let updated = (current as i128 + delta)
            .try_into()
            .context("balance underflow")?;
        batch.insert(&store.balances, key, u128::to_be_bytes(updated));
    }

    // Address -> transaction history index.
    for (owner, tx_ids) in touched_addresses {
        for tx_id in tx_ids {
            batch.insert(&store.addr_txs, prefixed_u64_key(&owner, tx_id), []);
        }
    }

    // cNight registrations: upsert keyed by stake key + dust address.
    for event in &block.dust_registration_events {
        apply_registration_event(store, &mut batch, event, block.height)?;
    }

    // The block itself.
    let record = BlockRecord {
        hash: block.hash.0,
        parent_hash: block.parent_hash.0,
        timestamp: block.timestamp,
        protocol_version: block.protocol_version.into(),
        author: block.author.map(|author| author.0),
        first_tx_id,
        tx_count: transactions.len() as u32,
        zswap_merkle_tree_root: block
            .zswap_merkle_tree_root
            .serialize()
            .context("serialize zswap merkle tree root")?,
        ledger_state_root: block.ledger_state_root.clone(),
    };
    batch.insert(&store.blocks, height_key, store::encode(&record));
    batch.insert(&store.blocks_by_hash, block.hash.0, height_key);

    // Meta: cursor, counters, and the retention window INCLUDING the new key
    // (recovery invariant: the stored window matches the persisted arena roots
    // up to the bounded crash orphan).
    let mut next_window = LedgerStateWindow(window.0.clone());
    next_window.0.push((
        ledger_state_key.clone(),
        block.protocol_version.ledger_version().into(),
    ));
    while next_window.0.len() > LEDGER_STATE_RETENTION {
        next_window.0.remove(0);
    }
    batch.insert(&store.meta, meta_keys::LAST_HEIGHT, height_key);
    batch.insert(
        &store.meta,
        meta_keys::TIP_TIMESTAMP,
        block.timestamp.to_be_bytes(),
    );
    batch.insert(
        &store.meta,
        meta_keys::NEXT_TX_ID,
        ids.next_tx_id.to_be_bytes(),
    );
    batch.insert(
        &store.meta,
        meta_keys::NEXT_ACTION_ID,
        ids.next_action_id.to_be_bytes(),
    );
    batch.insert(
        &store.meta,
        meta_keys::NEXT_EVENT_ID,
        ids.next_event_id.to_be_bytes(),
    );
    batch.insert(
        &store.meta,
        meta_keys::WALLET_TX_INDEXED_THROUGH,
        ids.next_tx_id.to_be_bytes(),
    );
    batch.insert(
        &store.meta,
        meta_keys::WALLET_DUST_INDEXED_THROUGH,
        ids.next_event_id.to_be_bytes(),
    );
    batch.insert(
        &store.meta,
        meta_keys::LEDGER_STATE_WINDOW,
        store::encode(&next_window),
    );
    if block.height == 0 {
        batch.insert(&store.meta, meta_keys::GENESIS_HASH, block.hash.0);
    }

    batch.commit().context("commit block batch")?;
    Ok(())
}

/// dust_gen_by_owner secondary key: owner (variable-length DustPublicKey)
/// followed by the fixed 32-byte night_utxo_hash primary key.
fn dust_gen_owner_key(
    owner: &nightfrost_core::domain::DustPublicKey,
    night_utxo_hash: &[u8; 32],
) -> Vec<u8> {
    let mut key = Vec::with_capacity(owner.0.len() + 32);
    key.extend_from_slice(&owner.0);
    key.extend_from_slice(night_utxo_hash);
    key
}

fn unspent_key(utxo: &UnshieldedUtxo) -> Vec<u8> {
    let mut key = Vec::with_capacity(32 + 32 + 36);
    key.extend_from_slice(&utxo.owner.0);
    key.extend_from_slice(&utxo.token_type.0);
    key.extend_from_slice(&utxo_key(&utxo.intent_hash.0, utxo.output_index));
    key
}

fn apply_registration_event(
    store: &Store,
    batch: &mut fjall::Batch,
    event: &DustRegistrationEvent,
    block_height: u64,
) -> anyhow::Result<()> {
    let (stake_key, dust_address) = match event {
        DustRegistrationEvent::Registration {
            cardano_stake_key,
            dust_address,
        }
        | DustRegistrationEvent::Deregistration {
            cardano_stake_key,
            dust_address,
        }
        | DustRegistrationEvent::MappingAdded {
            cardano_stake_key,
            dust_address,
            ..
        }
        | DustRegistrationEvent::MappingRemoved {
            cardano_stake_key,
            dust_address,
            ..
        } => (cardano_stake_key, dust_address),
    };

    let mut key = Vec::with_capacity(29 + dust_address.len());
    key.extend_from_slice(&stake_key.0);
    key.extend_from_slice(dust_address);

    let mut record = store
        .cnight_registrations
        .get(&key)?
        .map(|v| store::decode::<CnightRegistrationRecord>(&v))
        .unwrap_or_else(|| CnightRegistrationRecord {
            cardano_stake_key: stake_key.0.to_vec().into(),
            dust_address: dust_address.clone(),
            valid: false,
            registered_at_height: block_height,
            removed_at_height: None,
            utxo_id: None,
            utxo_index: None,
        });

    match event {
        DustRegistrationEvent::Registration { .. } => {
            record.valid = true;
            record.registered_at_height = block_height;
            record.removed_at_height = None;
        }
        DustRegistrationEvent::Deregistration { .. } => {
            record.valid = false;
            record.removed_at_height = Some(block_height);
        }
        DustRegistrationEvent::MappingAdded {
            utxo_id,
            utxo_index,
            ..
        } => {
            // A live NIGHT-utxo mapping IS a valid registration; the common
            // path emits MappingAdded without a separate Registration event.
            record.valid = true;
            record.removed_at_height = None;
            record.utxo_id = Some(utxo_id.clone());
            record.utxo_index = Some(u64::from(*utxo_index));
        }
        DustRegistrationEvent::MappingRemoved { .. } => {
            record.utxo_id = None;
            record.utxo_index = None;
        }
    }

    batch.insert(&store.cnight_registrations, key, store::encode(&record));
    Ok(())
}
