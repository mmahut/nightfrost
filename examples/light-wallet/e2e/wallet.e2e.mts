// End-to-end: open the test wallet against a live Nightfrost, send 3 NIGHT to
// itself through a real proof server, and confirm the indexer sees the
// transfer land. Costs the wallet only the DUST fee.
//
//   NIGHTFROST_E2E=1 npm run test:e2e
//
// Environment: NIGHTFROST_E2E_SEED_PHRASE (default: the "all all…" test
// phrase), NIGHTFROST_E2E_NETWORK (preview), NIGHTFROST_E2E_API,
// NIGHTFROST_E2E_PROVING_SERVER_URL (default https://wallet.nightfrost.dev,
// whose /prove and /check proxy the production proof server),
// NIGHTFROST_E2E_AMOUNT_NIGHT (3).
import '../src/polyfills.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NightfrostApi } from '../src/api.ts';
import { openNightfrostWallet } from '../src/nightfrost-sdk.ts';
import {
  assertNightOutput,
  log,
  network,
  STAR_PER_NIGHT,
  TEST_PHRASE,
  waitForTransaction,
} from './shared.mts';

const enabled = process.env.NIGHTFROST_E2E === '1';

test(
  'wallet: send NIGHT to itself and see it indexed',
  { skip: enabled ? false : 'set NIGHTFROST_E2E=1 to run against a live network', timeout: 20 * 60 * 1_000 },
  async () => {
    const net = network();
    const api = new NightfrostApi(net);
    const phrase = process.env.NIGHTFROST_E2E_SEED_PHRASE || TEST_PHRASE;
    const provingServerUrl = new URL(
      process.env.NIGHTFROST_E2E_PROVING_SERVER_URL || 'https://wallet.nightfrost.dev',
    );
    const amount = BigInt(process.env.NIGHTFROST_E2E_AMOUNT_NIGHT || '3') * STAR_PER_NIGHT;

    const session = await openNightfrostWallet(phrase, net, undefined, provingServerUrl);
    try {
      log('opened', session.address);
      await session.ready;
      const dust = await session.dustStatus();
      log('synced; dust', dust);
      assert.ok(dust.registeredUtxos > 0, 'the test wallet has no NIGHT registered for DUST');
      assert.ok(dust.balance > 0n, 'the test wallet has no DUST to pay the fee');

      const balancesBefore = await api.addressBalances(session.addressHex);
      const nightBefore = BigInt(balancesBefore.find((b) => /^(0x)?0{64}$/.test(b.token_type))?.amount ?? '0');
      assert.ok(nightBefore >= amount, `the test wallet holds ${nightBefore} STAR, less than ${amount}`);

      const result = await session.sendUnshielded(session.address, amount, (stage) => log('send:', stage));
      log('submitted', result);
      const hash =
        result.hash ??
        (await waitForTransaction(api, (await api.txByIdentifier(result.identifier)).hash)).tx.hash;

      const { tx, utxos } = await waitForTransaction(api, hash);
      log('indexed in block', tx.block_height, 'fees', tx.paid_fees);
      assertNightOutput(utxos, session.addressHex, amount);

      // Self-transfer: NIGHT balance is unchanged, only DUST paid the fee.
      const balancesAfter = await api.addressBalances(session.addressHex);
      const nightAfter = BigInt(balancesAfter.find((b) => /^(0x)?0{64}$/.test(b.token_type))?.amount ?? '0');
      assert.equal(nightAfter, nightBefore, 'a self-transfer must not change the NIGHT balance');
    } finally {
      await session.stop().catch(() => undefined);
    }
  },
);
