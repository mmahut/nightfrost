import './style.css';

const LOGO_SVG = `<svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="38,8 48,22 58,8"/><polyline points="38,8 48,22 58,8" transform="rotate(60 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(120 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(180 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(240 48 48)"/><polyline points="38,8 48,22 58,8" transform="rotate(300 48 48)"/></g><circle cx="48" cy="48" r="10" fill="#8fd0e4"/></svg>`;

type Network = 'preview' | 'preprod';
type Theme = 'auto' | 'light' | 'dark';
type Child = Node | string | null | undefined;
type FaucetState = { state: string; message: string };
type StatusResponse = { networks: Record<Network, FaucetState> };
type ClaimResponse = { id: string; state: string; message: string };

const COLORS: Record<Network, string> = { preview: '#f0b429', preprod: '#8fd0e4' };
const THEME_KEY = 'nf.theme';
const THEME_ICONS: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
const THEME_NEXT: Record<Theme, Theme> = { dark: 'light', light: 'auto', auto: 'dark' };
/// `?network=preview|preprod` selects the network on load (the wallet links
/// here with it); switching updates the address bar so the page is shareable.
function networkFromQuery(): Network {
  const wanted = new URLSearchParams(location.search).get('network')?.trim().toLowerCase();
  return wanted === 'preprod' ? 'preprod' : 'preview';
}
function rememberNetworkInUrl(value: Network): void {
  const url = new URL(location.href);
  url.searchParams.set('network', value);
  history.replaceState(history.state, '', url.toString());
}
let network: Network = networkFromQuery();
let statusTimer: ReturnType<typeof setTimeout> | undefined;

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
    if (child !== null && child !== undefined) {
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}

function currentTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'auto' || saved === 'light' || saved === 'dark' ? saved : 'dark';
}

function applyTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

function networkButton(value: Network): HTMLButtonElement {
  const button = el(
    'button',
    { class: 'net-pill', type: 'button', 'aria-pressed': String(network === value) },
    el('span', { class: 'net-dot', style: `background:${COLORS[value]}` }),
    value[0].toUpperCase() + value.slice(1),
  );
  button.addEventListener('click', () => {
    if (network === value) return;
    network = value;
    rememberNetworkInUrl(value);
    render();
  });
  return button;
}

function buildHeader(): HTMLElement {
  const logo = el('a', { class: 'logo', href: '/', 'aria-label': 'nightfrost faucet' });
  logo.innerHTML = LOGO_SVG;
  logo.append(
    el('span', { class: 'logo-word' }, 'night', el('span', { class: 'accent' }, 'frost')),
    el('span', { class: 'faucet-product muted' }, 'faucet'),
  );
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
    el('div', { class: 'shell header-row' }, logo, el('span', { class: 'faucet-spacer' }), themeButton),
  );
}

function setStatus(node: HTMLElement, message: string, kind = ''): void {
  node.className = `faucet-status ${kind}`.trim();
  node.replaceChildren();
  if (kind.includes('is-busy')) node.append(el('span', { class: 'spin', 'aria-hidden': 'true' }));
  node.append(document.createTextNode(message));
}

/// A response that says nothing about the claim itself: the network was
/// down, or nginx answered for a faucet that was too busy to reply in time
/// (an HTML 502/504 page, not JSON). Polls keep waiting through these.
class TransientError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new TransientError('The faucet is unreachable right now.');
  }
  const text = await response.text();
  let body: (T & { message?: string }) | undefined;
  try {
    body = JSON.parse(text) as T & { message?: string };
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message = body?.message || `Request failed (HTTP ${response.status}).`;
    if (response.status === 502 || response.status === 503 || response.status === 504 || body === undefined) {
      throw new TransientError(message);
    }
    throw new Error(message);
  }
  if (body === undefined) throw new TransientError('The faucet returned an unreadable response.');
  return body;
}

/// How long a claim poll tolerates transient errors before giving up.
const POLL_PATIENCE_MS = 15 * 60 * 1_000;

function waitForClaim(id: string, status: HTMLElement, submit: HTMLButtonElement): void {
  const startedAt = Date.now();
  const poll = async (): Promise<void> => {
    try {
      const claim = await api<ClaimResponse>(`/api/claims/${encodeURIComponent(id)}`);
      if (claim.state === 'complete') {
        status.className = 'faucet-status state-ok';
        status.replaceChildren(document.createTextNode('Sent 1.337 NIGHT · '));
        const link = el('a', { href: `https://explorer.nightfrost.dev/?network=${network}#/tx/${claim.message}`, target: '_blank', rel: 'noreferrer' }, 'view transaction');
        status.append(link);
        submit.disabled = false;
        submit.textContent = 'Send 1.337 NIGHT';
        return;
      }
      if (claim.state === 'failed') throw new Error(claim.message);
      setStatus(status, claim.message, 'is-busy');
      statusTimer = setTimeout(() => void poll(), 2_000);
    } catch (error) {
      if (error instanceof TransientError && Date.now() - startedAt < POLL_PATIENCE_MS) {
        setStatus(status, 'The faucet is busy; still waiting for your transfer…', 'is-busy');
        statusTimer = setTimeout(() => void poll(), 5_000);
        return;
      }
      setStatus(status, error instanceof Error ? error.message : String(error), 'state-error');
      submit.disabled = false;
      submit.textContent = 'Send 1.337 NIGHT';
    }
  };
  void poll();
}

function render(): void {
  if (statusTimer) clearTimeout(statusTimer);
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const address = el('input', {
    class: 'faucet-input mono',
    name: 'address',
    placeholder: `mn_addr_${network}…`,
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    required: '',
  });
  const submit = el('button', { class: 'search-go faucet-submit', type: 'submit', disabled: '' }, 'Checking…');
  const status = el('div', { class: 'faucet-status muted', role: 'status', 'aria-live': 'polite' });
  const form = el(
    'form',
    { class: 'faucet-form' },
    el('label', { class: 'label', for: 'faucet-address' }, 'Your NIGHT address'),
    el('div', { class: 'faucet-row' }, address, submit),
    status,
  );
  address.id = 'faucet-address';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Sending…';
    setStatus(status, 'Your transfer is queued. Building and proving the transaction…', 'is-busy');
    void api<ClaimResponse>('/api/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ network, address: address.value.trim() }),
    })
      .then((claim) => waitForClaim(claim.id, status, submit))
      .catch((error: unknown) => {
        setStatus(status, error instanceof Error ? error.message : String(error), 'state-error');
        submit.disabled = false;
        submit.textContent = 'Send 1.337 NIGHT';
      });
  });

  const footer = el(
    'footer',
    { class: 'site-footer' },
    el(
      'div',
      { class: 'shell footer-row' },
      el('span', { class: 'muted' }, 'Midnight testnet faucet powered by nightfrost'),
      el('span', { class: 'muted mono' }, `${network}.nightfrost.dev`),
    ),
  );
  app.replaceChildren(
    buildHeader(),
    el(
      'main',
      { class: 'shell faucet-outlet' },
      el(
        'section',
        { class: 'hero faucet-hero' },
        el(
          'div',
          { class: 'hero-inner faucet-inner' },
          el('div', { class: 'faucet-kicker label' }, 'Preview · Preprod · test funds'),
          el('h1', { class: 'hero-title' }, 'A little NIGHT for the road.'),
          el('p', { class: 'faucet-copy muted' }, 'Choose a test network, paste your NIGHT address, and receive exactly 1.337 NIGHT.'),
          el('div', { class: 'faucet-network', role: 'group', 'aria-label': 'Network' }, networkButton('preview'), networkButton('preprod')),
          form,
          el('p', { class: 'faucet-note muted' }, 'Testnet NIGHT has no monetary value. A zero-knowledge proof is generated for every transfer, so delivery can take several minutes.'),
        ),
      ),
    ),
    footer,
  );

  void api<StatusResponse>('/api/status')
    .then((result) => {
      const selected = result.networks[network];
      if (selected.state === 'ready') {
        submit.disabled = false;
        submit.textContent = 'Send 1.337 NIGHT';
        status.replaceChildren(el('span', { class: 'faucet-ready' }, el('span', { class: 'faucet-ready-dot' }), 'Faucet is ready'));
      } else {
        setStatus(status, selected.message, 'muted');
      }
    })
    .catch(() => setStatus(status, 'Faucet service is temporarily unavailable.', 'state-error'));
}

render();
