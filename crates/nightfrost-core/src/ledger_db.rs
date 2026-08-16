// Fjall-backed implementation of midnight-storage-core's `DB` trait: the
// content-addressed arena (merkle DAG node store + root refcounts) behind
// `LedgerState`. Replaces midnight-indexer's sqlx-based
// indexer-common/src/infra/ledger_db/v1_1.rs — the trait is synchronous and so
// is fjall, so no async bridging is needed.

use fjall::{Keyspace, PartitionHandle};
use midnight_serialize_v1::{Deserializable, Serializable};
use midnight_storage_core_v1::{
    DefaultHasher,
    arena::ArenaHash,
    backend::OnDiskObject,
    db::{DB, DummyArbitrary, Update},
};
use std::{collections::HashMap, fmt, ops::Bound};

pub struct FjallLedgerDb {
    keyspace: Keyspace,
    nodes: PartitionHandle,
    roots: PartitionHandle,
}

impl FjallLedgerDb {
    pub fn new(keyspace: Keyspace, nodes: PartitionHandle, roots: PartitionHandle) -> Self {
        Self {
            keyspace,
            nodes,
            roots,
        }
    }
}

/// Register the process-global ledger storage. Must be called exactly once,
/// before any `LedgerState` use.
pub fn init(cache_max_nodes: usize, db: FjallLedgerDb) {
    let _ = midnight_storage_core_v1::storage::set_default_storage(|| {
        midnight_storage_core_v1::Storage::new(cache_max_nodes, db)
    });
}

impl fmt::Debug for FjallLedgerDb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FjallLedgerDb").finish_non_exhaustive()
    }
}

fn serialize_object(object: &OnDiskObject<DefaultHasher>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(object.serialized_size());
    Serializable::serialize(object, &mut bytes).expect("cannot serialize OnDiskObject");
    bytes
}

fn deserialize_object(bytes: &[u8]) -> OnDiskObject<DefaultHasher> {
    OnDiskObject::deserialize(&mut &*bytes, 0).expect("cannot deserialize OnDiskObject")
}

fn deserialize_hash(bytes: &[u8]) -> ArenaHash<DefaultHasher> {
    ArenaHash::deserialize(&mut &*bytes, 0).expect("cannot deserialize ArenaHash")
}

impl DB for FjallLedgerDb {
    type Hasher = DefaultHasher;
    type ScanResumeHandle = ArenaHash<DefaultHasher>;

    fn get_node(&self, key: &ArenaHash<Self::Hasher>) -> Option<OnDiskObject<Self::Hasher>> {
        self.nodes
            .get(&key.0[..])
            .expect("cannot get node")
            .map(|bytes| deserialize_object(&bytes))
    }

    fn insert_node(&mut self, key: ArenaHash<Self::Hasher>, object: OnDiskObject<Self::Hasher>) {
        self.nodes
            .insert(&key.0[..], serialize_object(&object))
            .expect("cannot insert node");
    }

    fn delete_node(&mut self, key: &ArenaHash<Self::Hasher>) {
        self.nodes.remove(&key.0[..]).expect("cannot delete node");
    }

    fn batch_update<I>(&mut self, updates: I)
    where
        I: Iterator<Item = (ArenaHash<Self::Hasher>, Update<Self::Hasher>)>,
    {
        let mut batch = self.keyspace.batch();
        for (key, update) in updates {
            match update {
                Update::InsertNode(object) => {
                    batch.insert(&self.nodes, &key.0[..], serialize_object(&object));
                }
                Update::DeleteNode => {
                    batch.remove(&self.nodes, &key.0[..]);
                }
                Update::SetRootCount(0) => {
                    batch.remove(&self.roots, &key.0[..]);
                }
                Update::SetRootCount(count) => {
                    batch.insert(&self.roots, &key.0[..], count.to_be_bytes());
                }
            }
        }
        batch.commit().expect("cannot commit ledger-db batch");
    }

    fn batch_get_nodes<I>(
        &self,
        keys: I,
    ) -> Vec<(ArenaHash<Self::Hasher>, Option<OnDiskObject<Self::Hasher>>)>
    where
        I: Iterator<Item = ArenaHash<Self::Hasher>>,
    {
        keys.map(|key| {
            let node = self.get_node(&key);
            (key, node)
        })
        .collect()
    }

    fn get_root_count(&self, key: &ArenaHash<Self::Hasher>) -> u32 {
        // Must return the stored count, not row existence; under-reading makes
        // storage-core's flush (stored + delta) drive counts negative.
        self.roots
            .get(&key.0[..])
            .expect("cannot get root count")
            .map_or(0, |bytes| {
                u32::from_be_bytes(bytes.as_ref().try_into().expect("4-byte root count"))
            })
    }

    fn set_root_count(&mut self, key: ArenaHash<Self::Hasher>, count: u32) {
        if count > 0 {
            self.roots
                .insert(&key.0[..], count.to_be_bytes())
                .expect("cannot set root count");
        } else {
            self.roots
                .remove(&key.0[..])
                .expect("cannot delete root count");
        }
    }

    fn get_roots(&self) -> HashMap<ArenaHash<Self::Hasher>, u32> {
        self.roots
            .iter()
            .map(|entry| {
                let (key, value) = entry.expect("cannot iterate roots");
                let count = u32::from_be_bytes(value.as_ref().try_into().expect("4-byte count"));
                (deserialize_hash(&key), count)
            })
            .collect()
    }

    fn size(&self) -> usize {
        // Only used by gc for stats; an estimate is fine.
        self.nodes.approximate_len()
    }

    fn scan(
        &self,
        resume_from: Option<Self::ScanResumeHandle>,
        batch_size: usize,
    ) -> (
        Vec<(ArenaHash<Self::Hasher>, OnDiskObject<Self::Hasher>)>,
        Option<Self::ScanResumeHandle>,
    ) {
        let lower = match resume_from.as_ref() {
            Some(handle) => Bound::Excluded(handle.0.to_vec()),
            None => Bound::Unbounded,
        };

        let batch = self
            .nodes
            .range((lower, Bound::<Vec<u8>>::Unbounded))
            .take(batch_size)
            .map(|entry| {
                let (key, value) = entry.expect("cannot scan nodes");
                (deserialize_hash(&key), deserialize_object(&value))
            })
            .collect::<Vec<_>>();

        let next_handle = batch.last().map(|(key, _)| key.clone());

        (batch, next_handle)
    }
}

impl Default for FjallLedgerDb {
    fn default() -> Self {
        panic!("FjallLedgerDb cannot be constructed by default");
    }
}

impl DummyArbitrary for FjallLedgerDb {}

#[cfg(test)]
mod tests {
    use super::*;
    use midnight_storage_core_v1::Storage;

    fn arena_hash(bytes: [u8; 32]) -> ArenaHash<DefaultHasher> {
        ArenaHash::deserialize(&mut bytes.as_slice(), 0).expect("32 bytes are an ArenaHash")
    }

    fn test_db() -> (tempfile::TempDir, FjallLedgerDb) {
        let dir = tempfile::tempdir().expect("tempdir");
        let keyspace = fjall::Config::new(dir.path())
            .open()
            .expect("open keyspace");
        let nodes = keyspace
            .open_partition("ledger_db_nodes", Default::default())
            .expect("open nodes");
        let roots = keyspace
            .open_partition("ledger_db_roots", Default::default())
            .expect("open roots");
        (dir, FjallLedgerDb::new(keyspace, nodes, roots))
    }

    /// Ported from midnight-indexer's v1_1.rs regression suite.
    #[test]
    fn get_root_count_returns_stored_count_not_row_count() {
        let (_dir, mut db) = test_db();
        let key = arena_hash([0xaa; 32]);
        let other_key = arena_hash([0xbb; 32]);

        assert_eq!(db.get_root_count(&key), 0, "missing key is not a root");

        db.set_root_count(key.clone(), 7);
        db.set_root_count(other_key.clone(), 1);
        assert_eq!(db.get_root_count(&key), 7);
        assert_eq!(db.get_root_count(&other_key), 1);

        db.set_root_count(key.clone(), 0);
        assert_eq!(db.get_root_count(&key), 0, "count 0 deletes the row");
        assert_eq!(db.get_root_count(&other_key), 1);
    }

    #[test]
    fn scan_empty_db_returns_no_rows_and_no_handle() {
        let (_dir, db) = test_db();

        let (batch, handle) = db.scan(None, 100);
        assert!(batch.is_empty());
        assert!(handle.is_none());

        let (batch, handle) = db.scan(Some(ArenaHash::default()), 50);
        assert!(batch.is_empty());
        assert!(handle.is_none());
    }

    /// Root counts must accumulate across persists, and balanced unpersist
    /// must bring them back to zero (ported from v1_1.rs).
    #[test]
    fn persist_unpersist_root_counts() {
        const PERSISTS: u32 = 5;

        let (_dir, db) = test_db();
        let roots_partition = db.roots.clone();
        let storage = Storage::new(16, db);

        let mut root = storage.alloc(42u32);
        for _ in 0..PERSISTS {
            root.persist();
            storage.with_backend(|backend| backend.flush_all_changes_to_db());
        }
        let stored = roots_partition
            .get(&root.hash().0[..])
            .expect("get root count")
            .map(|v| u32::from_be_bytes(v.as_ref().try_into().expect("4 bytes")));
        assert_eq!(stored, Some(PERSISTS));

        for _ in 0..PERSISTS {
            root.unpersist();
            storage.with_backend(|backend| backend.flush_all_changes_to_db());
        }
        let stored = roots_partition
            .get(&root.hash().0[..])
            .expect("get root count");
        assert!(stored.is_none(), "no longer a root");
    }

    #[test]
    fn scan_pages_through_all_nodes_in_key_order() {
        let (_dir, db) = test_db();
        let scanner = FjallLedgerDb::new(db.keyspace.clone(), db.nodes.clone(), db.roots.clone());
        let storage = Storage::new(16, db);

        for i in 0..10u32 {
            let mut root = storage.alloc(i);
            root.persist();
        }
        storage.with_backend(|backend| backend.flush_all_changes_to_db());
        let expected = scanner.nodes.len().expect("count nodes");
        assert!(expected >= 10);

        let mut seen: Vec<Vec<u8>> = vec![];
        let mut resume = None;
        loop {
            let (batch, handle) = scanner.scan(resume.clone(), 3);
            if batch.is_empty() {
                break;
            }
            seen.extend(batch.into_iter().map(|(k, _)| k.0.to_vec()));
            resume = handle;
        }

        assert_eq!(seen.len(), expected);
        let mut sorted = seen.clone();
        sorted.sort();
        assert_eq!(seen, sorted, "scan yields key order");
    }
}
