/**
 * Composes a signed, validated order from trading intent.
 *
 * This is the one place that knows how the pieces fit: guards run before
 * anything is signed, increments are applied before the digest is computed, and
 * the builder code is attached from asset-class policy rather than passed in ad
 * hoc.
 */

import type { Account } from 'viem';

import { buildAppendix, OrderType, type AppendixParams } from './appendix.ts';
import { assertTradable, builderFeeUnitsFor, type Intent } from './guards.ts';
import type { MarketMeta, Network } from './markets.ts';
import { buildOrderNonce } from './nonce.ts';
import {
  orderDigest,
  serializeOrder,
  signOrder,
  type OrderMessage,
} from './signing.ts';
import { roundToIncrement, signedAmount, toX18 } from './units.ts';

/** Orders expire at this many seconds from now unless told otherwise. */
export const DEFAULT_EXPIRATION_SECONDS = 60 * 60;

export interface BuildOrderParams {
  market: MarketMeta;
  sender: `0x${string}`;
  side: 'buy' | 'sell';
  /** Size in the market's base units, as a decimal string. */
  size: string;
  /** Limit price as a decimal string. */
  price: string;
  intent?: Intent;
  orderType?: OrderType;
  reduceOnly?: boolean;
  /** Margin to move to the isolated subaccount, x6. Required for FX markets. */
  isolatedMarginX6?: bigint;
  expirationSeconds?: number;
  /** 0 leaves the order unattributed — the default until an ID is issued. */
  builderId?: number;
  now?: number;
}

export interface PreparedOrder {
  productId: number;
  symbol: string;
  message: OrderMessage;
  appendix: bigint;
  digest: `0x${string}`;
  /** What the builder fee costs on this order, in quote units. */
  builderFeeQuote: string;
}

export function buildOrder(network: Network, params: BuildOrderParams): PreparedOrder {
  const {
    market,
    sender,
    side,
    size,
    price,
    intent = 'open',
    orderType = OrderType.DEFAULT,
    reduceOnly = false,
    isolatedMarginX6,
    expirationSeconds = DEFAULT_EXPIRATION_SECONDS,
    builderId = 0,
    now = Date.now(),
  } = params;

  // Refuse before signing rather than after rejection — the sequencer's error
  // for a closed market is a bare code with no explanation to pass to a user.
  assertTradable(market, intent);

  if (market.isolatedOnly && isolatedMarginX6 === undefined) {
    throw new Error(
      `${market.symbol} accepts isolated-margin orders only; supply isolatedMarginX6.`,
    );
  }

  const rawSize = toX18(size);
  if (rawSize <= 0n) throw new Error('size must be positive; side sets the direction');

  const roundedSize = roundToIncrement(rawSize, market.sizeIncrement);
  if (roundedSize === 0n) {
    throw new Error(
      `size ${size} rounds to zero at ${market.symbol}'s increment; the minimum is larger`,
    );
  }
  if (roundedSize < market.minSize) {
    throw new Error(
      `size ${size} is below ${market.symbol}'s minimum order size`,
    );
  }

  const roundedPrice = roundToIncrement(toX18(price), market.priceIncrementX18);
  if (roundedPrice <= 0n) throw new Error('price must be positive');

  const appendixParams: AppendixParams = {
    orderType,
    reduceOnly,
    isolated: market.isolatedOnly,
    isolatedMarginX6: market.isolatedOnly ? isolatedMarginX6 : undefined,
    builderId,
    builderFeeRate: builderId === 0 ? 0 : builderFeeUnitsFor(market),
  };

  const appendix = buildAppendix(appendixParams);
  const message: OrderMessage = {
    sender,
    priceX18: roundedPrice,
    amount: signedAmount(side, roundedSize),
    expiration: BigInt(Math.floor(now / 1000) + expirationSeconds),
    nonce: buildOrderNonce(undefined, now),
    appendix,
  };

  return {
    productId: market.productId,
    symbol: market.symbol,
    message,
    appendix,
    digest: orderDigest(network, market.productId, message),
    builderFeeQuote: estimateBuilderFee(roundedPrice, roundedSize, appendixParams.builderFeeRate ?? 0),
  };
}

/**
 * builder_fee = price * |amount| * rate, with the rate in 0.1bps units
 * (1e-5 per unit). Both price and amount are x18, so the product carries 36
 * decimals and is scaled back down once.
 */
function estimateBuilderFee(priceX18: bigint, sizeX18: bigint, rateUnits: number): string {
  if (rateUnits === 0) return '0';
  const notionalX18 = (priceX18 * sizeX18) / 10n ** 18n;
  const feeX18 = (notionalX18 * BigInt(rateUnits)) / 100_000n;
  const whole = feeX18 / 10n ** 18n;
  const frac = (feeX18 % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

export async function signPreparedOrder(
  account: Account,
  network: Network,
  order: PreparedOrder,
) {
  const signature = await signOrder(account, network, order.productId, order.message);
  return {
    place_order: {
      product_id: order.productId,
      order: serializeOrder(order.message),
      signature,
    },
  };
}
