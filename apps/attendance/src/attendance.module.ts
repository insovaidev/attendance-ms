import { Module } from '@nestjs/common';
import { SERVICES, tcpClients } from '#common';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { PrismaService } from './prisma.service.js';

@Module({
  imports: [
    tcpClients(
      SERVICES.SHIFT, // sync: "what shift is this user on?"
      SERVICES.NOTIFICATION, // async: publish checked_in / checked_out
      SERVICES.GATEWAY_EVENTS, // async: feed the live SSE dashboard
    ),
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService, PrismaService],
})
export class AttendanceModule {}
