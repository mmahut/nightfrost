// Transaction page: status, fees, identifiers, UTXO in→out flow, events.

import { api, type ChainEvent } from '../api.ts';
import { formatHexDump, formatNight, truncateHash } from '../format.ts';
import {
  clear,
  detailRow,
  el,
  emptyState,
  errorState,
  groupingBadge,
  hashLink,
  hashText,
  heightLink,
  panel,
  skeleton,
  statusPill,
  timeFull,
  utxoCard,
  variantBadge,
} from '../ui.ts';

export async function renderTx(root: HTMLElement, hash: string): Promise<void> {
  root.append(el('div', { class: 'page-head' }, el('h1', {}, 'Transaction')), skeleton(6));

  let tx;
  try {
    tx = await api.tx(hash);
  } catch (err) {
    clear(root).append(
      el('div', { class: 'page-head' }, el('h1', {}, 'Transaction')),
      errorState(err, `tx ${truncateHash(hash, 12, 8)}`),
    );
    return;
  }

  clear(root);
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Transaction'),
      el('div', { class: 'head-badges' }, statusPill(tx.status), variantBadge(tx.variant)),
    ),
  );

  /* ------------------------------------------------------------ fields */
  const details = el('div', { class: 'details' });
  details.append(
    detailRow('hash', hashText(tx.hash, true)),
    detailRow(
      'block',
      heightLink(tx.block_height),
      el('span', { class: 'muted' }, '  ·  '),
      hashLink('block', tx.block_hash),
    ),
    detailRow('time', timeFull(tx.block_time)),
    detailRow('index in block', el('span', { class: 'mono num' }, String(tx.index))),
    detailRow(
      'fees paid',
      el('span', { class: 'mono num' }, `${formatNight(tx.paid_fees)} NIGHT`),
      el('span', { class: 'muted mono' }, `  (estimated ${formatNight(tx.estimated_fees)} NIGHT)`),
    ),
    detailRow(
      'activity',
      el(
        'span',
        { class: 'mono muted' },
        `${tx.utxo_created_count} utxos created · ${tx.utxo_spent_count} spent · ${tx.event_count} events · ${tx.contract_action_count} contract actions`,
      ),
    ),
  );
  if (tx.identifiers.length > 0) {
    const list = el('div', { class: 'ident-list' });
    for (const ident of tx.identifiers) list.append(hashText(ident));
    details.append(detailRow(`identifiers (${tx.identifiers.length})`, list));
  }
  root.append(panel(null, details));

  /* -------------------------------------------------------- utxo flow */
  const flowWrap = el('div', { class: 'utxo-flow' }, skeleton(2));
  root.append(panel('UTXO flow', flowWrap));
  void api
    .txUtxos(tx.hash)
    .then((u) => {
      clear(flowWrap);
      if (u.inputs.length === 0 && u.outputs.length === 0) {
        flowWrap.append(emptyState('No shielded-ledger UTXOs touched by this transaction.'));
        return;
      }
      const inputs = el('div', { class: 'utxo-col' }, el('h3', { class: 'utxo-col-title' }, `Inputs (${u.inputs.length})`));
      if (u.inputs.length === 0) inputs.append(el('div', { class: 'muted utxo-none' }, 'none, minted'));
      for (const i of u.inputs) inputs.append(utxoCard(i));
      const outputs = el('div', { class: 'utxo-col' }, el('h3', { class: 'utxo-col-title' }, `Outputs (${u.outputs.length})`));
      if (u.outputs.length === 0) outputs.append(el('div', { class: 'muted utxo-none' }, 'none'));
      for (const o of u.outputs) outputs.append(utxoCard(o));
      flowWrap.append(inputs, el('div', { class: 'utxo-arrow', 'aria-hidden': 'true' }, '→'), outputs);
    })
    .catch((err) => {
      clear(flowWrap).append(errorState(err, 'utxos'));
    });

  /* ------------------------------------------------------------ events */
  const eventsWrap = el('div', { class: 'events-list' }, skeleton(Math.max(1, Math.min(tx.event_count, 4))));
  root.append(panel(`Events (${tx.event_count})`, eventsWrap));
  void api
    .txEvents(tx.hash)
    .then((events) => {
      clear(eventsWrap);
      if (events.length === 0) {
        eventsWrap.append(emptyState('No events emitted by this transaction.'));
        return;
      }
      for (const ev of events) eventsWrap.append(eventCard(ev));
    })
    .catch((err) => {
      clear(eventsWrap).append(errorState(err, 'events'));
    });
}

function eventCard(ev: ChainEvent): HTMLElement {
  const head = el(
    'div',
    { class: 'event-head' },
    el('span', { class: 'mono muted' }, `#${ev.id}`),
    groupingBadge(ev.grouping),
  );
  const card = el('div', { class: 'event-card' }, head);

  if (typeof ev.attributes === 'string') {
    head.append(el('span', { class: 'event-tag' }, ev.attributes));
  } else {
    const tag = Object.keys(ev.attributes)[0];
    if (tag) head.append(el('span', { class: 'event-tag' }, tag));
    card.append(el('pre', { class: 'json-view mono' }, JSON.stringify(ev.attributes, null, 2)));
  }

  card.append(
    el(
      'details',
      { class: 'collapsible collapsible-sm' },
      el('summary', {}, `raw (${Math.ceil(ev.raw.length / 2)} bytes)`),
      el('pre', { class: 'hex-view mono' }, formatHexDump(ev.raw)),
    ),
  );
  return card;
}
