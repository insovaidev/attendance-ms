import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { bootstrapHybridService, CONSUMER_GROUPS, SERVICES } from '#common';
import { StatsModule } from './stats.module.js';

// A NEW consumer group on every start ("stats-1a2b3c4d"), reading from the
// beginning. The group has no committed offsets, so Kafka hands it the whole
// retained log, and the in-memory numbers are rebuilt by replaying it.
//
// That is the trick: the log is the source of truth, and a read model is just
// a function of it. Compare with notification, which keeps ONE group name
// and continues where it stopped.
//
// Trade-offs: replay time grows with the log, numbers only go back as far as
// topic retention (KAFKA_RETENTION_DAYS), and old groups linger on the broker
// until offsets.retention.minutes (7 days by default) expires them.
await bootstrapHybridService(StatsModule, SERVICES.STATS, 'StatsService', {
  groupId: `${CONSUMER_GROUPS.STATS}-${randomUUID().slice(0, 8)}`,
  fromBeginning: true,
});
