// Ledger events: /txs/{hash}/events versus the oracle's per-tx
// zswapLedgerEvents + dustLedgerEvents, for every tx in the shared set
// (sampled blocks + address histories). Event ids differ by a constant
// offset between the two systems, so events are compared as multisets of
// raw payload bytes per grouping; the id offset is checked for consistency.
// Also verifies the global /ledger/events cursor feed serves the same raws.

export const name = 'tx-events';

export async function run(ctx, t) {
  const idDeltas = new Set();
  for (const hash of ctx.txHashes) {
    const nfEvents = await ctx.nf(`/txs/${hash}/events`);
    const [orTx] = await ctx.oracleTxs([hash]);
    if (nfEvents.__status === 404 || !orTx) continue;
    const nfList = Array.isArray(nfEvents) ? nfEvents : [];

    const nfZ = nfList.filter((e) => e.grouping === 'Zswap');
    const nfD = nfList.filter((e) => e.grouping === 'Dust');
    const other = nfList.filter((e) => e.grouping !== 'Zswap' && e.grouping !== 'Dust');
    if (other.length)
      t.note(`groupings beyond Zswap/Dust seen in nightfrost (e.g. ${other[0].grouping}); compared within Zswap+Dust`);

    const orZ = orTx.zswapLedgerEvents ?? [];
    const orD = orTx.dustLedgerEvents ?? [];
    t.eq(hash, 'zswap raw multiset', nfZ.map((e) => e.raw.toLowerCase()).sort(), orZ.map((e) => e.raw.toLowerCase()).sort());
    t.eq(hash, 'dust raw multiset', nfD.map((e) => e.raw.toLowerCase()).sort(), orD.map((e) => e.raw.toLowerCase()).sort());

    // id numbering: expect a constant offset between the two systems
    const nfByRaw = new Map(nfList.map((e) => [e.raw.toLowerCase(), e.id]));
    for (const o of [...orZ, ...orD]) {
      const nfId = nfByRaw.get(o.raw.toLowerCase());
      if (nfId != null) idDeltas.add(o.id - nfId);
    }

    // the cursor feed must serve the same events at the nightfrost ids
    if (nfList.length) {
      const from = Math.min(...nfList.map((e) => e.id));
      const through = Math.max(...nfList.map((e) => e.id));
      const feed = [];
      let cursor;
      for (;;) {
        const page = await ctx.nfPage('/ledger/events', { from, count: 100, cursor });
        feed.push(...page.results);
        if (page.next_cursor == null || page.results.at(-1)?.id >= through) break;
        cursor = page.next_cursor;
      }
      const feedById = new Map(feed.map((e) => [e.id, e.raw?.toLowerCase()]));
      for (const e of nfList) {
        t.bump();
        if (feedById.get(e.id) !== e.raw.toLowerCase())
          t.mismatch(hash, `ledger-events feed id ${e.id}`, e.raw.slice(0, 80), feedById.get(e.id)?.slice(0, 80) ?? 'MISSING');
      }
    }
  }
  if (idDeltas.size === 1) {
    t.note(`event id numbering offset (oracle id - nightfrost id) is a constant ${[...idDeltas][0]} — representation difference, raw payloads compared`);
  } else if (idDeltas.size > 1) {
    t.bump();
    t.mismatch('(global)', 'event id offset not constant', null, [...idDeltas].sort((a, b) => a - b));
  }
}
