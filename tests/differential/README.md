# Differential integration tests

Verifies nightfrost's indexed data against an independent oracle: the
Blockfrost-hosted Midnight preview indexer (GraphQL) at
`https://midnight-preview.blockfrost.io/api/v0`. Every data category the two
APIs share is compared field by field, with normalization where the
representations differ (bech32m `mn_addr_preview1…` vs hex owners, bech32
`stake_test1…` vs hex stake keys, zero-hash vs null genesis parent, event-id
numbering offsets).

Zero npm dependencies — plain Node ≥ 18 (`fetch`), no install step.

## Run locally

```sh
export MIDNIGHT_BLOCKFROST_TOKEN=...   # Blockfrost project token — secret, env only
node tests/differential/run.mjs
```

On Nix systems:

```sh
nix-shell -p nodejs_20 --run "node tests/differential/run.mjs"
```

Exit code 0 only if every category passes. A human-readable summary goes to
stdout; a machine-readable report is written to `tests/differential/report.json`
(gitignored). Progress chatter goes to stderr.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MIDNIGHT_BLOCKFROST_TOKEN` | (required) | Blockfrost project token. Never write it to a file. |
| `NIGHTFROST_URL` | `http://127.0.0.1:3100` | nightfrost instance under test |
| `ORACLE_URL` | `https://midnight-preview.blockfrost.io/api/v0` | oracle GraphQL endpoint |
| `SAMPLE_SEED` | `20260805` | PRNG seed — same seed, same sample |
| `RANDOM_BLOCKS` | `30` | random heights across the whole range |
| `RECENT_BLOCKS` | `20` | most recent blocks |
| `ADDRESSES` | `10` | addresses (discovered from sampled txs) to verify |
| `CONTRACTS` | `5` | contracts to verify |
| `DUST_KEYS` | `25` | Cardano stake keys to verify |

## GitHub Action

The suite is CI-shaped: no dependencies, env-only config, nonzero exit on any
mismatch. A workflow invokes it as:

```yaml
- name: differential tests
  env:
    MIDNIGHT_BLOCKFROST_TOKEN: ${{ secrets.MIDNIGHT_BLOCKFROST_TOKEN }}
    NIGHTFROST_URL: http://127.0.0.1:3100
  run: node tests/differential/run.mjs
- name: upload report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: differential-report
    path: tests/differential/report.json
```

(nightfrost must be running and synced against preview before the step.)

## Adding a check

Drop a module into `tests/differential/checks/` — the runner discovers every
`*.mjs` there and runs them in filename order (use a numeric prefix; earlier
checks populate shared discovery state on `ctx` for later ones):

```js
// tests/differential/checks/55-mything.mjs
export const name = 'mything';           // category name in the report
export async function run(ctx, t) {
  const nf = await ctx.nf('/my/endpoint');            // nightfrost GET
  const or = await ctx.gql('{ myQuery { field } }');  // oracle GraphQL
  t.eq('some-id', 'field', nf.field, or.myQuery.field); // counted comparison
  t.note('anything worth surfacing');                   // non-failing remark
  t.mismatch('id', 'field', nfVal, oracleVal);          // explicit failure
}
```

`ctx` provides: `nf(path, params)` (unwrapped `results`), `nfPage(path, params)`
(full `{results, tip, next_cursor}` envelope), and `nfAllPages(path)` (nightfrost
REST, cursor-paginated),
`gql(query)` (oracle), `oracleTxs(hashes)` / `oracleBlocks(heights)` (batched +
cached, cache exposed as `oracleTxCache`), `rand()` (seeded), `cfg`, and shared
discovery state (`heights`, `orBlocks`, `txHashes`) filled in by the earlier checks.
Normalization helpers live in `../lib.mjs` (`normHexish`, `bech32Encode`,
`bech32Decode`, `compareUtxoSets`, `utxoKey`, `ZERO32`).

## What each category covers

- **blocks** — header fields, by-hash lookup, per-block tx lists (genesis +
  random + recent sample)
- **addresses** — balances, unspent sets, and history closure, reconstructed
  from oracle per-tx data (the oracle has no address query); feeds each
  address's history txs into the shared tx set
- **transactions** — variant, status/segments, fees, identifiers, block
  linkage, utxo/event/action counts for every tx in the shared set (sampled
  blocks + address histories)
- **tx-utxos** — full input/output unshielded utxo sets (owner, token type,
  value, ctime, dust-registration flag)
- **tx-events** — zswap + dust ledger event raw payloads per tx, id-offset
  consistency, and the `/ledger/events` cursor feed
- **contracts** — record, latest state, balances, action history sample
- **dust** — active cNIGHT→DUST registrations per stake key, list vs per-key
  endpoint
- **tip** — head-of-chain sanity within tolerance

Oracle surfaces with no nightfrost counterpart (SPO/staking suite, bridge
queries, wallet-sync merkle updates, governance history) and nightfrost extras
with no oracle counterpart (balance/unspent queries, `/stats`, `/sync`,
tx submission) are out of differential scope.
