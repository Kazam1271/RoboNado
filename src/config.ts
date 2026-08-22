/**
 * Which chain RoboNado is pointed at.
 *
 * Defaults to testnet. Selecting mainnet has to be a deliberate act — an
 * unset or misspelt variable must never silently put real money on the book,
 * so anything unrecognised is an error rather than a fallback.
 */

import type { Network } from './markets.ts';

export const DEFAULT_NETWORK: Network = 'testnet';

export class NetworkConfigError extends Error {
  constructor(value: string) {
    super(
      `NADO_NETWORK is "${value}" — expected "testnet" or "mainnet". ` +
        `Refusing to guess, since one of those trades real money.`,
    );
    this.name = 'NetworkConfigError';
  }
}

/**
 * Reads NADO_NETWORK. Unset means testnet; anything unrecognised throws.
 */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): Network {
  const raw = (env.NADO_NETWORK ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_NETWORK;
  if (raw === 'testnet' || raw === 'mainnet') return raw;
  throw new NetworkConfigError(env.NADO_NETWORK ?? '');
}

/**
 * A banner for the top of any script. Mainnet gets an unmissable one: the
 * failure mode this guards against is running a command you believed was
 * hitting testnet.
 */
export function networkBanner(network: Network): string {
  return network === 'mainnet'
    ? '=== MAINNET — REAL FUNDS === (Ink, chain 57073)'
    : 'testnet (Ink Sepolia, chain 763373)';
}

/** True when an accidental order would cost actual money. */
export function isLive(network: Network): boolean {
  return network === 'mainnet';
}
