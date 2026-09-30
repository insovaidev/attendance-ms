import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AUTH_PATTERNS, HEALTH_PATTERN, type LoginPayload, type RegisterPayload } from '#common';
import { AuthService } from './auth.service.js';

/**
 * Not an HTTP controller: each handler answers a message pattern over TCP.
 * The gateway is the only thing that calls these.
 */
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @MessagePattern(AUTH_PATTERNS.REGISTER)
  register(@Payload() payload: RegisterPayload) {
    return this.auth.register(payload);
  }

  @MessagePattern(AUTH_PATTERNS.LOGIN)
  login(@Payload() payload: LoginPayload) {
    return this.auth.login(payload);
  }

  @MessagePattern(AUTH_PATTERNS.GET_USER)
  getUser(@Payload() payload: { userId: string }) {
    return this.auth.getUser(payload.userId);
  }

  @MessagePattern(AUTH_PATTERNS.LIST_USERS)
  listUsers() {
    return this.auth.listUsers();
  }

  @MessagePattern(HEALTH_PATTERN)
  health() {
    return { service: 'auth', ok: true };
  }
}
