import { Controller, Sse, type MessageEvent } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { interval, map, merge, Observable } from 'rxjs';
import {
  EVENTS,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type EventEnvelope,
} from '#common';
import { Roles } from '../auth/decorators.js';
import { LiveEventsService } from './live-events.service.js';

/**
 * One controller, two worlds:
 *  - @EventPattern: receives TCP events from the attendance service
 *  - @Sse:          streams them to browsers (the live dashboard)
 *
 * Try:  curl -N "http://localhost:3000/attendance/live?token=<admin token>"
 */
@Controller()
export class LiveEventsController {
  constructor(private readonly live: LiveEventsService) {}

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_IN)
  onCheckedIn(@Payload() event: EventEnvelope<AttendanceCheckedInEvent>) {
    this.live.push(EVENTS.ATTENDANCE_CHECKED_IN, event.data);
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_OUT)
  onCheckedOut(@Payload() event: EventEnvelope<AttendanceCheckedOutEvent>) {
    this.live.push(EVENTS.ATTENDANCE_CHECKED_OUT, event.data);
  }

  @Roles('ADMIN')
  @Sse('attendance/live')
  stream(): Observable<MessageEvent> {
    // A heartbeat every 25s keeps proxies (Nginx) from closing idle connections.
    const heartbeat = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(this.live.asObservable(), heartbeat);
  }
}
