use anyhow::Context;
use clap::Parser;
use nightfrost_api::routes::ApiState;
use nightfrost_chain::{pipeline, subxt_node::SubxtNode};
use nightfrost_core::{ledger_db, store::Store};
use std::sync::Arc;

/// Arena node cache size (node count, not bytes); storage-core's own default.
const LEDGER_CACHE_MAX_NODES: usize = 10_000;

#[derive(Parser)]
#[command(name = "nightfrost", about = "Light Midnight indexer with a Blockfrost-style REST API")]
struct Args {
    /// Midnight node WebSocket RPC URL (must be an archive node for from-genesis sync)
    #[arg(long, env = "NIGHTFROST_NODE_URL", default_value = "wss://rpc.preview.midnight.network")]
    node_url: String,

    /// Network id for ledger state initialization (preview, preprod, testnet, or empty for mainnet)
    #[arg(long, env = "NIGHTFROST_NETWORK_ID", default_value = "preview")]
    network_id: String,

    /// Data directory for the fjall keyspace
    #[arg(long, env = "NIGHTFROST_DATA_DIR", default_value = "./data")]
    data_dir: String,

    /// Listen address for the REST API
    #[arg(long, env = "NIGHTFROST_LISTEN", default_value = "127.0.0.1:3000")]
    listen: String,
}

/// POST /api/v1/tx/submit — body: hex (optionally 0x-prefixed) or raw bytes of
/// a serialized ledger transaction; proxied to the node as an unsigned
/// `Midnight.send_mn_transaction` extrinsic.
async fn submit_tx(
    axum::extract::State(node): axum::extract::State<SubxtNode>,
    body: axum::body::Bytes,
) -> Result<axum::Json<serde_json::Value>, nightfrost_api::error::ApiError> {
    use nightfrost_api::error::ApiError;

    let raw = match std::str::from_utf8(&body) {
        Ok(text) => {
            let text = text.trim();
            let text = text.strip_prefix("0x").unwrap_or(text);
            const_hex::decode(text).map_err(|_| ApiError::bad_request("invalid hex body"))?
        }
        Err(_) => body.to_vec(),
    };

    let hash = node
        .submit_transaction(raw)
        .await
        .map_err(|error| ApiError::bad_request(format!("submission failed: {error:#}")))?;

    Ok(axum::Json(serde_json::json!({
        "tx_hash": const_hex::encode(hash)
    })))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,midnight_ledger=warn".into()),
        )
        .init();

    let args = Args::parse();
    let network_id = args
        .network_id
        .parse()
        .context("invalid network id (must be non-empty lowercase)")?;

    let store = Arc::new(Store::open(&args.data_dir).context("open fjall keyspace")?);
    ledger_db::init(
        LEDGER_CACHE_MAX_NODES,
        ledger_db::FjallLedgerDb::new(
            store.keyspace.clone(),
            store.ledger_db_nodes.clone(),
            store.ledger_db_roots.clone(),
        ),
    );
    tracing::info!(data_dir = %args.data_dir, "store opened");

    let node = SubxtNode::new(nightfrost_chain::subxt_node::Config::new(&args.node_url))
        .await
        .with_context(|| format!("connect to node {}", args.node_url))?;
    tracing::info!(node = %args.node_url, "node connected");
    let submit_node = node.clone();

    let highest_block = nightfrost_core::store::NodeTipHeight::default();
    let mut indexer = tokio::spawn(pipeline::run(
        store.clone(),
        node,
        network_id,
        highest_block.clone(),
    ));

    let state = Arc::new(ApiState {
        store,
        network_id: args.network_id,
        node_url: args.node_url,
        highest_block,
    });
    let submit_router = axum::Router::new()
        .route("/api/v1/tx/submit", axum::routing::post(submit_tx))
        .with_state(submit_node);
    let app = nightfrost_api::router(state).merge(submit_router);
    let listener = tokio::net::TcpListener::bind(&args.listen)
        .await
        .with_context(|| format!("bind {}", args.listen))?;
    tracing::info!(listen = %args.listen, "REST API listening");

    let mut api = tokio::spawn(async move { axum::serve(listener, app).await });

    tokio::select! {
        result = &mut indexer => {
            api.abort();
            // A root-match guard failure lands here: exit non-zero, loud.
            result.context("indexer panicked")?.context("indexer failed")
        }
        result = &mut api => {
            indexer.abort();
            result.context("api panicked")?.context("api failed")
        }
        _ = tokio::signal::ctrl_c() => {
            indexer.abort();
            api.abort();
            Ok(())
        }
    }
}
