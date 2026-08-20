/**
 * Minimal Telegram Bot API client — long polling, no dependencies.
 *
 * Written directly against the HTTP API rather than pulling in a framework:
 * this process holds a signing key, so every line between an inbound message
 * and an order should be readable in one sitting.
 */

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface Update {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramBot {
  private readonly base: string;
  private offset = 0;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? 'failed'}`);
    return json.result as T;
  }

  async getMe(): Promise<TelegramUser & { username: string }> {
    return this.call('getMe');
  }

  /** Telegram splits anything over 4096 characters. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += 4000) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: text.slice(i, i + 4000),
        disable_web_page_preview: true,
      });
    }
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  /**
   * Long-polls for messages. `offset` acknowledges everything already seen, so
   * a restart does not replay old commands — which for a trading bot would
   * mean re-running an order the user sent before it went down.
   */
  async *messages(signal?: AbortSignal): AsyncGenerator<TelegramMessage> {
    // Discard anything queued while the bot was offline.
    const backlog = await this.call<Update[]>('getUpdates', { timeout: 0, offset: -1 });
    if (backlog.length) this.offset = backlog[backlog.length - 1].update_id + 1;

    while (!signal?.aborted) {
      let updates: Update[];
      try {
        updates = await this.call<Update[]>('getUpdates', {
          offset: this.offset,
          timeout: 30,
        });
      } catch (err) {
        if (signal?.aborted) return;
        console.error(`poll failed, retrying: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        if (update.message?.text) yield update.message;
      }
    }
  }
}
