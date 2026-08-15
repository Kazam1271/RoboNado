/**
 * Builds and signs real orders against live Ink Sepolia market data, and prints
 * the payload without sending it.
 *
 * Uses a freshly generated throwaway key each run. Nothing here touches funds,
 * and no key of yours is read — placing an order for real needs a funded
 * subaccount and is a separate step.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { decodeAppendix, unitsToBps } from '../src/appendix.ts';
import { MarketClosedError, BUILDER_FEE_BPS } from '../src/guards.ts';
import { loadMarkets } from '../src/markets.ts';
import { buildOrder, signPreparedOrder } from '../src/order.ts';
import { toSubaccountHex } from '../src/subaccount.ts';
import { fromX18 } from '../src/units.ts';

const NETWORK = 'testnet' as const;
const BUILDER_ID = Number(process.env.ROBONADO_BUILDER_ID ?? 0);

const account = privateKeyToAccount(generatePrivateKey());
const sender = toSubaccountHex(account.address, 'default');

const markets = await loadMarkets(NETWORK);
console.log(`network   ${NETWORK} (Ink Sepolia)`);
console.log(`signer    ${account.address}  [ephemeral]`);
console.log(`sender    ${sender}`);
console.log(`builder   ${BUILDER_ID === 0 ? '0 — unattributed, no fee charged' : BUILDER_ID}\n`);

// Sizes clear each market's min_size (100 units across these listings).
const attempts = [
  { symbol: 'WTI-PERP', side: 'buy' as const, size: '100', price: '58.00' },
  { symbol: 'XAG-PERP', side: 'sell' as const, size: '150.037', price: '52.00' },
  { symbol: 'EURUSD-PERP', side: 'buy' as const, size: '1000', price: '1.0850' },
];

for (const attempt of attempts) {
  const market = markets.get(attempt.symbol);
  if (!market) {
    console.log(`${attempt.symbol}: not listed on ${NETWORK}\n`);
    continue;
  }

  console.log(
    `── ${market.symbol}  (${market.assetClass}, id ${market.productId}, ${market.tradingStatus})`,
  );

  try {
    const prepared = buildOrder(NETWORK, {
      market,
      sender,
      side: attempt.side,
      size: attempt.size,
      price: attempt.price,
      intent: 'open',
      builderId: BUILDER_ID,
      // FX is isolated-only; post 200 USDT0 of margin (x6).
      isolatedMarginX6: market.isolatedOnly ? 200_000_000n : undefined,
    });

    const decoded = decodeAppendix(prepared.appendix);
    const payload = await signPreparedOrder(account, NETWORK, prepared);

    console.log(`   ${attempt.side} ${fromX18(prepared.message.amount)} @ ${fromX18(prepared.message.priceX18)}`);
    console.log(`   appendix   ${prepared.appendix}`);
    console.log(
      `              isolated=${decoded.isolated} builderId=${decoded.builderId} ` +
        `fee=${unitsToBps(decoded.builderFeeRate)}bps (policy ${BUILDER_FEE_BPS[market.assetClass]}bps)`,
    );
    console.log(`   digest     ${prepared.digest}`);
    console.log(`   signature  ${payload.place_order.signature.slice(0, 42)}…`);
    console.log(`   our fee    ${prepared.builderFeeQuote} USDT0 on this order`);
    console.log('   NOT SENT — dry run\n');
  } catch (err) {
    if (err instanceof MarketClosedError) {
      console.log(`   blocked by guard: ${err.message}\n`);
    } else {
      console.log(`   rejected: ${(err as Error).message}\n`);
    }
  }
}
