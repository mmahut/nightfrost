// Address page: balance cards, UTXO tab (token filter), transactions tab.

import { api, type TokenBalance, type Tx } from '../api.ts';
import { isNativeToken, truncateHash } from '../format.ts';
import {
  balanceCards,
  clear,
  el,
  emptyState,
  errorState,
  hashText,
  pager,
  panel,
  skeleton,
  statusPill,
  timeCell,
  variantBadge,
  utxoCard,
} from '../ui.ts';

const PAGE_SIZE = 10;

export async function renderAddress(root: HTMLElement, addr: string): Promise<void> {
  root.append(el('div', { class: 'page-head' }, el('h1', {}, 'Address')), skeleton(4));

  let balances: TokenBalance[];
  try {
    balances = await api.addressBalances(addr);
  } catch (err) {
    clear(root).append(
      el('div', { class: 'page-head' }, el('h1', {}, 'Address')),
      errorState(err, `address ${truncateHash(addr, 12, 8)}`),
    );
    return;
  }

  clear(root);
  root.append(
    el('div', { class: 'page-head page-head-stack' }, el('h1', {}, 'Address'), hashText(addr, true)),
    balanceCards(balances),
  );

  /* -------------------------------------------------------------- tabs */
  const utxoTabBtn = el('button', { class: 'tab active', type: 'button' }, 'UTXOs');
  const txTabBtn = el('button', { class: 'tab', type: 'button' }, 'Transactions');
  const tabBody = el('div', { class: 'tab-body' });
  root.append(panel(null, el('div', { class: 'tabs' }, utxoTabBtn, txTabBtn), tabBody));

  let started: 'utxos' | 'txs' | null = null;
  const select = (which: 'utxos' | 'txs') => {
    utxoTabBtn.classList.toggle('active', which === 'utxos');
    txTabBtn.classList.toggle('active', which === 'txs');
    if (started === which) return;
    started = which;
    clear(tabBody);
    if (which === 'utxos') mountUtxosTab(tabBody, addr, balances);
    else mountTxsTab(tabBody, addr);
  };
  utxoTabBtn.addEventListener('click', () => select('utxos'));
  txTabBtn.addEventListener('click', () => select('txs'));
  select('utxos');
}

/* ------------------------------------------------------------- utxo tab */

function mountUtxosTab(body: HTMLElement, addr: string, balances: TokenBalance[]): void {
  const filter = el('select', { class: 'token-filter mono', 'aria-label': 'Filter by token' });
  filter.append(el('option', { value: '' }, 'all tokens'));
  for (const b of balances) {
    filter.append(
      el('option', { value: b.token_type }, isNativeToken(b.token_type) ? 'NIGHT' : truncateHash(b.token_type, 10, 6)),
    );
  }
  const grid = el('div', { class: 'utxo-grid' });
  body.append(el('div', { class: 'tab-toolbar' }, filter), grid);

  const buildPager = () => {
    const { controls, start } = pager({
      load: async (cursor) => {
        clear(grid).append(skeleton(4));
        try {
          const token = filter.value || undefined;
          const page = await api.addressUtxos(addr, token, { count: PAGE_SIZE, cursor, order: 'desc' });
          const utxos = page.results;
          clear(grid);
          if (utxos.length === 0) grid.append(emptyState('No unspent outputs here.'));
          for (const u of utxos) grid.append(utxoCard(u));
          return { count: utxos.length, nextCursor: page.next_cursor };
        } catch (err) {
          clear(grid).append(errorState(err, 'utxos'));
          return { count: 0, nextCursor: null };
        }
      },
    });
    return { controls, start };
  };

  let p = buildPager();
  body.append(p.controls);
  p.start();

  filter.addEventListener('change', () => {
    p.controls.remove();
    p = buildPager();
    body.append(p.controls);
    p.start();
  });
}

/* --------------------------------------------------------------- tx tab */

function mountTxsTab(body: HTMLElement, addr: string): void {
  const tbody = el('div', { class: 'table-body' });
  body.append(
    el(
      'div',
      { class: 'table txs-table' },
      el(
        'div',
        { class: 'table-head' },
        el('span', {}, 'block'),
        el('span', {}, 'hash'),
        el('span', {}, 'variant'),
        el('span', {}, 'status'),
        el('span', {}, 'time'),
      ),
      tbody,
    ),
  );

  const { controls, start } = pager({
    load: async (cursor) => {
      clear(tbody).append(skeleton(PAGE_SIZE));
      try {
        const page = await api.addressTxs(addr, { count: PAGE_SIZE, cursor, order: 'desc' });
        const hashes = page.results;
        const txs = await Promise.all(hashes.map((h) => api.tx(h)));
        clear(tbody);
        if (txs.length === 0) tbody.append(emptyState('No transactions for this address.'));
        for (const t of txs) tbody.append(txRow(t));
        return { count: hashes.length, nextCursor: page.next_cursor };
      } catch (err) {
        clear(tbody).append(errorState(err, 'transactions'));
        return { count: 0, nextCursor: null };
      }
    },
  });
  body.append(controls);
  start();
}

function txRow(t: Tx): HTMLElement {
  return el(
    'a',
    { class: 'table-row', href: `#/tx/${t.hash}` },
    el('span', { class: 'mono num' }, t.block_height.toLocaleString('en-US')),
    el('span', { class: 'mono cell-hash' }, truncateHash(t.hash)),
    variantBadge(t.variant),
    statusPill(t.status),
    timeCell(t.block_time),
  );
}
