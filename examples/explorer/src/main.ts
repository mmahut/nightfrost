import './style.css';
import { api } from './api.ts';
import { activeNetwork, customApi, networks, selectNetwork, setCustomApi } from './networks.ts';
import { formatUsd, nightPrice } from './price.ts';
import { route, startRouter } from './router.ts';
import { el } from './ui.ts';
import { renderHome } from './pages/home.ts';
import { renderBlock } from './pages/block.ts';
import { renderTx } from './pages/tx.ts';
import { renderAddress } from './pages/address.ts';
import { renderContract } from './pages/contract.ts';
import { renderSearch } from './pages/search.ts';

const LOGO_SVG = `<svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="38,8 48,22 58,8"/><polyline points="38,8 48,22 58,8" transform="rotate(60 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(120 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(180 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(240 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(300 48 48)"/></g><circle cx="48" cy="48" r="10" fill="#8fd0e4"/></svg>`;

/* -------------------------------------------------------------- theme */
// Dark is the default: prefers-color-scheme only wins when the user has
// explicitly selected "auto".

type Theme = 'auto' | 'light' | 'dark';
const THEME_KEY = 'nf.theme';

function currentTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'auto') return t;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

function applyTheme(t: Theme, persist = true): void {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage unavailable */
  }
}

const THEME_ICONS: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
const THEME_NEXT: Record<Theme, Theme> = { dark: 'light', light: 'auto', auto: 'dark' };

/* ------------------------------------------------------- price ticker */

function buildPriceTicker(): HTMLElement {
  const wrap = el('span', { class: 'price-ticker mono num', hidden: '' });
  void nightPrice().then((p) => {
    if (!p) return; // stay hidden — price is a nicety, not a dependency
    const change = p.change24h;
    wrap.append(
      el('span', { class: 'muted' }, 'NIGHT: '),
      el('span', { class: 'accent' }, formatUsd(p.usd)),
      ' ',
      el(
        'span',
        { class: change >= 0 ? 'price-up' : 'price-down' },
        `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
      ),
    );
    wrap.removeAttribute('hidden');
  });
  return wrap;
}

/* --------------------------------------------------- network dropdown */

function buildNetworkPill(): HTMLElement {
  const active = activeNetwork();
  const dot = (color: string) => {
    const d = el('span', { class: 'net-dot', 'aria-hidden': 'true' });
    d.style.background = color;
    return d;
  };

  const btn = el(
    'button',
    {
      class: 'net-pill',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: `network: ${active.name} (${active.apiUrl})`,
    },
    dot(active.color),
    el('span', { class: 'net-name' }, active.name),
    el('span', { class: 'net-caret', 'aria-hidden': 'true' }, '⌄'),
  );

  const menu = el('div', { class: 'net-menu', role: 'menu', hidden: '' });
  for (const n of networks()) {
    const item = el(
      'button',
      { class: 'net-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(n.name === active.name) },
      dot(n.color),
      el('span', { class: 'net-name' }, n.name),
      el('span', { class: 'net-check' }, n.name === active.name ? '✓' : ''),
    );
    item.addEventListener('click', () => {
      if (n.name !== active.name) selectNetwork(n.name);
      else close();
    });
    menu.append(item);
  }

  const wrap = el('div', { class: 'net-wrap' }, btn, menu);

  const close = () => {
    menu.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    menu.removeAttribute('hidden');
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLButtonElement>('.net-item')?.focus();
  };
  btn.addEventListener('click', () => (menu.hasAttribute('hidden') ? open() : close()));
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      btn.focus();
    }
  });
  return wrap;
}

/* ------------------------------------------------------------- header */

function buildHeader(): HTMLElement {
  const logo = el('a', { class: 'logo', href: '#/', 'aria-label': 'nightfrost home' });
  logo.innerHTML = LOGO_SVG; // static inline SVG constant, not user data
  logo.append(el('span', { class: 'logo-word' }, 'night', el('span', { class: 'accent' }, 'frost')));

  const input = el('input', {
    class: 'search-input mono',
    type: 'search',
    placeholder: 'height · hash · address',
    'aria-label': 'Search the chain',
    spellcheck: 'false',
  });
  const form = el('form', { class: 'header-search' }, input);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) {
      location.hash = `#/search/${encodeURIComponent(q)}`;
      input.value = '';
      input.blur();
    }
  });

  let theme = currentTheme();
  const themeBtn = el('button', { class: 'theme-btn', type: 'button', title: `theme: ${theme}` }, THEME_ICONS[theme]);
  themeBtn.addEventListener('click', () => {
    theme = THEME_NEXT[theme];
    applyTheme(theme);
    themeBtn.textContent = THEME_ICONS[theme];
    themeBtn.title = `theme: ${theme}`;
  });

  return el(
    'header',
    { class: 'site-header' },
    el('div', { class: 'shell header-row' }, logo, form, buildPriceTicker(), buildNetworkPill(), themeBtn),
  );
}

/* ------------------------------------------------------------- footer */

function buildFooter(): HTMLElement {
  const info = el('span', { class: 'muted footer-net mono' }, '');
  void api
    .network()
    .then((n) => {
      info.textContent = n.network_id;
    })
    .catch(() => {
      info.textContent = 'api unreachable';
    });

  // Sync state lives down here — useful, but not the page's primary information.
  const syncState = el('span', { class: 'muted footer-net mono' }, '');
  const refreshSyncState = () => {
    void api
      .syncStatus()
      .then((s) => {
        syncState.textContent = s.caught_up
          ? '✓ caught up'
          : `↺ syncing${s.percentage != null ? ` ${s.percentage.toFixed(1)}%` : ''}`;
      })
      .catch(() => {
        syncState.textContent = '';
      });
  };
  refreshSyncState();
  window.setInterval(refreshSyncState, 30_000);

  // Escape hatch: point the explorer at any nightfrost instance not in the
  // network registry. Adds a "Custom" entry to the header switcher; clearing
  // the field removes it again.
  const input = el('input', {
    class: 'api-input mono',
    type: 'url',
    value: customApi() ?? '',
    'aria-label': 'Custom API base URL',
    placeholder: activeNetwork().apiUrl,
    spellcheck: 'false',
  });
  const form = el(
    'form',
    { class: 'api-form' },
    el('label', { class: 'muted api-label' }, 'custom API'),
    input,
    el('button', { class: 'api-save', type: 'submit' }, 'set'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setCustomApi(input.value);
  });

  return el(
    'footer',
    { class: 'site-footer' },
    el(
      'div',
      { class: 'shell footer-row' },
      el('span', { class: 'muted' }, 'nightfrost explorer, a reference client for the nightfrost REST API'),
      info,
      syncState,
      form,
    ),
  );
}

/* --------------------------------------------------------------- boot */

applyTheme(currentTheme(), false); // index.html sets this pre-paint; re-assert for consistency

const app = document.querySelector<HTMLDivElement>('#app')!;
const outlet = el('main', { class: 'shell page-outlet' });
app.append(buildHeader(), outlet, buildFooter());

route(/^\/?$/, renderHome);
route(/^\/block\/([^/]+)$/, renderBlock);
route(/^\/tx\/([^/]+)$/, renderTx);
route(/^\/address\/([^/]+)$/, renderAddress);
route(/^\/contract\/([^/]+)$/, renderContract);
route(/^\/search\/(.+)$/, renderSearch);
route(/^(.*)$/, (root, path) => {
  root.append(
    el(
      'div',
      { class: 'state state-empty' },
      el('div', { class: 'state-icon' }, '❄'),
      el('div', { class: 'state-title' }, 'Lost in the frost'),
      el('div', { class: 'state-detail' }, `No page at “${path}”. `),
      el('a', { href: '#/' }, 'Back to the dashboard'),
    ),
  );
});

startRouter(outlet);
