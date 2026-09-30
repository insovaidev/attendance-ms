import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser, Role } from '#common';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const ALLOW_SSE_TICKET = 'allowSseTicket';
export const SSE_TICKET_AUDIENCE = 'sse';

/** Route needs no token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route also accepts a short-lived ?ticket= (for EventSource, which can't send headers). */
export const AllowSseTicket = () => SetMetadata(ALLOW_SSE_TICKET, true);

/** Route needs one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** The logged-in user, taken from the verified JWT. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
