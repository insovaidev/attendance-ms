import 'reflect-metadata';
import { bootstrapTcpService, SERVICES } from '#common';
import { AttendanceModule } from './attendance.module.js';

await bootstrapTcpService(AttendanceModule, SERVICES.ATTENDANCE, 'AttendanceService');
