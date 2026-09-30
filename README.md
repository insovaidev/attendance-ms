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
                 │        │  sync ◄┘      │ events ──►│
              auth_db  shift_db  attendance_db     notification_db
```

| Service | Owns | Talks to |
|---|---|---|
| **gateway** | nothing (stateless) | everyone; only HTTP entry point |
| **auth** | users, passwords, JWT | publishes `user.registered` |
| **shift** | shifts, assignments | publishes `shift.assigned` |
| **attendance** | check-in/out records | **asks** shift on every check-in, publishes `attendance.*` |
| **notification** | Telegram links, send log | only listens to events |

## Run it locally

Needs Node 22+ and PostgreSQL 16+ running on `localhost:5432` (user and password `postgres`, or edit `.env`).

```bash
npm install
cp .env.example .env
npm run setup     # creates 4 databases, generates 4 Prisma clients, runs migrations
npm run dev       # compiles and starts all 5 services with auto-reload
```

In a second terminal:

```bash
npm run demo      # full walkthrough: register, shifts, check-in, live events, notifications
```

The first `npm run setup` creates `apps/*/prisma/migrations/`. Commit those folders.

### Run it in Docker instead

```bash
npm run prisma:migrate    # once, to create the migration files the containers apply
docker compose up --build
```

## Project layout

```
apps/
  gateway/src/
    main.ts                 hybrid app: HTTP :3000 + TCP :4000 (receives events)
    rpc.ts                  call(): send to a service, map errors to HTTP 404/503/504
    auth/                   JWT guard, roles guard, @CurrentUser()
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
  publish.ts                fire-and-forget event helper
```

Services import shared code as `import { ... } from '#common'` (see `"imports"` in `package.json`). **`libs/common` must only hold contracts** (names, types, tiny helpers). Business logic there would couple the services back together.

## What happens on a check-in

1. `POST /attendance/check-in` hits the **gateway**. It verifies the JWT locally, without calling auth.
2. The gateway sends `attendance.check_in` with the user attached.
3. **Attendance** asks **shift** `shift.resolve_for_user`. This is a *synchronous* call with a 2s timeout.
4. Attendance saves the record as `ON_TIME`, `LATE`, `NO_SHIFT`, or `UNVERIFIED` (if shift didn't answer).
5. Attendance *emits* `attendance.checked_in` to **notification** and to the **gateway**, and does not wait for either.
6. Notification stores the `eventId` (unique) and sends a Telegram message.
7. The gateway pushes the event to admins connected to `GET /attendance/live` (SSE).

## API

All routes except register, login, and health need `Authorization: Bearer <token>`. The **first account registered becomes ADMIN**.

| Method | Path | Who |
|---|---|---|
| POST | `/auth/register` · `/auth/login` | public |
| GET | `/health` | public, pings every service |
| GET | `/auth/me` | any user |
| GET | `/users` | admin |
| POST / GET | `/shifts` | admin |
| POST | `/shifts/:id/assign` `{ userId, startDate, endDate? }` | admin |
| GET | `/shifts/me/today` | any user |
| POST | `/attendance/check-in` `{ note?, source? }` · `/attendance/check-out` | any user |
| GET | `/attendance/me?days=30` | any user |
| GET | `/attendance/day?date=YYYY-MM-DD` | admin |
| GET | `/attendance/live?token=...` (SSE) | admin |
| PUT | `/notifications/telegram` `{ chatId }` | any user |
| GET | `/notifications/log` | admin |

Telegram is optional. Set `TELEGRAM_BOT_TOKEN` (and `TELEGRAM_ADMIN_CHAT_ID` for late alerts) in `.env`, then link your chat with `PUT /notifications/telegram`. Without a token, messages are printed to the notification service's log.

## Break it on purpose

Run `npm run dev`, then stop one service in another terminal with `kill $(pgrep -f "apps/<name>/src/main.js")` and watch what happens. `npm run dev` doesn't restart a killed service, so restart it with `npm run dev:<name>`.

| Stop this | Then do this | What you'll see | The lesson |
|---|---|---|---|
| shift | check in | Saved as `UNVERIFIED`, employee not blocked | Decide per call: fail, or degrade gracefully |
| notification | check in, then restart it | Check-in works, but that alert is **gone forever** | TCP has no delivery guarantee. This is why brokers exist. |
| attendance | check out | Gateway returns **503** | Error translation at the edge (`gateway/src/rpc.ts`) |
| auth | log in, then check in with an existing token | Login fails, but check-in **still works** | Stateless JWT removes a runtime dependency |
| anything | `GET /health` | Which service is down, and latency per service | Observability starts with health checks |

Also notice that `attendance.service.ts` emits the same event **twice**, once to notification and once to the gateway. With plain TCP the publisher must know every listener. A broker fixes that.

## Next steps (the learning plan)

**Week 1: read and trace**
- Run the demo and follow one check-in through all the logs.
- Add a `correlationId` to every payload and log it in each service, so you can grep one request across services.

**Week 2: move to RabbitMQ**
- Add `rabbitmq:4-management` to `docker-compose.yml`.
- In `libs/common/src/bootstrap.ts` and `clients.ts`, switch `Transport.TCP` to `Transport.RMQ` with `{ urls: [...], queue: '<service>' }`.
- Rerun the "stop notification" experiment. The event now waits in the queue.
- Emit `attendance.checked_in` **once**, and let each consumer have its own queue (or use a topic exchange).

**Week 3: consistency**
- **Outbox pattern:** if attendance crashes right after saving but before emitting, the event is lost. Write events to an `Outbox` table in the same Prisma transaction, and have a worker (BullMQ, which you already know) publish them.
- **Re-verify `UNVERIFIED` records:** a BullMQ job asks shift again later and updates the status.

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
