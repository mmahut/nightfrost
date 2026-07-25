// Typed client for the nightfrost REST API (base path /api/v0).

import { activeNetwork } from './networks.ts';

export interface SyncStatus {
  indexed_height: number;
  node_height: number;
  percentage: number;
  caught_up: boolean;
}

export interface NetworkInfo {
  network_id: string;
  node_url: string;
  genesis_hash: string;
}

export interface Block {
  hash: string;
  height: number;
  parent_hash: string;
  /** unix milliseconds */
  timestamp: number;
  protocol_version: number;
  author: string | null;
  tx_count: number;
  zswap_merkle_tree_root: string;
  ledger_state_root: string;
}

export type TxStatus = 'success' | 'partial_success' | 'failure';
export type TxVariant = 'Regular' | 'System';

export interface Tx {
  hash: string;
  block_height: number;
  block_hash: string;
  /** unix milliseconds */
  block_time: number;
  index: number;
  variant: TxVariant;
  status: TxStatus;
  segments: unknown;
  paid_fees: string;
  estimated_fees: string;
  identifiers: string[];
  utxo_created_count: number;
  utxo_spent_count: number;
  event_count: number;
  contract_action_count: number;
}

export interface Utxo {
  owner: string;
  token_type: string;
  /** integer as decimal string */
  value: string;
  intent_hash: string;
  output_index: number;
  /** unix seconds */
  ctime: number;
  registered_for_dust_generation: boolean;
}

export interface TxUtxos {
  hash: string;
  inputs: Utxo[];
  outputs: Utxo[];
}

export interface ChainEvent {
  id: number;
  grouping: string;
  /** tagged JSON object, or a bare tag string */
  attributes: Record<string, unknown> | string;
  /** hex payload */
  raw: string;
  tx_id: number;
  block_height: number;
}

export interface TokenBalance {
  token_type: string;
  amount: string;
}

export interface Contract {
  address: string;
  deploy_action_id: number;
  latest_action_id: number;
  latest_action_type: string;
  latest_block_height: number;
  balances: TokenBalance[];
}

export interface ContractState {
  address: string;
  block_height: number;
  /** hex */
  state: string;
}

export interface ContractAction {
  id: number;
  type: string;
  entry_point: string | null;
  tx_hash: string;
  block_height: number;
}

export interface Tip {
  hash: string;
  height: number;
}

export interface ApiEnvelope<T> {
  results: T;
  tip: Tip | null;
  next_cursor: string | null;
}

export interface DustRegistration {
  cardano_stake_key: string;
  dust_address: string;
  valid: boolean;
  registered_at_height: number;
  removed_at_height: number | null;
  utxo_id: string | null;
  utxo_index: number | null;
}

export interface Stats {
  total_transactions: number;
  total_contract_actions: number;
  total_ledger_events: number;
  total_contracts: number;
}

export interface PageOpts {
  count?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

export interface EventPageOpts extends PageOpts {
  from?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiBase(): string {
  return activeNetwork().apiUrl.replace(/\/+$/, '');
}

async function reqEnvelope<T>(path: string, params?: Record<string, string | number | undefined>): Promise<ApiEnvelope<T>> {
  const url = new URL(`${apiBase()}/api/v0${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch {
    throw new ApiError(0, 'Network Error', `could not reach the API at ${apiBase()}`);
  }
  if (!res.ok) {
    let msg = res.statusText;
    let err = res.statusText;
    try {
      const body = (await res.json()) as { status_code?: number; error?: string; message?: string };
      if (body.message) msg = body.message;
      if (body.error) err = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, err, msg);
  }
  const body: unknown = await res.json();

  // The current API uses the { results, tip, next_cursor } envelope. The
  // binary currently deployed from the dev host predates that change and
  // returns direct objects/arrays (ledger-events uses an `events` field), so
  // accept both while the indexers are migrated.
  if (isRecord(body) && 'results' in body) {
    return body as unknown as ApiEnvelope<T>;
  }
  if (isRecord(body) && 'events' in body) {
    return {
      results: body.events as T,
      tip: null,
      next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
    };
  }
  return { results: body as T, tip: null, next_cursor: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function req<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  return (await reqEnvelope<T>(path, params)).results;
}

const pageParams = (o: PageOpts = {}) => ({ count: o.count, cursor: o.cursor, order: o.order });

export const api = {
  syncStatus: () => req<SyncStatus>('/sync-status'),
  network: () => req<NetworkInfo>('/network'),
  stats: () => req<Stats>('/stats'),

  latestBlock: () => req<Block>('/blocks/latest'),
  block: (id: string | number) => req<Block>(`/blocks/${id}`),
  blockTxs: (id: string | number, opts?: PageOpts) => reqEnvelope<string[]>(`/blocks/${id}/txs`, pageParams(opts)),

  tx: (hash: string) => req<Tx>(`/txs/${hash}`),
  txUtxos: (hash: string) => req<TxUtxos>(`/txs/${hash}/utxos`),
  txEvents: (hash: string) => req<ChainEvent[]>(`/txs/${hash}/events`),

  addressBalances: (addr: string) => req<TokenBalance[]>(`/addresses/${addr}`),
  addressUtxos: (addr: string, tokenType?: string, opts?: PageOpts) =>
    reqEnvelope<Utxo[]>(`/addresses/${addr}/utxos${tokenType ? `/${tokenType}` : ''}`, pageParams(opts)),
  addressTxs: (addr: string, opts?: PageOpts) => reqEnvelope<string[]>(`/addresses/${addr}/txs`, pageParams(opts)),

  contract: (addr: string) => req<Contract>(`/contracts/${addr}`),
  contractState: (addr: string) => req<ContractState>(`/contracts/${addr}/state`),
  contractActions: (addr: string, opts?: PageOpts) =>
    reqEnvelope<ContractAction[]>(`/contracts/${addr}/actions`, pageParams(opts)),

  ledgerEvents: (opts: EventPageOpts = {}) =>
    reqEnvelope<ChainEvent[]>('/ledger-events', { ...pageParams(opts), from: opts.from }),

  dustRegistrations: (stakeKey?: string, opts?: PageOpts) =>
    reqEnvelope<DustRegistration[]>(`/dust/registrations${stakeKey ? `/${stakeKey}` : ''}`, pageParams(opts)),
};
