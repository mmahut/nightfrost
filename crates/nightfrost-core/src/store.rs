//! The fjall index store: one keyspace, one partition per entity plus
//! secondary-index partitions. Keys are fixed-width big-endian integers (or
//! raw hashes) so lexicographic order equals numeric order; values are
//! postcard-encoded records, except blobs already serialized by
//! midnight-serialize which stay opaque bytes.

use crate::domain::{
    ByteVec, ContractAttributes, ContractBalance, LedgerEvent, LedgerVersion, TransactionResult,
    TransactionVariant, UnshieldedUtxo, dust::DustGenerationInfo,
};
use fjall::{Batch, Keyspace, PartitionCreateOptions, PartitionHandle};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::path::Path;

/// Highest finalized block height seen on the node, shared between the chain
/// pipeline (writer) and the REST API (reader, for /sync-status).
pub type NodeTipHeight = std::sync::Arc<std::sync::RwLock<Option<u64>>>;

/// All fjall partitions, opened once at startup.
pub struct Store {
    pub keyspace: Keyspace,
    /// Store schema: 1 = state inlined per action, 2 = content-addressed
    /// contract_states + contract_actions_v2. Fresh stores start at
    /// SCHEMA_CURRENT; absence on a non-empty store means 1.
    pub schema: u64,
    pub meta: PartitionHandle,
    pub blocks: PartitionHandle,
    pub blocks_by_hash: PartitionHandle,
    pub txs: PartitionHandle,
    pub txs_by_hash: PartitionHandle,
    pub txs_by_identifier: PartitionHandle,
    pub utxos: PartitionHandle,
    pub utxos_unspent_by_owner: PartitionHandle,
    pub balances: PartitionHandle,
    pub addr_txs: PartitionHandle,
    /// Active contract-action records: the "contract_actions_v2" partition on
    /// a current-schema store, the legacy "contract_actions" partition on a
    /// schema-1 store opened for migration.
    pub contract_actions: PartitionHandle,
    pub contract_actions_by_addr: PartitionHandle,
    /// Content-addressed contract-state blobs (schema 2), key-value separated:
    /// values are large and immutable, so they live in the blob log instead of
    /// being rewritten by every LSM compaction.
    pub contract_states: PartitionHandle,
    pub contracts: PartitionHandle,
    pub ledger_events: PartitionHandle,
    pub events_by_contract: PartitionHandle,
    pub dust_generation: PartitionHandle,
    pub dust_gen_by_owner: PartitionHandle,
    pub cnight_registrations: PartitionHandle,
    /// Ledger arena (content-addressed merkle DAG), owned by FjallLedgerDb.
    pub ledger_db_nodes: PartitionHandle,
    pub ledger_db_roots: PartitionHandle,
}

pub mod meta_keys {
    pub const LAST_HEIGHT: &str = "last_indexed_height";
    pub const SCHEMA_VERSION: &str = "schema_version";
    pub const CONTRACT_STATES_BACKFILL_CURSOR: &str = "contract_states_backfill_cursor";
    pub const TIP_TIMESTAMP: &str = "tip_timestamp";
    pub const GENESIS_HASH: &str = "genesis_hash";
    pub const NEXT_TX_ID: &str = "next_tx_id";
    pub const NEXT_ACTION_ID: &str = "next_action_id";
    pub const NEXT_EVENT_ID: &str = "next_event_id";
    pub const LEDGER_STATE_WINDOW: &str = "ledger_state_window";
}

/// Rolling window of persisted ledger-state keys (oldest first), stored in
/// `meta` in the same batch as the entities of the block that produced them.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LedgerStateWindow(pub Vec<(ByteVec, StoredLedgerVersion)>);

/// LedgerVersion is a vendored type without serde; store it as a plain tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StoredLedgerVersion {
    V8,
    V9,
}

impl From<LedgerVersion> for StoredLedgerVersion {
    fn from(version: LedgerVersion) -> Self {
        match version {
            LedgerVersion::V8 => Self::V8,
            LedgerVersion::V9 => Self::V9,
        }
    }
}

impl From<StoredLedgerVersion> for LedgerVersion {
    fn from(version: StoredLedgerVersion) -> Self {
        match version {
            StoredLedgerVersion::V8 => Self::V8,
            StoredLedgerVersion::V9 => Self::V9,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockRecord {
    pub hash: [u8; 32],
    pub parent_hash: [u8; 32],
    pub timestamp: u64,
    pub protocol_version: u32,
    pub author: Option<[u8; 32]>,
    pub first_tx_id: u64,
    pub tx_count: u32,
    pub zswap_merkle_tree_root: ByteVec,
    pub ledger_state_root: Option<ByteVec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxRecord {
    pub hash: [u8; 32],
    pub block_height: u64,
    pub index_in_block: u32,
    pub variant: TransactionVariant,
    pub result: TransactionResult,
    pub paid_fees: u128,
    pub estimated_fees: u128,
    pub identifiers: Vec<ByteVec>,
    pub contract_action_ids: Vec<u64>,
    pub first_event_id: u64,
    pub event_count: u32,
    pub created_utxos: Vec<UnshieldedUtxo>,
    pub spent_utxos: Vec<UnshieldedUtxo>,
    pub raw: ByteVec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UtxoRecord {
    pub utxo: UnshieldedUtxo,
    pub creating_tx_id: u64,
    pub spending_tx_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractActionRecord {
    pub address: ByteVec,
    pub attributes: ContractAttributes,
    /// Content hash keying the state blob in `contract_states`; None marks a
    /// failed action (previously an empty state), which never becomes a
    /// contract's latest pointer.
    pub state_hash: Option<[u8; 32]>,
    pub balances: Vec<ContractBalance>,
    pub tx_id: u64,
    pub block_height: u64,
}

/// Schema-1 shape of `ContractActionRecord`, which inlined the full state
/// blob per action. Only the contract-states backfill decodes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyContractActionRecord {
    pub address: ByteVec,
    pub attributes: ContractAttributes,
    pub state: ByteVec,
    pub balances: Vec<ContractBalance>,
    pub tx_id: u64,
    pub block_height: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractRecord {
    pub deploy_action_id: u64,
    pub latest_action_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRecord {
    pub event: LedgerEvent,
    pub tx_id: u64,
    pub block_height: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DustGenerationRecord {
    pub info: DustGenerationInfo,
    pub tx_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CnightRegistrationRecord {
    pub cardano_stake_key: ByteVec,
    pub dust_address: ByteVec,
    pub valid: bool,
    pub registered_at_height: u64,
    pub removed_at_height: Option<u64>,
    pub utxo_id: Option<ByteVec>,
    pub utxo_index: Option<u64>,
}

pub fn encode<T: Serialize>(value: &T) -> Vec<u8> {
    postcard::to_stdvec(value).expect("postcard encode")
}

pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> T {
    postcard::from_bytes(bytes).expect("postcard decode")
}

/// Composite key: fixed prefix followed by a big-endian u64.
pub fn prefixed_u64_key(prefix: &[u8], id: u64) -> Vec<u8> {
    let mut key = Vec::with_capacity(prefix.len() + 8);
    key.extend_from_slice(prefix);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// The trailing big-endian u64 of a composite key.
pub fn key_u64_suffix(key: &[u8]) -> u64 {
    u64::from_be_bytes(key[key.len() - 8..].try_into().expect("8-byte suffix"))
}

/// UTXO id: intent_hash (32 bytes) followed by big-endian output index.
pub fn utxo_key(intent_hash: &[u8; 32], output_index: u32) -> [u8; 36] {
    let mut key = [0u8; 36];
    key[..32].copy_from_slice(intent_hash);
    key[32..].copy_from_slice(&output_index.to_be_bytes());
    key
}

/// Current store schema; see `Store::schema`.
pub const SCHEMA_CURRENT: u64 = 2;

/// Legacy name of the schema-1 inline-state partition, kept only so the
/// migration can read it and reclamation can delete it.
pub const LEGACY_CONTRACT_ACTIONS: &str = "contract_actions";

impl Store {
    pub fn open(path: impl AsRef<Path>) -> fjall::Result<Self> {
        // fjall 2.x halts ALL writes once the journal directory exceeds this
        // cap, expecting flushing to drain it. Its in-order journal eviction
        // can livelock behind a rarely-written partition (observed in
        // production during mainnet/preprod catch-up: journals piled up past
        // the 512 MiB default with the flusher idle, permanently halting the
        // pipeline). Raise the cap far above any realistic backlog; revisit
        // when upgrading to fjall 3, which rewrote the stall bookkeeping.
        let keyspace = fjall::Config::new(path)
            .max_journaling_size(32 * 1024 * 1024 * 1024)
            .open()?;
        let part = |name: &str| keyspace.open_partition(name, PartitionCreateOptions::default());

        // Schema detection before anything decodes records: a fresh store is
        // current by construction; a non-empty store without the version key
        // predates it and is schema 1. Callers gate on require_current_schema
        // so a legacy store is only ever decoded by the migration.
        let meta = part("meta")?;
        let stored_schema = meta
            .get(meta_keys::SCHEMA_VERSION)?
            .map(|v| u64::from_be_bytes(v.as_ref().try_into().expect("8-byte schema version")));
        let is_empty = meta.get(meta_keys::LAST_HEIGHT)?.is_none();
        let schema = match stored_schema {
            Some(v) => v,
            None if is_empty => {
                meta.insert(meta_keys::SCHEMA_VERSION, SCHEMA_CURRENT.to_be_bytes())?;
                SCHEMA_CURRENT
            }
            None => 1,
        };
        let contract_actions_name = if schema >= 2 {
            "contract_actions_v2"
        } else {
            LEGACY_CONTRACT_ACTIONS
        };
        let contract_states = keyspace.open_partition(
            "contract_states",
            PartitionCreateOptions::default()
                .with_kv_separation(fjall::KvSeparationOptions::default()),
        )?;

        Ok(Self {
            schema,
            contract_actions: part(contract_actions_name)?,
            contract_states,
            meta,
            blocks: part("blocks")?,
            blocks_by_hash: part("blocks_by_hash")?,
            txs: part("txs")?,
            txs_by_hash: part("txs_by_hash")?,
            txs_by_identifier: part("txs_by_identifier")?,
            utxos: part("utxos")?,
            utxos_unspent_by_owner: part("utxos_unspent_by_owner")?,
            balances: part("balances")?,
            addr_txs: part("addr_txs")?,
            contract_actions_by_addr: part("contract_actions_by_addr")?,
            contracts: part("contracts")?,
            ledger_events: part("ledger_events")?,
            events_by_contract: part("events_by_contract")?,
            dust_generation: part("dust_generation")?,
            dust_gen_by_owner: part("dust_gen_by_owner")?,
            cnight_registrations: part("cnight_registrations")?,
            ledger_db_nodes: part("ledger_db_nodes")?,
            ledger_db_roots: part("ledger_db_roots")?,
            keyspace,
        })
    }

    pub fn batch(&self) -> Batch {
        self.keyspace.batch()
    }

    /// Errors unless the store is on the current schema. Every entry point
    /// that decodes records calls this; only the contract-states backfill
    /// may operate on a legacy store.
    pub fn require_current_schema(&self) -> Result<(), String> {
        if self.schema == SCHEMA_CURRENT {
            Ok(())
        } else {
            Err(format!(
                "data directory is on store schema {} (current is {}); run \
                 `nightfrost --backfill-contract-states` with the indexer stopped to migrate",
                self.schema, SCHEMA_CURRENT,
            ))
        }
    }

    /// Every partition, for whole-store maintenance sweeps.
    pub fn partitions(&self) -> [&PartitionHandle; 21] {
        [
            &self.meta,
            &self.blocks,
            &self.blocks_by_hash,
            &self.txs,
            &self.txs_by_hash,
            &self.txs_by_identifier,
            &self.utxos,
            &self.utxos_unspent_by_owner,
            &self.balances,
            &self.addr_txs,
            &self.contract_actions,
            &self.contract_actions_by_addr,
            &self.contract_states,
            &self.contracts,
            &self.ledger_events,
            &self.events_by_contract,
            &self.dust_generation,
            &self.dust_gen_by_owner,
            &self.cnight_registrations,
            &self.ledger_db_nodes,
            &self.ledger_db_roots,
        ]
    }

    /// Unsticks fjall's flushing when a journal backlog exists. fjall's
    /// flusher only wakes when a memtable is sealed, and sealing normally
    /// happens on the write path; after recovering a large journal backlog
    /// with writes halted (buffer saturation or journal cap), nothing ever
    /// seals, so the halt never lifts (observed livelocking production
    /// mainnet and preprod). Rotating every partition seals whatever is
    /// stagnant, wakes the flusher, and lets sealed journals evict; each
    /// rotation is a no-op for empty memtables.
    pub fn unstick_flushing(&self) -> fjall::Result<()> {
        for partition in self.partitions() {
            partition.rotate_memtable()?;
        }
        Ok(())
    }

    /// Journal files currently retained by the keyspace.
    pub fn journal_count(&self) -> usize {
        self.keyspace.journal_count()
    }

    fn meta_u64(&self, key: &str) -> fjall::Result<Option<u64>> {
        Ok(self
            .meta
            .get(key)?
            .map(|v| u64::from_be_bytes(v.as_ref().try_into().expect("8-byte meta value"))))
    }

    pub fn last_indexed_height(&self) -> fjall::Result<Option<u64>> {
        self.meta_u64(meta_keys::LAST_HEIGHT)
    }

    pub fn tip_timestamp(&self) -> fjall::Result<Option<u64>> {
        self.meta_u64(meta_keys::TIP_TIMESTAMP)
    }

    pub fn next_id(&self, key: &str) -> fjall::Result<u64> {
        Ok(self.meta_u64(key)?.unwrap_or(0))
    }

    pub fn ledger_state_window(&self) -> fjall::Result<LedgerStateWindow> {
        Ok(self
            .meta
            .get(meta_keys::LEDGER_STATE_WINDOW)?
            .map(|v| decode(&v))
            .unwrap_or_default())
    }

    pub fn block(&self, height: u64) -> fjall::Result<Option<BlockRecord>> {
        Ok(self.blocks.get(height.to_be_bytes())?.map(|v| decode(&v)))
    }

    pub fn block_height_by_hash(&self, hash: &[u8]) -> fjall::Result<Option<u64>> {
        Ok(self
            .blocks_by_hash
            .get(hash)?
            .map(|v| u64::from_be_bytes(v.as_ref().try_into().expect("8-byte height"))))
    }

    pub fn tx(&self, tx_id: u64) -> fjall::Result<Option<TxRecord>> {
        Ok(self.txs.get(tx_id.to_be_bytes())?.map(|v| decode(&v)))
    }

    /// Transaction ids for a hash (hashes are not unique across blocks).
    pub fn tx_ids_by_hash(&self, hash: &[u8; 32]) -> fjall::Result<Vec<u64>> {
        self.txs_by_hash
            .prefix(hash)
            .map(|entry| entry.map(|(key, _)| key_u64_suffix(&key)))
            .collect()
    }

    /// Transaction ids containing an identifier (identifiers are not unique
    /// across chain history).
    pub fn tx_ids_by_identifier(&self, identifier: &[u8]) -> fjall::Result<Vec<u64>> {
        self.txs_by_identifier
            .prefix(identifier)
            .map(|entry| entry.map(|(key, _)| key_u64_suffix(&key)))
            .collect()
    }
}
