import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { InternalAuthGuard, jwtExpiresIn, jwtSecret, outboxRelayProvider, SERVICES, tcpClients } from '#common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PrismaService } from './prisma.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({ secret: jwtSecret(), signOptions: { expiresIn: jwtExpiresIn() as never } }),
    }),
    // Auth only publishes events (through the outbox); it never calls other services.
    tcpClients(SERVICES.NOTIFICATION),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PrismaService,
    outboxRelayProvider(PrismaService, [SERVICES.NOTIFICATION]),
    { provide: APP_GUARD, useClass: InternalAuthGuard },
  ],
})
export class AuthModule {}
