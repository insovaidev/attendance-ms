/**
 * Events = facts that already happened. (client.emit, fire-and-forget)
 *
 * The publisher does not wait and does not care who is listening.
 * Name events in the past tense: "checked_in", not "check_in".
 *
 * Every event carries an eventId so consumers can ignore duplicates
 * (see NotificationService — it stores eventId with a unique index).
 */
export const EVENTS = {
  USER_REGISTERED: 'user.registered',
  SHIFT_ASSIGNED: 'shift.assigned',
  ATTENDANCE_CHECKED_IN: 'attendance.checked_in',
  ATTENDANCE_CHECKED_OUT: 'attendance.checked_out',
} as const;

export interface EventEnvelope<T> {
  eventId: string;
  occurredAt: string; // ISO timestamp
  data: T;
}

export interface UserRegisteredEvent {
  userId: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
}

export interface ShiftAssignedEvent {
  assignmentId: string;
  userId: string;
  shiftId: string;
  shiftName: string;
  startDate: string;
  endDate: string | null;
}

export type AttendanceStatus = 'ON_TIME' | 'LATE' | 'NO_SHIFT' | 'UNVERIFIED';

export interface AttendanceCheckedInEvent {
  recordId: string;
  userId: string;
  userName: string;
  shiftName: string | null;
  checkInAt: string;
  status: AttendanceStatus;
  lateMinutes: number;
  source: 'WEB' | 'TELEGRAM';
}

export interface AttendanceCheckedOutEvent {
  recordId: string;
  userId: string;
  userName: string;
  checkInAt: string;
  checkOutAt: string;
  workedMinutes: number;
  leftEarlyMinutes: number;
}

export function envelope<T>(data: T): EventEnvelope<T> {
  return { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), data };
}
