import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runBot, type BotOptions } from '../src/bot.ts';
import { NadoApiError } from '../src/gateway.ts';
import { MarketClosedError } from '../src/guards.ts';
import type { MarketMeta } from '../src/markets.ts';
import type { AccountSnapshot } from '../src/positions.ts';
import { createTools, type PrepareParams } from '../src/tools.ts';
import type { TelegramBot, TelegramMessage } from '../src/telegram.ts';
import { toX18 } from '../src/units.ts';

/**
 * This file tests bot.ts's own job — command parsing, access control,
 * per-chat ordering, and error routing — not the tools/policy/positions
 * logic behind each command, which already has its own dedicated tests.
 * Every dependency is faked so no test touches the network.
 */

/** A fake Telegram client that records what runBot sends instead of calling the real API. */
function fakeTelegram(messages: TelegramMessage[]) {
  const sent: { chatId: number; text: string }[] = [];
  const telegram = {
    getMe: async () => ({ id: 1, username: 'testbot' }),
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
    },
    sendTyping: async () => {},
    messages: async function* () {
      for (const m of messages) yield m;
    },
  } as unknown as TelegramBot;
  return { telegram, sent };
}

const message = (text: string, opts: { userId?: number; chatId?: number } = {}): TelegramMessage =>
  ({
    message_id: 1,
    text,
    chat: { id: opts.chatId ?? 100, type: 'private' },
    from: opts.userId === undefined ? undefined : { id: opts.userId },
  }) as TelegramMessage;

/** Only the two tool entries bot.ts actually looks up by name. */
function fakeTools(overrides: {
  listMarkets?: (args: { assetClass?: string }) => Promise<string>;
  getPrice?: (args: { market: string }) => Promise<string>;
  prepareOrder?: (params: PrepareParams) => ReturnType<ReturnType<typeof createTools>['prepareOrder']>;
  confirmOrder?: (token: string) => Promise<string>;
} = {}): ReturnType<typeof createTools> {
  return {
    tools: [
      { name: 'list_markets', run: overrides.listMarkets ?? (async () => 'markets') },
      { name: 'get_price', run: overrides.getPrice ?? (async () => 'price') },
    ],
    prepareOrder:
      overrides.prepareOrder ?? (async () => ({ ok: false, reason: 'not configured for this test' })),
    confirmOrder: overrides.confirmOrder ?? (async () => 'not configured for this test'),
    pending: new Map(),
  } as unknown as ReturnType<typeof createTools>;
}

const emptyAccount = (): AccountSnapshot =>
  ({
    exists: true,
    sender: '0xabc',
    health: { initial: toX18('0'), maintenance: toX18('0'), pnl: toX18('0') },
    spot: [],
    positions: [],
    equityX18: 0n,
    grossNotionalX18: 0n,
    marginUtilisation: 0,
    isolatedMarginX18: 0n,
    isolatedNotionalX18: 0n,
  }) as AccountSnapshot;

function baseOptions(overrides: Partial<BotOptions> = {}): BotOptions {
  return {
    telegram: fakeTelegram([]).telegram,
    network: 'testnet',
    gateway: {} as BotOptions['gateway'],
    address: '0x72819631EDda427c4A23e412e3fA2598937d2E16',
    tools: fakeTools(),
    allowedUserIds: new Set<number>(),
    getMarkets: async () => new Map<string, MarketMeta>(),
    readAccount: async () => emptyAccount(),
    ...overrides,
  };
}

describe('help and unknown commands', () => {
  test('/help and /start return the same help text', async () => {
    const { telegram, sent } = fakeTelegram([message('/help'), message('/start')]);
    await runBot(baseOptions({ telegram }));
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /RoboNado/);
    assert.equal(sent[0].text, sent[1].text);
  });

  test('an unrecognised slash command gets the help text appended', async () => {
    const { telegram, sent } = fakeTelegram([message('/nonsense')]);
    await runBot(baseOptions({ telegram }));
    assert.match(sent[0].text, /^Unknown command\. RoboNado/);
  });

  test('a bot-mention suffix is stripped before matching the command', async () => {
    const { telegram, sent } = fakeTelegram([message('/help@RoboNadoBot')]);
    await runBot(baseOptions({ telegram }));
    assert.match(sent[0].text, /RoboNado/);
    assert.doesNotMatch(sent[0].text, /^Unknown command/);
  });

  test('commands are case-insensitive', async () => {
    const { telegram, sent } = fakeTelegram([message('/HELP')]);
    await runBot(baseOptions({ telegram }));
    assert.doesNotMatch(sent[0].text, /^Unknown command/);
  });
});

describe('/whoami and /limits', () => {
  test('/whoami reports read-only when the user is not on the allowlist', async () => {
    const { telegram, sent } = fakeTelegram([message('/whoami', { userId: 42 })]);
    await runBot(baseOptions({ telegram, allowedUserIds: new Set([1, 2, 3]) }));
    assert.match(sent[0].text, /your telegram id: 42/);
    assert.match(sent[0].text, /read-only/);
  });

  test('/whoami reports trading enabled when the user is on the allowlist', async () => {
    const { telegram, sent } = fakeTelegram([message('/whoami', { userId: 42 })]);
    await runBot(baseOptions({ telegram, allowedUserIds: new Set([42]) }));
    assert.match(sent[0].text, /trading: enabled/);
  });

  test('/limits states the limits are enforced in code, not by the assistant', async () => {
    const { telegram, sent } = fakeTelegram([message('/limits')]);
    await runBot(baseOptions({ telegram }));
    assert.match(sent[0].text, /Enforced in code, not by the assistant\./);
    assert.match(sent[0].text, /max leverage/);
  });
});

describe('/markets and /price', () => {
  test('/markets with no argument defaults to "all"', async () => {
    let seen: unknown;
    const tools = fakeTools({
      listMarkets: async (args) => {
        seen = args.assetClass;
        return 'ok';
      },
    });
    const { telegram, sent } = fakeTelegram([message('/markets')]);
    await runBot(baseOptions({ telegram, tools }));
    assert.equal(seen, 'all');
    assert.equal(sent[0].text, 'ok');
  });

  test('/markets fx passes the class straight through', async () => {
    let seen: unknown;
    const tools = fakeTools({ listMarkets: async (args) => ((seen = args.assetClass), 'ok') });
    const { telegram } = fakeTelegram([message('/markets fx')]);
    await runBot(baseOptions({ telegram, tools }));
    assert.equal(seen, 'fx');
  });

  test('/price with no argument returns a usage message rather than calling the tool', async () => {
    let called = false;
    const tools = fakeTools({ getPrice: async () => ((called = true), 'ok') });
    const { telegram, sent } = fakeTelegram([message('/price')]);
    await runBot(baseOptions({ telegram, tools }));
    assert.equal(called, false);
    assert.match(sent[0].text, /usage: \/price gold/);
  });

  test('/price gold joins multi-word arguments into one market query', async () => {
    let seen: unknown;
    const tools = fakeTools({ getPrice: async (args) => ((seen = args.market), 'ok') });
    const { telegram } = fakeTelegram([message('/price the S&P')]);
    await runBot(baseOptions({ telegram, tools }));
    assert.equal(seen, 'the S&P');
  });
});

describe('/account', () => {
  test('reports no subaccount rather than an empty account', async () => {
    const { telegram, sent } = fakeTelegram([message('/account')]);
    await runBot(baseOptions({ telegram, readAccount: async () => ({ ...emptyAccount(), exists: false }) }));
    assert.match(sent[0].text, /No Nado subaccount yet/);
  });

  test('reports no open positions on an idle, funded account', async () => {
    const { telegram, sent } = fakeTelegram([message('/account')]);
    await runBot(
      baseOptions({
        telegram,
        readAccount: async () => ({ ...emptyAccount(), equityX18: toX18('50') }),
      }),
    );
    assert.match(sent[0].text, /equity \$50/);
    assert.match(sent[0].text, /no open positions/);
  });

  test('flags isolated margin separately and marks isolated positions', async () => {
    const account: AccountSnapshot = {
      ...emptyAccount(),
      equityX18: toX18('10'),
      isolatedMarginX18: toX18('40'),
      isolatedNotionalX18: toX18('120'),
      positions: [
        {
          productId: 90,
          symbol: 'WTI-PERP',
          assetClass: 'commodity',
          side: 'long',
          amount: toX18('1.2'),
          oraclePriceX18: toX18('99.155'),
          entryPriceX18: toX18('99.155'),
          notionalX18: toX18('120'),
          unrealizedPnlX18: -toX18('1.43'),
          fundingX18: 0n,
          leverage: 3,
          liquidationPriceX18: toX18('69.3193'),
          isolated: true,
          isolatedMarginX18: toX18('40'),
        },
      ],
    };
    const { telegram, sent } = fakeTelegram([message('/account')]);
    await runBot(baseOptions({ telegram, readAccount: async () => account }));
    assert.match(sent[0].text, /\+ \$40 locked in isolated positions below/);
    assert.match(sent[0].text, /WTI-PERP long \(isolated\)/);
    assert.match(sent[0].text, /-\$1\.43/);
  });

  test('passes the wallet\'s subaccount and the fetched markets through to readAccount', async () => {
    let seenSender: unknown;
    let seenMarkets: unknown;
    const markets = new Map<string, MarketMeta>([
      ['WTI-PERP', { productId: 90, symbol: 'WTI-PERP', assetClass: 'commodity' } as MarketMeta],
    ]);
    const { telegram } = fakeTelegram([message('/account')]);
    await runBot(
      baseOptions({
        telegram,
        getMarkets: async () => markets,
        readAccount: async (sender, m) => ((seenSender = sender), (seenMarkets = m), emptyAccount()),
      }),
    );
    assert.equal(seenSender, '0x72819631edda427c4a23e412e3fa2598937d2e1664656661756c740000000000');
    assert.equal(seenMarkets, markets);
  });
});

describe('/buy and /sell access control', () => {
  test('refuses to prepare an order for a user not on the allowlist', async () => {
    let called = false;
    const tools = fakeTools({ prepareOrder: async () => ((called = true), { ok: false, reason: 'x' }) });
    const { telegram, sent } = fakeTelegram([message('/buy 100 gold', { userId: 99 })]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.equal(called, false);
    assert.match(sent[0].text, /Not authorised to trade/);
    assert.match(sent[0].text, /99/);
  });

  test('rejects a non-numeric amount before calling prepareOrder', async () => {
    let called = false;
    const tools = fakeTools({ prepareOrder: async () => ((called = true), { ok: false, reason: 'x' }) });
    const { telegram, sent } = fakeTelegram([message('/buy lots gold', { userId: 1 })]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.equal(called, false);
    assert.match(sent[0].text, /usage: \/buy 120 gold/);
  });

  test('rejects a non-positive amount', async () => {
    const { telegram, sent } = fakeTelegram([message('/buy -50 gold', { userId: 1 })]);
    await runBot(baseOptions({ telegram, allowedUserIds: new Set([1]) }));
    assert.match(sent[0].text, /usage: \/sell 120 gold|usage: \/buy 120 gold/);
  });

  test('rejects a missing market', async () => {
    const { telegram, sent } = fakeTelegram([message('/buy 100', { userId: 1 })]);
    await runBot(baseOptions({ telegram, allowedUserIds: new Set([1]) }));
    assert.match(sent[0].text, /usage: \/buy 120 gold/);
  });

  test('an authorised /sell maps to side "sell" and shows the prepared summary on success', async () => {
    let seenParams: PrepareParams | undefined;
    const tools = fakeTools({
      prepareOrder: async (params) => {
        seenParams = params;
        return {
          ok: true,
          pending: {
            token: 'tok-1',
            prepared: { builderFeeQuote: '0.12' } as never,
            market: {} as MarketMeta,
            summary: 'sell 100 XAUT-PERP @ 4300',
            createdAt: Date.now(),
          },
        };
      },
    });
    const { telegram, sent } = fakeTelegram([message('/sell 100 gold', { userId: 1 })]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.equal(seenParams?.side, 'sell');
    assert.equal(seenParams?.market, 'gold');
    assert.equal(seenParams?.notionalUsd, 100);
    assert.match(sent[0].text, /PREPARED — not sent\./);
    assert.match(sent[0].text, /\/confirm tok-1/);
  });

  test('surfaces prepareOrder\'s reason verbatim on failure, not a generic error', async () => {
    const tools = fakeTools({
      prepareOrder: async () => ({ ok: false, reason: 'XAUT-PERP is closed right now.' }),
    });
    const { telegram, sent } = fakeTelegram([message('/buy 100 gold', { userId: 1 })]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.equal(sent[0].text, 'XAUT-PERP is closed right now.');
  });
});

describe('/confirm access control', () => {
  test('refuses a user not on the allowlist without ever calling confirmOrder', async () => {
    let called = false;
    const tools = fakeTools({ confirmOrder: async () => ((called = true), 'placed') });
    const { telegram, sent } = fakeTelegram([message('/confirm abc', { userId: 99 })]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.equal(called, false);
    assert.equal(sent[0].text, 'Not authorised to trade.');
  });

  test('requires a token argument', async () => {
    const { telegram, sent } = fakeTelegram([message('/confirm', { userId: 1 })]);
    await runBot(baseOptions({ telegram, allowedUserIds: new Set([1]) }));
    assert.match(sent[0].text, /usage: \/confirm <token>/);
  });

  test('passes the token through and relays confirmOrder\'s result', async () => {
    let seenToken: unknown;
    const tools = fakeTools({
      confirmOrder: async (token) => ((seenToken = token), 'Placed. digest 0xabc'),
    });
    const { telegram, sent } = fakeTelegram([message('/confirm abc-123', { userId: 1 })]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.equal(seenToken, 'abc-123');
    assert.equal(sent[0].text, 'Placed. digest 0xabc');
  });
});

describe('per-chat ordering', () => {
  test('a /buy followed by /confirm in the same chat is handled in order', async () => {
    const calls: string[] = [];
    const tools = fakeTools({
      prepareOrder: async () => {
        calls.push('prepare');
        return {
          ok: true,
          pending: {
            token: 'tok-2',
            prepared: { builderFeeQuote: '0' } as never,
            market: {} as MarketMeta,
            summary: 'buy 100 XAUT-PERP',
            createdAt: Date.now(),
          },
        };
      },
      confirmOrder: async () => {
        calls.push('confirm');
        return 'Placed.';
      },
    });
    const { telegram, sent } = fakeTelegram([
      message('/buy 100 gold', { userId: 1, chatId: 5 }),
      message('/confirm tok-2', { userId: 1, chatId: 5 }),
    ]);
    await runBot(baseOptions({ telegram, tools, allowedUserIds: new Set([1]) }));
    assert.deepEqual(calls, ['prepare', 'confirm']);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /PREPARED/);
    assert.equal(sent[1].text, 'Placed.');
  });

  test('messages in different chats do not block each other\'s replies', async () => {
    const { telegram, sent } = fakeTelegram([
      message('/help', { chatId: 1 }),
      message('/help', { chatId: 2 }),
    ]);
    await runBot(baseOptions({ telegram }));
    assert.deepEqual(
      sent.map((s) => s.chatId).sort(),
      [1, 2],
    );
  });
});

describe('free text without a copilot configured', () => {
  test('a bare market name is answered with its price, not refused', async () => {
    const markets = new Map<string, MarketMeta>([
      ['XAUT-PERP', { productId: 28, symbol: 'XAUT-PERP', assetClass: 'commodity' } as MarketMeta],
    ]);
    const tools = fakeTools({ getPrice: async () => 'XAUT-PERP bid 4300 ask 4301' });
    const { telegram, sent } = fakeTelegram([message('gold')]);
    await runBot(baseOptions({ telegram, tools, getMarkets: async () => markets }));
    assert.match(sent[0].text, /XAUT-PERP bid 4300 ask 4301/);
    assert.match(sent[0].text, /Conversational mode is off/);
  });

  test('unresolvable free text falls back to the help text', async () => {
    const { telegram, sent } = fakeTelegram([message('what a nice day')]);
    await runBot(baseOptions({ telegram, getMarkets: async () => new Map() }));
    assert.match(sent[0].text, /^Conversational mode is off\. RoboNado/);
  });
});

describe('free text with a copilot configured', () => {
  test('delegates to copilot.ask and relays its answer', async () => {
    const copilot = { ask: async (text: string) => `you said: ${text}` } as never;
    const { telegram, sent } = fakeTelegram([message('how exposed am I to gold?')]);
    await runBot(baseOptions({ telegram, copilot }));
    assert.equal(sent[0].text, 'you said: how exposed am I to gold?');
  });

  test('a MarketClosedError from the copilot is shown as its message, not a crash', async () => {
    const copilot = {
      ask: async () => {
        throw new MarketClosedError({ symbol: 'EURUSD-PERP' } as MarketMeta, 'FX is closed for the weekend.');
      },
    } as never;
    const { telegram, sent } = fakeTelegram([message('short the euro')]);
    await runBot(baseOptions({ telegram, copilot }));
    assert.equal(sent[0].text, 'FX is closed for the weekend.');
  });

  test('a NadoApiError from the copilot is shown as its message, not a crash', async () => {
    const copilot = {
      ask: async () => {
        throw new NadoApiError(2011, 'stale nonce');
      },
    } as never;
    const { telegram, sent } = fakeTelegram([message('buy some oil')]);
    await runBot(baseOptions({ telegram, copilot }));
    assert.match(sent[0].text, /stale nonce/);
  });

  test('an unrelated error is not swallowed as a market-closed or API message', async () => {
    const copilot = {
      ask: async () => {
        throw new Error('boom');
      },
    } as never;
    const { telegram, sent } = fakeTelegram([message('anything', { chatId: 7 })]);
    await runBot(baseOptions({ telegram, copilot }));
    // Re-thrown past the per-command try/catch, it is caught by the outer
    // per-chat handler in runBot's main loop and reported generically.
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Something broke: boom/);
  });
});
