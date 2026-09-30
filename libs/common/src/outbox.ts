import { Logger, type OnApplicationBootstrap, type OnModuleDestroy, type Provider } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { envelope, EVENT_DESTINATIONS, type EventEnvelope, type EventName } from './events.js';
import { withInternalToken } from './internal-auth.js';
import type { ServiceToken } from './services.js';

/**
 * Transactional outbox.
 *
 * Instead of emitting an event right after a database write (and losing it
 * if the process crashes in between, or the consumer is down), the event is
 * inserted into the service's own "OutboxEvent" table in the SAME
 * transaction as the business change. A relay then delivers pending rows
 * with request/reply (so it knows the consumer processed them) and retries
 * with backoff until it succeeds. Delivery is at-least-once: consumers must
 * be idempotent (notification de-duplicates on eventId).
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

/** Rows to insert (inside your transaction) for one event: one per destination. */
export function outboxRows<T>(eventName: EventName, data: T): OutboxRow[] {
  const message = envelope(data);
  return EVENT_DESTINATIONS[eventName].map((destination) => ({
    eventId: message.eventId,
    eventName,
    destination,
    payload: message as unknown as JsonObject,
  }));
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
  destination: ServiceToken;
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

  constructor(
    private readonly db: RawSqlClient,
    private readonly clients: Partial<Record<ServiceToken, ClientProxy>>,
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

  private async deliver(row: ClaimedRow) {
    const client = this.clients[row.destination];
    try {
      if (!client) throw new Error(`No client registered for destination ${row.destination}`);
      await firstValueFrom(
        client.send(row.eventName, withInternalToken(row.payload)).pipe(timeout(DELIVERY_TIMEOUT_MS)),
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
        `Delivering ${row.eventName} (${row.eventId}) to ${row.destination} failed (attempt ${attempts}), retry in ${delay}s: ${message(err)}`,
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
 * Nest provider for the relay. `prisma` is the service's PrismaService class;
 * `destinations` are the ServiceTokens its events go to (already registered
 * with tcpClients()).
 */
export function outboxRelayProvider(prisma: unknown, destinations: ServiceToken[]): Provider {
  return {
    provide: OutboxRelay,
    inject: [prisma as never, ...destinations],
    useFactory: (db: RawSqlClient, ...clients: ClientProxy[]) =>
      new OutboxRelay(db, Object.fromEntries(destinations.map((d, i) => [d, clients[i]]))),
  };
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return JSON.stringify(err);
}
