// Tip sanity: nightfrost's latest block versus the oracle's, with tolerance
// for the chain advancing between the two calls (6s slots). Also sanity-checks
// /stats and /sync shapes (no oracle equivalents — informational).

export const name = 'tip';

export async function run(ctx, t) {
  const [nfLatest, sync, stats] = await Promise.all([
    ctx.nf('/blocks/latest'),
    ctx.nf('/sync'),
    ctx.nf('/stats'),
  ]);
  const or = await ctx.gql('{ block { height hash } }');

  t.bump();
  if (Math.abs(or.block.height - nfLatest.height) > 5)
    t.mismatch('latest', 'height', nfLatest.height, or.block.height);
  else t.note(`tip heights within tolerance: nightfrost ${nfLatest.height}, oracle ${or.block.height}`);

  t.bump();
  if (sync.indexed_height < nfLatest.height)
    t.mismatch('sync-status', 'indexed_height < latest block height', sync.indexed_height, nfLatest.height);

  t.note(
    `stats (no oracle equivalent): txs=${stats.total_transactions} contract_actions=${stats.total_contract_actions} ` +
      `ledger_events=${stats.total_ledger_events} contracts=${stats.total_contracts}`,
  );
}
