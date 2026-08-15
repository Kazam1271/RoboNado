/**
 * Pre-flight checks that a crypto-native trading bot does not need, but that
 * every order on the commodity / FX / equity planes does.
 *
 * These exist because the failure modes are silent or confusing otherwise: an
 * FX order placed on a Saturday, or with cross margin, is rejected by the
 * sequencer with a bare error code.
 */

import type { AssetClass, MarketMeta } from './markets.ts';
import { bpsToUnits } from './appendix.ts';

export type Intent = 'open' | 'close';

export class MarketClosedError extends Error {
  market: MarketMeta;

  constructor(market: MarketMeta, message: string) {
    super(message);
    this.name = 'MarketClosedError';
    this.market = market;
  }
}

/**
 * Throws unless `market` will accept an order with this intent right now.
 *
 * `soft_reduce_only` is the one that matters most in practice: it is how FX
 * markets spend every weekend, and it still permits closing an existing
 * position, so the copilot should offer that rather than refusing outright.
 */
export function assertTradable(market: MarketMeta, intent: Intent): void {
  const { symbol, tradingStatus, assetClass } = market;

  switch (tradingStatus) {
    case 'live':
      return;

    case 'post_only':
      // Tradable either way, but the caller must send OrderType.POST_ONLY.
      return;

    case 'soft_reduce_only':
    case 'reduce_only':
      if (intent === 'close') return;
      throw new MarketClosedError(
        market,
        assetClass === 'fx'
          ? `${symbol} is closed for new positions — FX follows real market hours ` +
            `and is reduce-only outside them. You can still close an existing position.`
          : `${symbol} is reduce-only right now. You can close an existing ` +
            `position but not open a new one.`,
      );

    case 'not_tradable':
      throw new MarketClosedError(market, `${symbol} is not currently tradable.`);

    default:
      throw new MarketClosedError(
        market,
        `${symbol} has an unrecognised trading status "${tradingStatus}"; refusing to trade.`,
      );
  }
}

/**
 * FX markets must be traded with isolated margin. Sending a cross-margin order
 * to one is rejected, so callers need to know before signing.
 */
export function requiresIsolatedMargin(market: MarketMeta): boolean {
  return market.isolatedOnly;
}

/**
 * Builder fee ceilings, per asset class, expressed in bps.
 *
 * These are deliberately not one flat number. Nado's own taker fee on FX is
 * 0.7bps against 3.5bps on everything else, so a 1bps builder fee — unremarkable
 * on a crypto perp — would more than double what an FX trader pays to trade.
 * Charging it would make the product uncompetitive precisely in the markets
 * this bot exists to serve.
 */
export const BUILDER_FEE_BPS: Record<AssetClass, number> = {
  fx: 0.2,
  commodity: 1,
  equity: 1,
  crypto: 1,
};

export function builderFeeUnitsFor(market: MarketMeta): number {
  return bpsToUnits(BUILDER_FEE_BPS[market.assetClass]);
}

/**
 * What the builder fee costs the user relative to Nado's own taker fee, as a
 * ratio. Useful as a sanity check when tuning {@link BUILDER_FEE_BPS}: anything
 * much above ~0.3 means we are a material part of the user's cost to trade.
 */
export function builderFeeBurden(market: MarketMeta): number {
  const takerBps = Number(market.takerFeeRateX18) / 1e18 * 10_000;
  return BUILDER_FEE_BPS[market.assetClass] / takerBps;
}
