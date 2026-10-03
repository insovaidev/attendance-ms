import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, KafkaContext, MessagePattern, Payload, Transport } from '@nestjs/microservices';
import {
  consumeEvent,
  CONSUMER_GROUPS,
  EVENTS,
  HEALTH_PATTERN,
  STATS_PATTERNS,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
} from '#common';
import { StatsService } from './stats.service.js';

@Controller()
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  // The same topics notification reads. Different consumer group, so both
  // services receive every event, and attendance didn't change at all.

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_IN, Transport.KAFKA)
  onCheckedIn(@Ctx() ctx: KafkaContext) {
    return consumeEvent<AttendanceCheckedInEvent>(ctx, CONSUMER_GROUPS.STATS, (e, meta) =>
      this.stats.onCheckedIn(e, meta),
    );
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_OUT, Transport.KAFKA)
  onCheckedOut(@Ctx() ctx: KafkaContext) {
    return consumeEvent<AttendanceCheckedOutEvent>(ctx, CONSUMER_GROUPS.STATS, (e, meta) =>
      this.stats.onCheckedOut(e, meta),
    );
  }

  @MessagePattern(STATS_PATTERNS.DAILY, Transport.TCP)
  daily(@Payload() payload: { date?: string }) {
    return this.stats.daily(payload.date);
  }

  @MessagePattern(HEALTH_PATTERN, Transport.TCP)
  health() {
    return this.stats.health();
  }
}
