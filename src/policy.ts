/**
 * Risk limits enforced in code, never in the prompt.
 *
 * A language model decides what to propose; this file decides what is allowed.
 * That separation is the whole safety design: prompt instructions can be argued
 * with, talked around, or forgotten mid-conversation, and a jailbroken system
 * prompt must not be able to move money. Every order passes through here
 * regardless of how convincing the reasoning that produced it was.
 */

import type { AccountSnapshot } from './positions.ts';
import type { MarketMeta } from './markets.ts';
import { ONE_X18, fromX18 } from './units.ts';

export interface RiskPolicy {
  /** Largest single order, in quote terms. */
  maxOrderNotionalX18: bigint;
  /** Largest total exposure across all positions, in quote terms. */
  maxGrossNotionalX18: bigint;
  /** Gross notional as a multiple of account equity. */
  maxLeverage: number;
  /** Refuse to open when initial health would fall below this fraction of equity. */
  minFreeCollateralRatio: number;
  /** Markets the copilot may trade. Empty means nothing is tradable. */
  allowedAssetClasses: string[];
}

/**
 * Deliberately conservative. These are the limits for an agent trading
 * unsupervised on someone's behalf, not the limits of what the venue permits.
 *
 * All four asset classes are enabled — RoboNado is a copilot for the whole
 * venue, not a subset of it. An operator who wants a narrower mandate (crypto
 * excluded, say) sets `ROBONADO_ASSET_CLASSES` rather than editing this file.
 */
export const DEFAULT_POLICY: RiskPolicy = {
  maxOrderNotionalX18: 500n * ONE_X18,
  maxGrossNotionalX18: 2_000n * ONE_X18,
  maxLeverage: 3,
  minFreeCollateralRatio: 0.2,
  allowedAssetClasses: ['commodity', 'fx', 'equity', 'crypto'],
};

export class PolicyViolation extends Error {
  rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = 'PolicyViolation';
    this.rule = rule;
  }
}

export interface ProposedOrder {
  market: MarketMeta;
  side: 'buy' | 'sell';
  notionalX18: bigint;
  intent: 'open' | 'close';
}

/**
 * Total market exposure across both margin scopes. Cross and isolated
 * notional are each real dollars at risk, so they add directly — unlike
 * leverage, exposure has no scope-mismatch trap to fall into.
 */
export function totalExposure(account: AccountSnapshot): bigint {
  return account.grossNotionalX18 + (account.isolatedNotionalX18 ?? 0n);
}

/**
 * Total capital backing that exposure: cross equity plus every isolated
 * position's own posted margin. The two pools cannot back each other's
 * positions, but both are real money the trader has committed, and a
 * leverage cap is meant to bound risk against all of it — a trader is not
 * meaningfully safer at "3x on the cross book" while sitting on an
 * unrelated 20x isolated position the check never saw.
 *
 * Never divide `totalExposure` by `account.equityX18` alone, or
 * `account.isolatedNotionalX18` by `account.equityX18` alone — either mixes
 * one scope's notional against the other scope's capital and produces a
 * meaningless ratio (this is the mistake the isolated-positions fix in
 * positions.ts had to specifically avoid). Sum the pools on each side first,
 * then divide.
 */
export function totalCapital(account: AccountSnapshot): bigint {
  return account.equityX18 + (account.isolatedMarginX18 ?? 0n);
}

/**
 * Throws unless the proposal is within policy. Closing orders are exempt from
 * the exposure limits — a limit that prevents reducing risk is a bug, and an
 * account that has drifted over its cap must still be able to get back under.
 */
export function assertWithinPolicy(
  proposal: ProposedOrder,
  account: AccountSnapshot,
  policy: RiskPolicy = DEFAULT_POLICY,
): void {
  const { market, notionalX18, intent } = proposal;
  const usd = (v: bigint) => `$${fromX18(v, 2)}`;

  if (!policy.allowedAssetClasses.includes(market.assetClass)) {
    throw new PolicyViolation(
      'allowedAssetClasses',
      `${market.symbol} is ${market.assetClass}; this copilot trades ` +
        `${policy.allowedAssetClasses.join(', ')} only.`,
    );
  }

  if (notionalX18 > policy.maxOrderNotionalX18) {
    throw new PolicyViolation(
      'maxOrderNotional',
      `${usd(notionalX18)} exceeds the ${usd(policy.maxOrderNotionalX18)} single-order limit.`,
    );
  }

  if (intent === 'close') return;

  // Exposure and leverage are checked against cross AND isolated positions
  // together — an isolated position is real market risk the trader carries
  // regardless of which margin pool backs it, and a cap that only ever saw
  // the cross book could be walked straight past by opening isolated
  // positions instead. See totalExposure/totalCapital for why these are
  // summed rather than mixed.
  const projectedGross = totalExposure(account) + notionalX18;
  if (projectedGross > policy.maxGrossNotionalX18) {
    throw new PolicyViolation(
      'maxGrossNotional',
      `this would take total exposure (cross + isolated) to ${usd(projectedGross)}, ` +
        `over the ${usd(policy.maxGrossNotionalX18)} limit.`,
    );
  }

  const capital = totalCapital(account);
  if (capital > 0n) {
    const projectedLeverage = Number(projectedGross) / Number(capital);
    if (projectedLeverage > policy.maxLeverage) {
      throw new PolicyViolation(
        'maxLeverage',
        `this would put you at ${projectedLeverage.toFixed(1)}x against ` +
          `${usd(capital)} of capital (cross equity + isolated margin); ` +
          `the limit is ${policy.maxLeverage}x.`,
      );
    }
  }

  // Free collateral is specifically a cross-account concept — isolated margin
  // is never available to back a cross position, so it must not pad this
  // denominator the way it correctly does for totalCapital above. Guarded on
  // cross equity alone, not `capital`: an account that is all isolated margin
  // and near-zero cross equity must still hit this check rather than divide
  // by a near-zero or negative equityX18.
  if (account.equityX18 > 0n) {
    const freeRatio = Number(account.health.initial) / Number(account.equityX18);
    if (freeRatio < policy.minFreeCollateralRatio) {
      throw new PolicyViolation(
        'minFreeCollateral',
        `free collateral is ${usd(account.health.initial)}, only ` +
          `${(freeRatio * 100).toFixed(0)}% of equity. Close something before opening more.`,
      );
    }
  }
}

/** Human-readable policy, for the system prompt and for `/limits`. */
export function describePolicy(policy: RiskPolicy = DEFAULT_POLICY): string {
  return [
    `max single order: $${fromX18(policy.maxOrderNotionalX18, 0)}`,
    `max total exposure: $${fromX18(policy.maxGrossNotionalX18, 0)}`,
    `max leverage: ${policy.maxLeverage}x`,
    `min free collateral: ${(policy.minFreeCollateralRatio * 100).toFixed(0)}% of equity`,
    `tradable: ${policy.allowedAssetClasses.join(', ')}`,
  ].join('\n');
}
