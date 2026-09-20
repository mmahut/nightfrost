pub mod error;
pub mod metrics;
pub mod pagination;
pub mod routes;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use routes::ApiState;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

pub fn metrics_router(state: Arc<ApiState>) -> Router {
    Router::new()
        .route("/metrics", get(metrics::metrics))
        .with_state(state)
}

pub fn router(state: Arc<ApiState>) -> Router {
    use routes::entities;

    Router::new()
        .route("/api/v0/network", get(routes::network))
        .route("/api/v0/sync", get(routes::sync_status))
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
        .route("/api/v0/ledger/events", get(entities::ledger_events))
        .route(
            "/api/v0/wallet-sync/shielded",
            post(entities::wallet_shielded_sync).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route("/api/v0/wallet-sync/dust", get(entities::wallet_dust_sync))
        .route(
            "/api/v0/wallet/events",
            post(entities::wallet_events).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/v0/dust/registrations",
            get(entities::dust_registrations),
        )
        .route(
            "/api/v0/dust/registrations/{stake_key}",
            get(entities::dust_registrations_by_stake),
        )
        .route(
            "/api/v0/dust/status/{stake_key}",
            get(entities::dust_generation_status),
        )
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn metrics_are_only_served_by_metrics_router() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(ApiState {
            store: Arc::new(nightfrost_core::store::Store::open(dir.path()).unwrap()),
            network_id: "preview".into(),
            node_url: String::new(),
            highest_block: Default::default(),
            cursor_codec: pagination::CursorCodec::new("test"),
            wallet_scan_lock: Default::default(),
        });
        for (app, path, status) in [
            (router(state.clone()), "/metrics", 404),
            (metrics_router(state.clone()), "/metrics", 200),
            (metrics_router(state.clone()), "/api/v0/network", 404),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let response = tokio::task::spawn_blocking(move || {
                let mut stream = std::net::TcpStream::connect(address).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                write!(
                    stream,
                    "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                response
            })
            .await
            .unwrap();
            server.abort();
            assert!(
                response.starts_with(&format!("HTTP/1.1 {status}")),
                "{response}"
            );
            if status == 200 {
                assert!(response.contains("nightfrost_indexed_height"));
            }
        }
    }
}
