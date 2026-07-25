// Per-contract events: nightfrost /contracts/{addr}/events (cursor feed with
// contract-call correlation) versus the oracle's top-level contractEvents
// query, plus the nested ContractCall.contractEvents surface to verify the
// correlation itself.
//
// Discovery: nightfrost's feed is scanned for EVERY contract (local, cheap);
// the oracle is then consulted for every contract that has events on our side
// plus a deterministic sample of empty ones — the oracle has no contract
// enumeration, so emptiness parity is verified by sampling. Note that
// contract events are a ledger-v9 (MIP-107) surface: on a ledger-v8 chain
// (preview today, protocol 1.x) both systems must serve zero events for every
// contract, and this check proves exactly that.

export const name = 'contract-events';

const EMPTY_SAMPLE = 40;
const TYPE = {
  ShieldedSpendEvent: 'ContractShieldedSpend',
  ShieldedReceiveEvent: 'ContractShieldedReceive',
  ShieldedMintEvent: 'ContractShieldedMint',
  ShieldedBurnEvent: 'ContractShieldedBurn',
  UnshieldedSpendEvent: 'ContractUnshieldedSpend',
  UnshieldedReceiveEvent: 'ContractUnshieldedReceive',
  UnshieldedMintEvent: 'ContractUnshieldedMint',
  UnshieldedBurnEvent: 'ContractUnshieldedBurn',
  PausedEvent: 'ContractPaused',
  UnpausedEvent: 'ContractUnpaused',
  MiscContractEvent: 'ContractMisc',
};

/** Drain the nightfrost per-contract cursor feed. */
async function nfContractEvents(ctx, addr) {
  const out = [];
  let cursor;
  for (;;) {
    const page = await ctx.nfPage(`/contracts/${addr}/events`, { count: 100, cursor });
    out.push(...page.results);
    if (page.next_cursor == null) return out;
    cursor = page.next_cursor;
  }
}

/** Drain the oracle's contractEvents query for one address. */
async function oracleContractEvents(ctx, addr) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const d = await ctx.gql(`{ contractEvents(filter:{contractAddress:"${addr}"}, limit: 100, offset: ${offset}) {
      __typename id raw contractAddress transaction { hash block { height } } } }`);
    const chunk = d.contractEvents ?? [];
    out.push(...chunk);
    if (chunk.length < 100) return out;
  }
}

export async function run(ctx, t) {
  const contracts = await ctx.nfAllPages('/contracts');

  // Local discovery pass over every contract.
  const withEvents = [];
  for (const c of contracts) {
    const probe = await ctx.nf(`/contracts/${c.address}/events`, { count: 1 });
    if (probe.length) withEvents.push(c.address);
  }
  t.note(
    `nightfrost lists ${contracts.length} contracts, ${withEvents.length} with contract events` +
      (withEvents.length ? '' : ' (chain is on ledger v8; MIP-107 contract events require v9 — emptiness parity sampled on the oracle)'),
  );

  // Oracle sample: everything with events on our side + deterministic empties.
  const sample = new Set(withEvents);
  if (contracts.length) {
    sample.add(contracts[0].address);
    sample.add(contracts[contracts.length - 1].address);
    while (sample.size < Math.min(withEvents.length + EMPTY_SAMPLE, contracts.length))
      sample.add(contracts[Math.floor(ctx.rand() * contracts.length)].address);
  }

  for (const addr of sample) {
    const [nfEvents, orEvents] = await Promise.all([
      nfContractEvents(ctx, addr),
      oracleContractEvents(ctx, addr),
    ]);

    t.eq(addr, 'event count', nfEvents.length, orEvents.length);
    if (!nfEvents.length && !orEvents.length) continue;

    // Ids differ by a constant offset between the systems (like /ledger-events),
    // so events are matched as multisets of raw payload bytes.
    const rawsNf = nfEvents.map((e) => e.raw.toLowerCase()).sort();
    const rawsOr = orEvents.map((e) => e.raw.toLowerCase()).sort();
    t.eq(addr, 'raw multiset', rawsNf, rawsOr);

    const nfByRaw = new Map(nfEvents.map((e) => [e.raw.toLowerCase(), e]));
    for (const o of orEvents) {
      const n = nfByRaw.get(o.raw.toLowerCase());
      t.bump();
      if (!n) { t.mismatch(`${addr} event ${o.id}`, 'existence', 'MISSING', o.__typename); continue; }
      const nfType = typeof n.attributes === 'string' ? n.attributes : Object.keys(n.attributes)[0];
      t.eq(`${addr} event ${o.id}`, 'type', nfType, TYPE[o.__typename] ?? o.__typename);
      t.eq(`${addr} event ${o.id}`, 'contract_address', n.contract_address.toLowerCase(), o.contractAddress.toLowerCase());
      t.eq(`${addr} event ${o.id}`, 'tx_hash', n.tx_hash.toLowerCase(), o.transaction.hash.toLowerCase());
      t.eq(`${addr} event ${o.id}`, 'block_height', n.block_height, o.transaction.block.height);
    }

    // Correlation: our contract_action_id must group events exactly like the
    // oracle's nested ContractCall.contractEvents surface groups them.
    const txHashes = [...new Set(nfEvents.map((e) => e.tx_hash))];
    for (const hash of txHashes) {
      let d = null;
      try {
        d = await ctx.gql(`{ transactions(offset:{hash:"${hash}"}) {
          contractActions { __typename address ... on ContractCall { entryPoint contractEvents { raw } } } } }`);
      } catch (e) {
        t.note(`oracle nested contractEvents error on tx ${hash}: ${String(e.message).slice(0, 150)}`);
        continue;
      }
      const orTx = (d.transactions ?? [])[0];
      if (!orTx) continue;

      // oracle: multiset of raws per attributed call; unattributed = raws in
      // the top-level feed for this tx that appear under no call
      const orGroups = (orTx.contractActions ?? [])
        .filter((a) => a.__typename === 'ContractCall' && a.address.toLowerCase() === addr.toLowerCase())
        .map((a) => (a.contractEvents ?? []).map((e) => e.raw.toLowerCase()).sort())
        .filter((g) => g.length)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

      // nightfrost: group this tx's events by contract_action_id
      const mine = nfEvents.filter((e) => e.tx_hash === hash);
      const groups = new Map();
      for (const e of mine) {
        const k = e.contract_action_id ?? 'unattributed';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e.raw.toLowerCase());
      }
      const nfGroups = [...groups.entries()]
        .filter(([k]) => k !== 'unattributed')
        .map(([, g]) => g.sort())
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      t.eq(`${addr} tx ${hash}`, 'events per attributed contract call', nfGroups, orGroups);
    }
  }
}
