import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppendix,
  decodeAppendix,
  bpsToUnits,
  unitsToBps,
  OrderType,
  TriggerType,
  MAX_BUILDER_FEE_RATE,
  MAX_BUILDER_ID,
} from '../src/appendix.ts';

describe('buildAppendix', () => {
  test('a bare order is version 1 and nothing else', () => {
    assert.equal(buildAppendix(), 1n);
  });

  test('matches the worked example from the Nado docs', () => {
    // Docs: "Order through builder ID 1 with 1bps (10 units) fee"
    const appendix = buildAppendix({
      orderType: OrderType.DEFAULT,
      builderId: 1,
      builderFeeRate: 10,
    });
    const expected = 1n | (10n << 38n) | (1n << 48n);
    assert.equal(appendix, expected);
  });

  test('places each flag in its documented bit position', () => {
    const appendix = buildAppendix({
      orderType: OrderType.POST_ONLY, // 0b11 at bits 9-10
      reduceOnly: true, // bit 11
      isolated: true, // bit 8
      isolatedMarginX6: 250_000_000n, // bits 64-127
      triggerType: TriggerType.TWAP, // 0b10 at bits 12-13
      builderId: 4242, // bits 48-63
      builderFeeRate: 7, // bits 38-47
    });

    assert.deepEqual(decodeAppendix(appendix), {
      version: 1,
      isolated: true,
      orderType: OrderType.POST_ONLY,
      reduceOnly: true,
      triggerType: TriggerType.TWAP,
      builderFeeRate: 7,
      builderId: 4242,
      value: 250_000_000n,
    });
  });

  test('builder fields do not collide with the isolated margin value', () => {
    const withMargin = buildAppendix({
      isolated: true,
      isolatedMarginX6: (1n << 64n) - 1n, // every value bit set
      builderId: MAX_BUILDER_ID,
      builderFeeRate: MAX_BUILDER_FEE_RATE,
    });
    const decoded = decodeAppendix(withMargin);
    assert.equal(decoded.builderId, MAX_BUILDER_ID);
    assert.equal(decoded.builderFeeRate, MAX_BUILDER_FEE_RATE);
    assert.equal(decoded.value, (1n << 64n) - 1n);
  });

  test('round-trips across the full parameter space', () => {
    for (const orderType of [OrderType.DEFAULT, OrderType.IOC, OrderType.FOK, OrderType.POST_ONLY]) {
      for (const triggerType of [TriggerType.NONE, TriggerType.PRICE, TriggerType.TWAP]) {
        for (const reduceOnly of [false, true]) {
          const built = buildAppendix({
            orderType,
            triggerType,
            reduceOnly,
            builderId: 7,
            builderFeeRate: 2,
          });
          const d = decodeAppendix(built);
          assert.equal(d.orderType, orderType);
          assert.equal(d.triggerType, triggerType);
          assert.equal(d.reduceOnly, reduceOnly);
        }
      }
    }
  });
});

describe('buildAppendix validation', () => {
  test('rejects a fee rate with no builder (sequencer error 2118)', () => {
    assert.throws(
      () => buildAppendix({ builderId: 0, builderFeeRate: 5 }),
      /builderFeeRate must be 0/,
    );
  });

  test('rejects a builder ID wider than 16 bits', () => {
    assert.throws(() => buildAppendix({ builderId: MAX_BUILDER_ID + 1 }), RangeError);
  });

  test('rejects a fee rate wider than 10 bits', () => {
    assert.throws(
      () => buildAppendix({ builderId: 1, builderFeeRate: MAX_BUILDER_FEE_RATE + 1 }),
      RangeError,
    );
  });

  test('rejects isolated margin on a cross-margin order', () => {
    assert.throws(
      () => buildAppendix({ isolated: false, isolatedMarginX6: 100n }),
      /isolated is false/,
    );
  });
});

describe('fee rate units', () => {
  test('converts bps to 0.1bps units', () => {
    assert.equal(bpsToUnits(1), 10); // 1bps  = 0.01%
    assert.equal(bpsToUnits(0.2), 2); // 0.2bps = 0.002%
    assert.equal(bpsToUnits(10), 100); // 10bps = 0.1%
  });

  test('rejects a rate finer than the encoding allows', () => {
    assert.throws(() => bpsToUnits(0.05), RangeError);
  });

  test('unitsToBps inverts bpsToUnits', () => {
    for (const bps of [0.1, 0.2, 1, 2.5, 10]) {
      assert.equal(unitsToBps(bpsToUnits(bps)), bps);
    }
  });
});
