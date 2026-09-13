// Helpers shared by the wallet and faucet end-to-end suites. Both talk to a
// real Nightfrost deployment and a real chain, so everything here is about
// waiting patiently and asserting on what the indexer eventually reports.
import assert from 'node:assert/strict';
import type { NetworkDef } from '../src/networks.ts';
import { NightfrostApi, type Tx, type TxUtxos } from '../src/api.ts';

export const STAR_PER_NIGHT = 1_000_000n;
export const NATIVE_TOKEN = '0'.repeat(64);

/// The well-known BIP39 test phrase; its preview wallet is funded and
/// registered for DUST. Override with NIGHTFROST_E2E_SEED_PHRASE.
export const TEST_PHRASE = Array<string>(12).fill('all').join(' ');

export function network(): NetworkDef {
  const networkId = (process.env.NIGHTFROST_E2E_NETWORK || 'preview') as NetworkDef['networkId'];
  return {
    name: networkId[0].toUpperCase() + networkId.slice(1),
    networkId,
    apiUrl: (process.env.NIGHTFROST_E2E_API || `https://${networkId}.nightfrost.dev`).replace(/\/+$/, ''),
    faucetUrl: null,
    color: '',
    enabled: true,
  };
}

export const log = (...parts: unknown[]) =>
  console.error(new Date().toISOString().slice(11, 19), ...parts);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/// Polls until `probe` returns a value, or the deadline passes.
export async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
  intervalMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch((error) => {
      log(`${label}: probe failed, retrying:`, error instanceof Error ? error.message : error);
      return undefined;
    });
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${label}: timed out after ${timeoutMs / 1000}s`);
    await sleep(intervalMs);
  }
}

/// Waits for the indexer to report the transaction as included and
/// successful, then returns it with its UTXO movements.
export async function waitForTransaction(
  api: NightfrostApi,
  hash: string,
  timeoutMs = 10 * 60 * 1_000,
): Promise<{ tx: Tx; utxos: TxUtxos }> {
  const tx = await waitFor(`tx ${hash.slice(0, 12)}… indexed`, timeoutMs, async () => {
    const found = await api.tx(hash).catch(() => undefined);
    if (found && found.status !== 'success') {
      // Included but not applied: no point waiting, and the segment list
      // says which part failed (the fee segment usually succeeds).
      throw new Error(`tx ${hash} landed with status ${found.status}, segments ${JSON.stringify(found.segments)}`);
    }
    return found?.status === 'success' ? found : undefined;
  });
  return { tx, utxos: await api.txUtxos(hash) };
}

/// Asserts that the transaction created a native NIGHT output of `value`
/// STAR for `ownerHex`.
export function assertNightOutput(utxos: TxUtxos, ownerHex: string, value: bigint): void {
  const owner = ownerHex.replace(/^0x/, '').toLowerCase();
  const match = utxos.outputs.find(
    (utxo) =>
      utxo.owner.replace(/^0x/, '').toLowerCase() === owner &&
      utxo.token_type.replace(/^0x/, '') === NATIVE_TOKEN &&
      BigInt(utxo.value) === value,
  );
  assert.ok(
    match,
    `expected a ${value} STAR NIGHT output to ${owner.slice(0, 12)}…; outputs were ${JSON.stringify(
      utxos.outputs.map((u) => ({ owner: u.owner.slice(0, 12), value: u.value })),
    )}`,
  );
}
