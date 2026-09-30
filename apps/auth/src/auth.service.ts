import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClientProxy } from '@nestjs/microservices';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  EVENTS,
  publish,
  rpcError,
  SERVICES,
  type AuthUser,
  type JwtPayload,
  type LoginPayload,
  type RegisterPayload,
  type UserRegisteredEvent,
} from '#common';
import { PrismaService } from './prisma.service.js';
import type { User } from './generated/prisma/client.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(SERVICES.NOTIFICATION) private readonly notification: ClientProxy,
  ) {}

  async register({ email, password, name }: RegisterPayload): Promise<AuthUser> {
    const normalized = email.trim().toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (exists) throw rpcError(409, 'Email is already registered');

    // Convenience for local development: the very first account becomes ADMIN.
    const isFirstUser = (await this.prisma.user.count()) === 0;

    const user = await this.prisma.user.create({
      data: {
        email: normalized,
        name: name.trim(),
        passwordHash: await hashPassword(password),
        role: isFirstUser ? 'ADMIN' : 'EMPLOYEE',
      },
    });

    publish<UserRegisteredEvent>(this.notification, EVENTS.USER_REGISTERED, {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });

    return toAuthUser(user);
  }

  async login({ email, password }: LoginPayload): Promise<{ accessToken: string; user: AuthUser }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw rpcError(401, 'Invalid email or password');
    }
    const payload: JwtPayload = { sub: user.id, email: user.email, name: user.name, role: user.role };
    return { accessToken: await this.jwt.signAsync(payload), user: toAuthUser(user) };
  }

  async getUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw rpcError(404, 'User not found');
    return toAuthUser(user);
  }

  async listUsers(): Promise<AuthUser[]> {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(toAuthUser);
  }
}

/** Never send passwordHash (or any Prisma model) across the wire. */
function toAuthUser(user: User): AuthUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}
