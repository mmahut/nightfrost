export interface NetworkDef {
  name: 'Preview' | 'Preprod' | 'Mainnet';
  networkId: 'preview' | 'preprod' | 'mainnet';
  apiUrl: string;
  faucetUrl: string | null;
  color: string;
  enabled: boolean;
}

const DEFAULT_NETWORKS: NetworkDef[] = [
  {
    name: 'Preview',
    networkId: 'preview',
    apiUrl: 'https://preview.nightfrost.dev',
    faucetUrl: 'https://faucet.nightfrost.dev/',
    color: '#f0b429',
    enabled: true,
  },
  {
    name: 'Preprod',
    networkId: 'preprod',
    apiUrl: 'https://preprod.nightfrost.dev',
    faucetUrl: 'https://faucet.nightfrost.dev/',
    color: '#8fd0e4',
    enabled: true,
  },
  {
    name: 'Mainnet',
    networkId: 'mainnet',
    apiUrl: 'https://mainnet.nightfrost.dev',
    faucetUrl: null,
    color: '#34d399',
    enabled: false,
  },
];

function configuredNetworks(): NetworkDef[] {
  const raw = import.meta.env.VITE_NETWORKS;
  if (!raw) return DEFAULT_NETWORKS;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected an array');

    return DEFAULT_NETWORKS.map((fallback) => {
      const configured = parsed.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          String((entry as { name?: unknown }).name).toLowerCase() === fallback.name.toLowerCase(),
      ) as { apiUrl?: unknown; color?: unknown } | undefined;

      return {
        ...fallback,
        apiUrl:
          typeof configured?.apiUrl === 'string'
            ? configured.apiUrl.replace(/\/+$/, '')
            : fallback.apiUrl,
        color: typeof configured?.color === 'string' ? configured.color : fallback.color,
      };
    });
  } catch {
    console.warn('VITE_NETWORKS is not valid; using the built-in API defaults');
    return DEFAULT_NETWORKS;
  }
}

export const NETWORKS = configuredNetworks();

/**
 * Where zero-knowledge proofs are generated. By default the wallet talks to a
 * Midnight proof server on its own origin: the SDK's HTTP prover client posts
 * to the absolute paths `/prove` and `/check`, which Nginx (production) and
 * Vite (`npm run dev` / `npm run preview`) proxy to the proof server on
 * 127.0.0.1:6300. Set VITE_PROVING_SERVER_URL to an absolute URL to use a
 * different proof server, or to `browser` to fall back to the in-tab WASM
 * prover, which needs no server but takes several minutes per transaction.
 */
export const PROVING_SERVER_URL: URL | undefined = resolveProvingServerUrl(
  import.meta.env.VITE_PROVING_SERVER_URL,
);

function resolveProvingServerUrl(raw: string | undefined): URL | undefined {
  const value = (raw ?? '').trim();
  if (value.toLowerCase() === 'browser') return undefined;
  if (value) {
    try {
      return new URL(value);
    } catch {
      console.warn('VITE_PROVING_SERVER_URL is not a valid URL; using the same-origin proof server');
    }
  }
  return typeof location === 'undefined' ? undefined : new URL(location.origin);
}

/** True when proofs are generated in this tab instead of by a proof server. */
export const BROWSER_PROVING = PROVING_SERVER_URL === undefined;

/** The Nightfrost explorer used by transaction links. */
export const EXPLORER_URL = (
  import.meta.env.VITE_EXPLORER_URL || 'https://explorer.nightfrost.dev'
).replace(/\/+$/, '');
