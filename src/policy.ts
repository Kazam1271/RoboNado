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
  /** Markets the copilot may trade. Empty means the non-crypto planes only. */
  allowedAssetClasses: string[];
}

/**
 * Deliberately conservative. These are the limits for an agent trading
 * unsupervised on someone's behalf, not the limits of what the venue permits.
 */
export const DEFAULT_POLICY: RiskPolicy = {
  maxOrderNotionalX18: 500n * ONE_X18,
  maxGrossNotionalX18: 2_000n * ONE_X18,
  maxLeverage: 3,
  minFreeCollateralRatio: 0.2,
  allowedAssetClasses: ['commodity', 'fx', 'equity'],
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

  const projectedGross = account.grossNotionalX18 + notionalX18;
  if (projectedGross > policy.maxGrossNotionalX18) {
    throw new PolicyViolation(
      'maxGrossNotional',
      `this would take total exposure to ${usd(projectedGross)}, over the ` +
        `${usd(policy.maxGrossNotionalX18)} limit.`,
    );
  }

  if (account.equityX18 > 0n) {
    const projectedLeverage = Number(projectedGross) / Number(account.equityX18);
    if (projectedLeverage > policy.maxLeverage) {
      throw new PolicyViolation(
        'maxLeverage',
        `this would put you at ${projectedLeverage.toFixed(1)}x against ` +
          `${usd(account.equityX18)} of equity; the limit is ${policy.maxLeverage}x.`,
      );
    }

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
