/**
 * Checks whether a wallet is ready to trade, and prices a live order against
 * the book — without signing or sending anything.
 *
 *   npm run preflight -- 0xYourWalletAddress
 *
 * Takes a public address only. No private key is read.
 */

import { NadoApiError, NadoGateway } from '../src/gateway.ts';
import { loadMarkets, nonCryptoMarkets } from '../src/markets.ts';
import { toSubaccountHex } from '../src/subaccount.ts';
import { fromX18 } from '../src/units.ts';

const address = process.argv[2];
if (!address) {
  console.error('usage: npm run preflight -- 0xYourWalletAddress');
  process.exit(1);
}

const NETWORK = 'testnet' as const;
const gateway = new NadoGateway(NETWORK);
const sender = toSubaccountHex(address, 'default');

console.log(`network  ${NETWORK}`);
console.log(`wallet   ${address}`);
console.log(`sender   ${sender}\n`);

const info = await gateway.subaccountInfo(sender);

if (!info.exists) {
  console.log('subaccount  DOES NOT EXIST');
  console.log('');
  console.log('  Minting USDT0 puts tokens in your wallet — it does not fund Nado.');
  console.log('  The subaccount is created by the deposit itself:');
  console.log('    1. testnet.nado.xyz → Deposit');
  console.log('    2. at least $5 USDT0');
  console.log('    3. re-run this script\n');
} else {
  console.log('subaccount  EXISTS ✓');
  const usdt0 = info.spot_balances?.find((b) => b.product_id === 0);
  if (usdt0) console.log(`balance     ${fromX18(BigInt(usdt0.balance.amount), 2)} USDT0`);
  console.log('');
}

// Live prices across the wedge, whether or not the account is funded.
const markets = await loadMarkets(NETWORK);
const wedge = nonCryptoMarkets(markets).filter((m) => m.assetClass !== 'equity');
const prices = await gateway.marketPrices(wedge.map((m) => m.productId));
const byId = new Map(prices.market_prices?.map((p) => [p.product_id, p]) ?? []);

console.log('SYMBOL        CLASS      STATUS             BID         ASK');
for (const m of wedge) {
  const p = byId.get(m.productId);
  console.log(
    m.symbol.padEnd(14) +
      m.assetClass.padEnd(11) +
      m.tradingStatus.padEnd(19) +
      (p ? fromX18(BigInt(p.bid_x18), 4).padEnd(12) : '—'.padEnd(12)) +
      (p ? fromX18(BigInt(p.ask_x18), 4) : '—'),
  );
}

try {
  await gateway.openOrders(sender, 90);
  console.log('\nopen WTI orders: none');
} catch (err) {
  if (err instanceof NadoApiError) console.log(`\nopen orders query: ${err.message}`);
}
