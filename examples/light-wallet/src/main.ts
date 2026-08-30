import './polyfills.ts';
import './style.css';
import {
  ApiError,
  NightfrostApi,
  type TokenBalance,
  type Tx,
  type TxStatus,
  type TxUtxos,
  type Utxo,
} from './api.ts';
import { formatNight, formatRawAmount, formatTime, isNativeToken, truncate } from './format.ts';
import { EXPLORER_URL, NETWORKS, type NetworkDef } from './networks.ts';
import { formatNightAddress, generateRecoveryPhrase, NIGHT_DERIVATION_PATH } from './wallet.ts';
import type { DustStatus, LocalWalletSession, SyncCore, SyncProgress } from './nightfrost-sdk.ts';

const LOGO_SVG = `<svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="38,8 48,22 58,8"/><polyline points="38,8 48,22 58,8" transform="rotate(60 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(120 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(180 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(240 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(300 48 48)"/></g><circle cx="48" cy="48" r="10" fill="#8fd0e4"/></svg>`;

type Child = Node | string | null | undefined;
type Theme = 'auto' | 'light' | 'dark';

const THEME_KEY = 'nf.theme';
const THEME_ICONS: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
const THEME_NEXT: Record<Theme, Theme> = { dark: 'light', light: 'auto', auto: 'dark' };

let activeNetwork = NETWORKS[0];
let walletAddress: string | null = null;
let walletSession: LocalWalletSession | null = null;
let walletSync = new Map<SyncCore, SyncProgress>();
let walletSyncReady = false;
let walletSyncError: string | null = null;
let walletResyncing = false;
let txCursors: Array<string | undefined> = [undefined];
let txPage = 0;
let renderVersion = 0;
let syncOverlayDismissed = false;

/// DUST math: 1 DUST = 1e15 specks; each NIGHT (1e6 STAR) can back up to
/// 5 DUST, so the capacity per STAR is 5e9 specks.
const SPECKS_PER_DUST = 1_000_000_000_000_000n;
const DUST_CAP_SPECKS_PER_STAR = 5_000_000_000n;

function formatDust(specks: bigint): string {
  const thousandths = specks / (SPECKS_PER_DUST / 1_000n);
  return (Number(thousandths) / 1_000).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function dustCapacityPercent(specks: bigint, nightStar: bigint): number | null {
  const cap = nightStar * DUST_CAP_SPECKS_PER_STAR;
  if (cap <= 0n) return null;
  const pct = Number((specks * 1000n) / cap) / 10;
  return Math.max(0, Math.min(100, pct));
}

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

function formatWalletError(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 8 || seen.has(value)) return;
    if (typeof value === 'string') {
      if (value.trim()) details.push(value.trim());
      return;
    }
    if (typeof value !== 'object') {
      details.push(String(value));
      return;
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const tag = typeof record._tag === 'string' ? record._tag : '';
    const status = value instanceof ApiError && value.status > 0 ? 'HTTP ' + value.status : '';
    const summary = [tag, status, message].filter(Boolean).join(': ');
    if (summary) details.push(summary);

    for (const key of ['cause', 'error', 'failure', 'defect']) {
      if (key in record) visit(record[key], depth + 1);
    }
  };

  visit(error, 0);
  const unique = details.filter((detail, index) => details.indexOf(detail) === index);
  return unique.length > 0 ? unique.join(' → ') : String(error);
}

const SYNC_LOGO_SVG = LOGO_SVG.replace('#8fd0e4', 'currentColor');

const SYNC_LABELS: Record<SyncCore, string> = {
  unshielded: 'NIGHT balance',
  shielded: 'Shielded balance',
  dust: 'DUST balance',
};

function syncRow(core: SyncCore, synced: boolean): HTMLElement {
  const icon = el('span', { class: 'wallet-sync-logo', 'aria-hidden': 'true' });
  icon.innerHTML = SYNC_LOGO_SVG;
  return el(
    'div',
    { class: 'wallet-sync-row ' + (synced ? 'is-synced' : 'is-progress') },
    icon,
    el('span', { class: 'wallet-sync-label' }, SYNC_LABELS[core]),
    el('span', { class: 'wallet-sync-state' }, synced ? 'Synced' : 'In progress'),
  );
}

function coreSynced(core: SyncCore): boolean {
  const progress = walletSync.get(core);
  return (
    walletSyncReady ||
    (progress !== undefined && (progress.total === 0 || progress.scanned >= progress.total))
  );
}

function reportWalletSync(progress: SyncProgress): void {
  walletSync.set(progress.core, progress);
  updateWalletSyncBanner();
}

/// Stop and relaunch the wallet cores' background sync. Rescues a sync that
/// stalled (dropped connection, indexer hiccup) without forgetting the wallet.
async function resyncWallet(): Promise<void> {
  const session = walletSession;
  if (!session || walletResyncing) return;
  walletResyncing = true;
  walletSync = new Map();
  walletSyncError = null;
  updateWalletSyncBanner();
  try {
    await session.resync();
    if (walletSession !== session) return;
    walletSyncReady = true;
  } catch (error) {
    if (walletSession !== session) return;
    console.error('Wallet resync failed', error);
    walletSyncError = formatWalletError(error);
  } finally {
    if (walletSession === session) {
      walletResyncing = false;
      updateWalletSyncBanner();
    }
  }
}

function resyncButton(): HTMLElement {
  const button = el(
    'button',
    { class: 'pager-btn wallet-resync-btn', type: 'button' },
    walletResyncing ? 'Resyncing…' : 'Resync',
  );
  if (walletResyncing) button.setAttribute('disabled', '');
  button.addEventListener('click', () => void resyncWallet());
  return button;
}

function updateWalletSyncBanner(): void {
  const banner = document.querySelector<HTMLElement>('[data-wallet-sync]');
  if (!banner) return;

  const rows = (['unshielded', 'shielded', 'dust'] as const).map((core) =>
    syncRow(core, coreSynced(core)),
  );

  banner.className = 'wallet-sync-banner' + (walletSyncError ? ' state-error' : '');
  clear(banner).append(...rows);
  if (walletSyncError) {
    banner.append(el('div', { class: 'wallet-sync-error' }, walletSyncError));
  }
  if (walletSession !== null && (walletResyncing || !walletSyncReady || walletSyncError !== null)) {
    banner.append(resyncButton());
  }

  updateSyncOverlay();
}

/// While the wallet cores replay history the WASM work can freeze the tab,
/// so a blocking overlay explains the wait instead of letting people click
/// a frozen page. It removes itself the moment sync finishes or fails.
function updateSyncOverlay(): void {
  const existing = document.querySelector<HTMLElement>('[data-sync-overlay]');
  const wanted =
    walletAddress !== null && !walletSyncReady && !walletSyncError && !syncOverlayDismissed;

  if (!wanted) {
    if (existing) {
      existing.remove();
      app.removeAttribute('aria-busy');
    }
    return;
  }

  const rows = (['unshielded', 'shielded', 'dust'] as const).map((core) =>
    syncRow(core, coreSynced(core)),
  );

  if (existing) {
    const rowsHost = existing.querySelector<HTMLElement>('.sync-overlay-rows');
    if (rowsHost) clear(rowsHost).append(...rows);
    return;
  }

  const dismiss = el(
    'button',
    { class: 'ghost-btn sync-overlay-dismiss', type: 'button', hidden: '' },
    'Continue anyway',
  );
  dismiss.addEventListener('click', () => {
    syncOverlayDismissed = true;
    updateSyncOverlay();
  });
  const resync = el(
    'button',
    { class: 'ghost-btn sync-overlay-dismiss', type: 'button', hidden: '' },
    'Resync stuck sync',
  );
  resync.addEventListener('click', () => {
    resync.setAttribute('disabled', '');
    resync.textContent = 'Resyncing…';
    void resyncWallet().finally(() => {
      resync.removeAttribute('disabled');
      resync.textContent = 'Resync stuck sync';
    });
  });
  setTimeout(() => {
    dismiss.removeAttribute('hidden');
    resync.removeAttribute('hidden');
  }, 20_000);

  const overlay = el(
    'div',
    { class: 'wallet-opening', role: 'status', 'aria-live': 'polite', 'data-sync-overlay': '' },
    el(
      'div',
      { class: 'wallet-opening-card' },
      el('span', { class: 'spin sync-overlay-spin', 'aria-hidden': 'true' }),
      el('div', { class: 'wallet-opening-title' }, 'Wallet is syncing'),
      el(
        'div',
        { class: 'wallet-opening-copy muted' },
        'The wallet cores replay history inside this tab, which can freeze the page until they finish. Leave the tab open • this closes by itself.',
      ),
      el('div', { class: 'sync-overlay-rows' }, ...rows),
      resync,
      dismiss,
    ),
  );
  document.body.append(overlay);
  app.setAttribute('aria-busy', 'true');
}

function showWalletOpening(): HTMLElement {
  const logo = el('div', { class: 'wallet-opening-logo', 'aria-hidden': 'true' });
  logo.innerHTML = LOGO_SVG;
  const overlay = el(
    'div',
    { class: 'wallet-opening', role: 'status', 'aria-live': 'polite' },
    el(
      'div',
      { class: 'wallet-opening-card' },
      logo,
      el('div', { class: 'wallet-opening-title' }, 'Opening your wallet'),
      el(
        'div',
        { class: 'wallet-opening-copy muted' },
        'Deriving local keys and starting the Midnight wallet cores…',
      ),
    ),
  );
  document.body.append(overlay);
  app.setAttribute('aria-busy', 'true');
  return overlay;
}

function hideWalletOpening(overlay: HTMLElement): void {
  overlay.remove();
  app.removeAttribute('aria-busy');
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
    el(
      'div',
      { class: 'shell header-row' },
      logo,
      el('span', { class: 'wallet-header-spacer' }),
      buildNetworkPill(),
      themeButton,
    ),
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
  const confirmation = "I'm stupid and I deserve to lose my funds";
  const dialog = el('dialog', { class: 'mainnet-dialog', 'aria-labelledby': 'mainnet-title' });
  const input = el('input', {
    class: 'seed-input mainnet-confirmation',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Type the mainnet confirmation phrase',
  });
  const confirm = el(
    'button',
    { class: 'search-go dialog-confirm', type: 'button', disabled: '' },
    'Enable mainnet',
  );
  const cancel = el('button', { class: 'ghost-btn dialog-cancel', type: 'button' }, 'Cancel');

  input.addEventListener('input', () => {
    confirm.disabled = input.value !== confirmation;
  });
  confirm.addEventListener('click', () => {
    if (input.value !== confirmation) return;
    const mainnet = NETWORKS.find((network) => network.networkId === 'mainnet');
    if (!mainnet) return;
    mainnet.enabled = true;
    dialog.close();
    selectNetwork(mainnet);
  });
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    input.value = '';
    confirm.disabled = true;
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.append(
    el('div', { class: 'dialog-icon', 'aria-hidden': 'true' }, '⚠'),
    el('h2', { id: 'mainnet-title' }, 'Mainnet can use real funds'),
    el(
      'p',
      {},
      'This is an experimental example wallet. A mistake or bug can permanently destroy real funds.',
    ),
    el('p', { class: 'muted' }, 'To continue, type this exact sentence:'),
    el('code', { class: 'mainnet-confirmation-copy' }, confirmation),
    input,
    el('div', { class: 'dialog-actions' }, cancel, confirm),
  );
  return dialog;
}

function renderFooter(): void {
  clear(footer).append(
    el(
      'div',
      { class: 'shell footer-row' },
      el(
        'span',
        { class: 'muted' },
        'Midnight BIP39 light wallet example powered by the nightfrost REST API',
      ),
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
  const generate = el(
    'button',
    { class: 'pager-btn seed-generate', type: 'button' },
    'Generate test phrase',
  );
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
    el(
      'div',
      { class: 'seed-tools' },
      generate,
      el('span', { class: 'muted' }, 'Creates 24 random BIP39 words in this tab.'),
    ),
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

    const opening = showWalletOpening();

    // Give the overlay two frames to paint before CPU-heavy key derivation
    // starts. Hidden tabs never fire animation frames, so race a timeout —
    // otherwise opening a wallet in a background tab hangs on this gate.
    const afterPaint = (callback: () => void): void => {
      let called = false;
      const run = () => {
        if (called) return;
        called = true;
        callback();
      };
      requestAnimationFrame(() => requestAnimationFrame(run));
      setTimeout(run, 250);
    };
    afterPaint(() => {
      void (async () => {
        try {
          submit.textContent = 'Opening…';
          walletSync = new Map();
          walletSyncReady = false;
          walletSyncError = null;
          walletResyncing = false;
          syncOverlayDismissed = false;
          const { openNightfrostWallet } = await import('./nightfrost-sdk.ts');
          const session = await openNightfrostWallet(words, activeNetwork, reportWalletSync);
          walletSession = session;
          walletAddress = session.addressHex;
          renderWallet();
          hideWalletOpening(opening);
          void session.ready
            .then(() => {
              if (walletSession !== session) return;
              walletSyncReady = true;
              updateWalletSyncBanner();
            })
            .catch((error: unknown) => {
              if (walletSession !== session) return;
              walletSyncError = formatWalletError(error);
              updateWalletSyncBanner();
            });
        } catch (error) {
          hideWalletOpening(opening);
          walletSession = null;
          walletAddress = null;
          formError.textContent = formatWalletError(error);
          formError.removeAttribute('hidden');
          submit.removeAttribute('disabled');
          submit.textContent = 'Open wallet';
          seedInput.focus();
        }
      })();
    });
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
          'Open immediately while the three Midnight wallet cores sync through Nightfrost in the background, then receive and send unshielded Preview NIGHT with local signing and proving.',
        ),
        el('div', { class: 'hero-chips' }, el('span', { class: 'chip' }, NIGHT_DERIVATION_PATH)),
        form,
        el(
          'p',
          { class: 'seed-note muted' },
          'Your phrase is used only in this tab, is never stored, and is cleared from the input after derivation. Spending keys stay in this tab. Nightfrost receives the view-only Zswap encryption key for stateless event filtering and finalized transactions. Use test wallets only.',
        ),
      ),
    ),
  );
}

async function closeWallet(): Promise<void> {
  const session = walletSession;
  walletSession = null;
  walletAddress = null;
  walletSync = new Map();
  walletSyncReady = false;
  walletSyncError = null;
  walletResyncing = false;
  syncOverlayDismissed = false;
  updateSyncOverlay();
  txCursors = [undefined];
  txPage = 0;
  if (session) await session.stop().catch((error) => console.warn('Wallet shutdown failed', error));
}

function renderWallet(): void {
  if (!walletAddress) return renderLanding();
  const version = ++renderVersion;
  const address = walletAddress;
  const receiveAddress =
    walletSession?.address ?? formatNightAddress(address, activeNetwork.networkId);
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
        el('span', { class: 'amount-cell' }, 'amount'),
        el('span', {}, 'variant'),
        el('span', {}, 'status'),
        el('span', {}, 'time'),
      ),
      txBody,
    ),
    el('div', { class: 'pager' }, previous, pageLabel, next),
  );
  let lastNight = 0n;
  let lastDust: DustStatus | null = null;

  // One refresh drives everything derived from balances and dust state:
  // the balance cards, the onboarding steps, and the fee note in Send.
  const refreshStatus = () => {
    const session = walletSession;
    void (async () => {
      try {
        const balances = await new NightfrostApi(activeNetwork).addressBalances(address);
        if (version !== renderVersion) return;
        lastNight = BigInt(
          balances.find((item) => isNativeToken(item.token_type))?.amount ?? '0',
        );
        renderBalances(balancesBody, balances, lastDust, lastNight);
        setup.update(lastNight, lastDust);
        updateFeeDust(lastDust);
      } catch (error) {
        if (version !== renderVersion) return;
        clear(balancesBody).append(errorState(error, 'balance'));
      }
    })();
    if (session) {
      void session
        .dustStatus()
        .then((dust) => {
          if (version !== renderVersion || walletSession !== session) return;
          lastDust = dust;
          void new NightfrostApi(activeNetwork)
            .addressBalances(address)
            .then((balances) => {
              if (version !== renderVersion) return;
              renderBalances(balancesBody, balances, lastDust, lastNight);
            })
            .catch(() => undefined);
          setup.update(lastNight, dust);
          updateFeeDust(dust);
        })
        .catch(() => undefined);
    }
  };
  const refreshAll = () => {
    refreshStatus();
    void loadTransactions(version, address, txBody, previous, next, pageLabel);
  };

  const setup = buildOnboarding(receiveAddress, refreshAll);
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
    transactionsPanel,
  );
  const receivePane = el(
    'div',
    { class: 'wallet-tab-pane', hidden: '' },
    el(
      'section',
      { class: 'panel receive-panel' },
      el('h2', { class: 'panel-title' }, 'Receive NIGHT'),
      el(
        'p',
        { class: 'receive-intro muted' },
        `Your unshielded ${activeNetwork.name} wallet address.`,
      ),
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
        el(
          'div',
          { class: 'receive-hex muted' },
          el('span', {}, 'ledger hex '),
          el('span', { class: 'mono' }, address),
          copyButton(address),
        ),
      ),
      el(
        'p',
        { class: 'receive-warning' },
        `Only send unshielded test assets on ${activeNetwork.name}. Always confirm the network before sharing this address.`,
      ),
    ),
  );
  const sendPane = buildSendPane(refreshAll);
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
    el(
      'div',
      { class: 'wallet-status-strip' },
      balancesBody,
      el('div', { class: 'wallet-sync-banner is-syncing', 'data-wallet-sync': '', role: 'status' }),
    ),
    setup.node,
    el('div', { class: 'tabs wallet-tabs' }, overviewTab, receiveTab, sendTab),
    overviewPane,
    receivePane,
    sendPane,
  );

  updateWalletSyncBanner();
  refreshAll();

  // Balances, dust, and onboarding steps advance while the user waits, so
  // keep them fresh without manual refreshes.
  const tick = setInterval(() => {
    if (version !== renderVersion) {
      clearInterval(tick);
      return;
    }
    refreshStatus();
  }, 20_000);
}

/// Busy status line with a compositor-driven spinner (CSS transform keeps
/// spinning even when WASM work freezes the main thread) and, for proving
/// stages, a note that browser proving takes minutes plus a live elapsed
/// counter. The counter element doubles as the proving marker: when the next
/// non-proving stage re-renders this line, its presence and start timestamp
/// yield the "generated in…" summary. Error paths replace the status content
/// wholesale, so a stale marker never survives into the next attempt.
function setBusyStatus(status: HTMLElement, message: string): void {
  const prevTimer = status.querySelector<HTMLElement>('[data-proving-timer]');
  const startedAt = prevTimer ? Number(prevTimer.dataset.startedAt) : Date.now();
  status.className = 'send-status muted is-busy';
  clear(status).append(el('span', { class: 'spin', 'aria-hidden': 'true' }), el('span', {}, message));
  if (/proof|proving/i.test(message)) {
    const counter = el(
      'span',
      { class: 'mono send-proving-timer', 'data-proving-timer': '', 'data-started-at': String(startedAt) },
      elapsedClock(startedAt),
    );
    const tick = setInterval(() => {
      if (!counter.isConnected) {
        clearInterval(tick);
        return;
      }
      counter.textContent = elapsedClock(startedAt);
    }, 1_000);
    status.append(
      counter,
      el(
        'div',
        { class: 'send-proving-note' },
        'Without a dedicated proof server the zero-knowledge proof is generated in this browser • this can take several minutes. Be patient and keep the tab open.',
      ),
    );
    snakeGame ??= createSnakeGame();
    status.append(snakeGame);
  } else if (prevTimer) {
    status.append(
      el(
        'div',
        { class: 'send-proving-note' },
        `Zero-knowledge proof generated in ${formatElapsed(Date.now() - startedAt)}.`,
      ),
    );
  }
}

function elapsedClock(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const label = minutes === 1 ? 'minute' : 'minutes';
  return rest === 0 ? `${minutes} ${label}` : `${minutes} ${label} ${rest} seconds`;
}

/// Nokia-style snake shown under the proving note so the minutes-long local
/// proof has something to fill them with. One game per proving run: each
/// progress message re-renders the busy status, so the same node is
/// re-appended to keep the game alive, and the loop tears itself down once
/// the status moves on and the canvas stays detached.
let snakeGame: HTMLElement | null = null;

function createSnakeGame(): HTMLElement {
  const COLS = 20;
  const ROWS = 12;
  // Backing-store pixels, displayed at 300 CSS px: 1:1 device pixels on 2x
  // displays, so cells and text stay crisp.
  const CELL = 30;
  const score = el('span', { class: 'mono' }, '0');
  const canvas = el('canvas', {
    class: 'send-snake-lcd',
    width: String(COLS * CELL),
    height: String(ROWS * CELL),
  });
  const node = el(
    'div',
    { class: 'send-snake' },
    el('div', { class: 'send-snake-head' }, el('span', {}, 'Snake while you wait'), score),
    canvas,
    el('div', { class: 'send-snake-hint' }, 'Arrow keys / WASD, or swipe'),
  );
  const ctx = canvas.getContext('2d');
  if (!ctx) return node;

  type Cell = { x: number; y: number };
  let snake: Cell[];
  let dir: Cell;
  let turns: Cell[];
  let food: Cell;
  let alive: boolean;
  let started = false;
  let eaten: number;

  const placeFood = (): Cell => {
    let cell: Cell;
    do {
      cell = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
    } while (snake.some((s) => s.x === cell.x && s.y === cell.y));
    return cell;
  };

  const reset = (): void => {
    snake = [3, 2, 1].map((x) => ({ x, y: Math.floor(ROWS / 2) }));
    dir = { x: 1, y: 0 };
    turns = [];
    alive = true;
    eaten = 0;
    food = placeFood();
    score.textContent = '0';
  };
  reset();

  const draw = (): void => {
    ctx.fillStyle = '#a3b65c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#26301c';
    const dot = (c: Cell): void => ctx.fillRect(c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4);
    dot(food);
    for (const c of snake) dot(c);
    if (!started || !alive) {
      ctx.fillStyle = 'rgba(163, 182, 92, 0.75)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#26301c';
      ctx.font = 'bold 26px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const middle = canvas.height / 2;
      if (!alive) {
        ctx.fillText(`Game over · ${eaten}`, canvas.width / 2, middle - 10);
        ctx.fillText('Press a key to retry', canvas.width / 2, middle + 26);
      } else {
        ctx.fillText('Press a key to play', canvas.width / 2, middle + 9);
      }
    }
  };
  draw();

  const step = (): void => {
    const next = turns.shift();
    if (next && (next.x !== -dir.x || next.y !== -dir.y)) dir = next;
    // Walls wrap; only biting yourself ends the game.
    const head = { x: (snake[0].x + dir.x + COLS) % COLS, y: (snake[0].y + dir.y + ROWS) % ROWS };
    if (snake.some((c, i) => i < snake.length - 1 && c.x === head.x && c.y === head.y)) {
      alive = false;
      return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      eaten += 1;
      score.textContent = String(eaten);
      food = placeFood();
    } else {
      snake.pop();
    }
  };

  const steer = (turn: Cell): void => {
    if (!alive) reset();
    started = true;
    if (turns.length < 2) turns.push(turn);
    draw();
  };

  const restart = (): void => {
    reset();
    started = false;
    draw();
  };

  const onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    const turn = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      w: { x: 0, y: -1 },
      s: { x: 0, y: 1 },
      a: { x: -1, y: 0 },
      d: { x: 1, y: 0 },
    }[event.key];
    if (turn) {
      event.preventDefault();
      steer(turn);
    } else if (!alive) {
      // "Press a key to retry" means any key.
      restart();
    }
  };

  let touchStart: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent): void => {
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };
  const onTouchEnd = (event: TouchEvent): void => {
    if (!touchStart) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
    steer(Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) });
  };

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('click', () => {
    if (!alive) restart();
  });

  // The re-append on each proving message happens synchronously with the
  // clear, so a genuinely detached canvas across several ticks means the
  // proving run is over.
  let detachedTicks = 0;
  const loop = setInterval(() => {
    if (!node.isConnected) {
      detachedTicks += 1;
      if (detachedTicks > 4) {
        clearInterval(loop);
        window.removeEventListener('keydown', onKey);
        if (snakeGame === node) snakeGame = null;
      }
      return;
    }
    detachedTicks = 0;
    if (started && alive) {
      step();
      draw();
    }
  }, 140);

  return node;
}

function updateFeeDust(dust: DustStatus | null): void {
  const node = document.querySelector<HTMLElement>('[data-fee-dust]');
  if (!node) return;
  node.textContent = dust === null ? 'DUST balance syncing…' : formatDust(dust.balance) + ' DUST available';
}

interface OnboardingPanel {
  node: HTMLElement;
  update(night: bigint, dust: DustStatus | null): void;
}

/// Two-step onboarding above the tabs: get NIGHT from the faucet, then
/// register it for DUST generation. The active step is highlighted; once the
/// wallet holds NIGHT and generates DUST the whole panel disappears.
function buildOnboarding(receiveAddress: string, onUpdated: () => void): OnboardingPanel {
  const session = walletSession;
  const status = el('div', { class: 'send-status muted', role: 'status' });

  const faucet = el(
    'a',
    {
      class: 'search-go setup-step-action faucet-link',
      href: activeNetwork.faucetUrl ?? '#',
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    'Copy address & open faucet',
  );
  faucet.addEventListener('click', () => {
    void navigator.clipboard.writeText(receiveAddress).catch(() => undefined);
  });

  const register = el(
    'button',
    { class: 'search-go setup-step-action', type: 'button', disabled: '' },
    'Generate DUST',
  );

  const stepGet = el(
    'div',
    { class: 'setup-step' },
    el('div', { class: 'setup-step-title' }, el('span', { class: 'setup-step-mark' }, '1'), 'Get NIGHT'),
    el(
      'div',
      { class: 'setup-step-desc' },
      'Copy your address and request test NIGHT from the faucet. The balance appears here once indexed.',
    ),
    faucet,
  );
  const stepDust = el(
    'div',
    { class: 'setup-step' },
    el('div', { class: 'setup-step-title' }, el('span', { class: 'setup-step-mark' }, '2'), 'Generate DUST'),
    el(
      'div',
      { class: 'setup-step-desc' },
      'Register your NIGHT once so it continuously generates the DUST that pays transaction fees.',
    ),
    register,
  );

  const node = el(
    'section',
    { class: 'panel setup-panel' },
    el('h2', { class: 'panel-title' }, 'Get ready to transact'),
    el('div', { class: 'setup-steps' }, stepGet, stepDust),
    status,
  );

  const mark = (step: HTMLElement, state: 'idle' | 'active' | 'done') => {
    step.classList.toggle('is-active', state === 'active');
    step.classList.toggle('is-done', state === 'done');
    const markNode = step.querySelector('.setup-step-mark');
    if (markNode) markNode.textContent = state === 'done' ? '✓' : step === stepGet ? '1' : '2';
  };

  let busy = false;
  const update = (night: bigint, dust: DustStatus | null) => {
    if (busy) return;
    if (night === 0n) {
      node.hidden = false;
      mark(stepGet, 'active');
      mark(stepDust, 'idle');
      register.disabled = true;
      status.textContent = '';
      return;
    }
    if (dust === null) {
      node.hidden = false;
      mark(stepGet, 'done');
      mark(stepDust, 'active');
      register.disabled = true;
      status.textContent = 'NIGHT received • waiting for the local wallet to finish syncing…';
      return;
    }
    if (dust.unregisteredUtxos > 0) {
      node.hidden = false;
      mark(stepGet, 'done');
      mark(stepDust, 'active');
      register.disabled = false;
      status.textContent = '';
      return;
    }
    if (dust.registeredUtxos > 0) {
      // Funded and generating: onboarding is over.
      node.hidden = true;
      return;
    }
    node.hidden = false;
    mark(stepGet, 'done');
    mark(stepDust, 'active');
    register.disabled = true;
    status.textContent = 'NIGHT is indexed; the local wallet is catching up. This updates by itself.';
  };

  register.addEventListener('click', () => {
    if (!session) return;
    busy = true;
    register.disabled = true;
    register.textContent = 'Waiting, proving & submitting…';
    setBusyStatus(
      status,
      'The NIGHT UTXO must generate enough DUST to cover registration. This can take several minutes…',
    );
    let registrationStage = 'Preparing the DUST registration';
    void session
      .registerForDustGeneration((message) => {
        registrationStage = message.endsWith('…') ? message.slice(0, -1) : message;
        setBusyStatus(status, message);
      })
      .then((result) => {
        status.className = 'send-status send-success';
        clear(status).append(
          el('span', {}, 'DUST registration submitted: '),
          result.hash !== undefined
            ? explorerTxLink(result.hash)
            : el('span', { class: 'mono', title: result.identifier }, truncate(result.identifier)),
        );
        setTimeout(onUpdated, 4_000);
      })
      .catch((error: unknown) => {
        console.error('DUST registration failed during ' + registrationStage, error);
        status.className = 'send-status state-error';
        status.textContent = registrationStage + ' failed: ' + formatWalletError(error);
      })
      .finally(() => {
        busy = false;
        register.textContent = 'Generate DUST';
        register.disabled = false;
      });
  });

  return { node, update };
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
      el(
        'span',
        { class: 'muted send-fee-note' },
        'Fees are paid from this wallet’s synced DUST balance.',
        el('span', { class: 'mono send-fee-dust', 'data-fee-dust': '' }, ''),
      ),
      submit,
    ),
    status,
  );

  const openingSession = walletSession;
  if (!walletSyncReady) {
    submit.disabled = true;
    status.textContent = 'Sending unlocks when NIGHT, shielded state, and DUST finish syncing.';
    if (openingSession) {
      void openingSession.ready
        .then(() => {
          if (walletSession !== openingSession) return;
          submit.disabled = false;
          status.textContent = '';
        })
        .catch((error: unknown) => {
          if (walletSession !== openingSession) return;
          status.className = 'send-status state-error';
          status.textContent = formatWalletError(error);
        });
    }
  }

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
    setBusyStatus(
      status,
      'The transaction is built, signed, and proven locally before Nightfrost receives it.',
    );

    let sendStage = 'Preparing the transaction';
    void (async () => {
      try {
        const result = await session.sendUnshielded(
          recipient.value,
          parseNightAmount(amount.value),
          (message) => {
            sendStage = message.endsWith('…') ? message.slice(0, -1) : message;
            setBusyStatus(status, message);
          },
        );
        status.className = 'send-status send-success';
        clear(status).append(
          el('span', {}, 'Finalized transaction '),
          result.hash !== undefined
            ? explorerTxLink(result.hash)
            : el('span', { class: 'mono', title: result.identifier }, truncate(result.identifier)),
        );
        amount.value = '';
        setTimeout(onSubmitted, 3_000);
      } catch (error) {
        console.error('NIGHT transaction failed during ' + sendStage, error);
        status.className = 'send-status state-error';
        status.textContent = sendStage + ' failed: ' + formatWalletError(error);
      } finally {
        if (walletSyncReady) submit.removeAttribute('disabled');
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

function renderBalances(
  body: HTMLElement,
  balances: TokenBalance[],
  dust: DustStatus | null,
  nightStar: bigint,
): void {
  clear(body);
  const native = balances.find((balance) => isNativeToken(balance.token_type));
  const nativeAmount = native?.amount ?? '0';
  body.append(
    el(
      'div',
      { class: 'balance-card balance-native' },
      el('div', { class: 'balance-label' }, 'NIGHT balance'),
      el('div', { class: 'balance-value mono num' }, formatNight(nativeAmount)),
      el(
        'div',
        { class: 'balance-sub muted mono' },
        `${formatRawAmount(nativeAmount)} STAR · smallest NIGHT unit`,
      ),
    ),
  );

  const pct = dust === null ? null : dustCapacityPercent(dust.balance, nightStar);
  const meter =
    pct === null ? null : el('div', { class: 'dust-meter', title: `${pct}% of capacity` });
  if (meter && pct !== null) {
    const fill = el('div', { class: 'dust-meter-fill' });
    fill.style.width = `${pct}%`;
    meter.append(fill);
  }
  body.append(
    el(
      'div',
      { class: 'balance-card balance-dust' },
      el('div', { class: 'balance-label' }, 'DUST balance'),
      el(
        'div',
        { class: 'balance-value mono num' },
        dust === null ? 'syncing…' : formatDust(dust.balance),
      ),
      dust === null
        ? el('div', { class: 'balance-sub muted' }, 'pays transaction fees')
        : el(
            'div',
            { class: 'balance-sub muted mono' },
            pct === null ? 'pays transaction fees' : `${pct.toFixed(1)}% of generation capacity`,
          ),
      meter,
    ),
  );

  for (const balance of balances.filter((item) => !isNativeToken(item.token_type))) {
    body.append(
      el(
        'div',
        { class: 'balance-card' },
        el(
          'div',
          { class: 'balance-label' },
          'token ',
          el('span', { class: 'mono' }, truncate(balance.token_type)),
        ),
        el('div', { class: 'balance-value mono num' }, formatRawAmount(balance.amount)),
        el(
          'div',
          { class: 'balance-sub muted mono', title: balance.token_type },
          balance.token_type,
        ),
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
    const transactions = await Promise.all(
      page.results.map(async (hash) => {
        const [transaction, utxos] = await Promise.all([
          api.tx(hash),
          // The amount column is cosmetic; a failed utxo lookup renders "—".
          api.txUtxos(hash).catch((): TxUtxos | null => null),
        ]);
        return { transaction, delta: nightDelta(utxos, address) };
      }),
    );
    if (version !== renderVersion) return;

    clear(body);
    if (transactions.length === 0) body.append(emptyState('No transactions for this address.'));
    else for (const { transaction, delta } of transactions) body.append(txRow(transaction, delta));

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

function explorerTxLink(hash: string): HTMLElement {
  return el(
    'a',
    {
      class: 'mono tx-explorer-link',
      title: `Open ${hash} in Nightfrost explorer`,
      href: `${EXPLORER_URL}/#/tx/${hash}`,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    truncate(hash),
  );
}

/// Net NIGHT movement for this address: outputs it owns minus inputs it
/// spent. Negative = sent, positive = received; null when utxos are unknown.
function nightDelta(utxos: TxUtxos | null, address: string): bigint | null {
  if (utxos === null) return null;
  const owned = (list: readonly Utxo[]) =>
    list
      .filter((utxo) => utxo.owner === address && isNativeToken(utxo.token_type))
      .reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
  return owned(utxos.outputs) - owned(utxos.inputs);
}

function amountCell(deltaStar: bigint | null): HTMLElement {
  if (deltaStar === null) return el('span', { class: 'amount-cell mono num muted' }, '—');
  const direction = deltaStar < 0n ? 'amount-out' : 'amount-in';
  const sign = deltaStar < 0n ? '−' : '+';
  const magnitude = deltaStar < 0n ? -deltaStar : deltaStar;
  const night = `${sign}${formatNight(magnitude.toString())}`;
  return el(
    'span',
    { class: `amount-cell mono num ${direction}`, title: `${night} NIGHT` },
    night,
  );
}

function txRow(transaction: Tx, deltaStar: bigint | null): HTMLElement {
  return el(
    'div',
    { class: 'table-row' },
    el('span', { class: 'mono num' }, transaction.block_height.toLocaleString('en-US')),
    el(
      'span',
      { class: 'hash-cell cell-hash' },
      explorerTxLink(transaction.hash),
      copyButton(transaction.hash),
    ),
    amountCell(deltaStar),
    el(
      'span',
      { class: `badge badge-variant-${transaction.variant.toLowerCase()}` },
      transaction.variant,
    ),
    statusPill(transaction.status),
    el(
      'span',
      { class: 'time-cell', title: formatTime(transaction.block_time) },
      formatTime(transaction.block_time),
    ),
  );
}

function statusPill(status: TxStatus): HTMLElement {
  return el(
    'span',
    { class: `pill pill-${status}` },
    status === 'partial_success' ? 'partial success' : status,
  );
}

function detailRow(label: string, ...value: Child[]): HTMLElement {
  return el(
    'div',
    { class: 'detail-row' },
    el('div', { class: 'detail-label' }, label),
    el('div', { class: 'detail-value' }, ...value),
  );
}

function copyButton(value: string): HTMLButtonElement {
  const button = el(
    'button',
    { class: 'copy-btn', type: 'button', title: 'Copy to clipboard', 'aria-label': 'Copy' },
    '⧉',
  );
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
  return el(
    'div',
    { class: 'state state-empty' },
    el('div', { class: 'state-icon' }, '❄'),
    el('div', { class: 'state-detail' }, message),
  );
}

function errorState(error: unknown, context: string): HTMLElement {
  const message = formatWalletError(error);
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
