# System Architecture & Design Document
### Bulk Email Sender — "MailGun"
*Generated: 2026-06-05 | Analyst: Antigravity (Senior Software Architect)*

---

## 1. Executive Summary

This system is a **scalable bulk email dispatch platform** built to reliably send large volumes of personalized emails (design target: 800K+/batch) by stacking free-tier quotas across multiple SMTP providers. The backend is an **event-driven, queue-based monolith** split into two co-located processes — an Express API server and a BullMQ worker — communicating asynchronously via Redis. Recipient data is persisted in SQLite with WAL mode for concurrent access, and email state (pending → processing → sent/failed) is tracked at task granularity. The frontend is a React SPA that uploads CSV files, monitors live job progress via polling, and controls job lifecycle (pause/resume/stop). The system is containerized with Docker Compose and designed for horizontal worker scaling.

---

## 2. Technology Stack Summary

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Frontend Framework** | React | 19.x | SPA UI |
| **Frontend Build** | Vite + `@vitejs/plugin-react` | 8.x | Dev server & production bundler |
| **Backend Runtime** | Node.js | 20 (Alpine Docker) | ESM-first server runtime |
| **API Server** | Express | 4.x | HTTP REST API |
| **Queue Broker** | Redis | 7-alpine | BullMQ message broker + Pub/Sub |
| **Queue Library** | BullMQ | 5.x | Job queue (producer + consumer) |
| **Job State DB** | SQLite (Node built-in `node:sqlite`) | Node 22+ | Persistent task tracking |
| **SMTP Sending** | Nodemailer | 6.x | Email dispatch |
| **SMTP Providers** | Gmail, Brevo, Mailjet | — | Free-tier SMTP relays (4 groups × 3) |
| **File Parsing** | csv-parser | 3.x | Streaming CSV row parsing |
| **File Upload** | Multer | 1.x | multipart/form-data handling |
| **Pub/Sub Transport** | ioredis | 5.x | Cross-process abort signal delivery |
| **Containerization** | Docker + Docker Compose | 3.9 | Service orchestration |
| **Config** | dotenv | 16.x | Environment-variable management |
| **ID Generation** | uuid (v4) | 10.x | Unique job IDs |

---

## 3. System Architecture Overview

### 3.1 Architectural Pattern

**Event-Driven Hybrid Monolith** — two separate OS processes sharing one SQLite database file (via WAL-mode concurrent access) and communicating via Redis (BullMQ queue + Pub/Sub channel).

- Not a microservices architecture: there is one shared codebase, one Docker image, and both processes mount the same SQLite file.
- The separation of the API server from the worker is a **process-level isolation**, not a service-level one.
- The pattern is deliberately chosen to allow horizontal worker scaling (`docker compose up --scale worker=N`) without any code changes.

### 3.2 Component Interaction Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL ACTORS                                     │
│                                                                              │
│   Browser (React SPA — Vite / React 19)                                     │
│   └─ CSV Upload, Subject/Template compose, Live monitor, Pause/Resume/Stop  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  HTTP REST  (port 3001)
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                      API SERVER  (server.js — Express)                        │
│                                                                               │
│  POST /api/parse-csv       ─ CSV streaming preview (max 200 rows)            │
│  POST /api/upload-job      ─ Full ingest: stream CSV → SQLite → BullMQ       │
│  GET  /api/status/:jobId   ─ Poll SQLite for task progress counts            │
│  GET  /api/jobs            ─ List last 20 jobs (dashboard)                   │
│  GET  /api/smtp-stats      ─ SmtpRotator usage snapshot                      │
│  POST /api/jobs/:id/pause  ─ abortJob() + SQLite control status              │
│  POST /api/jobs/:id/resume ─ re-enqueue BullMQ job                          │
│  POST /api/jobs/:id/stop   ─ abortJob() + mark tasks failed                 │
│  GET  /api/jobs/:id/control─ read controlStatus from SQLite                  │
│                                                                               │
│  Uses:                                                                        │
│  ┌────────────────────┐   ┌─────────────────────┐   ┌───────────────────┐   │
│  │  SmtpRotator (db)  │   │  AbortRegistry      │   │  BullMQ Queue     │   │
│  │  (stats only—API   │   │  (publish abort to   │   │  Producer only:   │   │
│  │  does not send)    │   │  Redis Pub/Sub)      │   │  emailQueue.add() │   │
│  └────────────────────┘   └─────────────────────┘   └───────┬───────────┘   │
└─────────────────────────────────────────────────────────────┼───────────────┘
                                                              │
                        Redis (port 6379)                     │
              ┌──────────────────────────────────┐           │
              │  BullMQ Queue: "email-queue"     │◄──────────┘
              │  Pub/Sub Channel: "job-aborts"   │
              └──────────────────────────────────┘
                                │   worker pulls jobs
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                     WORKER PROCESS  (worker.js — BullMQ Worker)               │
│                                                                               │
│  Concurrency: 2 BullMQ jobs in parallel                                      │
│  Per job:                                                                     │
│    1. getPendingTasks(jobId) from SQLite                                      │
│    2. Check job_control (paused/stopped) → wait or skip                      │
│    3. registerJob(jobId) → AbortController                                   │
│    4. ParallelSmtpRotator.sendBatch(tasks, mailFactory, onProgress, signal)  │
│       ├─ Splits tasks into 4 equal chunks                                    │
│       ├─ Runs 4 group workers concurrently (Promise.allSettled)              │
│       │  Each group: gmail_N → brevo_N → mailjet_N (round-robin quota)      │
│       └─ Per-send: abort check → sendMail → markTaskSent/Failed → delay     │
│    5. onProgress: markTaskSent / markTaskFailed in SQLite + BullMQ progress  │
│    6. cleanupJob(jobId) in AbortRegistry                                     │
│                                                                               │
│  AbortRegistry also subscribes to Redis "job-aborts" Pub/Sub channel        │
└─────────────────────────────────────────────────────────────────────────────┬─┘
                                                                              │
              ┌───────────────────────────────────────────────────────────────┘
              │  Reads & Writes (WAL-mode concurrent SQLite)
              ▼
┌──────────────────────────────────────────────────────────┐
│             SQLite  (email_jobs.db — WAL mode)           │
│                                                          │
│  Table: jobs          (id, subject, template, total)     │
│  Table: email_tasks   (id, job_id, name, email, status,  │
│                        attempts, error, updated_at)      │
│  Table: smtp_usage    (provider_name, sent_today,        │
│                        daily_limit, reset_date)          │
│  Table: job_control   (job_id, status)                   │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│              SMTP PROVIDERS (external)                   │
│                                                          │
│  Group 1: gmail_1 (500/d) · brevo_1 (300/d) · mailjet_1 │
│  Group 2: gmail_2 (500/d) · brevo_2 (300/d) · mailjet_2 │
│  Group 3: gmail_3 (500/d) · brevo_3 (300/d) · mailjet_3 │
│  Group 4: gmail_4 (500/d) · brevo_4 (300/d) · mailjet_4 │
│                                                          │
│  Total daily capacity: ~4,600 emails/day (as configured) │
└──────────────────────────────────────────────────────────┘
```

### 3.3 Data Flow Narrative

1. **User uploads** a CSV file + subject + template via `POST /api/upload-job`.
2. **Server streams** the CSV row-by-row (never loaded fully into memory). Every 5,000 rows (`BATCH_SIZE`) it flushes: inserts the chunk to SQLite as `email_tasks` and enqueues one BullMQ job into `email-queue`.
3. **Server returns `202 Accepted`** immediately with the `jobId` and count.
4. **BullMQ Worker** dequeues the job, fetches `pending` tasks from SQLite, splits them into 4 chunks, and dispatches each chunk to a group rotator.
5. **ParallelSmtpRotator** sends emails sequentially per group (with per-provider delays), updating SQLite task status after every send.
6. **Frontend polls** `GET /api/status/:jobId` every 2 seconds to display live progress. SMTP stats are polled every 5 seconds.
7. **Pause/Stop** signals flow: browser → `POST /api/jobs/:id/pause` → `abortJob()` publishes to Redis `job-aborts` channel → worker's `AbortRegistry` receives it and calls `controller.abort()` → `_sendChunk` loop sees `signal.aborted === true` and breaks.

---

## 4. Component Responsibilities

### 4.1 `server.js` — Express API Server
The public-facing HTTP layer. Handles all client interactions: CSV upload and streaming ingest, job enqueueing into BullMQ, job status queries against SQLite, SMTP stats read from `SmtpRotator`, and all job lifecycle control (pause/resume/stop). It also owns the `job_control` table schema initialization, manages `SmtpRotator` purely for stats reporting (it does not send emails itself), and uses `abortRegistry.abortJob()` to publish abort signals cross-process via Redis Pub/Sub.

### 4.2 `worker.js` — BullMQ Email Worker
A standalone Node.js process run separately from the API server. Registers with BullMQ as a consumer of the `email-queue` queue at a concurrency of 2. For each dequeued job, it: verifies SMTP capacity, checks the `job_control` table for pause/stop signals, registers an `AbortController`, delegates to `ParallelSmtpRotator.sendBatch()`, updates SQLite task state via `onProgress` callbacks, and reports percentage progress to BullMQ. Handles graceful shutdown on `SIGTERM`/`SIGINT`.

### 4.3 `smtpRotator.js` — `SmtpRotator` & `ParallelSmtpRotator`
The email dispatch engine. `SmtpRotator` manages a pool of SMTP providers (ordered by priority), checking daily quotas from SQLite before each send, auto-resetting counters at midnight, and marking providers permanently exhausted on auth errors. `ParallelSmtpRotator` composes 4 `SmtpRotator` instances (one per group), splits recipient lists into 4 equal chunks, and runs all groups concurrently via `Promise.allSettled`. Per-provider inter-message delays (Gmail: 800 ms, Brevo: 400 ms, Mailjet: 500 ms) are enforced inside `_sendChunk`. Abort signals are checked at the top of each loop iteration.

### 4.4 `db.js` — SQLite State Management Layer
All SQLite interactions are centralized here. Uses Node.js's built-in `node:sqlite` `DatabaseSync` API (synchronous, no callback overhead). Initializes WAL mode, `PRAGMA synchronous = NORMAL`, and foreign keys. Exposes typed functions: `createJob`, `insertEmailTaskBatch` (transactional bulk insert), `getPendingTasks`, `markTaskProcessing/Sent/Failed`, `getJobStatus` (aggregation query), and `getAllJobs`.

### 4.5 `abortRegistry.js` — Cross-Process Abort Signal Bus
A global in-process `Map<jobId, AbortController>` augmented with Redis Pub/Sub for cross-process signal delivery. When the API server calls `abortJob(jobId)`, it both aborts the local controller (if any) and publishes `{"jobId": "..."}` to the `job-aborts` channel. The worker process subscribes to this channel and aborts its own local `AbortController` for the matching job. This bridges the API server and worker across process boundaries without requiring a shared memory region.

### 4.6 `frontend/src/App.jsx` — React SPA
Single-file React 19 application (769 lines). Manages the complete UI: drag-and-drop CSV upload, subject/template composition, live preview, job submission, 2-second polling for progress, 5-second polling for SMTP stats, and control buttons (Pause/Resume/Stop). The `SmtpStatsPanel` sub-component renders the 4-group provider cluster view with collapsible accordions and live usage bars.

---

## 5. Queue Management

| Attribute | Detail |
|---|---|
| **Technology** | BullMQ 5.x backed by Redis 7 |
| **Queue Name** | `email-queue` (single queue) |
| **Job Name Pattern** | `batch-{jobId}-{batchIndex}` (initial) · `resume-{jobId}-{timestamp}` (resume) |
| **Producer** | `server.js` line 68–75 (`new Queue('email-queue', ...)`) |
| **Consumer** | `worker.js` line 157–287 (`new Worker('email-queue', ...)`) |
| **Concurrency** | `WORKER_CONCURRENCY` env var (default: **2** BullMQ jobs in parallel per worker process) |

### Queue Configuration
Defined in `server.js` lines 68–75:
```
defaultJobOptions: {
  attempts:         1,    // BullMQ-level retries disabled (retry logic is inside the worker)
  removeOnComplete: 100,  // retain last 100 completed job metadata in Redis
  removeOnFail:     500,  // retain last 500 failed job metadata in Redis
}
```

### Job Triggering
- Jobs are enqueued inside the streaming `flushChunk()` function (`server.js` line 217–237) whenever an in-memory chunk reaches `BATCH_SIZE` (5,000 rows) or at stream end.
- Resume re-enqueues with a fresh job name (`server.js` line 520): `emailQueue.add('resume-{jobId}-{ts}', { jobId, subject, template, sentRecipients })`.

### Dead-Letter Queue (DLQ)
**Not implemented.** BullMQ's `removeOnFail: 500` retains metadata in Redis but there is no DLQ topic, no forwarding of failed jobs, and no alerting when a BullMQ-level job fails. Failed individual email tasks are only tracked per-task in SQLite.

### Job State Tracking
BullMQ tracks job state in Redis (waiting → active → completed/failed). The canonical source of truth for email-level state is **SQLite** (`email_tasks.status`). BullMQ job progress percentage is also updated via `job.updateProgress(pct)` (`worker.js` line 256) but is not used by the polling UI (which reads SQLite via the status API).

---

## 6. Batch Processing

### What Defines a Batch?
A "batch" in this system has two distinct meanings:

| Level | Definition | Size |
|---|---|---|
| **Ingest batch** (SQLite chunk) | Rows streamed from CSV before a BullMQ job is enqueued | `BATCH_SIZE` env var = **5,000 rows** |
| **Send batch** (worker job) | All pending `email_tasks` for a given `jobId` processed by one BullMQ job execution | All pending rows in SQLite |

### Ingest Batching (`server.js` lines 217–287)
- The CSV is streamed via `fs.createReadStream().pipe(csv())`.
- The stream is **paused** (`stream.pause()`) when the chunk fills, flushed synchronously (`flushChunk()`), then **resumed** (`stream.resume()`).
- `insertEmailTaskBatch` uses an explicit `BEGIN TRANSACTION … COMMIT` (`db.js` lines 117–129) for high-throughput bulk inserts.
- Multiple BullMQ jobs are created per upload (one per chunk of 5,000 rows).

### Send Batch Processing (`smtpRotator.js` lines 510–540)
- The worker fetches all pending tasks for the job from SQLite at once (`getPendingTasks`).
- Tasks are split into **4 equal chunks** (`Math.ceil(recipients.length / 4)`).
- All 4 groups execute **concurrently** via `Promise.allSettled`.
- Within each group, sending is **sequential** (one email at a time, with delay), never parallel at the individual email level.

### Partial Batch Failure Handling
- If an individual email send fails, it is recorded (`markTaskFailed`) and the loop continues (no batch abort for individual failures).
- If a group worker (one of the 4) throws entirely, `Promise.allSettled` catches the rejection (`smtpRotator.js` line 532–536), logs it, increments `failed`, and the other groups are not interrupted.
- If a provider hits its daily quota mid-batch, that group falls through to the next provider in its rotator chain.

### Performance Constraints
- Effective throughput is **~15–20 emails/second** combined (4 groups × ~4–5 emails/sec per group, governed by per-provider delays).
- At ~1,200 emails/minute: 800K emails would take approximately **11+ hours** of continuous sending (across multiple days given daily limits of ~4,600).

---

## 7. Rate Limiting

### Implementation
Rate limiting is implemented **at the provider level** inside `_sendChunk` (`smtpRotator.js` lines 576–589), not at any API gateway or middleware layer.

### Mechanism
Fixed per-provider inter-message delays (a form of **token bucket approximation**):

| Provider | Delay | Approx. Rate |
|---|---|---|
| Gmail | 800 ms | ~75 emails/min/account |
| Brevo | 400 ms | ~150 emails/min/account |
| Mailjet | 500 ms | ~120 emails/min/account |

These are enforced via `sleep(delayForProvider(provider))` after every successful send, and a 200 ms pause after every failure.

### Configuration
Defined in `smtpRotator.js` lines 457–461:
```js
const PROVIDER_DELAY_MS = { gmail: 800, brevo: 400, mailjet: 500 };
```
The `RATE_LIMIT_PER_SECOND` env var (default: 5) is read by `worker.js` line 51 but is explicitly marked as **"informational only"** — it has no effect on actual throughput.

### API-Level Rate Limiting
**Not implemented.** There is no middleware rate limiting (no `express-rate-limit` or similar) on the Express API. Any client can flood the upload endpoint.

### Rate Limit Violation Signaling
Daily quota exhaustion per provider causes `SmtpRotator.sendMail` to `continue` to the next provider. If **all** providers in a group are exhausted, the group skips remaining recipients with `error: 'Group exhausted'` — no HTTP 429, no queue pause.

### Recovery After Rate Limit
- Quota resets happen **at midnight** via a scheduled `setTimeout` in `SmtpRotator._scheduleMidnightReset()` (`smtpRotator.js` lines 411–425).
- A safety net `_maybeResetCounters()` is called before every `sendMail` invocation, checking if `reset_date !== today`.
- Manual reset is available via `node reset-smtp.mjs`.

---

## 8. Retry Mechanism

### BullMQ-Level Retries
BullMQ job-level retries are set to **`attempts: 1`** (`server.js` line 71), meaning **no BullMQ retries** — if the worker job function throws, the BullMQ job is marked failed immediately and not re-queued.

### Application-Level Retry (Provider Fallback)
The retry logic is inside `SmtpRotator.sendMail` (`smtpRotator.js` lines 252–299):
- For each email, providers are tried **in priority order** within the group (gmail → brevo → mailjet).
- On a **transient error** (non-permanent), the error is re-thrown (escalates to `_sendChunk` → recorded as failed, loop continues).
- On a **permanent error** (SMTP codes 535, 534, 530, 550, 554 or keywords: `authentication`, `credentials`, `not authorized`, `rejected`), the provider is marked `exhausted = true` in memory and its `sent_today = daily_limit` in SQLite, then the loop moves to the next provider.

### Per-Task Retry
The `email_tasks` table has an `attempts` column and `incrementAttempt()` function (`db.js` line 160–165), but `MAX_RETRIES` (env var, default: 3) and `incrementAttempt()` are **never called** in the current `worker.js` or `smtpRotator.js` implementation — individual email retries across providers are not tracked. This is a gap.

### Resume as Retry
The `/api/jobs/:jobId/resume` endpoint (`server.js` lines 492–533) re-enqueues a new BullMQ job that will pick up only the remaining `pending` tasks (tasks still in `pending` status). Tasks already marked `sent` are excluded. This acts as a coarse-grained "retry" for a paused job.

### What Happens After All Retries Exhausted?
When all providers in a group are exhausted, the group loop fails remaining recipients with `error: 'Group exhausted'` and `markTaskFailed` is called. No DLQ, no notification, no re-queue.

### Circuit Breaker
**Not implemented.** There is no circuit breaker pattern; provider exhaustion is detected by the `exhausted` boolean flag (in-memory) plus the SQLite quota counter. Transient network errors are not tracked across multiple sends to detect a flapping provider.

### Idempotency
Partial — the `sentRecipients` array in BullMQ job data is updated after each send (`worker.js` line 241–244), and on resume this set is used to filter out already-sent tasks (`worker.js` lines 183–185). However, this in-job-data tracking is separate from the SQLite `status = 'sent'` flag. SQLite status is the authoritative source, making resume idempotent at the task level.

---

## 9. Logging

### Library
**`console.log` / `console.error` / `console.warn`** — the native Node.js console. No structured logging library (no Winston, Pino, Bunyan, etc.) is in use.

### Log Levels In Use

| Level | Method | When Used |
|---|---|---|
| INFO | `console.log` | Job lifecycle, SMTP rotation, startup banners, per-email send results |
| WARN | `console.warn` | Non-fatal issues (no SMTP providers, group failures, provider near limit) |
| ERROR | `console.error` | Exceptions, SMTP auth failures, Redis errors, abort channel errors |
| DEBUG | `console.log('[DEBUG] ...')` | Abort/pause/stop signal tracking (present in `server.js` lines 470, 538 and `abortRegistry.js`) |

### Structured Fields Per Log Event

| Event | Fields Logged |
|---|---|
| Job upload complete | `jobId`, `totalInserted`, `batchIndex` |
| Email sent (worker) | `recipient.email`, `provider`, `group` |
| Email failed (worker) | `recipient.email`, `error message` |
| BullMQ job complete | `job.id` |
| BullMQ job failed | `job.id`, `error.message` |
| Provider exhausted | `provider.name`, `error.message` |
| SMTP reset at midnight | provider pool table (via `printStats()`) |
| Abort signal received | `jobId` (via `[DEBUG]` prefix) |

> **No structured JSON logging.** All logs are plain text. There is no `requestId`, `traceId`, or `correlationId` propagated through the system.

### Log Destinations
**stdout only.** Docker Compose captures stdout/stderr from all containers. There is no log aggregation pipeline (no ELK, no Loki, no Datadog shipper).

### Sensitive Data Handling
SMTP passwords are read from env vars and never logged. The `.env` file contains **plain-text SMTP credentials** (including real App Passwords visible in `backend/.env`). These would appear in git history if committed — a significant security risk.

### Request ID / Trace ID Propagation
**Not implemented.** No correlation ID is assigned to uploads or attached to downstream log entries in the worker.

---

## 10. Monitoring & Observability

### Monitoring Tools
**None integrated.** No Prometheus, Datadog, New Relic, Sentry, Grafana, or OpenTelemetry is present in the codebase or dependencies.

### Application-Level Observability (Custom)
The system builds its own lightweight observability via SQLite queries and a polling API:

| Observable | How Exposed |
|---|---|
| Job progress (%) | `GET /api/status/:jobId` → SQLite aggregate query |
| Task status breakdown (pending/processing/sent/failed) | Same endpoint |
| Per-provider daily usage (sent, limit, remaining, pct) | `GET /api/smtp-stats` → `SmtpRotator.getStats()` |
| Total pool capacity & remaining | Same endpoint (aggregated) |
| Estimated send speed | Calculated client-side in `App.jsx` line 582–587 |
| Provider health (ACTIVE/LOW_BAL/DONE) | Derived from `pct` thresholds in `App.jsx` |
| Job control state | `GET /api/jobs/:id/control` → SQLite `job_control` |

### Health Check Endpoints
**Redis health check only** — defined in `docker-compose.yml` lines 30–34 (`redis-cli ping`). **No HTTP `/health` endpoint** exists for the API server or worker.

### BullMQ Progress Reporting
`job.updateProgress(pct)` is called fire-and-forget in `worker.js` line 256. This updates Redis-stored BullMQ job metadata, but **the UI does not read BullMQ progress directly** — it uses the SQLite-backed status API. BullMQ progress is essentially unused.

### Worker Event Handlers (`worker.js` lines 292–302)
```js
worker.on('completed', (job, result) => console.log(...));
worker.on('failed',    (job, err)    => console.error(...));
worker.on('error',     (err)         => console.error(...));
```
These log to stdout only — no alerting, no metric increment, no webhook.

### Distributed Tracing
**Not implemented.**

### Alerting / SLO / SLA
**Not implemented.** No alerting rules, no SLO definitions, no on-call hooks.

---

## 11. Cross-Cutting Concerns

### 11.1 Error Handling Strategy

**Distributed (local catch at each layer):**

| Layer | Strategy |
|---|---|
| Express routes | `try/catch` → `res.status(500).json({ error: err.message })` |
| CSV stream | `stream.on('error', reject)` → caught by outer `try/catch` |
| `flushChunk()` | `stream.destroy(e)` on error |
| Worker process function | `try/finally` → `cleanupJob(jobId)` always runs |
| `_sendChunk` | per-email `try/catch`; never throws — records failure inline |
| `SmtpRotator.sendMail` | permanent errors marked exhausted; transient re-thrown |
| `Promise.allSettled` | group rejections caught and counted as failed |
| `AbortRegistry` Pub/Sub | `.catch(err => console.error(...))` |

No centralized error boundary, no error classification hierarchy, no global unhandled-rejection handler beyond Node.js defaults.

### 11.2 Concurrency & Locking

| Concern | Mechanism |
|---|---|
| SQLite concurrent reads | WAL mode (`PRAGMA journal_mode = WAL`) allows parallel readers |
| SQLite concurrent writes | SQLite WAL allows one writer at a time — safe since the worker is the only bulk writer |
| Bulk insert atomicity | Explicit `BEGIN TRANSACTION … COMMIT` in `insertEmailTaskBatch` |
| In-process abort | `AbortController` / `AbortSignal` (standard Web API) |
| Cross-process abort | Redis Pub/Sub `job-aborts` channel |
| Provider exhaustion flag | In-memory `provider.exhausted` boolean — **not** shared across worker replicas |
| Concurrent worker replicas | **Risk**: if 2 worker containers run simultaneously they will call `getPendingTasks` on the same SQLite file. Without a distributed lock, the same task could be processed twice. |

> **Critical Gap**: The `provider.exhausted` flag and in-memory quota tracking are **per-worker-process**. Horizontal scaling of workers would result in each worker having its own independent quota tracking, potentially causing `sent_today` in SQLite to be over-incremented or providers to be double-used.

### 11.3 Data Flow & State Transitions

```
email_tasks.status transitions:

  'pending'
      │
      │  markTaskProcessing()    (worker.js line 219)
      ▼
  'processing'
      │
      ├──► markTaskSent()        (worker.js line 237, via onProgress)
      │         └─► 'sent'  ✓
      │
      └──► markTaskFailed()      (worker.js line 248, via onProgress)
                └─► 'failed' ✗

  On stop:   pending|processing → 'failed' (bulk UPDATE, server.js line 559–563)
  On resume: processing → 'pending'        (server.js line 501–505)
```

`job_control.status` transitions:
```
  (default 'running')
        ↓ pause
     'paused'
        ↓ resume
     'running'
        ↓ stop
     'stopped'
```

### 11.4 Configuration Management

All configuration via **environment variables** loaded by `dotenv` from `backend/.env`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3001 | Express listen port |
| `REDIS_HOST` / `REDIS_PORT` | 127.0.0.1 / 6379 | Redis connection |
| `BATCH_SIZE` | 5000 | Rows per SQLite/BullMQ chunk |
| `WORKER_CONCURRENCY` | 2 | BullMQ worker concurrency |
| `MAX_RETRIES` | 3 | Declared but unused |
| `RATE_LIMIT_PER_SECOND` | 5 | Informational only |
| `SMTP_FROM_NAME` | "Exposys Data Lab" | Sender display name |
| `DEFAULT_FROM_EMAIL` | — | From address |
| `GMAIL_N_USER/PASS` (×4) | — | Gmail SMTP credentials |
| `BREVO_N_USER/PASS` (×4) | — | Brevo SMTP credentials |
| `MAILJET_N_API_KEY/SECRET` (×4) | — | Mailjet SMTP credentials |

**No secrets manager.** Credentials are stored in plain-text `.env` files on disk.

**No feature flags.** Configuration is static at startup.

### 11.5 Scalability Design

| Axis | Mechanism | Limitation |
|---|---|---|
| Horizontal worker scaling | `docker compose up --scale worker=N` | SQLite file locking: only safe if workers don't race on the same tasks |
| Batch parallelism | 4 parallel group workers per BullMQ job | Fixed at 4 — not configurable |
| SMTP capacity | Add more provider accounts → more groups | Hardcoded to 4 groups in `GROUP_CONFIGS` |
| Ingest throughput | Streaming CSV parser (never loads full file) | Single-threaded Node.js event loop |
| Status polling | Per-job SQLite aggregate query (indexed) | No caching; each poll hits DB |
| Redis persistence | `--appendonly yes` in Docker Compose | Single Redis node — no Sentinel or Cluster |

### 11.6 Security Boundaries

| Concern | Status |
|---|---|
| API authentication | ❌ **None** — all endpoints are publicly accessible, no auth middleware |
| CORS | Open (`app.use(cors())` — all origins allowed) |
| File upload validation | Partial — only CSV MIME/extension checked; no size limit on upload |
| `.env` in repo | ⚠️ **High risk** — real SMTP credentials visible in `.env` file; no `.gitignore` reference to `backend/.env` |
| Redis exposed | Port 6379 published on `0.0.0.0` in Docker Compose — accessible from LAN |
| SQLite path traversal | Not exploitable via API (path is hardcoded) |
| Request body size | Limited to `10mb` via `express.json({ limit: '10mb' })` |
| Legacy `/api/send-emails` endpoint | Accepts direct email sending up to 500 recipients with SMTP credentials from env — no auth |

---

## 12. Identified Gaps & Recommendations

### 🔴 Critical

| # | Gap | File / Location | Recommendation |
|---|---|---|---|
| C1 | **No API authentication** | `server.js` | Add API key or JWT middleware before all `/api/*` routes. Anyone on the network can trigger mass email sends. |
| C2 | **Plain-text SMTP credentials in `.env` committed to repo** | `backend/.env` | Move to a secrets manager (AWS Secrets Manager, Vault, `.env.local` excluded by `.gitignore`). Rotate all credentials immediately. |
| C3 | **Horizontal worker scaling is unsafe** | `worker.js` `getPendingTasks` | When 2+ workers run concurrently, both will select the same `pending` tasks and double-send. Add a `SELECT … FOR UPDATE SKIP LOCKED` equivalent (use `status = 'processing'` with an atomic compare-and-swap `UPDATE email_tasks SET status='processing' WHERE status='pending' AND id = ?`) before processing each task. |
| C4 | **`provider.exhausted` is per-process** | `smtpRotator.js` line 220 | On horizontal scale-out, quota tracking diverges between workers. Move quota enforcement fully into SQLite (it's already partially there via `smtp_usage`) and remove the in-memory `exhausted` flag. |

### 🟡 High Priority

| # | Gap | File / Location | Recommendation |
|---|---|---|---|
| H1 | **No DLQ or failed-job alerting** | `server.js` `emailQueue` | Configure BullMQ DLQ or a `worker.on('failed')` webhook to notify operators when jobs fail. |
| H2 | **`MAX_RETRIES` and `incrementAttempt()` are declared but unused** | `worker.js` line 52, `db.js` line 160 | Implement per-task retry logic: on transient SMTP error, increment `attempts`, and only mark `failed` after `MAX_RETRIES`. |
| H3 | **No `/health` endpoint** | `server.js` | Add `GET /health` that checks Redis connectivity (`emailQueue.ping()`) and SQLite readability, for Docker health-check and load balancer probes. |
| H4 | **Redis has no authentication** | `docker-compose.yml` line 22 | Add `requirepass` to Redis config and set `REDIS_PASSWORD` env var. |
| H5 | **Daily capacity ceiling (4,600/day) vs. 800K design target** | `smtpRotator.js` `PROVIDER_CONFIGS` | System as configured supports ~4,600 emails/day — ~174 days for 800K. Document this constraint clearly or add more provider groups. |
| H6 | **No structured / JSON logging** | All files | Adopt Pino or Winston with JSON output + `requestId`/`jobId` fields for log correlation. |

### 🟢 Medium Priority

| # | Gap | File / Location | Recommendation |
|---|---|---|---|
| M1 | **No monitoring / alerting integration** | All | Integrate Prometheus metrics (queue depth, job duration, error rate) and wire to Grafana + AlertManager. |
| M2 | **No distributed tracing** | All | Add OpenTelemetry with trace IDs propagated from upload → BullMQ job → worker → SMTP send. |
| M3 | **Open CORS** | `server.js` line 61 | Restrict `cors()` to known frontend origins. |
| M4 | **`/api/send-emails` legacy endpoint** | `server.js` lines 353–405 | This endpoint uses hardcoded single-provider SMTP and is marked "not suitable for 800K". Remove or protect it. |
| M5 | **No email validation beyond `@` check** | `server.js` line 161 | Use a library like `validator.js` `isEmail()` for RFC-compliant validation. |
| M6 | **Frontend `API_BASE` is hardcoded** | `App.jsx` line 4 | Use `import.meta.env.VITE_API_BASE` so the frontend can target different environments. |
| M7 | **No email template HTML sanitization** | `worker.js` line 136 (`html: body`) | If `templateMessage` ever contains user-provided HTML, XSS in emails is possible. Sanitize with DOMPurify or bleach before including in `html` field. |
| M8 | **Midnight reset uses a single `setTimeout` chain** | `smtpRotator.js` line 411 | If the process restarts near midnight, the timer resets and providers won't reset until the *next* midnight. Prefer a cron (`node-cron`) or rely entirely on the `_maybeResetCounters()` safety net. |
| M9 | **SQLite not suitable for multi-machine deployment** | `db.js` | If workers run on separate machines (not just separate containers on one host), they cannot share a SQLite file. Migrate to PostgreSQL for true horizontal scaling. |
| M10 | **No circuit breaker for flapping SMTP providers** | `smtpRotator.js` | Add exponential backoff + circuit breaker (e.g., `opossum`) to avoid hammering a temporarily unreachable SMTP server. |
