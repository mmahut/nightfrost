# Nightfrost faucet

A Preview and Preprod test-funds faucet that sends 1.337 NIGHT per claim
through the Nightfrost API. The static Vite UI talks to a localhost-only Node
service that holds the wallet; the configured BIP39 phrase is never included
in the browser bundle or returned by the API. Hosted at
[faucet.nightfrost.dev](https://faucet.nightfrost.dev).

The server imports the wallet adapter from `../light-wallet/src`, so both
example directories must be present.

## Running

```sh
npm install
npm run build          # web bundle to dist/, server bundle to server-dist/
NIGHTFROST_FAUCET_SEED_PHRASE='your test wallet words' npm start
```

Transfers are proven by a Midnight proof server, which must be running
(default `http://127.0.0.1:6300`):

```sh
podman run --rm -p 127.0.0.1:6300:6300 docker.io/midnightntwrk/proof-server:8.1.0 midnight-proof-server
```

For UI work, `npm run dev` serves the frontend on `http://localhost:5173` and
proxies `/api` to the server on port 3210. `npm test` builds the server
bundle and runs the `node:test` suite in `src/server.test.mjs`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NIGHTFROST_FAUCET_SEED_PHRASE` | required | BIP39 phrase of the funding wallet, used for both networks |
| `NIGHTFROST_FAUCET_HOST` | `127.0.0.1` | Listen address; keep it on loopback behind a reverse proxy |
| `NIGHTFROST_FAUCET_PORT` | `3210` | Listen port |
| `NIGHTFROST_FAUCET_PROVING_SERVER_URL` | `http://127.0.0.1:6300` | Midnight proof server |
| `NIGHTFROST_FAUCET_PREVIEW_API` | `https://preview.nightfrost.dev` | Nightfrost API for Preview |
| `NIGHTFROST_FAUCET_PREPROD_API` | `https://preprod.nightfrost.dev` | Nightfrost API for Preprod |

## Lifecycle

Each network's wallet runs in its own worker thread (`src/wallet-worker.ts`);
the HTTP server on the main thread only mirrors their state. Wallet sync and
transaction building are CPU-bound for seconds to minutes, and on a shared
thread they starved the API until the reverse proxy answered 504.

At startup each network wallet syncs through Nightfrost, waits for a NIGHT
UTXO at its funding address (printed to the log on first start), registers
that UTXO for DUST generation if necessary, and waits for spendable DUST.
Claims for a network are rejected until that lifecycle completes. One claim
is processed at a time per network; a failed transfer triggers a wallet
resync before the faucet reports ready again.

## HTTP API

Request bodies are limited to 4 KiB. Claims are kept in memory for 24 hours.

- `GET /api/status` returns `{ networks: { preview: { state, message }, preprod: { ... } } }`
  where `state` is `starting`, `syncing`, `ready`, or `error`.
- `POST /api/claims` with `{ "network": "preview" | "preprod", "address": "<mn_addr… or hex>" }`
  answers `202` with a claim `{ id, network, state, message, txHash }`; `state`
  starts at `queued`.
- `GET /api/claims/{id}` returns the same claim as it moves through `queued`,
  `sending`, `sent`, or `failed`.

`?network=preview` or `?network=preprod` in the URL preselects the network; the light wallet links here that way.
