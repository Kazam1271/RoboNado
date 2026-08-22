/**
 * Places a real order on Ink Sepolia, reads it back, and optionally cancels it.
 *
 *   npm run trade -- --symbol EURUSD-PERP --side buy --size 100 --price 1.10
 *   npm run trade -- --cancel <digest> --symbol EURUSD-PERP
 *   npm run trade -- --list --symbol EURUSD-PERP
 *
 * Reads NADO_PRIVATE_KEY from the environment. The key is never printed.
 * Defaults to a price far from the book so the order rests instead of filling.
 */

import { privateKeyToAccount } from 'viem/accounts';

import { decodeAppendix, unitsToBps } from '../src/appendix.ts';
import { NadoApiError, NadoGateway } from '../src/gateway.ts';
import { MarketClosedError } from '../src/guards.ts';
import { loadMarkets } from '../src/markets.ts';
import { buildOrder, signPreparedOrder } from '../src/order.ts';
import { buildOrderNonce } from '../src/nonce.ts';
import { serializeCancellation, signCancellation } from '../src/signing.ts';
import { toSubaccountHex } from '../src/subaccount.ts';
import { fromX18 } from '../src/units.ts';
import { resolveNetwork, networkBanner } from '../src/config.ts';

const NETWORK = resolveNetwork();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const key = process.env.NADO_PRIVATE_KEY;
if (!key) {
  console.error('NADO_PRIVATE_KEY is not set.');
  console.error('Put it in .env (already gitignored) and run with:');
  console.error('  node --env-file=.env scripts/trade.ts ...');
  process.exit(1);
}

const account = privateKeyToAccount(key as `0x${string}`);
const sender = toSubaccountHex(account.address, 'default');
const gateway = new NadoGateway(NETWORK);

const symbol = arg('symbol') ?? 'EURUSD-PERP';
const markets = await loadMarkets(NETWORK);
const market = markets.get(symbol);
if (!market) {
  console.error(`${symbol} is not listed on ${NETWORK}`);
  process.exit(1);
}

console.log(`wallet  ${account.address}`);
console.log(`market  ${market.symbol}  (${market.assetClass}, id ${market.productId}, ${market.tradingStatus})\n`);

// ── list ─────────────────────────────────────────────────────────────────────
if (has('list')) {
  const open = await gateway.openOrders(sender, market.productId);
  if (!open.orders?.length) {
    console.log('no open orders');
  } else {
    for (const o of open.orders) {
      console.log(
        `${o.digest}\n  ${fromX18(BigInt(o.amount))} @ ${fromX18(BigInt(o.price_x18))}` +
          `  unfilled ${fromX18(BigInt(o.unfilled_amount))}`,
      );
    }
  }
  process.exit(0);
}

// ── cancel ───────────────────────────────────────────────────────────────────
const cancelDigest = arg('cancel');
if (cancelDigest) {
  const message = {
    sender,
    productIds: [market.productId],
    digests: [cancelDigest as `0x${string}`],
    nonce: buildOrderNonce(),
  };
  const signature = await signCancellation(account, NETWORK, message);
  try {
    await gateway.cancelOrders({
      cancel_orders: { tx: serializeCancellation(message), signature },
    });
    console.log(`cancelled ${cancelDigest}`);
  } catch (err) {
    console.error(err instanceof NadoApiError ? err.message : err);
    process.exit(1);
  }
  process.exit(0);
}

// ── place ────────────────────────────────────────────────────────────────────
const side = (arg('side') ?? 'buy') as 'buy' | 'sell';
const size = arg('size') ?? '100';

// Default to a price well away from the touch so the order rests rather than
// fills — a first live order should prove the path, not take a position.
const prices = await gateway.marketPrices([market.productId]);
const book = prices.market_prices?.[0];
const bid = book ? Number(fromX18(BigInt(book.bid_x18), 6)) : 0;
const ask = book ? Number(fromX18(BigInt(book.ask_x18), 6)) : 0;
const restingDefault = side === 'buy' ? bid * 0.9 : ask * 1.1;
const price = arg('price') ?? restingDefault.toFixed(6);

console.log(`book    bid ${bid}  ask ${ask}`);
console.log(`order   ${side} ${size} @ ${price}${arg('price') ? '' : '  (auto: 10% away, should rest)'}\n`);

try {
  const prepared = buildOrder(NETWORK, {
    market,
    sender,
    side,
    size,
    price,
    intent: 'open',
    builderId: Number(process.env.ROBONADO_BUILDER_ID ?? 0),
    // Isolated-only markets need margin posted with the order.
    isolatedMarginX6: market.isolatedOnly ? BigInt(arg('margin') ?? '20') * 1_000_000n : undefined,
  });

  const decoded = decodeAppendix(prepared.appendix);
  console.log(`appendix   isolated=${decoded.isolated} builderId=${decoded.builderId} fee=${unitsToBps(decoded.builderFeeRate)}bps`);
  console.log(`digest     ${prepared.digest}`);

  const payload = await signPreparedOrder(account, NETWORK, prepared);
  const result = await gateway.placeOrder(payload);

  console.log(`\nPLACED ✓   ${result.digest ?? prepared.digest}`);

  const open = await gateway.openOrders(sender, market.productId);
  const found = open.orders?.find((o) => o.digest === (result.digest ?? prepared.digest));
  console.log(
    found
      ? `resting on book: ${fromX18(BigInt(found.amount))} @ ${fromX18(BigInt(found.price_x18))}, unfilled ${fromX18(BigInt(found.unfilled_amount))}`
      : 'not on the book — it filled immediately, or the engine has not indexed it yet',
  );
  console.log(`\ncancel with:\n  npm run trade -- --symbol ${symbol} --cancel ${result.digest ?? prepared.digest}`);
} catch (err) {
  if (err instanceof MarketClosedError) console.error(`guard: ${err.message}`);
  else if (err instanceof NadoApiError) console.error(err.message);
  else console.error((err as Error).message);
  process.exit(1);
}
