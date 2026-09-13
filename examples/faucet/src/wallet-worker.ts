import '../../light-wallet/src/polyfills.ts';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  errorMessage,
  FaucetWallet,
  HttpError,
  NETWORKS,
  type Claim,
  type Lifecycle,
  type NetworkId,
} from './faucet-wallet.ts';

/// Messages from the HTTP process to a wallet worker.
export type WorkerCommand =
  | { type: 'claim'; claim: Claim; address: string }
  | { type: 'stop' };

/// Messages from a wallet worker back to the HTTP process.
export type WorkerEvent =
  | { type: 'state'; state: Lifecycle; message: string }
  | { type: 'claim'; claim: Claim };

// One worker per network. The wallet cores' WASM sync and the ledger's
// transaction building are CPU-bound and synchronous for seconds to minutes
// at a time; on the main thread they starved the HTTP server until nginx
// answered 504 for status and claim polls.
if (!isMainThread && parentPort) {
  const port = parentPort;
  const network = NETWORKS[(workerData as { networkId: NetworkId }).networkId];
  const post = (event: WorkerEvent) => port.postMessage(event);
  const wallet = new FaucetWallet(network, {
    onState: (state, message) => post({ type: 'state', state, message }),
    onClaim: (claim) => post({ type: 'claim', claim: { ...claim } }),
  });

  port.on('message', (command: WorkerCommand) => {
    if (command.type === 'claim') {
      try {
        wallet.claim(command.claim, command.address);
      } catch (error) {
        // The HTTP process checks readiness before forwarding, so this only
        // fires on a race; report it as a failed claim rather than dropping it.
        const status = error instanceof HttpError ? error.status : 500;
        post({
          type: 'claim',
          claim: { ...command.claim, state: 'failed', message: `${errorMessage(error)} (HTTP ${status})` },
        });
      }
    } else if (command.type === 'stop') {
      void (wallet.session?.stop() ?? Promise.resolve())
        .catch(() => undefined)
        .finally(() => process.exit(0));
    }
  });

  post({ type: 'state', state: wallet.state, message: wallet.message });
  if (network.enabled) void wallet.start();
}
