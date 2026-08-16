mod backfill;
mod banner;
mod config;
mod init;
mod measure;
mod snapshot;

use anyhow::Context;
use clap::{Parser, Subcommand};
use nightfrost_api::routes::ApiState;
use nightfrost_chain::{pipeline, subxt_node::SubxtNode};
use nightfrost_core::{ledger_db, store::Store};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(Parser)]
#[command(
    name = "nightfrost",
    about = "Midnight blockchain indexer with a REST API"
)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,

    /// Midnight node WebSocket RPC URL (must be an archive node for from-genesis sync)
    #[arg(
        long,
        global = true,
        env = "NIGHTFROST_NODE_URL",
        default_value = "wss://rpc.preview.midnight.network"
    )]
    node_url: String,

    /// Network id for ledger state initialization (preview, preprod, testnet, or empty for mainnet)
    #[arg(
        long,
        global = true,
        env = "NIGHTFROST_NETWORK_ID",
        default_value = "preview"
    )]
    network_id: String,

    /// Data directory for the fjall keyspace
    #[arg(long, env = "NIGHTFROST_DATA_DIR", default_value = "./data")]
    data_dir: String,

    /// Listen address for the REST API
    #[arg(
        long,
        global = true,
        env = "NIGHTFROST_LISTEN",
        default_value = "127.0.0.1:3000"
    )]
    listen: String,

    /// Exact browser origin allowed to submit transactions cross-origin.
    /// Leave unset for same-origin deployments.
    #[arg(long, global = true, env = "NIGHTFROST_SUBMIT_CORS_ORIGIN")]
    submit_cors_origin: Option<String>,

    /// HMAC secret for opaque pagination cursors. Set the same value on every
    /// API replica and retain it across storage/backend migrations.
    #[arg(long, global = true, env = "NIGHTFROST_CURSOR_SECRET")]
    cursor_secret: Option<String>,

    /// One-off maintenance: correlate already-indexed contract events with
    /// their emitting contract calls and populate the per-contract event
    /// index, then exit. Run with the indexer stopped; idempotent.
    #[arg(long)]
    backfill_contract_events: bool,

    /// One-off maintenance: rebuild the dust generation index keyed by
    /// night_utxo_hash instead of the ledger's unstable recomputed
    /// generation_index, then exit. Run with the indexer stopped; idempotent.
    #[arg(long)]
    backfill_dust_generation: bool,

    /// Ledger arena node-cache size (node count, not bytes). The 10k default
    /// is storage-core's own bootstrap value; catch-up replay walks merkle
    /// paths far larger than that, so raising it trades memory for fewer
    /// fjall reads (docs/ROADMAP.md 2b).
    #[arg(
        long,
        global = true,
        env = "NIGHTFROST_LEDGER_CACHE_NODES",
        default_value_t = 100_000
    )]
    ledger_cache_nodes: usize,

    /// One-off maintenance: measure contract-state duplication (see
    /// docs/CONTRACT_STATE.md), then exit. Read-only; run with the
    /// indexer stopped. Only meaningful on a pre-migration store.
    #[arg(long)]
    measure_contract_states: bool,

    /// One-off maintenance: migrate a schema-1 store to content-addressed
    /// contract states (docs/CONTRACT_STATE.md), then exit. Resumable; run
    /// with the indexer stopped. A rerun after cutover reclaims the legacy
    /// partition.
    #[arg(long)]
    backfill_contract_states: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Save or restore the data directory as a portable tar.xz archive.
    Snapshot(SnapshotArgs),
    /// Interactively write a nightfrost.toml config, picked up automatically
    /// by a plain `nightfrost` run.
    Init {
        /// Config file to write
        #[arg(long, default_value = config::DEFAULT_PATH)]
        config: String,

        /// Overwrite an existing config file
        #[arg(long)]
        force: bool,
    },
}

#[derive(clap::Args)]
struct SnapshotArgs {
    #[command(subcommand)]
    command: SnapshotCommand,
}

#[derive(Subcommand)]
enum SnapshotCommand {
    /// Flush the store and archive the data directory. Run with the indexer stopped.
    Save {
        /// Data directory to snapshot
        #[arg(long, env = "NIGHTFROST_DATA_DIR", default_value = "./data")]
        data_dir: String,

        /// Output archive path, e.g. snapshot.tar.xz
        #[arg(long)]
        output: String,
    },
    /// Extract a `snapshot save` archive into a fresh data directory.
    Restore {
        /// Archive produced by `snapshot save`
        #[arg(long)]
        input: String,

        /// Destination data directory; must not already exist
        #[arg(long, env = "NIGHTFROST_DATA_DIR", default_value = "./data")]
        data_dir: String,
    },
}

/// POST /api/v0/tx/submit — a serialized ledger transaction, proxied to the
/// node as an unsigned `Midnight.send_mn_transaction` extrinsic. The body is
/// raw bytes when Content-Type is application/octet-stream, hex (optionally
/// 0x-prefixed) otherwise — never guessed from the payload, which would
/// corrupt raw bodies that happen to be valid hex text.
async fn submit_tx(
    axum::extract::State(node): axum::extract::State<SubxtNode>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<axum::Json<serde_json::Value>, nightfrost_api::error::ApiError> {
    use nightfrost_api::error::ApiError;

    let is_binary = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/octet-stream"));

    let raw = if is_binary {
        body.to_vec()
    } else {
        let text = std::str::from_utf8(&body)
            .map_err(|_| {
                ApiError::bad_request(
                    "expected hex body (or Content-Type: application/octet-stream for raw bytes)",
                )
            })?
            .trim();
        let text = text.strip_prefix("0x").unwrap_or(text);
        const_hex::decode(text).map_err(|_| ApiError::bad_request("invalid hex body"))?
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

    config::apply_env_defaults(config::DEFAULT_PATH);
    let mut args = Args::parse();

    match args.command.take() {
        Some(Command::Snapshot(SnapshotArgs { command })) => match command {
            SnapshotCommand::Save { data_dir, output } => {
                snapshot::save(&data_dir, &output)
                    .with_context(|| format!("save snapshot of {data_dir} to {output}"))?;
                println!("snapshot written to {output}");
                Ok(())
            }
            SnapshotCommand::Restore { input, data_dir } => {
                snapshot::restore(&input, &data_dir)
                    .with_context(|| format!("restore snapshot {input} into {data_dir}"))?;
                println!("snapshot restored into {data_dir}");
                Ok(())
            }
        },
        Some(Command::Init { config, force }) => init::run(&config, force),
        None => run(args).await,
    }
}

async fn run(args: Args) -> anyhow::Result<()> {
    banner::print();

    let network_id = args
        .network_id
        .parse()
        .context("invalid network id (must be non-empty lowercase)")?;

    let store = Arc::new(Store::open(&args.data_dir).context("open fjall keyspace")?);
    store
        .unstick_flushing()
        .context("rotate memtables after journal recovery")?;

    if args.backfill_contract_states {
        let counts = backfill::backfill_contract_states(&store)
            .context("migrate contract states to schema 2")?;
        tracing::info!(?counts, "contract-states migration finished");
        println!(
            "migration done: {} actions rewritten, {} unique blobs ({} bytes), \
             cutover={}, legacy partition reclaimed={}",
            counts.actions, counts.blobs, counts.blob_bytes, counts.cut_over, counts.reclaimed,
        );
        return Ok(());
    }

    if args.measure_contract_states {
        anyhow::ensure!(
            store.schema < nightfrost_core::store::SCHEMA_CURRENT,
            "store already migrated to content-addressed states; nothing to measure"
        );
        let report = measure::contract_states(&store).context("measure contract states")?;
        measure::print(&report);
        return Ok(());
    }

    // Everything below decodes current-schema records.
    store
        .require_current_schema()
        .map_err(|message| anyhow::anyhow!(message))?;

    if args.backfill_contract_events {
        let counts =
            backfill::backfill_contract_events(&store).context("backfill per-contract events")?;
        tracing::info!(?counts, "contract-event backfill finished");
        println!(
            "backfill done: {} events scanned, {} contract events indexed, \
             {} correlated to a contract call, {} event records rewritten",
            counts.events_scanned,
            counts.contract_events_indexed,
            counts.events_correlated,
            counts.records_rewritten,
        );
        return Ok(());
    }

    if args.backfill_dust_generation {
        let counts =
            backfill::backfill_dust_generation(&store).context("backfill dust generation index")?;
        tracing::info!(?counts, "dust-generation backfill finished");
        println!(
            "backfill done: rebuilt={}, {} events scanned, {} generation entries written",
            counts.rebuilt, counts.events_scanned, counts.generation_entries_written,
        );
        return Ok(());
    }

    ledger_db::init(
        args.ledger_cache_nodes,
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

    let cursor_key = args.cursor_secret.unwrap_or_else(|| {
        tracing::warn!("NIGHTFROST_CURSOR_SECRET is unset; using a deterministic development key");
        format!("nightfrost-development-cursor-key:{}", args.network_id)
    });
    let submit_cors_origin = args.submit_cors_origin.clone();
    let state = Arc::new(ApiState {
        store,
        network_id: args.network_id,
        node_url: args.node_url,
        highest_block,
        cursor_codec: nightfrost_api::pagination::CursorCodec::new(cursor_key),
    });
    let submit_router = axum::Router::new()
        .route("/api/v0/tx/submit", axum::routing::post(submit_tx))
        .with_state(submit_node);
    let submit_router = if let Some(origin) = submit_cors_origin {
        let origin = origin
            .parse::<axum::http::HeaderValue>()
            .context("parse NIGHTFROST_SUBMIT_CORS_ORIGIN")?;
        submit_router.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([axum::http::Method::POST])
                .allow_headers([axum::http::header::CONTENT_TYPE]),
        )
    } else {
        submit_router
    };
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
