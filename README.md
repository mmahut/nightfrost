<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="nightfrost" width="112">
  </picture>
</p>

# nightfrost

A single-binary indexer for the [Midnight](https://midnight.network) blockchain with a
REST API. Everything lives in one embedded [fjall](https://github.com/fjall-rs/fjall)
LSM keyspace — no PostgreSQL, no NATS, no GraphQL stack.

```
midnight node ──subxt──▶ replay pipeline ──▶ fjall ◀── axum REST (/api/v0)
                (ws)      (midnight-ledger)
```

## How it works

The Midnight node only exposes opaque SCALE transaction blobs — all semantics
(balances, UTXOs, fees, transaction results, ledger events, contract state) are
derived by **replaying every transaction through `midnight-ledger`** (v8 and v9),
exactly like the official [midnight-indexer](https://github.com/midnightntwrk/midnight-indexer),
from which the ledger facade and node integration are vendored.

Two deliberate deviations from the official indexer:

- **Proof and signature verification is off.** Only finalized blocks are consumed,
  so the node has already validated them. Instead, a **root-match guard** compares
  the recomputed ledger-state root *and* zswap merkle root against the node's
  runtime API values **on every block** (the official indexer checks the ledger
  root only at genesis) — any divergence halts the indexer loudly.
- **Storage is a single fjall keyspace**: the ledger's content-addressed merkle
  arena (a `midnight-storage-core DB` impl, `FjallLedgerDb`) plus ~20 entity
  partitions with big-endian integer keys, so every paginated/cursored read is a
  native range scan. All entities derived from a block commit in **one atomic
  batch**; crash recovery resumes from the last committed block.

Shielded wallet sync (viewing keys, session management, collapsed merkle updates —
the Lace wallet's GraphQL protocol) is intentionally out of scope.

## Installation

### Requirements

- **Rust** — the toolchain is pinned by `rust-toolchain.toml` (currently 1.95.0);
  [rustup](https://rustup.rs) picks it up automatically.
- **Git network access** — some `midnight-*` ledger crates resolve from git tags
  on [`midnightntwrk/midnight-ledger`](https://github.com/midnightntwrk/midnight-ledger)
  via `[patch.crates-io]` (`Cargo.lock` is committed, so builds are reproducible).
- A **Midnight node** to index from, reachable over WebSocket. Syncing from
  genesis requires an **archive node** (`--state-pruning archive
  --blocks-pruning archive`) because the per-block runtime API calls need
  historical state. The public RPC endpoints (e.g.
  `wss://rpc.preview.midnight.network`) are archive nodes.
- Around 8 GB of free disk for the build; indexed preview data is ~1 GB.

### Build

```sh
git clone https://github.com/mmahut/nightfrost
cd nightfrost
cargo build --release
```

The binary lands at `target/release/nightfrost`.

### Run

```sh
nightfrost \
    --node-url wss://rpc.preview.midnight.network \
    --network-id preview \
    --data-dir /var/lib/nightfrost \
    --listen 127.0.0.1:3000
```

The indexer syncs from genesis on first start, resumes from where it left off on
restart, and serves the REST API while syncing (`GET /api/v0/sync-status` reports
progress). A data directory is bound to one chain — starting against a different
network fails with a clear genesis-hash error.

### Configuration

Every flag has an environment-variable twin:

| Flag | Env | Default | |
|---|---|---|---|
| `--node-url` | `NIGHTFROST_NODE_URL` | `wss://rpc.preview.midnight.network` | node WebSocket RPC |
| `--network-id` | `NIGHTFROST_NETWORK_ID` | `preview` | ledger network id |
| `--data-dir` | `NIGHTFROST_DATA_DIR` | `./data` | fjall keyspace directory |
| `--listen` | `NIGHTFROST_LISTEN` | `127.0.0.1:3000` | REST API listen address |
| `--cursor-secret` | `NIGHTFROST_CURSOR_SECRET` | development key | HMAC key for pagination cursors; set the same secret on every API replica |

Logging is controlled with `RUST_LOG` (default `info,midnight_ledger=warn`).

### Running as a service

`deploy/setup-server.sh` is a worked example that provisions archive node
instances plus `nightfrost` systemd units on a host that already runs Midnight
node binaries; adapt the unit definitions inside to your setup.

### Example client

`examples/explorer/` is a full block-explorer web app built purely against the
REST API (Vite + TypeScript, no framework):

```sh
cd examples/explorer
npm install && npm run dev   # VITE_API_URL / VITE_NETWORKS point it at your indexer
```

## REST API

Every `GET /api/v0` response uses one envelope. `results` contains the
endpoint's object or array, `tip` is the indexed chain tip against which the
response was produced, and `next_cursor` is null for point lookups or the final
collection page:

```json
{
  "results": [],
  "tip": { "hash": "ab12…", "height": 185518 },
  "next_cursor": "nf1.AQAAAA…"
}
```

Collection pagination is `?count=1..100&order=asc|desc&cursor=nf1...` (defaults:
100 and ascending). Cursors are opaque: clients must replay them verbatim and
must not decode or construct them. Error responses remain
`{status_code, error, message}`. Addresses are accepted as hex or bech32m.

| Endpoint | Returns |
|---|---|
| `GET /api/v0/network` | network id, genesis hash, node URL |
| `GET /api/v0/sync-status` | indexed vs node height, percentage, caught_up |
| `GET /api/v0/blocks/latest` · `/blocks/{hash\|height}` | block header, roots, tx count |
| `GET /api/v0/blocks/{id}/txs` | tx hashes in the block |
| `GET /api/v0/txs/{hash}` | status, fees, identifiers, counts |
| `GET /api/v0/txs/{hash}/utxos` | spent/created unshielded UTXOs |
| `GET /api/v0/txs/{hash}/events` | ledger events emitted by the tx |
| `GET /api/v0/addresses/{addr}` | balances per token type |
| `GET /api/v0/addresses/{addr}/utxos[/{token_type}]` | unspent UTXOs |
| `GET /api/v0/addresses/{addr}/txs` | transaction history |
| `GET /api/v0/contracts/{addr}` · `/state` · `/actions` | contract record, latest state, action history |
| `GET /api/v0/contracts/{addr}/events?count=&cursor=` | per-contract event cursor feed with contract-call correlation |
| `GET /api/v0/ledger-events?count=&cursor=` | raw ledger event cursor feed (`from=<event_id>` may seed a forward poll) |
| `GET /api/v0/dust/registrations[/{stake_key}]` | cNIGHT→DUST registrations |
| `GET /api/v0/dust/generation-status/{stake_key}` | DUST generation status: registered, dust address, NIGHT balance, rate, current/max capacity |
| `POST /api/v0/tx/submit` | submit a raw ledger tx (hex or bytes) to the node |

### Cursor stability and caching

An `nf1` cursor is a deterministic, base64url-encoded and HMAC-authenticated
token containing only a format version, a 128-bit query fingerprint, the
anchored tip `(height, hash)`, and the endpoint's logical sort tuple. It never
contains a fjall key, SQL offset, or backend row locator. Numeric tuple fields
use big-endian bytes, so the same cursor position maps directly to a fjall range
seek today and a PostgreSQL keyset predicate after a future storage migration.
Keep `NIGHTFROST_CURSOR_SECRET` unchanged through deployments and migrations if
already-issued cursors must remain valid.

The API does not currently send any caching headers, and no invalidation
layer (Varnish or otherwise) sits in front of it — this repository does not
implement or operate one. That said, cursor tokens are deterministic (no
nonce or issue time) and the full normalized query string, including the
opaque cursor, is stable, so a future shared-cache layer could safely use it
as a cache key provided it invalidates `/api/v0` on every committed block and
normalizes query-parameter ordering. Until such a layer actually exists,
treat every response as uncached.

The tip anchor gives stable traversal for append-only blocks, transactions,
actions, and events. Current-state resources such as unspent UTXOs can still
change between HTTP requests when a new block spends an output; strict
historical UTXO snapshots would require a temporal index.

## Workspace

| Crate | Contents |
|---|---|
| `nightfrost-core` | domain types, ledger replay facade (v8+v9), `FjallLedgerDb`, store schema |
| `nightfrost-chain` | subxt node layer (4 runtime versions, parallel catch-up), replay pipeline |
| `nightfrost-api` | axum routes |
| `nightfrost` | binary: config, wiring, `/tx/submit` |

The v9 ledger crates resolve via git RC tags (`[patch.crates-io]`, copied from
midnight-indexer); `Cargo.lock` is committed. `deploy/setup-server.sh` provisions
archive nodes + indexer units on a host that already runs Midnight node binaries.

## Status

Preview is fully synced from genesis with the root guard green throughout, and
verified field-by-field against the Blockfrost Midnight API (see
`tests/differential/`). Not yet done: the v8→v9 ledger hard-fork translation
(no network has crossed it yet; upstream has it on feature branches) and a
few smaller gaps tracked in `docs/PARITY.md`.

## License

Apache-2.0. Portions vendored and adapted from
[midnight-indexer](https://github.com/midnightntwrk/midnight-indexer)
(Midnight Foundation, Apache-2.0) — see `NOTICE` and per-file headers.
