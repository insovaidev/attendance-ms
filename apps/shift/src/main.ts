import 'reflect-metadata';
import { bootstrapTcpService, SERVICES } from '#common';
import { ShiftModule } from './shift.module.js';

await bootstrapTcpService(ShiftModule, SERVICES.SHIFT, 'ShiftService');
