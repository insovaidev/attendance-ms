import { Logger, type OnApplicationBootstrap, type OnModuleDestroy, type Provider } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { envelope, type EventEnvelope, type EventName } from './events.js';
import { ensureTopics, KAFKA_PRODUCER, toKafkaMessage } from './kafka.js';

/**
 * Transactional outbox.
 *
 * Instead of emitting an event right after a database write (and losing it
 * if the process crashes in between, or the consumer is down), the event is
 * inserted into the service's own "OutboxEvent" table in the SAME
 * transaction as the business change. A relay then publishes pending rows
 * to Kafka (topic = event name) and retries with backoff until the broker
 * acknowledges them. Delivery is at-least-once: consumers must be
 * idempotent (notification de-duplicates on eventId).
 *
 * The relay doesn't know who consumes the events. Any number of consumer
 * groups can read the topic (notification, stats, ...), each at its own pace.
 *
 * Each publishing service needs this model in its schema.prisma:
 *
 *   model OutboxEvent { id, eventId, eventName, destination, payload Json,
 *                       attempts, nextAttemptAt, lockedUntil, publishedAt,
 *                       lastError, createdAt }
 */

/** Plain JSON, shaped so Prisma accepts it for a Json column. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OutboxRow {
  eventId: string;
  eventName: string;
  destination: string;
  payload: JsonObject;
}

/** Where outbox rows go. (Before Kafka, there was one row per consuming service.) */
export const OUTBOX_DESTINATION = 'kafka';

/** Rows to insert (inside your transaction) for one event. */
export function outboxRows<T>(eventName: EventName, data: T): OutboxRow[] {
  const message = envelope(data);
  return [
    {
      eventId: message.eventId,
      eventName,
      destination: OUTBOX_DESTINATION,
      payload: message as unknown as JsonObject,
    },
  ];
}

/** The raw-SQL surface of any generated PrismaClient. */
export interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface ClaimedRow {
  id: string;
  eventId: string;
  eventName: string;
  destination: string;
  payload: EventEnvelope<unknown>;
  attempts: number;
}

const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 1000);
const BATCH = Number(process.env.OUTBOX_BATCH ?? 20);
const DELIVERY_TIMEOUT_MS = Number(process.env.OUTBOX_DELIVERY_TIMEOUT_MS ?? 5000);
const RETENTION_DAYS = Number(process.env.OUTBOX_RETENTION_DAYS ?? 7);
const MAX_BACKOFF_S = 300;

/** 2s, 4s, 8s ... capped at 5 minutes. */
export const backoffSeconds = (attempts: number) => Math.min(2 ** Math.max(1, attempts), MAX_BACKOFF_S);

export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastCleanup = 0;
  private topicsReady = false;

  constructor(
    private readonly db: RawSqlClient,
    /** A ClientKafka (see kafkaProducer()). */
    private readonly kafka: ClientProxy,
    private readonly prepareTopics: () => Promise<void> = ensureTopics,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** One polling round. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.ensureTopics())) return;
      // Prisma stores DateTime as UTC "timestamp without time zone", hence timezone('utc', now()).
      // Claim a batch. SKIP LOCKED + lockedUntil let several replicas run
      // the relay without delivering the same row at the same time.
      const rows = await this.db.$queryRawUnsafe<ClaimedRow[]>(
        `UPDATE "OutboxEvent" SET "lockedUntil" = timezone('utc', now()) + interval '60 seconds'
         WHERE id IN (
           SELECT id FROM "OutboxEvent"
           WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= timezone('utc', now())
             AND ("lockedUntil" IS NULL OR "lockedUntil" < timezone('utc', now()))
           ORDER BY "createdAt" LIMIT $1
           FOR UPDATE SKIP LOCKED)
         RETURNING id, "eventId", "eventName", destination, payload, attempts`,
        BATCH,
      );
      for (const row of rows) await this.deliver(row);
      await this.cleanup();
    } catch (err) {
      this.logger.error(`Outbox poll failed: ${message(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** Topics must exist (with the right partition count) before the first publish. */
  private async ensureTopics(): Promise<boolean> {
    if (this.topicsReady) return true;
    try {
      await this.prepareTopics();
      this.topicsReady = true;
    } catch (err) {
      this.logger.warn(`Kafka not reachable yet, events stay in the outbox: ${message(err)}`);
    }
    return this.topicsReady;
  }

  private async deliver(row: ClaimedRow) {
    try {
      // emit() resolves once the broker has written the message to the
      // partition (acks from all in-sync replicas by default).
      await lastValueFrom(
        this.kafka.emit(row.eventName, toKafkaMessage(row.payload)).pipe(timeout(DELIVERY_TIMEOUT_MS)),
        { defaultValue: undefined },
      );
      await this.db.$executeRawUnsafe(
        `UPDATE "OutboxEvent" SET "publishedAt" = timezone('utc', now()), "lockedUntil" = NULL, attempts = attempts + 1, "lastError" = NULL
         WHERE id = $1::uuid`,
        row.id,
      );
    } catch (err) {
      const attempts = row.attempts + 1;
      const delay = backoffSeconds(attempts);
      this.logger.warn(
        `Publishing ${row.eventName} (${row.eventId}) to Kafka failed (attempt ${attempts}), retry in ${delay}s: ${message(err)}`,
      );
      await this.db.$executeRawUnsafe(
        `UPDATE "OutboxEvent" SET attempts = $2, "lastError" = $3, "lockedUntil" = NULL,
           "nextAttemptAt" = timezone('utc', now()) + make_interval(secs => $4)
         WHERE id = $1::uuid`,
        row.id,
        attempts,
        message(err).slice(0, 1000),
        delay,
      );
    }
  }

  private async cleanup() {
    if (Date.now() - this.lastCleanup < 3_600_000) return;
    this.lastCleanup = Date.now();
    await this.db.$executeRawUnsafe(
      `DELETE FROM "OutboxEvent" WHERE "publishedAt" < timezone('utc', now()) - make_interval(days => $1)`,
      RETENTION_DAYS,
    );
  }
}

/**
 * Nest provider for the relay. `prisma` is the service's PrismaService class.
 * The module must also import kafkaProducer(...).
 */
export function outboxRelayProvider(prisma: unknown): Provider {
  return {
    provide: OutboxRelay,
    inject: [prisma as never, KAFKA_PRODUCER],
    useFactory: (db: RawSqlClient, kafka: ClientProxy) => new OutboxRelay(db, kafka),
  };
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return JSON.stringify(err);
}
