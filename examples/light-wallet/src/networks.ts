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

/** The Nightfrost explorer used by transaction links. */
export const EXPLORER_URL = (
  import.meta.env.VITE_EXPLORER_URL || 'https://explorer.nightfrost.dev'
).replace(/\/+$/, '');
