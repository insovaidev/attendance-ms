import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
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

  // ---- Events: @EventPattern handlers return nothing to the sender ----

  @EventPattern(EVENTS.USER_REGISTERED)
  onUserRegistered(@Payload() event: EventEnvelope<UserRegisteredEvent>) {
    return this.notifications.onUserRegistered(event);
  }

  @EventPattern(EVENTS.SHIFT_ASSIGNED)
  onShiftAssigned(@Payload() event: EventEnvelope<ShiftAssignedEvent>) {
    return this.notifications.onShiftAssigned(event);
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_IN)
  onCheckedIn(@Payload() event: EventEnvelope<AttendanceCheckedInEvent>) {
    return this.notifications.onCheckedIn(event);
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_OUT)
  onCheckedOut(@Payload() event: EventEnvelope<AttendanceCheckedOutEvent>) {
    return this.notifications.onCheckedOut(event);
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
    return { service: 'notification', ok: true };
  }
}
