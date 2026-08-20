import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAccount, HEALTH } from '../src/positions.ts';
import type { NadoGateway } from '../src/gateway.ts';
import type { MarketMeta } from '../src/markets.ts';
import { toX18, fromX18 } from '../src/units.ts';

const x18 = (v: string) => toX18(v).toString();

/** Minimal market registry — only the fields fetchAccount reads. */
const markets = new Map<string, MarketMeta>([
  ['BTC-PERP', { productId: 2, symbol: 'BTC-PERP', assetClass: 'crypto' } as MarketMeta],
  ['WTI-PERP', { productId: 90, symbol: 'WTI-PERP', assetClass: 'commodity' } as MarketMeta],
]);

function gatewayReturning(raw: unknown): NadoGateway {
  return { query: async () => raw } as unknown as NadoGateway;
}

const flatRisk = (long: string, short: string, longM: string, shortM: string, price: string) => ({
  long_weight_initial_x18: x18(long),
  short_weight_initial_x18: x18(short),
  long_weight_maintenance_x18: x18(longM),
  short_weight_maintenance_x18: x18(shortM),
  price_x18: x18(price),
});

describe('health reporting', () => {
  test('reads the three health weightings in documented order', async () => {
    const account = await fetchAccount(
      gatewayReturning({
        exists: true,
        subaccount: '0xabc',
        healths: [
          { assets: x18('40000'), liabilities: '0', health: x18('40000') },
          { assets: x18('45000'), liabilities: '0', health: x18('45000') },
          { assets: x18('50000'), liabilities: '0', health: x18('50000') },
        ],
        spot_balances: [],
        perp_balances: [],
        spot_products: [],
        perp_products: [],
      }),
      '0xabc',
      markets,
    );

    assert.equal(fromX18(account.health.initial), '40000');
    assert.equal(fromX18(account.health.maintenance), '45000');
    assert.equal(fromX18(account.health.pnl), '50000');
    assert.equal(HEALTH.INITIAL, 0);
  });

  test('an idle account reports zero utilisation', async () => {
    const account = await fetchAccount(
      gatewayReturning({
        exists: true,
        subaccount: '0xabc',
        healths: Array(3).fill({ assets: x18('50'), liabilities: '0', health: x18('50') }),
        spot_balances: [{ product_id: 0, balance: { amount: x18('50') } }],
        perp_balances: [],
        spot_products: [{ product_id: 0, risk: flatRisk('1', '1', '1', '1', '1') }],
        perp_products: [],
      }),
      '0xabc',
      markets,
    );

    assert.equal(account.marginUtilisation, 0);
    assert.equal(account.positions.length, 0);
    assert.equal(fromX18(account.spot[0].valueX18), '50');
  });
});

describe('perp positions', () => {
  /**
   * Nado's documented short example: 5 BTC-perps shorted at $10,000 with the
   * mark still at $10,000, so v_quote is the +$50,000 received on opening.
   */
  const shortBtc = {
    exists: true,
    subaccount: '0xabc',
    healths: [
      { assets: '0', liabilities: '0', health: x18('45000') },
      { assets: '0', liabilities: '0', health: x18('47500') },
      { assets: '0', liabilities: '0', health: x18('50000') },
    ],
    spot_balances: [],
    perp_balances: [
      {
        product_id: 2,
        balance: {
          amount: x18('-5'),
          v_quote_balance: x18('50000'),
          last_cumulative_funding_x18: '0',
        },
      },
    ],
    spot_products: [],
    perp_products: [
      {
        product_id: 2,
        oracle_price_x18: x18('10000'),
        risk: flatRisk('0.9', '1.1', '0.95', '1.05', '10000'),
        state: { cumulative_funding_long_x18: '0', cumulative_funding_short_x18: '0' },
      },
    ],
  };

  test('derives side, entry price and notional', async () => {
    const { positions } = await fetchAccount(gatewayReturning(shortBtc), '0xabc', markets);
    assert.equal(positions.length, 1);

    const p = positions[0];
    assert.equal(p.symbol, 'BTC-PERP');
    assert.equal(p.side, 'short');
    assert.equal(fromX18(p.entryPriceX18), '10000');
    assert.equal(fromX18(p.notionalX18), '50000');
  });

  test('unrealized pnl is zero when mark equals entry', async () => {
    const { positions } = await fetchAccount(gatewayReturning(shortBtc), '0xabc', markets);
    assert.equal(fromX18(positions[0].unrealizedPnlX18), '0');
  });

  test('a short loses as the mark rises', async () => {
    const moved = structuredClone(shortBtc);
    moved.perp_products[0].oracle_price_x18 = x18('11000');
    const { positions } = await fetchAccount(gatewayReturning(moved), '0xabc', markets);
    // -5 * 11000 + 50000 = -5000
    assert.equal(fromX18(positions[0].unrealizedPnlX18), '-5000');
  });

  test('a long gains as the mark rises', async () => {
    const longBtc = structuredClone(shortBtc);
    longBtc.perp_balances[0].balance.amount = x18('5');
    longBtc.perp_balances[0].balance.v_quote_balance = x18('-50000');
    longBtc.perp_products[0].oracle_price_x18 = x18('11000');
    const { positions } = await fetchAccount(gatewayReturning(longBtc), '0xabc', markets);
    assert.equal(positions[0].side, 'long');
    // 5 * 11000 - 50000 = 5000
    assert.equal(fromX18(positions[0].unrealizedPnlX18), '5000');
    assert.equal(fromX18(positions[0].entryPriceX18), '10000');
  });

  test('classifies the position by asset class', async () => {
    const wti = structuredClone(shortBtc);
    wti.perp_balances[0].product_id = 90;
    wti.perp_products[0].product_id = 90;
    const { positions } = await fetchAccount(gatewayReturning(wti), '0xabc', markets);
    assert.equal(positions[0].symbol, 'WTI-PERP');
    assert.equal(positions[0].assetClass, 'commodity');
  });
});

describe('liquidation price', () => {
  /** Long 1 BTC at $10,000, $2,000 of collateral, 0.95 maintenance weight. */
  const longWithCollateral = (oracle: string, maintenanceHealth: string) => ({
    exists: true,
    subaccount: '0xabc',
    // Derived from maintenance so the fixture always satisfies
    // initial <= maintenance <= pnl, as a real account must.
    healths: [
      { assets: '0', liabilities: '0', health: (BigInt(maintenanceHealth) / 2n).toString() },
      { assets: '0', liabilities: '0', health: maintenanceHealth },
      { assets: '0', liabilities: '0', health: (BigInt(maintenanceHealth) * 2n).toString() },
    ],
    spot_balances: [],
    perp_balances: [
      {
        product_id: 2,
        balance: {
          amount: x18('1'),
          v_quote_balance: x18('-10000'),
          last_cumulative_funding_x18: '0',
        },
      },
    ],
    spot_products: [],
    perp_products: [
      {
        product_id: 2,
        oracle_price_x18: x18(oracle),
        risk: flatRisk('0.9', '1.1', '0.95', '1.05', oracle),
        state: { cumulative_funding_long_x18: '0', cumulative_funding_short_x18: '0' },
      },
    ],
  });

  test('sits below the mark for a long', async () => {
    const { positions } = await fetchAccount(
      gatewayReturning(longWithCollateral('10000', x18('1500'))),
      '0xabc',
      markets,
    );
    const liq = positions[0].liquidationPriceX18;
    assert.ok(liq !== null, 'expected a liquidation price');
    assert.ok(liq! < positions[0].oraclePriceX18, 'long liquidates below the mark');
  });

  test('sits above the mark for a short', async () => {
    const short = structuredClone(longWithCollateral('10000', x18('1500')));
    short.perp_balances[0].balance.amount = x18('-1');
    short.perp_balances[0].balance.v_quote_balance = x18('10000');
    const { positions } = await fetchAccount(gatewayReturning(short), '0xabc', markets);
    const liq = positions[0].liquidationPriceX18;
    assert.ok(liq !== null, 'expected a liquidation price');
    assert.ok(liq! > positions[0].oraclePriceX18, 'short liquidates above the mark');
  });

  test('more collateral pushes a long liquidation further away', async () => {
    const thin = await fetchAccount(
      gatewayReturning(longWithCollateral('10000', x18('1000'))),
      '0xabc',
      markets,
    );
    const fat = await fetchAccount(
      gatewayReturning(longWithCollateral('10000', x18('3000'))),
      '0xabc',
      markets,
    );
    assert.ok(
      fat.positions[0].liquidationPriceX18! < thin.positions[0].liquidationPriceX18!,
      'a healthier account liquidates further from the mark',
    );
  });

  test('is null when there is no position', async () => {
    const account = await fetchAccount(
      gatewayReturning({
        exists: true,
        subaccount: '0xabc',
        healths: Array(3).fill({ assets: '0', liabilities: '0', health: x18('50') }),
        spot_balances: [],
        perp_balances: [{ product_id: 2, balance: { amount: '0', v_quote_balance: '0', last_cumulative_funding_x18: '0' } }],
        spot_products: [],
        perp_products: [],
      }),
      '0xabc',
      markets,
    );
    assert.equal(account.positions.length, 0);
  });
});

describe('health ordering guard', () => {
  test('throws when the weightings arrive out of order', async () => {
    await assert.rejects(
      fetchAccount(
        gatewayReturning({
          exists: true,
          subaccount: '0xabc',
          // initial > maintenance: impossible if the index constants are right
          healths: [
            { assets: '0', liabilities: '0', health: x18('45000') },
            { assets: '0', liabilities: '0', health: x18('40000') },
            { assets: '0', liabilities: '0', health: x18('50000') },
          ],
          spot_balances: [],
          perp_balances: [],
          spot_products: [],
          perp_products: [],
        }),
        '0xabc',
        markets,
      ),
      /health ordering violated/,
    );
  });

  test('accepts equal weightings on a stablecoin-only account', async () => {
    const account = await fetchAccount(
      gatewayReturning({
        exists: true,
        subaccount: '0xabc',
        healths: Array(3).fill({ assets: x18('50'), liabilities: '0', health: x18('50') }),
        spot_balances: [],
        perp_balances: [],
        spot_products: [],
        perp_products: [],
      }),
      '0xabc',
      markets,
    );
    assert.equal(fromX18(account.health.initial), '50');
  });
});
