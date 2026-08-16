pub mod error;
pub mod metrics;
pub mod pagination;
pub mod routes;

use axum::{Router, routing::get};
use routes::ApiState;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

pub fn router(state: Arc<ApiState>) -> Router {
    use routes::entities;

    Router::new()
        .route("/metrics", get(metrics::metrics))
        .route("/api/v0/network", get(routes::network))
        .route("/api/v0/sync-status", get(routes::sync_status))
        .route("/api/v0/stats", get(routes::stats))
        .route("/api/v0/blocks/latest", get(routes::block_latest))
        .route(
            "/api/v0/ledger-parameters/latest",
            get(routes::ledger_parameters_latest),
        )
        .route("/api/v0/blocks/{id}", get(routes::block_by_id))
        .route("/api/v0/blocks/{id}/txs", get(routes::block_txs))
        .route("/api/v0/txs/{hash}", get(entities::tx))
        .route(
            "/api/v0/tx-identifiers/{identifier}",
            get(entities::tx_by_identifier),
        )
        .route("/api/v0/txs/{hash}/utxos", get(entities::tx_utxos))
        .route("/api/v0/txs/{hash}/events", get(entities::tx_events))
        .route("/api/v0/addresses/{addr}", get(entities::address_balances))
        .route(
            "/api/v0/addresses/{addr}/utxos",
            get(entities::address_utxos),
        )
        .route(
            "/api/v0/addresses/{addr}/utxos/{token_type}",
            get(entities::address_utxos_by_token),
        )
        .route("/api/v0/addresses/{addr}/txs", get(entities::address_txs))
        .route("/api/v0/contracts", get(entities::contracts))
        .route("/api/v0/contracts/{addr}", get(entities::contract))
        .route(
            "/api/v0/contracts/{addr}/state",
            get(entities::contract_state),
        )
        .route(
            "/api/v0/contracts/{addr}/actions",
            get(entities::contract_actions),
        )
        .route(
            "/api/v0/contracts/{addr}/events",
            get(entities::contract_events),
        )
        .route("/api/v0/ledger-events", get(entities::ledger_events))
        .route(
            "/api/v0/dust/registrations",
            get(entities::dust_registrations),
        )
        .route(
            "/api/v0/dust/registrations/{stake_key}",
            get(entities::dust_registrations_by_stake),
        )
        .route(
            "/api/v0/dust/generation-status/{stake_key}",
            get(entities::dust_generation_status),
        )
        .layer(CorsLayer::permissive())
        .with_state(state)
}
