import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from '../dist/apps/gateway/src/auth/rate-limit.guard.js';

function context(ip, headers) {
  class Ctl {}
  function login() {}
  Reflect.defineMetadata('rateLimit', { limit: 3, windowMs: 60_000 }, login);
  return {
    getType: () => 'http',
    getClass: () => Ctl,
    getHandler: () => login,
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => ({ setHeader: (k, v) => (headers[k] = v) }),
    }),
  };
}

test('RateLimitGuard allows the limit, then answers 429 with Retry-After', () => {
  const guard = new RateLimitGuard(new Reflector());
  const headers = {};
  for (let i = 0; i < 3; i++) assert.equal(guard.canActivate(context('1.1.1.1', headers)), true);
  assert.throws(() => guard.canActivate(context('1.1.1.1', headers)), (err) => err.getStatus() === 429);
  assert.ok(Number(headers['Retry-After']) > 0);

  // Another client is counted separately.
  assert.equal(guard.canActivate(context('2.2.2.2', {})), true);
});
