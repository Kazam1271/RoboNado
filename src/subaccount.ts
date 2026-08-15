/**
 * Subaccount identifiers.
 *
 * Nado identifies a trading compartment by a bytes32:
 *   20 bytes wallet address ++ 12 bytes UTF-8 subaccount name, zero-padded.
 *
 * Getting this wrong produces a well-formed signature over the wrong sender,
 * which the sequencer rejects with an opaque signature error — so it is worth
 * encoding and decoding explicitly rather than string-concatenating at call
 * sites.
 */

import { getAddress, isAddress } from 'viem';

export const SUBACCOUNT_NAME_BYTES = 12;
export const DEFAULT_SUBACCOUNT_NAME = 'default';

export interface Subaccount {
  owner: `0x${string}`;
  name: string;
}

/** Encodes `owner` + `name` into the bytes32 hex the API calls `sender`. */
export function toSubaccountHex(
  owner: string,
  name: string = DEFAULT_SUBACCOUNT_NAME,
): `0x${string}` {
  if (!isAddress(owner)) {
    throw new Error(`not a valid address: ${owner}`);
  }

  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > SUBACCOUNT_NAME_BYTES) {
    throw new RangeError(
      `subaccount name "${name}" is ${nameBytes.length} bytes; the field holds ${SUBACCOUNT_NAME_BYTES}`,
    );
  }

  const padded = new Uint8Array(SUBACCOUNT_NAME_BYTES);
  padded.set(nameBytes);
  const nameHex = [...padded].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Lowercased: the sequencer compares these as raw bytes, and a checksummed
  // address would still be the same bytes, but keeping one canonical form makes
  // equality checks in our own code safe.
  return `0x${owner.slice(2).toLowerCase()}${nameHex}`;
}

/** Inverse of {@link toSubaccountHex}. Trailing zero padding is stripped. */
export function fromSubaccountHex(hex: string): Subaccount {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length !== 64) {
    throw new Error(`subaccount must be 32 bytes (64 hex chars), got ${raw.length}`);
  }

  const owner = getAddress(`0x${raw.slice(0, 40)}`);
  const nameBytes = Uint8Array.from(
    raw
      .slice(40)
      .match(/.{2}/g)!
      .map((b) => parseInt(b, 16)),
  );

  let end = nameBytes.length;
  while (end > 0 && nameBytes[end - 1] === 0) end--;

  return { owner, name: new TextDecoder().decode(nameBytes.subarray(0, end)) };
}
