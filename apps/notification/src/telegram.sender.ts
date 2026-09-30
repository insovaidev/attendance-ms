import { Injectable, Logger } from '@nestjs/common';

/**
 * Sends Telegram messages through the Bot API.
 * Without TELEGRAM_BOT_TOKEN it just logs, so the project runs with no setup.
 */
@Injectable()
export class TelegramSender {
  private readonly logger = new Logger('Telegram');
  private readonly token = process.env.TELEGRAM_BOT_TOKEN;

  get enabled(): boolean {
    return Boolean(this.token);
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.token) {
      this.logger.log(`(no bot token) would send to ${chatId}: ${text}`);
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
    }
  }
}
