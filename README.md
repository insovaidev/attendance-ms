# Attendance system, as microservices

A learning project: the attendance system split into six NestJS services. Requests go over TCP, events go through **Kafka**, and each service with data has its own PostgreSQL database managed by Prisma.

```
                 Nuxt PWA / Telegram / curl
                           │ HTTP :3000
                    ┌──────▼──────┐
                    │   gateway   │  JWT check, validation, routing, SSE live feed
                    └──┬──┬──┬──┬─┘
              TCP requests (ask and wait for an answer)
              ┌─────▼┐ ┌──▼───┐ ┌──▼─────────┐
              │ auth │ │shift │◄┤ attendance │
              └──┬───┘ └──┬───┘ └─────┬──────┘
          outbox │        │ outbox    │ outbox
                 ▼        ▼           ▼
        ╔═══════════════════ Kafka ══════════════════════╗
        ║ user.registered  shift.assigned                ║   topics, 3 partitions each,
        ║ attendance.checked_in  attendance.checked_out  ║   key = userId
        ╚════════╤══════════════════════════╤════════════╝
     group "notification"            group "stats-<random>"
          ┌──────▼───────┐              ┌───▼───┐
          │ notification │              │ stats │  read model, no database
          └──────────────┘              └───────┘
```

| Service | Owns | Talks to |
|---|---|---|
| **gateway** | nothing (stateless) | everyone over TCP; only HTTP entry point |
| **auth** | users, passwords, JWT | produces `user.registered` |
| **shift** | shifts, assignments | produces `shift.assigned` |
| **attendance** | check-in/out records | **asks** shift on every check-in, produces `attendance.*` |
| **notification** | Telegram links, send log | consumes every topic (group `notification`) |
| **stats** | nothing: numbers in memory, rebuilt from Kafka | consumes `attendance.*` (its own group) |

Every internal TCP message carries a shared `INTERNAL_TOKEN`; services reject messages without it. Kafka messages carry an HMAC signature of their value instead, so the secret itself is never written to the log.

## Run it locally

Needs Node 22+, PostgreSQL 16+ running on `localhost:5432` (user and password `postgres`, or edit `.env`), and Kafka on `localhost:9092`.

```bash
npm install
npm run setup     # creates .env with random secrets, 4 databases, 4 Prisma clients, runs migrations
npm run kafka:up  # Kafka on localhost:9092 + kafka-ui on http://localhost:8080 (Docker)
npm run dev       # compiles and starts all 6 services with auto-reload
```

No Docker? Download Kafka from kafka.apache.org (needs Java 17+), then:

```bash
bin/kafka-storage.sh format --standalone -t $(bin/kafka-storage.sh random-uuid) -c config/server.properties
bin/kafka-server-start.sh config/server.properties
```

Services create their topics on first start (`ensureTopics()` in `libs/common/src/kafka.ts`).

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

Compose also starts Kafka and kafka-ui (http://localhost:8080). In Docker each service logs into Postgres with its own role that can only reach its own database (`docker/postgres-init.sh`), the internal TCP ports are not published, containers run as a non-root user, and self-registration is off (`ALLOW_REGISTRATION=false`).

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
  stats/src/                no database: a read model built from Kafka events
libs/common/src/            the contracts between services
  patterns.ts               request/response names  ("auth.login", ...)
  events.ts                 event names + payload types ("attendance.checked_in", ...)
  contracts.ts              payload shapes
  services.ts               host/port of every service
  publish.ts                fire-and-forget event helper (live feed only)
  outbox.ts                 transactional outbox + relay that publishes to Kafka
  kafka.ts                  topics, producer, consumer options, signing, retry + dead-letter helper
  internal-auth.ts          INTERNAL_TOKEN on every internal message + the guard that checks it
  config.ts                 required secrets; services refuse to start without them
scripts/kafka-redrive.mjs   moves dead-lettered messages back to their topics
test/                       unit tests (npm test)
```

Services import shared code as `import { ... } from '#common'` (see `"imports"` in `package.json`). **`libs/common` must only hold contracts** (names, types, tiny helpers). Business logic there would couple the services back together.

## What happens on a check-in

1. `POST /attendance/check-in` hits the **gateway**. It verifies the JWT locally, without calling auth.
2. The gateway sends `attendance.check_in` with the user attached.
3. **Attendance** asks **shift** `shift.resolve_for_user`. This is a *synchronous* call with a 2s timeout.
4. Attendance saves the record as `ON_TIME`, `LATE`, `NO_SHIFT`, or `UNVERIFIED` (if shift didn't answer).
5. In the **same database transaction**, attendance writes `attendance.checked_in` to its `OutboxEvent` table (transactional outbox).
6. The outbox relay (polls every second) publishes it to the Kafka topic `attendance.checked_in`, keyed by `userId`, and retries with backoff until the broker acknowledges it. Delivery is at-least-once.
7. Kafka hands the message to **every consumer group**. Attendance doesn't know who they are:
   - **notification** claims the `eventId` (unique, so duplicates are ignored) and sends a Telegram message. If Telegram fails, `consumeEvent()` retries twice more, then moves the message to `notification.dlq`.
   - **stats** adds it to today's counters.
8. Attendance also emits the event to the **gateway** over TCP (best effort), which pushes it to admins connected to `GET /attendance/live` (SSE).
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
| GET | `/stats/daily?date=YYYY-MM-DD` | admin |

Telegram is optional. Set `TELEGRAM_BOT_TOKEN` (and `TELEGRAM_ADMIN_CHAT_ID` for late alerts) in `.env`, then link your chat with `PUT /notifications/telegram`. Without a token, messages are printed to the notification service's log.

## Break it on purpose

Run `npm run dev`, then stop one service in another terminal with `kill $(pgrep -f "apps/<name>/src/main.js")` and watch what happens. `npm run dev` doesn't restart a killed service, so restart it with `npm run dev:<name>`.

| Stop this | Then do this | What you'll see | The lesson |
|---|---|---|---|
| shift | check in, then restart shift | Saved as `UNVERIFIED`, employee not blocked; fixed within 5 min | Degrade gracefully, then reconcile |
| notification | check in a few times, look at its group's **lag** in kafka-ui, then restart it | Check-ins work; notification continues from its committed offset and the lag drops to 0 | A consumer group remembers where it stopped |
| Kafka | check in, then start Kafka again | Check-in works; the event waits in the outbox until Kafka is back | Transactional outbox + retries (`libs/common/src/outbox.ts`) |
| stats | check in, then restart it | Numbers are back: a fresh consumer group replays the topics from the start | The log is the source of truth; a read model can always be rebuilt |
| attendance | check out | Gateway returns **503** | Error translation at the edge (`gateway/src/rpc.ts`) |
| auth | log in, then check in with an existing token | Login fails, but check-in **still works** | Stateless JWT removes a runtime dependency |
| anything | `GET /health` | Which service is down, and latency per service | Observability starts with health checks |

## Kafka in this project

Kafka carries the **events** (facts that already happened). Requests that need an answer (`shift.resolve_for_user`, everything the gateway asks) stay on TCP. Both are NestJS microservice transports. `bootstrapHybridService()` runs one app with both:

| | TCP (requests) | Kafka (events) |
|---|---|---|
| Decorator | `@MessagePattern(pattern, Transport.TCP)` | `@EventPattern(topic, Transport.KAFKA)` |
| Sender | `client.send()` and wait for the reply | outbox relay → `ClientKafka.emit(topic, { key, value, headers })` |
| Receiver down | caller gets 503 | message waits in the topic; consumer catches up |
| Who receives | the one service you called | every consumer group subscribed to the topic |

Concepts and where to see them:

- **Topic and partitions**: each event name is a topic with 3 partitions (`ensureTopics()`). Messages with the same **key** go to the same partition, and order is guaranteed only inside a partition. We key by `userId`, so one person's check-in always comes before their check-out. There is no order *across* topics: after an outage, notification can handle a new user's check-in before their `user.registered`.
- **Consumer groups**: `notification` and `stats` read the same topics independently (fan-out). Start a second `npm run dev:notification` (with a different `NOTIFICATION_PORT`) and watch the partitions split between the two instances in kafka-ui (load balancing). There are 3 partitions, so a 4th instance would sit idle.
- **Offsets**: a group commits how far it got. `notification` keeps its group name and resumes after a restart. `stats` uses a new group every start with `fromBeginning: true`, so it **replays** the log to rebuild its numbers (`apps/stats/src/main.ts`).
- **At-least-once**: a message can arrive twice (crash before the offset commit, redrive). Both consumers ignore an `eventId` they have already handled.
- **Poison messages and the dead-letter topic**: if a handler throws, kafkajs retries the same message forever and the partition is stuck behind it. `consumeEvent()` retries `KAFKA_HANDLER_ATTEMPTS` times, then publishes the message to `<group>.dlq` with `x-error` and `x-original-*` headers. Fix the cause, then run `npm run kafka:redrive` to send it back.
- **Headers**: `x-event-id` and `x-signature` (HMAC of the value, checked by `consumeEvent()`). Unsigned messages go straight to the DLQ, marked `x-permanent`, and the redrive skips them.

Look inside the broker (Docker: prefix with `docker compose exec kafka /opt/kafka/bin/`):

```bash
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic attendance.checked_in
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group notification   # offsets and LAG
kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic attendance.checked_in \
  --from-beginning --property print.key=true --property print.headers=true
```

Or open kafka-ui at http://localhost:8080.

## Next steps (the learning plan)

**Week 1: read and trace**
- Run the demo and follow one check-in through all the logs.
- Add a `correlationId` to every payload and log it in each service, so you can grep one request across services. With Kafka, put it in a header.

**Week 2: Kafka exercises**
- Try every row of "Break it on purpose" above while watching kafka-ui.
- Send yourself a forged event with `kafka-console-producer.sh` and find it in `notification.dlq`.
- `UNVERIFIED` check-ins fixed by `reverify.job.ts` never reach stats. Publish an `attendance.reverified` event through the outbox and handle it in stats.
- Move the gateway's live SSE feed to Kafka: a consumer group per gateway instance (like stats), so it works with several gateway replicas. Then delete `publish()`.
- Give stats a database and a **fixed** group name: it stops replaying and keeps its numbers. What must happen for each event so a duplicate doesn't count twice?
- Add a `telegram-bot` service that produces `attendance.check_in_requested` and see what changes when a command, not a fact, goes through Kafka.

**Week 3: consistency** — done: transactional outbox (`libs/common/src/outbox.ts`), whose relay publishes to Kafka, and re-verification of `UNVERIFIED` records (`apps/attendance/src/reverify.job.ts`).

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
- Durable events (outbox → Kafka), signed Kafka messages, a dead-letter topic per consumer group, retry-safe notifications, race-safe check-out, database checks in `GET /health`.
- Multi-stage Docker image, non-root.

Still to do before a large deployment:

- **TLS between services.** The token authenticates messages, but TCP traffic is plain text. Keep services on a private network, or add `tlsOptions` to the TCP transport / use a service mesh.
- **Kafka for real**: 3 brokers with replication factor 3 (`KAFKA_REPLICATION_FACTOR`), TLS and SASL authentication with ACLs per service, and moving the live SSE feed to Kafka so it works with more than one gateway replica.
- **Shared rate-limit storage** (Redis) when running more than one gateway.
- **Token revocation** (short access tokens + refresh tokens) if a role change must take effect immediately.
- **Observability:** correlation IDs across services, structured logs, metrics and tracing.
- **Overnight shifts** in the shift engine.
- **Rotate the old `JWT_SECRET`**: an earlier version of this repository committed `.env`, so that value is public in git history.
