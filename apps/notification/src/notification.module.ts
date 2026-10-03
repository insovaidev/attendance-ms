import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalAuthGuard } from '#common';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { PrismaService } from './prisma.service.js';
import { TelegramSender } from './telegram.sender.js';

// No clients: notification never calls anyone. It only receives
// (requests over TCP, events from Kafka).
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationService,
    TelegramSender,
    PrismaService,
    { provide: APP_GUARD, useClass: InternalAuthGuard },
  ],
})
export class NotificationModule {}
