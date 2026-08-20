/**
 * Turns what a person calls a market into the symbol Nado uses.
 *
 * Traders on these asset classes do not say "XAUT-PERP" — they say gold, oil,
 * cable, the S&P. This is the layer that makes the copilot usable to someone
 * who has never seen a Nado ticker, and it stays deterministic so the model
 * cannot invent a market that does not exist.
 */

import type { MarketMeta } from './markets.ts';

/**
 * Aliases for the non-crypto planes. Deliberately hand-written: no fuzzy
 * matcher should be allowed to decide that "peng" means Pudgy Penguins
 * (PENGU-PERP, crypto) rather than Penguin Solutions (PENG-PERP, an equity).
 */
const ALIASES: Record<string, string> = {
  // Commodities
  gold: 'XAUT-PERP',
  xau: 'XAUT-PERP',
  xaut: 'XAUT-PERP',
  bullion: 'XAUT-PERP',
  silver: 'XAG-PERP',
  xag: 'XAG-PERP',
  oil: 'WTI-PERP',
  crude: 'WTI-PERP',
  'crude oil': 'WTI-PERP',
  wti: 'WTI-PERP',

  // FX
  euro: 'EURUSD-PERP',
  eur: 'EURUSD-PERP',
  eurusd: 'EURUSD-PERP',
  'euro dollar': 'EURUSD-PERP',
  pound: 'GBPUSD-PERP',
  sterling: 'GBPUSD-PERP',
  cable: 'GBPUSD-PERP',
  gbp: 'GBPUSD-PERP',
  gbpusd: 'GBPUSD-PERP',
  yen: 'USDJPY-PERP',
  jpy: 'USDJPY-PERP',
  usdjpy: 'USDJPY-PERP',

  // Indices
  'sp500': 'SPY-PERP',
  'S&P': 'SPY-PERP',
  'sandp': 'SPY-PERP',
  spx: 'SPY-PERP',
  spy: 'SPY-PERP',
  nasdaq: 'QQQ-PERP',
  qqq: 'QQQ-PERP',

  // Equities
  apple: 'AAPL-PERP',
  amazon: 'AMZN-PERP',
  google: 'GOOGL-PERP',
  alphabet: 'GOOGL-PERP',
  meta: 'META-PERP',
  facebook: 'META-PERP',
  microsoft: 'MSFT-PERP',
  nvidia: 'NVDA-PERP',
  tesla: 'TSLA-PERP',
  amd: 'AMD-PERP',
  broadcom: 'AVGO-PERP',
  dell: 'DELL-PERP',
  intel: 'INTC-PERP',
  marvell: 'MRVL-PERP',
  micron: 'MU-PERP',
  sandisk: 'SNDK-PERP',
  spacex: 'SPCX-PERP',
  strategy: 'MSTR-PERP',
  microstrategy: 'MSTR-PERP',
  blackberry: 'BBX-PERP',
  zhipu: 'ZHIPU-PERP',
  circle: 'CRCL-PERP',
  nebius: 'NBIS-PERP',
  'penguin solutions': 'PENG-PERP',
};

export interface Resolution {
  market: MarketMeta;
  /** How the match was made, for explaining the choice back to the user. */
  via: 'symbol' | 'alias' | 'ticker';
}

export class UnknownMarketError extends Error {
  query: string;
  suggestions: string[];

  constructor(query: string, suggestions: string[]) {
    super(
      `no market matches "${query}"` +
        (suggestions.length ? `. Did you mean: ${suggestions.join(', ')}?` : ''),
    );
    this.name = 'UnknownMarketError';
    this.query = query;
    this.suggestions = suggestions;
  }
}

/**
 * Resolves a free-text market reference. Throws with suggestions rather than
 * guessing — a wrong market is a wrong trade, so ambiguity goes back to the
 * user instead of being resolved silently.
 */
export function resolveMarket(
  query: string,
  markets: Map<string, MarketMeta>,
): Resolution {
  const raw = query.trim();
  const lower = raw.toLowerCase();

  // Exact symbol, case-insensitive.
  for (const [symbol, market] of markets) {
    if (symbol.toLowerCase() === lower) return { market, via: 'symbol' };
  }

  const aliased = ALIASES[lower];
  if (aliased) {
    const market = markets.get(aliased);
    if (market) return { market, via: 'alias' };
  }

  // Bare ticker: "TSLA" for TSLA-PERP. Only an exact base match counts, so
  // "PENG" cannot land on "PENGU-PERP".
  const upper = raw.toUpperCase();
  for (const [symbol, market] of markets) {
    const base = symbol.replace(/-PERP$/, '');
    if (base === upper) return { market, via: 'ticker' };
  }

  throw new UnknownMarketError(raw, suggest(lower, markets));
}

/** Nearby symbols and aliases, for an error a person can act on. */
function suggest(query: string, markets: Map<string, MarketMeta>): string[] {
  const hits = new Set<string>();

  for (const [alias, symbol] of Object.entries(ALIASES)) {
    if (!markets.has(symbol)) continue;
    if (alias.includes(query) || query.includes(alias)) hits.add(symbol);
  }
  for (const symbol of markets.keys()) {
    if (symbol.toLowerCase().includes(query)) hits.add(symbol);
  }

  return [...hits].slice(0, 5);
}

/** Every alias pointing at a market, for help text and prompts. */
export function aliasesFor(symbol: string): string[] {
  return Object.entries(ALIASES)
    .filter(([, s]) => s === symbol)
    .map(([alias]) => alias);
}

export { ALIASES };
