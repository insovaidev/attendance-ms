// End-to-end walkthrough through the gateway. Run with all services up:
//   npm run dev        (terminal 1)
//   npm run demo       (terminal 2)
// Safe to run more than once.

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:3000';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

function step(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

async function registerOrLogin(email, name) {
  const password = 'password123';
  const reg = await api('POST', '/auth/register', { body: { email, password, name } });
  if (reg.status !== 201 && reg.status !== 409) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const login = await api('POST', '/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login)}`);
  return login.data;
}

/** Listen to the admin SSE stream and collect events. */
function listen(token) {
  const events = [];
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/attendance/live?token=${token}`, { signal: controller.signal });
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        for (const block of decoder.decode(chunk).split('\n\n')) {
          const type = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (type && data && type !== 'ping') events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, stop: () => controller.abort() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

step('Health check — gateway pings every service');
console.log(JSON.stringify((await api('GET', '/health')).data, null, 2));

step('Register + login admin (the first account ever created becomes ADMIN)');
const admin = await registerOrLogin('admin@example.com', 'Admin');
console.log(`${admin.user.name} → role ${admin.user.role}`);
if (admin.user.role !== 'ADMIN') {
  console.log('admin@example.com is not ADMIN (another account was created first). Reset the auth_db to rerun from scratch.');
  process.exit(1);
}

step('Register + login employee');
const emp = await registerOrLogin('sokha@example.com', 'Sokha');
console.log(`${emp.user.name} → role ${emp.user.role}`);

step('Employee tries an admin route (should be 403)');
const forbidden = await api('GET', '/users', { token: emp.accessToken });
console.log(forbidden.status, forbidden.data.message);

step('Admin creates a shift (every day, 08:00–17:00, 10 min grace)');
let shift = await api('POST', '/shifts', {
  token: admin.accessToken,
  body: { name: 'Office day', type: 'FIXED', startTime: '08:00', endTime: '17:00', graceMinutes: 10, days: [0, 1, 2, 3, 4, 5, 6] },
});
if (shift.status === 409) {
  const all = await api('GET', '/shifts', { token: admin.accessToken });
  shift = { data: all.data.find((s) => s.name === 'Office day') };
  console.log('already exists, reusing it');
}
console.log(`shift ${shift.data.id}`);

step('Admin assigns the employee (gateway asks auth "does this user exist?", then shift)');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh' }).format(new Date());
const assign = await api('POST', `/shifts/${shift.data.id}/assign`, {
  token: admin.accessToken,
  body: { userId: emp.user.id, startDate: today },
});
console.log(assign.status, assign.data.shift?.name ?? assign.data);

step('Assigning a user that does not exist (auth answers 404, gateway passes it on)');
const ghost = await api('POST', `/shifts/${shift.data.id}/assign`, {
  token: admin.accessToken,
  body: { userId: '00000000-0000-4000-8000-000000000000', startDate: today },
});
console.log(ghost.status, ghost.data.message);

step('Employee: "what shift am I on right now?"');
console.log((await api('GET', '/shifts/me/today', { token: emp.accessToken })).data);

step('Admin opens the live dashboard stream (SSE)');
const live = listen(admin.accessToken);
await sleep(300);

step('Employee checks in (attendance → sync call to shift → events to notification + gateway)');
const checkIn = await api('POST', '/attendance/check-in', { token: emp.accessToken, body: { note: 'demo' } });
if (checkIn.status === 409) console.log('409:', checkIn.data.message, '(already checked in today — fine on reruns)');
else console.log(checkIn.status, { status: checkIn.data.status, lateMinutes: checkIn.data.lateMinutes, shift: checkIn.data.shiftName });

step('Checking in twice (should be 409)');
const again = await api('POST', '/attendance/check-in', { token: emp.accessToken, body: {} });
console.log(again.status, again.data.message);

step('Employee checks out');
const out = await api('POST', '/attendance/check-out', { token: emp.accessToken });
console.log(out.status, out.status === 201 ? { leftEarlyMinutes: out.data.leftEarlyMinutes } : out.data.message);

await sleep(500);
live.stop();

step('Events the admin dashboard received over SSE');
console.log(live.events.length ? live.events.map((e) => `${e.type}: ${e.data.userName}`).join('\n') : '(none — you probably already checked in/out today)');

step("Admin: today's attendance");
for (const r of (await api('GET', '/attendance/day', { token: admin.accessToken })).data) {
  console.log(`${r.userName}  ${r.status}  late=${r.lateMinutes}m  out=${r.checkOutAt ? 'yes' : 'no'}`);
}

step('Admin: notification log (what the notification service did with the events)');
for (const n of (await api('GET', '/notifications/log?limit=6', { token: admin.accessToken })).data) {
  console.log(`${n.status.padEnd(7)} ${n.eventName.padEnd(24)} ${n.message}`);
}
console.log('\nDone.');
