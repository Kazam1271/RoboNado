/**
 * Registry of Nado's non-crypto asset planes.
 *
 * This is the wedge: ~40% of Nado's perp listings are commodities, FX, or
 * equities. Crypto-native bots ignore these markets entirely, and they behave
 * differently enough that treating them like BTC-PERP produces broken orders.
 */

export type AssetClass = 'commodity' | 'fx' | 'equity' | 'crypto';

/**
 * Trading statuses observed on live markets. Only `live` accepts opening
 * orders; the rest each fail differently and need distinct handling.
 */
export type TradingStatus =
  | 'live'
  | 'post_only'
  | 'soft_reduce_only'
  | 'reduce_only'
  | 'not_tradable';

export interface MarketMeta {
  productId: number;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** FX markets must use isolated margin; cross-margin orders are rejected. */
  isolatedOnly: boolean;
  tradingStatus: TradingStatus;
  priceIncrementX18: bigint;
  sizeIncrement: bigint;
  minSize: bigint;
  makerFeeRateX18: bigint;
  takerFeeRateX18: bigint;
}

/**
 * Explicit classification for the non-crypto planes. Kept as a hand-maintained
 * map rather than inferred from names: "PENG-PERP" is Penguin Solutions (an
 * equity) while "PENGU-PERP" is Pudgy Penguins (crypto), and no heuristic
 * separates those safely.
 */
const NON_CRYPTO: Record<string, AssetClass> = {
  // Commodities
  'XAUT-PERP': 'commodity', // Tether Gold
  'XAG-PERP': 'commodity', // Silver
  'WTI-PERP': 'commodity', // Crude Oil

  // FX — all isolated-only, all follow real FX market hours
  'EURUSD-PERP': 'fx',
  'GBPUSD-PERP': 'fx',
  'USDJPY-PERP': 'fx',

  // Index equities
  'SPY-PERP': 'equity',
  'QQQ-PERP': 'equity',

  // Single-name equities
  'AAPL-PERP': 'equity',
  'AMZN-PERP': 'equity',
  'GOOGL-PERP': 'equity',
  'META-PERP': 'equity',
  'MSFT-PERP': 'equity',
  'NVDA-PERP': 'equity',
  'TSLA-PERP': 'equity',
  'AMD-PERP': 'equity',
  'AVGO-PERP': 'equity',
  'DELL-PERP': 'equity',
  'INTC-PERP': 'equity',
  'MRVL-PERP': 'equity',
  'MU-PERP': 'equity',
  'SNDK-PERP': 'equity',
  'SPCX-PERP': 'equity', // SpaceX
  'MSTR-PERP': 'equity',
  'BBX-PERP': 'equity',
  'ZHIPU-PERP': 'equity', // 2513.HK
  'CRCL-PERP': 'equity',
  'NBIS-PERP': 'equity',
  'PENG-PERP': 'equity', // Penguin Solutions — NOT Pudgy Penguins
};

export function classify(symbol: string): AssetClass {
  return NON_CRYPTO[symbol] ?? 'crypto';
}

export const GATEWAY_REST = {
  mainnet: 'https://gateway.prod.nado.xyz',
  testnet: 'https://gateway.test.nado.xyz',
} as const;

export type Network = keyof typeof GATEWAY_REST;

interface RawSymbol {
  type: string;
  product_id: number;
  symbol: string;
  price_increment_x18: string;
  size_increment: string;
  min_size: string;
  maker_fee_rate_x18: string;
  taker_fee_rate_x18: string;
  trading_status: string;
  isolated_only: boolean;
}

/**
 * Loads live market metadata. Trading status and isolated-only flags change
 * with market hours, so this must be refreshed rather than cached at build
 * time — FX flips to `soft_reduce_only` every weekend.
 */
export async function loadMarkets(
  network: Network = 'mainnet',
): Promise<Map<string, MarketMeta>> {
  const [symbolsRes, assetsRes] = await Promise.all([
    fetch(`${GATEWAY_REST[network]}/v1/query?type=symbols`),
    fetch(`${GATEWAY_REST[network]}/v2/assets`),
  ]);

  if (!symbolsRes.ok) {
    throw new Error(`symbols query failed: ${symbolsRes.status}`);
  }

  const symbolsBody = (await symbolsRes.json()) as {
    data?: { symbols?: Record<string, RawSymbol> };
  };
  const raw = symbolsBody.data?.symbols;
  if (!raw) throw new Error('symbols query returned no data');

  // Display names live on the v2 assets endpoint, not the symbols query.
  const names = new Map<string, string>();
  if (assetsRes.ok) {
    const assets = (await assetsRes.json()) as {
      symbol: string;
      name: string | null;
    }[];
    for (const a of assets) if (a.name) names.set(a.symbol, a.name);
  }

  const out = new Map<string, MarketMeta>();
  for (const [symbol, m] of Object.entries(raw)) {
    if (m.type !== 'perp') continue;
    out.set(symbol, {
      productId: m.product_id,
      symbol,
      name: names.get(symbol) ?? symbol,
      assetClass: classify(symbol),
      isolatedOnly: m.isolated_only,
      tradingStatus: m.trading_status as TradingStatus,
      priceIncrementX18: BigInt(m.price_increment_x18),
      sizeIncrement: BigInt(m.size_increment),
      minSize: BigInt(m.min_size),
      makerFeeRateX18: BigInt(m.maker_fee_rate_x18),
      takerFeeRateX18: BigInt(m.taker_fee_rate_x18),
    });
  }
  return out;
}

export function nonCryptoMarkets(markets: Map<string, MarketMeta>): MarketMeta[] {
  return [...markets.values()].filter((m) => m.assetClass !== 'crypto');
}
