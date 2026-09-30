import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { PrismaService } from './prisma.service.js';
import { TelegramSender } from './telegram.sender.js';

// No clients: notification never calls anyone. It only listens.
@Module({
  controllers: [NotificationController],
  providers: [NotificationService, TelegramSender, PrismaService],
})
export class NotificationModule {}
