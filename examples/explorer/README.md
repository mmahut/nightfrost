# nightfrost explorer

A small, zero-dependency block explorer for the Midnight network, built as the
reference client for the nightfrost REST API. Vite + vanilla TypeScript, no
frameworks and no UI libraries — one typed fetch client, a hash router, and a
handful of page modules.

## Quickstart

```sh
npm install
npm run dev          # http://localhost:5173, expects the API on http://127.0.0.1:3100
```

### Networks

The header has a network switcher. Configure the registry with `VITE_NETWORKS`
(a JSON array; `color` is the status-dot color):

```sh
VITE_NETWORKS='[{"name":"Preview","apiUrl":"http://127.0.0.1:3100","color":"#f0b429"},{"name":"Mainnet","apiUrl":"http://127.0.0.1:3102","color":"#34d399"}]' npm run dev
```

Defaults when unset: Preview on `:3100` (amber) and Mainnet on `:3102`
(green). A plain `VITE_API_URL=http://my-indexer:3100` still works as a
single-network fallback, and the **custom API** field in the footer adds a
"Custom" entry to the switcher at runtime (persisted to `localStorage`).

Production build (output in `dist/`, plain static files):

```sh
npm run build
npm run preview
```

## What it demonstrates

Every read endpoint of the nightfrost API (`/api/v0`), integrated end to end:

- All reads consume the common `{ results, tip, next_cursor }` envelope. List
  views use opaque cursor pagination and retain visited cursors client-side for
  previous-page navigation; no numeric offsets are generated.

- **Dashboard** — `/sync-status` (animated sync progress), `/network`, and
  `/stats` stat tiles (transactions, contracts), plus a NIGHT price/market-cap
  tile from CoinGecko (cached 60 s; the page degrades gracefully without it)
  and an epoch tile computed from the latest block timestamp (Cardano preview
  schedule: 86,400 s epochs — constants in `src/epoch.ts`). Below: live
  latest-blocks and latest-transactions tables (polling every 6 s, the
  chain's block time) and a recent `/ledger-events` ticker. The events feed
  is a forward cursor, so the tail is located with a binary search over
  `from`; recent tx-bearing blocks are discovered through those events.
- **Block pages** — `/blocks/{hash|height}` with prev/next navigation,
  verification roots, and the paginated `/blocks/{id}/txs` list resolved to
  transaction summaries.
- **Transaction pages** — `/txs/{hash}` plus `/txs/{hash}/utxos` rendered as
  an inputs → outputs flow and `/txs/{hash}/events` with pretty-printed
  attributes and collapsible raw hex.
- **Address pages** — `/addresses/{addr}` balances,
  `/addresses/{addr}/utxos[/{token_type}]` with a token filter, and
  `/addresses/{addr}/txs`.
- **Contract pages** — `/contracts/{addr}`, `/contracts/{addr}/actions`, and
  the `/contracts/{addr}/state` hex viewer.
- **Search** — digits resolve to a block height; 64-hex input is probed as a
  block hash, then a tx hash, then an address, then a contract.

Native-token amounts are stored in STAR and displayed as NIGHT
(1 NIGHT = 10^6 STAR, 6 decimals). Dark is the default theme; the header
toggle cycles dark → light → auto (auto follows `prefers-color-scheme`).

## Layout

```
src/
  api.ts         typed fetch client mirroring the REST contract
  networks.ts    network registry + active selection (VITE_NETWORKS)
  price.ts       CoinGecko NIGHT price (60 s cache, fails soft)
  epoch.ts       epoch schedule constants and math
  router.ts      minimal hash router (#/block/… #/tx/… #/address/… #/contract/…)
  format.ts      NIGHT/STAR, timestamps, hash truncation, hex dumps
  ui.ts          shared DOM components (links, badges, pager, states)
  starfield.ts   dashboard hero canvas (static under prefers-reduced-motion)
  pages/         home, block, tx, address, contract, search
```
