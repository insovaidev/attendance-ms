import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  EVENTS,
  hhmmToMinutes,
  localParts,
  publish,
  rpcError,
  SERVICES,
  SHIFT_PATTERNS,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type AttendanceStatus,
  type CheckInPayload,
  type CheckOutPayload,
  type ResolvedShift,
  type ResolveShiftPayload,
} from '#common';
import { Prisma } from './generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

const SHIFT_TIMEOUT_MS = Number(process.env.SHIFT_TIMEOUT_MS ?? 2000);

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVICES.SHIFT) private readonly shift: ClientProxy,
    @Inject(SERVICES.NOTIFICATION) private readonly notification: ClientProxy,
    @Inject(SERVICES.GATEWAY_EVENTS) private readonly gatewayEvents: ClientProxy,
  ) {}

  async checkIn({ user, source, note }: CheckInPayload) {
    const now = new Date();
    const local = localParts(now);
    const workDate = new Date(`${local.date}T00:00:00.000Z`);

    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { userId_workDate: { userId: user.id, workDate } },
    });
    if (existing) throw rpcError(409, 'You already checked in today');

    // ---- The synchronous call -------------------------------------------
    // Attendance cannot decide ON_TIME vs LATE without the shift engine.
    // If shift is slow or down we don't block the employee: we record the
    // check-in as UNVERIFIED. (Exercise: add a job that re-verifies these.)
    const { shift, reachable } = await this.resolveShift({ userId: user.id, at: now.toISOString() });

    const status: AttendanceStatus = !reachable
      ? 'UNVERIFIED'
      : !shift
        ? 'NO_SHIFT'
        : shift.lateMinutes > 0
          ? 'LATE'
          : 'ON_TIME';

    let record;
    try {
      record = await this.prisma.attendanceRecord.create({
        data: {
          userId: user.id,
          userName: user.name,
          workDate,
          shiftId: shift?.shiftId ?? null,
          shiftName: shift?.name ?? null,
          shiftEndTime: shift?.endTime ?? null,
          checkInAt: now,
          status,
          lateMinutes: shift?.lateMinutes ?? 0,
          source,
          note: note ?? null,
        },
      });
    } catch (err) {
      // Two check-ins at the same instant: the unique index wins the race.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw rpcError(409, 'You already checked in today');
      }
      throw err;
    }

    // ---- The asynchronous part ------------------------------------------
    // Attendance doesn't know or care what happens with this fact.
    // Note the TCP limitation: we must emit to each listener by name.
    // With a broker you'd publish ONCE and any number of services subscribe.
    const event: AttendanceCheckedInEvent = {
      recordId: record.id,
      userId: user.id,
      userName: user.name,
      shiftName: record.shiftName,
      checkInAt: record.checkInAt.toISOString(),
      status: record.status,
      lateMinutes: record.lateMinutes,
      source: record.source,
    };
    publish(this.notification, EVENTS.ATTENDANCE_CHECKED_IN, event);
    publish(this.gatewayEvents, EVENTS.ATTENDANCE_CHECKED_IN, event);

    return record;
  }

  async checkOut({ user }: CheckOutPayload) {
    const now = new Date();
    const local = localParts(now);
    const workDate = new Date(`${local.date}T00:00:00.000Z`);

    const record = await this.prisma.attendanceRecord.findUnique({
      where: { userId_workDate: { userId: user.id, workDate } },
    });
    if (!record) throw rpcError(404, 'You have not checked in today');
    if (record.checkOutAt) throw rpcError(409, 'You already checked out today');

    const leftEarlyMinutes = record.shiftEndTime
      ? Math.max(0, hhmmToMinutes(record.shiftEndTime) - local.minutes)
      : 0;

    const updated = await this.prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { checkOutAt: now, leftEarlyMinutes },
    });

    const event: AttendanceCheckedOutEvent = {
      recordId: updated.id,
      userId: user.id,
      userName: user.name,
      checkInAt: updated.checkInAt.toISOString(),
      checkOutAt: now.toISOString(),
      workedMinutes: Math.round((now.getTime() - updated.checkInAt.getTime()) / 60000),
      leftEarlyMinutes,
    };
    publish(this.notification, EVENTS.ATTENDANCE_CHECKED_OUT, event);
    publish(this.gatewayEvents, EVENTS.ATTENDANCE_CHECKED_OUT, event);

    return updated;
  }

  listMine(userId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(days, 366) * 86_400_000);
    return this.prisma.attendanceRecord.findMany({
      where: { userId, checkInAt: { gte: since } },
      orderBy: { checkInAt: 'desc' },
    });
  }

  listByDay(date?: string) {
    const day = date ?? localParts(new Date()).date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw rpcError(400, 'date must be YYYY-MM-DD');
    return this.prisma.attendanceRecord.findMany({
      where: { workDate: new Date(`${day}T00:00:00.000Z`) },
      orderBy: { checkInAt: 'asc' },
    });
  }

  private async resolveShift(
    payload: ResolveShiftPayload,
  ): Promise<{ shift: ResolvedShift | null; reachable: boolean }> {
    try {
      const shift = await firstValueFrom(
        this.shift
          .send<ResolvedShift | null>(SHIFT_PATTERNS.RESOLVE_FOR_USER, payload)
          .pipe(timeout(SHIFT_TIMEOUT_MS)),
      );
      return { shift, reachable: true };
    } catch (err) {
      this.logger.warn(
        `Shift service unavailable, recording check-in as UNVERIFIED: ${
          err instanceof Error ? err.message : JSON.stringify(err)
        }`,
      );
      return { shift: null, reachable: false };
    }
  }
}
