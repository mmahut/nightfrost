// Blocks: header fields, hash lookup, and per-block tx hash lists.
// Samples genesis + RANDOM_BLOCKS random heights + RECENT_BLOCKS most recent.
// Populates ctx.heights, ctx.orBlocks, ctx.txHashes for later checks.

import { ZERO32 } from '../lib.mjs';

export const name = 'blocks';

export async function run(ctx, t) {
  const sync = await ctx.nf('/sync-status');
  const H = sync.indexed_height;
  ctx.indexedHeight = H;
  process.stderr.write(`nightfrost indexed height: ${H}\n`);

  const heights = new Set([0]);
  for (let i = 0; i < ctx.cfg.randomBlocks; i++) heights.add(1 + Math.floor(ctx.rand() * (H - 1)));
  for (let i = 0; i < ctx.cfg.recentBlocks; i++) heights.add(H - i);
  ctx.heights = [...heights].sort((a, b) => a - b);
  process.stderr.write(`sampled ${ctx.heights.length} heights\n`);

  ctx.orBlocks = await ctx.oracleBlocks(ctx.heights);

  for (const h of ctx.heights) {
    const [nfBlock, nfTxs] = await Promise.all([
      ctx.nf(`/blocks/${h}`),
      ctx.nfAllPages(`/blocks/${h}/txs`),
    ]);
    const ob = ctx.orBlocks.get(h);
    t.bump();
    if (nfBlock.__status === 404 || !ob) {
      if (nfBlock.__status === 404 && ob) t.mismatch(h, 'existence', 'MISSING', 'present');
      if (nfBlock.__status !== 404 && !ob) t.mismatch(h, 'existence', 'present', 'MISSING (oracle)');
      continue;
    }
    t.eq(h, 'hash', nfBlock.hash, ob.hash);
    t.eq(h, 'height', nfBlock.height, ob.height);
    // genesis: nightfrost uses the all-zero parent hash, the oracle uses null
    const nfParent = nfBlock.parent_hash === ZERO32 ? null : nfBlock.parent_hash;
    t.eq(h, 'parent_hash', nfParent, ob.parent?.hash ?? null);
    t.eq(h, 'timestamp', nfBlock.timestamp, ob.timestamp);
    t.eq(h, 'protocol_version', nfBlock.protocol_version, ob.protocolVersion);
    t.eq(h, 'author', nfBlock.author, ob.author);
    t.eq(h, 'zswap_merkle_tree_root', nfBlock.zswap_merkle_tree_root, ob.zswapMerkleTreeRoot);
    t.eq(h, 'tx_count', nfBlock.tx_count, ob.transactions.length);

    // lookup by hash must return the same block
    const byHash = await ctx.nf(`/blocks/${ob.hash}`);
    t.eq(h, 'lookup by hash -> height', byHash.height, ob.height);

    // tx hash list, order-sensitive
    t.eq(h, 'tx hash list', nfTxs, ob.transactions.map((x) => x.hash));

    for (const x of ob.transactions) ctx.txHashes.add(x.hash);
    for (const x of nfTxs) ctx.txHashes.add(x);
  }
  process.stderr.write(`blocks done; ${ctx.txHashes.size} txs collected from sampled blocks\n`);
}
