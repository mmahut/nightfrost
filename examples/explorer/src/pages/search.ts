// Search resolution: digits -> block height; 64-hex -> probe block hash,
// then tx hash, then address (then contract as a courtesy); else not found.

import { api } from '../api.ts';
import { el } from '../ui.ts';

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

export async function renderSearch(root: HTMLElement, query: string): Promise<void> {
  const q = query.trim();
  const status = el('div', { class: 'state state-empty' }, el('div', { class: 'state-icon spin' }, '❄'), el('div', { class: 'state-detail' }, `Searching for “${q}”…`));
  root.append(el('div', { class: 'page-head' }, el('h1', {}, 'Search')), status);

  if (/^\d+$/.test(q)) {
    location.replace(`#/block/${q}`);
    return;
  }

  if (HEX64.test(q)) {
    const h = q.replace(/^0x/, '').toLowerCase();
    // 1. block hash
    if (await probe(() => api.block(h))) {
      location.replace(`#/block/${h}`);
      return;
    }
    // 2. tx hash
    if (await probe(() => api.tx(h))) {
      location.replace(`#/tx/${h}`);
      return;
    }
    // 3. address (balances endpoint returns [] for unknown addresses, so
    //    also check for any transaction history before deciding)
    const hasBalance = await probe(async () => {
      const balances = await api.addressBalances(h);
      if (balances.length > 0) return true;
      const txs = await api.addressTxs(h, { count: 1 });
      if (txs.results.length > 0) return true;
      throw new Error('no activity');
    });
    if (hasBalance) {
      location.replace(`#/address/${h}`);
      return;
    }
    // 4. contract
    if (await probe(() => api.contract(h))) {
      location.replace(`#/contract/${h}`);
      return;
    }
  }

  status.remove();
  root.append(
    el(
      'div',
      { class: 'state state-empty' },
      el('div', { class: 'state-icon' }, '❄'),
      el('div', { class: 'state-title' }, 'Not found'),
      el(
        'div',
        { class: 'state-detail' },
        `Nothing on this chain matches “${q}”. Try a block height, a 64-character block or transaction hash, or an address.`,
      ),
    ),
  );
}

async function probe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}
