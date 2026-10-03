import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, KafkaContext, MessagePattern, Payload, Transport } from '@nestjs/microservices';
import {
  consumeEvent,
  CONSUMER_GROUPS,
  EVENTS,
  HEALTH_PATTERN,
  NOTIFICATION_PATTERNS,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type LinkTelegramPayload,
  type ShiftAssignedEvent,
  type UserRegisteredEvent,
} from '#common';
import { NotificationService } from './notification.service.js';

const GROUP = CONSUMER_GROUPS.NOTIFICATION;

@Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  // ---- Events, from Kafka ---------------------------------------------------
  // @EventPattern(topic, Transport.KAFKA): subscribe this consumer group to the
  // topic. Nothing is sent back to the publisher. consumeEvent() checks the
  // signature, retries a failing handler, and parks it in "notification.dlq"
  // if it keeps failing, so one bad message can't block the partition.

  @EventPattern(EVENTS.USER_REGISTERED, Transport.KAFKA)
  onUserRegistered(@Ctx() ctx: KafkaContext) {
    return consumeEvent<UserRegisteredEvent>(ctx, GROUP, (e) => this.notifications.onUserRegistered(e));
  }

  @EventPattern(EVENTS.SHIFT_ASSIGNED, Transport.KAFKA)
  onShiftAssigned(@Ctx() ctx: KafkaContext) {
    return consumeEvent<ShiftAssignedEvent>(ctx, GROUP, (e) => this.notifications.onShiftAssigned(e));
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_IN, Transport.KAFKA)
  onCheckedIn(@Ctx() ctx: KafkaContext) {
    return consumeEvent<AttendanceCheckedInEvent>(ctx, GROUP, (e) => this.notifications.onCheckedIn(e));
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_OUT, Transport.KAFKA)
  onCheckedOut(@Ctx() ctx: KafkaContext) {
    return consumeEvent<AttendanceCheckedOutEvent>(ctx, GROUP, (e) => this.notifications.onCheckedOut(e));
  }

  // ---- Requests, over TCP: @MessagePattern handlers reply to the caller ----

  @MessagePattern(NOTIFICATION_PATTERNS.LINK_TELEGRAM, Transport.TCP)
  linkTelegram(@Payload() payload: LinkTelegramPayload) {
    return this.notifications.linkTelegram(payload);
  }

  @MessagePattern(NOTIFICATION_PATTERNS.LIST_LOG, Transport.TCP)
  listLog(@Payload() payload: { limit?: number }) {
    return this.notifications.listLog(payload.limit);
  }

  @MessagePattern(HEALTH_PATTERN, Transport.TCP)
  health() {
    return this.notifications.health();
  }
}
