import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { KafkaContext } from '@nestjs/microservices';
import { timingSafeEqual } from 'node:crypto';
import { requiredSecret } from './config.js';
import { rpcError } from './rpc-error.js';

/**
 * Service-to-service authentication.
 *
 * The TCP transport has no headers, so every internal message carries a
 * shared secret in a reserved field. InternalAuthGuard (registered as a
 * global guard in every service) checks and strips it before the handler
 * runs. Without it, anything that can reach a service port could, for
 * example, send attendance.check_in for any user or list every account.
 *
 * Kafka messages are checked differently: they carry an HMAC signature in a
 * header instead of the token itself (see consumeEvent() in kafka.ts).
 */
const FIELD = '_internal';

let cachedToken: Buffer | undefined;
const token = () => (cachedToken ??= Buffer.from(requiredSecret('INTERNAL_TOKEN')));

/** Attach the internal token to an outgoing message. */
export function withInternalToken<T extends object>(data: T): T {
  return { ...data, [FIELD]: token().toString() };
}

export function isInternalTokenValid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value);
  const expected = token();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger('InternalAuth');

  constructor() {
    token(); // fail at startup, not on the first message
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;
    if (context.switchToRpc().getContext() instanceof KafkaContext) return true;

    const data = context.switchToRpc().getData<Record<string, unknown> | undefined>();
    if (data && typeof data === 'object' && isInternalTokenValid(data[FIELD])) {
      delete data[FIELD];
      return true;
    }
    const pattern = context.switchToRpc().getContext<{ getPattern?: () => string }>()?.getPattern?.();
    this.logger.warn(`Rejected internal message without a valid token${pattern ? ` (${pattern})` : ''}`);
    throw rpcError(401, 'Unauthorized internal call');
  }
}
