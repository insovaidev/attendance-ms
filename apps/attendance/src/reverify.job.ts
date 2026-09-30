import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AttendanceService } from './attendance.service.js';

const INTERVAL_MS = Number(process.env.REVERIFY_INTERVAL_MS ?? 5 * 60_000);

/**
 * Check-ins made while the shift service was down are stored as UNVERIFIED.
 * This job periodically asks shift again (for the original check-in time)
 * and fixes their status. Safe to run on several replicas: the update only
 * applies to rows that are still UNVERIFIED.
 */
@Injectable()
export class ReverifyJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReverifyJob.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly attendance: AttendanceService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const fixed = await this.attendance.reverifyUnverified();
      if (fixed) this.logger.log(`Re-verified ${fixed} UNVERIFIED check-in(s)`);
    } catch (err) {
      this.logger.warn(`Re-verification failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
