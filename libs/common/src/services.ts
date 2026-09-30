/**
 * Where every service lives on the network.
 *
 * Each service is a separate process. The gateway (and any service that
 * calls another service) needs to know the host + port of the target.
 * In Docker Compose the host is the service name; locally it's 127.0.0.1.
 */
export const SERVICES = {
  AUTH: 'AUTH_SERVICE',
  SHIFT: 'SHIFT_SERVICE',
  ATTENDANCE: 'ATTENDANCE_SERVICE',
  NOTIFICATION: 'NOTIFICATION_SERVICE',
  GATEWAY_EVENTS: 'GATEWAY_EVENTS',
} as const;

export type ServiceToken = (typeof SERVICES)[keyof typeof SERVICES];

interface Endpoint {
  host: string;
  port: number;
}

const defaults: Record<ServiceToken, { hostEnv: string; portEnv: string; port: number }> = {
  AUTH_SERVICE: { hostEnv: 'AUTH_HOST', portEnv: 'AUTH_PORT', port: 4001 },
  SHIFT_SERVICE: { hostEnv: 'SHIFT_HOST', portEnv: 'SHIFT_PORT', port: 4002 },
  ATTENDANCE_SERVICE: { hostEnv: 'ATTENDANCE_HOST', portEnv: 'ATTENDANCE_PORT', port: 4003 },
  NOTIFICATION_SERVICE: { hostEnv: 'NOTIFICATION_HOST', portEnv: 'NOTIFICATION_PORT', port: 4004 },
  // The gateway also listens on TCP so it can receive events for the SSE dashboard.
  GATEWAY_EVENTS: { hostEnv: 'GATEWAY_EVENTS_HOST', portEnv: 'GATEWAY_EVENTS_PORT', port: 4000 },
};

export function endpoint(service: ServiceToken): Endpoint {
  const d = defaults[service];
  return {
    host: process.env[d.hostEnv] ?? '127.0.0.1',
    port: Number(process.env[d.portEnv] ?? d.port),
  };
}

/** Address a service should bind to when it starts listening. */
export function listenAddress(service: ServiceToken): Endpoint {
  return { host: process.env.BIND_HOST ?? '0.0.0.0', port: endpoint(service).port };
}
