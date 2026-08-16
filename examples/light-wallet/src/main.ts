import './polyfills.ts';
import './style.css';
import { ApiError, NightfrostApi, type TokenBalance, type Tx, type TxStatus } from './api.ts';
import { formatNight, formatRawAmount, formatTime, isNativeToken, truncate } from './format.ts';
import { EXPLORER_URL, NETWORKS, type NetworkDef } from './networks.ts';
import {
  formatNightAddress,
  generateRecoveryPhrase,
  NIGHT_DERIVATION_PATH,
} from './wallet.ts';
import type { LocalWalletSession } from './nightfrost-sdk.ts';

const LOGO_SVG = `<svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="38,8 48,22 58,8"/><polyline points="38,8 48,22 58,8" transform="rotate(60 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(120 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(180 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(240 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(300 48 48)"/></g><circle cx="48" cy="48" r="10" fill="#8fd0e4"/></svg>`;

type Child = Node | string | null | undefined;
type Theme = 'auto' | 'light' | 'dark';

const THEME_KEY = 'nf.theme';
const THEME_ICONS: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
const THEME_NEXT: Record<Theme, Theme> = { dark: 'light', light: 'auto', auto: 'dark' };

let activeNetwork = NETWORKS[0];
let walletAddress: string | null = null;
let walletSession: LocalWalletSession | null = null;
let txCursors: Array<string | undefined> = [undefined];
let txPage = 0;
let renderVersion = 0;

const app = document.querySelector<HTMLDivElement>('#app')!;
const outlet = el('main', { class: 'shell page-outlet wallet-outlet' });
const footer = el('footer', { class: 'site-footer' });
const mainnetDialog = buildMainnetDialog();

app.append(buildHeader(), outlet, footer, mainnetDialog);
renderFooter();
renderLanding();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

function buildHeader(): HTMLElement {
  const logo = el('a', { class: 'logo', href: '#', 'aria-label': 'nightfrost light wallet' });
  logo.innerHTML = LOGO_SVG;
  logo.append(
    el('span', { class: 'logo-word' }, 'night', el('span', { class: 'accent' }, 'frost')),
    el('span', { class: 'wallet-product muted' }, 'light wallet'),
  );
  logo.addEventListener('click', (event) => {
    event.preventDefault();
    if (!walletAddress) renderLanding();
  });

  let theme = currentTheme();
  const themeButton = el(
    'button',
    { class: 'theme-btn', type: 'button', title: `theme: ${theme}`, 'aria-label': 'Change theme' },
    THEME_ICONS[theme],
  );
  themeButton.addEventListener('click', () => {
    theme = THEME_NEXT[theme];
    applyTheme(theme);
    themeButton.textContent = THEME_ICONS[theme];
    themeButton.title = `theme: ${theme}`;
  });

  return el(
    'header',
    { class: 'site-header' },
    el('div', { class: 'shell header-row' }, logo, el('span', { class: 'wallet-header-spacer' }), buildNetworkPill(), themeButton),
  );
}

function buildNetworkPill(): HTMLElement {
  const dot = (color: string) => {
    const node = el('span', { class: 'net-dot', 'aria-hidden': 'true' });
    node.style.background = color;
    return node;
  };

  const button = el(
    'button',
    {
      class: 'net-pill',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: `${activeNetwork.name}: ${activeNetwork.apiUrl}`,
    },
    dot(activeNetwork.color),
    el('span', { class: 'net-name' }, activeNetwork.name),
    el('span', { class: 'net-caret', 'aria-hidden': 'true' }, '⌄'),
  );
  const menu = el('div', { class: 'net-menu', role: 'menu', hidden: '' });

  const close = () => {
    menu.setAttribute('hidden', '');
    button.setAttribute('aria-expanded', 'false');
  };

  for (const network of NETWORKS) {
    const selected = network.name === activeNetwork.name;
    const item = el(
      'button',
      {
        class: 'net-item',
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(selected),
      },
      dot(network.color),
      el('span', { class: 'net-name' }, network.name),
      el('span', { class: 'net-check' }, selected ? '✓' : ''),
    );
    item.addEventListener('click', () => {
      close();
      selectNetwork(network);
    });
    menu.append(item);
  }

  const wrap = el('div', { class: 'net-wrap' }, button, menu);
  button.addEventListener('click', () => {
    const opening = menu.hasAttribute('hidden');
    if (!opening) return close();
    menu.removeAttribute('hidden');
    button.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      window.addEventListener(
        'click',
        (event) => {
          if (!wrap.contains(event.target as Node)) close();
        },
        { once: true },
      );
    });
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      button.focus();
    }
  });
  return wrap;
}

function selectNetwork(network: NetworkDef): void {
  if (!network.enabled) {
    mainnetDialog.showModal();
    return;
  }
  if (network.name === activeNetwork.name) return;

  activeNetwork = network;
  txCursors = [undefined];
  txPage = 0;
  document.querySelector('.site-header')?.replaceWith(buildHeader());
  renderFooter();
  if (walletSession) void closeWallet().then(() => renderLanding());
  else renderLanding();
}

function buildMainnetDialog(): HTMLDialogElement {
  const dialog = el('dialog', { class: 'mainnet-dialog', 'aria-labelledby': 'mainnet-title' });
  const close = el('button', { class: 'search-go dialog-close', type: 'button' }, 'I understand');
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.append(
    el('div', { class: 'dialog-icon', 'aria-hidden': 'true' }, '⚠'),
    el('h2', { id: 'mainnet-title' }, 'Do not use this on mainnet'),
    el(
      'p',
      {},
      'Never enter a real mainnet seed phrase into an example wallet. Use Preview or Preprod test words only.',
    ),
    el('p', { class: 'muted' }, 'Mainnet is intentionally disabled in this example.'),
    close,
  );
  return dialog;
}

function renderFooter(): void {
  clear(footer).append(
    el(
      'div',
      { class: 'shell footer-row' },
      el('span', { class: 'muted' }, 'Midnight BIP39 light wallet example powered by the nightfrost REST API'),
      el('span', { class: 'muted footer-net mono' }, activeNetwork.apiUrl),
    ),
  );
}

function renderLanding(): void {
  renderVersion += 1;
  clear(outlet);

  const seedInput = el('input', {
    class: 'seed-input mono',
    type: 'password',
    name: 'recovery-phrase',
    placeholder: 'Enter your BIP39 recovery phrase',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'BIP39 recovery phrase',
  });
  const reveal = el('button', { class: 'seed-reveal', type: 'button' }, 'show');
  reveal.addEventListener('click', () => {
    const showing = seedInput.type === 'text';
    seedInput.type = showing ? 'password' : 'text';
    reveal.textContent = showing ? 'show' : 'hide';
  });
  const generate = el('button', { class: 'pager-btn seed-generate', type: 'button' }, 'Generate test phrase');
  generate.addEventListener('click', () => {
    seedInput.value = generateRecoveryPhrase();
    seedInput.type = 'text';
    reveal.textContent = 'hide';
    formError.setAttribute('hidden', '');
    seedInput.focus();
    seedInput.select();
  });
  const submit = el('button', { class: 'search-go seed-submit', type: 'submit' }, 'Open wallet');
  const formError = el('div', { class: 'seed-error', role: 'alert', hidden: '' });

  const form = el(
    'form',
    { class: 'seed-form' },
    el('label', { class: 'label', for: 'seed-words' }, 'Recovery phrase'),
    el('div', { class: 'seed-row' }, seedInput, reveal, submit),
    el('div', { class: 'seed-tools' }, generate, el('span', { class: 'muted' }, 'Creates 24 random BIP39 words in this tab.')),
    formError,
  );
  seedInput.id = 'seed-words';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    formError.setAttribute('hidden', '');
    submit.setAttribute('disabled', '');
    submit.textContent = 'Deriving…';

    const words = seedInput.value;
    seedInput.value = '';
    seedInput.type = 'password';

    // Yield once so the busy state paints before key derivation and initial sync.
    setTimeout(() => {
      void (async () => {
        try {
          submit.textContent = 'Syncing…';
          const { openNightfrostWallet } = await import('./nightfrost-sdk.ts');
          walletSession = await openNightfrostWallet(words, activeNetwork);
          walletAddress = walletSession.addressHex;
          renderWallet();
        } catch (error) {
          walletSession = null;
          walletAddress = null;
          formError.textContent = error instanceof Error ? error.message : String(error);
          formError.removeAttribute('hidden');
          submit.removeAttribute('disabled');
          submit.textContent = 'Open wallet';
          seedInput.focus();
        }
      })();
    }, 0);
  });

  outlet.append(
    el(
      'section',
      { class: 'hero wallet-hero' },
      el(
        'div',
        { class: 'hero-inner wallet-hero-inner' },
        el('div', { class: 'wallet-kicker label' }, 'BIP39 · local keys · Nightfrost only'),
        el('h1', { class: 'hero-title' }, 'A small window into your Midnight wallet.'),
        el(
          'p',
          { class: 'wallet-intro muted' },
          'Sync the three Midnight wallet cores through Nightfrost, then receive and send unshielded Preview NIGHT with local signing and proving.',
        ),
        el('div', { class: 'hero-chips' }, el('span', { class: 'chip' }, NIGHT_DERIVATION_PATH)),
        form,
        el(
          'p',
          { class: 'seed-note muted' },
          'Your phrase is used only in this tab, is never stored, and is cleared from the input after derivation. Wallet keys stay in this tab; Nightfrost receives public sync queries and finalized transactions only. Use test wallets only.',
        ),
      ),
    ),
  );
}

async function closeWallet(): Promise<void> {
  const session = walletSession;
  walletSession = null;
  walletAddress = null;
  txCursors = [undefined];
  txPage = 0;
  if (session) await session.stop().catch((error) => console.warn('Wallet shutdown failed', error));
}

function renderWallet(): void {
  if (!walletAddress) return renderLanding();
  const version = ++renderVersion;
  const address = walletAddress;
  const receiveAddress = walletSession?.address ?? formatNightAddress(address, activeNetwork.networkId);
  clear(outlet);

  const forget = el('button', { class: 'pager-btn forget-btn', type: 'button' }, 'Forget wallet');
  forget.addEventListener('click', () => {
    forget.setAttribute('disabled', '');
    void closeWallet().then(() => renderLanding());
  });

  const balancesBody = el('div', { class: 'balance-cards' }, skeleton(2));
  const txBody = el('div', { class: 'table-body' }, skeleton(6));
  const pageLabel = el('span', { class: 'pager-label mono' }, `page ${txPage + 1}`);
  const previous = el('button', { class: 'pager-btn', type: 'button' }, '← prev');
  const next = el('button', { class: 'pager-btn', type: 'button' }, 'next →');
  previous.disabled = txPage === 0;
  next.disabled = true;

  const loadPage = (page: number) => {
    if (page < 0 || page >= txCursors.length) return;
    txPage = page;
    void loadTransactions(version, address, txBody, previous, next, pageLabel);
  };
  previous.addEventListener('click', () => loadPage(txPage - 1));
  next.addEventListener('click', () => {
    if (next.dataset.cursor === undefined) return;
    txCursors.length = txPage + 1;
    txCursors.push(next.dataset.cursor || undefined);
    loadPage(txPage + 1);
  });

  const transactionsPanel = el(
    'section',
    { class: 'panel' },
    el('h2', { class: 'panel-title' }, 'Transactions'),
    el(
      'div',
      { class: 'table txs-table wallet-txs-table' },
      el(
        'div',
        { class: 'table-head' },
        el('span', {}, 'block'),
        el('span', {}, 'hash'),
        el('span', {}, 'variant'),
        el('span', {}, 'status'),
        el('span', {}, 'time'),
      ),
      txBody,
    ),
    el('div', { class: 'pager' }, previous, pageLabel, next),
  );
  const overviewPane = el(
    'div',
    { class: 'wallet-tab-pane' },
    el(
      'section',
      { class: 'panel wallet-details' },
      el('h2', { class: 'panel-title' }, 'Account'),
      el(
        'div',
        { class: 'details' },
        detailRow('network', activeNetwork.name),
        detailRow('NIGHT path', el('span', { class: 'mono' }, NIGHT_DERIVATION_PATH)),
        detailRow('API', el('span', { class: 'mono' }, activeNetwork.apiUrl)),
      ),
    ),
    el('h2', { class: 'wallet-section-title' }, 'Balances'),
    balancesBody,
    transactionsPanel,
  );
  const receivePane = el(
    'div',
    { class: 'wallet-tab-pane', hidden: '' },
    el(
      'section',
      { class: 'panel receive-panel' },
      el('h2', { class: 'panel-title' }, 'Receive NIGHT'),
      el('p', { class: 'receive-intro muted' }, `Your unshielded ${activeNetwork.name} wallet address.`),
      el(
        'div',
        { class: 'receive-address-card' },
        el('div', { class: 'label' }, `${activeNetwork.name} address`),
        el(
          'div',
          { class: 'hash-cell receive-address' },
          el('span', { class: 'mono', title: receiveAddress }, receiveAddress),
          copyButton(receiveAddress),
        ),
        el('div', { class: 'receive-hex muted' }, el('span', {}, 'ledger hex '), el('span', { class: 'mono' }, address), copyButton(address)),
      ),
      el(
        'p',
        { class: 'receive-warning' },
        `Only send unshielded test assets on ${activeNetwork.name}. Always confirm the network before sharing this address.`,
      ),
    ),
  );
  const sendPane = buildSendPane(() => {
    void loadBalances(version, address, balancesBody);
    void loadTransactions(version, address, txBody, previous, next, pageLabel);
  });
  const overviewTab = el('button', { class: 'tab active', type: 'button' }, 'Overview');
  const receiveTab = el('button', { class: 'tab', type: 'button' }, 'Receive');
  const sendTab = el('button', { class: 'tab', type: 'button' }, 'Send');
  const selectTab = (tab: 'overview' | 'receive' | 'send') => {
    overviewTab.classList.toggle('active', tab === 'overview');
    receiveTab.classList.toggle('active', tab === 'receive');
    sendTab.classList.toggle('active', tab === 'send');
    overviewPane.toggleAttribute('hidden', tab !== 'overview');
    receivePane.toggleAttribute('hidden', tab !== 'receive');
    sendPane.toggleAttribute('hidden', tab !== 'send');
  };
  overviewTab.addEventListener('click', () => selectTab('overview'));
  receiveTab.addEventListener('click', () => selectTab('receive'));
  sendTab.addEventListener('click', () => selectTab('send'));

  outlet.append(
    el(
      'div',
      { class: 'page-head wallet-page-head' },
      el(
        'div',
        { class: 'wallet-heading' },
        el('h1', {}, 'Light wallet'),
        el('div', { class: 'muted' }, `${activeNetwork.name} · account 0`),
      ),
      el('div', { class: 'wallet-head-actions' }, forget),
    ),
    el('div', { class: 'tabs wallet-tabs' }, overviewTab, receiveTab, sendTab),
    overviewPane,
    receivePane,
    sendPane,
  );

  void loadBalances(version, address, balancesBody);
  void loadTransactions(version, address, txBody, previous, next, pageLabel);
}

function parseNightAmount(value: string): bigint {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(normalized);
  if (!match) throw new Error('Enter a NIGHT amount with at most six decimal places.');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  const amount = whole * 1_000_000n + fraction;
  if (amount <= 0n) throw new Error('Amount must be greater than zero.');
  return amount;
}

function buildSendPane(onSubmitted: () => void): HTMLElement {
  const recipient = el('input', {
    class: 'seed-input mono send-input',
    name: 'recipient',
    placeholder: 'mn_addr_preview… or 32-byte hex address',
    autocomplete: 'off',
    spellcheck: 'false',
    required: '',
  });
  const amount = el('input', {
    class: 'seed-input mono send-input',
    name: 'amount',
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0.000000',
    autocomplete: 'off',
    required: '',
  });
  const submit = el('button', { class: 'search-go send-submit', type: 'submit' }, 'Send NIGHT');
  const status = el('div', { class: 'send-status muted', role: 'status' });

  const form = el(
    'form',
    { class: 'send-form' },
    el('label', { class: 'label' }, 'Recipient', recipient),
    el('label', { class: 'label' }, 'NIGHT amount', amount),
    el(
      'div',
      { class: 'send-summary' },
      el('span', { class: 'muted' }, 'Fees are paid from this wallet’s synced DUST balance.'),
      submit,
    ),
    status,
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const session = walletSession;
    if (!session) {
      status.textContent = 'Wallet session is no longer available.';
      status.className = 'send-status state-error';
      return;
    }

    submit.setAttribute('disabled', '');
    submit.textContent = 'Building and proving…';
    status.className = 'send-status muted';
    status.textContent =
      'The transaction is built, signed, and proven locally before Nightfrost receives it.';

    void (async () => {
      try {
        const result = await session.sendUnshielded(
          recipient.value,
          parseNightAmount(amount.value),
        );
        status.className = 'send-status send-success';
        clear(status).append(
          el('span', {}, 'Finalized transaction '),
          el('span', { class: 'mono', title: result.identifier }, truncate(result.identifier)),
          copyButton(result.identifier),
        );
        amount.value = '';
        setTimeout(onSubmitted, 3_000);
      } catch (error) {
        status.className = 'send-status state-error';
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        submit.removeAttribute('disabled');
        submit.textContent = 'Send NIGHT';
      }
    })();
  });

  return el(
    'div',
    { class: 'wallet-tab-pane', hidden: '' },
    el(
      'section',
      { class: 'panel send-panel' },
      el('h2', { class: 'panel-title' }, 'Send unshielded NIGHT'),
      el(
        'p',
        { class: 'receive-intro muted' },
        'Preview example: sync through Nightfrost, prove in this browser, then submit through the Nightfrost API.',
      ),
      form,
      el(
        'p',
        { class: 'receive-warning' },
        'Use only disposable Preview or Preprod funds. This example has not been audited as a production wallet.',
      ),
    ),
  );
}

async function loadBalances(version: number, address: string, body: HTMLElement): Promise<void> {
  try {
    const balances = await new NightfrostApi(activeNetwork).addressBalances(address);
    if (version !== renderVersion) return;
    renderBalances(body, balances);
  } catch (error) {
    if (version !== renderVersion) return;
    clear(body).append(errorState(error, 'balance'));
  }
}

function renderBalances(body: HTMLElement, balances: TokenBalance[]): void {
  clear(body);
  const native = balances.find((balance) => isNativeToken(balance.token_type));
  const nativeAmount = native?.amount ?? '0';
  body.append(
    el(
      'div',
      { class: 'balance-card balance-native' },
      el('div', { class: 'balance-label' }, 'NIGHT balance'),
      el('div', { class: 'balance-value mono num' }, formatNight(nativeAmount)),
      el('div', { class: 'balance-sub muted mono' }, `${formatRawAmount(nativeAmount)} STAR · smallest NIGHT unit`),
    ),
  );

  for (const balance of balances.filter((item) => !isNativeToken(item.token_type))) {
    body.append(
      el(
        'div',
        { class: 'balance-card' },
        el('div', { class: 'balance-label' }, 'token ', el('span', { class: 'mono' }, truncate(balance.token_type))),
        el('div', { class: 'balance-value mono num' }, formatRawAmount(balance.amount)),
        el('div', { class: 'balance-sub muted mono', title: balance.token_type }, balance.token_type),
      ),
    );
  }
}

async function loadTransactions(
  version: number,
  address: string,
  body: HTMLElement,
  previous: HTMLButtonElement,
  next: HTMLButtonElement,
  pageLabel: HTMLElement,
): Promise<void> {
  clear(body).append(skeleton(6));
  previous.disabled = true;
  next.disabled = true;
  delete next.dataset.cursor;

  try {
    const api = new NightfrostApi(activeNetwork);
    const page = await api.addressTxs(address, txCursors[txPage]);
    const transactions = await Promise.all(page.results.map((hash) => api.tx(hash)));
    if (version !== renderVersion) return;

    clear(body);
    if (transactions.length === 0) body.append(emptyState('No transactions for this address.'));
    else for (const transaction of transactions) body.append(txRow(transaction));

    previous.disabled = txPage === 0;
    pageLabel.textContent = `page ${txPage + 1}`;
    if (page.next_cursor !== null) {
      next.dataset.cursor = page.next_cursor;
      next.disabled = false;
    }
  } catch (error) {
    if (version !== renderVersion) return;
    clear(body).append(errorState(error, 'transactions'));
    previous.disabled = txPage === 0;
  }
}

function txRow(transaction: Tx): HTMLElement {
  return el(
    'div',
    { class: 'table-row' },
    el('span', { class: 'mono num' }, transaction.block_height.toLocaleString('en-US')),
    el(
      'span',
      { class: 'hash-cell cell-hash' },
      el(
        'a',
        {
          class: 'mono tx-explorer-link',
          title: `Open ${transaction.hash} in Nightfrost explorer`,
          href: `${EXPLORER_URL}/#/tx/${transaction.hash}`,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        truncate(transaction.hash),
      ),
      copyButton(transaction.hash),
    ),
    el('span', { class: `badge badge-variant-${transaction.variant.toLowerCase()}` }, transaction.variant),
    statusPill(transaction.status),
    el('span', { class: 'time-cell', title: formatTime(transaction.block_time) }, formatTime(transaction.block_time)),
  );
}

function statusPill(status: TxStatus): HTMLElement {
  return el('span', { class: `pill pill-${status}` }, status === 'partial_success' ? 'partial success' : status);
}

function detailRow(label: string, ...value: Child[]): HTMLElement {
  return el('div', { class: 'detail-row' }, el('div', { class: 'detail-label' }, label), el('div', { class: 'detail-value' }, ...value));
}

function copyButton(value: string): HTMLButtonElement {
  const button = el('button', { class: 'copy-btn', type: 'button', title: 'Copy to clipboard', 'aria-label': 'Copy' }, '⧉');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = '✓';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = '⧉';
        button.classList.remove('copied');
      }, 1200);
    } catch {
      // Clipboard access is optional.
    }
  });
  return button;
}

function skeleton(rows: number): HTMLElement {
  const block = el('div', { class: 'skeleton-block', 'aria-hidden': 'true' });
  for (let index = 0; index < rows; index += 1) block.append(el('div', { class: 'skeleton-row' }));
  return block;
}

function emptyState(message: string): HTMLElement {
  return el('div', { class: 'state state-empty' }, el('div', { class: 'state-icon' }, '❄'), el('div', { class: 'state-detail' }, message));
}

function errorState(error: unknown, context: string): HTMLElement {
  const message = error instanceof Error ? error.message : String(error);
  const title = error instanceof ApiError && error.status === 404 ? 'Not found' : 'API unavailable';
  return el(
    'div',
    { class: 'state state-error' },
    el('div', { class: 'state-icon' }, '✳'),
    el('div', { class: 'state-title' }, `${title}: ${context}`),
    el('div', { class: 'state-detail mono' }, message),
  );
}

function currentTheme(): Theme {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    if (theme === 'auto' || theme === 'light' || theme === 'dark') return theme;
  } catch {
    // Storage is optional.
  }
  return 'dark';
}

function applyTheme(theme: Theme): void {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage is optional.
  }
}
