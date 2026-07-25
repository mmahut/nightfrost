// Contract page: record fields, balances, actions table, state hex viewer.

import { api } from '../api.ts';
import { formatHexDump, formatInt, truncateHash } from '../format.ts';
import {
  balanceCards,
  clear,
  detailRow,
  el,
  emptyState,
  errorState,
  hashLink,
  hashText,
  heightLink,
  pager,
  panel,
  skeleton,
} from '../ui.ts';

const PAGE_SIZE = 10;

export async function renderContract(root: HTMLElement, addr: string): Promise<void> {
  root.append(el('div', { class: 'page-head' }, el('h1', {}, 'Contract')), skeleton(5));

  let contract;
  try {
    contract = await api.contract(addr);
  } catch (err) {
    clear(root).append(
      el('div', { class: 'page-head' }, el('h1', {}, 'Contract')),
      errorState(err, `contract ${truncateHash(addr, 12, 8)}`),
    );
    return;
  }

  clear(root);
  root.append(
    el('div', { class: 'page-head page-head-stack' }, el('h1', {}, 'Contract'), hashText(contract.address, true)),
  );

  /* ------------------------------------------------------------ fields */
  const details = el('div', { class: 'details' });
  details.append(
    detailRow('deploy action id', el('span', { class: 'mono num' }, String(contract.deploy_action_id))),
    detailRow('latest action id', el('span', { class: 'mono num' }, String(contract.latest_action_id))),
    detailRow('latest action type', el('span', { class: 'badge badge-action' }, contract.latest_action_type)),
    detailRow('latest block', heightLink(contract.latest_block_height)),
  );
  root.append(panel(null, details));

  /* ---------------------------------------------------------- balances */
  root.append(panel('Balances', balanceCards(contract.balances ?? [])));

  /* ----------------------------------------------------------- actions */
  const actionsBody = el('div', { class: 'table-body' });
  const actionsPanel = panel(
    'Actions',
    el(
      'div',
      { class: 'table actions-table' },
      el(
        'div',
        { class: 'table-head' },
        el('span', {}, 'id'),
        el('span', {}, 'type'),
        el('span', {}, 'entry point'),
        el('span', {}, 'transaction'),
        el('span', {}, 'block'),
      ),
      actionsBody,
    ),
  );
  root.append(actionsPanel);

  const { controls, start } = pager({
    load: async (cursor) => {
      clear(actionsBody).append(skeleton(5));
      try {
        const page = await api.contractActions(addr, { count: PAGE_SIZE, cursor, order: 'desc' });
        const actions = page.results;
        clear(actionsBody);
        if (actions.length === 0) actionsBody.append(emptyState('No actions recorded.'));
        for (const a of actions) {
          actionsBody.append(
            el(
              'div',
              { class: 'table-row table-row-static' },
              el('span', { class: 'mono num muted' }, String(a.id)),
              el('span', { class: 'badge badge-action' }, a.type),
              el('span', { class: 'mono' }, a.entry_point ?? '-'),
              hashLink('tx', a.tx_hash),
              heightLink(a.block_height),
            ),
          );
        }
        return { count: actions.length, nextCursor: page.next_cursor };
      } catch (err) {
        clear(actionsBody).append(errorState(err, 'actions'));
        return { count: 0, nextCursor: null };
      }
    },
  });
  actionsPanel.append(controls);
  start();

  /* ------------------------------------------------------------- state */
  const stateWrap = el('div', {}, skeleton(2));
  root.append(panel('State', stateWrap));
  void api
    .contractState(addr)
    .then((s) => {
      clear(stateWrap);
      const bytes = Math.ceil(s.state.replace(/^0x/, '').length / 2);
      stateWrap.append(
        el(
          'div',
          { class: 'muted state-meta' },
          `as of block `,
          heightLink(s.block_height),
          ` · ${formatInt(bytes)} bytes`,
        ),
        el(
          'details',
          { class: 'collapsible' },
          el('summary', {}, 'raw state'),
          el('pre', { class: 'hex-view mono' }, formatHexDump(s.state)),
        ),
      );
    })
    .catch((err) => {
      clear(stateWrap).append(errorState(err, 'contract state'));
    });
}
