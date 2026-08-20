/**
 * Reads a subaccount's positions and health off Nado's unified margin engine.
 *
 * This is the question Nado's architecture is uniquely good at answering and
 * that a per-market bot cannot: spot balances, perp positions and borrows all
 * feed one health number, so "can I open this?" and "where do I get
 * liquidated?" depend on the whole account, not the position in front of you.
 */

import type { NadoGateway } from './gateway.ts';
import { classify, type AssetClass, type MarketMeta } from './markets.ts';
import { ONE_X18 } from './units.ts';

/**
 * Index into the `healths` array. Nado reports three weightings of the same
 * account, following the convention its risk engine inherits:
 *
 *   0 INITIAL     — free collateral; gates opening new positions
 *   1 MAINTENANCE — liquidation buffer; below zero the account is liquidatable
 *   2 PNL         — unweighted mark-to-market value
 *
 * With only stablecoin collateral all three are equal (USDT0 carries weight
 * 1.0), so an account must hold a weighted asset for them to diverge.
 */
export const HEALTH = { INITIAL: 0, MAINTENANCE: 1, PNL: 2 } as const;

const mulX18 = (a: bigint, b: bigint) => (a * b) / ONE_X18;
const divX18 = (a: bigint, b: bigint) => (a * ONE_X18) / b;

export interface Health {
  /** Free collateral. New positions are rejected once this goes negative. */
  initial: bigint;
  /** Liquidation buffer. Below zero the subaccount can be liquidated. */
  maintenance: bigint;
  /** Unweighted account value. */
  pnl: bigint;
}

export interface Position {
  productId: number;
  symbol: string;
  assetClass: AssetClass;
  side: 'long' | 'short';
  /** Signed size, x18. Positive is long. */
  amount: bigint;
  oraclePriceX18: bigint;
  entryPriceX18: bigint;
  notionalX18: bigint;
  unrealizedPnlX18: bigint;
  /** Unsettled funding since this position last settled. Estimate. */
  fundingX18: bigint;
  /** Position notional as a multiple of total account value. */
  leverage: number;
  /**
   * Oracle price at which maintenance health reaches zero, holding the rest of
   * the account constant. Null when an adverse move in this market alone
   * cannot liquidate the account.
   */
  liquidationPriceX18: bigint | null;
}

export interface SpotBalance {
  productId: number;
  amountX18: bigint;
  priceX18: bigint;
  valueX18: bigint;
}

export interface AccountSnapshot {
  exists: boolean;
  sender: string;
  health: Health;
  spot: SpotBalance[];
  positions: Position[];
  /** Total unweighted account value. */
  equityX18: bigint;
  /** Sum of absolute position notionals. */
  grossNotionalX18: bigint;
  /** Fraction of account value consumed as margin. 0 = idle. */
  marginUtilisation: number;
}

interface RawRisk {
  long_weight_initial_x18: string;
  short_weight_initial_x18: string;
  long_weight_maintenance_x18: string;
  short_weight_maintenance_x18: string;
  price_x18: string;
}

interface RawSubaccount {
  exists: boolean;
  subaccount: string;
  healths: { assets: string; liabilities: string; health: string }[];
  spot_balances: { product_id: number; balance: { amount: string } }[];
  perp_balances: {
    product_id: number;
    balance: {
      amount: string;
      v_quote_balance: string;
      last_cumulative_funding_x18: string;
    };
  }[];
  spot_products: { product_id: number; risk: RawRisk }[];
  perp_products: {
    product_id: number;
    oracle_price_x18: string;
    risk: RawRisk;
    state: { cumulative_funding_long_x18: string; cumulative_funding_short_x18: string };
  }[];
}

export async function fetchAccount(
  gateway: NadoGateway,
  sender: string,
  markets: Map<string, MarketMeta>,
): Promise<AccountSnapshot> {
  const raw = await gateway.query<RawSubaccount>('subaccount_info', { subaccount: sender });

  const symbolByProduct = new Map<number, string>();
  for (const m of markets.values()) symbolByProduct.set(m.productId, m.symbol);

  const health: Health = {
    initial: BigInt(raw.healths?.[HEALTH.INITIAL]?.health ?? '0'),
    maintenance: BigInt(raw.healths?.[HEALTH.MAINTENANCE]?.health ?? '0'),
    pnl: BigInt(raw.healths?.[HEALTH.PNL]?.health ?? '0'),
  };

  // Initial is the strictest weighting and pnl the loosest, so a healthy
  // account must satisfy initial <= maintenance <= pnl. A violation means the
  // array order above is wrong, which would silently misreport the liquidation
  // buffer — the one number a risk view must never get wrong. Only weighted
  // assets make these diverge, so this stays quiet on a stablecoin-only
  // account rather than proving anything about it.
  if (health.initial > health.maintenance || health.maintenance > health.pnl) {
    throw new Error(
      `health ordering violated (initial ${health.initial}, maintenance ` +
        `${health.maintenance}, pnl ${health.pnl}) — the HEALTH index constants ` +
        `no longer match what the engine returns`,
    );
  }

  const spotRisk = new Map(raw.spot_products?.map((p) => [p.product_id, p]) ?? []);
  const spot: SpotBalance[] = [];
  for (const b of raw.spot_balances ?? []) {
    const amount = BigInt(b.balance.amount);
    if (amount === 0n) continue;
    const price = BigInt(spotRisk.get(b.product_id)?.risk.price_x18 ?? '0');
    spot.push({
      productId: b.product_id,
      amountX18: amount,
      priceX18: price,
      valueX18: mulX18(amount, price),
    });
  }

  const perpProducts = new Map(raw.perp_products?.map((p) => [p.product_id, p]) ?? []);
  const positions: Position[] = [];
  let grossNotional = 0n;

  for (const b of raw.perp_balances ?? []) {
    const amount = BigInt(b.balance.amount);
    if (amount === 0n) continue;

    const product = perpProducts.get(b.product_id);
    if (!product) continue;

    const oracle = BigInt(product.oracle_price_x18);
    const vQuote = BigInt(b.balance.v_quote_balance);
    const long = amount > 0n;
    const absAmount = long ? amount : -amount;

    const notional = mulX18(absAmount, oracle);
    grossNotional += notional;

    // v_quote is the quote paid (long) or received (short) to open, so entry
    // price is its magnitude per unit of size.
    const entry = absAmount === 0n ? 0n : divX18(vQuote < 0n ? -vQuote : vQuote, absAmount);

    // Mark to market: current value of the size plus the quote leg.
    const unrealized = mulX18(amount, oracle) + vQuote;

    const cumulativeNow = BigInt(
      long
        ? product.state.cumulative_funding_long_x18
        : product.state.cumulative_funding_short_x18,
    );
    const cumulativeLast = BigInt(b.balance.last_cumulative_funding_x18);
    const funding = -mulX18(amount, cumulativeNow - cumulativeLast);

    const maintenanceWeight = BigInt(
      long
        ? product.risk.long_weight_maintenance_x18
        : product.risk.short_weight_maintenance_x18,
    );

    positions.push({
      productId: b.product_id,
      symbol: symbolByProduct.get(b.product_id) ?? `product ${b.product_id}`,
      assetClass: classify(symbolByProduct.get(b.product_id) ?? ''),
      side: long ? 'long' : 'short',
      amount,
      oraclePriceX18: oracle,
      entryPriceX18: entry,
      notionalX18: notional,
      unrealizedPnlX18: unrealized,
      fundingX18: funding,
      leverage: health.pnl === 0n ? 0 : Number(notional) / Number(health.pnl),
      liquidationPriceX18: liquidationPrice(
        amount,
        vQuote,
        maintenanceWeight,
        health.maintenance,
        oracle,
      ),
    });
  }

  return {
    exists: Boolean(raw.exists),
    sender,
    health,
    spot,
    positions,
    equityX18: health.pnl,
    grossNotionalX18: grossNotional,
    marginUtilisation:
      health.pnl <= 0n ? 0 : 1 - Number(health.initial) / Number(health.pnl),
  };
}

/**
 * Price at which maintenance health hits zero for this position.
 *
 * Maintenance health is the rest of the account plus this position's
 * contribution, amount * P * weight + vQuote. Removing the contribution at the
 * current oracle gives the rest, then solving for the P that drives the total
 * to zero gives the liquidation price.
 *
 * Returns null when the answer is non-positive, or sits the wrong side of the
 * current price — either the account is already unhealthy, or the position is
 * hedged well enough that this market alone cannot liquidate it.
 */
function liquidationPrice(
  amount: bigint,
  vQuote: bigint,
  maintenanceWeight: bigint,
  maintenanceHealth: bigint,
  oracle: bigint,
): bigint | null {
  if (amount === 0n) return null;

  const contribution = mulX18(mulX18(amount, oracle), maintenanceWeight) + vQuote;
  const otherHealth = maintenanceHealth - contribution;

  const denominator = mulX18(amount, maintenanceWeight);
  if (denominator === 0n) return null;

  const price = divX18(-otherHealth - vQuote, denominator);
  if (price <= 0n) return null;

  const plausible = amount > 0n ? price < oracle : price > oracle;
  return plausible ? price : null;
}
