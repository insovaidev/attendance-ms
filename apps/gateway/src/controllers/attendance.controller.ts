import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ATTENDANCE_PATTERNS, SERVICES, type AuthUser, type CheckInPayload } from '#common';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { CheckInDto, DateQueryDto, DaysQueryDto } from '../dto.js';
import { call } from '../rpc.js';

@Controller('attendance')
export class AttendanceController {
  constructor(@Inject(SERVICES.ATTENDANCE) private readonly attendance: ClientProxy) {}

  @Post('check-in')
  checkIn(@CurrentUser() user: AuthUser, @Body() dto: CheckInDto) {
    // The gateway passes the verified user along, so attendance never
    // needs to call auth just to learn the user's name.
    const payload: CheckInPayload = { user, source: dto.source ?? 'WEB', note: dto.note };
    return call(this.attendance, ATTENDANCE_PATTERNS.CHECK_IN, payload);
  }

  @Post('check-out')
  checkOut(@CurrentUser() user: AuthUser) {
    return call(this.attendance, ATTENDANCE_PATTERNS.CHECK_OUT, { user });
  }

  @Get('me')
  mine(@CurrentUser() user: AuthUser, @Query() query: DaysQueryDto) {
    return call(this.attendance, ATTENDANCE_PATTERNS.LIST_MINE, { userId: user.id, days: query.days });
  }

  @Roles('ADMIN')
  @Get('day')
  byDay(@Query() query: DateQueryDto) {
    return call(this.attendance, ATTENDANCE_PATTERNS.LIST_BY_DAY, { date: query.date });
  }
}
