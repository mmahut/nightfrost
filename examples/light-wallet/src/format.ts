export const NATIVE_TOKEN = '0'.repeat(64);
const STAR_PER_NIGHT = 1_000_000n;

export function isNativeToken(tokenType: string): boolean {
  return tokenType.toLowerCase().replace(/^0x/, '') === NATIVE_TOKEN;
}

export function formatNight(star: string): string {
  try {
    let value = BigInt(star);
    const sign = value < 0n ? '-' : '';
    if (value < 0n) value = -value;
    const whole = value / STAR_PER_NIGHT;
    const fraction = (value % STAR_PER_NIGHT).toString().padStart(6, '0');
    return `${sign}${groupDigits(whole.toString())}.${fraction}`;
  } catch {
    return star;
  }
}

export function formatRawAmount(value: string): string {
  return /^\d+$/.test(value) ? groupDigits(value) : value;
}

export function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function truncate(value: string, head = 10, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatTime(ms: number): string {
  return DATE_FORMAT.format(new Date(ms));
}
