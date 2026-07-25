// Dashboard: sync progress, network chip, stat tiles, live latest-blocks and
// latest-transactions tables, recent ledger-events ticker.

import { api, type Block, type ChainEvent, type Tx } from '../api.ts';
import { epochAt, formatDuration } from '../epoch.ts';
import { formatInt, formatNight, truncateHash } from '../format.ts';
import { formatUsd, formatUsdCompact, nightPrice } from '../price.ts';
import {
  clear,
  el,
  errorState,
  groupingBadge,
  heightLink,
  skeleton,
  statusPill,
  timeCell,
  variantBadge,
} from '../ui.ts';
import { mountStarfield } from '../starfield.ts';
import type { Cleanup } from '../router.ts';

const POLL_MS = 6000; // the chain's block time
const BLOCK_ROWS = 10;
const TX_ROWS = 10;
const EVENT_ROWS = 8;
const SEED_EVENTS = 60; // events scanned to locate recent tx-bearing blocks

export async function renderHome(root: HTMLElement): Promise<Cleanup> {
  const disposers: Cleanup[] = [];
  let alive = true;

  /* ------------------------------------------------------------- hero */
  const canvas = el('canvas', { class: 'hero-canvas', 'aria-hidden': 'true' });
  const syncBar = el('div', { class: 'sync-bar-fill' });
  const syncPct = el('span', { class: 'sync-pct mono num' }, '-');
  const syncDetail = el('div', { class: 'sync-detail mono muted' }, 'connecting…');
  const networkChip = el('span', { class: 'chip' }, '· · ·');

  const searchInput = el('input', {
    class: 'search-input mono',
    type: 'search',
    placeholder: 'block height · block hash · tx hash · address',
    'aria-label': 'Search the chain',
    spellcheck: 'false',
  });
  const searchForm = el('form', { class: 'hero-search' }, searchInput, el('button', { class: 'search-go', type: 'submit' }, 'Search'));
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
  });

  const hero = el(
    'section',
    { class: 'hero' },
    canvas,
    el(
      'div',
      { class: 'hero-inner' },
      el('h1', { class: 'hero-title' }, 'The Midnight chain, ', el('span', { class: 'accent' }, 'under frost'), '.'),
      el('div', { class: 'hero-chips' }, networkChip),
      searchForm,
      el(
        'div',
        { class: 'sync-wrap' },
        el('div', { class: 'sync-head' }, el('span', { class: 'label' }, 'index sync'), syncPct),
        el('div', { class: 'sync-bar' }, syncBar),
        syncDetail,
      ),
    ),
  );
  root.append(hero);
  disposers.push(mountStarfield(canvas));

  /* -------------------------------------------------------- stat tiles */
  const tile = (icon: string, label: string) => {
    const value = el('div', { class: 'stat-value mono num' }, '-');
    const sub = el('div', { class: 'stat-sub muted' }, '');
    const box = el(
      'div',
      { class: 'stat-tile' },
      el('div', { class: 'stat-label' }, el('span', { class: 'stat-icon', 'aria-hidden': 'true' }, icon), label),
      value,
      sub,
    );
    return { box, value, sub };
  };

  const priceTile = tile('✦', 'night price');
  const txTile = tile('⇄', 'transactions');
  const contractsTile = tile('❖', 'contracts');
  const epochTile = tile('◷', 'epoch');
  const epochBarFill = el('div', { class: 'tile-bar-fill' });
  epochTile.value.after(el('div', { class: 'tile-bar' }, epochBarFill));

  root.append(el('div', { class: 'stat-tiles' }, priceTile.box, txTile.box, contractsTile.box, epochTile.box));

  /* ------------------------------------------------------------ panels */
  const blocksBody = el('div', { class: 'table-body' }, skeleton(BLOCK_ROWS));
  const blocksPanel = el(
    'section',
    { class: 'panel' },
    el('h2', { class: 'panel-title' }, 'Latest blocks ', el('span', { class: 'live-dot', title: 'live: polling every 6s' })),
    el(
      'div',
      { class: 'table blocks-table' },
      el(
        'div',
        { class: 'table-head' },
        el('span', {}, 'height'),
        el('span', {}, 'hash'),
        el('span', {}, 'txs'),
        el('span', {}, 'author'),
        el('span', {}, 'time'),
      ),
      blocksBody,
    ),
  );

  const txsBody = el('div', { class: 'table-body' }, skeleton(TX_ROWS));
  const txsPanel = el(
    'section',
    { class: 'panel' },
    el('h2', { class: 'panel-title' }, 'Latest transactions ', el('span', { class: 'live-dot', title: 'live' })),
    el(
      'div',
      { class: 'table home-txs-table' },
      el(
        'div',
        { class: 'table-head' },
        el('span', {}, 'hash'),
        el('span', {}, 'block'),
        el('span', {}, 'status'),
        el('span', { title: 'paid fees in NIGHT' }, 'fees'),
        el('span', {}, 'time'),
      ),
      txsBody,
    ),
  );

  const eventsBody = el('div', { class: 'ticker-body' }, skeleton(EVENT_ROWS));
  const eventsPanel = el(
    'section',
    { class: 'panel' },
    el('h2', { class: 'panel-title' }, 'Ledger events ', el('span', { class: 'live-dot', title: 'live' })),
    eventsBody,
  );

  root.append(el('div', { class: 'home-grid' }, blocksPanel, txsPanel), eventsPanel);

  /* ------------------------------------------------------- sync + net */
  let latestBlock: Block | null = null;

  async function refreshSync() {
    try {
      const s = await api.syncStatus();
      if (!alive) return;
      syncPct.textContent = `${s.percentage.toFixed(2)}%`;
      syncBar.style.width = `${Math.min(100, Math.max(0.5, s.percentage))}%`;
      syncBar.classList.toggle('done', s.caught_up);
      syncDetail.textContent = `${formatInt(s.indexed_height)} of ${formatInt(s.node_height)} blocks indexed`;
    } catch (err) {
      if (alive) syncDetail.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  void api
    .network()
    .then((n) => {
      if (!alive) return;
      networkChip.textContent = '';
      networkChip.append(el('strong', {}, n.network_id));
      networkChip.title = `genesis ${n.genesis_hash}`;
    })
    .catch(() => {
      networkChip.textContent = 'network unavailable';
    });

  /* ------------------------------------------------------------- tiles */
  async function refreshPriceTile() {
    const p = await nightPrice(); // cached 60 s; null on failure
    if (!alive) return;
    if (p) {
      priceTile.value.textContent = formatUsd(p.usd);
      priceTile.sub.textContent = `${formatUsdCompact(p.marketCapUsd)} market cap`;
    } else {
      priceTile.value.textContent = '-';
      priceTile.sub.textContent = 'price unavailable';
    }
  }

  async function refreshStatsTiles() {
    try {
      const s = await api.stats();
      if (!alive) return;
      txTile.value.textContent = formatInt(s.total_transactions);
      txTile.sub.textContent = `${formatInt(s.total_ledger_events)} ledger events`;
      contractsTile.value.textContent = formatInt(s.total_contracts);
      contractsTile.sub.textContent = `${formatInt(s.total_contract_actions)} contract actions`;
    } catch {
      /* tiles keep their last values */
    }
  }

  function refreshEpochTile() {
    if (!latestBlock) return;
    const e = epochAt(latestBlock.timestamp);
    epochTile.value.textContent = `#${e.epoch}`;
    epochBarFill.style.width = `${(e.progress * 100).toFixed(1)}%`;
    epochTile.sub.textContent = `${Math.round(e.progress * 100)}% · ${formatDuration(e.remainingS)} left`;
  }

  /* ------------------------------------------------------------ blocks */
  let topHeight = -1;

  function blockRow(b: Block, fresh: boolean): HTMLElement {
    return el(
      'a',
      { class: `table-row${fresh ? ' frost-new' : ''}`, href: `#/block/${b.height}` },
      el('span', { class: 'mono num' }, formatInt(b.height)),
      el('span', { class: 'mono cell-hash' }, truncateHash(b.hash)),
      el('span', { class: 'mono num' }, String(b.tx_count)),
      el('span', { class: 'mono cell-hash muted' }, b.author ? truncateHash(b.author, 6, 6) : '-'),
      timeCell(b.timestamp),
    );
  }

  async function refreshBlocks() {
    try {
      const latest = await api.latestBlock();
      if (!alive) return;
      latestBlock = latest;
      refreshEpochTile();
      if (latest.height === topHeight) return;
      const first = topHeight === -1;
      const wanted: number[] = [];
      for (let h = latest.height; h > latest.height - BLOCK_ROWS && h >= 0; h--) wanted.push(h);
      const blocks = await Promise.all(wanted.map((h) => (h === latest.height ? Promise.resolve(latest) : api.block(h))));
      if (!alive) return;
      const prevTop = topHeight;
      topHeight = latest.height;
      clear(blocksBody);
      for (const b of blocks) blocksBody.append(blockRow(b, !first && b.height > prevTop));
      // feed newly arrived tx-bearing blocks into the latest-transactions list
      const newWithTxs = blocks.filter((b) => b.tx_count > 0 && (first || b.height > prevTop));
      if (newWithTxs.length > 0) void ingestTxBlocks(newWithTxs.map((b) => b.height), !first);
    } catch (err) {
      if (alive && topHeight === -1) {
        clear(blocksBody);
        blocksBody.append(errorState(err, 'latest blocks'));
      }
    }
  }

  /* -------------------------------------------------------- latest txs */
  const txCache = new Map<string, Tx>(); // resolved summaries — no refetch churn
  let recentTxs: Tx[] = []; // newest first
  const freshTxs = new Set<string>(); // hashes that frost-glow on next paint
  let txSeeded = false;

  async function resolveTx(hash: string): Promise<Tx> {
    const hit = txCache.get(hash);
    if (hit) return hit;
    const t = await api.tx(hash);
    txCache.set(hash, t);
    return t;
  }

  function txRow(t: Tx, fresh: boolean): HTMLElement {
    return el(
      'a',
      { class: `table-row${fresh ? ' frost-new' : ''}`, href: `#/tx/${t.hash}` },
      el('span', { class: 'mono cell-hash' }, truncateHash(t.hash)),
      el('span', { class: 'mono num muted' }, formatInt(t.block_height)),
      el('span', { class: 'cell-badges' }, variantBadge(t.variant), ' ', statusPill(t.status)),
      el('span', { class: 'mono num' }, formatNight(t.paid_fees)),
      timeCell(t.block_time),
    );
  }

  function paintTxs() {
    clear(txsBody);
    if (recentTxs.length === 0) {
      txsBody.append(el('div', { class: 'state state-empty' }, el('div', { class: 'state-detail' }, 'No recent transactions found.')));
      return;
    }
    for (const t of recentTxs) txsBody.append(txRow(t, freshTxs.has(t.hash)));
    freshTxs.clear();
  }

  async function ingestTxBlocks(heights: number[], markFresh: boolean) {
    try {
      const perBlock = await Promise.all(heights.map((h) => api.blockTxs(h, { count: 100 })));
      const txs = await Promise.all(perBlock.flatMap((page) => page.results).map(resolveTx));
      if (!alive || txs.length === 0) return;
      const known = new Set(recentTxs.map((t) => t.hash));
      for (const t of txs) {
        if (known.has(t.hash)) continue;
        recentTxs.push(t);
        if (markFresh) freshTxs.add(t.hash);
      }
      recentTxs.sort((a, b) => b.block_height - a.block_height || b.index - a.index);
      recentTxs = recentTxs.slice(0, TX_ROWS);
      paintTxs();
    } catch {
      /* keep whatever is already rendered */
    }
  }

  /**
   * Tx-bearing blocks are sparse on this chain, so the 10-block poll window
   * rarely contains any. Seed the list from recent ledger events instead —
   * every event belongs to a transaction, so its block has transactions.
   */
  async function seedTxs(events: ChainEvent[]) {
    if (txSeeded) return;
    txSeeded = true;
    try {
      if (!alive) return;
      const heights = [...new Set(events.map((e) => e.block_height))].sort((a, b) => b - a);
      for (const h of heights) {
        if (recentTxs.length >= TX_ROWS) break;
        await ingestTxBlocks([h], false);
        if (!alive) return;
      }
      if (recentTxs.length === 0) paintTxs(); // show the empty state
    } catch (err) {
      if (alive && recentTxs.length === 0) {
        clear(txsBody).append(errorState(err, 'latest transactions'));
      }
    }
  }

  /* ------------------------------------------------------------ events */
  let lastEventId: number | null = null;
  const recentEvents: ChainEvent[] = [];

  function eventRow(ev: ChainEvent): HTMLElement {
    const tag = typeof ev.attributes === 'string' ? ev.attributes : Object.keys(ev.attributes)[0] ?? '-';
    return el(
      'div',
      { class: 'ticker-row' },
      el('span', { class: 'mono muted ticker-id' }, `#${ev.id}`),
      groupingBadge(ev.grouping),
      el('span', { class: 'ticker-tag' }, tag),
      el('span', { class: 'ticker-block' }, 'block ', heightLink(ev.block_height)),
    );
  }

  function paintEvents() {
    clear(eventsBody);
    if (recentEvents.length === 0) {
      eventsBody.append(el('div', { class: 'state state-empty' }, el('div', { class: 'state-detail' }, 'No ledger events yet.')));
      return;
    }
    for (const ev of recentEvents) eventsBody.append(eventRow(ev));
  }

  async function refreshEvents() {
    try {
      if (lastEventId === null) {
        const page = await api.ledgerEvents({ count: SEED_EVENTS, order: 'desc' });
        if (!alive) return;
        void seedTxs(page.results);
        recentEvents.push(...page.results.slice(0, EVENT_ROWS));
        if (page.results.length > 0) lastEventId = Math.max(...page.results.map((event) => event.id));
        paintEvents();
      } else {
        const page = await api.ledgerEvents({ from: lastEventId + 1, count: EVENT_ROWS, order: 'asc' });
        if (!alive || page.results.length === 0) return;
        recentEvents.unshift(...[...page.results].reverse());
        recentEvents.length = Math.min(recentEvents.length, EVENT_ROWS);
        lastEventId = Math.max(lastEventId, ...page.results.map((event) => event.id));
        paintEvents();
        eventsBody.firstElementChild?.classList.add('frost-new');
        // new events also flag freshly indexed tx-bearing blocks — feed the list
        const evHeights = [...new Set(page.results.map((e) => e.block_height))];
        void ingestTxBlocks(evHeights, true);
      }
    } catch (err) {
      if (alive && lastEventId === null) {
        clear(eventsBody);
        eventsBody.append(errorState(err, 'ledger events'));
      }
    }
  }

  /* ------------------------------------------------------------- ticks */
  await Promise.all([refreshSync(), refreshBlocks()]);
  void refreshEvents();
  void refreshPriceTile();
  void refreshStatsTiles();

  const timer = window.setInterval(() => {
    void refreshSync();
    void refreshBlocks();
    void refreshEvents();
    void refreshPriceTile();
    void refreshStatsTiles();
  }, POLL_MS);

  return () => {
    alive = false;
    window.clearInterval(timer);
    for (const d of disposers) d();
  };
}
