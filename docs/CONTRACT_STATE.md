# Contract state: storage and API design

Status: proposal, 2026-08-16. Prompted by a production incident on preprod.
Revised after review — see "Review revisions" at the end for what changed and why.

## The problem

On 2026-08-16 all three production indexers entered a crash loop. The chain was:
the root filesystem hit 100%, fjall's journal flush failed with
`Os { code: 28, kind: StorageFull }`, that poisoned the mutex guarding the
ledger-db batch, and the next commit panicked at `nightfrost-core/src/ledger_db.rs:103`
(`cannot commit ledger-db batch: Poisoned`). systemd restarted each unit, the
same thing happened again — 26-29 restarts per unit, with intermittent 502s at
the edge whenever a request landed in a dead window.

The disk pressure came from one partition (sizes are physical, i.e. already
LZ4-compressed — see "Compression is already on"):

| Partition | preprod (1.08M blocks) | mainnet (2.12M blocks) |
|---|---|---|
| `contract_actions` | **125 GB** | 9.9 GB |
| `ledger_db_nodes` (arena) | 55 GB | 67 GB |
| everything else | ~2 GB | ~2 GB |
| **total data dir** | **182 GB** | 74 GB |

The arena is comparable between networks, so this is not general chain growth.
`contract_actions` costs preprod ~116 KB/block versus mainnet's ~4.7 KB/block —
**25× per block, for half the blocks.**

The disk has since been resized 315 GB → 394 GB (117 GB free), which stopped the
bleeding but does not solve it. preprod is at 1.08M of 2.13M blocks; finishing
the sync means roughly another 1.05M blocks at ~116 KB each, so **~122 GB more
in `contract_actions` alone**, plus arena growth. preprod alone projects to
~320-360 GB against 117 GB free. **preprod cannot complete its sync on the
current disk without a storage change.** That is why this is worth doing now
rather than filing away.

## Why the data is so large

Every contract action stores a complete copy of the contract state.
`crates/nightfrost-chain/src/pipeline.rs:555` builds each record with
`state: action.state.clone()`, and that blob comes from the node's
`get_contract_state(address, block)` runtime call
(`crates/nightfrost-chain/src/subxt_node.rs:832`) — fetched **per action, at
that block**.

Two consequences compound:

1. Several actions against the same contract **in one block** each store a
   byte-identical copy of that block's state.
2. A contract called across many blocks **without a meaningful state change**
   stores near-identical copies every time.

preprod evidently has a heavily-called contract with a large state. Nothing is
wrong with the replay; the storage schema simply pays full price per action.

## What is served today

Only the newest state is ever returned:

- `GET /contracts/{addr}/state` reads `record.latest_action_id` and hex-encodes
  that one action's state (`crates/nightfrost-api/src/routes/entities.rs:630`).
  It is the **only** reader of the field.
- `GET /contracts/{addr}/actions` returns `ContractActionResponse`
  (`entities.rs:636`) — id, type, entry point, tx hash, block height. **No state.**
- `GET /contracts/{addr}` returns the latest action's metadata and balances.

So today's 125 GB of historical blobs is written and never read.

## Why we keep the history anyway

Deleting all but the latest state would reclaim essentially the whole partition,
and it is tempting. It is the wrong call:

- `docs/PARITY.md:149` and `:179` deliberately bank on those blobs for a planned
  `contract state as of an arbitrary block height` endpoint, explicitly noted as
  **"API-layer only: latest action ≤ height, no resync"**. Discarding the blobs
  converts a cheap future feature into one that needs a full re-sync.
- The capability is the point of the API, not an extra. The official indexer
  serves `contractAction(address, offset)` (`PARITY.md:14`), and reading a
  contract's state at a block is the primitive a DApp provider is built on:
  read state at a point, build a transaction against it. An indexer that can
  only answer "state right now" is not usable for that.

So: keep the history, stop storing it naively.

## What granularity we can honestly offer

This constrains the API and must be stated before the endpoint shapes.

State is fetched from the runtime **at the containing block**
(`subxt_node.rs:830`), so what we hold for any action is that block's
**end-of-block** state. Several actions in one block therefore share one
snapshot, and we cannot reconstruct the intermediate state between two actions
in the same block. Every selector below resolves to an *action*, and the state
returned is that action's containing-block snapshot. Responses say so via a
dedicated field rather than implying per-transaction granularity.

Separately, transaction hashes are **not unique** — `txs_by_hash` is a
`hash‖tx_id` composite for exactly that reason — so a transaction selector
resolves to the latest occurrence, consistent with existing transaction lookups.

This has a sharp consequence for the transaction selector. If transactions A and
B sit in the same block and both touch the contract, the state stored against
action A **already includes B's effect**, because it is end-of-block state.
Returning `action_id: A` next to that blob would be internally inconsistent no
matter how the granularity is labelled. So `?tx=` is defined as a **delegation**:
resolve the transaction to its containing block, then apply the block selector.
The action returned may therefore sit *after* the transaction asked about, within
the same block. That keeps offset parity with the official indexer while never
pairing an action id with a state that does not correspond to it.

## Proposed API surface

### 1. One state resource with offset selectors

```
GET /api/v0/contracts/{addr}/state                 → latest
GET /api/v0/contracts/{addr}/state?height=120000   → as of a block height
GET /api/v0/contracts/{addr}/state?block=<hash>    → as of a block hash
GET /api/v0/contracts/{addr}/state?tx=<hash>       → containing block of that tx
```

All resolve the same way: the newest action for that address at or before the
offset, **skipping failed actions** (those carry no state — see the
`state.is_empty()` guard at `pipeline.rs:710`). `?tx=` first maps the
transaction to its containing block, then behaves exactly as `?block=`; the
resulting `action_id` may belong to a later transaction in that block. They
belong on one resource
rather than three sibling paths; `PARITY.md:179` sketched
`/contracts/{addr}/state/{height}`, but height is only one of three offset kinds
and the path form would need a route per kind. Selectors are mutually exclusive;
supplying more than one is a `400`.

Response uses `PointResponse` (`routes.rs:56`), which **omits** `next_cursor`
rather than sending it null:

```json
{
  "results": {
    "address": "0042ee…1299",
    "action_id": 730,
    "block_height": 120000,
    "tx_hash": "8f54…",
    "state_hash": "9c3b…",
    "state_at": "end_of_block",
    "state": "0d2f…"
  },
  "tip": { "hash": "ab12…", "height": 185518 }
}
```

`state_at: "end_of_block"` is deliberately explicit so clients are never misled
into assuming transaction-level granularity.

### 2. Expose `state_hash`, and give it its own immutable resource

Content-addressing the blobs (below) gives every state a stable identity for
free. Surfacing it is what makes the API usable for wallets — but it must be
attached to the right resource:

- Include `state_hash` in the small `GET /contracts/{addr}` response and in
  action rows. A wallet polls the cheap endpoint, compares the hash, and fetches
  the multi-megabyte blob **only when it actually changed**.
- Add `GET /api/v0/contract-states/{state_hash}` — a **state-only, immutable**
  resource. Its representation is exactly the blob, addressed by its own content
  hash, so it can never change: the ideal thing to cache.

**All caching lives in nginx, none in the Rust code.** The application sets no
`ETag`, no `Cache-Control`, and implements no conditional-request or `304`
handling; the API stays a plain origin and the caching tier is configuration.
See §4 for the policy.

That constraint is a good fit here rather than a compromise. For a
content-addressed resource, `Cache-Control: public, max-age=31536000, immutable`
is strictly better than `ETag`/`If-None-Match`: a revalidating client still pays
a round trip to be told "unchanged", whereas an immutable long-lived entry means
the client **never asks again**. The metadata endpoint in (1) is where an ETag
would have been actively wrong anyway — `action_id`, `block_height` and
`tx_hash` all change when a contract is called without changing state, so a
`304` keyed on `state_hash` would have claimed an unchanged representation that
had in fact changed. Splitting the immutable blob onto its own resource removes
the question entirely.

### 3. `state_hash` in the action list

Keep `GET /contracts/{addr}/actions` lean — full blobs in a 100-item page would
be brutal — but add `state_hash` per row. Thirty-two bytes per item lets a
developer page a contract's history and see exactly which calls changed state,
then fetch only those (via the immutable resource above, which caches). Add a
point lookup for the full record:

```
GET /api/v0/contract-actions/{id}   → one action including its state
```

Top-level rather than nested, matching the existing `/tx-identifiers/{identifier}`
resolver, since action ids are globally unique.

### 4. nginx: compression and the entire caching policy

Ops-side, in the nightfrost-ops repo. Two separate jobs:

**gzip for `/api/v0`.** Hex is 100% encoding overhead and compresses very well.
No API change, and it lands on exactly the responses that hurt.

**Caching.** By project rule, caching is nginx's responsibility and must not
appear in the Rust code. Two tiers:

- `/api/v0/contract-states/` — immutable by construction. Add
  `Cache-Control: public, max-age=31536000, immutable` (the `immutable`
  directive alone sets no freshness lifetime, so the `max-age` is required), and
  `proxy_cache` it aggressively. Repeat fetches are then served by nginx or the
  CDN and never reach the indexer.
- Everything else is tip-dependent and must not be cached without an
  invalidation story. `README.md` already documents the constraint: the API
  currently sends no caching headers and no invalidation layer exists, so a
  future shared cache would have to invalidate `/api/v0` on every committed
  block. The immutable resource above is exempt precisely because its key is its
  content hash, so it needs no invalidation at all.

## Required index for historical lookups

`contract_actions_by_addr` is keyed `address‖action_id`
(`pipeline.rs`, `prefixed_u64_key(address, action_id)`), **not** by height. A
naive "latest action ≤ height" would walk a hot contract's entire history
backwards — precisely the contracts that motivated this document.

Action ids are assigned in block order, so they are monotonic in height; the
missing piece is only the mapping from a height to an id boundary. Two viable
shapes:

- a `block_height → last_action_id` boundary index, enabling a bounded seek into
  the existing `address‖action_id` index; or
- a new `address‖block_height‖action_id` index.

The boundary index is smaller and reuses the existing index; the composite index
makes the seek direct. Choose during implementation; either way the resolver
must skip actions whose `state_hash` is `None`.

## Proposed storage change

Content-address the state blobs.

```rust
// crates/nightfrost-core/src/store.rs
pub struct ContractActionRecord {
    pub address: ByteVec,
    pub attributes: ContractAttributes,
    pub state_hash: Option<[u8; 32]>,   // was: pub state: ByteVec
    pub balances: Vec<ContractBalance>,
    pub tx_id: u64,
    pub block_height: u64,
}
```

New partition `contract_states`: key = 32-byte content hash, value = the raw
state bytes. Identical states — repeated actions in one block, or a contract
called without a state change — collapse to a single stored copy.

Notes:

- `Option` preserves existing semantics. An empty state currently marks a failed
  action and must not become a contract's latest pointer (`pipeline.rs:710`, and
  the balances branch at `pipeline.rs:524`); `None` carries that meaning
  explicitly instead of by sentinel.
- **Use key-value separation** for this partition. Vendored fjall supports it
  (`vendor/fjall/src/partition/options.rs`, `kv_separation`, default `None`) and
  it exists precisely for values above ~1 KiB. Without it, LSM compaction
  repeatedly rewrites multi-megabyte values.
- **Never insert a hash that is already stored.** This is a correctness
  requirement, not an optimization. With key-value separation fjall does *not*
  quietly collapse repeated writes: its own documentation states that
  "garbage collection for deleted or outdated values becomes lazy, so GC needs
  to be triggered *manually*", alongside "higher temporary space usage". So a
  redundant insert of an identical blob appends to the value log and stays there
  until a manual GC — exactly the unbounded growth this proposal exists to stop.
  The write path therefore needs both:
  - `contract_states.contains_key(hash)` (`vendor/fjall/src/partition/mod.rs:596`)
    for **persistent** dedupe across the whole store; and
  - a per-batch pending set for duplicates **within one block's batch**, since
    fjall batches are write-only and `contains_key` cannot see pending writes.
    This mirrors the existing in-block maps in `write_block` (`created_this_block`
    and friends) and is scoped to the batch — not a cache layer.

  Note this is a *store read*, not an in-process cache: per project rule the Rust
  code holds no cache, and an LRU would in any case only have caught duplicates
  inside its window while letting older repeats through.
- Because keys are content hashes, a key's value can never change. Given the
  no-redundant-insert rule above, the partition accumulates no outdated versions
  at all, which keeps the lazy blob GC essentially idle in steady state.
- **The blob insert and the referencing action record must go in the same fjall
  batch**, so a crash can never leave an action pointing at a missing state.
- **No refcounting needed.** Contract actions are never pruned, so a state blob
  is never orphaned. This keeps the change small.

### Compression is already on

fjall enables **LZ4 by default** (`vendor/fjall/src/partition/options.rs:309`,
and `default = ["single_writer_tx", "lz4"]` in its manifest; the workspace takes
default features). The 125 GB figure is therefore **already compressed**, which
has two consequences:

- Logical distinct-state bytes alone will not predict disk savings. The
  measurement must compare physical sizes too (below).
- "Add compression" is a smaller lever than it appears — the gain is only zstd's
  margin over LZ4, not raw-versus-compressed. Vendored fjall does not expose
  zstd, so that would have to be application-level compression of the blob
  before insert.

Dedupe is unaffected by this: LZ4 operates per block and does not collapse
identical blobs stored far apart, so duplicates still cost full price today.

## Step 1: measure before building

The one number that decides dedupe versus compression is unmeasured: **how much
of preprod's 125 GB is byte-identical duplication?** Because compression is
already on, a logical-bytes count alone would mislead. Measure all of:

1. logical state bytes (sum of blob lengths);
2. unique logical state bytes (distinct content hashes);
3. current **physical** partition size;
4. physical size of a content-addressed prototype built from the same data;
5. per-blob compression headroom (zstd versus the LZ4 already applied).

(1) versus (2) gives the dedupe ratio; (3) versus (4) is the number that
actually predicts reclaimed disk. Build only after it lands, and quote the ratio
in the commit.

The **source store is read-only and the indexer stays stopped** throughout;
steps (1)-(3) require no schema change. Step (4) is not read-only in itself — it
builds a second physical store — so the prototype must be written to a
**separate path, ideally a separate volume**, precisely because headroom on the
production disk is the open question the measurement exists to answer.

## Migration

Changing the record changes its postcard encoding, so old records cannot be
decoded by new code, and a half-finished in-place rewrite would leave two
encodings in one partition with no way to tell them apart — not retryable.
The migration must therefore be explicitly versioned:

- Add `meta_keys::SCHEMA_VERSION`. Absence means legacy **only when the store is
  non-empty** (a fresh store is current-schema by construction).
- Normal startup **rejects** a legacy store with an error naming the backfill
  command; only migration mode may open one.
- Keep an explicit `LegacyContractActionRecord` for decoding old rows.
- Write into a **new `contract_actions_v2` partition** (or tag records with a
  discriminator) and cut over only once the pass completes; do not rewrite in
  place. This is what makes a retry safe after an interrupted run.
- Update `SCHEMA_VERSION` **only after** the new data is durably persisted.
- **Reclaim in a separate, separately retryable phase.** Persisting v2 and
  flipping the schema version does not free the old 125 GB; the legacy partition
  must be dropped explicitly via `Keyspace::delete_partition`
  (`vendor/fjall/src/keyspace.rs:435`). Order matters: **schema switch first,
  deletion second**, so a crash after cutover resumes safely at cleanup rather
  than re-running the rewrite. Reclamation is then just "if the legacy partition
  still exists and the schema is current, delete it".
- Add `--backfill-contract-states`, matching the existing one-off maintenance
  convention (`--backfill-contract-events`, `--backfill-dust-generation`): run
  with the indexer stopped, idempotent.

**Disk headroom is the real risk.** Overwriting or superseding 125 GB of LSM
values does not reclaim the originals immediately — reclamation waits on
compaction, and the old and new partitions coexist until cutover. The earlier
"117 GB free is enough" reasoning was optimistic and should not be relied on.
Either establish the requirement from the measurement's step (4) before
starting, or take the fallback: let preprod re-sync from scratch under the new
schema, which costs days of sync but carries no headroom risk. Decide with the
measurement in hand.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep only the latest state per contract | Reclaims the most disk, but destroys the planned state-at-height endpoint and any future one; recovering it later needs a full re-sync. |
| Bigger disk only | Already done once (315→394 GB) and preprod still projects past it. Treats a per-block cost as a capacity problem, so it recurs on every network. |
| Compress without dedupe | Weaker than it first appears now that LZ4 is known to be on; the remaining margin is zstd-over-LZ4. Also loses the free `state_hash`, which is what lets clients skip unchanged blobs and what makes the immutable cacheable resource possible. |
| Store state deltas between actions | Best compression in principle, but needs ledger-aware structural diffing, is fragile across ledger versions, and makes a point read a chain of applications. |
| Don't store state; proxy `get_contract_state` to an archive node at query time | Removes the storage cost entirely, but makes read latency depend on an external archive node, breaks if it prunes, and puts node load on every API call. Reasonable for a thin gateway, wrong for an indexer whose value is serving this locally. |

## Risks

- **Duplication may be low.** Then dedupe buys little and the fix leans on
  zstd-over-LZ4, which is a modest margin. Measurement first is the mitigation,
  and a poor ratio should reopen the "keep only latest" question rather than
  proceeding regardless.
- **Backfill headroom on preprod.** See above; fallback is re-sync.
- **Schema break.** Mandatory backfill for every existing data directory. The
  `SCHEMA_VERSION` guard turns silent corruption into a clear startup error.
- **Hashing cost on the write path.** One hash per contract action; negligible
  against ledger replay, which already dominates CPU.

## Verification

1. Measurement pass reports dedupe ratio *and* prototype physical size; record both.
2. Unit coverage for `contract_states` round-tripping, the `None` (failed action)
   case, and "same state twice in one block".
3. Index coverage: "latest action ≤ height" returns the same answer as a brute
   backward scan, including when the newest actions are failed ones.
4. Write path: re-indexing a range that repeats a state inserts the blob exactly
   once (assert via `contains_key` and value-log size), including a repeat
   separated by enough blocks that any windowed scheme would have missed it.
5. Backfill on a copy of real preprod data: record counts unchanged, every
   `/contracts/{addr}/state` response byte-identical before and after, partition
   size reduced by the predicted ratio; interrupt mid-run and confirm a clean
   retry; interrupt *after* cutover and confirm reclamation resumes.
6. Differential check of the new offset selectors against the hosted official
   indexer's `contractAction(address, offset)` (harness in `tests/differential/`),
   including a block containing two transactions against one contract, where
   `?tx=` on the earlier one must return the block's action.
7. nginx serves `Cache-Control: public, max-age=31536000, immutable` on
   `/api/v0/contract-states/` and nothing cacheable elsewhere; the Rust binary
   emits no cache headers at all.
8. Production: preprod `contract_actions` size after backfill *and* after
   reclamation, and projected full-sync size back under the disk budget.

## Review revisions

### Round 2

- **Caching removed from the application entirely.** Project rule: caching is
  nginx's job. The Rust code now sets no `ETag`, no `Cache-Control`, and does no
  conditional-request handling; §4 carries the whole policy. This also happens to
  be the better design for a content-addressed resource — an immutable long-lived
  entry means the client never revalidates, where `ETag`/`304` still costs a
  round trip.
- **`?tx=` now delegates to the containing block.** The objection was decisive:
  with two transactions against one contract in a block, the state stored against
  the earlier action already contains the later one's effect, so pairing
  `action_id: A` with that blob is inconsistent regardless of labelling. The
  selector resolves the transaction to its block and then behaves as `?block=`,
  and the returned action may belong to a later transaction in that block.
- **Dedupe made a correctness requirement, and the LRU dropped.** Key-value
  separation means fjall does not collapse repeated writes: outdated values sit
  in the value log until a *manual* GC. A windowed LRU would have let older
  repeats through and slowly reintroduced the growth problem. Replaced with a
  persistent `contains_key` check plus a per-batch pending set (fjall batches
  being write-only), with blob and action committed in one batch. Dropping the
  LRU also satisfies the no-cache-in-Rust rule.
- **Measurement no longer claimed to be fully read-only.** Steps (1)-(3) are;
  step (4) builds a prototype store and must target a separate path or volume.
- **Migration gained an explicit reclamation phase.** Flipping the schema version
  does not free the old partition; `delete_partition` runs as a separate,
  separately retryable step *after* cutover.
- **`Cache-Control` spelled out in full** — `immutable` alone sets no freshness
  lifetime, so `max-age` is required.

### Round 1

Changes made after the first review round, with rationale:

- **Transaction selector kept but re-specified.** The objection was that state is
  block-final, so `tx=` cannot mean transaction-level state. Correct. Rather than
  drop the selector (it is genuinely useful and matches the official indexer's
  offset set), granularity is now stated up front in "What granularity we can
  honestly offer", and every response carries `state_at: "end_of_block"`. The
  non-uniqueness of transaction hashes is documented too.
- **ETag design corrected.** Using `state_hash` as the ETag of a response that
  also carries `action_id`/`block_height`/`tx_hash` was wrong — those change on a
  no-op call. Split out the immutable `/contract-states/{state_hash}` resource,
  which is the only place the hash is a valid strong ETag.
- **Migration made genuinely retryable.** Added `LegacyContractActionRecord`,
  legacy detection only for non-empty stores, migration-mode-only opening,
  new-partition cutover instead of in-place rewrite, and writing
  `SCHEMA_VERSION` only after persistence.
- **Height index added.** The original draft assumed the lookup was free;
  `address‖action_id` has no height ordering, so a boundary or composite index is
  now a stated requirement, including skipping `None` states.
- **Compression corrected.** fjall already applies LZ4 by default, so the
  measurement now compares physical sizes and a prototype, not just logical
  bytes, and key-value separation is specified for the blob partition.
- **Envelope corrected.** Point lookups use `PointResponse`, which omits
  `next_cursor` entirely. Note `README.md` still describes it as null for point
  lookups — a separate documentation fix.
