<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="nightfrost" width="112">
  </picture>
</p>

<div align="center">

[![Hosted API](https://img.shields.io/badge/Hosted%20API-nightfrost.dev-4c1?&logoColor=white&color=pink)](https://nightfrost.dev)
[![GitHub Release](https://img.shields.io/github/v/release/mmahut/nightfrost)](https://github.com/mmahut/nightfrost/releases/latest)
[![Build and test](https://github.com/mmahut/nightfrost/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/mmahut/nightfrost/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-nightfrost.dev-4c1?logo=bookstack&logoColor=white&color=mediumslateblue)](https://docs.nightfrost.dev)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

</div>

# Nightfrost

A lean indexer for the [Midnight](https://midnight.network) blockchain with a
REST API. 

```
┌───────────────┐   Subxt (WS)   ┌──────────────────┐   index   ┌───────────┐
│ Midnight Node │ ─────────────▶ │ Replay Pipeline  │ ────────▶ │   Fjall   │
└───────────────┘                │ midnight-ledger  │           └─────┬─────┘
                                 └──────────────────┘                 │ query
                                                                      ▼
                                                             ┌────────────────┐
                                                             │ Axum REST API  │
                                                             │    /api/v0     │
                                                             └────────────────┘
```

Live version is at [nightfrost.dev](https://nightfrost.dev)

## Installation

### Recommended requirements

- 1 vCPU 
- 4GB of RAM per network
- 3GB of Storage for Preview
- 180GB of Storage for Preprod 
- 60GB of Storage for Mainnet 

### Building

```sh
git clone https://github.com/mmahut/nightfrost
cd nightfrost
cargo build --release
```

### Setup wizard

Setup will ask you for everything needed, such as node url, network, data dir etc.

```sh
nightfrost init
```

### Run directly

```sh
nightfrost \
    --node-url wss://rpc.preview.midnight.network \
    --network-id preview \
    --data-dir /var/lib/nightfrost \
    --listen 127.0.0.1:3000
```

### Snapshots

You can use `nightfrost snapshot` subcommands to create and load snapshots.

```sh
nightfrost snapshot restore --trust-me-bro --data-dir /var/lib/nightfrost
```

We also support `--trust-me-bro` which will download our snapshots, don't trust us tho.

### Example clients

 * `examples/explorer/` is a full block explorer web app built purely against the
REST API.
   * Demo at [explorer.nightfrost.dev](https://explorer.nightfrost.dev)

* `examples/light-wallet/` is an experimental, Midnight wallet example.
   * Demo at [wallet.nightfrost.dev](https://wallet.nightfrost.dev).

* `examples/faucet/` is a test-funds faucet handing out 1.337 NIGHT per claim
on preview and preprod.
   * Demo at [faucet.nightfrost.dev](https://faucet.nightfrost.dev).
## REST API

The OpenAPI documentation lives at [docs.nightfrost.dev](https://docs.nightfrost.dev).
