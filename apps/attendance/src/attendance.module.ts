import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalAuthGuard, kafkaProducer, outboxRelayProvider, SERVICES, tcpClients } from '#common';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { PrismaService } from './prisma.service.js';
import { ReverifyJob } from './reverify.job.js';

@Module({
  imports: [
    tcpClients(
      SERVICES.SHIFT, // sync: "what shift is this user on?"
      SERVICES.GATEWAY_EVENTS, // best-effort: feed the live SSE dashboard
    ),
    kafkaProducer('attendance'), // durable events, via the outbox
  ],
  controllers: [AttendanceController],
  providers: [
    AttendanceService,
    PrismaService,
    ReverifyJob,
    outboxRelayProvider(PrismaService),
    { provide: APP_GUARD, useClass: InternalAuthGuard },
  ],
})
export class AttendanceModule {}
