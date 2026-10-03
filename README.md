# My Questions
- if every services deploy is used dif db, how the can use each onther

# Attendance system, as microservices

A learning project: the attendance system split into five NestJS services that talk over TCP, each with its own PostgreSQL database managed by Prisma.

```
                 Nuxt PWA / Telegram / curl
                           │ HTTP :3000
                    ┌──────▼──────┐
                    │   gateway   │  JWT check, validation, routing, SSE live feed
                    └──┬──┬──┬──┬─┘
          TCP :4001 ┌──┘  │  │  └──┐ TCP :4004
              ┌─────▼┐ ┌──▼──┴┐ ┌──▼─────────┐ ┌──────────────┐
              │ auth │ │shift │ │ attendance │ │ notification │
              └──┬───┘ └──┬───┘ └──┬──────┬──┘ └──────┬───────┘
                 │        │  sync ◄┘      │ outbox ──►│
              auth_db  shift_db  attendance_db     notification_db
```

| Service | Owns | Talks to |
|---|---|---|
| **gateway** | nothing (stateless) | everyone; only HTTP entry point |
| **auth** | users, passwords, JWT | publishes `user.registered` |
| **shift** | shifts, assignments | publishes `shift.assigned` |
| **attendance** | check-in/out records | **asks** shift on every check-in, publishes `attendance.*` |
| **notification** | Telegram links, send log | only receives events |

Every internal TCP message carries a shared `INTERNAL_TOKEN`; services reject messages without it.

Diagrams for every flow in this system (topology, login, check-in, the outbox,
degradation, the guard chain): **[docs/FLOW.md](docs/FLOW.md)**.

## Run it locally

Needs Node 22+ and PostgreSQL 16+ running on `localhost:5432` (user and password `postgres`, or edit `.env`).

```bash
npm install
npm run setup     # creates .env with random secrets, 4 databases, 4 Prisma clients, runs migrations
npm run dev       # compiles and starts all 5 services with auto-reload
```

`npm run setup` prints the admin login it generated (`ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`). The auth service creates that account on startup.

In a second terminal:

```bash
npm run demo      # full walkthrough: admin, users, shifts, check-in, live events, notifications
npm test          # unit tests
```

The first `npm run setup` creates `apps/*/prisma/migrations/`. Commit those folders.

### Run it in Docker instead

```bash
npm run env:init          # once: .env with random secrets (compose reads it and refuses to start without them)
docker compose up --build
```

In Docker each service logs into Postgres with its own role that can only reach its own database (`docker/postgres-init.sh`), the internal TCP ports are not published, containers run as a non-root user, and self-registration is off (`ALLOW_REGISTRATION=false`).

## Project layout

```
apps/
  gateway/src/
    main.ts                 hybrid app: HTTP :3000 + TCP :4000 (receives events)
    rpc.ts                  call(): send to a service, map errors to HTTP 404/503/504
    auth/                   JWT guard, roles guard, rate-limit guard, @CurrentUser()
    controllers/            one per service it fronts
    live/                   SSE dashboard fed by attendance events
  auth/
    prisma/schema.prisma    this service's tables, and only these
    prisma.config.ts        points Prisma at AUTH_DATABASE_URL
    src/generated/prisma/   generated client (gitignored). No other app can import it.
  shift/ attendance/ notification/   same shape
libs/common/src/            the contracts between services
  patterns.ts               request/response names  ("auth.login", ...)
  events.ts                 event names + payload types ("attendance.checked_in", ...)
  contracts.ts              payload shapes
  services.ts               host/port of every service
  publish.ts                fire-and-forget event helper (live feed only)
  outbox.ts                 transactional outbox + relay (durable events)
  internal-auth.ts          INTERNAL_TOKEN on every internal message + the guard that checks it
  config.ts                 required secrets; services refuse to start without them
test/                       unit tests (npm test)
```

Services import shared code as `import { ... } from '#common'` (see `"imports"` in `package.json`). **`libs/common` must only hold contracts** (names, types, tiny helpers). Business logic there would couple the services back together.

## What happens on a check-in

1. `POST /attendance/check-in` hits the **gateway**. It verifies the JWT locally, without calling auth.
2. The gateway sends `attendance.check_in` with the user attached.
3. **Attendance** asks **shift** `shift.resolve_for_user`. This is a *synchronous* call with a 2s timeout.
4. Attendance saves the record as `ON_TIME`, `LATE`, `NO_SHIFT`, or `UNVERIFIED` (if shift didn't answer).
5. In the **same database transaction**, attendance writes `attendance.checked_in` to its `OutboxEvent` table (transactional outbox).
6. The outbox relay (polls every second) delivers it to **notification** with request/reply and retries with backoff until notification acknowledges it. Delivery is at-least-once.
7. Notification claims the `eventId` (unique, so duplicates are ignored) and sends a Telegram message. If Telegram fails, it records `FAILED` and the relay retries.
8. Attendance also emits the event to the **gateway** (best effort), which pushes it to admins connected to `GET /attendance/live` (SSE).
9. Check-ins stored as `UNVERIFIED` (shift was down) are re-checked every 5 minutes (`apps/attendance/src/reverify.job.ts`).

## API

All routes except register, login, and health need `Authorization: Bearer <token>`. The first admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on startup. Login and register are rate-limited per IP (10 and 5 per minute).

| Method | Path | Who |
|---|---|---|
| POST | `/auth/register` | public, only if `ALLOW_REGISTRATION=true` (default off in production) |
| POST | `/auth/login` | public |
| GET | `/health` | public, pings every service |
| GET | `/auth/me` | any user |
| POST | `/users` `{ email, password, name, role }` | admin |
| GET | `/users` | admin |
| POST / GET | `/shifts` | admin |
| POST | `/shifts/:id/assign` `{ userId, startDate, endDate? }` | admin |
| GET | `/shifts/me/today` | any user |
| POST | `/attendance/check-in` `{ note?, source? }` · `/attendance/check-out` | any user |
| GET | `/attendance/me?days=30` | any user |
| GET | `/attendance/day?date=YYYY-MM-DD` | admin |
| POST | `/attendance/live/ticket` → `{ ticket }` (valid 60s) | admin |
| GET | `/attendance/live?ticket=...` (SSE) | admin |
| PUT | `/notifications/telegram` `{ chatId }` | any user |
| GET | `/notifications/log` | admin |

Telegram is optional. Set `TELEGRAM_BOT_TOKEN` (and `TELEGRAM_ADMIN_CHAT_ID` for late alerts) in `.env`, then link your chat with `PUT /notifications/telegram`. Without a token, messages are printed to the notification service's log.

## Break it on purpose

Run `npm run dev`, then stop one service in another terminal with `kill $(pgrep -f "apps/<name>/src/main.js")` and watch what happens. `npm run dev` doesn't restart a killed service, so restart it with `npm run dev:<name>`.

| Stop this | Then do this | What you'll see | The lesson |
|---|---|---|---|
| shift | check in, then restart shift | Saved as `UNVERIFIED`, employee not blocked; fixed within 5 min | Degrade gracefully, then reconcile |
| notification | check in, then restart it | Check-in works; the alert arrives once notification is back | Transactional outbox + retries (`libs/common/src/outbox.ts`) |
| attendance | check out | Gateway returns **503** | Error translation at the edge (`gateway/src/rpc.ts`) |
| auth | log in, then check in with an existing token | Login fails, but check-in **still works** | Stateless JWT removes a runtime dependency |
| anything | `GET /health` | Which service is down, and latency per service | Observability starts with health checks |

Also notice that events still go point-to-point: `EVENT_DESTINATIONS` in `libs/common/src/events.ts` lists every consumer, so the publisher must know its listeners. A broker fixes that.

## Next steps (the learning plan)

**Week 1: read and trace**
- Run the demo and follow one check-in through all the logs.
- Add a `correlationId` to every payload and log it in each service, so you can grep one request across services.

**Week 2: move to RabbitMQ**
- Add `rabbitmq:4-management` to `docker-compose.yml`.
- In `libs/common/src/bootstrap.ts` and `clients.ts`, switch `Transport.TCP` to `Transport.RMQ` with `{ urls: [...], queue: '<service>' }`.
- Rerun the "stop notification" experiment. The event now waits in the queue.
- Emit `attendance.checked_in` **once**, and let each consumer have its own queue (or use a topic exchange).

**Week 3: consistency** — done: transactional outbox (`libs/common/src/outbox.ts`) and re-verification of `UNVERIFIED` records (`apps/attendance/src/reverify.job.ts`). With a broker, the relay would publish to it instead of calling notification directly.

**Week 4: remove the sync call**
- Shift publishes `shift.assigned`, `shift.updated`, and so on. Attendance keeps its own copy of today's schedule and stops calling shift on check-in.
- Compare: what did you gain (resilience, speed) and what did you lose (the copy can be stale)?

**Shift engine exercises** (in `apps/shift/src/shift.service.ts`)
- Overnight shifts (22:00 → 06:00): the check-in date and shift date differ.
- Real rotation patterns (for example 4 days on, 4 off) instead of dated assignments.

**Telegram check-in**
- A `telegram-bot` service (grammY) that receives `/checkin` and sends `attendance.check_in` with `source: 'TELEGRAM'`. That's a sixth service with no database at all.

## Rules this codebase follows

1. **A service never reads another service's database.** `userId` in shift and attendance is a plain UUID with no foreign key.
2. **Only plain JSON crosses the wire:** ISO strings instead of `Date`, no Prisma models, no password hashes.
3. **Events are past tense** (`checked_in`) and carry an `eventId`. Consumers must handle duplicates.
4. **Denormalize for reads.** Attendance copies `userName` and `shiftName` at check-in, so history never needs other services.
5. **Validate at the edge, enforce business rules inside.** DTOs in the gateway, rules in each service.

## Running it for real

What is already in place:

- Secrets are required: services refuse to start without a real `JWT_SECRET` and `INTERNAL_TOKEN` (no fallback values). `.env` is gitignored; generate it with `npm run env:init`.
- No "first user becomes admin": the admin comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, admins create accounts, and self-registration is off in production.
- Internal traffic is authenticated (`INTERNAL_TOKEN`), and internal ports bind to loopback unless `BIND_HOST` is set.
- One Postgres role per service in Docker; Postgres is only published on `127.0.0.1`.
- Tokens expire after `JWT_EXPIRES_IN` (default 8h); the SSE stream uses 60-second tickets instead of putting the token in the URL.
- Login/register rate limits, a CORS allow-list (`CORS_ORIGINS`), `TRUST_PROXY` for real client IPs, and no internal error details in 500 responses.
- Durable events (outbox), retry-safe notifications, race-safe check-out, database checks in `GET /health`.
- Multi-stage Docker image, non-root.

Still to do before a large deployment:

- **TLS between services.** The token authenticates messages, but TCP traffic is plain text. Keep services on a private network, or add `tlsOptions` to the TCP transport / use a service mesh.
- **A broker** (RabbitMQ/NATS) so events fan out without the publisher listing consumers, and so the live SSE feed works with more than one gateway replica.
- **Shared rate-limit storage** (Redis) when running more than one gateway.
- **Token revocation** (short access tokens + refresh tokens) if a role change must take effect immediately.
- **Observability:** correlation IDs across services, structured logs, metrics and tracing.
- **Overnight shifts** in the shift engine.
- **Rotate the old `JWT_SECRET`**: an earlier version of this repository committed `.env`, so that value is public in git history.
