import 'reflect-metadata';
import { bootstrapTcpService, SERVICES } from '#common';
import { AuthModule } from './auth.module.js';

await bootstrapTcpService(AuthModule, SERVICES.AUTH, 'AuthService');
