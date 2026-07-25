//! One-off backfill for data indexed before per-contract event correlation
//! existed: scans `ledger_events`, correlates every contract-grouping event
//! with the emitting `ContractCall` of its transaction (same semantics as the
//! chain pipeline / official chain-indexer), populates the
//! `events_by_contract` index, and rewrites event records whose
//! `contract_action_id` changed. Idempotent; run with the indexer stopped.

use anyhow::Context;
use nightfrost_core::{
    domain::{LedgerEventGrouping, correlate_contract_action_id},
    store::{self, ContractActionRecord, EventRecord, Store, prefixed_u64_key},
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
        if !actions_cache.contains_key(&tx_id) {
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
            actions_cache.insert(tx_id, actions);
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
            LedgerEventAttributes::DustInitialUtxo { generation_info, .. } => generation_info,
            LedgerEventAttributes::DustGenerationDtimeUpdate { generation_info, .. } => generation_info,
            _ => continue,
        };

        let gen_record = DustGenerationRecord {
            info: generation_info.clone(),
            tx_id: record.tx_id,
        };
        new_generation.push((generation_info.night_utxo_hash.0, store::encode(&gen_record)));
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
    let new_generation_keys: std::collections::HashSet<Vec<u8>> =
        new_generation.iter().map(|(hash, _)| hash.to_vec()).collect();
    let new_owner_keys: std::collections::HashSet<Vec<u8>> =
        new_owner.iter().cloned().collect();

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
