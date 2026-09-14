import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTradable,
  builderFeeBurden,
  builderFeeUnitsFor,
  requiresIsolatedMargin,
  BUILDER_FEE_BPS,
  MarketClosedError,
} from '../src/guards.ts';
import type { MarketMeta } from '../src/markets.ts';

/** bps -> x18 fee rate, matching how guards.ts reads it back (raw / 1e14 = bps). */
const bpsX18 = (bps: number): bigint => BigInt(Math.round(bps * 1e14));

const market = (overrides: Partial<MarketMeta>): MarketMeta =>
  ({
    productId: 1,
    symbol: 'EURUSD-PERP',
    name: 'Euro',
    assetClass: 'fx',
    isolatedOnly: true,
    tradingStatus: 'live',
    priceIncrementX18: 1n,
    sizeIncrement: 1n,
    minNotionalX18: 1n,
    makerFeeRateX18: bpsX18(0.2),
    takerFeeRateX18: bpsX18(0.7),
    ...overrides,
  }) as MarketMeta;

describe('assertTradable', () => {
  test('permits both intents when live', () => {
    const m = market({ tradingStatus: 'live' });
    assert.doesNotThrow(() => assertTradable(m, 'open'));
    assert.doesNotThrow(() => assertTradable(m, 'close'));
  });

  test('permits both intents when post_only — the caller sets the order type', () => {
    const m = market({ tradingStatus: 'post_only' });
    assert.doesNotThrow(() => assertTradable(m, 'open'));
    assert.doesNotThrow(() => assertTradable(m, 'close'));
  });

  test('reduce-only statuses permit closing but not opening', () => {
    for (const tradingStatus of ['soft_reduce_only', 'reduce_only'] as const) {
      const m = market({ tradingStatus });
      assert.doesNotThrow(() => assertTradable(m, 'close'));
      assert.throws(() => assertTradable(m, 'open'), MarketClosedError);
    }
  });

  test('an FX reduce-only rejection names an estimated reopen time', () => {
    const m = market({ tradingStatus: 'soft_reduce_only', assetClass: 'fx' });
    // Friday 23:00 UTC — one hour after the estimated weekly close.
    const now = new Date('2026-09-18T23:00:00.000Z');
    try {
      assertTradable(m, 'open', now);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof MarketClosedError);
      assert.match(err.message, /should reopen in about/);
      assert.match(err.message, /estimate/);
      assert.match(err.message, /still close an existing position/);
    }
  });

  test('a non-FX reduce-only rejection carries no reopen estimate — the reason is not a schedule', () => {
    const m = market({ tradingStatus: 'reduce_only', assetClass: 'equity', symbol: 'TSLA-PERP' });
    try {
      assertTradable(m, 'open');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof MarketClosedError);
      assert.doesNotMatch(err.message, /reopen/);
      assert.match(err.message, /reduce-only right now/);
    }
  });

  test('not_tradable always refuses, even to close', () => {
    const m = market({ tradingStatus: 'not_tradable' });
    assert.throws(() => assertTradable(m, 'open'), MarketClosedError);
    assert.throws(() => assertTradable(m, 'close'), MarketClosedError);
  });

  test('an unrecognised status refuses rather than guessing', () => {
    const m = market({ tradingStatus: 'something_new' as MarketMeta['tradingStatus'] });
    assert.throws(() => assertTradable(m, 'open'), /unrecognised trading status/);
  });
});

describe('requiresIsolatedMargin', () => {
  test('mirrors the market flag', () => {
    assert.equal(requiresIsolatedMargin(market({ isolatedOnly: true })), true);
    assert.equal(requiresIsolatedMargin(market({ isolatedOnly: false })), false);
  });
});

describe('builder fees', () => {
  test('units follow the asset-class table', () => {
    assert.equal(builderFeeUnitsFor(market({ assetClass: 'fx' })), 2); // 0.2bps = 2 units
    assert.equal(builderFeeUnitsFor(market({ assetClass: 'crypto' })), 10); // 1bps = 10 units
  });

  test('burden is our fee as a share of the venue taker fee', () => {
    // fx: our 0.2bps against a 0.7bps taker fee.
    const fx = market({ assetClass: 'fx', takerFeeRateX18: bpsX18(0.7) });
    const burden = builderFeeBurden(fx)!;
    assert.ok(Math.abs(burden - BUILDER_FEE_BPS.fx / 0.7) < 1e-9);
  });

  test('is null rather than Infinity when the venue charges no taker fee', () => {
    const promo = market({ assetClass: 'crypto', takerFeeRateX18: 0n });
    assert.equal(builderFeeBurden(promo), null);
  });
});
