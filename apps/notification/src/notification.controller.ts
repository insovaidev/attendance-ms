import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  EVENTS,
  HEALTH_PATTERN,
  NOTIFICATION_PATTERNS,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type EventEnvelope,
  type LinkTelegramPayload,
  type ShiftAssignedEvent,
  type UserRegisteredEvent,
} from '#common';
import { NotificationService } from './notification.service.js';

@Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  // ---- Events --------------------------------------------------------------
  // Delivered by the publishers' outbox relays with request/reply, so the
  // relay knows the event was processed. Returning normally acknowledges it;
  // throwing makes the relay retry later (duplicates are ignored by eventId).

  @MessagePattern(EVENTS.USER_REGISTERED)
  onUserRegistered(@Payload() event: EventEnvelope<UserRegisteredEvent>) {
    return this.ack(this.notifications.onUserRegistered(event));
  }

  @MessagePattern(EVENTS.SHIFT_ASSIGNED)
  onShiftAssigned(@Payload() event: EventEnvelope<ShiftAssignedEvent>) {
    return this.ack(this.notifications.onShiftAssigned(event));
  }

  @MessagePattern(EVENTS.ATTENDANCE_CHECKED_IN)
  onCheckedIn(@Payload() event: EventEnvelope<AttendanceCheckedInEvent>) {
    return this.ack(this.notifications.onCheckedIn(event));
  }

  @MessagePattern(EVENTS.ATTENDANCE_CHECKED_OUT)
  onCheckedOut(@Payload() event: EventEnvelope<AttendanceCheckedOutEvent>) {
    return this.ack(this.notifications.onCheckedOut(event));
  }

  // ---- Requests: @MessagePattern handlers reply to the caller ----

  @MessagePattern(NOTIFICATION_PATTERNS.LINK_TELEGRAM)
  linkTelegram(@Payload() payload: LinkTelegramPayload) {
    return this.notifications.linkTelegram(payload);
  }

  @MessagePattern(NOTIFICATION_PATTERNS.LIST_LOG)
  listLog(@Payload() payload: { limit?: number }) {
    return this.notifications.listLog(payload.limit);
  }

  @MessagePattern(HEALTH_PATTERN)
  health() {
    return this.notifications.health();
  }

  private async ack(work: Promise<void>) {
    await work;
    return { ok: true };
  }
}
