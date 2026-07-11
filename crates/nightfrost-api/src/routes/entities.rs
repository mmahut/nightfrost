//! Transaction, address, contract, dust and ledger-event endpoints.

use super::{ApiState, internal, paginate};
use crate::{error::ApiError, pagination::Pagination};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use nightfrost_core::{
    domain::{LedgerEventAttributes, LedgerEventGrouping, TransactionResult, TransactionVariant, UnshieldedUtxo},
    store::{self, CnightRegistrationRecord, ContractActionRecord, EventRecord, TxRecord, key_u64_suffix},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
    pub hash: String,
    pub block_height: u64,
    pub block_hash: String,
    pub block_time: u64,
    pub index: u32,
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

pub async fn tx(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<TxResponse>, ApiError> {
    let (_, record) = tx_by_hash(&state, &hash)?;
    let block = state
        .store
        .block(record.block_height)
        .map_err(internal)?
        .ok_or_else(|| ApiError::internal("missing block for tx"))?;
    let (status, segments) = tx_status(&record.result);

    Ok(Json(TxResponse {
        hash: const_hex::encode(record.hash),
        block_height: record.block_height,
        block_hash: const_hex::encode(block.hash),
        block_time: block.timestamp,
        index: record.index_in_block,
        variant: record.variant,
        status,
        segments,
        paid_fees: record.paid_fees.to_string(),
        estimated_fees: record.estimated_fees.to_string(),
        identifiers: record.identifiers.iter().map(|i| const_hex::encode(i)).collect(),
        utxo_created_count: record.created_utxos.len(),
        utxo_spent_count: record.spent_utxos.len(),
        event_count: record.event_count,
        contract_action_count: record.contract_action_ids.len(),
    }))
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
) -> Result<Json<TxUtxosResponse>, ApiError> {
    let (_, record) = tx_by_hash(&state, &hash)?;
    Ok(Json(TxUtxosResponse {
        hash: const_hex::encode(record.hash),
        inputs: record.spent_utxos.iter().map(Into::into).collect(),
        outputs: record.created_utxos.iter().map(Into::into).collect(),
    }))
}

#[derive(Serialize)]
pub struct EventResponse {
    pub id: u64,
    pub grouping: LedgerEventGrouping,
    pub attributes: LedgerEventAttributes,
    pub raw: String,
    pub tx_id: u64,
    pub block_height: u64,
}

impl EventResponse {
    fn new(id: u64, record: EventRecord) -> Self {
        Self {
            id,
            grouping: record.event.grouping,
            raw: const_hex::encode(&record.event.raw),
            attributes: record.event.attributes,
            tx_id: record.tx_id,
            block_height: record.block_height,
        }
    }
}

pub async fn tx_events(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<Vec<EventResponse>>, ApiError> {
    let (_, record) = tx_by_hash(&state, &hash)?;
    let events = (record.first_event_id..record.first_event_id + record.event_count as u64)
        .map(|event_id| {
            state
                .store
                .ledger_events
                .get(event_id.to_be_bytes())
                .map_err(internal)?
                .map(|v| EventResponse::new(event_id, store::decode(&v)))
                .ok_or_else(|| ApiError::internal("missing event record"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(events))
}

#[derive(Serialize)]
pub struct BalanceResponse {
    pub token_type: String,
    pub amount: String,
}

pub async fn address_balances(
    State(state): State<AppState>,
    Path(addr): Path<String>,
) -> Result<Json<Vec<BalanceResponse>>, ApiError> {
    let owner = parse_addr32(&addr)?;
    let balances = state
        .store
        .balances
        .prefix(owner)
        .map(|entry| {
            let (key, value) = entry.map_err(internal)?;
            Ok(BalanceResponse {
                token_type: const_hex::encode(&key[32..64]),
                amount: u128::from_be_bytes(
                    value.as_ref().try_into().expect("16-byte balance"),
                )
                .to_string(),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(balances))
}

#[derive(Deserialize)]
pub struct UtxoFilter {
    pub token_type: Option<String>,
}

pub async fn address_utxos(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(pagination): Query<Pagination>,
    Query(filter): Query<UtxoFilter>,
) -> Result<Json<Vec<UtxoResponse>>, ApiError> {
    pagination.validate().map_err(ApiError::bad_request)?;
    let owner = parse_addr32(&addr)?;

    let mut prefix = owner.to_vec();
    if let Some(token_type) = &filter.token_type {
        let token: [u8; 32] = const_hex::decode(token_type)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| ApiError::bad_request("invalid token_type"))?;
        prefix.extend_from_slice(&token);
    }

    let utxo_keys = state
        .store
        .utxos_unspent_by_owner
        .prefix(prefix)
        .map(|entry| entry.map(|(_, utxo_key)| utxo_key).map_err(internal))
        .collect::<Result<Vec<_>, _>>()?;

    let page = paginate(utxo_keys, &pagination);
    let utxos = page
        .into_iter()
        .map(|key| {
            let record: store::UtxoRecord = state
                .store
                .utxos
                .get(&key)
                .map_err(internal)?
                .map(|v| store::decode(&v))
                .ok_or_else(|| ApiError::internal("missing utxo record"))?;
            Ok(UtxoResponse::from(&record.utxo))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(utxos))
}

pub async fn address_txs(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<Vec<String>>, ApiError> {
    pagination.validate().map_err(ApiError::bad_request)?;
    let owner = parse_addr32(&addr)?;

    let tx_ids = state
        .store
        .addr_txs
        .prefix(owner)
        .map(|entry| entry.map(|(key, _)| key_u64_suffix(&key)).map_err(internal))
        .collect::<Result<Vec<_>, _>>()?;

    let page = paginate(tx_ids, &pagination);
    let hashes = page
        .into_iter()
        .map(|tx_id| {
            let record = state
                .store
                .tx(tx_id)
                .map_err(internal)?
                .ok_or_else(|| ApiError::internal("missing tx record"))?;
            Ok(const_hex::encode(record.hash))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(hashes))
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
) -> Result<Json<ContractResponse>, ApiError> {
    let address = parse_contract_addr(&addr)?;
    let record: store::ContractRecord = state
        .store
        .contracts
        .get(&address)
        .map_err(internal)?
        .map(|v| store::decode(&v))
        .ok_or_else(|| ApiError::not_found("contract not found"))?;
    let latest = contract_action(&state, record.latest_action_id)?;

    Ok(Json(ContractResponse {
        address: const_hex::encode(&address),
        deploy_action_id: record.deploy_action_id,
        latest_action_id: record.latest_action_id,
        latest_action_type: action_type(&latest),
        latest_block_height: latest.block_height,
        balances: latest
            .balances
            .iter()
            .map(|b| BalanceResponse {
                token_type: const_hex::encode(b.token_type.0),
                amount: b.amount.to_string(),
            })
            .collect(),
    }))
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
) -> Result<Json<ContractStateResponse>, ApiError> {
    let address = parse_contract_addr(&addr)?;
    let record: store::ContractRecord = state
        .store
        .contracts
        .get(&address)
        .map_err(internal)?
        .map(|v| store::decode(&v))
        .ok_or_else(|| ApiError::not_found("contract not found"))?;
    let latest = contract_action(&state, record.latest_action_id)?;

    Ok(Json(ContractStateResponse {
        address: const_hex::encode(&address),
        block_height: latest.block_height,
        state: const_hex::encode(&latest.state),
    }))
}

#[derive(Serialize)]
pub struct ContractActionResponse {
    pub id: u64,
    pub r#type: String,
    pub entry_point: Option<String>,
    pub tx_hash: String,
    pub block_height: u64,
}

pub async fn contract_actions(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<Vec<ContractActionResponse>>, ApiError> {
    pagination.validate().map_err(ApiError::bad_request)?;
    let address = parse_contract_addr(&addr)?;

    let action_ids = state
        .store
        .contract_actions_by_addr
        .prefix(address)
        .map(|entry| entry.map(|(key, _)| key_u64_suffix(&key)).map_err(internal))
        .collect::<Result<Vec<_>, _>>()?;

    let page = paginate(action_ids, &pagination);
    let actions = page
        .into_iter()
        .map(|action_id| {
            let record = contract_action(&state, action_id)?;
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
            Ok(ContractActionResponse {
                id: action_id,
                r#type: action_type(&record),
                entry_point,
                tx_hash: const_hex::encode(tx.hash),
                block_height: record.block_height,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(actions))
}

#[derive(Deserialize)]
pub struct EventCursor {
    #[serde(default)]
    pub from: u64,
    #[serde(default = "default_event_count")]
    pub count: usize,
}

fn default_event_count() -> usize {
    100
}

#[derive(Serialize)]
pub struct LedgerEventsResponse {
    pub events: Vec<EventResponse>,
    pub next_cursor: Option<u64>,
}

pub async fn ledger_events(
    State(state): State<AppState>,
    Query(cursor): Query<EventCursor>,
) -> Result<Json<LedgerEventsResponse>, ApiError> {
    let count = cursor.count.min(1000);
    let events = state
        .store
        .ledger_events
        .range(cursor.from.to_be_bytes()..)
        .take(count)
        .map(|entry| {
            let (key, value) = entry.map_err(internal)?;
            let id = u64::from_be_bytes(key.as_ref().try_into().expect("8-byte event id"));
            Ok(EventResponse::new(id, store::decode(&value)))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let next_cursor = events.last().map(|event| event.id + 1);
    Ok(Json(LedgerEventsResponse { events, next_cursor }))
}

#[derive(Deserialize)]
pub struct RegistrationFilter {
    pub stake_key: Option<String>,
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
    State(state): State<AppState>,
    Query(pagination): Query<Pagination>,
    Query(filter): Query<RegistrationFilter>,
) -> Result<Json<Vec<RegistrationResponse>>, ApiError> {
    pagination.validate().map_err(ApiError::bad_request)?;

    let prefix = match &filter.stake_key {
        Some(stake_key) => const_hex::decode(stake_key)
            .map_err(|_| ApiError::bad_request("invalid stake_key (hex)"))?,
        None => vec![],
    };

    let records = state
        .store
        .cnight_registrations
        .prefix(prefix)
        .map(|entry| {
            let (_, value) = entry.map_err(internal)?;
            let record: CnightRegistrationRecord = store::decode(&value);
            Ok(RegistrationResponse {
                cardano_stake_key: const_hex::encode(&record.cardano_stake_key),
                dust_address: const_hex::encode(&record.dust_address),
                valid: record.valid,
                registered_at_height: record.registered_at_height,
                removed_at_height: record.removed_at_height,
                utxo_id: record.utxo_id.as_deref().map(const_hex::encode),
                utxo_index: record.utxo_index,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    Ok(Json(paginate(records, &pagination)))
}
