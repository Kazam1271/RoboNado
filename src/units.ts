/**
 * Fixed-point conversions.
 *
 * Prices and sizes cross the wire as base-10^18 integers in decimal strings.
 * A slip here is never small — it is a factor of ten — so all conversion goes
 * through these helpers rather than inline arithmetic, and nothing uses
 * floating point past the parse step.
 */

export const ONE_X18 = 10n ** 18n;

/**
 * Converts a human decimal ("64123.5") to x18. Takes a string rather than a
 * number so that values beyond IEEE-754's exact integer range, and trailing
 * decimals like 0.1, survive intact.
 */
export function toX18(value: string | number): bigint {
  const s = typeof value === 'number' ? formatNumber(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a decimal number: "${s}"`);
  }

  const negative = s.startsWith('-');
  const [whole, frac = ''] = (negative ? s.slice(1) : s).split('.');
  if (frac.length > 18) {
    throw new RangeError(`"${s}" has more than 18 decimal places`);
  }

  const scaled = BigInt(whole + frac.padEnd(18, '0'));
  return negative ? -scaled : scaled;
}

export function fromX18(value: bigint, decimals = 8): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE_X18;
  const frac = (abs % ONE_X18).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  // Avoid exponential notation, which the regex above would reject.
  return n.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Rounds `value` down to a multiple of `increment`, away from zero for negative
 * values so that a sell size never rounds up into more risk than requested.
 */
export function roundToIncrement(value: bigint, increment: bigint): bigint {
  if (increment <= 0n) throw new RangeError('increment must be positive');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rounded = (abs / increment) * increment;
  return negative ? -rounded : rounded;
}

/**
 * A signed order amount: positive is a buy, negative is a sell. Nado encodes
 * side purely in this sign, so it is worth constructing explicitly — a stray
 * negation silently opens the opposite position.
 */
export function signedAmount(side: 'buy' | 'sell', size: bigint): bigint {
  const abs = size < 0n ? -size : size;
  return side === 'buy' ? abs : -abs;
}

export function sideOf(amount: bigint): 'buy' | 'sell' {
  if (amount === 0n) throw new Error('a zero amount has no side');
  return amount > 0n ? 'buy' : 'sell';
}
