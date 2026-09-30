import { Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { envelope } from './events.js';

const logger = new Logger('publish');

/**
 * Publish an event (fire-and-forget).
 *
 * NestJS `emit()` sends immediately; we subscribe only to log failures.
 * With plain TCP, if the consumer is down the event is simply LOST —
 * nothing retries it. That is the main reason real systems put a broker
 * (RabbitMQ, NATS, Kafka) in the middle. Try it: stop the notification
 * service, check in, start it again — the alert never arrives.
 */
export function publish<T>(client: ClientProxy, event: string, data: T): void {
  const message = envelope(data);
  client.emit(event, message).subscribe({
    error: (err: unknown) =>
      logger.warn(
        `Event "${event}" (${message.eventId}) was not delivered: ${
          err instanceof Error ? err.message : JSON.stringify(err)
        }`,
      ),
  });
}
