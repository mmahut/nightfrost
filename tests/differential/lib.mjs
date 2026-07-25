// Shared helpers for the differential test suite. Zero dependencies.

// ---------- env / config ----------

export function config() {
  const token = process.env.MIDNIGHT_BLOCKFROST_TOKEN;
  if (!token) {
    console.error('MIDNIGHT_BLOCKFROST_TOKEN is not set');
    process.exit(2);
  }
  return {
    token,
    nightfrost:
      (process.env.NIGHTFROST_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '') + '/api/v0',
    oracle: process.env.ORACLE_URL ?? 'https://midnight-preview.blockfrost.io/api/v0',
    seed: Number(process.env.SAMPLE_SEED ?? 20260805),
    randomBlocks: Number(process.env.RANDOM_BLOCKS ?? 30),
    recentBlocks: Number(process.env.RECENT_BLOCKS ?? 20),
    addresses: Number(process.env.ADDRESSES ?? 10),
    contracts: Number(process.env.CONTRACTS ?? 5),
    dustKeys: Number(process.env.DUST_KEYS ?? 25),
  };
}

// ---------- deterministic sampling ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- bech32 / bech32m (BIP-173 / BIP-350) ----------

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}
/** spec: 1 = bech32 (Cardano stake addrs), BECH32M = bech32m (Midnight mn_* addrs) */
export function bech32Encode(hrp, bytes, spec = 1) {
  const data = convertBits([...bytes], 8, 5, true);
  const values = [...hrpExpand(hrp), ...data];
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ spec;
  let ret = hrp + '1' + data.map((d) => B32[d]).join('');
  for (let i = 0; i < 6; i++) ret += B32[(mod >> (5 * (5 - i))) & 31];
  return ret;
}
export function bech32Decode(str) {
  const lower = str.toLowerCase();
  if (str !== lower && str !== str.toUpperCase()) return null;
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const c of lower.slice(pos + 1)) {
    const d = B32.indexOf(c);
    if (d === -1) return null;
    data.push(d);
  }
  const spec = polymod([...hrpExpand(hrp), ...data]);
  if (spec !== 1 && spec !== BECH32M) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes) return null;
  return { hrp, bytes: Uint8Array.from(bytes), spec };
}
export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

/** Normalize an address/hash-ish string (hex with/without 0x, or bech32/bech32m) to lowercase hex. */
export function normHexish(s) {
  if (s == null) return s;
  s = String(s);
  if (/^(0x)?[0-9a-fA-F]+$/.test(s)) return s.replace(/^0x/, '').toLowerCase();
  const d = bech32Decode(s);
  if (d) return toHex(d.bytes);
  return s.toLowerCase();
}

export const ZERO32 = '0'.repeat(64);

// ---------- context: HTTP clients, oracle caches, recorder ----------

export function makeContext(cfg) {
  const stats = { nfCalls: 0, oracleCalls: 0 };

  async function httpJson(url, opts, tries = 5) {
    for (let i = 0; i < tries; i++) {
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      if (res.status === 404) return { __status: 404 };
      if (!res.ok) throw new Error(`${res.status} ${await res.text()} for ${url}`);
      return res.json();
    }
    throw new Error(`retries exhausted for ${url}`);
  }

  async function nfPage(path, params) {
    stats.nfCalls++;
    const qs = params
      ? '?' + Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('&')
      : '';
    return httpJson(`${cfg.nightfrost}${path}${qs}`);
  }

  async function nf(path, params) {
    const envelope = await nfPage(path, params);
    return envelope.__status ? envelope : envelope.results;
  }

  async function nfAllPages(path, params = {}) {
    const out = [];
    let cursor;
    for (;;) {
      const page = await nfPage(path, { ...params, count: 100, cursor });
      if (page.__status === 404) return page;
      out.push(...page.results);
      if (page.next_cursor == null) return out;
      cursor = page.next_cursor;
    }
  }

  async function gql(query) {
    stats.oracleCalls++;
    const res = await httpJson(cfg.oracle, {
      method: 'POST',
      headers: { project_id: cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.errors) throw new Error('GraphQL errors: ' + JSON.stringify(res.errors).slice(0, 500));
    return res.data;
  }

  const TX_FIELDS = `
    __typename
    hash
    protocolVersion
    block { hash height timestamp }
    contractActions { __typename address ... on ContractCall { entryPoint } }
    unshieldedCreatedOutputs { owner tokenType value intentHash outputIndex ctime registeredForDustGeneration spentAtTransaction { hash } }
    unshieldedSpentOutputs { owner tokenType value intentHash outputIndex ctime registeredForDustGeneration createdAtTransaction { hash } }
    zswapLedgerEvents { id raw }
    dustLedgerEvents { id raw __typename }
    ... on RegularTransaction {
      transactionResult { status segments { id success } }
      fees { paidFees estimatedFees }
      identifiers
    }`;

  const oracleTxCache = new Map(); // hash -> tx object | null
  let txBatchSize = 8; // shrinks adaptively when the oracle says "Query is too complex"
  /** Batched, cached oracle tx lookup. Returns entries aligned with `hashes`. */
  async function oracleTxs(hashes) {
    const missing = [...new Set(hashes)].filter((h) => !oracleTxCache.has(h));
    let i = 0;
    while (i < missing.length) {
      const batch = missing.slice(i, i + txBatchSize);
      const q =
        '{ ' +
        batch.map((h, j) => `t${j}: transactions(offset:{hash:"${h}"}) { ${TX_FIELDS} }`).join('\n') +
        ' }';
      let data;
      try {
        data = await gql(q);
      } catch (e) {
        if (txBatchSize > 1 && /too complex/i.test(String(e.message))) {
          txBatchSize = Math.max(1, Math.floor(txBatchSize / 2));
          continue; // retry the same slice with the smaller batch
        }
        throw e;
      }
      batch.forEach((h, j) => {
        const list = data[`t${j}`] ?? [];
        oracleTxCache.set(h, list.length ? list[0] : null);
      });
      i += batch.length;
      process.stderr.write(`  oracle tx cache: ${oracleTxCache.size}   \r`);
    }
    return hashes.map((h) => oracleTxCache.get(h));
  }

  async function oracleBlocks(heights) {
    const out = new Map();
    const BATCH = 10;
    for (let i = 0; i < heights.length; i += BATCH) {
      const batch = heights.slice(i, i + BATCH);
      const q =
        '{ ' +
        batch
          .map(
            (h, j) =>
              `b${j}: block(offset:{height:${h}}) { hash height parent { hash } timestamp protocolVersion author zswapMerkleTreeRoot transactions { hash } }`,
          )
          .join('\n') +
        ' }';
      const data = await gql(q);
      batch.forEach((h, j) => out.set(h, data[`b${j}`]));
    }
    return out;
  }

  return {
    cfg,
    stats,
    rand: mulberry32(cfg.seed),
    nf,
    nfPage,
    nfAllPages,
    gql,
    oracleTxs,
    oracleBlocks,
    oracleTxCache, // hash -> full oracle tx | null, for cross-check discovery
    // shared discovery state, filled by earlier checks for later ones:
    heights: [], // sampled block heights (blocks check)
    orBlocks: new Map(), // height -> oracle block (blocks check)
    txHashes: new Set(), // tx hashes to verify: sampled blocks + address histories
  };
}

// ---------- recorder (one per category/check module) ----------

export function makeRecorder(name) {
  const rec = { name, comparisons: 0, mismatches: [], notes: [] };
  return {
    rec,
    bump(n = 1) { rec.comparisons += n; },
    mismatch(id, field, nfVal, orVal) {
      rec.mismatches.push({ id, field, nightfrost: nfVal, oracle: orVal });
    },
    note(text) { if (!rec.notes.includes(text)) rec.notes.push(text); },
    eq(id, field, nfVal, orVal) {
      rec.comparisons++;
      const a = nfVal === undefined ? null : nfVal;
      const b = orVal === undefined ? null : orVal;
      if (JSON.stringify(a) !== JSON.stringify(b)) rec.mismatches.push({ id, field, nightfrost: a, oracle: b });
    },
  };
}

// ---------- shared comparison helpers ----------

export const utxoKey = (u) => `${normHexish(u.intent_hash ?? u.intentHash)}:${u.output_index ?? u.outputIndex}`;

/** Compare a nightfrost utxo list (snake_case) against an oracle one (camelCase), keyed by intent_hash:output_index. */
export function compareUtxoSets(t, id, side, nfList, orList) {
  const nfMap = new Map(nfList.map((u) => [utxoKey(u), u]));
  const orMap = new Map(orList.map((u) => [utxoKey(u), u]));
  t.eq(id, `${side}: utxo count`, nfList.length, orList.length);
  for (const [k, o] of orMap) {
    const n = nfMap.get(k);
    t.bump();
    if (!n) { t.mismatch(id, `${side} utxo ${k}`, 'MISSING', 'present'); continue; }
    t.eq(id, `${side} ${k} owner`, normHexish(n.owner), normHexish(o.owner));
    t.eq(id, `${side} ${k} token_type`, normHexish(n.token_type), normHexish(o.tokenType));
    t.eq(id, `${side} ${k} value`, String(n.value), String(o.value));
    t.eq(id, `${side} ${k} ctime`, n.ctime ?? null, o.ctime ?? null);
    t.eq(id, `${side} ${k} registered_for_dust`, n.registered_for_dust_generation, o.registeredForDustGeneration);
  }
  for (const k of nfMap.keys()) {
    if (!orMap.has(k)) { t.bump(); t.mismatch(id, `${side} utxo ${k}`, 'present', 'MISSING'); }
  }
}
