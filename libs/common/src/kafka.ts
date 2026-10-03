import { Logger, type DynamicModule } from '@nestjs/common';
import { ClientsModule, Transport, type KafkaContext, type KafkaOptions } from '@nestjs/microservices';
import kafkajs from 'kafkajs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requiredSecret } from './config.js';
import { EVENTS, type EventEnvelope } from './events.js';

/**
 * Kafka: the durable event log between services.
 *
 * Request/response ("which shift is this user on?") stays on TCP.
 * Events ("this user checked in") go to Kafka:
 *
 *   attendance ──outbox relay──► topic "attendance.checked_in" ──► group "notification"
 *                                   (3 partitions, key = userId)  └─► group "stats"
 *
 * - A TOPIC is an append-only log. Messages are kept for days (retention),
 *   not deleted when read.
 * - A topic is split into PARTITIONS. Messages with the same KEY always land
 *   in the same partition, and order is only guaranteed inside a partition.
 *   We key every event by userId, so one person's check-in always comes
 *   before their check-out.
 * - A CONSUMER GROUP is one logical reader. Every group gets every message
 *   (fan-out); inside a group, each partition is read by one instance only
 *   (load balancing). The publisher never knows who is reading.
 * - Each group remembers how far it got (its committed OFFSET per partition).
 *   A consumer that was down simply continues from there.
 */
const { Kafka, Partitioners, logLevel } = kafkajs;
const logger = new Logger('Kafka');

export const kafkaBrokers = () =>
  (process.env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);

/** Every event name is also its topic name. */
export const EVENT_TOPICS: string[] = Object.values(EVENTS);

/** Consumer groups. Their names are what you see in kafka-ui / kafka-consumer-groups.sh. */
export const CONSUMER_GROUPS = {
  NOTIFICATION: 'notification',
  STATS: 'stats',
} as const;

/** Messages a group gave up on land here, with the error in the headers (see consumeEvent). */
export const dlqTopic = (group: string) => `${group}.dlq`;

/** Header names we add to every event message. */
export const KAFKA_HEADERS = {
  EVENT_ID: 'x-event-id',
  SIGNATURE: 'x-signature',
  ERROR: 'x-error',
  /** "true" when retrying can never help (bad signature, not JSON). Redrive skips these. */
  PERMANENT: 'x-permanent',
  ORIGINAL_TOPIC: 'x-original-topic',
  ORIGINAL_PARTITION: 'x-original-partition',
  ORIGINAL_OFFSET: 'x-original-offset',
} as const;

// ---- Producing -------------------------------------------------------------

/** Injection token for the Kafka producer (a Nest ClientKafka). */
export const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

/**
 * Registers a producer-only ClientKafka, injectable with
 *   @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka
 *
 * producerOnlyMode: a plain ClientKafka also starts a consumer to receive
 * replies to send(). We only emit() events, so we skip it.
 */
export function kafkaProducer(clientId: string): DynamicModule {
  return ClientsModule.register([
    {
      name: KAFKA_PRODUCER,
      transport: Transport.KAFKA,
      options: {
        client: { clientId, brokers: kafkaBrokers() },
        producerOnlyMode: true,
        producer: {
          // Topics are created on purpose by ensureTopics(), with the right
          // partition count, not by accident on the first message.
          allowAutoTopicCreation: false,
          // Same key -> same partition, with the murmur2 hash Java clients use.
          createPartitioner: Partitioners.DefaultPartitioner,
        },
      },
    },
  ]);
}

export interface KafkaOutgoingMessage {
  key: string | null;
  value: string;
  headers: Record<string, string>;
}

/**
 * Turns an event envelope into a Kafka message: { key, value, headers }.
 * ClientKafka.emit(topic, message) sends it as-is.
 */
export function toKafkaMessage(event: EventEnvelope<unknown>): KafkaOutgoingMessage {
  const value = JSON.stringify(event);
  const userId = (event.data as { userId?: unknown } | null)?.userId;
  return {
    key: typeof userId === 'string' ? userId : null,
    value,
    headers: {
      [KAFKA_HEADERS.EVENT_ID]: event.eventId,
      [KAFKA_HEADERS.SIGNATURE]: sign(value),
    },
  };
}

// ---- Signing ---------------------------------------------------------------
// Over TCP, every message carries INTERNAL_TOKEN in its body. Kafka keeps
// messages on disk for days, so we never put the secret itself in a message.
// Instead the producer adds an HMAC of the value, which proves the message
// came from a service that knows INTERNAL_TOKEN and was not altered.
// (In production you would also lock the broker down with SASL + ACLs.)

let cachedKey: Buffer | undefined;
const signingKey = () => (cachedKey ??= Buffer.from(requiredSecret('INTERNAL_TOKEN')));

export function sign(value: string | Buffer): string {
  return createHmac('sha256', signingKey()).update(value).digest('hex');
}

export function isSignatureValid(value: Buffer | string, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(value));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---- Topics ----------------------------------------------------------------

const PARTITIONS = Number(process.env.KAFKA_PARTITIONS ?? 3);
const REPLICATION = Number(process.env.KAFKA_REPLICATION_FACTOR ?? 1);
const RETENTION_DAYS = Number(process.env.KAFKA_RETENTION_DAYS ?? 30);

/**
 * Creates the event and dead-letter topics if they don't exist yet.
 * Safe to call from every service on every start (existing topics are left alone).
 */
export async function ensureTopics(): Promise<void> {
  const admin = new Kafka({ clientId: 'topic-admin', brokers: kafkaBrokers(), logLevel: logLevel.NOTHING }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const wanted = [...EVENT_TOPICS, ...Object.values(CONSUMER_GROUPS).map(dlqTopic)];
    const missing = wanted.filter((t) => !existing.has(t));
    if (missing.length === 0) return;
    await admin.createTopics({
      waitForLeaders: true,
      topics: missing.map((topic) => ({
        topic,
        numPartitions: PARTITIONS,
        replicationFactor: REPLICATION,
        // How long the log is kept. The stats service rebuilds itself by
        // replaying it, so this is also how far back its numbers can go.
        configEntries: [{ name: 'retention.ms', value: String(RETENTION_DAYS * 86_400_000) }],
      })),
    });
    logger.log(`Created topics: ${missing.join(', ')}`);
  } finally {
    await admin.disconnect();
  }
}

// ---- Consuming -------------------------------------------------------------

export interface KafkaConsumerConfig {
  /** Consumer group id. Instances with the same group share the work. */
  groupId: string;
  /** Where a group with no committed offset starts: the oldest message, or only new ones. */
  fromBeginning?: boolean;
}

/** Options for app.connectMicroservice({ transport: Transport.KAFKA, options }). */
export function kafkaConsumerOptions({ groupId, fromBeginning = true }: KafkaConsumerConfig): KafkaOptions['options'] {
  return {
    client: { clientId: groupId, brokers: kafkaBrokers() },
    consumer: { groupId, allowAutoTopicCreation: false },
    // Nest appends "-server" to the group id by default; we want the exact name.
    postfixId: '',
    subscribe: { fromBeginning },
    // Keep the value as raw bytes so consumeEvent() can check the signature
    // against exactly what the producer signed, then parse it itself.
    parser: { keepBinary: true },
    producer: { createPartitioner: Partitioners.DefaultPartitioner },
  };
}

const HANDLER_ATTEMPTS = Number(process.env.KAFKA_HANDLER_ATTEMPTS ?? 3);

export interface KafkaEventMeta {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
}

/**
 * Runs an @EventPattern handler for a Kafka message, safely.
 *
 * Why this exists: if a handler throws, Nest hands the error to kafkajs,
 * which retries the SAME message again and again. Nothing behind it in that
 * partition is processed meanwhile (a "poison pill" blocks the partition).
 * So instead:
 *
 *   1. Reject messages without a valid signature (to the dead-letter topic).
 *   2. Try the handler up to KAFKA_HANDLER_ATTEMPTS times, with a short backoff.
 *   3. Still failing? Publish the message to "<group>.dlq" with the error in
 *      its headers, and move on. Fix the cause, then `npm run kafka:redrive`.
 *
 * Returning normally lets kafkajs commit the offset ("done with this one").
 * Delivery is at-least-once, so handlers must ignore duplicate eventIds.
 */
export async function consumeEvent<T>(
  ctx: KafkaContext,
  group: string,
  handler: (event: EventEnvelope<T>, meta: KafkaEventMeta) => Promise<unknown> | unknown,
): Promise<void> {
  const message = ctx.getMessage();
  const meta: KafkaEventMeta = {
    topic: ctx.getTopic(),
    partition: ctx.getPartition(),
    offset: message.offset,
    key: message.key == null ? null : String(message.key),
  };
  const raw = message.value as Buffer | string | null;
  const where = `${meta.topic}[${meta.partition}]@${meta.offset}`;

  if (raw == null || !isSignatureValid(raw, header(message.headers, KAFKA_HEADERS.SIGNATURE))) {
    logger.warn(`${where}: missing or invalid signature, sent to ${dlqTopic(group)}`);
    return deadLetter(ctx, group, meta, 'invalid signature', true);
  }

  let event: EventEnvelope<T>;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return deadLetter(ctx, group, meta, 'value is not JSON', true);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await handler(event, meta);
      return;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (attempt >= HANDLER_ATTEMPTS) {
        logger.error(`${where} (${event.eventId}) failed ${attempt} times, sent to ${dlqTopic(group)}: ${error}`);
        return deadLetter(ctx, group, meta, error);
      }
      logger.warn(`${where} (${event.eventId}) failed (attempt ${attempt}), retrying: ${error}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      // Tell the broker we're alive, or it assumes we crashed and hands
      // our partitions to another instance (a "rebalance").
      await ctx.getHeartbeat()();
    }
  }
}

async function deadLetter(ctx: KafkaContext, group: string, meta: KafkaEventMeta, error: string, permanent = false) {
  const message = ctx.getMessage();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (value != null) headers[name] = String(value);
  }
  // If this throws (broker down), kafkajs retries the original message: nothing is lost.
  await ctx.getProducer().send({
    topic: dlqTopic(group),
    messages: [
      {
        key: meta.key,
        value: message.value as Buffer | string | null,
        headers: {
          ...headers,
          [KAFKA_HEADERS.ERROR]: error.slice(0, 1000),
          [KAFKA_HEADERS.PERMANENT]: String(permanent),
          [KAFKA_HEADERS.ORIGINAL_TOPIC]: meta.topic,
          [KAFKA_HEADERS.ORIGINAL_PARTITION]: String(meta.partition),
          [KAFKA_HEADERS.ORIGINAL_OFFSET]: meta.offset,
        },
      },
    ],
  });
}

function header(headers: Record<string, unknown> | undefined, name: string): unknown {
  const value = headers?.[name];
  return Buffer.isBuffer(value) ? value.toString() : value;
}
