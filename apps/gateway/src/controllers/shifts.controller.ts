import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AUTH_PATTERNS, SERVICES, SHIFT_PATTERNS, type AuthUser, type ResolvedShift } from '#common';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { AssignShiftDto, CreateShiftDto } from '../dto.js';
import { call } from '../rpc.js';

@Controller('shifts')
export class ShiftsController {
  constructor(
    @Inject(SERVICES.SHIFT) private readonly shift: ClientProxy,
    @Inject(SERVICES.AUTH) private readonly auth: ClientProxy,
  ) {}

  @Roles('ADMIN')
  @Post()
  create(@Body() dto: CreateShiftDto) {
    return call(this.shift, SHIFT_PATTERNS.CREATE, dto);
  }

  @Roles('ADMIN')
  @Get()
  list() {
    return call(this.shift, SHIFT_PATTERNS.LIST);
  }

  /**
   * API composition: the gateway asks auth "does this user exist?" and only
   * then asks shift to assign. Neither service needs to know about the other.
   */
  @Roles('ADMIN')
  @Post(':id/assign')
  async assign(@Param('id', ParseUUIDPipe) shiftId: string, @Body() dto: AssignShiftDto) {
    await call<AuthUser>(this.auth, AUTH_PATTERNS.GET_USER, { userId: dto.userId });
    return call(this.shift, SHIFT_PATTERNS.ASSIGN, { ...dto, shiftId });
  }

  /** "What am I working right now?" */
  @Get('me/today')
  async myShiftNow(@CurrentUser() user: AuthUser) {
    const shift = await call<ResolvedShift | null>(this.shift, SHIFT_PATTERNS.RESOLVE_FOR_USER, {
      userId: user.id,
      at: new Date().toISOString(),
    });
    return { shift };
  }
}
