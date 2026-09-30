// Creates one database per service (auth_db, shift_db, ...) if missing.
// Reads the *_DATABASE_URL variables from .env.
import 'dotenv/config';
import pg from 'pg';

const vars = ['AUTH_DATABASE_URL', 'SHIFT_DATABASE_URL', 'ATTENDANCE_DATABASE_URL', 'NOTIFICATION_DATABASE_URL'];

for (const name of vars) {
  const raw = process.env[name];
  if (!raw) {
    console.error(`${name} is not set. Copy .env.example to .env first.`);
    process.exit(1);
  }
  const url = new URL(raw);
  const database = url.pathname.slice(1);
  url.pathname = '/postgres'; // connect to the default DB to create the others

  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (rowCount === 0) {
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    console.log(`created  ${database}`);
  } else {
    console.log(`exists   ${database}`);
  }
  await client.end();
}
