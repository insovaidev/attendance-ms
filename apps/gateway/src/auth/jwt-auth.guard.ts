import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser, JwtPayload } from '#common';
import { ALLOW_SSE_TICKET, IS_PUBLIC, SSE_TICKET_AUDIENCE } from './decorators.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The gateway also receives TCP events from other services. Those are
    // internal traffic (checked by InternalAuthGuard), so this guard skips them.
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const allowTicket = this.reflector.getAllAndOverride<boolean>(ALLOW_SSE_TICKET, targets);

    let user: AuthUser;
    if (header?.startsWith('Bearer ')) {
      const payload = await this.verify(header.slice(7));
      // A short-lived SSE ticket is not a login token.
      if (payload.aud === SSE_TICKET_AUDIENCE) throw new UnauthorizedException('Invalid or expired token');
      user = toUser(payload);
    } else if (allowTicket && typeof req.query?.ticket === 'string') {
      // EventSource can't send headers. Instead of putting the real token in
      // the URL (where proxies and access logs keep it), the client first
      // gets a 60-second ticket from POST /attendance/live/ticket.
      user = toUser(await this.verify(req.query.ticket, SSE_TICKET_AUDIENCE));
    } else {
      throw new UnauthorizedException('Missing bearer token');
    }

    req.user = user;
    return true;
  }

  private async verify(token: string, audience?: string) {
    try {
      return await this.jwt.verifyAsync<JwtPayload & { aud?: string }>(token, audience ? { audience } : {});
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

function toUser(payload: JwtPayload): AuthUser {
  return { id: payload.sub, email: payload.email, name: payload.name, role: payload.role };
}
