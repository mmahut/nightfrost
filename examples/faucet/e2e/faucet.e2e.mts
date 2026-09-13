// End-to-end: claim from a live faucet and confirm through Nightfrost that
// 1.337 NIGHT reached the address. Needs only HTTP, no keys.
//
//   NIGHTFROST_E2E=1 npm run test:e2e
//
// Environment: NIGHTFROST_E2E_FAUCET_URL (https://faucet.nightfrost.dev),
// NIGHTFROST_E2E_NETWORK (preview), NIGHTFROST_E2E_API,
// NIGHTFROST_E2E_RECIPIENT (default: the "all all…" test wallet's address).
import assert from 'node:assert/strict';
import test from 'node:test';
import { NightfrostApi } from '../../light-wallet/src/api.ts';
import { assertNightOutput, log, network, waitFor, waitForTransaction } from '../../light-wallet/e2e/shared.mts';

const enabled = process.env.NIGHTFROST_E2E === '1';
const CLAIM_STAR = 1_337_000n;
const DEFAULT_RECIPIENTS: Record<string, string> = {
  preview: 'mn_addr_preview1y3rlhff46raumcdcum5sgetq05wx7f2qd0hp4jv76907f2e8z2sq728cz3',
  preprod: 'mn_addr_preprod1y3rlhff46raumcdcum5sgetq05wx7f2qd0hp4jv76907f2e8z2sq7teg3v',
};

type Claim = { id: string; state: 'queued' | 'sending' | 'complete' | 'failed'; message: string };

test(
  'faucet: a claim delivers 1.337 NIGHT and Nightfrost sees it',
  { skip: enabled ? false : 'set NIGHTFROST_E2E=1 to run against a live faucet', timeout: 25 * 60 * 1_000 },
  async () => {
    const net = network();
    const api = new NightfrostApi(net);
    const faucet = (process.env.NIGHTFROST_E2E_FAUCET_URL || 'https://faucet.nightfrost.dev').replace(/\/+$/, '');
    const recipient = process.env.NIGHTFROST_E2E_RECIPIENT || DEFAULT_RECIPIENTS[net.networkId];
    assert.ok(recipient, `no default recipient for ${net.networkId}; set NIGHTFROST_E2E_RECIPIENT`);
    const headers = { 'content-type': 'application/json', 'user-agent': 'nightfrost-e2e' };

    const status = (await (await fetch(`${faucet}/api/status`, { headers })).json()) as {
      networks: Record<string, { state: string; message: string }>;
    };
    log('faucet status', status.networks[net.networkId]);
    assert.equal(status.networks[net.networkId]?.state, 'ready', 'faucet is not ready for this network');

    const created = await fetch(`${faucet}/api/claims`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ network: net.networkId, address: recipient }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 202, `claim was refused: ${createdBody}`);
    const claim = JSON.parse(createdBody) as Claim;
    log('claim accepted', claim.id);

    let lastMessage = '';
    const done = await waitFor(`claim ${claim.id}`, 15 * 60 * 1_000, async () => {
      const response = await fetch(`${faucet}/api/claims/${claim.id}`, { headers });
      // A busy faucet behind nginx may answer with an HTML 504; keep polling.
      if (!response.ok) return undefined;
      const current = (await response.json()) as Claim;
      if (current.message !== lastMessage) {
        lastMessage = current.message;
        log('claim:', current.state, current.message);
      }
      return current.state === 'complete' || current.state === 'failed' ? current : undefined;
    }, 3_000);
    assert.equal(done.state, 'complete', `claim failed: ${done.message}`);

    const hash = done.message;
    assert.match(hash, /^[0-9a-f]{64}$/, 'a completed claim reports the transaction hash');
    const { tx, utxos } = await waitForTransaction(api, hash);
    log('indexed in block', tx.block_height);

    // The recipient is bech32; the indexer keys UTXO owners by hex, so
    // confirm via the address's own transaction list plus the output value.
    const listed = await waitFor('tx listed for recipient', 5 * 60 * 1_000, async () => {
      const page = await api.addressTxs(recipient, undefined);
      return page.results.includes(hash) ? true : undefined;
    });
    assert.ok(listed);
    const output = utxos.outputs.find((u) => BigInt(u.value) === CLAIM_STAR && /^(0x)?0{64}$/.test(u.token_type));
    assert.ok(output, 'the transaction has a 1.337 NIGHT output');
    assertNightOutput(utxos, output.owner, CLAIM_STAR);
  },
);
