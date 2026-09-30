import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  envFlag,
  EVENTS,
  isProduction,
  outboxRows,
  rpcError,
  type AuthUser,
  type CreateUserPayload,
  type JwtPayload,
  type LoginPayload,
  type RegisterPayload,
  type Role,
  type UserRegisteredEvent,
} from '#common';
import { Prisma, type User } from './generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// Compared against when the email is unknown, so a login for a missing
// account takes as long as one for an existing account (no user enumeration).
const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(64)}`;

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  /** Public self-registration. Off by default in production: admins create accounts. */
  private readonly allowRegistration = envFlag('ALLOW_REGISTRATION', !isProduction());

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if that account
   * doesn't exist yet. Replaces "the first account registered becomes ADMIN",
   * which on a fresh deployment hands the system to whoever registers first.
   */
  async onApplicationBootstrap() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      if ((await this.prisma.user.count({ where: { role: 'ADMIN' } })) === 0) {
        this.logger.warn('No ADMIN account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD to create one.');
      }
      return;
    }
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    if (await this.prisma.user.findUnique({ where: { email } })) return;

    await this.createAccount({ email, password, name: process.env.ADMIN_NAME ?? 'Admin', role: 'ADMIN' });
    this.logger.log(`Created admin account ${email}`);
  }

  async register(input: RegisterPayload): Promise<AuthUser> {
    if (!this.allowRegistration) throw rpcError(403, 'Self-registration is disabled. Ask an admin for an account.');
    return this.createAccount({ ...input, role: 'EMPLOYEE' });
  }

  /** Admin-only (enforced by the gateway's RolesGuard). */
  createUser(input: CreateUserPayload): Promise<AuthUser> {
    return this.createAccount(input);
  }

  async login({ email, password }: LoginPayload): Promise<{ accessToken: string; user: AuthUser }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) throw rpcError(401, 'Invalid email or password');

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

  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw rpcError(503, 'auth database unavailable');
    }
    return { service: 'auth', ok: true };
  }

  /** Creates the user and its user.registered event in one transaction. */
  private async createAccount(input: RegisterPayload & { role: Role }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, name: input.name.trim(), passwordHash, role: input.role },
        });
        await tx.outboxEvent.createMany({
          data: outboxRows<UserRegisteredEvent>(EVENTS.USER_REGISTERED, {
            userId: created.id,
            name: created.name,
            email: created.email,
            role: created.role,
          }),
        });
        return created;
      });
      return toAuthUser(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw rpcError(409, 'Email is already registered');
      }
      throw err;
    }
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
  const expected = Buffer.from(hashHex ?? '', 'hex');
  if (!saltHex || expected.length === 0) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}
