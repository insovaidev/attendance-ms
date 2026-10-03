import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { SERVICES, STATS_PATTERNS } from '#common';
import { Roles } from '../auth/decorators.js';
import { DateQueryDto } from '../dto.js';
import { call } from '../rpc.js';

@Controller('stats')
export class StatsController {
  constructor(@Inject(SERVICES.STATS) private readonly stats: ClientProxy) {}

  /** Numbers for one day, built by the stats service from the Kafka event log. */
  @Roles('ADMIN')
  @Get('daily')
  daily(@Query() query: DateQueryDto) {
    return call(this.stats, STATS_PATTERNS.DAILY, { date: query.date });
  }
}
