import { Module } from '@nestjs/common';
import { SERVICES, tcpClients } from '#common';
import { PrismaService } from './prisma.service.js';
import { ShiftController } from './shift.controller.js';
import { ShiftService } from './shift.service.js';

@Module({
  imports: [tcpClients(SERVICES.NOTIFICATION)],
  controllers: [ShiftController],
  providers: [ShiftService, PrismaService],
})
export class ShiftModule {}
