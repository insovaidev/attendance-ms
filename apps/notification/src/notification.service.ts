import { Injectable, Logger } from '@nestjs/common';
import {
  COMPANY_TZ,
  EVENTS,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type EventEnvelope,
  type LinkTelegramPayload,
  type ShiftAssignedEvent,
  type UserRegisteredEvent,
} from '#common';
import { Prisma } from './generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import { TelegramSender } from './telegram.sender.js';

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || null;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramSender,
  ) {}

  async onUserRegistered({ eventId, data }: EventEnvelope<UserRegisteredEvent>) {
    // Nothing to send yet (they haven't linked Telegram), but we record it.
    await this.deliver(eventId, EVENTS.USER_REGISTERED, data.userId, null, `Welcome, ${data.name}!`);
  }

  async onShiftAssigned({ eventId, data }: EventEnvelope<ShiftAssignedEvent>) {
    const until = data.endDate ? ` until ${data.endDate}` : '';
    await this.deliver(
      eventId,
      EVENTS.SHIFT_ASSIGNED,
      data.userId,
      await this.chatFor(data.userId),
      `You have been assigned to the "${data.shiftName}" shift from ${data.startDate}${until}.`,
    );
  }

  async onCheckedIn({ eventId, data }: EventEnvelope<AttendanceCheckedInEvent>) {
    const time = formatTime(data.checkInAt);
    const shift = data.shiftName ? ` (${data.shiftName})` : '';
    const label: Record<AttendanceCheckedInEvent['status'], string> = {
      ON_TIME: 'on time',
      LATE: `late by ${data.lateMinutes} min`,
      NO_SHIFT: 'no shift scheduled today',
      UNVERIFIED: 'shift not verified yet',
    };

    await this.deliver(
      eventId,
      EVENTS.ATTENDANCE_CHECKED_IN,
      data.userId,
      await this.chatFor(data.userId),
      `Checked in at ${time}${shift}: ${label[data.status]}.`,
    );

    // Late arrivals also alert the admin chat. A second, independent reaction
    // to the same event — attendance didn't have to change to add this.
    if (data.status === 'LATE' && ADMIN_CHAT_ID) {
      await this.deliver(
        `${eventId}:admin`,
        EVENTS.ATTENDANCE_CHECKED_IN,
        data.userId,
        ADMIN_CHAT_ID,
        `${data.userName} checked in late (${data.lateMinutes} min) at ${time}${shift}.`,
      );
    }
  }

  async onCheckedOut({ eventId, data }: EventEnvelope<AttendanceCheckedOutEvent>) {
    const hours = Math.floor(data.workedMinutes / 60);
    const minutes = data.workedMinutes % 60;
    const early = data.leftEarlyMinutes > 0 ? ` Left ${data.leftEarlyMinutes} min early.` : '';
    await this.deliver(
      eventId,
      EVENTS.ATTENDANCE_CHECKED_OUT,
      data.userId,
      await this.chatFor(data.userId),
      `Checked out at ${formatTime(data.checkOutAt)}. Worked ${hours}h ${minutes}m.${early}`,
    );
  }

  linkTelegram({ userId, chatId }: LinkTelegramPayload) {
    return this.prisma.telegramLink.upsert({
      where: { userId },
      create: { userId, chatId },
      update: { chatId },
    });
  }

  listLog(limit = 50) {
    return this.prisma.notificationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  private async chatFor(userId: string): Promise<string | null> {
    const link = await this.prisma.telegramLink.findUnique({ where: { userId } });
    return link?.chatId ?? null;
  }

  /**
   * Idempotent delivery: "claim" the event by inserting its eventId first.
   * If the same event arrives twice (retries, redelivery from a broker),
   * the unique index rejects the second insert and we skip sending.
   */
  private async deliver(
    eventId: string,
    eventName: string,
    userId: string | null,
    chatId: string | null,
    message: string,
  ) {
    const willSend = Boolean(chatId) && this.telegram.enabled;

    let logId: string;
    try {
      const log = await this.prisma.notificationLog.create({
        data: { eventId, eventName, userId, chatId, message, status: willSend ? 'SENT' : 'SKIPPED' },
      });
      logId = log.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`Duplicate event ${eventId} (${eventName}) ignored`);
        return;
      }
      throw err;
    }

    if (!chatId) {
      this.logger.log(`[${eventName}] ${message} (no Telegram chat linked)`);
      return;
    }

    try {
      await this.telegram.send(chatId, message);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Telegram delivery failed for ${eventId}: ${error}`);
      await this.prisma.notificationLog.update({ where: { id: logId }, data: { status: 'FAILED', error } });
    }
  }
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: COMPANY_TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
