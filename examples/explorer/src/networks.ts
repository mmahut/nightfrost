// Multi-network registry. Configure via VITE_NETWORKS, a JSON array of
//   [{"name":"Preview","apiUrl":"http://127.0.0.1:3100","color":"#f0b429"}, ...]
// A plain VITE_API_URL is honored as a single-network fallback. The footer's
// "custom API" field adds an extra entry at runtime (persisted locally).

export interface NetworkDef {
  name: string;
  apiUrl: string;
  color: string;
}

const ACTIVE_KEY = 'nf.network';
const CUSTOM_KEY = 'nf.apiBase'; // same key the footer setting has always used

const DEFAULT_NETWORKS: NetworkDef[] = [
  { name: 'Preview', apiUrl: 'http://127.0.0.1:3100', color: '#f0b429' },
  { name: 'Mainnet', apiUrl: 'http://127.0.0.1:3102', color: '#34d399' },
];

function configuredNetworks(): NetworkDef[] {
  const raw = import.meta.env.VITE_NETWORKS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.filter(
          (n): n is NetworkDef =>
            typeof n === 'object' &&
            n !== null &&
            typeof (n as NetworkDef).name === 'string' &&
            typeof (n as NetworkDef).apiUrl === 'string',
        );
        if (list.length > 0) {
          return list.map((n) => ({ ...n, color: typeof n.color === 'string' ? n.color : '#8fd0e4' }));
        }
      }
    } catch {
      console.warn('VITE_NETWORKS is not valid JSON; using defaults');
    }
  }
  if (import.meta.env.VITE_API_URL) {
    return [{ name: 'API', apiUrl: import.meta.env.VITE_API_URL, color: '#8fd0e4' }];
  }
  return DEFAULT_NETWORKS;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function customApi(): string | null {
  return read(CUSTOM_KEY);
}

/** Registry: configured networks plus the runtime "Custom" entry, if set. */
export function networks(): NetworkDef[] {
  const list = [...configuredNetworks()];
  const custom = customApi();
  if (custom) list.push({ name: 'Custom', apiUrl: custom, color: '#8fd0e4' });
  return list;
}

/** `?network=preview` (id or display name, case-insensitive) wins over the
 *  stored choice, so links from the wallet and faucet open the right chain. */
function networkFromQuery(list: NetworkDef[]): NetworkDef | undefined {
  const wanted = new URLSearchParams(location.search).get('network')?.trim().toLowerCase();
  if (!wanted) return undefined;
  return list.find((n) => n.name.toLowerCase() === wanted);
}

export function activeNetwork(): NetworkDef {
  const list = networks();
  const fromQuery = networkFromQuery(list);
  if (fromQuery) return fromQuery;
  const stored = read(ACTIVE_KEY);
  return list.find((n) => n.name === stored) ?? list[0];
}

/** Persist the selection and reload: fresh caches, same route (hash survives).
 *  The query parameter is rewritten too, or it would pin the previous network. */
export function selectNetwork(name: string): void {
  write(ACTIVE_KEY, name);
  const url = new URL(location.href);
  url.searchParams.set('network', name.toLowerCase());
  location.replace(url.toString());
}

/** Footer escape hatch: set (and switch to) a custom API URL; empty clears it. */
export function setCustomApi(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed) {
    write(CUSTOM_KEY, trimmed);
    write(ACTIVE_KEY, 'Custom');
  } else {
    write(CUSTOM_KEY, null);
    write(ACTIVE_KEY, null);
  }
  const target = new URL(location.href);
  target.searchParams.delete('network');
  location.replace(target.toString());
}
