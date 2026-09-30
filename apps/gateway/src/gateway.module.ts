import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { SERVICES, tcpClients } from '#common';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { AttendanceController } from './controllers/attendance.controller.js';
import { AuthController } from './controllers/auth.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { NotificationsController } from './controllers/notifications.controller.js';
import { ShiftsController } from './controllers/shifts.controller.js';
import { LiveEventsController } from './live/live-events.controller.js';
import { LiveEventsService } from './live/live-events.service.js';

@Module({
  imports: [
    // Same secret as the auth service. The gateway verifies tokens locally,
    // so a normal request never has to call auth at all.
    JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me' }),
    tcpClients(SERVICES.AUTH, SERVICES.SHIFT, SERVICES.ATTENDANCE, SERVICES.NOTIFICATION),
  ],
  controllers: [
    AuthController,
    ShiftsController,
    AttendanceController,
    NotificationsController,
    HealthController,
    LiveEventsController,
  ],
  providers: [
    LiveEventsService,
    // Order matters: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class GatewayModule {}
