/**
 * Order nonce packing.
 *
 * The nonce is a uint64 carrying two unrelated things:
 *   bits 63..20 (44 bits) — recv_time in ms; the matching engine discards the
 *                           order if it arrives after this
 *   bits 19..0  (20 bits) — random, to avoid digest collisions between two
 *                           otherwise identical orders
 *
 * The recv_time half is a liveness control, not a expiry: it bounds how long an
 * order may sit in flight, and is unrelated to the `expiration` field.
 */

import { randomInt } from 'node:crypto';

export const NONCE_RANDOM_BITS = 20n;
const RANDOM_MASK = (1n << NONCE_RANDOM_BITS) - 1n;

/** Default in-flight allowance. Nado's own examples use 50ms. */
export const DEFAULT_RECV_WINDOW_MS = 50;

export interface NonceParts {
  recvTimeMs: bigint;
  random: number;
}

export function buildOrderNonce(
  recvWindowMs: number = DEFAULT_RECV_WINDOW_MS,
  now: number = Date.now(),
): bigint {
  return packOrderNonce({
    recvTimeMs: BigInt(now + recvWindowMs),
    random: randomInt(0, Number(RANDOM_MASK) + 1),
  });
}

export function packOrderNonce({ recvTimeMs, random }: NonceParts): bigint {
  if (recvTimeMs < 0n || recvTimeMs >= 1n << 44n) {
    throw new RangeError('recvTimeMs does not fit in 44 bits');
  }
  if (!Number.isInteger(random) || random < 0 || BigInt(random) > RANDOM_MASK) {
    throw new RangeError(`random must be an integer in 0..${RANDOM_MASK}`);
  }
  return (recvTimeMs << NONCE_RANDOM_BITS) | BigInt(random);
}

export function unpackOrderNonce(nonce: bigint): NonceParts {
  return {
    recvTimeMs: nonce >> NONCE_RANDOM_BITS,
    random: Number(nonce & RANDOM_MASK),
  };
}

/**
 * Nado's docs note that the low 20 bits — not the client `id` field — are the
 * safe way to tell otherwise-identical orders apart, because only the nonce is
 * covered by the order digest.
 */
export function clientTagFromNonce(nonce: bigint): number {
  return unpackOrderNonce(nonce).random;
}
