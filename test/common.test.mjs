// Unit tests for the shared library (run with `npm test`, against the build in dist/).
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.INTERNAL_TOKEN = 'a'.repeat(64);
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

test('outboxRows creates one row per destination sharing one eventId', () => {
  const rows = common.outboxRows(common.EVENTS.ATTENDANCE_CHECKED_IN, { recordId: 'r1' });
  assert.equal(rows.length, common.EVENT_DESTINATIONS[common.EVENTS.ATTENDANCE_CHECKED_IN].length);
  for (const row of rows) {
    assert.equal(row.eventName, 'attendance.checked_in');
    assert.equal(row.payload.eventId, row.eventId);
    assert.deepEqual(row.payload.data, { recordId: 'r1' });
  }
});

test('backoffSeconds doubles and is capped at 5 minutes', () => {
  assert.equal(common.backoffSeconds(1), 2);
  assert.equal(common.backoffSeconds(3), 8);
  assert.equal(common.backoffSeconds(20), 300);
});

test('OutboxRelay marks a delivered row published and reschedules a failed one', async () => {
  const statements = [];
  const claimed = [
    { id: 'ok', eventId: 'e1', eventName: 'x', destination: 'NOTIFICATION_SERVICE', payload: {}, attempts: 0 },
    { id: 'bad', eventId: 'e2', eventName: 'x', destination: 'MISSING', payload: {}, attempts: 2 },
  ];
  const db = {
    $queryRawUnsafe: async () => claimed,
    $executeRawUnsafe: async (sql, ...values) => {
      statements.push({ sql, values });
      return 1;
    },
  };
  const { of } = await import('rxjs');
  const client = { send: () => of({ ok: true }) };
  const relay = new common.OutboxRelay(db, { NOTIFICATION_SERVICE: client });
  await relay.tick();

  const published = statements.find((s) => s.values[0] === 'ok');
  assert.match(published.sql, /"publishedAt" =/);
  const retried = statements.find((s) => s.values[0] === 'bad');
  assert.match(retried.sql, /"nextAttemptAt" =/);
  assert.equal(retried.values[1], 3); // attempts
  assert.equal(retried.values[3], 8); // backoff seconds for attempt 3
});

test('localParts converts a UTC instant to the company time zone', () => {
  // 2026-09-30T01:30Z is 08:30 in Asia/Phnom_Penh (UTC+7), a Wednesday.
  const local = common.localParts(new Date('2026-09-30T01:30:00Z'), 'Asia/Phnom_Penh');
  assert.deepEqual(local, { date: '2026-09-30', weekday: 3, minutes: 510 });
});
