import { Injectable } from '@nestjs/common';
import {
  EVENTS,
  hhmmToMinutes,
  isHHMM,
  localParts,
  outboxRows,
  rpcError,
  type AssignShiftPayload,
  type CreateShiftPayload,
  type ResolvedShift,
  type ResolveShiftPayload,
  type ShiftAssignedEvent,
} from '#common';
import { Prisma } from './generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

@Injectable()
export class ShiftService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateShiftPayload) {
    if (!isHHMM(input.startTime) || !isHHMM(input.endTime)) {
      throw rpcError(400, 'startTime and endTime must be HH:MM (24h)');
    }
    const days = input.days ?? [1, 2, 3, 4, 5];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw rpcError(400, 'days must contain numbers 0 (Sunday) to 6 (Saturday)');
    }
    try {
      return await this.prisma.shift.create({
        data: {
          name: input.name.trim(),
          type: input.type,
          startTime: input.startTime,
          endTime: input.endTime,
          graceMinutes: input.graceMinutes ?? 10,
          days: [...new Set(days)].sort(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw rpcError(409, `A shift named "${input.name}" already exists`);
      }
      throw err;
    }
  }

  list() {
    return this.prisma.shift.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
  }

  async assign(input: AssignShiftPayload) {
    const shift = await this.prisma.shift.findUnique({ where: { id: input.shiftId } });
    if (!shift) throw rpcError(404, 'Shift not found');

    const startDate = parseDate(input.startDate, 'startDate');
    const endDate = input.endDate ? parseDate(input.endDate, 'endDate') : null;
    if (endDate && endDate < startDate) throw rpcError(400, 'endDate is before startDate');

    // NOTE: we trust that userId exists. We can't join to the auth DB, and
    // calling auth here would couple the two services. The gateway already
    // checks the user exists before sending this. (Exercise: what happens
    // if that user is deleted later? Who should clean up assignments?)
    // The assignment and its event are committed together (transactional outbox).
    const assignment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shiftAssignment.create({
        data: { userId: input.userId, shiftId: shift.id, startDate, endDate },
      });
      await tx.outboxEvent.createMany({
        data: outboxRows<ShiftAssignedEvent>(EVENTS.SHIFT_ASSIGNED, {
          assignmentId: created.id,
          userId: created.userId,
          shiftId: shift.id,
          shiftName: shift.name,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
        }),
      });
      return created;
    });

    return { ...assignment, shift };
  }

  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw rpcError(503, 'shift database unavailable');
    }
    return { service: 'shift', ok: true };
  }

  /**
   * The core of the shift engine: which shift applies to this user at this moment?
   *
   * Rules (kept simple on purpose — this is the part to grow):
   *  - FIXED:    an active assignment whose shift runs on this weekday.
   *  - ROTATING: same query — rotation is expressed as consecutive dated
   *              assignments (e.g. week 1 = Morning, week 2 = Night).
   *  - REMOTE:   resolved like FIXED but lateMinutes is always 0.
   *  - If several assignments overlap, the most recently started wins.
   *  - Overnight shifts (22:00 → 06:00) are NOT handled yet. See README exercises.
   */
  async resolveForUser({ userId, at }: ResolveShiftPayload): Promise<ResolvedShift | null> {
    const moment = new Date(at);
    if (Number.isNaN(moment.getTime())) throw rpcError(400, 'at must be an ISO timestamp');

    const local = localParts(moment);
    const day = new Date(`${local.date}T00:00:00.000Z`);

    const assignments = await this.prisma.shiftAssignment.findMany({
      where: {
        userId,
        startDate: { lte: day },
        OR: [{ endDate: null }, { endDate: { gte: day } }],
      },
      include: { shift: true },
      orderBy: { startDate: 'desc' },
    });

    const match = assignments.find((a) => a.shift.days.includes(local.weekday));
    if (!match) return null;

    const { shift } = match;
    const lateBy = local.minutes - (hhmmToMinutes(shift.startTime) + shift.graceMinutes);

    return {
      shiftId: shift.id,
      name: shift.name,
      type: shift.type,
      startTime: shift.startTime,
      endTime: shift.endTime,
      graceMinutes: shift.graceMinutes,
      lateMinutes: shift.type === 'REMOTE' ? 0 : Math.max(0, lateBy),
    };
  }
}

function parseDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw rpcError(400, `${field} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw rpcError(400, `${field} is not a valid date`);
  return date;
}
