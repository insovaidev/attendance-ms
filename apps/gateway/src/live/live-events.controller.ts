import { Controller, HttpCode, Post, Sse, type MessageEvent } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EventPattern, Payload } from '@nestjs/microservices';
import { interval, map, merge, Observable } from 'rxjs';
import {
  EVENTS,
  type AuthUser,
  type JwtPayload,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type EventEnvelope,
} from '#common';
import { AllowSseTicket, CurrentUser, Roles, SSE_TICKET_AUDIENCE } from '../auth/decorators.js';
import { LiveEventsService } from './live-events.service.js';

/**
 * One controller, two worlds:
 *  - @EventPattern: receives TCP events from the attendance service
 *  - @Sse:          streams them to browsers (the live dashboard)
 *
 * Try:
 *   TICKET=$(curl -s -X POST -H "Authorization: Bearer <admin token>" \
 *            localhost:3000/attendance/live/ticket | jq -r .ticket)
 *   curl -N "http://localhost:3000/attendance/live?ticket=$TICKET"
 */
@Controller()
export class LiveEventsController {
  constructor(
    private readonly live: LiveEventsService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * A 60-second ticket for opening the SSE stream. EventSource can't send an
   * Authorization header, and the real token must not end up in URLs/logs.
   */
  @Roles('ADMIN')
  @Post('attendance/live/ticket')
  @HttpCode(200)
  async ticket(@CurrentUser() user: AuthUser) {
    const payload: JwtPayload = { sub: user.id, email: user.email, name: user.name, role: user.role };
    const ticket = await this.jwt.signAsync(payload, { audience: SSE_TICKET_AUDIENCE, expiresIn: 60 });
    return { ticket, expiresIn: 60 };
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_IN)
  onCheckedIn(@Payload() event: EventEnvelope<AttendanceCheckedInEvent>) {
    this.live.push(EVENTS.ATTENDANCE_CHECKED_IN, event.data);
  }

  @EventPattern(EVENTS.ATTENDANCE_CHECKED_OUT)
  onCheckedOut(@Payload() event: EventEnvelope<AttendanceCheckedOutEvent>) {
    this.live.push(EVENTS.ATTENDANCE_CHECKED_OUT, event.data);
  }

  @Roles('ADMIN')
  @AllowSseTicket()
  @Sse('attendance/live')
  stream(): Observable<MessageEvent> {
    // A heartbeat every 25s keeps proxies (Nginx) from closing idle connections.
    const heartbeat = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(this.live.asObservable(), heartbeat);
  }
}
