import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AUTH_PATTERNS, SERVICES, type AuthUser } from '#common';
import { CurrentUser, Public, Roles } from '../auth/decorators.js';
import { LoginDto, RegisterDto } from '../dto.js';
import { call } from '../rpc.js';

@Controller()
export class AuthController {
  constructor(@Inject(SERVICES.AUTH) private readonly auth: ClientProxy) {}

  @Public()
  @Post('auth/register')
  register(@Body() dto: RegisterDto) {
    return call<AuthUser>(this.auth, AUTH_PATTERNS.REGISTER, dto);
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return call(this.auth, AUTH_PATTERNS.LOGIN, dto);
  }

  /** Fresh data from the auth service (the JWT might be up to a day old). */
  @Get('auth/me')
  me(@CurrentUser() user: AuthUser) {
    return call<AuthUser>(this.auth, AUTH_PATTERNS.GET_USER, { userId: user.id });
  }

  @Roles('ADMIN')
  @Get('users')
  listUsers() {
    return call<AuthUser[]>(this.auth, AUTH_PATTERNS.LIST_USERS);
  }
}
