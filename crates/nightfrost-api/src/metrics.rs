//! Prometheus text exposition at GET /metrics — gauges rendered directly from
//! the store, no metrics library needed.

use crate::{error::ApiError, routes::ApiState, routes::internal};
use axum::extract::State;
use nightfrost_core::store::meta_keys;
use std::fmt::Write;
use std::sync::Arc;

pub async fn metrics(State(state): State<Arc<ApiState>>) -> Result<String, ApiError> {
    let indexed_height = state.store.last_indexed_height().map_err(internal)?;
    let node_height = *state.highest_block.read().expect("lock highest block");
    let caught_up = matches!((indexed_height, node_height), (Some(i), Some(n)) if n.saturating_sub(i) <= 10);
    let txs = state.store.next_id(meta_keys::NEXT_TX_ID).map_err(internal)?;
    let actions = state.store.next_id(meta_keys::NEXT_ACTION_ID).map_err(internal)?;
    let events = state.store.next_id(meta_keys::NEXT_EVENT_ID).map_err(internal)?;
    let disk = state.store.keyspace.disk_space();

    let mut out = String::with_capacity(1024);
    let mut gauge = |name: &str, help: &str, value: f64| {
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {value}");
    };

    gauge(
        "nightfrost_indexed_height",
        "Highest block height indexed",
        indexed_height.map(|h| h as f64).unwrap_or(-1.0),
    );
    gauge(
        "nightfrost_node_height",
        "Highest finalized block height seen on the node",
        node_height.map(|h| h as f64).unwrap_or(-1.0),
    );
    gauge(
        "nightfrost_caught_up",
        "1 when the indexer is within 10 blocks of the node tip",
        caught_up as u8 as f64,
    );
    gauge(
        "nightfrost_transactions_total",
        "Transactions indexed",
        txs as f64,
    );
    gauge(
        "nightfrost_contract_actions_total",
        "Contract actions indexed",
        actions as f64,
    );
    gauge(
        "nightfrost_ledger_events_total",
        "Ledger events indexed",
        events as f64,
    );
    gauge(
        "nightfrost_store_disk_bytes",
        "Disk space used by the fjall keyspace",
        disk as f64,
    );

    Ok(out)
}
