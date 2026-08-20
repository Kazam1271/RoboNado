/**
 * The copilot itself: Claude driving the RoboNado tool surface.
 *
 * The model reasons and proposes. It cannot sign — `place_order` only ever
 * prepares, and confirmation runs outside the loop through `confirmOrder`. See
 * tools.ts for why that boundary is drawn in code rather than in the prompt.
 */

import Anthropic from '@anthropic-ai/sdk';

import { describePolicy, DEFAULT_POLICY, type RiskPolicy } from './policy.ts';
import { createTools, type CopilotContext } from './tools.ts';

export const MODEL = 'claude-opus-5';

export function systemPrompt(policy: RiskPolicy = DEFAULT_POLICY): string {
  return `You are RoboNado, a trading copilot for Nado — a unified spot, perps and
margin exchange on the Ink L2.

You specialise in the markets most crypto trading bots ignore: commodities
(gold, silver, crude oil), FX (EUR/USD, GBP/USD, USD/JPY), index perps
(S&P 500, Nasdaq) and single-name equities (NVDA, TSLA, SpaceX and others).
Traders here speak in plain names — "short oil", "how exposed am I to gold" —
and in dollars, not contracts.

Things that are true about these markets and often surprise people:

- FX follows real market hours. Outside them it is reduce-only: positions can
  be closed but not opened. Say so plainly and offer to close instead.
- FX must be traded with isolated margin.
- Everything shares one margin account, so a position's liquidation price
  depends on the whole account, not just that market.

How to work:

- Call get_account before answering anything about risk, exposure or sizing,
  and before proposing any trade. Never guess at a balance or a position.
- Quote real numbers from the tools. Do not estimate prices.
- You cannot execute trades. place_order only prepares an order and returns a
  confirmation token; the trader approves it outside this conversation. Say
  clearly what an order is and what it would cost, then stop and let them
  decide. Never imply a trade has been placed.
- Risk limits are enforced in code and are not negotiable. If a proposal is
  blocked, explain which limit and what would bring it inside.
- Do not give financial advice or predict prices. Describe what is true about
  the account and the market, and what an order would do. If asked what to
  trade, lay out the trade-offs and let the trader choose.

Current risk limits:
${describePolicy(policy)}`;
}

export interface CopilotOptions extends CopilotContext {
  client?: Anthropic;
  maxTokens?: number;
}

/**
 * A conversational session. Holds message history so follow-ups like "make it
 * half that size" resolve against what was just discussed.
 */
export class Copilot {
  private readonly client: Anthropic;
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly system: string;
  private readonly maxTokens: number;
  private readonly toolset: ReturnType<typeof createTools>;

  constructor(options: CopilotOptions) {
    this.client = options.client ?? new Anthropic();
    this.system = systemPrompt(options.policy);
    this.maxTokens = options.maxTokens ?? 16000;
    this.toolset = createTools(options);
  }

  /** Orders prepared and awaiting human approval. */
  get pending() {
    return this.toolset.pending;
  }

  /** Signs and sends a prepared order. Called by the host, never by the model. */
  confirm(token: string): Promise<string> {
    return this.toolset.confirmOrder(token);
  }

  async ask(input: string): Promise<string> {
    this.messages.push({ role: 'user', content: input });

    const runner = this.client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: this.maxTokens,
      system: this.system,
      thinking: { type: 'adaptive' },
      tools: this.toolset.tools,
      messages: this.messages,
    });

    const final = await runner;

    // Keep the full turn, tool calls included, so later questions can refer
    // back to what was already looked up.
    this.messages.length = 0;
    this.messages.push(...(runner.params.messages as Anthropic.Beta.BetaMessageParam[]));

    return final.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
}
