//! One-off maintenance: measure contract-state duplication.
//! Read-only over the store; run with the indexer
//! stopped like the backfills. Decodes the schema-1 inline-state records:
//! this measurement exists to size the migration, so it only makes sense on
//! a legacy store.

use anyhow::Context;
use nightfrost_core::store::{self, LegacyContractActionRecord, Store};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub struct Report {
    pub records: u64,
    pub failed_actions: u64,
    pub logical_bytes: u64,
    pub unique_hashes: u64,
    pub unique_bytes: u64,
    pub histogram: [(u64, u64); 6],
    pub top_addresses: Vec<(String, u64, u64)>,
}

const BUCKETS: [u64; 5] = [1 << 10, 10 << 10, 100 << 10, 1 << 20, 10 << 20];

pub fn contract_states(store: &Store) -> anyhow::Result<Report> {
    let mut records = 0u64;
    let mut failed_actions = 0u64;
    let mut logical_bytes = 0u64;
    let mut unique_bytes = 0u64;
    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    let mut histogram = [0u64; 6];
    // address -> (action count, total state bytes)
    let mut per_address: HashMap<Vec<u8>, (u64, u64)> = HashMap::new();

    for entry in store.contract_actions.iter() {
        let (_, value) = entry.context("iterate contract_actions")?;
        let record: LegacyContractActionRecord = store::decode(&value);
        records += 1;

        let len = record.state.len() as u64;
        if len == 0 {
            failed_actions += 1;
            continue;
        }
        logical_bytes += len;

        let bucket = BUCKETS.iter().position(|&b| len < b).unwrap_or(5);
        histogram[bucket] += 1;

        let hash: [u8; 32] = Sha256::digest(record.state.as_ref()).into();
        if seen.insert(hash) {
            unique_bytes += len;
        }

        let entry = per_address.entry(record.address.to_vec()).or_default();
        entry.0 += 1;
        entry.1 += len;

        if records.is_multiple_of(100_000) {
            tracing::info!(records, logical_bytes, "measuring contract states");
        }
    }

    let mut addresses: Vec<_> = per_address.into_iter().collect();
    addresses.sort_by_key(|(_, (_, bytes))| std::cmp::Reverse(*bytes));
    let top_addresses = addresses
        .into_iter()
        .take(10)
        .map(|(addr, (count, bytes))| (const_hex::encode(addr), count, bytes))
        .collect();

    let labels = [1u64 << 10, 10 << 10, 100 << 10, 1 << 20, 10 << 20, u64::MAX];
    let histogram = std::array::from_fn(|i| (labels[i], histogram[i]));

    Ok(Report {
        records,
        failed_actions,
        logical_bytes,
        unique_hashes: seen.len() as u64,
        unique_bytes,
        histogram,
        top_addresses,
    })
}

pub fn print(report: &Report) {
    let gib = |b: u64| b as f64 / (1u64 << 30) as f64;
    println!("contract-state measurement");
    println!("  actions:          {}", report.records);
    println!("  failed (empty):   {}", report.failed_actions);
    println!(
        "  logical bytes:    {} ({:.2} GiB)",
        report.logical_bytes,
        gib(report.logical_bytes)
    );
    println!("  unique states:    {}", report.unique_hashes);
    println!(
        "  unique bytes:     {} ({:.2} GiB)",
        report.unique_bytes,
        gib(report.unique_bytes)
    );
    println!(
        "  dedupe ratio:     {:.1}% of logical bytes are duplicates",
        100.0 * (1.0 - report.unique_bytes as f64 / report.logical_bytes.max(1) as f64)
    );
    println!("  size histogram (upper bound, count):");
    for (bound, count) in report.histogram {
        if bound == u64::MAX {
            println!("    >= 10 MiB: {count}");
        } else {
            println!("    < {:>7}: {count}", human(bound));
        }
    }
    println!("  top addresses by state bytes:");
    for (addr, count, bytes) in &report.top_addresses {
        println!(
            "    {addr}  actions={count}  bytes={bytes} ({:.2} GiB)",
            gib(*bytes)
        );
    }
}

fn human(bytes: u64) -> String {
    if bytes >= 1 << 20 {
        format!("{} MiB", bytes >> 20)
    } else {
        format!("{} KiB", bytes >> 10)
    }
}
