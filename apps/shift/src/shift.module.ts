import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalAuthGuard, kafkaProducer, outboxRelayProvider } from '#common';
import { PrismaService } from './prisma.service.js';
import { ShiftController } from './shift.controller.js';
import { ShiftService } from './shift.service.js';

@Module({
  imports: [kafkaProducer('shift')], // shift.assigned events, via the outbox
  controllers: [ShiftController],
  providers: [
    ShiftService,
    PrismaService,
    outboxRelayProvider(PrismaService),
    { provide: APP_GUARD, useClass: InternalAuthGuard },
  ],
})
export class ShiftModule {}
