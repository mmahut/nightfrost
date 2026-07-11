pub mod error;
pub mod pagination;
pub mod routes;

use axum::{Router, routing::get};
use routes::ApiState;
use std::sync::Arc;

pub fn router(state: Arc<ApiState>) -> Router {
    use routes::entities;

    Router::new()
        .route("/api/v1/network", get(routes::network))
        .route("/api/v1/sync-status", get(routes::sync_status))
        .route("/api/v1/blocks/latest", get(routes::block_latest))
        .route("/api/v1/blocks/{id}", get(routes::block_by_id))
        .route("/api/v1/blocks/{id}/txs", get(routes::block_txs))
        .route("/api/v1/txs/{hash}", get(entities::tx))
        .route("/api/v1/txs/{hash}/utxos", get(entities::tx_utxos))
        .route("/api/v1/txs/{hash}/events", get(entities::tx_events))
        .route("/api/v1/addresses/{addr}", get(entities::address_balances))
        .route("/api/v1/addresses/{addr}/utxos", get(entities::address_utxos))
        .route("/api/v1/addresses/{addr}/txs", get(entities::address_txs))
        .route("/api/v1/contracts/{addr}", get(entities::contract))
        .route("/api/v1/contracts/{addr}/state", get(entities::contract_state))
        .route("/api/v1/contracts/{addr}/actions", get(entities::contract_actions))
        .route("/api/v1/ledger-events", get(entities::ledger_events))
        .route("/api/v1/dust/registrations", get(entities::dust_registrations))
        .with_state(state)
}
