/**
 * Which chain RoboNado is pointed at.
 *
 * Defaults to testnet. Selecting mainnet has to be a deliberate act — an
 * unset or misspelt variable must never silently put real money on the book,
 * so anything unrecognised is an error rather than a fallback.
 */

import type { AssetClass, Network } from './markets.ts';
import { DEFAULT_POLICY, type RiskPolicy } from './policy.ts';

export const DEFAULT_NETWORK: Network = 'testnet';

const KNOWN_ASSET_CLASSES: readonly AssetClass[] = ['crypto', 'commodity', 'fx', 'equity'];

export class AssetClassConfigError extends Error {
  constructor(value: string, bad: string[]) {
    super(
      `ROBONADO_ASSET_CLASSES is "${value}" — unrecognised: ${bad.join(', ')}. ` +
        `Expected a comma-separated list from: ${KNOWN_ASSET_CLASSES.join(', ')}.`,
    );
    this.name = 'AssetClassConfigError';
  }
}

/**
 * Reads ROBONADO_ASSET_CLASSES and returns a policy narrowed to it, or
 * {@link DEFAULT_POLICY} unchanged when unset — which trades every asset
 * class Nado lists. An operator who wants a narrower mandate (crypto
 * excluded, say) sets this rather than editing policy.ts, mirroring how
 * {@link resolveNetwork} keeps the network choice out of code too.
 */
export function resolveAssetClasses(
  env: NodeJS.ProcessEnv = process.env,
  basePolicy: RiskPolicy = DEFAULT_POLICY,
): RiskPolicy {
  const raw = (env.ROBONADO_ASSET_CLASSES ?? '').trim();
  if (!raw) return basePolicy;

  const requested = raw.split(',').map((s) => s.trim().toLowerCase());
  const bad = requested.filter((c) => !KNOWN_ASSET_CLASSES.includes(c as AssetClass));
  if (bad.length) throw new AssetClassConfigError(raw, bad);

  return { ...basePolicy, allowedAssetClasses: requested };
}

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
