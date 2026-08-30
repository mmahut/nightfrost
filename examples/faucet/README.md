# Nightfrost faucet

A Preview and Preprod faucet that sends exactly 1 NIGHT through the Nightfrost
API. The static Vite UI talks to a localhost-only Node service; the configured
BIP39 phrase is never included in the browser bundle or returned by the API.

```sh
npm install
npm run build
NIGHTFROST_FAUCET_SEED_PHRASE='your test wallet words' npm start
```

At startup each network wallet syncs, waits for a NIGHT UTXO, registers that
UTXO for DUST generation if necessary, and waits for spendable DUST. Claims
remain unavailable until that lifecycle completes.
