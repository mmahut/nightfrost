//! Transaction, address, contract, dust and ledger-event endpoints.

use super::{
    ApiResponse, ApiState, PointResponse, current_tip, internal, next_cursor, page_context,
    response, response_at,
};
use crate::{
    error::ApiError,
    pagination::{Order, Pagination, prefix_end, scope},
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, header::CACHE_CONTROL},
};
use nightfrost_core::{
    domain::{
        LedgerEventAttributes, LedgerEventGrouping, ProtocolVersion, TransactionResult,
        TransactionVariant, UnshieldedUtxo,
        ledger::{LedgerState, Transaction},
    },
    store::{
        self, CnightRegistrationRecord, ContractActionRecord, EventRecord, Store, TxRecord,
        WalletTxIndexRecord, key_u64_suffix, meta_keys,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, ops::Bound, sync::Arc};

type AppState = Arc<ApiState>;

/// Accept a 32-byte value as hex (with/without 0x) or bech32m (any mn_* HRP).
fn parse_addr32(input: &str) -> Result<[u8; 32], ApiError> {
    if let Ok((_hrp, data)) = bech32::decode(input) {
        return data
            .try_into()
            .map_err(|_| ApiError::bad_request("bech32 address must decode to 32 bytes"));
    }
    const_hex::decode(input)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("invalid address: expected hex or bech32m"))
}

#[derive(Serialize)]
pub struct TxResponse {
    pub id: u64,
    pub hash: String,
    pub block_height: u64,
    pub block_hash: String,
    pub block_time: u64,
    pub index: u32,
    pub protocol_version: u32,
    pub variant: TransactionVariant,
    pub status: String,
    pub segments: Option<Vec<(u16, bool)>>,
    pub paid_fees: String,
    pub estimated_fees: String,
    pub identifiers: Vec<String>,
    pub utxo_created_count: usize,
    pub utxo_spent_count: usize,
    pub event_count: u32,
    pub contract_action_count: usize,
}

fn tx_status(result: &TransactionResult) -> (String, Option<Vec<(u16, bool)>>) {
    match result {
        TransactionResult::Success => ("success".into(), None),
        TransactionResult::PartialSuccess(segments) => {
            ("partial_success".into(), Some(segments.clone()))
        }
        TransactionResult::Failure => ("failure".into(), None),
    }
}

/// The record for a tx hash (the most recent occurrence if duplicated).
fn tx_by_hash(state: &AppState, hash: &str) -> Result<(u64, TxRecord), ApiError> {
    let hash: [u8; 32] = const_hex::decode(hash)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("invalid transaction hash"))?;
    let tx_id = state
        .store
        .tx_ids_by_hash(&hash)
        .map_err(internal)?
        .pop()
        .ok_or_else(|| ApiError::not_found("transaction not found"))?;
    let record = state
        .store
        .tx(tx_id)
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("transaction not found"))?;
    Ok((tx_id, record))
}

fn tx_response(state: &AppState, tx_id: u64, record: TxRecord) -> Result<TxResponse, ApiError> {
    let block = state
        .store
        .block(record.block_height)
        .map_err(internal)?
        .ok_or_else(|| ApiError::internal("missing block for tx"))?;
    let (status, segments) = tx_status(&record.result);

    Ok(TxResponse {
        id: tx_id,
        hash: const_hex::encode(record.hash),
        block_height: record.block_height,
        block_hash: const_hex::encode(block.hash),
        block_time: block.timestamp,
        index: record.index_in_block,
        protocol_version: block.protocol_version,
        variant: record.variant,
        status,
        segments,
        paid_fees: record.paid_fees.to_string(),
        estimated_fees: record.estimated_fees.to_string(),
        identifiers: record.identifiers.iter().map(const_hex::encode).collect(),
        utxo_created_count: record.created_utxos.len(),
        utxo_spent_count: record.spent_utxos.len(),
        event_count: record.event_count,
        contract_action_count: record.contract_action_ids.len(),
    })
}

pub async fn tx(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<PointResponse<TxResponse>>, ApiError> {
    let (tx_id, record) = tx_by_hash(&state, &hash)?;
    response(&state, tx_response(&state, tx_id, record)?)
}

pub async fn tx_by_identifier(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<PointResponse<TxResponse>>, ApiError> {
    let identifier = const_hex::decode(identifier.trim_start_matches("0x"))
        .map_err(|_| ApiError::bad_request("invalid transaction identifier"))?;
    if identifier.len() != 33 {
        return Err(ApiError::bad_request(
            "transaction identifier must be 33 bytes",
        ));
    }
    let tx_id = state
        .store
        .tx_ids_by_identifier(&identifier)
        .map_err(internal)?
        .pop()
        .ok_or_else(|| ApiError::not_found("transaction not found"))?;
    let record = state
        .store
        .tx(tx_id)
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("transaction not found"))?;
    response(&state, tx_response(&state, tx_id, record)?)
}

#[derive(Serialize)]
pub struct UtxoResponse {
    pub owner: String,
    pub token_type: String,
    pub value: String,
    pub intent_hash: String,
    pub output_index: u32,
    pub ctime: Option<u64>,
    pub registered_for_dust_generation: bool,
}

impl From<&UnshieldedUtxo> for UtxoResponse {
    fn from(utxo: &UnshieldedUtxo) -> Self {
        Self {
            owner: const_hex::encode(utxo.owner.0),
            token_type: const_hex::encode(utxo.token_type.0),
            value: utxo.value.to_string(),
            intent_hash: const_hex::encode(utxo.intent_hash.0),
            output_index: utxo.output_index,
            ctime: utxo.ctime,
            registered_for_dust_generation: utxo.registered_for_dust_generation,
        }
    }
}

#[derive(Serialize)]
pub struct TxUtxosResponse {
    pub hash: String,
    pub inputs: Vec<UtxoResponse>,
    pub outputs: Vec<UtxoResponse>,
}

pub async fn tx_utxos(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<PointResponse<TxUtxosResponse>>, ApiError> {
    let (_, record) = tx_by_hash(&state, &hash)?;
    response(
        &state,
        TxUtxosResponse {
            hash: const_hex::encode(record.hash),
            // The replay extracts spent utxos from the post-apply ledger state,
            // where they no longer exist, so their ctime comes back null — take it
            // from the stored record written when the utxo was created.
            inputs: record
                .spent_utxos
                .iter()
                .map(|utxo| {
                    let mut response = UtxoResponse::from(utxo);
                    if response.ctime.is_none() {
                        let key = nightfrost_core::store::utxo_key(
                            &utxo.intent_hash.0,
                            utxo.output_index,
                        );
                        if let Ok(Some(v)) = state.store.utxos.get(key) {
                            let stored: store::UtxoRecord = store::decode(&v);
                            response.ctime = stored.utxo.ctime;
                        }
                    }
                    response
                })
                .collect(),
            outputs: record.created_utxos.iter().map(Into::into).collect(),
        },
    )
}

#[derive(Serialize)]
pub struct EventResponse {
    pub id: u64,
    pub grouping: LedgerEventGrouping,
    pub attributes: LedgerEventAttributes,
    pub raw: String,
    pub tx_id: u64,
    pub block_height: u64,
    pub protocol_version: u32,
}

impl EventResponse {
    fn new(state: &AppState, id: u64, record: EventRecord) -> Result<Self, ApiError> {
        let protocol_version = state
            .store
            .block(record.block_height)
            .map_err(internal)?
            .ok_or_else(|| ApiError::internal("missing block for ledger event"))?
            .protocol_version;
        Ok(Self {
            id,
            grouping: record.event.grouping,
            raw: const_hex::encode(&record.event.raw),
            attributes: record.event.attributes,
            tx_id: record.tx_id,
            block_height: record.block_height,
            protocol_version,
        })
    }
}

pub async fn tx_events(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<PointResponse<Vec<EventResponse>>>, ApiError> {
    let (_, record) = tx_by_hash(&state, &hash)?;
    let events = (record.first_event_id..record.first_event_id + record.event_count as u64)
        .map(|event_id| {
            let value = state
                .store
                .ledger_events
                .get(event_id.to_be_bytes())
                .map_err(internal)?
                .ok_or_else(|| ApiError::internal("missing event record"))?;
            EventResponse::new(&state, event_id, store::decode(&value))
        })
        .collect::<Result<Vec<_>, _>>()?;
    response(&state, events)
}

#[derive(Serialize)]
pub struct BalanceResponse {
    pub token_type: String,
    pub amount: String,
}

pub async fn address_balances(
    State(state): State<AppState>,
    Path(addr): Path<String>,
) -> Result<Json<PointResponse<Vec<BalanceResponse>>>, ApiError> {
    let owner = parse_addr32(&addr)?;
    let balances = state
        .store
        .balances
        .prefix(owner)
        .map(|entry| {
            let (key, value) = entry.map_err(internal)?;
            Ok(BalanceResponse {
                token_type: const_hex::encode(&key[32..64]),
                amount: u128::from_be_bytes(value.as_ref().try_into().expect("16-byte balance"))
                    .to_string(),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    response(&state, balances)
}

pub async fn address_utxos(
    state: State<AppState>,
    Path(addr): Path<String>,
    pagination: Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<UtxoResponse>>>, ApiError> {
    address_utxos_inner(state, addr, None, pagination).await
}

pub async fn address_utxos_by_token(
    state: State<AppState>,
    Path((addr, token_type)): Path<(String, String)>,
    pagination: Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<UtxoResponse>>>, ApiError> {
    address_utxos_inner(state, addr, Some(token_type), pagination).await
}

async fn address_utxos_inner(
    State(state): State<AppState>,
    addr: String,
    token_type: Option<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<UtxoResponse>>>, ApiError> {
    let owner = parse_addr32(&addr)?;

    let mut prefix = owner.to_vec();
    if let Some(token_type) = &token_type {
        let token: [u8; 32] = const_hex::decode(token_type)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| ApiError::bad_request("invalid token_type"))?;
        prefix.extend_from_slice(&token);
    }
    let query_scope = scope(
        &[
            b"address_utxos",
            &owner,
            token_type.as_deref().unwrap_or("").as_bytes(),
        ],
        pagination.order,
    );
    let page = page_context(&state, &pagination, &query_scope)?;
    let cursor_key = page
        .position
        .as_ref()
        .map(|position| {
            if position.len() != 68 {
                return Err(ApiError::bad_request("invalid UTXO cursor position"));
            }
            let mut key = owner.to_vec();
            key.extend_from_slice(position);
            Ok(key)
        })
        .transpose()?;
    let lower = match (pagination.order, cursor_key.as_ref()) {
        (Order::Asc, Some(key)) => Bound::Excluded(key.clone()),
        _ => Bound::Included(prefix.clone()),
    };
    let upper = match (pagination.order, cursor_key) {
        (Order::Desc, Some(key)) => Bound::Excluded(key),
        _ => prefix_end(&prefix).map_or(Bound::Unbounded, Bound::Excluded),
    };
    let range = state.store.utxos_unspent_by_owner.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut rows = entries
        .take(pagination.count + 1)
        .map(|entry| entry.map_err(internal))
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = rows.len() > pagination.count;
    rows.truncate(pagination.count);
    let cursor_position = rows.last().map(|(index_key, _)| index_key[32..].to_vec());
    let utxos = rows
        .into_iter()
        .map(|(_, utxo_key)| {
            let record: store::UtxoRecord = state
                .store
                .utxos
                .get(&utxo_key)
                .map_err(internal)?
                .map(|v| store::decode(&v))
                .ok_or_else(|| ApiError::internal("missing utxo record"))?;
            Ok(UtxoResponse::from(&record.utxo))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let cursor = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_deref(),
        has_more,
    );
    response_at(&state, utxos, page.anchor, cursor)
}

pub async fn address_txs(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(from): Query<EventFrom>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<String>>>, ApiError> {
    let owner = parse_addr32(&addr)?;
    let query_scope = scope(
        &[b"address_txs", &owner, &from.from.to_be_bytes()],
        pagination.order,
    );
    let page = page_context(&state, &pagination, &query_scope)?;
    let cursor_key = page
        .position
        .as_deref()
        .map(|position| {
            let id: [u8; 8] = position
                .try_into()
                .map_err(|_| ApiError::bad_request("invalid transaction cursor position"))?;
            let mut key = owner.to_vec();
            key.extend_from_slice(&id);
            Ok::<_, ApiError>(key)
        })
        .transpose()?;
    let lower = match (pagination.order, cursor_key.as_ref()) {
        (Order::Asc, Some(key)) => Bound::Excluded(key.clone()),
        _ => {
            let mut key = owner.to_vec();
            key.extend_from_slice(&from.from.to_be_bytes());
            Bound::Included(key)
        }
    };
    let upper = match (pagination.order, cursor_key) {
        (Order::Desc, Some(key)) => Bound::Excluded(key),
        _ => prefix_end(&owner).map_or(Bound::Unbounded, Bound::Excluded),
    };
    let range = state.store.addr_txs.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut rows = Vec::with_capacity(pagination.count + 1);
    for entry in entries {
        let (key, _) = entry.map_err(internal)?;
        let tx_id = key_u64_suffix(&key);
        let record = state
            .store
            .tx(tx_id)
            .map_err(internal)?
            .ok_or_else(|| ApiError::internal("missing tx record"))?;
        if page
            .anchor
            .as_ref()
            .is_some_and(|tip| record.block_height > tip.height)
        {
            continue;
        }
        rows.push((tx_id, const_hex::encode(record.hash)));
        if rows.len() > pagination.count {
            break;
        }
    }
    let has_more = rows.len() > pagination.count;
    rows.truncate(pagination.count);
    let cursor_position = rows.last().map(|(tx_id, _)| tx_id.to_be_bytes());
    let cursor = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_ref().map(|position| position.as_slice()),
        has_more,
    );
    response_at(
        &state,
        rows.into_iter().map(|(_, hash)| hash).collect(),
        page.anchor,
        cursor,
    )
}

fn parse_contract_addr(addr: &str) -> Result<Vec<u8>, ApiError> {
    const_hex::decode(addr).map_err(|_| ApiError::bad_request("invalid contract address (hex)"))
}

fn contract_action(state: &AppState, action_id: u64) -> Result<ContractActionRecord, ApiError> {
    state
        .store
        .contract_actions
        .get(action_id.to_be_bytes())
        .map_err(internal)?
        .map(|v| store::decode(&v))
        .ok_or_else(|| ApiError::internal("missing contract action record"))
}

#[derive(Serialize)]
pub struct ContractResponse {
    pub address: String,
    pub deploy_action_id: u64,
    pub latest_action_id: u64,
    pub latest_action_type: String,
    pub latest_block_height: u64,
    /// Content hash of the latest state: poll this cheap endpoint and fetch
    /// the state blob only when it changes.
    pub state_hash: Option<String>,
    pub balances: Vec<BalanceResponse>,
}

fn action_type(record: &ContractActionRecord) -> String {
    match &record.attributes {
        nightfrost_core::domain::ContractAttributes::Deploy => "deploy".into(),
        nightfrost_core::domain::ContractAttributes::Call { .. } => "call".into(),
        nightfrost_core::domain::ContractAttributes::Update => "update".into(),
    }
}

pub async fn contract(
    State(state): State<AppState>,
    Path(addr): Path<String>,
) -> Result<Json<PointResponse<ContractResponse>>, ApiError> {
    let address = parse_contract_addr(&addr)?;
    let record: store::ContractRecord = state
        .store
        .contracts
        .get(&address)
        .map_err(internal)?
        .map(|v| store::decode(&v))
        .ok_or_else(|| ApiError::not_found("contract not found"))?;
    let latest = contract_action(&state, record.latest_action_id)?;

    response(
        &state,
        ContractResponse {
            address: const_hex::encode(&address),
            deploy_action_id: record.deploy_action_id,
            latest_action_id: record.latest_action_id,
            latest_action_type: action_type(&latest),
            latest_block_height: latest.block_height,
            state_hash: latest.state_hash.map(const_hex::encode),
            balances: latest
                .balances
                .iter()
                .map(|b| BalanceResponse {
                    token_type: const_hex::encode(b.token_type.0),
                    amount: b.amount.to_string(),
                })
                .collect(),
        },
    )
}

#[derive(Serialize)]
pub struct ContractListItem {
    pub address: String,
    pub deploy_action_id: u64,
    pub latest_action_id: u64,
}

pub async fn contracts(
    State(state): State<AppState>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<ContractListItem>>>, ApiError> {
    let query_scope = scope(&[b"contracts"], pagination.order);
    let page = page_context(&state, &pagination, &query_scope)?;
    let lower = match (pagination.order, page.position.as_ref()) {
        (Order::Asc, Some(position)) => Bound::Excluded(position.clone()),
        _ => Bound::Unbounded,
    };
    let upper = match (pagination.order, page.position.as_ref()) {
        (Order::Desc, Some(position)) => Bound::Excluded(position.clone()),
        _ => Bound::Unbounded,
    };
    let range = state.store.contracts.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut rows = entries
        .take(pagination.count + 1)
        .map(|entry| {
            let (address, value) = entry.map_err(internal)?;
            let record: store::ContractRecord = store::decode(&value);
            Ok((
                address.to_vec(),
                ContractListItem {
                    address: const_hex::encode(&address),
                    deploy_action_id: record.deploy_action_id,
                    latest_action_id: record.latest_action_id,
                },
            ))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let has_more = rows.len() > pagination.count;
    rows.truncate(pagination.count);
    let cursor_position = rows.last().map(|(address, _)| address.as_slice());
    let cursor = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position,
        has_more,
    );
    response_at(
        &state,
        rows.into_iter().map(|(_, contract)| contract).collect(),
        page.anchor,
        cursor,
    )
}

#[derive(Serialize)]
pub struct ContractStateResponse {
    pub address: String,
    pub block_height: u64,
    pub state: String,
}

pub async fn contract_state(
    State(state): State<AppState>,
    Path(addr): Path<String>,
) -> Result<Json<PointResponse<ContractStateResponse>>, ApiError> {
    let address = parse_contract_addr(&addr)?;
    let record: store::ContractRecord = state
        .store
        .contracts
        .get(&address)
        .map_err(internal)?
        .map(|v| store::decode(&v))
        .ok_or_else(|| ApiError::not_found("contract not found"))?;
    let latest = contract_action(&state, record.latest_action_id)?;

    let state_hash = latest
        .state_hash
        .ok_or_else(|| internal("latest contract action has no state"))?;
    let blob = state
        .store
        .contract_states
        .get(state_hash)
        .map_err(internal)?
        .ok_or_else(|| internal("contract state blob missing for hash"))?;

    response(
        &state,
        ContractStateResponse {
            address: const_hex::encode(&address),
            block_height: latest.block_height,
            state: const_hex::encode(&blob),
        },
    )
}

#[derive(Serialize)]
pub struct ContractActionResponse {
    pub id: u64,
    pub r#type: String,
    pub entry_point: Option<String>,
    pub tx_hash: String,
    pub block_height: u64,
    /// Content hash of the block-final state stored for this action; None for
    /// a failed action. Lets clients page history and fetch only the states
    /// that actually changed.
    pub state_hash: Option<String>,
}

pub async fn contract_actions(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<ContractActionResponse>>>, ApiError> {
    let address = parse_contract_addr(&addr)?;
    let query_scope = scope(&[b"contract_actions", &address], pagination.order);
    let page = page_context(&state, &pagination, &query_scope)?;
    let cursor_key = page
        .position
        .as_deref()
        .map(|position| {
            let id: [u8; 8] = position
                .try_into()
                .map_err(|_| ApiError::bad_request("invalid contract action cursor position"))?;
            let mut key = address.clone();
            key.extend_from_slice(&id);
            Ok::<_, ApiError>(key)
        })
        .transpose()?;
    let lower = match (pagination.order, cursor_key.as_ref()) {
        (Order::Asc, Some(key)) => Bound::Excluded(key.clone()),
        _ => Bound::Included(address.clone()),
    };
    let upper = match (pagination.order, cursor_key) {
        (Order::Desc, Some(key)) => Bound::Excluded(key),
        _ => prefix_end(&address).map_or(Bound::Unbounded, Bound::Excluded),
    };
    let range = state.store.contract_actions_by_addr.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut actions = Vec::with_capacity(pagination.count + 1);
    for entry in entries {
        let (key, _) = entry.map_err(internal)?;
        let action_id = key_u64_suffix(&key);
        let record = contract_action(&state, action_id)?;
        // Index keys are address‖action_id, so a shorter address that is a
        // byte-prefix of another would match here — keep exact ones only.
        if record.address.0 != address {
            continue;
        }
        if page
            .anchor
            .as_ref()
            .is_some_and(|tip| record.block_height > tip.height)
        {
            continue;
        }
        let tx = state
            .store
            .tx(record.tx_id)
            .map_err(internal)?
            .ok_or_else(|| ApiError::internal("missing tx record"))?;
        let entry_point = match &record.attributes {
            nightfrost_core::domain::ContractAttributes::Call { entry_point } => {
                Some(entry_point.clone())
            }
            _ => None,
        };
        actions.push((
            action_id,
            ContractActionResponse {
                id: action_id,
                r#type: action_type(&record),
                entry_point,
                tx_hash: const_hex::encode(tx.hash),
                block_height: record.block_height,
                state_hash: record.state_hash.map(const_hex::encode),
            },
        ));
        if actions.len() > pagination.count {
            break;
        }
    }
    let has_more = actions.len() > pagination.count;
    actions.truncate(pagination.count);
    let cursor_position = actions.last().map(|(action_id, _)| action_id.to_be_bytes());
    let cursor = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_ref().map(|position| position.as_slice()),
        has_more,
    );
    response_at(
        &state,
        actions.into_iter().map(|(_, action)| action).collect(),
        page.anchor,
        cursor,
    )
}

/// `from` on its own so it can be extracted with a separate `Query<_>` from
/// `Pagination` — `#[serde(flatten)]` is incompatible with axum's
/// `serde_urlencoded`-based `Query` extractor for non-string fields (a known
/// limitation: the flatten buffering step loses the type hint needed to
/// coerce e.g. `"100"` into `usize`, so any query with an explicit `count`
/// 400s). Extracting twice avoids it entirely, since neither struct denies
/// unknown fields.
#[derive(Deserialize)]
pub struct EventFrom {
    #[serde(default)]
    pub from: u64,
}

#[cfg(test)]
mod event_cursor_tests {
    use super::*;
    use crate::pagination::CursorCodec;
    use nightfrost_core::store::{BlockRecord, ContractRecord, Store, meta_keys};
    use std::sync::RwLock;

    #[test]
    fn event_cursor_defaults_to_regular_pagination() {
        let from: EventFrom = serde_json::from_str("{}").unwrap();
        assert_eq!(from.from, 0);
        let pagination = Pagination::default();
        assert_eq!(pagination.count, 100);
        assert_eq!(pagination.order, Order::Asc);
        assert!(pagination.cursor.is_none());
    }

    #[tokio::test]
    async fn wallet_feed_advances_cleanly_on_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(ApiState {
            store: Arc::new(Store::open(dir.path()).unwrap()),
            network_id: "test".into(),
            node_url: "ws://node".into(),
            highest_block: Arc::new(RwLock::new(None)),
            cursor_codec: CursorCodec::new(b"test key"),
            wallet_scan_lock: Arc::new(std::sync::Mutex::new(())),
        });

        let (headers, Json(response)) = wallet_events(
            State(state.clone()),
            Json(WalletEventsRequest {
                viewing_key: const_hex::encode([0u8; 32]),
                from: 0,
                count: 5_000,
                cursor: None,
            }),
        )
        .await
        .unwrap();

        assert_eq!(headers[CACHE_CONTROL], "no-store");
        assert!(response.results.events.is_empty());
        assert_eq!(response.results.scanned_through, 0);
        assert_eq!(response.results.highest_event_id, 0);
        assert!(response.next_cursor.is_none());

        let (headers, Json(response)) = wallet_shielded_sync(
            State(state.clone()),
            Json(ShieldedSyncRequest {
                viewing_key: const_hex::encode([0u8; 32]),
                from_index: 0,
            }),
        )
        .await
        .unwrap();
        assert_eq!(headers[CACHE_CONTROL], "no-store");
        assert!(response.results.updates.is_empty());
        assert_eq!(response.results.applied_through, 0);
        assert_eq!(response.results.highest_index, 0);
        assert_eq!(response.results.scanned_transactions, 0);

        let (headers, Json(response)) = wallet_dust_sync(
            State(state),
            Query(DustSyncRequest {
                from: 0,
                count: 50_000,
            }),
        )
        .await
        .unwrap();
        assert_eq!(headers[CACHE_CONTROL], "public, max-age=2");
        assert!(response.results.events.is_empty());
        assert_eq!(response.results.scanned_through, 0);
        assert_eq!(response.results.highest_event_id, 0);
    }

    #[tokio::test]
    async fn contracts_seek_from_the_opaque_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let tip_hash = [9; 32];
        store
            .blocks
            .insert(
                0u64.to_be_bytes(),
                store::encode(&BlockRecord {
                    hash: tip_hash,
                    parent_hash: [0; 32],
                    timestamp: 0,
                    protocol_version: 1,
                    author: None,
                    first_tx_id: 0,
                    tx_count: 0,
                    zswap_merkle_tree_root: vec![].into(),
                    ledger_state_root: None,
                }),
            )
            .unwrap();
        store
            .meta
            .insert(meta_keys::LAST_HEIGHT, 0u64.to_be_bytes())
            .unwrap();
        for byte in 1..=3 {
            store
                .contracts
                .insert(
                    [byte; 32],
                    store::encode(&ContractRecord {
                        deploy_action_id: u64::from(byte),
                        latest_action_id: u64::from(byte),
                    }),
                )
                .unwrap();
        }
        let state = Arc::new(ApiState {
            store,
            network_id: "test".into(),
            node_url: "ws://node".into(),
            highest_block: Arc::new(RwLock::new(Some(0))),
            cursor_codec: CursorCodec::new(b"test key"),
            wallet_scan_lock: Arc::new(std::sync::Mutex::new(())),
        });

        let first = contracts(
            State(state.clone()),
            Query(Pagination {
                count: 2,
                ..Pagination::default()
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(first.results.len(), 2);
        assert_eq!(
            first.tip.as_ref().unwrap().hash,
            const_hex::encode(tip_hash)
        );
        let cursor = first.next_cursor.unwrap();

        let second = contracts(
            State(state),
            Query(Pagination {
                count: 2,
                cursor: Some(cursor),
                ..Pagination::default()
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(second.results.len(), 1);
        assert!(second.next_cursor.is_none());
        assert_eq!(second.results[0].address, const_hex::encode([3; 32]));
    }
}

pub async fn ledger_events(
    State(state): State<AppState>,
    Query(from): Query<EventFrom>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<EventResponse>>>, ApiError> {
    let query_scope = scope(
        &[b"ledger_events", &from.from.to_be_bytes()],
        pagination.order,
    );
    let page = page_context(&state, &pagination, &query_scope)?;
    let position = page
        .position
        .as_deref()
        .map(|bytes| {
            bytes
                .try_into()
                .map(u64::from_be_bytes)
                .map_err(|_| ApiError::bad_request("invalid ledger event cursor position"))
        })
        .transpose()?;
    let lower = match (pagination.order, position) {
        (Order::Asc, Some(id)) => Bound::Excluded(id.to_be_bytes().to_vec()),
        _ => Bound::Included(from.from.to_be_bytes().to_vec()),
    };
    let upper = match (pagination.order, position) {
        (Order::Desc, Some(id)) => Bound::Excluded(id.to_be_bytes().to_vec()),
        _ => Bound::Unbounded,
    };
    let range = state.store.ledger_events.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut events = Vec::with_capacity(pagination.count + 1);
    for entry in entries {
        let (key, value) = entry.map_err(internal)?;
        let id = u64::from_be_bytes(key.as_ref().try_into().expect("8-byte event id"));
        let record: EventRecord = store::decode(&value);
        if page
            .anchor
            .as_ref()
            .is_some_and(|tip| record.block_height > tip.height)
        {
            continue;
        }
        events.push(EventResponse::new(&state, id, record)?);
        if events.len() > pagination.count {
            break;
        }
    }
    let has_more = events.len() > pagination.count;
    events.truncate(pagination.count);
    let cursor_position = events.last().map(|event| event.id.to_be_bytes());
    let next = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_ref().map(|position| position.as_slice()),
        has_more,
    );
    response_at(&state, events, page.anchor, next)
}

#[derive(Deserialize)]
pub struct WalletEventsRequest {
    pub viewing_key: String,
    #[serde(default)]
    pub from: u64,
    #[serde(default = "wallet_events_default_count")]
    pub count: usize,
    pub cursor: Option<String>,
}

fn wallet_events_default_count() -> usize {
    5_000
}

#[derive(Serialize)]
pub struct WalletEventResponse {
    #[serde(flatten)]
    pub event: EventResponse,
    pub relevant: Option<bool>,
}

#[derive(Serialize)]
pub struct WalletEventsResult {
    pub events: Vec<WalletEventResponse>,
    /// One past the last raw ledger-event ID examined, including irrelevant events.
    pub scanned_through: u64,
    /// One past the latest ledger-event ID currently indexed.
    pub highest_event_id: u64,
}

/// Stateless wallet feed. The supplied Zswap encryption secret key is used
/// only for trial decryption during this request and is never persisted. The
/// response remains chain-complete for wallet replay: every Zswap and DUST event
/// is returned, with Zswap relevance annotated; contract events are omitted.
pub async fn wallet_events(
    State(state): State<AppState>,
    Json(request): Json<WalletEventsRequest>,
) -> Result<(HeaderMap, Json<ApiResponse<WalletEventsResult>>), ApiError> {
    let viewing_key_bytes = const_hex::decode(request.viewing_key.trim_start_matches("0x"))
        .map_err(|_| ApiError::bad_request("viewing_key must be hex-encoded"))?;
    let viewing_key = nightfrost_core::domain::ledger::viewing_key_repr(&viewing_key_bytes)
        .ok_or_else(|| {
            ApiError::bad_request(
                "viewing_key must be a raw 32-byte key or official SDK serialization",
            )
        })?;
    let pagination = Pagination {
        count: request.count,
        order: Order::Asc,
        cursor: request.cursor,
        page: None,
    };
    let query_scope = scope(
        &[b"wallet_events", &request.from.to_be_bytes(), &viewing_key],
        Order::Asc,
    );
    let page = page_context(&state, &pagination, &query_scope)?;
    let position = page
        .position
        .as_deref()
        .map(|bytes| {
            bytes
                .try_into()
                .map(u64::from_be_bytes)
                .map_err(|_| ApiError::bad_request("invalid wallet event cursor position"))
        })
        .transpose()?;
    let lower = position
        .map(|id| Bound::Excluded(id.to_be_bytes().to_vec()))
        .unwrap_or_else(|| Bound::Included(request.from.to_be_bytes().to_vec()));
    let mut events = Vec::new();
    let mut scanned = 0usize;
    let mut scanned_through = request.from;
    let mut cursor_position = None;
    let mut has_more = false;
    let mut relevant_txs = HashMap::<u64, bool>::new();

    for entry in state.store.ledger_events.range((lower, Bound::Unbounded)) {
        let (key, value) = entry.map_err(internal)?;
        let id = u64::from_be_bytes(key.as_ref().try_into().expect("8-byte event id"));
        let record: EventRecord = store::decode(&value);
        if page
            .anchor
            .as_ref()
            .is_some_and(|tip| record.block_height > tip.height)
        {
            continue;
        }
        if scanned == pagination.count {
            has_more = true;
            break;
        }

        scanned += 1;
        scanned_through = id.saturating_add(1);
        cursor_position = Some(id.to_be_bytes());
        let relevance = match record.event.grouping {
            LedgerEventGrouping::Dust => None,
            LedgerEventGrouping::Contract => continue,
            LedgerEventGrouping::Zswap => Some({
                if let Some(relevant) = relevant_txs.get(&record.tx_id) {
                    *relevant
                } else {
                    let tx = state
                        .store
                        .tx(record.tx_id)
                        .map_err(internal)?
                        .ok_or_else(|| {
                            ApiError::internal("missing transaction for wallet event")
                        })?;
                    let relevant = if tx.variant == TransactionVariant::Regular {
                        let block = state
                            .store
                            .block(tx.block_height)
                            .map_err(internal)?
                            .ok_or_else(|| ApiError::internal("missing block for wallet event"))?;
                        let ledger_version = ProtocolVersion::try_from(block.protocol_version)
                            .map_err(internal)?
                            .ledger_version();
                        Transaction::deserialize(&tx.raw, ledger_version)
                            .map_err(internal)?
                            .relevant(&viewing_key)
                    } else {
                        false
                    };
                    relevant_txs.insert(record.tx_id, relevant);
                    relevant
                }
            }),
        };
        events.push(WalletEventResponse {
            event: EventResponse::new(&state, id, record)?,
            relevant: relevance,
        });
    }

    let next = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_ref().map(|position| position.as_slice()),
        has_more,
    );
    let results = WalletEventsResult {
        events,
        scanned_through,
        highest_event_id: state
            .store
            .next_id(meta_keys::NEXT_EVENT_ID)
            .map_err(internal)?,
    };
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let response = response_at(&state, results, page.anchor, next)?;
    Ok((headers, response))
}

/// Per-contract event cursor feed, shaped like `/ledger/events`: events (with
/// their transaction and correlation context) plus the next cursor. Restricted
/// to events emitted by exactly this contract.
#[derive(Serialize)]
pub struct ContractEventResponse {
    pub id: u64,
    pub grouping: LedgerEventGrouping,
    pub attributes: LedgerEventAttributes,
    pub raw: String,
    pub tx_id: u64,
    pub tx_hash: String,
    pub block_height: u64,
    pub contract_address: String,
    /// Id of the emitting `ContractCall` (a `/contracts/{addr}/actions` id);
    /// `None` when several calls in the transaction share address and entry
    /// point (unambiguous attribution only, like the official indexer).
    pub contract_action_id: Option<u64>,
}

pub async fn contract_events(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(from): Query<EventFrom>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<ContractEventResponse>>>, ApiError> {
    let address = parse_contract_addr(&addr)?;
    let query_scope = scope(
        &[b"contract_events", &address, &from.from.to_be_bytes()],
        pagination.order,
    );
    let page = page_context(&state, &pagination, &query_scope)?;
    let position = page
        .position
        .as_deref()
        .map(|bytes| {
            bytes
                .try_into()
                .map(u64::from_be_bytes)
                .map_err(|_| ApiError::bad_request("invalid contract event cursor position"))
        })
        .transpose()?;
    let mut start = address.clone();
    start.extend_from_slice(&from.from.to_be_bytes());
    let lower = match (pagination.order, position) {
        (Order::Asc, Some(id)) => {
            let mut key = address.clone();
            key.extend_from_slice(&id.to_be_bytes());
            Bound::Excluded(key)
        }
        _ => Bound::Included(start),
    };
    let upper = match (pagination.order, position) {
        (Order::Desc, Some(id)) => {
            let mut key = address.clone();
            key.extend_from_slice(&id.to_be_bytes());
            Bound::Excluded(key)
        }
        _ => prefix_end(&address).map_or(Bound::Unbounded, Bound::Excluded),
    };
    let range = state.store.events_by_contract.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut events = Vec::with_capacity(pagination.count + 1);
    for entry in entries {
        let (key, _) = entry.map_err(internal)?;
        if !key.starts_with(&address) {
            break;
        }
        let event_id = key_u64_suffix(&key);
        let record: EventRecord = state
            .store
            .ledger_events
            .get(event_id.to_be_bytes())
            .map_err(internal)?
            .map(|v| store::decode(&v))
            .ok_or_else(|| ApiError::internal("missing event record"))?;
        // Index keys are address‖event_id, so a shorter address that is a
        // byte-prefix of another would match here — keep exact ones only.
        if record.event.contract_address.as_ref().map(|a| &a.0) != Some(&address) {
            continue;
        }
        if page
            .anchor
            .as_ref()
            .is_some_and(|tip| record.block_height > tip.height)
        {
            continue;
        }
        let tx = state
            .store
            .tx(record.tx_id)
            .map_err(internal)?
            .ok_or_else(|| ApiError::internal("missing tx record"))?;
        events.push(ContractEventResponse {
            id: event_id,
            grouping: record.event.grouping,
            raw: const_hex::encode(&record.event.raw),
            attributes: record.event.attributes,
            tx_id: record.tx_id,
            tx_hash: const_hex::encode(tx.hash),
            block_height: record.block_height,
            contract_address: const_hex::encode(&address),
            contract_action_id: record.event.contract_action_id,
        });
        if events.len() > pagination.count {
            break;
        }
    }
    let has_more = events.len() > pagination.count;
    events.truncate(pagination.count);
    let cursor_position = events.last().map(|event| event.id.to_be_bytes());
    let next = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position.as_ref().map(|position| position.as_slice()),
        has_more,
    );
    response_at(&state, events, page.anchor, next)
}

#[derive(Serialize)]
pub struct RegistrationResponse {
    pub cardano_stake_key: String,
    pub dust_address: String,
    pub valid: bool,
    pub registered_at_height: u64,
    pub removed_at_height: Option<u64>,
    pub utxo_id: Option<String>,
    pub utxo_index: Option<u64>,
}

pub async fn dust_registrations(
    state: State<AppState>,
    pagination: Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<RegistrationResponse>>>, ApiError> {
    dust_registrations_inner(state, None, pagination).await
}

pub async fn dust_registrations_by_stake(
    state: State<AppState>,
    Path(stake_key): Path<String>,
    pagination: Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<RegistrationResponse>>>, ApiError> {
    dust_registrations_inner(state, Some(stake_key), pagination).await
}

async fn dust_registrations_inner(
    State(state): State<AppState>,
    stake_key: Option<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<ApiResponse<Vec<RegistrationResponse>>>, ApiError> {
    let prefix = match &stake_key {
        Some(stake_key) => {
            let key = const_hex::decode(stake_key)
                .map_err(|_| ApiError::bad_request("invalid stake_key (hex)"))?;
            // Registration keys start with the full 29-byte Cardano reward
            // address; anything shorter would prefix-match other stake keys.
            if key.len() != 29 {
                return Err(ApiError::bad_request("stake_key must be 29 bytes of hex"));
            }
            key
        }
        None => vec![],
    };
    let query_scope = scope(&[b"dust_registrations", &prefix], pagination.order);
    let page = page_context(&state, &pagination, &query_scope)?;
    let lower = match (pagination.order, page.position.as_ref()) {
        (Order::Asc, Some(position)) => Bound::Excluded(position.clone()),
        _ if prefix.is_empty() => Bound::Unbounded,
        _ => Bound::Included(prefix.clone()),
    };
    let upper = match (pagination.order, page.position.as_ref()) {
        (Order::Desc, Some(position)) => Bound::Excluded(position.clone()),
        _ => prefix_end(&prefix).map_or(Bound::Unbounded, Bound::Excluded),
    };
    let range = state.store.cnight_registrations.range((lower, upper));
    let entries: Box<dyn Iterator<Item = _>> = match pagination.order {
        Order::Asc => Box::new(range),
        Order::Desc => Box::new(range.rev()),
    };
    let mut rows = Vec::with_capacity(pagination.count + 1);
    for entry in entries {
        let (key, value) = entry.map_err(internal)?;
        let record: CnightRegistrationRecord = store::decode(&value);
        // Deliberately current-state, not tip-anchored-consistent, like
        // address_utxos/contracts: registered_at_height is overwritten on
        // every re-Registration event (pipeline.rs) rather than fixed at
        // first creation, and Deregistration/MappingAdded/MappingRemoved
        // don't touch it at all. A guard keyed on it would hide rows that
        // legitimately existed as of the tip (re-registered after) while
        // letting rows that changed validity or mapping after the tip
        // through untouched — neither a real snapshot nor useful filtering.
        // Would need an immutable creation-height field to do this properly.
        rows.push((
            key.to_vec(),
            RegistrationResponse {
                cardano_stake_key: const_hex::encode(&record.cardano_stake_key),
                dust_address: const_hex::encode(&record.dust_address),
                // Derive for rows written before MappingAdded implied validity:
                // a live utxo mapping is a valid registration.
                valid: record.valid
                    || (record.utxo_id.is_some() && record.removed_at_height.is_none()),
                registered_at_height: record.registered_at_height,
                removed_at_height: record.removed_at_height,
                utxo_id: record.utxo_id.as_deref().map(const_hex::encode),
                utxo_index: record.utxo_index,
            },
        ));
        if rows.len() > pagination.count {
            break;
        }
    }
    let has_more = rows.len() > pagination.count;
    rows.truncate(pagination.count);
    let cursor_position = rows.last().map(|(key, _)| key.as_slice());
    let cursor = next_cursor(
        &state,
        &query_scope,
        page.anchor.as_ref(),
        cursor_position,
        has_more,
    );
    response_at(
        &state,
        rows.into_iter().map(|(_, record)| record).collect(),
        page.anchor,
        cursor,
    )
}

/// Accept a Cardano stake key as 29-byte hex (with/without 0x) or bech32
/// (`stake1…` / `stake_test1…`).
fn parse_stake_key(input: &str) -> Result<[u8; 29], ApiError> {
    if let Ok((_hrp, data)) = bech32::decode(input) {
        return data
            .try_into()
            .map_err(|_| ApiError::bad_request("bech32 stake key must decode to 29 bytes"));
    }
    const_hex::decode(input)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("invalid stake key: expected 29-byte hex or bech32"))
}

/// DUST generation status for a Cardano stake key; the REST twin of the
/// official `dustGenerationStatus` query. Amounts are strings: night_balance
/// in STAR, the rate in SPECK/second, capacities in SPECK. Unregistered keys
/// are a 200 with `registered: false`, matching the official indexer.
#[derive(Serialize)]
pub struct DustGenerationStatusResponse {
    pub cardano_stake_key: String,
    pub registered: bool,
    pub dust_address: Option<String>,
    pub night_balance: String,
    pub generation_rate: String,
    pub current_capacity: String,
    pub max_capacity: String,
}

pub async fn dust_generation_status(
    State(state): State<AppState>,
    Path(stake_key): Path<String>,
) -> Result<Json<PointResponse<DustGenerationStatusResponse>>, ApiError> {
    use nightfrost_core::domain::{LedgerVersion, TimestampMs, TimestampSecs, ledger};

    let stake_key = parse_stake_key(&stake_key)?;

    // Latest current registration for this stake key (removed_at unset,
    // newest registered_at) — the selection the official indexer-api makes in
    // its dust storage. `valid` is derived the same way as
    // /dust/registrations: a live NIGHT-utxo mapping is a valid registration.
    //
    // The validity filter applies INSIDE the loop, before the "latest wins"
    // comparison: a stake key can carry multiple non-removed rows tied on
    // registered_at_height (e.g. two registration attempts in the same
    // block, only one of them valid) — filtering afterwards let an invalid
    // row that lost the tie discard an equally-recent valid one, which
    // surfaced as real divergence from the oracle on live preview data.
    let mut registration: Option<CnightRegistrationRecord> = None;
    for entry in state.store.cnight_registrations.prefix(stake_key) {
        let (_, value) = entry.map_err(internal)?;
        let record: CnightRegistrationRecord = store::decode(&value);
        if record.removed_at_height.is_some() || !(record.valid || record.utxo_id.is_some()) {
            continue;
        }
        if registration
            .as_ref()
            .is_none_or(|current| record.registered_at_height >= current.registered_at_height)
        {
            registration = Some(record);
        }
    }

    let mut night_balance = 0u128;
    let mut generation_rate = 0u128;
    let mut max_capacity = 0u128;
    let mut current_capacity = 0u128;

    if let Some(registration) = &registration {
        // DUST parameters for the current protocol version (the official
        // indexer-api queries with LedgerVersion::LATEST).
        let dust_params = ledger::dust_parameters(LedgerVersion::LATEST).map_err(internal)?;
        let generation_decay_rate = dust_params.generation_decay_rate as u128;
        let night_dust_ratio = dust_params.night_dust_ratio as u128;

        // Latest active generation info owned by the registered dust address
        // (dtime == u64::MAX means "not decaying yet", the fjall twin of the
        // official `dtime IS NULL`).
        let owner = &registration.dust_address;
        let mut active: Option<nightfrost_core::domain::dust::DustGenerationInfo> = None;
        for entry in state.store.dust_gen_by_owner.prefix(&owner.0) {
            let (key, _) = entry.map_err(internal)?;
            // Index keys are owner‖night_utxo_hash(32) — the primary key of
            // dust_generation. Keyed by night_utxo_hash rather than the
            // ledger's recomputed generation_index/mt_index, which does not
            // reproduce the original leaf's index on a dtime update.
            let night_utxo_hash = &key[key.len() - 32..];
            let record: store::DustGenerationRecord = state
                .store
                .dust_generation
                .get(night_utxo_hash)
                .map_err(internal)?
                .map(|v| store::decode(&v))
                .ok_or_else(|| ApiError::internal("missing dust generation record"))?;
            // Exact-owner guard against byte-prefix collisions, like the other indexes.
            if record.info.owner != *owner || record.info.dtime != u64::MAX {
                continue;
            }
            if active
                .as_ref()
                .is_none_or(|current| record.info.ctime >= current.ctime)
            {
                active = Some(record.info);
            }
        }

        if let Some(info) = active {
            night_balance = info.value;

            // DUST generation rate = STAR * generation_decay_rate SPECK/second.
            generation_rate = info.value.saturating_mul(generation_decay_rate);

            // Maximum capacity (static cap) = STAR * night_dust_ratio.
            max_capacity = info.value.saturating_mul(night_dust_ratio);

            // Current capacity (time-dependent) = STAR * generation_decay_rate
            // * elapsed_seconds since ctime, capped at max_capacity. "Now" is
            // the latest indexed block's timestamp (milliseconds).
            let ctime = TimestampSecs(info.ctime);
            let now = state
                .store
                .tip_timestamp()
                .map_err(internal)?
                .map(TimestampMs)
                .unwrap_or(ctime.to_ms());
            let elapsed_seconds = now.elapsed_seconds_since(ctime.to_ms());
            current_capacity = info
                .value
                .saturating_mul(generation_decay_rate)
                .saturating_mul(elapsed_seconds as u128)
                .min(max_capacity);
        }
    }

    response(
        &state,
        DustGenerationStatusResponse {
            cardano_stake_key: const_hex::encode(stake_key),
            registered: registration.is_some(),
            dust_address: registration
                .as_ref()
                .map(|record| const_hex::encode(&record.dust_address)),
            night_balance: night_balance.to_string(),
            generation_rate: generation_rate.to_string(),
            current_capacity: current_capacity.to_string(),
            max_capacity: max_capacity.to_string(),
        },
    )
}
#[derive(Deserialize)]
pub struct ShieldedSyncRequest {
    pub viewing_key: String,
    #[serde(default)]
    pub from_index: u64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShieldedSyncUpdate {
    Collapsed {
        from_index: u64,
        to_index: u64,
        protocol_version: u32,
        update: String,
    },
    Transaction {
        from_index: u64,
        to_index: u64,
        protocol_version: u32,
        tx_id: u64,
        tx_hash: String,
        events: Vec<EventResponse>,
    },
}

#[derive(Serialize)]
pub struct ShieldedSyncResult {
    pub updates: Vec<ShieldedSyncUpdate>,
    pub applied_through: u64,
    pub highest_index: u64,
    pub scanned_transactions: u64,
}

fn wallet_relevance_key(viewing_hash: &[u8; 32], tx_id: u64) -> [u8; 40] {
    let mut key = [0u8; 40];
    key[..32].copy_from_slice(viewing_hash);
    key[32..].copy_from_slice(&tx_id.to_be_bytes());
    key
}

fn scan_wallet_relevance(
    store: &Store,
    viewing_hash: &[u8; 32],
    viewing_key: &[u8; 32],
    target_tx: u64,
) -> Result<(), String> {
    let mut scanned = store
        .wallet_scan_progress
        .get(viewing_hash)
        .map_err(|error| error.to_string())?
        .map(|value| u64::from_be_bytes(value.as_ref().try_into().expect("8-byte progress")))
        .unwrap_or(0);
    while scanned < target_tx {
        let batch_end = target_tx.min(scanned + 1_000);
        let mut batch = store.batch();
        for tx_id in scanned..batch_end {
            let tx = store
                .tx(tx_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("missing transaction {tx_id}"))?;
            if tx.variant != TransactionVariant::Regular {
                continue;
            }
            let index = store
                .wallet_tx_indices
                .get(tx_id.to_be_bytes())
                .map_err(|error| error.to_string())?
                .map(|value| store::decode::<WalletTxIndexRecord>(&value))
                .ok_or_else(|| format!("missing wallet transaction index {tx_id}"))?;
            let ledger_version = ProtocolVersion::try_from(index.protocol_version)
                .map_err(|error| error.to_string())?
                .ledger_version();
            if Transaction::deserialize(&tx.raw, ledger_version)
                .map_err(|error| error.to_string())?
                .relevant(viewing_key)
            {
                batch.insert(
                    &store.wallet_relevant_txs,
                    wallet_relevance_key(viewing_hash, tx_id),
                    [],
                );
            }
        }
        scanned = batch_end;
        batch.insert(
            &store.wallet_scan_progress,
            viewing_hash,
            scanned.to_be_bytes(),
        );
        batch.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Fast shielded-wallet bootstrap: only relevant transaction events cross the
/// wire; concise authenticated Merkle updates cover every irrelevant gap.
pub async fn wallet_shielded_sync(
    State(state): State<AppState>,
    Json(request): Json<ShieldedSyncRequest>,
) -> Result<(HeaderMap, Json<PointResponse<ShieldedSyncResult>>), ApiError> {
    let viewing_key_bytes = const_hex::decode(request.viewing_key.trim_start_matches("0x"))
        .map_err(|_| ApiError::bad_request("viewing_key must be hex-encoded"))?;
    let viewing_key = nightfrost_core::domain::ledger::viewing_key_repr(&viewing_key_bytes)
        .ok_or_else(|| {
            ApiError::bad_request(
                "viewing_key must be a raw 32-byte key or official SDK serialization",
            )
        })?;
    let viewing_hash: [u8; 32] = Sha256::digest(viewing_key).into();
    let tip = current_tip(&state)?;
    let target_tx = match tip.as_ref() {
        Some(tip) => {
            let block = state
                .store
                .block(tip.height)
                .map_err(internal)?
                .ok_or_else(|| ApiError::internal("indexed tip block is missing"))?;
            block.first_tx_id + u64::from(block.tx_count)
        }
        None => 0,
    };

    let scan_store = state.store.clone();
    let scan_lock = state.wallet_scan_lock.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = scan_lock
            .lock()
            .map_err(|_| "wallet scan lock poisoned".to_string())?;
        scan_wallet_relevance(&scan_store, &viewing_hash, &viewing_key, target_tx)
    })
    .await
    .map_err(internal)?
    .map_err(internal)?;

    if target_tx == 0 {
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok((
            headers,
            Json(PointResponse {
                results: ShieldedSyncResult {
                    updates: vec![],
                    applied_through: 0,
                    highest_index: 0,
                    scanned_transactions: 0,
                },
                tip: None,
            }),
        ));
    }

    // Anchor the response to the same transaction boundary used by the
    // relevance scan. The live pipeline may append another block while this
    // request is building its response; using the newest tree first-free
    // index here would skip relevance testing for that block.
    let highest_index = state
        .store
        .wallet_tx_indices
        .get((target_tx - 1).to_be_bytes())
        .map_err(internal)?
        .map(|value| store::decode::<WalletTxIndexRecord>(&value).zswap_end_index)
        .ok_or_else(|| ApiError::internal("missing wallet transaction index at sync boundary"))?;
    let window = state.store.ledger_state_window().map_err(internal)?;
    let (ledger_key, ledger_version) = window
        .0
        .last()
        .ok_or_else(|| ApiError::internal("wallet sync requires a persisted ledger state"))?;
    let ledger_state = LedgerState::load(ledger_key, (*ledger_version).into()).map_err(internal)?;
    if ledger_state.zswap_first_free() < highest_index {
        return Err(ApiError::internal(
            "persisted ledger state is behind the wallet sync boundary",
        ));
    }
    if request.from_index > highest_index {
        return Err(ApiError::bad_request("from_index is beyond the Zswap tree"));
    }
    let protocol_version = tip
        .as_ref()
        .and_then(|tip| state.store.block(tip.height).ok().flatten())
        .map(|block| block.protocol_version)
        .ok_or_else(|| ApiError::internal("indexed tip block is missing"))?;

    let mut updates = Vec::new();
    let mut applied_through = request.from_index;
    for entry in state.store.wallet_relevant_txs.prefix(viewing_hash) {
        let (key, _) = entry.map_err(internal)?;
        let tx_id = key_u64_suffix(&key);
        if tx_id >= target_tx {
            break;
        }
        let index = state
            .store
            .wallet_tx_indices
            .get(tx_id.to_be_bytes())
            .map_err(internal)?
            .map(|value| store::decode::<WalletTxIndexRecord>(&value))
            .ok_or_else(|| ApiError::internal("missing wallet transaction index"))?;
        if index.zswap_end_index <= applied_through {
            continue;
        }
        if index.zswap_start_index < applied_through {
            return Err(ApiError::bad_request(
                "from_index falls inside a relevant transaction",
            ));
        }
        if applied_through < index.zswap_start_index {
            updates.push(ShieldedSyncUpdate::Collapsed {
                from_index: applied_through,
                to_index: index.zswap_start_index,
                protocol_version,
                update: const_hex::encode(
                    ledger_state
                        .make_zswap_collapsed_update(applied_through, index.zswap_start_index - 1)
                        .map_err(internal)?,
                ),
            });
        }
        let tx = state
            .store
            .tx(tx_id)
            .map_err(internal)?
            .ok_or_else(|| ApiError::internal("missing relevant transaction"))?;
        let events = (tx.first_event_id..tx.first_event_id + u64::from(tx.event_count))
            .filter_map(|event_id| {
                let value = match state.store.ledger_events.get(event_id.to_be_bytes()) {
                    Ok(Some(value)) => value,
                    Ok(None) => {
                        return Some(Err(ApiError::internal("missing relevant event")));
                    }
                    Err(error) => return Some(Err(internal(error))),
                };
                let record: EventRecord = store::decode(&value);
                matches!(record.event.grouping, LedgerEventGrouping::Zswap)
                    .then(|| EventResponse::new(&state, event_id, record))
            })
            .collect::<Result<Vec<_>, _>>()?;
        updates.push(ShieldedSyncUpdate::Transaction {
            from_index: index.zswap_start_index,
            to_index: index.zswap_end_index,
            protocol_version: index.protocol_version,
            tx_id,
            tx_hash: const_hex::encode(tx.hash),
            events,
        });
        applied_through = index.zswap_end_index;
    }
    if applied_through < highest_index {
        updates.push(ShieldedSyncUpdate::Collapsed {
            from_index: applied_through,
            to_index: highest_index,
            protocol_version,
            update: const_hex::encode(
                ledger_state
                    .make_zswap_collapsed_update(applied_through, highest_index - 1)
                    .map_err(internal)?,
            ),
        });
        applied_through = highest_index;
    }

    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((
        headers,
        Json(PointResponse {
            results: ShieldedSyncResult {
                updates,
                applied_through,
                highest_index,
                scanned_transactions: target_tx,
            },
            tip: tip.as_ref().map(Into::into),
        }),
    ))
}

#[derive(Deserialize)]
pub struct DustSyncRequest {
    #[serde(default)]
    pub from: u64,
    #[serde(default = "wallet_events_default_count")]
    pub count: usize,
}

#[derive(Serialize)]
pub struct DustSyncResult {
    pub events: Vec<EventResponse>,
    pub scanned_through: u64,
    pub highest_event_id: u64,
}

/// Direct DUST-only replay feed backed by a side index.
pub async fn wallet_dust_sync(
    State(state): State<AppState>,
    Query(request): Query<DustSyncRequest>,
) -> Result<(HeaderMap, Json<PointResponse<DustSyncResult>>), ApiError> {
    if !(1..=50_000).contains(&request.count) {
        return Err(ApiError::bad_request(
            "count should be within range 1-50000",
        ));
    }
    let highest_event_id = state
        .store
        .next_id(meta_keys::NEXT_EVENT_ID)
        .map_err(internal)?;
    let mut events = Vec::new();
    for entry in state.store.wallet_dust_events.range((
        Bound::Included(request.from.to_be_bytes().to_vec()),
        Bound::Unbounded,
    )) {
        let (key, _) = entry.map_err(internal)?;
        let event_id = u64::from_be_bytes(key.as_ref().try_into().expect("8-byte event id"));
        let value = state
            .store
            .ledger_events
            .get(event_id.to_be_bytes())
            .map_err(internal)?
            .ok_or_else(|| ApiError::internal("missing DUST event"))?;
        events.push(EventResponse::new(&state, event_id, store::decode(&value))?);
        if events.len() == request.count {
            break;
        }
    }
    let scanned_through = events
        .last()
        .map(|event| event.id + 1)
        .unwrap_or(request.from);
    let scanned_through = if events.len() < request.count {
        highest_event_id
    } else {
        scanned_through
    };
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=2"));
    response(
        &state,
        DustSyncResult {
            events,
            scanned_through,
            highest_event_id,
        },
    )
    .map(|json| (headers, json))
}
