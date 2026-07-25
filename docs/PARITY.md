# Parity with midnight-indexer

Tracks what the official midnight-indexer (GraphQL `/api/v4`, schema-v4 @ 4.3.5) serves
versus what nightfrost serves (REST `/api/v0`). Status as of 2026-08-05.

Legend: ✅ served · 📥 data indexed, endpoint pending · 🔶 partial · 🚫 out of scope by design

## Queries

| midnight-indexer | nightfrost | Status |
|---|---|---|
| `block(offset)` by hash/height | `GET /blocks/{hash\|height}`, `/blocks/latest`, `/blocks/{id}/txs` | ✅ |
| `transactions(offset)` by hash/identifier | `GET /txs/{hash}` (+`/utxos`, `/events`); by identifier: index stored (`txs_by_identifier`) | 🔶 endpoint for identifier lookup pending |
| `contract(address)` / `contractAction(address, offset)` | `GET /contracts/{addr}`, `/state`, `/actions` | ✅ |
| `contractEvents(filter)` | `GET /contracts/{addr}/events?from=&count=` — correlated to the emitting `ContractCall` like the official indexer (ticket #1162 semantics); verified against the oracle (currently 0 events either side — preview is ledger v8, MIP-107 events need v9) | ✅ |
| `dustGenerationStatus(addresses)` | `GET /dust/generation-status/{stake_key}` (hex or bech32); capacity/rate math ported from indexer-api's dust.rs, verified against the oracle (401 comparisons, 2 residual — see note below) | ✅ |
| `dustGenerations(address)` | `dust_generation` (+by-owner index) stored | 📥 |
| `zswapMerkleTreeCollapsedUpdate(start,end)` | wallet-sync primitive (needs collapsed-update makers, dropped from facade) | 🚫 |
| `dustCommitmentMerkleTreeUpdate` / `dustGenerationMerkleTreeUpdate` | wallet-sync primitives | 🚫 |
| `bridgeEvents/Balance/Deposits/ReserveInflows/TreasuryInflows/PoolSummary` | bridge events decoded and available in block data; not persisted to own partition | 🔶 |
| `dParameterHistory` / `termsAndConditionsHistory` | governance/system parameters (dropped from vendored node layer) | 🚫 |
| SPO suite (~20 queries: `spoList`, `stakeDistribution`, `epochPerformance`, `committee`, `poolMetadata`, …) | Cardano stake-pool data from an external Cardano API (spo-indexer) | 🚫 |

## Mutations

| midnight-indexer | nightfrost | Status |
|---|---|---|
| `connect(viewingKey)` / `disconnect(sessionId)` | shielded wallet sessions | 🚫 |
| — (submission goes to the node directly) | `POST /tx/submit` | ✅ nightfrost extra |

## Subscriptions

nightfrost is poll-based REST; the cursor feed substitutes for some streams.

| midnight-indexer | nightfrost | Status |
|---|---|---|
| `blocks` | poll `GET /blocks/latest` / `/sync-status` | 🔶 |
| `zswapLedgerEvents` / `dustLedgerEvents` (Lace shielded/dust sync) | `GET /ledger-events?from=` serves the same event stream as a cursor feed (raw + decoded attributes), without sessions | 🔶 |
| `shieldedTransactions(sessionId)` (trial decryption + collapsed updates) | viewing-key wallet sync | 🚫 |
| `shieldedNullifierTransactions` / `dustNullifierTransactions` (prefix lookup) | nullifiers present in stored event attributes; prefix index pending | 📥 |
| `unshieldedTransactions(address)` | poll `GET /addresses/{addr}/txs` / `/utxos` | ✅ (poll) |
| `contractActions` | poll `GET /contracts/{addr}/actions` | 🔶 |
| `contractEvents` | poll `GET /contracts/{addr}/events?from=` | 🔶 (poll, but data ✅) |
| `bridgeEvents` / `bridgePoolUpdates` / `bridgeBalance` | — | 🚫 for now |
| `dustGenerations` | — | 📥 |
| `dParameter` / `termsAndConditions` | — | 🚫 |

## nightfrost extras (no official equivalent)

- `GET /addresses/{addr}` — balances per token type (official offers no balance query at all)
- `GET /addresses/{addr}/utxos[/{token_type}]` — point-in-time unspent set (official only streams)
- `GET /txs/{hash}/utxos` — inputs/outputs view
- `GET /sync-status` with percentage
- `POST /tx/submit`

## Known residual: same-block registration churn

A handful of stake keys (4–5 out of 2,483 on preview, found via the differential
suite) carry two `cnight_registrations` rows tied on `registered_at_height` —
one explicitly removed in the same block, one not — from what looks like a
register/re-register sequence within a single block. nightfrost reports the
surviving non-removed row as the current registration (internally consistent:
it's the only non-removed, valid candidate). The oracle reports no current
registration at all for these same keys. Investigated at length (bech32
round-trip, raw event dumps, full registration history) without a conclusive
root cause on either side — could be a genuine "any churn within one block
invalidates the mapping" chain rule we don't reproduce, or an oracle-side
limitation on this rare pattern. Left as a known gap rather than guessed at
further; the affected keys are in `tests/differential/report.json`.

## Data indexed but not yet exposed (no resync needed to expose)

tx-by-identifier lookup · nullifier prefix index · bridge event/claim partitions.

## REST proposals for the partial / out-of-scope surfaces

How each gap could look if promoted to `/api/v0`, staying inside the existing
conventions (path filters, cursor queries, `?count&page&order`).

### Straightforward promotions (data already indexed)

| Proposed endpoint | Serves | Notes |
|---|---|---|
| `GET /txs/identifier/{identifier}` | tx hashes for a transaction identifier | direct read of `txs_by_identifier` |
| `GET /dust/generations/{dust_address}` | generation info rows for an owner | reads `dust_gen_by_owner` |
| `GET /nullifiers/{hex_prefix}/txs` | tx/block refs whose events carry a nullifier with this prefix | REST twin of `shieldedNullifierTransactions`/`dustNullifierTransactions` — stateless, no viewing keys; needs a nullifier→event index (backfillable) |
| `GET /bridge/events[?from=]` · `GET /bridge/balance` · `GET /bridge/deposits/{recipient}` | c2m-bridge activity | events are already decoded per block; persist them to their own partition first |

### Subscriptions → SSE streams

One mechanism covers all official subscriptions worth keeping: every stream is
already a monotonic id under the hood, so each gets a Server-Sent-Events twin of
its cursor feed — `GET /<feed>/stream?from=<cursor>` with `Content-Type:
text/event-stream`, each event carrying its cursor as the SSE `id:` so
`Last-Event-ID` reconnection resumes for free (same replay semantics graphql-ws
clients expect):

- `GET /blocks/stream` — new finalized blocks (twin of `blocks`)
- `GET /ledger-events/stream?from=` — twin of `zswapLedgerEvents`/`dustLedgerEvents`
- `GET /addresses/{addr}/txs/stream` — twin of `unshieldedTransactions(address)`
- `GET /contracts/{addr}/actions/stream` — twin of `contractActions`

Implementation is small: axum SSE + a `tokio::sync::watch` on last-indexed-height,
each stream is "range-scan from cursor, then wake on new block".

### Deliberately out of scope — and the honest REST answer

- **Shielded wallet sync** (`connect`/`disconnect`, `shieldedTransactions`):
  server-side trial decryption of viewing keys is inherently session-stateful and
  custodial — it does not want to be REST. The REST-native answer is the
  *stateless* pair above (nullifier prefix lookup + the raw ledger-event stream),
  with decryption and merkle-witness building on the client. Wallets that need
  `zswapMerkleTreeCollapsedUpdate` would additionally need
  `GET /zswap/merkle-update?start=&end=` — possible (re-vendor the collapsed-update
  makers we dropped), but it drags the wallet-sync tier back in; only worth it if
  Lace-style clients become a goal.
- **Governance** (`dParameterHistory`, `termsAndConditions*`): would be
  `GET /governance/d-parameter[/history]` and `GET /governance/terms` — cheap to
  add (two runtime API calls per change), just not indexer work we need.
- **SPO suite**: Cardano stake-pool analytics sourced from an external Cardano API, not from
  Midnight chain data. If ever wanted, it belongs in a separate service (or direct
  Cardano queries) rather than nightfrost's store.

## Data coverage vs. midnightexplorer.com API

The third-party explorer's REST service ("Midnight API Service",
api-service-01.midnightexplorer.com, `/api/v1`, api-key auth; OpenAPI at
`/api/docs-json`). Beyond basic block/tx/contract lookups it is chiefly an
epoch/validator analytics API, sourced from node RPC
(`sidechain_getAriadneParameters`) and its own epoch snapshots rather than from
ledger replay. Status as of 2026-08-05.

**Already covered**: latest block · block by height/hash · transaction by hash
(their hash-or-identifier lookup maps to the identifier gap tracked above) ·
current contract action state per address.

**Overlaps with gaps already tracked above** (no new entries): dust generation
status per Cardano reward address (📥 capacity/rate math; their response also
includes the registration UTXO ref, which `cnight_registrations` stores) ·
D-parameter history and terms-and-conditions history (🚫 dropped from the
vendored node layer).

**Data they serve with no nightfrost equivalent:**

| Data | Underlying data in nightfrost | Work needed |
|---|---|---|
| Current epoch (number, duration, elapsed) | 📥 pure slot arithmetic over indexed block timestamps (6s slots) | API-layer only; or one runtime call for the authoritative value |
| Contract state as of an arbitrary block height | 📥 every `ContractActionRecord` carries `block_height`; per-contract history in `contract_actions_by_addr` | API-layer only: latest action ≤ height, no resync |
| Current validator set (permissioned + registered, Aura/sidechain/GRANDPA keys, validity flag), total count, lookup by Aura key | not stored — theirs is a cached live proxy of `sidechain_getAriadneParameters` | node-layer (re-add the dropped RPC), no store/pipeline work |
| Per-epoch committee membership with expected slot counts | not stored | same RPC family; historical epochs need archive-node queries or snapshotting at sync time |
| Per-epoch block production performance and utilization (produced vs expected per validator) | 🔶 "produced" is derivable — block author (Aura authority) is on every `BlockRecord` — but no author×epoch aggregation partition exists; "expected" needs the committee data above | new pipeline work: an author/epoch counter partition plus the committee source |
| SPO registration time series (cumulative totals per epoch, valid/invalid split by validator class with D-param, raw per-SPO presence events, first-valid-epoch per SPO) | not stored — needs per-epoch snapshots of the Ariadne candidate set taken as the chain syncs | new pipeline work; falls under the SPO-suite scope call above, though note their source is the Midnight node RPC, not an external Cardano API |

Everything else in their spec is infrastructure (`/health`) or auth, not data.
Conversely, they have no equivalents for most of nightfrost's surface: address
balances/UTXOs/history, tx UTXO views, ledger-event feed, contract action
history, dust registrations, tx submission.

## Proposed endpoints to close the gaps (concrete shapes)

Consolidates everything above into a concrete `/api/v0` menu with response
shapes. Together with what already exists this reaches near-full data parity
with both the official indexer (minus shielded wallet sessions) and
midnightexplorer.com (minus their live validator analytics, listed last).

### From data already indexed (API-layer only)

`GET /txs/identifier/{identifier}` — hashes of txs carrying the identifier
```json
["c94028f1…3a52", "8de2a7fe…526b"]
```

`GET /contracts/{addr}/events?from=0&count=100` — after correlation backfill
```json
{ "results": [ { "id": 15102, "grouping": "Contract", "attributes": { "ContractShieldedReceive": { "version": 1, "entry_point": "6d696e74", "commitment": "9a…" } }, "tx_hash": "60c5…", "block_height": 185518, "raw": "6d69…" } ], "tip": { "hash": "ab…", "height": 185518 }, "next_cursor": "nf1.AQ…" }
```

`GET /contracts/{addr}/state/{height}` — state as of a block height
```json
{ "address": "0042ee…1299", "block_height": 120000, "action_id": 730, "state": "0d2f…" }
```

`GET /epoch` — derived from the latest block timestamp (schedule per network)
```json
{ "epoch": 1373, "progress": 0.29, "started_at": 1754352000, "ends_at": 1754438400, "seconds_left": 61200 }
```

`GET /dust/generation-status/{stake_key}` (+ `POST /dust/generation-status` bulk)
```json
{ "cardano_stake_key": "e00028…", "registered": true, "dust_address": "73c1…153d12", "night_balance": "50000000000000", "generation_rate": "5000000000", "current_capacity": "121500000000000", "max_capacity": "250000000000000000000" }
```

`GET /dust/generations/{dust_address}` — generation info rows
```json
[ { "generation_index": 42, "night_utxo_hash": "5b2c…e0db", "value": "470000000000", "nonce": "18…", "ctime": 1784222670, "dtime": null, "tx_hash": "8f54…" } ]
```

### Needs a small new index (backfillable, no resync)

`GET /nullifiers/{hex_prefix}/txs` — stateless shielded/dust lookup
```json
[ { "tx_hash": "8a54…", "block_height": 185555, "grouping": "Zswap", "nullifier": "ab34…" } ]
```

`GET /bridge/events?from=0` · `GET /bridge/balance` · `GET /bridge/deposits/{recipient}`
```json
{ "results": [ { "id": 7, "variant": "UserTransfer", "mc_tx_hash": "9f…", "amount": "1000000", "recipient": "9ef1…9360", "midnight_tx_hash": "72fc…", "block_height": 171000 } ], "tip": { "hash": "ab…", "height": 171000 }, "next_cursor": "nf1.AQ…" }
```

### Streams (SSE twins of the official subscriptions)

`GET /blocks/stream` · `GET /ledger-events/stream?from=` ·
`GET /addresses/{addr}/txs/stream` · `GET /contracts/{addr}/actions/stream`
```
id: 185650
data: {"hash":"dbf9…","height":185650,"timestamp":1754382000000,"tx_count":0}
```
(SSE `id:` = cursor, so `Last-Event-ID` reconnection replays from the gap.)

### Needs the node RPC re-added (validator surface, midnightexplorer-style)

`GET /validators` (+ `/validators/count`, `/validators/{aura_key}`) — live proxy
of `sidechain_getAriadneParameters`
```json
[ { "aura_key": "0x8e21…", "grandpa_key": "0x55e3…", "sidechain_key": "0x1ee8…", "kind": "registered", "valid": true } ]
```

`GET /epochs/{epoch}/committee` · `/performance` — committee snapshot per epoch
(new pipeline work: snapshot at epoch boundary; performance = indexed block
authors × expected slots)
```json
{ "epoch": 1373, "members": [ { "aura_key": "0x8e21…", "expected_slots": 720, "produced": 703 } ], "utilization": 0.976 }
```
