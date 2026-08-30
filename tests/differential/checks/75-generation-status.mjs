// Dust generation status: nightfrost /dust/status/{stake_key}
// versus the oracle's dustGenerationStatus query, over ~50 stake keys — every
// flavor the chain offers (currently registered, deregistered, mapping-only)
// plus synthetic never-registered keys.
//
// current_capacity is time-dependent (SPECK generated since ctime, measured
// at each indexer's own chain tip), so a small drift bounded by
// generation_rate * 60s is tolerated when the value is still below max;
// everything else must match exactly.

import { bech32Encode, fromHex, normHexish } from '../lib.mjs';

export const name = 'generation-status';

const UNREGISTERED_KEYS = 10;
const DRIFT_SECONDS = 60n;

export async function run(ctx, t) {
  const rows = await ctx.nfAllPages('/dust/registrations');
  const keys = [...new Set(rows.map((r) => r.cardano_stake_key))];

  const wanted = Math.min(Math.max(ctx.cfg.dustKeys, 40), keys.length);
  const sample = [];
  const step = Math.max(1, Math.floor(keys.length / wanted));
  for (let i = 0; i < keys.length && sample.length < wanted; i += step) sample.push(keys[i]);

  // Synthetic never-registered keys (deterministic; e0 = testnet reward tag).
  for (let i = 0; i < UNREGISTERED_KEYS; i++) {
    let k = 'e0';
    for (let j = 0; j < 28; j++) k += Math.floor(ctx.rand() * 256).toString(16).padStart(2, '0');
    sample.push(k);
  }
  t.note(`sampled ${sample.length} stake keys (${sample.length - UNREGISTERED_KEYS} from registrations, ${UNREGISTERED_KEYS} synthetic unregistered) out of ${keys.length} known`);

  // Oracle statuses, batched 10 per query.
  const orByKey = new Map();
  for (let i = 0; i < sample.length; i += 10) {
    const chunk = sample.slice(i, i + 10);
    const bech = chunk.map((k) => bech32Encode('stake_test', fromHex(k), 1));
    let d;
    try {
      d = await ctx.gql(`{ dustGenerationStatus(cardanoRewardAddresses:[${bech.map((b) => `"${b}"`).join(',')}]) {
        cardanoRewardAddress dustAddress registered nightBalance generationRate maxCapacity currentCapacity } }`);
    } catch (e) {
      t.bump();
      t.mismatch(`(keys ${i}..${i + chunk.length})`, 'oracle dustGenerationStatus query failed', null, String(e.message).slice(0, 300));
      continue;
    }
    for (const s of d.dustGenerationStatus) orByKey.set(normHexish(s.cardanoRewardAddress), s);
  }

  let bech32Checked = false;
  let drifted = 0;
  for (const k of sample) {
    const or = orByKey.get(k);
    if (!or) continue; // whole chunk failed above, already recorded

    const nf = await ctx.nf(`/dust/status/${k}`);
    t.bump();
    if (nf.__status === 404) {
      t.mismatch(k, 'existence', '404', or.registered ? 'registered' : 'unregistered');
      continue;
    }

    t.eq(k, 'cardano_stake_key', normHexish(nf.cardano_stake_key), k);
    t.eq(k, 'registered', nf.registered, or.registered);
    t.eq(k, 'dust_address', nf.dust_address ? normHexish(nf.dust_address) : null, or.dustAddress ? normHexish(or.dustAddress) : null);
    t.eq(k, 'night_balance', nf.night_balance, String(or.nightBalance));
    t.eq(k, 'generation_rate', nf.generation_rate, String(or.generationRate));
    t.eq(k, 'max_capacity', nf.max_capacity, String(or.maxCapacity));

    // current_capacity: exact when saturated or zero, else rate-bounded drift.
    const nfCur = BigInt(nf.current_capacity);
    const orCur = BigInt(or.currentCapacity);
    const rate = BigInt(nf.generation_rate);
    t.bump();
    if (nfCur !== orCur) {
      const diff = nfCur > orCur ? nfCur - orCur : orCur - nfCur;
      if (rate === 0n || diff > rate * DRIFT_SECONDS) {
        t.mismatch(k, 'current_capacity', nf.current_capacity, String(or.currentCapacity));
      } else {
        drifted++;
      }
    }

    // the bech32 spelling of the stake key must resolve identically
    if (!bech32Checked && nf.registered) {
      bech32Checked = true;
      const viaBech = await ctx.nf(`/dust/status/${bech32Encode('stake_test', fromHex(k), 1)}`);
      t.bump();
      if (JSON.stringify({ ...viaBech, current_capacity: null }) !== JSON.stringify({ ...nf, current_capacity: null }))
        t.mismatch(k, 'bech32 vs hex stake key', viaBech, nf);
    }
  }
  if (drifted)
    t.note(`${drifted} current_capacity values within the ${DRIFT_SECONDS}s generation-rate drift bound (tip-time dependent field)`);
}
