//! One-off backfill for data indexed before per-contract event correlation
//! existed: scans `ledger_events`, correlates every contract-grouping event
//! with the emitting `ContractCall` of its transaction (same semantics as the
//! chain pipeline / official chain-indexer), populates the
//! `events_by_contract` index, and rewrites event records whose
//! `contract_action_id` changed. Idempotent; run with the indexer stopped.

use anyhow::Context;
use nightfrost_core::{
    domain::{LedgerEventAttributes, LedgerEventGrouping, correlate_contract_action_id},
    store::{
        self, ContractActionRecord, EventRecord, Store, WalletTxIndexRecord, meta_keys,
        prefixed_u64_key,
    },
};
use std::collections::HashMap;

const COMMIT_EVERY: usize = 1_000;

#[derive(Debug, Default)]
pub struct BackfillCounts {
    pub events_scanned: u64,
    pub contract_events_indexed: u64,
    pub events_correlated: u64,
    pub records_rewritten: u64,
}

pub fn backfill_contract_events(store: &Store) -> anyhow::Result<BackfillCounts> {
    let mut counts = BackfillCounts::default();
    // tx_id -> that transaction's contract actions with their ids.
    let mut actions_cache: HashMap<u64, Vec<(u64, ContractActionRecord)>> = HashMap::new();

    let mut batch = store.batch();
    let mut pending = 0usize;

    for entry in store.ledger_events.iter() {
        let (key, value) = entry.context("scan ledger_events")?;
        counts.events_scanned += 1;
        let event_id = u64::from_be_bytes(key.as_ref().try_into().context("8-byte event id")?);
        let mut record: EventRecord = store::decode(&value);

        if !matches!(record.event.grouping, LedgerEventGrouping::Contract) {
            continue;
        }
        let address = record
            .event
            .contract_address
            .clone()
            .with_context(|| format!("contract event {event_id} without contract address"))?;

        batch.insert(
            &store.events_by_contract,
            prefixed_u64_key(&address, event_id),
            [],
        );
        counts.contract_events_indexed += 1;
        pending += 1;

        let tx_id = record.tx_id;
        if let std::collections::hash_map::Entry::Vacant(entry) = actions_cache.entry(tx_id) {
            let tx = store
                .tx(tx_id)?
                .with_context(|| format!("missing tx record {tx_id} for event {event_id}"))?;
            let actions = tx
                .contract_action_ids
                .iter()
                .map(|&action_id| {
                    let action: ContractActionRecord = store
                        .contract_actions
                        .get(action_id.to_be_bytes())?
                        .map(|v| store::decode(&v))
                        .with_context(|| format!("missing contract action {action_id}"))?;
                    Ok((action_id, action))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            entry.insert(actions);
            if actions_cache.len() > 10_000 {
                actions_cache.clear();
            }
        }
        let actions = &actions_cache[&tx_id];

        let correlated = correlate_contract_action_id(
            &record.event,
            actions
                .iter()
                .map(|(action_id, action)| (*action_id, &action.address, &action.attributes)),
        )
        .or(record.event.contract_action_id);
        if correlated.is_some() {
            counts.events_correlated += 1;
        }

        if record.event.contract_action_id != correlated {
            record.event.contract_action_id = correlated;
            batch.insert(&store.ledger_events, key, store::encode(&record));
            counts.records_rewritten += 1;
            pending += 1;
        }

        if pending >= COMMIT_EVERY {
            batch.commit().context("commit backfill batch")?;
            batch = store.batch();
            pending = 0;
        }
    }

    batch.commit().context("commit final backfill batch")?;
    store
        .keyspace
        .persist(fjall::PersistMode::SyncAll)
        .context("persist keyspace")?;
    Ok(counts)
}

#[derive(Debug, Default)]
pub struct WalletSidecarCounts {
    pub transactions_indexed: u64,
    pub dust_events_indexed: u64,
}

/// Populate wallet-only side indexes for databases created before fast sync.
/// Idempotent and safe to run at every startup before the pipeline begins.
pub fn backfill_wallet_sidecars(
    store: &Store,
    current_zswap_end: u64,
) -> anyhow::Result<WalletSidecarCounts> {
    let target_tx = store.next_id(meta_keys::NEXT_TX_ID)?;
    let target_event = store.next_id(meta_keys::NEXT_EVENT_ID)?;
    let tx_progress = store.next_id(meta_keys::WALLET_TX_INDEXED_THROUGH)?;
    let event_progress = store.next_id(meta_keys::WALLET_DUST_INDEXED_THROUGH)?;
    let mut counts = WalletSidecarCounts::default();

    let mut zswap_index = if tx_progress == 0 {
        let outputs = store.ledger_events.iter().try_fold(0u64, |count, entry| {
            let (_, value) = entry.context("scan events for Zswap output count")?;
            let record: EventRecord = store::decode(&value);
            Ok::<_, anyhow::Error>(
                count
                    + u64::from(matches!(
                        record.event.attributes,
                        LedgerEventAttributes::ZswapOutput
                    )),
            )
        })?;
        current_zswap_end
            .checked_sub(outputs)
            .context("stored Zswap events exceed the current first-free index")?
    } else {
        store
            .wallet_tx_indices
            .get((tx_progress - 1).to_be_bytes())?
            .map(|value| store::decode::<WalletTxIndexRecord>(&value).zswap_end_index)
            .context("wallet transaction index progress has no preceding record")?
    };

    let mut batch = store.batch();
    let mut pending = 0usize;
    for tx_id in tx_progress..target_tx {
        let tx = store
            .tx(tx_id)?
            .with_context(|| format!("missing transaction {tx_id}"))?;
        let block = store
            .block(tx.block_height)?
            .with_context(|| format!("missing block {}", tx.block_height))?;
        let start = zswap_index;
        for event_id in tx.first_event_id..tx.first_event_id + u64::from(tx.event_count) {
            let event: EventRecord = store
                .ledger_events
                .get(event_id.to_be_bytes())?
                .map(|value| store::decode(&value))
                .with_context(|| format!("missing event {event_id}"))?;
            if matches!(event.event.attributes, LedgerEventAttributes::ZswapOutput) {
                zswap_index += 1;
            }
        }
        batch.insert(
            &store.wallet_tx_indices,
            tx_id.to_be_bytes(),
            store::encode(&WalletTxIndexRecord {
                zswap_start_index: start,
                zswap_end_index: zswap_index,
                protocol_version: block.protocol_version,
            }),
        );
        batch.insert(
            &store.meta,
            meta_keys::WALLET_TX_INDEXED_THROUGH,
            (tx_id + 1).to_be_bytes(),
        );
        counts.transactions_indexed += 1;
        pending += 1;
        if pending >= COMMIT_EVERY {
            batch
                .commit()
                .context("commit wallet transaction indexes")?;
            batch = store.batch();
            pending = 0;
        }
    }
    anyhow::ensure!(
        zswap_index == current_zswap_end,
        "wallet Zswap index ended at {zswap_index}, ledger state is at {current_zswap_end}"
    );

    for event_id in event_progress..target_event {
        let record: EventRecord = store
            .ledger_events
            .get(event_id.to_be_bytes())?
            .map(|value| store::decode(&value))
            .with_context(|| format!("missing event {event_id}"))?;
        if matches!(record.event.grouping, LedgerEventGrouping::Dust) {
            batch.insert(&store.wallet_dust_events, event_id.to_be_bytes(), []);
            counts.dust_events_indexed += 1;
        }
        batch.insert(
            &store.meta,
            meta_keys::WALLET_DUST_INDEXED_THROUGH,
            (event_id + 1).to_be_bytes(),
        );
        pending += 1;
        if pending >= COMMIT_EVERY {
            batch.commit().context("commit wallet DUST index")?;
            batch = store.batch();
            pending = 0;
        }
    }
    batch.commit().context("commit final wallet side indexes")?;
    Ok(counts)
}

/// Rebuild `dust_generation` and `dust_gen_by_owner` from scratch, keyed by
/// `night_utxo_hash` instead of the ledger's recomputed `generation_index` /
/// `mt_index`. The latter does not reproduce the original leaf's index on a
/// `DustGenerationDtimeUpdate` (verified against real preview data: a
/// multi-billion garbage value instead of the true ~1000s-range index), so
/// entries indexed before this fix are keyed inconsistently between an
/// initial-utxo event and its later dtime update, leaving decayed generation
/// info looking permanently "active". night_utxo_hash is stable across the
/// create/update pair, matching the official chain-indexer's own
/// `UPDATE ... WHERE night_utxo_hash = ?`.
///
/// Idempotent (safe to rerun after an interruption — old-format leftovers and
/// missing new-format entries both get corrected). Removals and insertions
/// are interleaved within shared batch commits rather than wiping everything
/// up front, so a crash partway through leaves a partially migrated,
/// non-empty index instead of a guaranteed-empty one. Run with the indexer
/// stopped.
pub fn backfill_dust_generation(store: &Store) -> anyhow::Result<DustBackfillCounts> {
    use nightfrost_core::{domain::LedgerEventAttributes, store::DustGenerationRecord};

    let mut counts = DustBackfillCounts::default();

    // Compute the full rebuild in memory FIRST (pure read scan, thousands of
    // small entries — cheap to hold), before touching disk at all. Only once
    // this is complete do we remove old-format entries and insert new-format
    // ones, INTERLEAVED within shared batch commits (see below) rather than
    // wiping everything up front, so an interruption leaves a partially
    // migrated, non-empty index instead of a guaranteed-empty one.
    let mut new_generation = Vec::new(); // (night_utxo_hash, encoded record)
    let mut new_owner = Vec::new(); // owner ‖ night_utxo_hash
    for entry in store.ledger_events.iter() {
        let (_, value) = entry.context("scan ledger_events")?;
        let record: EventRecord = store::decode(&value);
        counts.events_scanned += 1;

        let generation_info = match &record.event.attributes {
            LedgerEventAttributes::DustInitialUtxo {
                generation_info, ..
            } => generation_info,
            LedgerEventAttributes::DustGenerationDtimeUpdate {
                generation_info, ..
            } => generation_info,
            _ => continue,
        };

        let gen_record = DustGenerationRecord {
            info: generation_info.clone(),
            tx_id: record.tx_id,
        };
        new_generation.push((
            generation_info.night_utxo_hash.0,
            store::encode(&gen_record),
        ));
        let mut owner_key = generation_info.owner.0.clone();
        owner_key.extend_from_slice(&generation_info.night_utxo_hash.0);
        new_owner.push(owner_key);
        counts.generation_entries_written += 1;
    }

    // Old keys to remove — but ONLY those that won't also be (re)written
    // below. old_generation_keys is scanned in KEY order (fjall .keys()),
    // while new_generation is in EVENT/chronological order — the two
    // orderings put the SAME logical key at different round-robin positions,
    // so a naive "remove all old, insert all new" interleave can apply a
    // key's Remove op after its own Insert op, permanently deleting an entry
    // that should exist (reproduced live: two consecutive backfill runs gave
    // different results for the same key). Filtering removals down to
    // genuine garbage — keys absent from the fresh rebuild — makes the
    // remove-set and insert-set disjoint, so no key's fate depends on
    // interleaving order.
    let new_generation_keys: std::collections::HashSet<Vec<u8>> = new_generation
        .iter()
        .map(|(hash, _)| hash.to_vec())
        .collect();
    let new_owner_keys: std::collections::HashSet<Vec<u8>> = new_owner.iter().cloned().collect();

    let old_generation_keys = store
        .dust_generation
        .keys()
        .collect::<Result<Vec<_>, _>>()
        .context("scan dust_generation")?
        .into_iter()
        .filter(|key| !new_generation_keys.contains(key.as_ref()))
        .collect::<Vec<_>>();
    let old_owner_keys = store
        .dust_gen_by_owner
        .keys()
        .collect::<Result<Vec<_>, _>>()
        .context("scan dust_gen_by_owner")?
        .into_iter()
        .filter(|key| !new_owner_keys.contains(key.as_ref()))
        .collect::<Vec<_>>();

    enum Op {
        RemoveGeneration(fjall::Slice),
        RemoveOwner(fjall::Slice),
        InsertGeneration([u8; 32], Vec<u8>),
        InsertOwner(Vec<u8>),
    }
    // Round-robin the four operation streams so every commit boundary lands
    // on a mix of removals and insertions across both partitions. Safe now:
    // the remove and insert sets are disjoint by construction.
    let streams: [Box<dyn Iterator<Item = Op>>; 4] = [
        Box::new(old_generation_keys.into_iter().map(Op::RemoveGeneration)),
        Box::new(old_owner_keys.into_iter().map(Op::RemoveOwner)),
        Box::new(
            new_generation
                .into_iter()
                .map(|(hash, value)| Op::InsertGeneration(hash, value)),
        ),
        Box::new(new_owner.into_iter().map(Op::InsertOwner)),
    ];
    let mut streams: Vec<_> = streams.into_iter().collect();

    let mut batch = store.batch();
    let mut pending = 0usize;
    'outer: loop {
        let mut any = false;
        for stream in &mut streams {
            let Some(op) = stream.next() else { continue };
            any = true;
            match op {
                Op::RemoveGeneration(key) => batch.remove(&store.dust_generation, key),
                Op::RemoveOwner(key) => batch.remove(&store.dust_gen_by_owner, key),
                Op::InsertGeneration(hash, value) => {
                    batch.insert(&store.dust_generation, hash, value)
                }
                Op::InsertOwner(key) => batch.insert(&store.dust_gen_by_owner, key, []),
            }
            pending += 1;
        }
        if !any {
            break 'outer;
        }
        if pending >= COMMIT_EVERY {
            batch.commit().context("commit backfill batch")?;
            batch = store.batch();
            pending = 0;
        }
    }
    batch.commit().context("commit final backfill batch")?;
    store
        .keyspace
        .persist(fjall::PersistMode::SyncAll)
        .context("persist keyspace")?;
    counts.rebuilt = true;
    Ok(counts)
}

#[derive(Debug, Default)]
pub struct DustBackfillCounts {
    /// Set only once every removal and insertion has committed; a crash
    /// partway through leaves this false and the index partially migrated
    /// (a mix of pre- and post-fix entries) rather than empty — rerun to
    /// finish (idempotent).
    pub rebuilt: bool,
    pub events_scanned: u64,
    pub generation_entries_written: u64,
}

/// Migrates a schema-1 store to schema 2: rewrites every inline-state
/// contract-action record into `contract_actions_v2` with a content hash,
/// stores each distinct state blob once in `contract_states`, flips the
/// schema version only after everything is persisted, then reclaims the
/// legacy partition as a separately retryable phase.
/// Resumable: progress is cursored in meta, and a rerun after cutover goes
/// straight to reclamation.
pub fn backfill_contract_states(store: &Store) -> anyhow::Result<ContractStatesCounts> {
    use nightfrost_core::store::{LEGACY_CONTRACT_ACTIONS, LegacyContractActionRecord, meta_keys};
    use sha2::{Digest, Sha256};

    let mut counts = ContractStatesCounts::default();

    if store.schema >= nightfrost_core::store::SCHEMA_CURRENT {
        // Post-cutover: only reclamation may remain.
        if store.keyspace.partition_exists(LEGACY_CONTRACT_ACTIONS) {
            let legacy = store
                .keyspace
                .open_partition(LEGACY_CONTRACT_ACTIONS, Default::default())
                .context("open legacy partition for reclamation")?;
            store
                .keyspace
                .delete_partition(legacy)
                .context("delete legacy contract_actions partition")?;
            counts.reclaimed = true;
            tracing::info!("legacy contract_actions partition reclaimed");
        }
        return Ok(counts);
    }

    // The store is schema 1, so store.contract_actions IS the legacy
    // partition; the v2 partition is opened explicitly here.
    let v2 = store
        .keyspace
        .open_partition("contract_actions_v2", Default::default())
        .context("open contract_actions_v2")?;

    let resume_after = store
        .meta
        .get(meta_keys::CONTRACT_STATES_BACKFILL_CURSOR)
        .context("read backfill cursor")?
        .map(|v| u64::from_be_bytes(v.as_ref().try_into().expect("8-byte cursor")));
    if let Some(cursor) = resume_after {
        tracing::info!(cursor, "resuming contract-states backfill");
    }

    let mut batch = store.batch();
    let mut pending = 0usize;
    let mut last_id;
    // Hashes inserted in the current uncommitted batch: contains_key cannot
    // see pending writes, and contract_states is key-value separated, so a
    // duplicate insert within one batch would stick in the blob log.
    let mut pending_hashes: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();

    for entry in store.contract_actions.iter() {
        let (key, value) = entry.context("scan legacy contract_actions")?;
        let action_id = u64::from_be_bytes(key.as_ref().try_into().context("8-byte action id")?);
        if resume_after.is_some_and(|cursor| action_id <= cursor) {
            continue;
        }
        let legacy: LegacyContractActionRecord = store::decode(&value);
        counts.actions += 1;
        last_id = action_id;

        let state_hash = if legacy.state.is_empty() {
            None
        } else {
            let hash: [u8; 32] = Sha256::digest(legacy.state.as_ref()).into();
            // contains_key cannot see this batch's pending writes, so commit
            // granularity below keeps correctness: a blob written in this
            // batch is only skipped via the committed store after the commit,
            // and duplicate inserts within one batch are collapsed by fjall
            // for plain (non-separated) partitions -- but contract_states is
            // separated, so check the batch-local set as well.
            if !store
                .contract_states
                .contains_key(hash)
                .context("check contract state")?
                && pending_hashes.insert(hash)
            {
                batch.insert(&store.contract_states, hash, legacy.state.as_ref());
                counts.blobs += 1;
                counts.blob_bytes += legacy.state.len() as u64;
            }
            Some(hash)
        };

        let record = store::ContractActionRecord {
            address: legacy.address,
            attributes: legacy.attributes,
            state_hash,
            balances: legacy.balances,
            tx_id: legacy.tx_id,
            block_height: legacy.block_height,
        };
        batch.insert(&v2, key.as_ref(), store::encode(&record));
        pending += 1;

        if pending >= COMMIT_EVERY {
            batch.insert(
                &store.meta,
                meta_keys::CONTRACT_STATES_BACKFILL_CURSOR,
                last_id.to_be_bytes(),
            );
            batch.commit().context("commit migration batch")?;
            pending_hashes.clear();
            batch = store.batch();
            pending = 0;
            if counts.actions.is_multiple_of(100_000) {
                tracing::info!(
                    actions = counts.actions,
                    blobs = counts.blobs,
                    "migrating contract actions"
                );
            }
        }
    }

    // Final batch: remaining records, cursor removal, and the cutover itself.
    batch.remove(&store.meta, meta_keys::CONTRACT_STATES_BACKFILL_CURSOR);
    batch.insert(
        &store.meta,
        meta_keys::SCHEMA_VERSION,
        nightfrost_core::store::SCHEMA_CURRENT.to_be_bytes(),
    );
    batch.commit().context("commit migration cutover")?;
    store
        .keyspace
        .persist(fjall::PersistMode::SyncAll)
        .context("persist cutover")?;
    counts.cut_over = true;
    tracing::info!("schema cutover persisted; reclaiming legacy partition");

    store
        .keyspace
        .delete_partition(store.contract_actions.clone())
        .context("delete legacy contract_actions partition")?;
    counts.reclaimed = true;

    Ok(counts)
}

#[derive(Debug, Default)]
pub struct ContractStatesCounts {
    pub actions: u64,
    pub blobs: u64,
    pub blob_bytes: u64,
    pub cut_over: bool,
    pub reclaimed: bool,
}
