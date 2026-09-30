/**
 * Required configuration. Services refuse to start with a missing or
 * placeholder secret instead of silently falling back to a known value
 * (a known JWT secret lets anyone mint an ADMIN token).
 */
const PLACEHOLDERS = new Set([
  'change-me-to-a-long-random-string',
  'dev-only-secret-change-me',
  'change-me',
]);

export function requiredSecret(name: string, minLength = 32): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run "npm run env:init" or generate one with: openssl rand -hex 32`);
  }
  if (PLACEHOLDERS.has(value) || value.length < minLength) {
    throw new Error(`${name} must be a random string of at least ${minLength} characters (openssl rand -hex 32)`);
  }
  return value;
}

export const jwtSecret = () => requiredSecret('JWT_SECRET');

/** How long a login token stays valid. Keep it short: tokens cannot be revoked. */
export const jwtExpiresIn = () => process.env.JWT_EXPIRES_IN ?? '8h';

export const isProduction = () => process.env.NODE_ENV === 'production';

/** "true"/"false" env flag with a default. */
export function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}
