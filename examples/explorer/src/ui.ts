// Small DOM helpers and shared components. No frameworks, no templates —
// everything is built with document.createElement so user data is never
// interpreted as HTML.

import { ApiError, type TokenBalance, type TxStatus, type TxVariant, type Utxo } from './api.ts';
import {
  formatNight,
  formatRawAmount,
  isNativeToken,
  truncateHash,
  formatAbsoluteTime,
  formatRelativeTime,
} from './format.ts';

type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

/* ---------------------------------------------------------------- copy */

export function copyButton(text: string): HTMLElement {
  const btn = el('button', { class: 'copy-btn', type: 'button', title: 'Copy to clipboard', 'aria-label': 'Copy' });
  btn.textContent = '⧉';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '⧉';
        btn.classList.remove('copied');
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });
  return btn;
}

/* ---------------------------------------------------------------- links */

export type LinkKind = 'block' | 'tx' | 'address' | 'contract';

/** Truncated monospace hash link with a copy button. */
export function hashLink(kind: LinkKind, value: string, full = false): HTMLElement {
  const a = el('a', { class: 'hash-link mono', href: `#/${kind}/${value}`, title: value });
  a.textContent = full ? value : truncateHash(value);
  return el('span', { class: 'hash-cell' }, a, copyButton(value));
}

/** Truncated monospace hash (not a link) with a copy button. */
export function hashText(value: string, full = false): HTMLElement {
  const s = el('span', { class: 'mono', title: value }, full ? value : truncateHash(value));
  return el('span', { class: 'hash-cell' }, s, copyButton(value));
}

export function heightLink(height: number): HTMLElement {
  return el('a', { class: 'mono height-link', href: `#/block/${height}` }, height.toLocaleString('en-US'));
}

/* ---------------------------------------------------------------- badges */

export function statusPill(status: TxStatus): HTMLElement {
  const label = status === 'partial_success' ? 'partial success' : status;
  return el('span', { class: `pill pill-${status}` }, label);
}

export function variantBadge(variant: TxVariant): HTMLElement {
  return el('span', { class: `badge badge-variant-${variant.toLowerCase()}` }, variant);
}

export function groupingBadge(grouping: string): HTMLElement {
  const known = ['zswap', 'dust', 'contract'].includes(grouping.toLowerCase()) ? grouping.toLowerCase() : 'other';
  return el('span', { class: `badge badge-group-${known}` }, grouping);
}

export function tokenBadge(tokenType: string): HTMLElement {
  if (isNativeToken(tokenType)) return el('span', { class: 'badge badge-night' }, 'NIGHT');
  return el('span', { class: 'badge badge-token mono', title: tokenType }, truncateHash(tokenType, 6, 4));
}

export function amountCell(value: string, tokenType: string): HTMLElement {
  const amount = isNativeToken(tokenType) ? formatNight(value) : formatRawAmount(value);
  return el('span', { class: 'amount' }, el('span', { class: 'mono num' }, amount), ' ', tokenBadge(tokenType));
}

/* ---------------------------------------------------------------- time */

export function timeCell(ms: number): HTMLElement {
  const wrap = el(
    'span',
    { class: 'time-cell', title: formatAbsoluteTime(ms) },
    el('span', { class: 'time-rel' }, formatRelativeTime(ms)),
  );
  return wrap;
}

export function timeFull(ms: number): HTMLElement {
  return el(
    'span',
    { class: 'time-cell' },
    el('span', {}, formatAbsoluteTime(ms)),
    ' ',
    el('span', { class: 'muted' }, `(${formatRelativeTime(ms)})`),
  );
}

/* ------------------------------------------------------------- sections */

export function detailRow(label: string, ...value: Child[]): HTMLElement {
  return el('div', { class: 'detail-row' }, el('div', { class: 'detail-label' }, label), el('div', { class: 'detail-value' }, ...value));
}

export function panel(title: string | null, ...children: Child[]): HTMLElement {
  const p = el('section', { class: 'panel' });
  if (title) p.append(el('h2', { class: 'panel-title' }, title));
  p.append(...children.filter((c): c is Node | string => c != null));
  return p;
}

/* ------------------------------------------------------ loading / errors */

export function skeleton(rows = 4): HTMLElement {
  const wrap = el('div', { class: 'skeleton-block', 'aria-hidden': 'true' });
  for (let i = 0; i < rows; i++) wrap.append(el('div', { class: 'skeleton-row' }));
  return wrap;
}

export function errorState(err: unknown, context = ''): HTMLElement {
  const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
  const kind = err instanceof ApiError && err.status === 404 ? 'Not found' : 'Something went wrong';
  return el(
    'div',
    { class: 'state state-error' },
    el('div', { class: 'state-icon' }, '✳'),
    el('div', { class: 'state-title' }, context ? `${kind}: ${context}` : kind),
    el('div', { class: 'state-detail mono' }, message),
  );
}

export function emptyState(message: string): HTMLElement {
  return el(
    'div',
    { class: 'state state-empty' },
    el('div', { class: 'state-icon' }, '❄'),
    el('div', { class: 'state-detail' }, message),
  );
}

/* ------------------------------------------------------------ pagination */

export interface PagerHooks {
  /** Load the page after `cursor`; undefined means the first page. */
  load: (cursor?: string) => Promise<{ count: number; nextCursor: string | null }>;
}

/**
 * Cursor pager. Previously visited cursors are retained client-side, so the UI
 * can move backwards without requiring a server-side reverse cursor.
 */
export function pager(hooks: PagerHooks): { controls: HTMLElement; start: () => void } {
  const cursors: Array<string | undefined> = [undefined];
  let pageIndex = 0;
  let nextCursor: string | null = null;
  let busy = false;
  const prev = el('button', { class: 'pager-btn', type: 'button' }, '← prev');
  const next = el('button', { class: 'pager-btn', type: 'button' }, 'next →');
  const label = el('span', { class: 'pager-label mono' }, 'page 1');
  const controls = el('div', { class: 'pager' }, prev, label, next);

  async function go(index: number) {
    if (busy || index < 0 || index >= cursors.length) return;
    busy = true;
    prev.setAttribute('disabled', '');
    next.setAttribute('disabled', '');
    try {
      const page = await hooks.load(cursors[index]);
      pageIndex = index;
      nextCursor = page.nextCursor;
      label.textContent = `page ${pageIndex + 1}`;
      if (pageIndex > 0) prev.removeAttribute('disabled');
      if (nextCursor !== null) next.removeAttribute('disabled');
    } finally {
      busy = false;
    }
  }

  prev.addEventListener('click', () => void go(pageIndex - 1));
  next.addEventListener('click', () => {
    if (nextCursor === null) return;
    cursors.length = pageIndex + 1;
    cursors.push(nextCursor);
    void go(pageIndex + 1);
  });
  return { controls, start: () => void go(0) };
}

/* ---------------------------------------------------------------- utxos */

export function utxoCard(u: Utxo): HTMLElement {
  const card = el('div', { class: 'utxo-card' });
  card.append(
    el('div', { class: 'utxo-amount' }, amountCell(u.value, u.token_type)),
    el(
      'div',
      { class: 'utxo-meta' },
      el('span', { class: 'muted' }, 'owner '),
      hashLink('address', u.owner),
    ),
    el(
      'div',
      { class: 'utxo-meta' },
      el('span', { class: 'muted' }, 'intent '),
      hashText(u.intent_hash),
      el('span', { class: 'muted mono' }, ` #${u.output_index}`),
    ),
  );
  if (u.registered_for_dust_generation) {
    card.append(el('div', { class: 'utxo-meta' }, el('span', { class: 'badge badge-dust' }, '❄ dust generation')));
  }
  return card;
}

export function balanceCards(balances: TokenBalance[]): HTMLElement {
  const wrap = el('div', { class: 'balance-cards' });
  const native = balances.find((b) => isNativeToken(b.token_type));
  const others = balances.filter((b) => !isNativeToken(b.token_type));
  if (native) {
    wrap.append(
      el(
        'div',
        { class: 'balance-card balance-native' },
        el('div', { class: 'balance-label' }, 'NIGHT balance'),
        el('div', { class: 'balance-value mono num' }, formatNight(native.amount)),
        el('div', { class: 'balance-sub muted mono' }, `${formatRawAmount(native.amount)} STAR`),
      ),
    );
  }
  for (const b of others) {
    wrap.append(
      el(
        'div',
        { class: 'balance-card' },
        el('div', { class: 'balance-label' }, tokenBadge(b.token_type), ' ', copyButton(b.token_type)),
        el('div', { class: 'balance-value mono num' }, formatRawAmount(b.amount)),
      ),
    );
  }
  if (!native && others.length === 0) wrap.append(emptyState('No balances for this address.'));
  return wrap;
}
