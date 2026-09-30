import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const RATE_LIMIT = 'rateLimit';

interface RateLimitOptions {
  /** Requests allowed per client IP within the window. */
  limit: number;
  windowMs: number;
}

/** Limit how often one client IP may call this route (e.g. login brute force). */
export const RateLimit = (limit: number, windowMs = 60_000) =>
  SetMetadata(RATE_LIMIT, { limit, windowMs } satisfies RateLimitOptions);

/**
 * Fixed-window, in-memory rate limiter.
 *
 * Counts are per gateway process, so with N gateway replicas a client can
 * make up to N× the limit. Move the counters to Redis (or rate-limit at the
 * load balancer) when you run more than one gateway.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const options = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT, context.getHandler());
    if (!options) return true;

    const req = context.switchToHttp().getRequest();
    const now = Date.now();
    this.sweep(now);

    // req.ip honours the TRUST_PROXY setting (see main.ts).
    const key = `${context.getClass().name}.${context.getHandler().name}:${req.ip}`;
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;

    if (entry.count > options.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      context.switchToHttp().getResponse().setHeader('Retry-After', String(retryAfter));
      throw new HttpException(`Too many requests. Try again in ${retryAfter}s.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
