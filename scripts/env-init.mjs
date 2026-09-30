// Creates .env from .env.example with every placeholder secret replaced by a
// random value. Refuses to overwrite an existing .env.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env already exists — leaving it alone.');
  process.exit(0);
}

const random = () => randomBytes(32).toString('hex');
const env = readFileSync('.env.example', 'utf8')
  .replace(/=change-me-to-a-long-random-string$/gm, () => `=${random()}`)
  .replace(/^ADMIN_PASSWORD=.*$/m, () => `ADMIN_PASSWORD=${randomBytes(12).toString('base64url')}`);

writeFileSync('.env', env, { mode: 0o600 });
console.log(`Created .env. Admin login: ${env.match(/^ADMIN_EMAIL=(.*)$/m)[1]} / ${env.match(/^ADMIN_PASSWORD=(.*)$/m)[1]}`);
