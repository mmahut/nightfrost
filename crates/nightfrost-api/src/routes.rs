pub mod entities;

use crate::{
    error::ApiError,
    pagination::{CursorCodec, DecodedCursor, Pagination, TipAnchor},
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use nightfrost_core::{
    domain::{ProtocolVersion, ledger::LedgerState},
    store::{BlockRecord, NodeTipHeight, Store, TxRecord, meta_keys},
};
use serde::Serialize;
use std::sync::Arc;

pub struct ApiState {
    pub store: Arc<Store>,
    pub network_id: String,
    pub node_url: String,
    pub highest_block: NodeTipHeight,
    pub cursor_codec: CursorCodec,
    pub wallet_scan_lock: Arc<std::sync::Mutex<()>>,
}

type AppState = Arc<ApiState>;

pub(crate) fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(error.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct TipResponse {
    pub hash: String,
    pub height: u64,
}

impl From<&TipAnchor> for TipResponse {
    fn from(tip: &TipAnchor) -> Self {
        Self {
            hash: const_hex::encode(tip.hash),
            height: tip.height,
        }
    }
}

/// Response envelope for paginated collection endpoints. `next_cursor` is
/// null once there's no further page.
#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub results: T,
    pub tip: Option<TipResponse>,
    pub next_cursor: Option<String>,
}

/// Response envelope for point lookups and unpaginated full-list endpoints
/// (e.g. a transaction's own events). No `next_cursor`: unlike
/// `ApiResponse`, there is no code path that could ever populate one, so
/// omitting the field instead of always sending it null is the honest shape.
#[derive(Serialize)]
pub struct PointResponse<T> {
    pub results: T,
    pub tip: Option<TipResponse>,
}

pub(crate) fn current_tip(state: &ApiState) -> Result<Option<TipAnchor>, ApiError> {
    let Some(height) = state.store.last_indexed_height().map_err(internal)? else {
        return Ok(None);
    };
    let block = state
        .store
        .block(height)
        .map_err(internal)?
        .ok_or_else(|| ApiError::internal("indexed tip block is missing"))?;
    Ok(Some(TipAnchor {
        height,
        hash: block.hash,
    }))
}

fn validate_anchor(state: &ApiState, anchor: &TipAnchor) -> Result<(), ApiError> {
    let Some(block) = state.store.block(anchor.height).map_err(internal)? else {
        return Err(ApiError::gone("cursor tip is no longer available"));
    };
    if block.hash != anchor.hash {
        return Err(ApiError::gone(
            "cursor belongs to a different chain history",
        ));
    }
    Ok(())
}

pub(crate) struct PageContext {
    pub anchor: Option<TipAnchor>,
    pub position: Option<Vec<u8>>,
}

pub(crate) fn page_context(
    state: &ApiState,
    pagination: &Pagination,
    scope: &[u8],
) -> Result<PageContext, ApiError> {
    pagination.validate()?;
    let decoded: Option<DecodedCursor> = pagination
        .cursor
        .as_deref()
        .map(|cursor| state.cursor_codec.decode(cursor, scope))
        .transpose()?;
    match decoded {
        Some(decoded) => {
            validate_anchor(state, &decoded.anchor)?;
            Ok(PageContext {
                anchor: Some(decoded.anchor),
                position: Some(decoded.position),
            })
        }
        None => Ok(PageContext {
            anchor: current_tip(state)?,
            position: None,
        }),
    }
}

pub(crate) fn next_cursor(
    state: &ApiState,
    scope: &[u8],
    anchor: Option<&TipAnchor>,
    position: Option<&[u8]>,
    has_more: bool,
) -> Option<String> {
    if !has_more {
        return None;
    }
    Some(state.cursor_codec.encode(scope, anchor?, position?))
}

pub(crate) fn response<T>(
    state: &ApiState,
    results: T,
) -> Result<Json<PointResponse<T>>, ApiError> {
    Ok(Json(PointResponse {
        results,
        tip: current_tip(state)?.as_ref().map(Into::into),
    }))
}

pub(crate) fn response_at<T>(
    _state: &ApiState,
    results: T,
    tip: Option<TipAnchor>,
    next_cursor: Option<String>,
) -> Result<Json<ApiResponse<T>>, ApiError> {
    Ok(Json(ApiResponse {
        results,
        tip: tip.as_ref().map(Into::into),
        next_cursor,
    }))
}

#[derive(Serialize)]
pub struct NetworkResponse {
    pub network_id: String,
    pub node_url: String,
    pub genesis_hash: Option<String>,
}

pub async fn network(
    State(state): State<AppState>,
) -> Result<Json<PointResponse<NetworkResponse>>, ApiError> {
    let genesis_hash = state
        .store
        .meta
        .get(meta_keys::GENESIS_HASH)
        .map_err(internal)?
        .map(|v| const_hex::encode(v.as_ref()));

    response(
        &state,
        NetworkResponse {
            network_id: state.network_id.clone(),
            node_url: state.node_url.clone(),
            genesis_hash,
        },
    )
}

#[derive(Serialize)]
pub struct SyncStatusResponse {
    pub indexed_height: Option<u64>,
    pub node_height: Option<u64>,
    pub percentage: Option<f64>,
    pub caught_up: bool,
}

pub async fn sync_status(
    State(state): State<AppState>,
) -> Result<Json<PointResponse<SyncStatusResponse>>, ApiError> {
    let indexed_height = state.store.last_indexed_height().map_err(internal)?;
    let node_height = *state.highest_block.read().expect("lock highest block");
    let caught_up = match (indexed_height, node_height) {
        (Some(indexed), Some(node)) => node.saturating_sub(indexed) <= 10,
        _ => false,
    };
    let percentage = match (indexed_height, node_height) {
        // The node's reported tip can transiently sit below what we've
        // already indexed (e.g. the node itself was wiped and is
        // re-syncing) — clamp rather than report a nonsensical >100%.
        (Some(indexed), Some(node)) if node > 0 => {
            Some(((indexed as f64 / node as f64 * 10_000.0).round() / 100.0).min(100.0))
        }
        _ => None,
    };
    response(
        &state,
        SyncStatusResponse {
            indexed_height,
            node_height,
            percentage,
            caught_up,
        },
    )
}

#[derive(Serialize)]
pub struct StatsResponse {
    pub total_transactions: u64,
    pub total_contract_actions: u64,
    pub total_ledger_events: u64,
    pub total_contracts: u64,
}

pub async fn stats(
    State(state): State<AppState>,
) -> Result<Json<PointResponse<StatsResponse>>, ApiError> {
    use nightfrost_core::store::meta_keys;
    response(
        &state,
        StatsResponse {
            total_transactions: state
                .store
                .next_id(meta_keys::NEXT_TX_ID)
                .map_err(internal)?,
            total_contract_actions: state
                .store
                .next_id(meta_keys::NEXT_ACTION_ID)
                .map_err(internal)?,
            total_ledger_events: state
                .store
                .next_id(meta_keys::NEXT_EVENT_ID)
                .map_err(internal)?,
            // Exact scan; the contract set is small.
            total_contracts: state.store.contracts.len().map_err(internal)? as u64,
        },
    )
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

pub async fn block_latest(
    State(state): State<AppState>,
) -> Result<Json<PointResponse<BlockResponse>>, ApiError> {
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
    response(&state, BlockResponse::new(height, record))
}

/// Authoritative ledger parameters at the indexed tip. Wallet clients need
/// the tagged binary form because fee calculation and transaction validation
/// must use exactly the parameters applied by the ledger implementation.
#[derive(Serialize)]
pub struct LedgerParametersResponse {
    pub block_hash: String,
    pub block_height: u64,
    pub block_time: u64,
    pub protocol_version: u32,
    pub ledger_parameters: String,
}

pub async fn ledger_parameters_latest(
    State(state): State<AppState>,
) -> Result<Json<PointResponse<LedgerParametersResponse>>, ApiError> {
    let height = state
        .store
        .last_indexed_height()
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("no indexed block"))?;
    let block = state
        .store
        .block(height)
        .map_err(internal)?
        .ok_or_else(|| ApiError::internal("indexed tip block is missing"))?;
    let state_key = block
        .ledger_state_root
        .as_ref()
        .ok_or_else(|| ApiError::internal("indexed tip has no persisted ledger state"))?;
    let ledger_version = ProtocolVersion::try_from(block.protocol_version)
        .map_err(internal)?
        .ledger_version();
    let ledger_state = LedgerState::load(state_key, ledger_version).map_err(internal)?;
    let ledger_parameters = ledger_state
        .ledger_parameters()
        .serialize()
        .map_err(internal)?;

    response(
        &state,
        LedgerParametersResponse {
            block_hash: const_hex::encode(block.hash),
            block_height: height,
            block_time: block.timestamp,
            protocol_version: block.protocol_version,
            ledger_parameters: const_hex::encode(ledger_parameters),
        },
    )
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
) -> Result<Json<PointResponse<BlockResponse>>, ApiError> {
    let (height, record) = resolve_block(&state.store, &id)?;
    response(&state, BlockResponse::new(height, record))
}

pub async fn block_txs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<String>>>, ApiError> {
    use crate::pagination::{Order, scope};

    let (height, record) = resolve_block(&state.store, &id)?;
    let query_scope = scope(&[b"block_txs", &height.to_be_bytes()], pagination.order);
    let page = page_context(&state, &pagination, &query_scope)?;
    let after = page
        .position
        .as_deref()
        .map(|bytes| {
            bytes
                .try_into()
                .map(u32::from_be_bytes)
                .map_err(|_| ApiError::bad_request("invalid block transaction cursor"))
        })
        .transpose()?;

    let indexes: Box<dyn Iterator<Item = u32>> = match pagination.order {
        Order::Asc => Box::new(
            (0..record.tx_count).filter(move |index| after.is_none_or(|after| *index > after)),
        ),
        Order::Desc => Box::new(
            (0..record.tx_count)
                .rev()
                .filter(move |index| after.is_none_or(|after| *index < after)),
        ),
    };
    let mut indexed_hashes = indexes
        .take(pagination.count + 1)
        .map(|index| {
            let tx_id = record.first_tx_id + u64::from(index);
            let tx: Option<TxRecord> = state.store.tx(tx_id).map_err(internal)?;
            tx.map(|tx| const_hex::encode(tx.hash))
                .map(|hash| (index, hash))
                .ok_or_else(|| ApiError::internal(format!("missing tx record {tx_id}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = indexed_hashes.len() > pagination.count;
    indexed_hashes.truncate(pagination.count);
    let cursor_position = indexed_hashes.last().map(|(index, _)| index.to_be_bytes());
    let cursor = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_ref().map(|position| position.as_slice()),
        has_more,
    );
    response_at(
        &state,
        indexed_hashes.into_iter().map(|(_, hash)| hash).collect(),
        page.anchor,
        cursor,
    )
}
