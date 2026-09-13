import type { NetworkDef } from './networks.ts';

export interface Tip {
  hash: string;
  height: number;
}

export interface ApiEnvelope<T> {
  results: T;
  tip: Tip | null;
  next_cursor: string | null;
}

export interface TokenBalance {
  token_type: string;
  amount: string;
}

export type TxStatus = 'success' | 'partial_success' | 'failure';

export interface Tx {
  id: number;
  hash: string;
  block_height: number;
  block_hash: string;
  /** unix milliseconds */
  block_time: number;
  index: number;
  protocol_version: number;
  variant: 'Regular' | 'System';
  status: TxStatus;
  segments: Array<[number, boolean]> | null;
  paid_fees: string;
  estimated_fees: string;
  identifiers: string[];
}

export interface Utxo {
  owner: string;
  token_type: string;
  value: string;
  intent_hash: string;
  output_index: number;
  ctime: number | null;
  registered_for_dust_generation: boolean;
}

export interface TxUtxos {
  hash: string;
  inputs: Utxo[];
  outputs: Utxo[];
}

export interface LedgerEvent {
  id: number;
  grouping: 'Zswap' | 'Dust' | 'Contract';
  raw: string;
  tx_id: number;
  block_height: number;
  protocol_version: number;
  relevant?: boolean | null;
}

export interface Stats {
  total_transactions: number;
  total_contract_actions: number;
  total_ledger_events: number;
  total_contracts: number;
}

export interface WalletEventsResult {
  events: LedgerEvent[];
  scanned_through: number;
  highest_event_id: number;
}

export type ShieldedSyncUpdate =
  | {
      type: 'collapsed';
      from_index: number;
      to_index: number;
      protocol_version: number;
      update: string;
    }
  | {
      type: 'transaction';
      from_index: number;
      to_index: number;
      protocol_version: number;
      tx_id: number;
      tx_hash: string;
      events: LedgerEvent[];
    };

export interface ShieldedSyncResult {
  updates: ShieldedSyncUpdate[];
  applied_through: number;
  highest_index: number;
  scanned_transactions: number;
}

export interface DustSyncResult {
  events: LedgerEvent[];
  scanned_through: number;
  highest_event_id: number;
}

export interface LedgerParameters {
  block_hash: string;
  block_height: number;
  block_time: number;
  protocol_version: number;
  ledger_parameters: string;
}

export interface SubmitResult {
  tx_hash: string;
}

export interface SyncStatus {
  indexed_height: number;
  node_height: number;
  percentage: number;
  caught_up: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NightfrostApi {
  constructor(private readonly network: NetworkDef) {}

  syncStatus(): Promise<SyncStatus> {
    return this.request<SyncStatus>('/sync');
  }

  addressBalances(address: string): Promise<TokenBalance[]> {
    return this.request<TokenBalance[]>(`/addresses/${address}`);
  }

  /// Every unspent output of the address, following pagination. Callers
  /// compare this with local wallet state, so a truncated first page would
  /// read as coins vanishing from the chain and trigger needless resyncs.
  async addressUtxos(address: string): Promise<Utxo[]> {
    const utxos: Utxo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.requestEnvelope<Utxo[]>(`/addresses/${address}/utxos`, {
        count: 5_000,
        cursor,
      });
      utxos.push(...page.results);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return utxos;
  }

  addressTxs(address: string, cursor?: string): Promise<ApiEnvelope<string[]>> {
    return this.requestEnvelope<string[]>(`/addresses/${address}/txs`, {
      count: 10,
      order: 'desc',
      cursor,
    });
  }

  tx(hash: string): Promise<Tx> {
    return this.request<Tx>(`/txs/${hash}`);
  }

  txByIdentifier(identifier: string): Promise<Tx> {
    return this.request<Tx>('/tx-identifiers/' + identifier);
  }

  txUtxos(hash: string): Promise<TxUtxos> {
    return this.request<TxUtxos>('/txs/' + hash + '/utxos');
  }

  stats(): Promise<Stats> {
    return this.request<Stats>('/stats');
  }

  ledgerParameters(): Promise<LedgerParameters> {
    return this.request<LedgerParameters>('/ledger-parameters/latest');
  }

  ledgerEvents(from: number, cursor?: string): Promise<ApiEnvelope<LedgerEvent[]>> {
    return this.requestEnvelope<LedgerEvent[]>('/ledger/events', {
      from,
      count: 5_000,
      order: 'asc',
      cursor,
    });
  }

  walletEvents(
    viewingKey: string,
    from: number,
    count = 5_000,
  ): Promise<ApiEnvelope<WalletEventsResult>> {
    return this.postEnvelope<WalletEventsResult>('/wallet/events', {
      viewing_key: viewingKey,
      from,
      count,
    });
  }

  walletShieldedSync(
    viewingKey: string,
    fromIndex: number,
  ): Promise<ApiEnvelope<ShieldedSyncResult>> {
    return this.postEnvelope<ShieldedSyncResult>('/wallet-sync/shielded', {
      viewing_key: viewingKey,
      from_index: fromIndex,
    });
  }

  walletDustSync(from: number, count = 50_000): Promise<ApiEnvelope<DustSyncResult>> {
    return this.requestEnvelope<DustSyncResult>('/wallet-sync/dust', { from, count });
  }

  addressTxsSince(address: string, from: number, cursor?: string): Promise<ApiEnvelope<string[]>> {
    return this.requestEnvelope<string[]>('/addresses/' + address + '/txs', {
      from,
      count: 100,
      order: 'asc',
      cursor,
    });
  }

  async submit(transaction: Uint8Array): Promise<SubmitResult> {
    const url = new URL(this.network.apiUrl + '/api/v0/tx/submit');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: transaction,
      });
    } catch {
      throw new ApiError(
        0,
        'Could not reach ' + this.network.name + ' at ' + this.network.apiUrl + '.',
      );
    }

    if (!response.ok) {
      let message = response.statusText || 'HTTP ' + response.status;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // Keep the HTTP status text for a non-JSON error.
      }
      throw new ApiError(response.status, message);
    }
    return (await response.json()) as SubmitResult;
  }

  private async postEnvelope<T>(path: string, payload: unknown): Promise<ApiEnvelope<T>> {
    const url = new URL(`${this.network.apiUrl}/api/v0${path}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(0, `Could not reach ${this.network.name} at ${this.network.apiUrl}.`);
    }
    if (!response.ok) {
      let message = response.statusText || `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // Keep the HTTP status text for a non-JSON error.
      }
      throw new ApiError(response.status, message);
    }
    return (await response.json()) as ApiEnvelope<T>;
  }

  private async request<T>(path: string): Promise<T> {
    return (await this.requestEnvelope<T>(path)).results;
  }

  private async requestEnvelope<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<ApiEnvelope<T>> {
    const url = new URL(`${this.network.apiUrl}/api/v0${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new ApiError(0, `Could not reach ${this.network.name} at ${this.network.apiUrl}.`);
    }

    if (!response.ok) {
      let message = response.statusText || `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // Keep the HTTP status text for a non-JSON error.
      }
      throw new ApiError(response.status, message);
    }

    const body: unknown = await response.json();
    if (isRecord(body) && 'results' in body) return body as unknown as ApiEnvelope<T>;

    // Keep compatibility with indexers deployed before the common envelope.
    return { results: body as T, tip: null, next_cursor: null };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
