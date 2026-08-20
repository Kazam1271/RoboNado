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

/**
 * How long an order may stay in flight before the engine discards it.
 *
 * Nado's docs use 50ms, which suits a bot colocated with the sequencer in
 * Tokyo and fails immediately (error 2011 LateRecvExecution) from anywhere
 * else — the request is stale before it lands. The engine accepts any
 * recv_time up to 100s ahead, rejecting beyond that with 2012
 * EarlyRecvExecution, so this sits well inside the band while tolerating a
 * slow or distant connection.
 */
export const DEFAULT_RECV_WINDOW_MS = 20_000;

/** The engine rejects recv_time more than this far ahead (error 2012). */
export const MAX_RECV_WINDOW_MS = 100_000;

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
