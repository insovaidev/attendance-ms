import 'reflect-metadata';
import { bootstrapTcpService, SERVICES } from '#common';
import { NotificationModule } from './notification.module.js';

await bootstrapTcpService(NotificationModule, SERVICES.NOTIFICATION, 'NotificationService');
