import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalAuthGuard, outboxRelayProvider, SERVICES, tcpClients } from '#common';
import { PrismaService } from './prisma.service.js';
import { ShiftController } from './shift.controller.js';
import { ShiftService } from './shift.service.js';

@Module({
  imports: [tcpClients(SERVICES.NOTIFICATION)],
  controllers: [ShiftController],
  providers: [
    ShiftService,
    PrismaService,
    outboxRelayProvider(PrismaService, [SERVICES.NOTIFICATION]),
    { provide: APP_GUARD, useClass: InternalAuthGuard },
  ],
})
export class ShiftModule {}
