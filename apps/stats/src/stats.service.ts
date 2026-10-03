import { Injectable } from '@nestjs/common';
import {
  localParts,
  rpcError,
  type AttendanceCheckedInEvent,
  type AttendanceCheckedOutEvent,
  type AttendanceStatus,
  type EventEnvelope,
  type KafkaEventMeta,
} from '#common';

interface DayStats {
  checkedIn: number;
  checkedOut: number;
  byStatus: Record<AttendanceStatus, number>;
  bySource: Record<'WEB' | 'TELEGRAM', number>;
  /** Check-ins per local hour, "08" -> 5. */
  byHour: Record<string, number>;
  totalLateMinutes: number;
  totalWorkedMinutes: number;
  leftEarly: number;
  late: { userName: string; lateMinutes: number }[];
}

const emptyDay = (): DayStats => ({
  checkedIn: 0,
  checkedOut: 0,
  byStatus: { ON_TIME: 0, LATE: 0, NO_SHIFT: 0, UNVERIFIED: 0 },
  bySource: { WEB: 0, TELEGRAM: 0 },
  byHour: {},
  totalLateMinutes: 0,
  totalWorkedMinutes: 0,
  leftEarly: 0,
  late: [],
});

/**
 * A read model ("projection") built only from events.
 *
 * Attendance owns the records; this service never asks it anything. It folds
 * every attendance.* event into per-day counters, in memory. Kills and
 * restarts are fine: main.ts replays the topics from the beginning.
 */
@Injectable()
export class StatsService {
  private readonly days = new Map<string, DayStats>();
  /** At-least-once delivery means duplicates. Count each eventId once. */
  private readonly seen = new Set<string>();
  private readonly startedAt = new Date().toISOString();
  private consumed = 0;
  private duplicates = 0;
  /** Last offset applied per "topic[partition]": how far into the log we are. */
  private readonly positions: Record<string, string> = {};

  onCheckedIn({ eventId, data }: EventEnvelope<AttendanceCheckedInEvent>, meta: KafkaEventMeta) {
    if (!this.accept(eventId, meta)) return;
    const local = localParts(new Date(data.checkInAt));
    const day = this.day(local.date);
    day.checkedIn++;
    day.byStatus[data.status]++;
    day.bySource[data.source]++;
    const hour = String(Math.floor(local.minutes / 60)).padStart(2, '0');
    day.byHour[hour] = (day.byHour[hour] ?? 0) + 1;
    if (data.status === 'LATE') {
      day.totalLateMinutes += data.lateMinutes;
      day.late.push({ userName: data.userName, lateMinutes: data.lateMinutes });
    }
  }

  onCheckedOut({ eventId, data }: EventEnvelope<AttendanceCheckedOutEvent>, meta: KafkaEventMeta) {
    if (!this.accept(eventId, meta)) return;
    // Counted on the day of the check-in, like the attendance record itself.
    const day = this.day(localParts(new Date(data.checkInAt)).date);
    day.checkedOut++;
    day.totalWorkedMinutes += data.workedMinutes;
    if (data.leftEarlyMinutes > 0) day.leftEarly++;
  }

  daily(date?: string) {
    const target = date ?? localParts(new Date()).date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) throw rpcError(400, 'date must be YYYY-MM-DD');
    const day = this.days.get(target) ?? emptyDay();
    return {
      date: target,
      checkedIn: day.checkedIn,
      checkedOut: day.checkedOut,
      stillIn: day.checkedIn - day.checkedOut,
      byStatus: day.byStatus,
      bySource: day.bySource,
      byHour: day.byHour,
      averageLateMinutes: day.byStatus.LATE ? Math.round(day.totalLateMinutes / day.byStatus.LATE) : 0,
      averageWorkedMinutes: day.checkedOut ? Math.round(day.totalWorkedMinutes / day.checkedOut) : 0,
      leftEarly: day.leftEarly,
      mostLate: [...day.late].sort((a, b) => b.lateMinutes - a.lateMinutes).slice(0, 5),
      // How this answer was built: useful while learning, harmless otherwise.
      kafka: {
        eventsConsumed: this.consumed,
        duplicatesIgnored: this.duplicates,
        positions: this.positions,
        rebuiltSince: this.startedAt,
      },
    };
  }

  health() {
    return { service: 'stats', ok: true, eventsConsumed: this.consumed };
  }

  private accept(eventId: string, meta: KafkaEventMeta): boolean {
    this.positions[`${meta.topic}[${meta.partition}]`] = meta.offset;
    if (this.seen.has(eventId)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(eventId);
    this.consumed++;
    return true;
  }

  private day(date: string): DayStats {
    let day = this.days.get(date);
    if (!day) this.days.set(date, (day = emptyDay()));
    return day;
  }
}
