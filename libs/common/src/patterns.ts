/**
 * Message patterns = the "API" of each service.
 *
 * Request/response (client.send)  -> the caller waits for an answer.
 * These are the service contracts; changing one is a breaking change for
 * every caller, exactly like changing a REST endpoint.
 */
export const AUTH_PATTERNS = {
  REGISTER: 'auth.register',
  LOGIN: 'auth.login',
  GET_USER: 'auth.get_user',
  LIST_USERS: 'auth.list_users',
  /** Admin creates an account (the only way in when public registration is off). */
  CREATE_USER: 'auth.create_user',
} as const;

export const SHIFT_PATTERNS = {
  CREATE: 'shift.create',
  LIST: 'shift.list',
  ASSIGN: 'shift.assign',
  /** "Which shift is this user on at this moment?" — called by attendance on every check-in. */
  RESOLVE_FOR_USER: 'shift.resolve_for_user',
} as const;

export const ATTENDANCE_PATTERNS = {
  CHECK_IN: 'attendance.check_in',
  CHECK_OUT: 'attendance.check_out',
  LIST_MINE: 'attendance.list_mine',
  LIST_BY_DAY: 'attendance.list_by_day',
} as const;

export const NOTIFICATION_PATTERNS = {
  LINK_TELEGRAM: 'notification.link_telegram',
  LIST_LOG: 'notification.list_log',
} as const;

/** Every service answers this so the gateway can report health. */
export const HEALTH_PATTERN = 'health.ping';
