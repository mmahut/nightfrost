# Roadmap

Remaining work, ordered by what actually blocks what. Status 2026-08-16.

## The forcing function

preprod is at ~51% (1.08M of 2.13M blocks) and costs ~116 KB/block in
`contract_actions` (see `CONTRACT_STATE.md`). Finishing the sync needs roughly
another 1.05M blocks — about **122 GB more in that one partition**, plus arena
growth of a similar order to what it has already accumulated. Free space after
the 315→394 GB resize is ~117 GB.

**preprod will exhaust the disk again before it finishes syncing.** That single
fact sets the order below: the storage fix is the critical path, throughput work
matters because it shortens the window, and everything else waits.

mainnet (97.9%) and preview (caught up) are not at risk — mainnet costs ~4.7
KB/block and is nearly done.

## 1. Contract-state storage — critical path

Design is settled in `CONTRACT_STATE.md` after two review rounds. Execution
order matters because each step gates the next.

**1a. Measurement.** Build the read-only pass described in that document:
logical state bytes, unique logical bytes, current physical size, prototype
physical size, per-blob zstd-over-LZ4 headroom. Source store stays stopped and
read-only; the prototype is written to a separate volume.

This is a genuine decision point, not a formality. If duplication is high,
content-addressing carries the fix. If it is low, two things change: the payoff
shrinks to zstd's margin over the LZ4 already in place, **and** the value-log GC
question becomes live, because dedupe is what keeps the blob log free of
outdated entries. A low ratio should reopen "keep only the latest state" rather
than proceed on momentum. Do not start 1b before this number exists.

**1b. Storage change.** `state_hash: Option<[u8; 32]>` on `ContractActionRecord`,
new `contract_states` partition with key-value separation, persistent
`contains_key` dedupe plus a per-batch pending set, blob and record in one batch.

**1c. Migration.** `meta_keys::SCHEMA_VERSION`, `LegacyContractActionRecord`,
migration-mode-only opening of legacy stores, `contract_actions_v2` with cutover
after completion, schema version written last, then reclamation via
`delete_partition` as a separate retryable phase.

Headroom is the risk: the old and new partitions coexist until cutover. Decide
from 1a's prototype number whether preprod can be migrated in place, or whether
it is cheaper to let it re-sync from scratch under the new schema.

**1d. API surface.** The offset selectors on `/contracts/{addr}/state`
(`?height=`, `?block=`, `?tx=` delegating to the containing block), the immutable
`/contract-states/{state_hash}` resource, `state_hash` in `/contracts/{addr}` and
in action rows, and `/contract-actions/{id}`.

**1e. nginx (ops repo).** gzip for `/api/v0`, and
`Cache-Control: public, max-age=31536000, immutable` plus `proxy_cache` scoped to
`/api/v0/contract-states/`. **All caching lives here — none in the Rust code.**

## 2. Sync throughput

Independent of §1 and worth doing because it shortens preprod's remaining window.
Measured on production: 2 vCPUs, each catching-up indexer pegs ~96% of one core,
disk idle, RPC round-trip 128-248 ms but fetch wait only ~4% of wall time. The
bottleneck is single-threaded ledger replay. A VPS resize was declined, so this
is code-level only.

**2a. Instrument first.** Per-stage timing accumulated in the pipeline loop —
fetch wait, replay, root checks, `persist()`, `write_block`, window unpersist,
`gc()` — logged once per `PROGRESS_LOG_INTERVAL` blocks. This decides which lever
below is worth pulling and proves the result afterwards.

**2b. Arena cache.** `LEDGER_CACHE_MAX_NODES` is still 10_000 (`main.rs:15`), the
bootstrap value; the original design plan called for tuning it to 100k during
sync and it never happened. Make it a flag/env with a much larger default. Likely
the largest single win, since misses mean fjall reads during merkle walks.

**2c. Amortize gc during catch-up.** `LedgerState::gc(GC_BOUND)` runs every block
with a 200 ms budget (`pipeline.rs:247`). Run it every block only when caught up;
during catch-up run it every Nth block. Worth up to ~40% if 2a shows gc consuming
its bound.

**2d. Overlap fetch with replay.** `index_block` runs in `block_in_place` on the
same task that polls the block stream, so chunk fetching and replay strictly
alternate. Move the stream to its own task feeding a bounded channel. Recovers
the fetch idle and stops fetch becoming the bottleneck once CPU work shrinks.

## 3. Operations

- **Snapshots cover preview only.** Add mainnet to `nightfrost_snapshot_networks`
  once it finishes; preprod only after §1, since a 182 GB data dir does not
  produce a usable snapshot artifact.
- **Disk headroom monitoring.** The last two incidents were both "disk hit 100%,
  fjall `StorageFull`, poisoned mutex, crash loop". A threshold alert at 85%
  would have caught both well before the outage.
- **`--skip-tags build`** already exists for config-only deploys.

## 4. Small fixes

- `README.md` states `next_cursor` is null for point lookups; `PointResponse`
  omits the field entirely and its doc comment argues that is the honest shape.
- Four dead-code warnings from vendored fjall on every build
  (`journal_recovery_mode`, `queue_count`, `outstanding_flushes`, and a lifetime
  lint). Harmless, but they train people to ignore build output.
- `NIGHTFROST_SUBMIT_CORS_ORIGIN` exists on the binary but is unset in ops, so
  browser transaction submission from the light wallet is blocked by CORS against
  production. Needs a decision on the allowed origin before it can be set.

## 5. Deferred, tracked

- **fjall 3 upgrade.** Would remove the vendored copy and its three
  `PATCHED(nightfrost)` diagnostics plus the flush-permit fix, since upstream
  rewrote the write-stall bookkeeping. Also brings journal compression. Worth
  doing after §1 settles, not during.
- **v8→v9 `translate`.** Still unimplemented; no network has crossed the boundary
  yet, so not blocking.
- **Remaining parity gaps.** Tracked in `PARITY.md` — epoch endpoint, nullifier
  index, validator/SPO analytics.
