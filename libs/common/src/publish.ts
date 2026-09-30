import { Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { envelope } from './events.js';
import { withInternalToken } from './internal-auth.js';

const logger = new Logger('publish');

/**
 * Publish an event (fire-and-forget, best effort).
 *
 * NestJS `emit()` sends immediately; we subscribe only to log failures.
 * With plain TCP, if the consumer is down the event is simply LOST.
 * Only use this for data that is fine to lose (the live SSE feed).
 * Events that must arrive go through the outbox (see outbox.ts).
 */
export function publish<T>(client: ClientProxy, event: string, data: T): void {
  const message = envelope(data);
  client.emit(event, withInternalToken(message)).subscribe({
    error: (err: unknown) =>
      logger.warn(
        `Event "${event}" (${message.eventId}) was not delivered: ${
          err instanceof Error ? err.message : JSON.stringify(err)
        }`,
      ),
  });
}
