import 'reflect-metadata';
import { bootstrapHybridService, CONSUMER_GROUPS, SERVICES } from '#common';
import { NotificationModule } from './notification.module.js';

// TCP for requests from the gateway, Kafka for events.
// Run two copies and they split the topic partitions between them
// (same consumer group = shared work).
await bootstrapHybridService(NotificationModule, SERVICES.NOTIFICATION, 'NotificationService', {
  groupId: CONSUMER_GROUPS.NOTIFICATION,
  // A brand-new group starts at the oldest message still in the topic.
  // After that, it continues from its committed offset.
  fromBeginning: true,
});
