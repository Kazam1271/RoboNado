/**
 * RoboNado's Telegram front end.
 *
 * Two modes, and the bot is useful in both:
 *   - Commands (/price, /account, /buy) work with no AI at all.
 *   - Free text goes to the copilot, but only when an Anthropic key is present.
 *
 * Access control matters more here than in the CLI. This process holds a
 * signing key, and a Telegram bot is reachable by anyone who finds its handle,
 * so trading is restricted to an explicit allowlist of user IDs. With no
 * allowlist configured the bot still answers questions but refuses to prepare
 * any order — the safe direction to fail.
 */

import type { Copilot } from './agent.ts';
import { NadoApiError, NadoGateway } from './gateway.ts';
import { MarketClosedError } from './guards.ts';
import { loadMarkets, type Network } from './markets.ts';
import { describePolicy, DEFAULT_POLICY, type RiskPolicy } from './policy.ts';
import { fetchAccount } from './positions.ts';
import { resolveMarket, UnknownMarketError } from './resolve.ts';
import { toSubaccountHex } from './subaccount.ts';
import { TelegramBot, type TelegramMessage } from './telegram.ts';
import { createTools } from './tools.ts';
import { fromX18 } from './units.ts';

export interface BotOptions {
  telegram: TelegramBot;
  network: Network;
  gateway: NadoGateway;
  address: `0x${string}`;
  tools: ReturnType<typeof createTools>;
  /** Telegram user IDs permitted to prepare and confirm orders. */
  allowedUserIds: Set<number>;
  /** Absent when no Anthropic key is configured; commands still work. */
  copilot?: Copilot;
  policy?: RiskPolicy;
}

const HELP = `RoboNado — commodities, FX and equities on Nado

/account            your equity, health and open positions
/markets [class]    what is tradable and whether it is open
/price <market>     live bid and ask
/buy <usd> <market>   prepare a buy, e.g. /buy 120 gold
/sell <usd> <market>  prepare a sell
/confirm <token>    approve a prepared order
/limits             the risk limits in force
/help               this message

Markets take plain names: gold, silver, oil, euro, cable, tesla, nvidia,
the S&P. FX follows real market hours and is reduce-only when closed.

Orders are never sent without /confirm.`;

export async function runBot(options: BotOptions): Promise<void> {
  const { telegram, gateway, network, address, tools, allowedUserIds, copilot } = options;
  const policy = options.policy ?? DEFAULT_POLICY;
  const sender = toSubaccountHex(address, 'default');
  const usd = (v: bigint) => (v < 0n ? `-$${fromX18(-v, 2)}` : `$${fromX18(v, 2)}`);

  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  const canTrade = (userId?: number) => userId !== undefined && allowedUserIds.has(userId);

  const me = await telegram.getMe();
  console.log(`RoboNado live as @${me.username}`);
  console.log(`network ${network}  wallet ${address}`);
  console.log(
    allowedUserIds.size
      ? `trading enabled for user ids: ${[...allowedUserIds].join(', ')}`
      : 'no allowlist set — read-only for everyone',
  );
  console.log(copilot ? 'copilot enabled' : 'commands only (no ANTHROPIC_API_KEY)');

  /**
   * One in-flight message per chat, queued in arrival order.
   *
   * Handling messages concurrently would let a /confirm overtake the /buy that
   * produced its token, or two orders interleave mid-preparation. Serialising
   * per chat keeps each conversation causally ordered while a slow request in
   * one chat still cannot stall another.
   */
  const queues = new Map<number, Promise<void>>();

  for await (const message of telegram.messages()) {
    const chatId = message.chat.id;
    const previous = queues.get(chatId) ?? Promise.resolve();

    const next = previous
      .then(() => handle(message))
      .catch(async (err) => {
        console.error(err);
        await telegram
          .sendMessage(chatId, `Something broke: ${(err as Error).message}`)
          .catch(() => {});
      })
      .finally(() => {
        // Drop the entry once this chat is idle, so the map does not grow
        // without bound across the bot's lifetime.
        if (queues.get(chatId) === next) queues.delete(chatId);
      });

    queues.set(chatId, next);
  }

  async function handle(message: TelegramMessage): Promise<void> {
    const text = (message.text ?? '').trim();
    const chatId = message.chat.id;
    const userId = message.from?.id;

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@.*$/, '');

    switch (command) {
      case '/start':
      case '/help':
        return telegram.sendMessage(chatId, HELP);

      case '/limits':
        return telegram.sendMessage(
          chatId,
          `${describePolicy(policy)}\n\nEnforced in code, not by the assistant.`,
        );

      case '/whoami':
        return telegram.sendMessage(
          chatId,
          `your telegram id: ${userId}\ntrading: ${canTrade(userId) ? 'enabled' : 'read-only'}`,
        );

      case '/markets':
        return telegram.sendMessage(
          chatId,
          await byName.list_markets.run({ assetClass: (args[0] as never) ?? 'all' }),
        );

      case '/price': {
        if (!args.length) return telegram.sendMessage(chatId, 'usage: /price gold');
        return telegram.sendMessage(chatId, await byName.get_price.run({ market: args.join(' ') }));
      }

      case '/account': {
        await telegram.sendTyping(chatId);
        const markets = await loadMarkets(network);
        const account = await fetchAccount(gateway, sender, markets);
        if (!account.exists) {
          return telegram.sendMessage(chatId, 'No Nado subaccount yet — deposit at least $5 USDT0.');
        }
        const lines = [
          `equity ${usd(account.equityX18)}`,
          `free collateral ${usd(account.health.initial)}`,
          `liquidation buffer ${usd(account.health.maintenance)}`,
        ];
        if (!account.positions.length) lines.push('\nno open positions');
        else {
          lines.push('');
          for (const p of account.positions) {
            const pnl = p.unrealizedPnlX18;
            lines.push(
              `${p.symbol} ${p.side} — ${usd(p.notionalX18)}, ` +
                `${pnl < 0n ? '-' : '+'}${usd(pnl < 0n ? -pnl : pnl)}, ` +
                `liq ${p.liquidationPriceX18 === null ? 'n/a' : fromX18(p.liquidationPriceX18, 4)}`,
            );
          }
        }
        return telegram.sendMessage(chatId, lines.join('\n'));
      }

      case '/buy':
      case '/sell': {
        if (!canTrade(userId)) {
          return telegram.sendMessage(
            chatId,
            `Not authorised to trade. Your telegram id is ${userId} — ` +
              `it must be in the operator's allowlist.`,
          );
        }
        const amount = Number(args[0]);
        const market = args.slice(1).join(' ');
        if (!Number.isFinite(amount) || amount <= 0 || !market) {
          return telegram.sendMessage(chatId, `usage: ${command} 120 gold`);
        }
        await telegram.sendTyping(chatId);
        return telegram.sendMessage(
          chatId,
          await byName.place_order.run({
            market,
            side: command === '/buy' ? 'buy' : 'sell',
            notionalUsd: amount,
          }),
        );
      }

      case '/confirm': {
        if (!canTrade(userId)) {
          return telegram.sendMessage(chatId, 'Not authorised to trade.');
        }
        if (!args[0]) return telegram.sendMessage(chatId, 'usage: /confirm <token>');
        await telegram.sendTyping(chatId);
        return telegram.sendMessage(chatId, await tools.confirmOrder(args[0]));
      }
    }

    if (command.startsWith('/')) {
      return telegram.sendMessage(chatId, `Unknown command. ${HELP}`);
    }

    // Free text — the copilot, when there is one.
    if (!copilot) {
      // Answer the most common question without an LLM rather than just
      // refusing: a bare market name almost always means "what's the price".
      try {
        const { market } = resolveMarket(text, await loadMarkets(network));
        return telegram.sendMessage(
          chatId,
          `${await byName.get_price.run({ market: market.symbol })}\n\n` +
            `(Conversational mode is off — the operator has not configured an ` +
            `Anthropic key. /help lists what works.)`,
        );
      } catch (err) {
        if (!(err instanceof UnknownMarketError)) throw err;
        return telegram.sendMessage(chatId, `Conversational mode is off. ${HELP}`);
      }
    }

    await telegram.sendTyping(chatId);
    try {
      return telegram.sendMessage(chatId, await copilot.ask(text));
    } catch (err) {
      if (err instanceof MarketClosedError) return telegram.sendMessage(chatId, err.message);
      if (err instanceof NadoApiError) return telegram.sendMessage(chatId, err.message);
      throw err;
    }
  }
}
