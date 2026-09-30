import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SERVICES, tcpClients } from '#common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PrismaService } from './prisma.service.js';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
      signOptions: { expiresIn: '1d' },
    }),
    // Auth only publishes events; it never calls other services.
    tcpClients(SERVICES.NOTIFICATION),
  ],
  controllers: [AuthController],
  providers: [AuthService, PrismaService],
})
export class AuthModule {}
