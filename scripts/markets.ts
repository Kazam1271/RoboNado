/**
 * Prints the trading surface with live status and fee burden.
 * Run with `npm run markets` — useful for seeing FX flip to reduce-only at the
 * weekly close. Pass `--wedge` to show only the non-crypto planes that most
 * crypto-native bots don't cover.
 */

import { loadMarkets, nonCryptoMarkets } from '../src/markets.ts';
import { resolveNetwork, networkBanner } from '../src/config.ts';
import { BUILDER_FEE_BPS, builderFeeBurden } from '../src/guards.ts';
import { fxSessionNote } from '../src/marketHours.ts';

const NETWORK = resolveNetwork();
const wedgeOnly = process.argv.includes('--wedge');
console.log(`${networkBanner(NETWORK)}\n`);
const markets = await loadMarkets(NETWORK);
const shown = (wedgeOnly ? nonCryptoMarkets(markets) : [...markets.values()]).sort(
  (a, b) => a.assetClass.localeCompare(b.assetClass) || a.symbol.localeCompare(b.symbol),
);

console.log(
  wedgeOnly
    ? `${shown.length} non-crypto markets of ${markets.size} perps ` +
        `(${((shown.length / markets.size) * 100).toFixed(0)}%)\n`
    : `${markets.size} markets across crypto, commodity, fx and equity ` +
        `(${nonCryptoMarkets(markets).length} non-crypto — see --wedge)\n`,
);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(
  pad('SYMBOL', 14) + pad('CLASS', 11) + pad('STATUS', 18) + pad('ISO', 5) + pad('OUR FEE', 10) + 'BURDEN',
);

for (const m of shown) {
  const burden = builderFeeBurden(m);
  console.log(
    pad(m.symbol, 14) +
      pad(m.assetClass, 11) +
      pad(m.tradingStatus, 18) +
      pad(m.isolatedOnly ? 'yes' : '-', 5) +
      pad(`${BUILDER_FEE_BPS[m.assetClass]}bps`, 10) +
      (burden === null ? 'n/a — venue charges 0bps here' : `${(burden * 100).toFixed(0)}% of taker fee`),
  );
}

// Estimated, not authoritative — see marketHours.ts. Printed separately from
// the table above so a normal week (no pair within the warning window)
// doesn't grow a column that's almost always empty.
const sessionNotes = shown.map((m) => fxSessionNote(m)).filter((n): n is string => n !== null);
if (sessionNotes.length) console.log(`\n${sessionNotes.join('\n')}`);
