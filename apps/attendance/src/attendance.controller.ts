import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ATTENDANCE_PATTERNS, HEALTH_PATTERN, type CheckInPayload, type CheckOutPayload } from '#common';
import { AttendanceService } from './attendance.service.js';

@Controller()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @MessagePattern(ATTENDANCE_PATTERNS.CHECK_IN)
  checkIn(@Payload() payload: CheckInPayload) {
    return this.attendance.checkIn(payload);
  }

  @MessagePattern(ATTENDANCE_PATTERNS.CHECK_OUT)
  checkOut(@Payload() payload: CheckOutPayload) {
    return this.attendance.checkOut(payload);
  }

  @MessagePattern(ATTENDANCE_PATTERNS.LIST_MINE)
  listMine(@Payload() payload: { userId: string; days?: number }) {
    return this.attendance.listMine(payload.userId, payload.days);
  }

  @MessagePattern(ATTENDANCE_PATTERNS.LIST_BY_DAY)
  listByDay(@Payload() payload: { date?: string }) {
    return this.attendance.listByDay(payload.date);
  }

  @MessagePattern(HEALTH_PATTERN)
  health() {
    return this.attendance.health();
  }
}
