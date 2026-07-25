// Epoch schedule. Midnight preview follows Cardano *preview*: 86,400-second
// epochs anchored at the Cardano preview genesis. For a mainnet deployment
// these would be 432,000 s anchored at the Cardano mainnet genesis
// (unix 1506203091) — adjust the two constants below.
export const EPOCH_LENGTH_S = 86_400;
export const EPOCH_ANCHOR_S = 1_666_656_000; // Cardano preview genesis (unix seconds)

export interface EpochInfo {
  epoch: number;
  /** 0..1 through the current epoch */
  progress: number;
  /** seconds until the next epoch boundary */
  remainingS: number;
}

export function epochAt(timestampMs: number): EpochInfo {
  const elapsed = timestampMs / 1000 - EPOCH_ANCHOR_S;
  const epoch = Math.floor(elapsed / EPOCH_LENGTH_S);
  const into = elapsed - epoch * EPOCH_LENGTH_S;
  return { epoch, progress: into / EPOCH_LENGTH_S, remainingS: EPOCH_LENGTH_S - into };
}

/** "18m 20s" / "3h 42m" / "55s" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
