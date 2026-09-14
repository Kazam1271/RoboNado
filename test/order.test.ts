import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildOrder, refreshNonce, type PreparedOrder } from '../src/order.ts';
import { MarketClosedError } from '../src/guards.ts';
import { unpackOrderNonce } from '../src/nonce.ts';
import { toSubaccountHex } from '../src/subaccount.ts';
import { toX18 } from '../src/units.ts';
import type { MarketMeta } from '../src/markets.ts';

const sender = toSubaccountHex('0x7a5ec2748e9065794491a8d29dcf3f9edb8d7c43');

const market = (overrides: Partial<MarketMeta> = {}): MarketMeta =>
  ({
    productId: 90,
    symbol: 'WTI-PERP',
    name: 'Crude Oil',
    assetClass: 'commodity',
    isolatedOnly: false,
    tradingStatus: 'live',
    priceIncrementX18: toX18('0.01'),
    sizeIncrement: toX18('0.001'),
    minNotionalX18: toX18('100'),
    makerFeeRateX18: 0n,
    takerFeeRateX18: 0n,
    ...overrides,
  }) as MarketMeta;

describe('buildOrder', () => {
  test('rounds price and size to the market increment', () => {
    const prepared = buildOrder('testnet', {
      market: market(),
      sender,
      side: 'buy',
      size: '100.0007',
      price: '58.004',
    });
    assert.equal(prepared.message.priceX18, toX18('58')); // truncates to the 0.01 increment
    assert.equal(prepared.message.amount, toX18('100')); // truncates to the 0.001 increment, positive for buy
  });

  test('refuses a size that would round to zero at the increment', () => {
    assert.throws(
      () => buildOrder('testnet', { market: market(), sender, side: 'buy', size: '0.0001', price: '58' }),
      /rounds to zero/,
    );
  });

  test('refuses notional under the market minimum', () => {
    assert.throws(
      () => buildOrder('testnet', { market: market(), sender, side: 'buy', size: '1', price: '58' }),
      /minimum is \$100/,
    );
  });

  test('refuses a closed market before signing anything', () => {
    assert.throws(
      () =>
        buildOrder('testnet', {
          market: market({ tradingStatus: 'not_tradable' }),
          sender,
          side: 'buy',
          size: '100',
          price: '58',
        }),
      MarketClosedError,
    );
  });

  test('an isolated-only market without margin is refused', () => {
    assert.throws(
      () =>
        buildOrder('testnet', {
          market: market({ isolatedOnly: true }),
          sender,
          side: 'buy',
          size: '100',
          price: '58',
        }),
      /isolated-margin orders only/,
    );
  });
});

describe('refreshNonce', () => {
  const original = buildOrder('testnet', {
    market: market(),
    sender,
    side: 'buy',
    size: '100',
    price: '58',
    now: 1_000_000,
  });

  test('rebuilds the nonce against a new time, not the original prepare time', () => {
    const fresh = refreshNonce('testnet', original, 20_000, 2_000_000);
    assert.equal(unpackOrderNonce(fresh.message.nonce).recvTimeMs, 2_020_000n);
    assert.notEqual(fresh.message.nonce, original.message.nonce);
  });

  test('the digest changes along with the nonce it covers', () => {
    const fresh = refreshNonce('testnet', original, 20_000, 2_000_000);
    assert.notEqual(fresh.digest, original.digest);
  });

  test('price, size, appendix and every other field are untouched', () => {
    const fresh = refreshNonce('testnet', original, 20_000, 2_000_000);
    assert.equal(fresh.message.priceX18, original.message.priceX18);
    assert.equal(fresh.message.amount, original.message.amount);
    assert.equal(fresh.message.sender, original.message.sender);
    assert.equal(fresh.message.expiration, original.message.expiration);
    assert.equal(fresh.appendix, original.appendix);
    assert.equal(fresh.productId, original.productId);
    assert.equal(fresh.symbol, original.symbol);
    assert.equal(fresh.builderFeeQuote, original.builderFeeQuote);
  });

  test('defaults to the standard recv window and the current clock', () => {
    const before = Date.now();
    const fresh = refreshNonce('testnet', original);
    const after = Date.now();
    const recvTime = Number(unpackOrderNonce(fresh.message.nonce).recvTimeMs);
    // Should land at "now + 20s" for whatever "now" was during the call.
    assert.ok(recvTime >= before + 20_000 && recvTime <= after + 20_000);
  });

  test('a wide gap between prepare and confirm no longer produces a stale nonce', () => {
    // The scenario this exists for: an order prepared at t=0 isn't signed
    // until a human confirms it four minutes later — well past the ~20s
    // recv window baked in at prepare time, but still inside the 5-minute
    // app-level approval TTL (tools.ts's PENDING_TTL_MS).
    const preparedAt = 0;
    const confirmedAt = 4 * 60 * 1000;
    const stale = buildOrder('testnet', { market: market(), sender, side: 'buy', size: '100', price: '58', now: preparedAt });
    const fresh: PreparedOrder = refreshNonce('testnet', stale, 20_000, confirmedAt);
    assert.equal(unpackOrderNonce(fresh.message.nonce).recvTimeMs, BigInt(confirmedAt + 20_000));
    // A sequencer checking "did this arrive before recv_time" against
    // confirmedAt would have rejected the stale nonce and accepts the fresh one.
    assert.ok(unpackOrderNonce(stale.message.nonce).recvTimeMs < BigInt(confirmedAt));
    assert.ok(unpackOrderNonce(fresh.message.nonce).recvTimeMs > BigInt(confirmedAt));
  });
});
