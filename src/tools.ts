/**
 * The tool surface the model is given.
 *
 * Reads execute immediately. Writes do not: `place_order` validates the
 * proposal, prices it, checks policy, and returns a description of what *would*
 * happen along with a confirmation token. Only a separate, human-driven call to
 * `confirmOrder` signs anything.
 *
 * The model therefore cannot place a trade, no matter what it decides or what
 * a user talks it into. It can only ever prepare one for a person to approve.
 */

import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account } from 'viem';

import { NadoApiError, NadoGateway } from './gateway.ts';
import { MarketClosedError, assertTradable } from './guards.ts';
import { loadMarkets, type MarketMeta, type Network } from './markets.ts';
import { buildOrder, signPreparedOrder, type PreparedOrder } from './order.ts';
import { assertWithinPolicy, DEFAULT_POLICY, PolicyViolation, type RiskPolicy } from './policy.ts';
import { fetchAccount } from './positions.ts';
import { resolveMarket, UnknownMarketError } from './resolve.ts';
import { toSubaccountHex } from './subaccount.ts';
import { fromX18, ONE_X18, toX18 } from './units.ts';

export interface CopilotContext {
  network: Network;
  gateway: NadoGateway;
  /** Wallet address. Present even in read-only mode. */
  address: `0x${string}`;
  /** Absent in read-only mode — without it nothing can ever be signed. */
  account?: Account;
  policy?: RiskPolicy;
  builderId?: number;
}

/** An order prepared and awaiting human approval. */
export interface PendingOrder {
  token: string;
  prepared: PreparedOrder;
  market: MarketMeta;
  summary: string;
  createdAt: number;
}

/** Approvals expire so a confirmation cannot be replayed against a stale book. */
export const PENDING_TTL_MS = 2 * 60 * 1000;

export function createTools(ctx: CopilotContext) {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const sender = toSubaccountHex(ctx.address, 'default');
  const pending = new Map<string, PendingOrder>();

  const markets = async () => loadMarkets(ctx.network);
  const usd = (v: bigint) => `$${fromX18(v, 2)}`;

  const getAccount = betaZodTool({
    name: 'get_account',
    description:
      'Read the trader\'s account: equity, free collateral, liquidation buffer, ' +
      'open positions with entry, mark, unrealized pnl and liquidation price. ' +
      'Call this before answering any question about exposure or risk, and ' +
      'before proposing a trade.',
    inputSchema: z.object({}),
    run: async () => {
      const account = await fetchAccount(ctx.gateway, sender, await markets());
      if (!account.exists) {
        return 'This wallet has no Nado subaccount yet. It needs a deposit of at least $5 USDT0.';
      }
      const lines = [
        `equity ${usd(account.equityX18)}`,
        `free collateral ${usd(account.health.initial)}`,
        `liquidation buffer ${usd(account.health.maintenance)}`,
        `gross notional ${usd(account.grossNotionalX18)}`,
      ];
      if (!account.positions.length) {
        lines.push('no open positions');
      } else {
        for (const p of account.positions) {
          lines.push(
            `${p.symbol} ${p.side} ${fromX18(p.amount, 4)} | entry ${fromX18(p.entryPriceX18, 4)} ` +
              `| mark ${fromX18(p.oraclePriceX18, 4)} | notional ${usd(p.notionalX18)} ` +
              `| unrealized ${p.unrealizedPnlX18 < 0n ? '-' : '+'}${usd(p.unrealizedPnlX18 < 0n ? -p.unrealizedPnlX18 : p.unrealizedPnlX18)} ` +
              `| liquidation ${p.liquidationPriceX18 === null ? 'n/a' : fromX18(p.liquidationPriceX18, 4)}`,
          );
        }
      }
      return lines.join('\n');
    },
  });

  const listMarkets = betaZodTool({
    name: 'list_markets',
    description:
      'List tradable markets with live status. Use to answer "what can I trade" ' +
      'and to check whether a market is open before proposing an order. FX ' +
      'follows real market hours and is reduce-only outside them.',
    inputSchema: z.object({
      assetClass: z
        .enum(['commodity', 'fx', 'equity', 'all'])
        .optional()
        .describe('Filter by asset class. Defaults to all non-crypto markets.'),
    }),
    run: async ({ assetClass = 'all' }) => {
      const all = [...(await markets()).values()].filter((m) =>
        assetClass === 'all' ? m.assetClass !== 'crypto' : m.assetClass === assetClass,
      );
      if (!all.length) return 'no markets match';
      return all
        .map((m) => `${m.symbol} (${m.assetClass}) ${m.tradingStatus}${m.isolatedOnly ? ' isolated-only' : ''}`)
        .join('\n');
    },
  });

  const getPrice = betaZodTool({
    name: 'get_price',
    description:
      'Current bid and ask for a market. Accepts common names — "gold", "oil", ' +
      '"cable", "the S&P" — as well as Nado symbols.',
    inputSchema: z.object({
      market: z.string().describe('Market name, ticker or symbol, e.g. "gold" or "XAUT-PERP".'),
    }),
    run: async ({ market }) => {
      try {
        const { market: m, via } = resolveMarket(market, await markets());
        const prices = await ctx.gateway.marketPrices([m.productId]);
        const book = prices.market_prices?.[0];
        if (!book) return `${m.symbol}: no book`;
        return (
          `${m.symbol} (matched by ${via}, ${m.tradingStatus}) ` +
          `bid ${fromX18(BigInt(book.bid_x18), 6)} ask ${fromX18(BigInt(book.ask_x18), 6)}`
        );
      } catch (err) {
        if (err instanceof UnknownMarketError) return err.message;
        throw err;
      }
    },
  });

  const placeOrder = betaZodTool({
    name: 'place_order',
    description:
      'Prepare an order for the trader to approve. This does NOT execute — it ' +
      'validates the market is open, prices the order, checks it against risk ' +
      'policy, and returns a summary plus a confirmation token. The trader must ' +
      'approve separately before anything is signed. Always call get_account first.',
    inputSchema: z.object({
      market: z.string().describe('Market name, ticker or symbol.'),
      side: z.enum(['buy', 'sell']),
      notionalUsd: z
        .number()
        .positive()
        .describe('Order size in US dollars of notional, not in contracts.'),
      limitPrice: z
        .number()
        .positive()
        .optional()
        .describe('Limit price. Omitted means price against the current book.'),
      intent: z
        .enum(['open', 'close'])
        .optional()
        .describe('"close" reduces an existing position and skips exposure limits.'),
    }),
    run: async ({ market, side, notionalUsd, limitPrice, intent = 'open' }) => {
      if (!ctx.account) {
        return 'Read-only mode: no signing key is loaded, so orders cannot be prepared.';
      }

      try {
        const all = await markets();
        const { market: m } = resolveMarket(market, all);

        assertTradable(m, intent);

        const prices = await ctx.gateway.marketPrices([m.productId]);
        const book = prices.market_prices?.[0];
        if (!book) return `${m.symbol} has no book right now.`;

        const bid = BigInt(book.bid_x18);
        const ask = BigInt(book.ask_x18);
        const priceX18 = limitPrice !== undefined ? toX18(String(limitPrice)) : side === 'buy' ? ask : bid;

        const notionalX18 = toX18(String(notionalUsd));
        const account = await fetchAccount(ctx.gateway, sender, all);
        assertWithinPolicy({ market: m, side, notionalX18, intent }, account, policy);

        const sizeX18 = (notionalX18 * ONE_X18) / priceX18;

        const prepared = buildOrder(ctx.network, {
          market: m,
          sender,
          side,
          size: fromX18(sizeX18, 8),
          price: fromX18(priceX18, 8),
          intent,
          builderId: ctx.builderId ?? 0,
          // Isolated markets need margin posted; use the order's own notional
          // at the policy leverage cap.
          isolatedMarginX6: m.isolatedOnly
            ? (notionalX18 * 1_000_000n) / ONE_X18 / BigInt(Math.floor(policy.maxLeverage))
            : undefined,
        });

        const token = randomUUID();
        const summary =
          `${side} ${fromX18(prepared.message.amount < 0n ? -prepared.message.amount : prepared.message.amount, 6)} ` +
          `${m.symbol} @ ${fromX18(prepared.message.priceX18, 6)} ` +
          `(${usd(notionalX18)} notional, ${m.assetClass})`;

        pending.set(token, { token, prepared, market: m, summary, createdAt: Date.now() });

        return (
          `PREPARED, NOT SENT.\n${summary}\n` +
          `fee to us: ${prepared.builderFeeQuote} USDT0\n` +
          `confirmation token: ${token}\n` +
          `Tell the trader exactly what this order is and ask them to confirm. ` +
          `You cannot confirm it yourself.`
        );
      } catch (err) {
        if (err instanceof UnknownMarketError) return err.message;
        if (err instanceof MarketClosedError) return `Cannot trade: ${err.message}`;
        if (err instanceof PolicyViolation) return `Blocked by risk policy (${err.rule}): ${err.message}`;
        if (err instanceof NadoApiError) return `Nado rejected this: ${err.message}`;
        return `Could not prepare the order: ${(err as Error).message}`;
      }
    },
  });

  /**
   * Signs and sends a prepared order. Not exposed to the model — it is called
   * by the host application after a human approves, which is what makes the
   * confirmation gate real rather than advisory.
   */
  async function confirmOrder(token: string): Promise<string> {
    const entry = pending.get(token);
    if (!entry) return 'No pending order with that token.';
    pending.delete(token);

    if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
      return 'That approval expired. Prepare the order again so it prices against the current book.';
    }
    if (!ctx.account) return 'No signing key loaded.';

    try {
      const payload = await signPreparedOrder(ctx.account, ctx.network, entry.prepared);
      const result = await ctx.gateway.placeOrder(payload);
      return `Placed. digest ${result.digest ?? entry.prepared.digest}\n${entry.summary}`;
    } catch (err) {
      if (err instanceof NadoApiError) return `Rejected: ${err.message}`;
      return `Failed: ${(err as Error).message}`;
    }
  }

  return {
    tools: [getAccount, listMarkets, getPrice, placeOrder],
    confirmOrder,
    pending,
  };
}
