import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  HEALTH_PATTERN,
  SHIFT_PATTERNS,
  type AssignShiftPayload,
  type CreateShiftPayload,
  type ResolveShiftPayload,
} from '#common';
import { ShiftService } from './shift.service.js';

@Controller()
export class ShiftController {
  constructor(private readonly shifts: ShiftService) {}

  @MessagePattern(SHIFT_PATTERNS.CREATE)
  create(@Payload() payload: CreateShiftPayload) {
    return this.shifts.create(payload);
  }

  @MessagePattern(SHIFT_PATTERNS.LIST)
  list() {
    return this.shifts.list();
  }

  @MessagePattern(SHIFT_PATTERNS.ASSIGN)
  assign(@Payload() payload: AssignShiftPayload) {
    return this.shifts.assign(payload);
  }

  /** Called synchronously by the attendance service on every check-in. */
  @MessagePattern(SHIFT_PATTERNS.RESOLVE_FOR_USER)
  resolve(@Payload() payload: ResolveShiftPayload) {
    return this.shifts.resolveForUser(payload);
  }

  @MessagePattern(HEALTH_PATTERN)
  health() {
    return this.shifts.health();
  }
}
