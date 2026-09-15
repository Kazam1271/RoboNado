import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { MarketMeta } from '../src/markets.ts';
import { resolveMarket, aliasesFor, UnknownMarketError } from '../src/resolve.ts';
import {
  assertWithinPolicy,
  describePolicy,
  DEFAULT_POLICY,
  PolicyViolation,
  type RiskPolicy,
} from '../src/policy.ts';
import type { AccountSnapshot } from '../src/positions.ts';
import { ONE_X18, toX18 } from '../src/units.ts';

const market = (symbol: string, assetClass: MarketMeta['assetClass'], productId = 1) =>
  ({ symbol, assetClass, productId }) as MarketMeta;

const markets = new Map<string, MarketMeta>([
  ['XAUT-PERP', market('XAUT-PERP', 'commodity', 28)],
  ['XAG-PERP', market('XAG-PERP', 'commodity', 88)],
  ['WTI-PERP', market('WTI-PERP', 'commodity', 90)],
  ['EURUSD-PERP', market('EURUSD-PERP', 'fx', 92)],
  ['GBPUSD-PERP', market('GBPUSD-PERP', 'fx', 94)],
  ['TSLA-PERP', market('TSLA-PERP', 'equity', 114)],
  ['PENG-PERP', market('PENG-PERP', 'equity', 162)],
  ['PENGU-PERP', market('PENGU-PERP', 'crypto', 40)],
  ['BTC-PERP', market('BTC-PERP', 'crypto', 2)],
]);

describe('market resolution', () => {
  test('resolves the names traders actually use', () => {
    const cases: [string, string][] = [
      ['gold', 'XAUT-PERP'],
      ['silver', 'XAG-PERP'],
      ['oil', 'WTI-PERP'],
      ['crude', 'WTI-PERP'],
      ['euro', 'EURUSD-PERP'],
      ['cable', 'GBPUSD-PERP'],
      ['sterling', 'GBPUSD-PERP'],
      ['tesla', 'TSLA-PERP'],
    ];
    for (const [query, expected] of cases) {
      assert.equal(resolveMarket(query, markets).market.symbol, expected, query);
    }
  });

  test('is case-insensitive', () => {
    assert.equal(resolveMarket('GOLD', markets).market.symbol, 'XAUT-PERP');
    assert.equal(resolveMarket('Oil', markets).market.symbol, 'WTI-PERP');
  });

  test('accepts exact symbols and bare tickers', () => {
    assert.equal(resolveMarket('XAUT-PERP', markets).via, 'symbol');
    assert.equal(resolveMarket('TSLA', markets).via, 'ticker');
  });

  test('does not confuse Penguin Solutions with Pudgy Penguins', () => {
    // PENG-PERP is an equity, PENGU-PERP is crypto. A fuzzy matcher would
    // happily pick the wrong one, and that is a wrong trade.
    assert.equal(resolveMarket('PENG', markets).market.symbol, 'PENG-PERP');
    assert.equal(resolveMarket('PENGU', markets).market.symbol, 'PENGU-PERP');
    assert.equal(resolveMarket('PENG', markets).market.assetClass, 'equity');
    assert.equal(resolveMarket('PENGU', markets).market.assetClass, 'crypto');
  });

  test('refuses to guess, and suggests instead', () => {
    assert.throws(() => resolveMarket('platinum', markets), UnknownMarketError);
    try {
      resolveMarket('eur', new Map());
    } catch (err) {
      assert.ok(err instanceof UnknownMarketError);
      assert.equal(err.query, 'eur');
    }
  });

  test('reports the aliases pointing at a market', () => {
    const gold = aliasesFor('XAUT-PERP');
    assert.ok(gold.includes('gold'));
    assert.ok(gold.includes('bullion'));
  });
});

const account = (
  equity: string,
  gross: string,
  initial?: string,
  isolated?: { margin: string; notional: string },
): AccountSnapshot =>
  ({
    exists: true,
    sender: '0xabc',
    health: {
      initial: toX18(initial ?? equity),
      maintenance: toX18(equity),
      pnl: toX18(equity),
    },
    spot: [],
    positions: [],
    equityX18: toX18(equity),
    grossNotionalX18: toX18(gross),
    marginUtilisation: 0,
    isolatedMarginX18: toX18(isolated?.margin ?? '0'),
    isolatedNotionalX18: toX18(isolated?.notional ?? '0'),
  }) as AccountSnapshot;

describe('risk policy', () => {
  const healthy = account('1000', '0');

  test('permits an order inside every limit', () => {
    assert.doesNotThrow(() =>
      assertWithinPolicy(
        { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('200'), intent: 'open' },
        healthy,
      ),
    );
  });

  test('blocks a single order over the notional cap', () => {
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('5000'), intent: 'open' },
          healthy,
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'maxOrderNotional',
    );
  });

  test('blocks an order that would breach total exposure', () => {
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('400'), intent: 'open' },
          account('10000', '1900'),
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'maxGrossNotional',
    );
  });

  test('blocks an order that would breach the leverage cap', () => {
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('400'), intent: 'open' },
          account('100', '0'),
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'maxLeverage',
    );
  });

  test('counts isolated exposure toward the total exposure cap', () => {
    // No cross positions at all — a check reading grossNotionalX18 alone
    // would see $0 of exposure and wave a $400 order straight through, even
    // though the account already carries $1900 of real market risk via
    // isolated positions.
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('400'), intent: 'open' },
          account('10000', '0', undefined, { margin: '1000', notional: '1900' }),
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'maxGrossNotional',
    );
  });

  test('counts isolated margin toward the leverage cap\'s capital base', () => {
    // Cross equity alone is tiny, but real capital is mostly sitting as
    // isolated margin. A check dividing by equityX18 alone would read this
    // as absurdly over-leveraged; totalCapital must see the isolated margin
    // as real capital backing real (isolated) exposure.
    assert.doesNotThrow(() =>
      assertWithinPolicy(
        { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('100'), intent: 'open' },
        account('10', '0', undefined, { margin: '990', notional: '1900' }),
      ),
    );
  });

  test('an isolated-only account still can\'t exceed leverage in aggregate', () => {
    // Cross equity is zero — every dollar of capital and every dollar of
    // exposure here is isolated. $1800 notional against $600 margin is
    // already 3x; a further $150 order must still be caught by the leverage
    // cap, not waved through because equityX18 alone reads as zero.
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('150'), intent: 'open' },
          account('0', '0', '0', { margin: '600', notional: '1800' }),
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'maxLeverage',
    );
  });

  test('minFreeCollateral stays scoped to cross equity when isolated margin backs all real capital', () => {
    // Cross equity is 0 (all capital moved to isolated margin), so there is
    // no cross free-collateral ratio to speak of. totalCapital is still
    // positive here (isolated margin), so the leverage check runs and must
    // pass; minFreeCollateral must skip cleanly on zero cross equity rather
    // than divide by it.
    assert.doesNotThrow(() =>
      assertWithinPolicy(
        { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('10'), intent: 'open' },
        account('0', '0', '0', { margin: '1000', notional: '100' }),
      ),
    );
  });

  test('blocks opening when free collateral is exhausted', () => {
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('50'), intent: 'open' },
          account('1000', '100', '50'),
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'minFreeCollateral',
    );
  });

  test('never blocks a close — reducing risk must always be possible', () => {
    // An account far outside every exposure limit must still be able to exit.
    const overexposed = account('100', '99999', '1');
    assert.doesNotThrow(() =>
      assertWithinPolicy(
        { market: markets.get('XAUT-PERP')!, side: 'sell', notionalX18: toX18('400'), intent: 'close' },
        overexposed,
      ),
    );
  });

  test('still caps a single close at the order limit', () => {
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'sell', notionalX18: toX18('99999'), intent: 'close' },
          healthy,
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'maxOrderNotional',
    );
  });

  test('trades every asset class by default, including crypto', () => {
    assert.doesNotThrow(() =>
      assertWithinPolicy(
        { market: markets.get('BTC-PERP')!, side: 'buy', notionalX18: toX18('100'), intent: 'open' },
        healthy,
      ),
    );
  });

  test('refuses asset classes outside a narrowed mandate', () => {
    const nonCryptoOnly: RiskPolicy = {
      ...DEFAULT_POLICY,
      allowedAssetClasses: ['commodity', 'fx', 'equity'],
    };
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('BTC-PERP')!, side: 'buy', notionalX18: toX18('100'), intent: 'open' },
          healthy,
          nonCryptoOnly,
        ),
      (err: unknown) => err instanceof PolicyViolation && err.rule === 'allowedAssetClasses',
    );
  });

  test('honours a tightened custom policy', () => {
    const strict: RiskPolicy = { ...DEFAULT_POLICY, maxOrderNotionalX18: 50n * ONE_X18 };
    assert.throws(
      () =>
        assertWithinPolicy(
          { market: markets.get('XAUT-PERP')!, side: 'buy', notionalX18: toX18('100'), intent: 'open' },
          healthy,
          strict,
        ),
      PolicyViolation,
    );
  });

  test('describes itself for the system prompt', () => {
    const text = describePolicy();
    assert.match(text, /max single order/);
    assert.match(text, /max leverage: 3x/);
  });
});
