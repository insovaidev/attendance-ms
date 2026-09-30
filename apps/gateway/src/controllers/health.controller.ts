import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { HEALTH_PATTERN, SERVICES } from '#common';
import { Public } from '../auth/decorators.js';
import { call } from '../rpc.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(SERVICES.AUTH) private readonly auth: ClientProxy,
    @Inject(SERVICES.SHIFT) private readonly shift: ClientProxy,
    @Inject(SERVICES.ATTENDANCE) private readonly attendance: ClientProxy,
    @Inject(SERVICES.NOTIFICATION) private readonly notification: ClientProxy,
  ) {}

  /** Pings every service in parallel. Try stopping one and calling this again. */
  @Public()
  @Get()
  async check() {
    const targets = { auth: this.auth, shift: this.shift, attendance: this.attendance, notification: this.notification };
    const results = await Promise.all(
      Object.entries(targets).map(async ([name, client]) => {
        const started = Date.now();
        try {
          await call(client, HEALTH_PATTERN, {}, 1500);
          return [name, { ok: true, ms: Date.now() - started }] as const;
        } catch (err) {
          return [name, { ok: false, error: err instanceof Error ? err.message : String(err) }] as const;
        }
      }),
    );
    const services = Object.fromEntries(results);
    return { ok: results.every(([, r]) => r.ok), services };
  }
}
