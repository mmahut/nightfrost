// Addresses: balances, unspent utxo sets, and tx history. Addresses are
// discovered from the unshielded utxo owners of the sampled-block txs, then
// widened from the owners seen in already-fetched oracle txs until the target
// count is reached. Every tx of each verified address's history is added to
// ctx.txHashes so the transactions/utxos/events checks cover them too.
//
// The oracle has no address query, so address state is reconstructed from
// oracle per-tx data over the address's full nightfrost history:
//   - every history tx must actually touch the address per the oracle
//   - closure: oracle createdAt/spentAt links must stay inside the history
//   - unspent set  = created utxos the oracle says are unspent
//   - balances     = sum of unspent values per token type
// If nightfrost silently dropped a *whole* tx of an address, closure catches
// it only when a known utxo links to it; a fabricated history entry is always
// caught. (Full independence is impossible: the oracle cannot enumerate by
// address.)

import { compareUtxoSets, normHexish, utxoKey, ZERO32 } from '../lib.mjs';

export const name = 'addresses';

const MAX_HIST = 400;

function ownersInCache(ctx) {
  const counts = new Map();
  for (const tx of ctx.oracleTxCache.values()) {
    if (!tx) continue;
    for (const u of [...tx.unshieldedCreatedOutputs, ...tx.unshieldedSpentOutputs]) {
      const a = normHexish(u.owner);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  return counts;
}

export async function run(ctx, t) {
  await ctx.oracleTxs([...ctx.txHashes]); // warm cache from the sampled blocks

  const verified = new Set();
  while (verified.size < ctx.cfg.addresses) {
    const queue = [...ownersInCache(ctx).entries()]
      .filter(([a]) => !verified.has(a))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([a]) => a);
    if (!queue.length) break;
    const addr = queue[0];
    verified.add(addr);
    await verifyAddress(ctx, t, addr);
  }
  if (verified.size < ctx.cfg.addresses)
    t.note(`only ${verified.size} addresses discoverable from sampled txs (wanted ${ctx.cfg.addresses})`);
}

async function verifyAddress(ctx, t, addr) {
  const [balances, utxos, hist] = await Promise.all([
    ctx.nf(`/addresses/${addr}`),
    ctx.nfAllPages(`/addresses/${addr}/utxos`),
    ctx.nfAllPages(`/addresses/${addr}/txs`),
  ]);
  let complete = hist.length <= MAX_HIST;
  if (!complete)
    t.note(`address ${addr}: history has ${hist.length} txs > cap ${MAX_HIST}; membership checked for the first ${MAX_HIST}, balance reconstruction skipped`);
  const verify = hist.slice(0, MAX_HIST);
  const histSet = new Set(hist);
  const orTxs = await ctx.oracleTxs(verify);
  for (const h of verify) ctx.txHashes.add(h); // widen coverage of later checks

  const unspent = new Map(); // utxoKey -> oracle utxo (current chain state per oracle)
  for (let i = 0; i < verify.length; i++) {
    const h = verify[i], ot = orTxs[i];
    t.bump();
    if (!ot) { t.mismatch(addr, `history tx ${h}`, 'present', 'MISSING (oracle)'); complete = false; continue; }
    const created = ot.unshieldedCreatedOutputs.filter((u) => normHexish(u.owner) === addr);
    const spent = ot.unshieldedSpentOutputs.filter((u) => normHexish(u.owner) === addr);
    if (created.length === 0 && spent.length === 0)
      t.mismatch(addr, `history tx ${h}`, 'listed in address history', 'touches no unshielded utxo of this address');
    for (const u of created) {
      if (u.spentAtTransaction == null) unspent.set(utxoKey(u), u);
      else {
        t.bump();
        if (!histSet.has(u.spentAtTransaction.hash))
          t.mismatch(addr, `spending tx ${u.spentAtTransaction.hash} of utxo ${utxoKey(u)}`, 'absent from address history', 'spends this address utxo');
      }
    }
    for (const u of spent) {
      t.bump();
      if (u.createdAtTransaction && !histSet.has(u.createdAtTransaction.hash))
        t.mismatch(addr, `creating tx ${u.createdAtTransaction.hash} of utxo ${utxoKey(u)}`, 'absent from address history', 'created this address utxo');
    }
  }

  if (complete) {
    compareUtxoSets(t, addr, 'unspent', utxos, [...unspent.values()]);

    const orBal = new Map();
    for (const u of unspent.values()) {
      const tok = normHexish(u.tokenType);
      orBal.set(tok, (orBal.get(tok) ?? 0n) + BigInt(u.value));
    }
    const nfBal = new Map(balances.map((b) => [normHexish(b.token_type), BigInt(b.amount)]));
    t.eq(addr, 'token types with balance', [...nfBal.keys()].sort(), [...orBal.keys()].sort());
    for (const [tok, v] of orBal)
      t.eq(addr, `balance[${tok}]`, (nfBal.get(tok) ?? 0n).toString(), v.toString());

    // token-filtered utxo endpoint against the reconstruction
    const nightUtxos = await ctx.nfAllPages(`/addresses/${addr}/utxos/${ZERO32}`);
    if (!nightUtxos.__status) {
      const orNight = [...unspent.values()].filter((u) => normHexish(u.tokenType) === ZERO32);
      t.eq(addr, 'utxos filtered by NIGHT token: count', nightUtxos.length, orNight.length);
    }
  }
  process.stderr.write(`address ${addr.slice(0, 12)}...: ${hist.length} txs${complete ? '' : ' (partial)'}\n`);
}
