/**
 * Prints the non-crypto trading surface with live status and fee burden.
 * Run with `npm run markets` — useful for seeing FX flip to reduce-only at the
 * weekly close.
 */

import { loadMarkets, nonCryptoMarkets } from '../src/markets.ts';
import { resolveNetwork, networkBanner } from '../src/config.ts';
import { BUILDER_FEE_BPS, builderFeeBurden } from '../src/guards.ts';

const NETWORK = resolveNetwork();
console.log(`${networkBanner(NETWORK)}\n`);
const markets = await loadMarkets(NETWORK);
const wedge = nonCryptoMarkets(markets).sort(
  (a, b) => a.assetClass.localeCompare(b.assetClass) || a.symbol.localeCompare(b.symbol),
);

console.log(
  `${wedge.length} non-crypto markets of ${markets.size} perps ` +
    `(${((wedge.length / markets.size) * 100).toFixed(0)}%)\n`,
);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(
  pad('SYMBOL', 14) + pad('CLASS', 11) + pad('STATUS', 18) + pad('ISO', 5) + pad('OUR FEE', 10) + 'BURDEN',
);

for (const m of wedge) {
  console.log(
    pad(m.symbol, 14) +
      pad(m.assetClass, 11) +
      pad(m.tradingStatus, 18) +
      pad(m.isolatedOnly ? 'yes' : '-', 5) +
      pad(`${BUILDER_FEE_BPS[m.assetClass]}bps`, 10) +
      `${(builderFeeBurden(m) * 100).toFixed(0)}% of taker fee`,
  );
}
