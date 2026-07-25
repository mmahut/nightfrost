// Dust registrations: nightfrost /dust/registrations (hex stake keys) versus
// oracle dustGenerations (bech32 Cardano reward addresses, max 10 per query).
//
// Normalization: the oracle returns only *current* registrations, so
// nightfrost rows that are removed (removed_at_height set) or dead residue
// (valid=false AND no utxo mapping) are dropped before comparing the
// (dust_address, utxo_ref) sets. The `valid` flag is then compared on rows
// matched by (dust_address, utxo_ref) — flag disagreements are reported
// separately from set differences.

import { bech32Encode, fromHex, normHexish } from '../lib.mjs';

export const name = 'dust';

export async function run(ctx, t) {
  const dust = await ctx.nfAllPages('/dust/registrations');
  const byKey = new Map();
  for (const r of dust) {
    if (!byKey.has(r.cardano_stake_key)) byKey.set(r.cardano_stake_key, []);
    byKey.get(r.cardano_stake_key).push(r);
  }
  const keys = [...byKey.keys()];
  const wanted = Math.min(ctx.cfg.dustKeys, keys.length);
  t.note(`nightfrost serves ${dust.length} registration rows over ${keys.length} stake keys; sampled ${wanted}`);

  const sample = [];
  const step = Math.max(1, Math.floor(keys.length / wanted));
  for (let i = 0; i < keys.length && sample.length < wanted; i += step) sample.push(keys[i]);

  const orByKey = new Map();
  for (let i = 0; i < sample.length; i += 10) {
    const chunk = sample.slice(i, i + 10);
    const bech = chunk.map((k) => bech32Encode('stake_test', fromHex(k), 1));
    let d;
    try {
      d = await ctx.gql(`{ dustGenerations(cardanoRewardAddresses:[${bech.map((b) => `"${b}"`).join(',')}]) {
        cardanoRewardAddress registrations { dustAddress valid utxoTxHash utxoOutputIndex } } }`);
    } catch (e) {
      t.bump();
      t.mismatch(`(keys ${i}..${i + chunk.length})`, 'oracle dustGenerations query failed', null, String(e.message).slice(0, 300));
      continue;
    }
    for (const g of d.dustGenerations) orByKey.set(normHexish(g.cardanoRewardAddress), g.registrations);
  }

  let flagDisagreements = 0;
  for (const k of sample) {
    const nfRows = byKey.get(k);
    if (!orByKey.has(k) && ![...orByKey.keys()].length) continue; // whole chunk failed above

    // the per-key endpoint must agree with the list rows
    const perKey = await ctx.nfAllPages(`/dust/registrations/${k}`);
    t.bump();
    if (JSON.stringify(perKey) !== JSON.stringify(nfRows))
      t.mismatch(k, 'per-key endpoint vs list rows', perKey, nfRows);

    const orRows = orByKey.get(k) ?? [];
    // live rows: current registrations only (see normalization note above)
    const nfLive = nfRows.filter((r) => r.removed_at_height == null && (r.valid || r.utxo_id));
    const pair = (dustAddr, utxo, idx) => [normHexish(dustAddr), utxo ? normHexish(utxo) : null, idx ?? null];
    const nfSet = nfLive.map((r) => pair(r.dust_address, r.utxo_id, r.utxo_index)).sort();
    const orSet = orRows.map((o) => pair(o.dustAddress, o.utxoTxHash, o.utxoOutputIndex)).sort();
    t.eq(k, 'current registrations (dust_address, utxo ref)', nfSet, orSet);

    // valid flag, on rows matched by (dust_address, utxo ref)
    const orValid = new Map(orRows.map((o) => [pair(o.dustAddress, o.utxoTxHash, o.utxoOutputIndex).join(':'), o.valid]));
    for (const r of nfLive) {
      const key = pair(r.dust_address, r.utxo_id, r.utxo_index).join(':');
      if (!orValid.has(key)) continue;
      t.bump();
      if (orValid.get(key) !== r.valid) {
        flagDisagreements++;
        if (flagDisagreements <= 5)
          t.mismatch(k, `valid flag for registration ${key.slice(0, 24)}...`, r.valid, orValid.get(key));
      }
    }
  }
  if (flagDisagreements > 5)
    t.mismatch('(aggregate)', 'valid flag disagreements beyond the 5 listed', flagDisagreements, null);
  if (flagDisagreements)
    t.note('nightfrost sets valid=true only on a Registration event (crates/nightfrost-chain/src/pipeline.rs); the oracle reports current registrations as valid=true — systematic divergence, see report');
}
