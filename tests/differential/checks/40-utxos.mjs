// Tx UTXO sets: /txs/{hash}/utxos inputs/outputs versus the oracle's
// unshieldedSpentOutputs/unshieldedCreatedOutputs, field by field
// (owner bech32m->hex normalized, token type, value, ctime, dust flag),
// for every tx in the shared set (sampled blocks + address histories).

import { compareUtxoSets } from '../lib.mjs';

export const name = 'tx-utxos';

export async function run(ctx, t) {
  for (const hash of ctx.txHashes) {
    const nfUtxos = await ctx.nf(`/txs/${hash}/utxos`);
    const [orTx] = await ctx.oracleTxs([hash]);
    if (nfUtxos.__status === 404 || !orTx) continue; // existence handled by transactions check
    compareUtxoSets(t, hash, 'outputs', nfUtxos.outputs ?? [], orTx.unshieldedCreatedOutputs);
    compareUtxoSets(t, hash, 'inputs', nfUtxos.inputs ?? [], orTx.unshieldedSpentOutputs);
  }
}
