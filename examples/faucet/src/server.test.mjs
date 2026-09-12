import assert from 'node:assert/strict';
import test from 'node:test';

import { FaucetWallet } from '../server-dist/server.js';

test('a failed transfer resyncs before accepting another claim', async () => {
  const wallet = new FaucetWallet({
    name: 'Preview',
    networkId: 'preview',
    apiUrl: 'http://127.0.0.1',
    faucetUrl: null,
    color: '',
    enabled: true,
  });
  let resyncs = 0;
  wallet.state = 'ready';
  wallet.session = {
    sendUnshielded: async () => {
      throw new Error('rejected');
    },
    resync: async () => {
      resyncs += 1;
    },
  };
  const claim = { id: 'test', network: 'preview', state: 'queued', message: '', createdAt: 0 };

  await wallet.send(claim, 'mn_addr_preview1test');

  assert.equal(resyncs, 1);
  assert.equal(claim.state, 'failed');
  assert.equal(wallet.state, 'ready');
  assert.equal(wallet.activeClaim, undefined);
});
