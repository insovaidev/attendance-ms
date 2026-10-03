// Unit tests for the shared library (run with `npm test`, against the build in dist/).
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.INTERNAL_TOKEN = 'a'.repeat(64);
process.env.KAFKA_HANDLER_ATTEMPTS = '2';
const common = await import('#common');

test('requiredSecret rejects missing, short and placeholder values', () => {
  delete process.env.TEST_SECRET;
  assert.throws(() => common.requiredSecret('TEST_SECRET'), /not set/);
  process.env.TEST_SECRET = 'short';
  assert.throws(() => common.requiredSecret('TEST_SECRET'), /at least 32/);
  process.env.TEST_SECRET = 'change-me-to-a-long-random-string';
  assert.throws(() => common.requiredSecret('TEST_SECRET'), /random string/);
  process.env.TEST_SECRET = 'x'.repeat(40);
  assert.equal(common.requiredSecret('TEST_SECRET'), 'x'.repeat(40));
});

test('withInternalToken adds a token that isInternalTokenValid accepts', () => {
  const signed = common.withInternalToken({ userId: '1' });
  assert.equal(signed.userId, '1');
  assert.ok(common.isInternalTokenValid(signed._internal));
  assert.equal(common.isInternalTokenValid('b'.repeat(64)), false);
  assert.equal(common.isInternalTokenValid(undefined), false);
});

test('InternalAuthGuard strips a valid token and rejects a missing one', () => {
  const guard = new common.InternalAuthGuard();
  const ctx = (data) => ({
    getType: () => 'rpc',
    switchToRpc: () => ({ getData: () => data, getContext: () => ({ getPattern: () => 'test.pattern' }) }),
  });

  const good = common.withInternalToken({ a: 1 });
  assert.equal(guard.canActivate(ctx(good)), true);
  assert.deepEqual(good, { a: 1 });

  assert.throws(() => guard.canActivate(ctx({ a: 1 })), (err) => err.getError().status === 401);
  assert.equal(guard.canActivate({ getType: () => 'http' }), true);
});

test('outboxRows creates one Kafka row per event', () => {
  const rows = common.outboxRows(common.EVENTS.ATTENDANCE_CHECKED_IN, { recordId: 'r1' });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.eventName, 'attendance.checked_in');
  assert.equal(row.destination, common.OUTBOX_DESTINATION);
  assert.equal(row.payload.eventId, row.eventId);
  assert.deepEqual(row.payload.data, { recordId: 'r1' });
});

test('backoffSeconds doubles and is capped at 5 minutes', () => {
  assert.equal(common.backoffSeconds(1), 2);
  assert.equal(common.backoffSeconds(3), 8);
  assert.equal(common.backoffSeconds(20), 300);
});

test('OutboxRelay publishes to Kafka, marks rows published and reschedules failures', async () => {
  const statements = [];
  const event = (eventId) => ({ eventId, occurredAt: 'now', data: { userId: 'u1' } });
  const claimed = [
    { id: 'ok', eventId: 'e1', eventName: 'x', destination: 'kafka', payload: event('e1'), attempts: 0 },
    { id: 'bad', eventId: 'e2', eventName: 'x', destination: 'kafka', payload: event('e2'), attempts: 2 },
  ];
  const db = {
    $queryRawUnsafe: async () => claimed,
    $executeRawUnsafe: async (sql, ...values) => {
      statements.push({ sql, values });
      return 1;
    },
  };
  const { of, throwError } = await import('rxjs');
  const emitted = [];
  const kafka = {
    emit: (topic, message) => {
      emitted.push({ topic, message });
      return message.headers['x-event-id'] === 'e2' ? throwError(() => new Error('broker down')) : of([{}]);
    },
  };
  const relay = new common.OutboxRelay(db, kafka, async () => {});
  await relay.tick();

  assert.equal(emitted[0].topic, 'x');
  assert.equal(emitted[0].message.key, 'u1');

  const published = statements.find((s) => s.values[0] === 'ok');
  assert.match(published.sql, /"publishedAt" =/);
  const retried = statements.find((s) => s.values[0] === 'bad');
  assert.match(retried.sql, /"nextAttemptAt" =/);
  assert.equal(retried.values[1], 3); // attempts
  assert.equal(retried.values[3], 8); // backoff seconds for attempt 3
});

test('relay keeps rows in the outbox while topics cannot be created', async () => {
  let claimed = false;
  const db = { $queryRawUnsafe: async () => ((claimed = true), []), $executeRawUnsafe: async () => 1 };
  const relay = new common.OutboxRelay(db, {}, async () => {
    throw new Error('ECONNREFUSED');
  });
  await relay.tick();
  assert.equal(claimed, false);
});

test('toKafkaMessage keys by userId and signs the exact value', () => {
  const event = { eventId: 'e1', occurredAt: 'now', data: { userId: 'u1', name: 'A' } };
  const msg = common.toKafkaMessage(event);
  assert.equal(msg.key, 'u1');
  assert.equal(msg.value, JSON.stringify(event));
  assert.equal(msg.headers['x-event-id'], 'e1');
  assert.ok(common.isSignatureValid(Buffer.from(msg.value), msg.headers['x-signature']));
  assert.equal(common.isSignatureValid(Buffer.from(msg.value.replace('A', 'B')), msg.headers['x-signature']), false);
  assert.equal(common.isSignatureValid(Buffer.from(msg.value), undefined), false);
  assert.equal(common.toKafkaMessage({ eventId: 'e2', occurredAt: 'now', data: {} }).key, null);
});

/** A stand-in for Nest's KafkaContext, recording what goes to the DLQ. */
function fakeKafkaContext(message) {
  const sent = [];
  let heartbeats = 0;
  const ctx = {
    getMessage: () => message,
    getTopic: () => 'attendance.checked_in',
    getPartition: () => 1,
    getHeartbeat: () => async () => void heartbeats++,
    getProducer: () => ({ send: async (record) => void sent.push(record) }),
  };
  return { ctx, sent, heartbeats: () => heartbeats };
}

const signedMessage = (event) => {
  const { key, value, headers } = common.toKafkaMessage(event);
  return { key, value: Buffer.from(value), headers, offset: '7' };
};

test('consumeEvent passes a signed event to the handler', async () => {
  const event = { eventId: 'e1', occurredAt: 'now', data: { userId: 'u1' } };
  const { ctx, sent } = fakeKafkaContext(signedMessage(event));
  let got;
  await common.consumeEvent(ctx, 'notification', (e, meta) => (got = { e, meta }));
  assert.deepEqual(got.e, event);
  assert.deepEqual(got.meta, { topic: 'attendance.checked_in', partition: 1, offset: '7', key: 'u1' });
  assert.equal(sent.length, 0);
});

test('consumeEvent dead-letters an unsigned message without calling the handler', async () => {
  const { ctx, sent } = fakeKafkaContext({ key: null, value: Buffer.from('{"eventId":"x"}'), headers: {}, offset: '3' });
  let called = false;
  await common.consumeEvent(ctx, 'notification', () => (called = true));
  assert.equal(called, false);
  assert.equal(sent[0].topic, 'notification.dlq');
  assert.equal(sent[0].messages[0].headers['x-error'], 'invalid signature');
  assert.equal(sent[0].messages[0].headers['x-permanent'], 'true');
});

test('consumeEvent retries, then dead-letters with the error and origin', async () => {
  const { ctx, sent, heartbeats } = fakeKafkaContext(signedMessage({ eventId: 'e1', occurredAt: 'now', data: {} }));
  let calls = 0;
  await common.consumeEvent(ctx, 'notification', () => {
    calls++;
    throw new Error('Telegram down');
  });
  assert.equal(calls, 2); // KAFKA_HANDLER_ATTEMPTS
  assert.equal(heartbeats(), 1);
  const { headers } = sent[0].messages[0];
  assert.equal(sent[0].topic, 'notification.dlq');
  assert.equal(headers['x-error'], 'Telegram down');
  assert.equal(headers['x-permanent'], 'false');
  assert.equal(headers['x-original-topic'], 'attendance.checked_in');
  assert.equal(headers['x-original-offset'], '7');
  assert.ok(headers['x-signature'], 'original headers are kept, so the redriven message still verifies');
});

test('InternalAuthGuard lets Kafka messages through (they are checked by signature)', async () => {
  const { KafkaContext } = await import('@nestjs/microservices');
  const guard = new common.InternalAuthGuard();
  const kafkaCtx = new KafkaContext([{}, 0, 't', null, null, null]);
  const ctx = { getType: () => 'rpc', switchToRpc: () => ({ getData: () => ({}), getContext: () => kafkaCtx }) };
  assert.equal(guard.canActivate(ctx), true);
});

test('localParts converts a UTC instant to the company time zone', () => {
  // 2026-09-30T01:30Z is 08:30 in Asia/Phnom_Penh (UTC+7), a Wednesday.
  const local = common.localParts(new Date('2026-09-30T01:30:00Z'), 'Asia/Phnom_Penh');
  assert.deepEqual(local, { date: '2026-09-30', weekday: 3, minutes: 510 });
});
