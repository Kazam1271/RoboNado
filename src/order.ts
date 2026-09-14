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
import { buildOrderNonce, DEFAULT_RECV_WINDOW_MS } from './nonce.ts';
import {
  orderDigest,
  serializeOrder,
  signOrder,
  type OrderMessage,
} from './signing.ts';
import { fromX18, ONE_X18, roundToIncrement, signedAmount, toX18 } from './units.ts';

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

  const roundedPrice = roundToIncrement(toX18(price), market.priceIncrementX18);
  if (roundedPrice <= 0n) throw new Error('price must be positive');

  // min_size is a notional floor in quote terms, not a base-unit count. Every
  // market reports 100 — including BTC, where 100 BTC would be millions — and
  // the live book carries resting orders of 0.023 XAUT and 0.05 BTC, well under
  // any base-unit reading of the field.
  const notionalX18 = (roundedPrice * roundedSize) / ONE_X18;
  if (notionalX18 < market.minNotionalX18) {
    throw new Error(
      `${size} ${market.symbol} at ${price} is $${fromX18(notionalX18, 2)} notional; ` +
        `the minimum is $${fromX18(market.minNotionalX18, 2)}`,
    );
  }

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

/**
 * Rebuilds a prepared order's nonce — and the digest that covers it — against
 * the current time, leaving price, size, and everything else untouched.
 *
 * The nonce's recv_time is a short liveness window (20s by default; see
 * nonce.ts) bounding how long a *signed* request may sit in flight to the
 * sequencer. It is not meant to survive the gap between preparing an order
 * and a human reading the summary and typing a confirmation back — that
 * routinely takes longer, and PENDING_TTL_MS (5 minutes, in tools.ts) is the
 * actual policy for how long an approval may wait. Call this immediately
 * before signing, not when the order was first built, so the recv window is
 * measured against real submission time rather than however long the order
 * has been sitting prepared.
 */
export function refreshNonce(
  network: Network,
  order: PreparedOrder,
  recvWindowMs: number = DEFAULT_RECV_WINDOW_MS,
  now: number = Date.now(),
): PreparedOrder {
  const message: OrderMessage = { ...order.message, nonce: buildOrderNonce(recvWindowMs, now) };
  return { ...order, message, digest: orderDigest(network, order.productId, message) };
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
