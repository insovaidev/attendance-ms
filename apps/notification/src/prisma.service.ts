import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

/**
 * This service's own database client. The generated client lives inside
 * this app (src/generated/prisma), so another service literally cannot
 * import it — the database boundary is enforced by the folder structure.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const connectionString = process.env.NOTIFICATION_DATABASE_URL;
    if (!connectionString) throw new Error('NOTIFICATION_DATABASE_URL is not set');
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
