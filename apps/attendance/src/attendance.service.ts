import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  EVENTS,
  hhmmToMinutes,
  localParts,
  outboxRows,
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
  withInternalToken,
} from '#common';
import { Prisma } from './generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

const SHIFT_TIMEOUT_MS = Number(process.env.SHIFT_TIMEOUT_MS ?? 2000);
/** How far back the re-verification job looks for UNVERIFIED check-ins. */
const REVERIFY_WINDOW_DAYS = 3;

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVICES.SHIFT) private readonly shift: ClientProxy,
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
    // check-in as UNVERIFIED; ReverifyJob fixes it once shift answers again.
    const { shift, reachable } = await this.resolveShift({ userId: user.id, at: now.toISOString() });

    const status = statusFor(shift, reachable);

    // ---- The asynchronous part ------------------------------------------
    // The record and its event are committed in one transaction (outbox),
    // so the event reaches Kafka even if Kafka is down right now or this
    // process crashes right after the insert.
    let record;
    try {
      record = await this.prisma.$transaction(async (tx) => {
        const created = await tx.attendanceRecord.create({
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
        await tx.outboxEvent.createMany({
          data: outboxRows(EVENTS.ATTENDANCE_CHECKED_IN, checkedInEvent(created)),
        });
        return created;
      });
    } catch (err) {
      // Two check-ins at the same instant: the unique index wins the race.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw rpcError(409, 'You already checked in today');
      }
      throw err;
    }

    // The live dashboard is best-effort: a missed SSE update is harmless.
    publish(this.gatewayEvents, EVENTS.ATTENDANCE_CHECKED_IN, checkedInEvent(record));

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

    const event: AttendanceCheckedOutEvent = {
      recordId: record.id,
      userId: user.id,
      userName: user.name,
      checkInAt: record.checkInAt.toISOString(),
      checkOutAt: now.toISOString(),
      workedMinutes: Math.round((now.getTime() - record.checkInAt.getTime()) / 60000),
      leftEarlyMinutes,
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      // "checkOutAt: null" makes the update conditional, so two check-outs
      // racing each other can't both succeed.
      const { count } = await tx.attendanceRecord.updateMany({
        where: { id: record.id, checkOutAt: null },
        data: { checkOutAt: now, leftEarlyMinutes },
      });
      if (count === 0) throw rpcError(409, 'You already checked out today');
      await tx.outboxEvent.createMany({
        data: outboxRows(EVENTS.ATTENDANCE_CHECKED_OUT, event),
      });
      return tx.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    });

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

  /** Re-asks shift about recent UNVERIFIED check-ins. Returns how many were fixed. */
  async reverifyUnverified(limit = 50): Promise<number> {
    const since = new Date(Date.now() - REVERIFY_WINDOW_DAYS * 86_400_000);
    const pending = await this.prisma.attendanceRecord.findMany({
      where: { status: 'UNVERIFIED', checkInAt: { gte: since } },
      orderBy: { checkInAt: 'asc' },
      take: limit,
    });

    let fixed = 0;
    for (const record of pending) {
      const { shift, reachable } = await this.resolveShift({
        userId: record.userId,
        at: record.checkInAt.toISOString(),
      });
      if (!reachable) break; // shift is still down; try again next round
      const { count } = await this.prisma.attendanceRecord.updateMany({
        where: { id: record.id, status: 'UNVERIFIED' },
        data: {
          status: statusFor(shift, true),
          shiftId: shift?.shiftId ?? null,
          shiftName: shift?.name ?? null,
          shiftEndTime: shift?.endTime ?? null,
          lateMinutes: shift?.lateMinutes ?? 0,
        },
      });
      fixed += count;
    }
    return fixed;
  }

  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw rpcError(503, 'attendance database unavailable');
    }
    return { service: 'attendance', ok: true };
  }

  private async resolveShift(
    payload: ResolveShiftPayload,
  ): Promise<{ shift: ResolvedShift | null; reachable: boolean }> {
    try {
      const shift = await firstValueFrom(
        this.shift
          .send<ResolvedShift | null>(SHIFT_PATTERNS.RESOLVE_FOR_USER, withInternalToken(payload))
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

function statusFor(shift: ResolvedShift | null, reachable: boolean): AttendanceStatus {
  if (!reachable) return 'UNVERIFIED';
  if (!shift) return 'NO_SHIFT';
  return shift.lateMinutes > 0 ? 'LATE' : 'ON_TIME';
}

function checkedInEvent(record: {
  id: string;
  userId: string;
  userName: string;
  shiftName: string | null;
  checkInAt: Date;
  status: AttendanceStatus;
  lateMinutes: number;
  source: 'WEB' | 'TELEGRAM';
}): AttendanceCheckedInEvent {
  return {
    recordId: record.id,
    userId: record.userId,
    userName: record.userName,
    shiftName: record.shiftName,
    checkInAt: record.checkInAt.toISOString(),
    status: record.status,
    lateMinutes: record.lateMinutes,
    source: record.source,
  };
}
