// Shared formatters: NIGHT amounts, times, hash truncation.

export const NATIVE_TOKEN = '0'.repeat(64);
const STAR_PER_NIGHT = 1_000_000n;

export function isNativeToken(tokenType: string): boolean {
  return tokenType.toLowerCase().replace(/^0x/, '') === NATIVE_TOKEN;
}

/** STAR (string integer) -> "1,234.567890" NIGHT with 6 decimals. */
export function formatNight(star: string): string {
  let v: bigint;
  try {
    v = BigInt(star);
  } catch {
    return star;
  }
  const sign = v < 0n ? '-' : '';
  if (v < 0n) v = -v;
  const whole = v / STAR_PER_NIGHT;
  const frac = (v % STAR_PER_NIGHT).toString().padStart(6, '0');
  return `${sign}${groupDigits(whole.toString())}.${frac}`;
}

export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatInt(n: number | bigint): string {
  return groupDigits(n.toString());
}

/** Raw token amount (non-native tokens have unknown decimals). */
export function formatRawAmount(value: string): string {
  return /^\d+$/.test(value) ? groupDigits(value) : value;
}

/** "8fd0e4…47bc4c" style middle truncation (8+8). */
export function truncateHash(hash: string, head = 8, tail = 8): string {
  const h = hash.replace(/^0x/, '');
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

const ABS_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

export function formatAbsoluteTime(ms: number): string {
  return ABS_FMT.format(new Date(ms));
}

export function formatRelativeTime(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  const s = Math.round(abs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ${suffix}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s ` : ''}${suffix}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m ` : ''}${suffix}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ${h % 24 ? `${h % 24}h ` : ''}${suffix}`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ${suffix}`;
  return `${Math.floor(mo / 12)}y ${suffix}`;
}

/** Group a hex string into spaced byte pairs, 16 bytes per row, with offsets. */
export function formatHexDump(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 32) {
    const row = clean.slice(i, i + 32);
    const bytes = row.match(/.{1,2}/g) ?? [];
    const grouped = bytes.map((b, j) => (j > 0 && j % 4 === 0 ? ` ${b}` : b)).join(' ');
    lines.push(`${(i / 2).toString(16).padStart(6, '0')}  ${grouped}`);
  }
  return lines.join('\n');
}
