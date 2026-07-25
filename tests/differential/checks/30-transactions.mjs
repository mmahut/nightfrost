// Transactions: scalar fields of every tx in ctx.txHashes (sampled blocks +
// address histories) — variant, status/segments, fees, identifiers, block
// linkage, and the various counts.

import { normHexish } from '../lib.mjs';

export const name = 'transactions';

const VARIANT = {
  RegularTransaction: 'Regular',
  SystemTransaction: 'System',
  BridgeClaimTransaction: 'BridgeClaim',
};

export async function run(ctx, t) {
  const hashes = [...ctx.txHashes];
  await ctx.oracleTxs(hashes); // warm the cache in batches
  for (const hash of hashes) {
    const nfTx = await ctx.nf(`/txs/${hash}`);
    const [orTx] = await ctx.oracleTxs([hash]);
    t.bump();
    if (nfTx.__status === 404 && !orTx) continue;
    if (nfTx.__status === 404) { t.mismatch(hash, 'existence', 'MISSING', 'present'); continue; }
    if (!orTx) { t.mismatch(hash, 'existence', 'present', 'MISSING (oracle)'); continue; }

    t.eq(hash, 'variant', nfTx.variant, VARIANT[orTx.__typename] ?? orTx.__typename);
    t.eq(hash, 'block_height', nfTx.block_height, orTx.block.height);
    t.eq(hash, 'block_hash', nfTx.block_hash, orTx.block.hash);
    t.eq(hash, 'block_time', nfTx.block_time, orTx.block.timestamp);
    if (orTx.__typename === 'RegularTransaction') {
      t.eq(hash, 'status', nfTx.status?.toUpperCase().replace('-', '_'), orTx.transactionResult.status);
      const orSegs = orTx.transactionResult.segments?.map((s) => ({ id: s.id, success: s.success })) ?? null;
      const nfSegs = nfTx.segments?.map((s) => ({ id: s.id, success: s.success })) ?? null;
      t.eq(hash, 'segments', nfSegs, orSegs);
      t.eq(hash, 'paid_fees', String(nfTx.paid_fees), orTx.fees.paidFees);
      t.eq(hash, 'estimated_fees', String(nfTx.estimated_fees), orTx.fees.estimatedFees);
      t.eq(
        hash,
        'identifiers',
        (nfTx.identifiers ?? []).map(normHexish).sort(),
        (orTx.identifiers ?? []).map(normHexish).sort(),
      );
    }
    t.eq(hash, 'utxo_created_count', nfTx.utxo_created_count, orTx.unshieldedCreatedOutputs.length);
    t.eq(hash, 'utxo_spent_count', nfTx.utxo_spent_count, orTx.unshieldedSpentOutputs.length);
    t.eq(
      hash,
      'event_count',
      nfTx.event_count,
      (orTx.zswapLedgerEvents?.length ?? 0) + (orTx.dustLedgerEvents?.length ?? 0),
    );
    t.eq(hash, 'contract_action_count', nfTx.contract_action_count, orTx.contractActions.length);
  }
  process.stderr.write(`\ntransactions done (${hashes.length})\n`);
}
