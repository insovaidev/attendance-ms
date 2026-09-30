/**
 * Shapes passed between services. Only plain JSON crosses the wire —
 * no class instances, no Prisma models, no Dates (use ISO strings).
 */
export type Role = 'ADMIN' | 'EMPLOYEE';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** What the gateway puts in the JWT and attaches to req.user. */
export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

export interface RegisterPayload {
  email: string;
  password: string;
  name: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export type ShiftType = 'FIXED' | 'ROTATING' | 'REMOTE';

export interface CreateShiftPayload {
  name: string;
  type: ShiftType;
  startTime: string; // "08:00" in the company time zone
  endTime: string; // "17:00"
  graceMinutes?: number;
  days?: number[]; // 0 = Sunday ... 6 = Saturday
}

export interface AssignShiftPayload {
  shiftId: string;
  userId: string;
  startDate: string; // "2026-10-01"
  endDate?: string | null;
}

export interface ResolveShiftPayload {
  userId: string;
  at: string; // ISO timestamp of the check-in
}

/** Answer from the shift engine: the shift that applies at a moment, if any. */
export interface ResolvedShift {
  shiftId: string;
  name: string;
  type: ShiftType;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  /** Minutes after the grace period. 0 if on time. Remote shifts are never late. */
  lateMinutes: number;
}

export interface CheckInPayload {
  user: AuthUser;
  source: 'WEB' | 'TELEGRAM';
  note?: string;
}

export interface CheckOutPayload {
  user: AuthUser;
}

export interface LinkTelegramPayload {
  userId: string;
  chatId: string;
}
