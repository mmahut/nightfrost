// Block page: header fields, prev/next navigation, verification roots,
// paginated transaction list resolved to summaries.

import { api, type Tx } from '../api.ts';
import { formatInt, formatNight, truncateHash } from '../format.ts';
import {
  clear,
  detailRow,
  el,
  emptyState,
  errorState,
  hashLink,
  hashText,
  pager,
  panel,
  skeleton,
  statusPill,
  timeFull,
  variantBadge,
} from '../ui.ts';

const TXS_PER_PAGE = 10;

export async function renderBlock(root: HTMLElement, id: string): Promise<void> {
  root.append(el('div', { class: 'page-head' }, el('h1', {}, 'Block')), skeleton(6));

  let block;
  try {
    block = await api.block(id);
  } catch (err) {
    clear(root).append(el('div', { class: 'page-head' }, el('h1', {}, 'Block')), errorState(err, `block ${truncateHash(id, 12, 8)}`));
    return;
  }

  let tipHeight = Infinity;
  try {
    tipHeight = (await api.syncStatus()).indexed_height;
  } catch {
    /* nav arrows fall back to optimistic */
  }

  clear(root);

  /* -------------------------------------------------------------- head */
  const prevBtn =
    block.height > 0
      ? el('a', { class: 'nav-arrow', href: `#/block/${block.height - 1}`, title: `block ${block.height - 1}` }, '←')
      : el('span', { class: 'nav-arrow disabled' }, '←');
  const nextBtn =
    block.height < tipHeight
      ? el('a', { class: 'nav-arrow', href: `#/block/${block.height + 1}`, title: `block ${block.height + 1}` }, '→')
      : el('span', { class: 'nav-arrow disabled' }, '→');

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Block ', el('span', { class: 'mono num accent' }, formatInt(block.height))),
      el('div', { class: 'block-nav' }, prevBtn, nextBtn),
    ),
  );

  /* ------------------------------------------------------------ fields */
  const details = el('div', { class: 'details' });
  details.append(
    detailRow('hash', hashText(block.hash, true)),
    detailRow(
      'parent',
      block.height > 0 ? hashLink('block', block.parent_hash, true) : hashText(block.parent_hash, true),
    ),
    detailRow('timestamp', timeFull(block.timestamp)),
    detailRow('author', block.author ? hashText(block.author, true) : el('span', { class: 'muted' }, 'none (genesis)')),
    detailRow('protocol version', el('span', { class: 'mono num' }, String(block.protocol_version))),
    detailRow('transactions', el('span', { class: 'mono num' }, String(block.tx_count))),
  );

  const verification = el(
    'details',
    { class: 'collapsible' },
    el('summary', {}, 'Verification'),
    el(
      'div',
      { class: 'details' },
      detailRow('zswap merkle tree root', hashText(block.zswap_merkle_tree_root, true)),
      detailRow('ledger state root', hashText(block.ledger_state_root, true)),
    ),
  );

  root.append(panel(null, details, verification));

  /* --------------------------------------------------------------- txs */
  const txBody = el('div', { class: 'table-body' });
  const txPanel = panel(
    `Transactions (${formatInt(block.tx_count)})`,
    el(
      'div',
      { class: 'table txs-table' },
      el(
        'div',
        { class: 'table-head' },
        el('span', {}, '#'),
        el('span', {}, 'hash'),
        el('span', {}, 'variant'),
        el('span', {}, 'status'),
        el('span', {}, 'fees'),
      ),
      txBody,
    ),
  );
  root.append(txPanel);

  if (block.tx_count === 0) {
    txBody.append(emptyState('No transactions in this block.'));
    return;
  }

  const height = block.height;
  const { controls, start } = pager({
    load: async (cursor) => {
      clear(txBody).append(skeleton(Math.min(TXS_PER_PAGE, block.tx_count)));
      try {
        const page = await api.blockTxs(height, { count: TXS_PER_PAGE, cursor });
        const hashes = page.results;
        const txs = await Promise.all(hashes.map((h) => api.tx(h)));
        clear(txBody);
        if (txs.length === 0) txBody.append(emptyState('No transactions on this page.'));
        for (const t of txs) txBody.append(txRow(t));
        return { count: hashes.length, nextCursor: page.next_cursor };
      } catch (err) {
        clear(txBody).append(errorState(err, 'transactions'));
        return { count: 0, nextCursor: null };
      }
    },
  });
  txPanel.append(controls);
  start();
}

function txRow(t: Tx): HTMLElement {
  return el(
    'a',
    { class: 'table-row', href: `#/tx/${t.hash}` },
    el('span', { class: 'mono num muted' }, String(t.index)),
    el('span', { class: 'mono cell-hash' }, truncateHash(t.hash)),
    variantBadge(t.variant),
    statusPill(t.status),
    el('span', { class: 'mono num' }, `${formatNight(t.paid_fees)} NIGHT`),
  );
}
