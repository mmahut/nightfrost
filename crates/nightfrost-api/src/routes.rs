pub mod entities;

use crate::{error::ApiError, pagination::{Order, Pagination}};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use nightfrost_core::store::{BlockRecord, NodeTipHeight, Store, TxRecord, meta_keys};
use serde::Serialize;
use std::sync::Arc;

pub struct ApiState {
    pub store: Arc<Store>,
    pub network_id: String,
    pub node_url: String,
    pub highest_block: NodeTipHeight,
}

type AppState = Arc<ApiState>;

pub(crate) fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(error.to_string())
}

#[derive(Serialize)]
pub struct NetworkResponse {
    pub network_id: String,
    pub node_url: String,
    pub genesis_hash: Option<String>,
}

pub async fn network(State(state): State<AppState>) -> Result<Json<NetworkResponse>, ApiError> {
    let genesis_hash = state
        .store
        .meta
        .get(meta_keys::GENESIS_HASH)
        .map_err(internal)?
        .map(|v| const_hex::encode(v.as_ref()));

    Ok(Json(NetworkResponse {
        network_id: state.network_id.clone(),
        node_url: state.node_url.clone(),
        genesis_hash,
    }))
}

#[derive(Serialize)]
pub struct SyncStatusResponse {
    pub indexed_height: Option<u64>,
    pub node_height: Option<u64>,
    pub caught_up: bool,
}

pub async fn sync_status(
    State(state): State<AppState>,
) -> Result<Json<SyncStatusResponse>, ApiError> {
    let indexed_height = state.store.last_indexed_height().map_err(internal)?;
    let node_height = *state.highest_block.read().expect("lock highest block");
    let caught_up = match (indexed_height, node_height) {
        (Some(indexed), Some(node)) => node.saturating_sub(indexed) <= 10,
        _ => false,
    };
    Ok(Json(SyncStatusResponse {
        indexed_height,
        node_height,
        caught_up,
    }))
}

#[derive(Serialize)]
pub struct BlockResponse {
    pub hash: String,
    pub height: u64,
    pub parent_hash: String,
    pub timestamp: u64,
    pub protocol_version: u32,
    pub author: Option<String>,
    pub tx_count: u32,
    pub zswap_merkle_tree_root: String,
    pub ledger_state_root: Option<String>,
}

impl BlockResponse {
    fn new(height: u64, record: BlockRecord) -> Self {
        Self {
            hash: const_hex::encode(record.hash),
            height,
            parent_hash: const_hex::encode(record.parent_hash),
            timestamp: record.timestamp,
            protocol_version: record.protocol_version,
            author: record.author.map(const_hex::encode),
            tx_count: record.tx_count,
            zswap_merkle_tree_root: const_hex::encode(&record.zswap_merkle_tree_root),
            ledger_state_root: record.ledger_state_root.as_deref().map(const_hex::encode),
        }
    }
}

pub async fn block_latest(State(state): State<AppState>) -> Result<Json<BlockResponse>, ApiError> {
    let height = state
        .store
        .last_indexed_height()
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("no blocks indexed yet"))?;
    let record = state
        .store
        .block(height)
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("block not found"))?;
    Ok(Json(BlockResponse::new(height, record)))
}

/// Resolve `{hash_or_height}`: decimal height or hex block hash.
fn resolve_block(store: &Store, id: &str) -> Result<(u64, BlockRecord), ApiError> {
    let height = if let Ok(height) = id.parse::<u64>() {
        height
    } else {
        let hash = const_hex::decode(id)
            .ok()
            .filter(|hash| hash.len() == 32)
            .ok_or_else(|| ApiError::bad_request("invalid block hash or height"))?;
        store
            .block_height_by_hash(&hash)
            .map_err(internal)?
            .ok_or_else(|| ApiError::not_found("block not found"))?
    };

    let record = store
        .block(height)
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("block not found"))?;
    Ok((height, record))
}

pub async fn block_by_id(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BlockResponse>, ApiError> {
    let (height, record) = resolve_block(&state.store, &id)?;
    Ok(Json(BlockResponse::new(height, record)))
}

pub async fn block_txs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<Vec<String>>, ApiError> {
    pagination.validate().map_err(ApiError::bad_request)?;
    let (_, record) = resolve_block(&state.store, &id)?;

    let tx_ids = (record.first_tx_id..record.first_tx_id + record.tx_count as u64)
        .collect::<Vec<_>>();
    let page = paginate(tx_ids, &pagination);

    let hashes = page
        .into_iter()
        .map(|tx_id| {
            let tx: Option<TxRecord> = state.store.tx(tx_id).map_err(internal)?;
            tx.map(|tx| const_hex::encode(tx.hash))
                .ok_or_else(|| ApiError::internal(format!("missing tx record {tx_id}")))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(hashes))
}

pub fn paginate<T>(mut items: Vec<T>, pagination: &Pagination) -> Vec<T> {
    if pagination.order == Order::Desc {
        items.reverse();
    }
    items
        .into_iter()
        .skip(pagination.offset())
        .take(pagination.count)
        .collect()
}
