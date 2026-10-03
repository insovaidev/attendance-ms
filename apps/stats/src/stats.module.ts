import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalAuthGuard } from '#common';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

// No database and no clients: everything stats knows comes from Kafka.
@Module({
  controllers: [StatsController],
  providers: [StatsService, { provide: APP_GUARD, useClass: InternalAuthGuard }],
})
export class StatsModule {}
