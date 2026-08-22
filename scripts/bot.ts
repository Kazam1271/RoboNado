/**
 * Runs the RoboNado Telegram bot.
 *
 *   npm run bot
 *
 * Required:
 *   TELEGRAM_BOT_TOKEN         from @BotFather
 * Optional:
 *   TELEGRAM_ALLOWED_USER_IDS  comma-separated ids permitted to trade
 *   NADO_PRIVATE_KEY           without it the bot is read-only
 *   ANTHROPIC_API_KEY          without it commands work but chat does not
 */

import { privateKeyToAccount } from 'viem/accounts';

import { Copilot } from '../src/agent.ts';
import { runBot } from '../src/bot.ts';
import { NadoGateway } from '../src/gateway.ts';
import { TelegramBot } from '../src/telegram.ts';
import { createTools } from '../src/tools.ts';
import { resolveNetwork, networkBanner } from '../src/config.ts';

const NETWORK = resolveNetwork();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and add it to .env.');
  process.exit(1);
}

const key = process.env.NADO_PRIVATE_KEY;
const account = key && !key.includes('PASTE') ? privateKeyToAccount(key as `0x${string}`) : undefined;
const address = (account?.address ?? process.env.NADO_ADDRESS) as `0x${string}` | undefined;

if (!address) {
  console.error('Set NADO_PRIVATE_KEY, or NADO_ADDRESS to run read-only.');
  process.exit(1);
}

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
);

const gateway = new NadoGateway(NETWORK);
const builderId = Number(process.env.ROBONADO_BUILDER_ID ?? 0);

const tools = createTools({ network: NETWORK, gateway, address, account, builderId });

// Conversational mode is a bonus, not a requirement — the bot is useful
// without an Anthropic key, which matters while billing is being sorted out.
const hasAnthropicKey =
  !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('PASTE');

const copilot = hasAnthropicKey
  ? new Copilot({ network: NETWORK, gateway, address, account, builderId })
  : undefined;

// Render sends SIGTERM on every deploy; drain rather than dying mid-order.
const shutdown = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig} received — finishing in-flight messages`);
    shutdown.abort();
  });
}

await runBot({
  telegram: new TelegramBot(botToken),
  signal: shutdown.signal,
  network: NETWORK,
  gateway,
  address,
  tools,
  allowedUserIds,
  copilot,
});
