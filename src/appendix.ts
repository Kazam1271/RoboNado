/**
 * Nado order `appendix` encoding — a bit-packed 128-bit integer carrying order
 * flags, isolated margin, and the builder code that attributes the trade to us.
 *
 * Layout (LSB → MSB), per docs.nado.xyz/developer-resources/api/order-appendix:
 *
 *   | value   | builder | builder fee rate | reserved | trigger | reduce only | order type | isolated | version |
 *   | 64 bits | 16 bits | 10 bits          | 24 bits  | 2 bits  | 1 bit       | 2 bits     | 1 bit    | 8 bits  |
 *   | 127..64 | 63..48  | 47..38           | 37..14   | 13..12  | 11          | 10..9      | 8        | 7..0    |
 */

export const APPENDIX_VERSION = 1n;

// Declared as const objects rather than `enum` so the sources stay erasable
// TypeScript and run directly under `node --test` with no build step.
export const OrderType = {
  DEFAULT: 0,
  IOC: 1,
  FOK: 2,
  POST_ONLY: 3,
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const TriggerType = {
  NONE: 0,
  PRICE: 1,
  TWAP: 2,
  TWAP_CUSTOM_AMOUNTS: 3,
} as const;
export type TriggerType = (typeof TriggerType)[keyof typeof TriggerType];

/** builder_fee_rate is 10 bits → 0..1023 units of 0.1bps (max 1.023%). */
export const MAX_BUILDER_FEE_RATE = 1023;
/** builder is 16 bits; 0 means "no builder". */
export const MAX_BUILDER_ID = 65535;

/** Builder fee rates are expressed in 0.1bps units: 1 unit = 0.001%. */
export function bpsToUnits(bps: number): number {
  const units = bps * 10;
  if (!Number.isInteger(units)) {
    throw new RangeError(
      `builder fee of ${bps}bps is not representable; the smallest step is 0.1bps`,
    );
  }
  return units;
}

export function unitsToBps(units: number): number {
  return units / 10;
}

export interface AppendixParams {
  orderType?: OrderType;
  reduceOnly?: boolean;
  isolated?: boolean;
  /** Margin moved to the isolated subaccount on first match, in x6 precision. */
  isolatedMarginX6?: bigint;
  triggerType?: TriggerType;
  /** Our registered builder ID. 0 (or omitted) routes the order unattributed. */
  builderId?: number;
  /** Fee rate in 0.1bps units. Must be 0 when builderId is 0. */
  builderFeeRate?: number;
}

export function buildAppendix(params: AppendixParams = {}): bigint {
  const {
    orderType = OrderType.DEFAULT,
    reduceOnly = false,
    isolated = false,
    isolatedMarginX6 = 0n,
    triggerType = TriggerType.NONE,
    builderId = 0,
    builderFeeRate = 0,
  } = params;

  if (!Number.isInteger(builderId) || builderId < 0 || builderId > MAX_BUILDER_ID) {
    throw new RangeError(`builderId must be an integer in 0..${MAX_BUILDER_ID}`);
  }
  if (
    !Number.isInteger(builderFeeRate) ||
    builderFeeRate < 0 ||
    builderFeeRate > MAX_BUILDER_FEE_RATE
  ) {
    throw new RangeError(
      `builderFeeRate must be an integer in 0..${MAX_BUILDER_FEE_RATE} (0.1bps units)`,
    );
  }
  // Mirrors Nado's own validation — sending this combination earns error 2118
  // (InvalidBuilder) from the sequencer rather than a useful message.
  if (builderId === 0 && builderFeeRate > 0) {
    throw new Error('builderFeeRate must be 0 when no builderId is set');
  }
  if (isolatedMarginX6 < 0n || isolatedMarginX6 >= 1n << 64n) {
    throw new RangeError('isolatedMarginX6 must fit in 64 unsigned bits');
  }
  if (!isolated && isolatedMarginX6 > 0n) {
    throw new Error('isolatedMarginX6 was supplied but isolated is false');
  }

  let appendix = APPENDIX_VERSION;
  if (isolated) appendix |= 1n << 8n;
  appendix |= BigInt(orderType & 0b11) << 9n;
  if (reduceOnly) appendix |= 1n << 11n;
  appendix |= BigInt(triggerType & 0b11) << 12n;
  appendix |= BigInt(builderFeeRate) << 38n;
  appendix |= BigInt(builderId) << 48n;
  if (isolated && isolatedMarginX6 > 0n) appendix |= isolatedMarginX6 << 64n;

  return appendix;
}

export interface DecodedAppendix {
  version: number;
  isolated: boolean;
  orderType: OrderType;
  reduceOnly: boolean;
  triggerType: TriggerType;
  builderFeeRate: number;
  builderId: number;
  value: bigint;
}

/** Inverse of {@link buildAppendix}, for asserting what we actually signed. */
export function decodeAppendix(appendix: bigint): DecodedAppendix {
  return {
    version: Number(appendix & 0xffn),
    isolated: ((appendix >> 8n) & 1n) === 1n,
    orderType: Number((appendix >> 9n) & 0b11n) as OrderType,
    reduceOnly: ((appendix >> 11n) & 1n) === 1n,
    triggerType: Number((appendix >> 12n) & 0b11n) as TriggerType,
    builderFeeRate: Number((appendix >> 38n) & 0x3ffn),
    builderId: Number((appendix >> 48n) & 0xffffn),
    value: (appendix >> 64n) & ((1n << 64n) - 1n),
  };
}
