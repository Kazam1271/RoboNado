/**
 * Shows a subaccount's health and open positions.
 *
 *   npm run account -- 0xYourWalletAddress
 *
 * Takes a public address. No private key is read.
 */

import { NadoGateway } from '../src/gateway.ts';
import { loadMarkets } from '../src/markets.ts';
import { fetchAccount } from '../src/positions.ts';
import { toSubaccountHex } from '../src/subaccount.ts';
import { fromX18 } from '../src/units.ts';

const address = process.argv[2];
if (!address) {
  console.error('usage: npm run account -- 0xYourWalletAddress');
  process.exit(1);
}

const NETWORK = 'testnet' as const;
const gateway = new NadoGateway(NETWORK);
const sender = toSubaccountHex(address, 'default');

const markets = await loadMarkets(NETWORK);
const account = await fetchAccount(gateway, sender, markets);

if (!account.exists) {
  console.log(`no subaccount for ${address} — deposit at least $5 USDT0 first`);
  process.exit(0);
}

const usd = (v: bigint) => `$${fromX18(v, 2)}`;

console.log(`account   ${address}\n`);
console.log(`equity            ${usd(account.equityX18)}`);
console.log(`free collateral   ${usd(account.health.initial)}   (initial health — gates new positions)`);
console.log(`liq buffer        ${usd(account.health.maintenance)}   (maintenance health — liquidated below $0)`);
console.log(`gross notional    ${usd(account.grossNotionalX18)}`);
console.log(`margin used       ${(account.marginUtilisation * 100).toFixed(1)}%`);

if (account.spot.length) {
  console.log('\ncollateral');
  for (const b of account.spot) {
    console.log(`  product ${String(b.productId).padEnd(4)} ${fromX18(b.amountX18, 4).padStart(14)}   ${usd(b.valueX18)}`);
  }
}

if (!account.positions.length) {
  console.log('\nno open positions');
} else {
  console.log('\npositions');
  for (const p of account.positions) {
    const pnl = Number(fromX18(p.unrealizedPnlX18, 2));
    const arrow = pnl >= 0 ? '+' : '';
    console.log(
      `\n  ${p.symbol}  ${p.side.toUpperCase()}  (${p.assetClass})`,
    );
    console.log(`    size        ${fromX18(p.amount, 4)}`);
    console.log(`    entry       ${fromX18(p.entryPriceX18, 4)}`);
    console.log(`    mark        ${fromX18(p.oraclePriceX18, 4)}`);
    console.log(`    notional    ${usd(p.notionalX18)}   (${p.leverage.toFixed(1)}x of equity)`);
    console.log(`    unrealized  ${arrow}${usd(p.unrealizedPnlX18).replace('$-', '$')}`);
    console.log(`    funding     ${usd(p.fundingX18)}   (unsettled, estimate)`);
    console.log(
      `    liquidation ${
        p.liquidationPriceX18 === null
          ? 'not reachable from this market alone'
          : fromX18(p.liquidationPriceX18, 4)
      }`,
    );
  }
}
