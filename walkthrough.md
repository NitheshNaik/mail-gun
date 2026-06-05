# Walkthrough: Multi-Provider SMTP Rotation + Live Dashboard Controls

## What Was Built

This extends the original bulk email system (async BullMQ + Redis + SQLite + React) with:

1. **Multi-provider SMTP rotation** — stacks 9 free SMTP providers, cycling through them by daily quota to give up to ~3,000–4,000 free sends per day.
2. **Live SMTP provider pool dashboard** — React panel that polls and visualizes each provider's daily usage.
3. **Job pause / resume / stop controls** — mid-batch job control wired through SQLite and the Express API.

---

## Architecture Overview

```
Frontend (React)
    │  POST /api/upload-job  (FormData: file + subject + template)
    │  GET  /api/status/:jobId          (polls every 2s)
    │  GET  /api/smtp-stats             (polls every 5s — always-on)
    │  POST /api/jobs/:jobId/pause|resume|stop
    ▼
Express API Server  :3001
    │  Streams CSV → chunks of 5,000 rows → SQLite + BullMQ
    │  Shared SmtpRotator instance (reads stats from SQLite)
    │  job_control table (pause/resume/stop)
    ▼
Redis (BullMQ Queue)
    ▼
Worker Process  (node worker.js)
    │  Checks remaining SMTP quota before starting each job
    │  Polls job_control on every email iteration → pauses / stops cleanly
    │  Rotates sends across providers via SmtpRotator
    │  Logs: ✅ user@email.com → via brevo (145/300 today)
    │  Prints provider stats table after each batch
    ▼
SQLite DB  (email_jobs.db)
    ├── jobs            — job metadata
    ├── email_tasks     — per-row state machine (pending → sent/failed)
    ├── smtp_usage      — per-provider daily send counter (auto-resets midnight)
    └── job_control     — pause/resume/stop signal per job
```

---

## Files Changed

| File | Change |
|------|--------|
| [smtpRotator.js](file:///c:/Users/Nithesh/Desktop/email/backend/smtpRotator.js) | **NEW** — Multi-provider SMTP rotation. 9 providers, SQLite-backed daily counters, midnight auto-reset, permanent-error detection |
| [worker.js](file:///c:/Users/Nithesh/Desktop/email/backend/worker.js) | **MODIFIED** — Uses `SmtpRotator`; logs provider per send; checks quota before job; prints stats after batch; polls `job_control` for pause/stop on every iteration |
| [server.js](file:///c:/Users/Nithesh/Desktop/email/backend/server.js) | **MODIFIED** — Shared `SmtpRotator` instance; `GET /api/smtp-stats`; `POST /api/jobs/:jobId/pause|resume|stop`; `GET /api/jobs/:jobId/control`; `GET /api/status/:jobId` now returns `controlStatus` |
| [.env](file:///c:/Users/Nithesh/Desktop/email/backend/.env) | **MODIFIED** — Appended 18 new provider env vars (blank, user-fills) |
| [docker-compose.yml](file:///c:/Users/Nithesh/Desktop/email/docker-compose.yml) | **MODIFIED** — All new provider env vars passed through to both `api` and `worker` services |
| [App.jsx](file:///c:/Users/Nithesh/Desktop/email/frontend/src/App.jsx) | **MODIFIED** — `SmtpStatsPanel` component (inline); Pause/Resume/Stop buttons + badges; `controlStatus` and `smtpStats` state; SMTP stats polling always-on from page mount |
| [App.css](file:///c:/Users/Nithesh/Desktop/email/frontend/src/App.css) | **MODIFIED** — Styles for `.job-controls`, `.btn-pause/resume/stop`, `.paused-badge`, `.stopped-badge`, full SMTP panel styles |

---

## New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/smtp-stats` | Per-provider usage stats + totals |
| `POST` | `/api/jobs/:jobId/pause` | Pauses the job mid-batch |
| `POST` | `/api/jobs/:jobId/resume` | Resumes a paused job |
| `POST` | `/api/jobs/:jobId/stop` | Permanently stops a job |
| `GET`  | `/api/jobs/:jobId/control` | Returns current control status |
| `GET`  | `/api/status/:jobId` | Extended — now includes `controlStatus` field |

---

## SmtpRotator — Provider Pool

| Provider | Host | Daily Limit |
|----------|------|-------------|
| brevo | smtp-relay.brevo.com | 300 |
| mailjet | in-v3.mailjet.com | 200 |
| sendpulse | smtp-pulse.com | 400 |
| sender_net | smtp.sender.net | 500 |
| gmail_1 | smtp.gmail.com | 500 |
| gmail_2 | smtp.gmail.com | 500 |
| outlook_1 | smtp-mail.outlook.com | 300 |
| outlook_2 | smtp-mail.outlook.com | 300 |
| mailgun | smtp.mailgun.org | 1,000 |
| **Total** | | **~3,000–4,000 / day** |

Any provider whose env vars are missing/empty is silently skipped. Permanent auth errors (SMTP codes 535/534/530/550/554 or keyword match) mark a provider exhausted for the session and move to the next automatically.

---

## Job Control Flow (Pause / Stop)

```
API → POST /api/jobs/:id/pause → writes 'paused' to job_control table
Worker → on next email iteration:
  - reads job_control
  - if 'paused' → enters polling loop (3s interval) until 'running' or 'stopped'
  - if 'stopped' → breaks out of send loop cleanly, no data deleted
  - if 'running' → resumes normal sending

Frontend:
  - Pause button → amber, shows pulsing PAUSED badge
  - Resume button → green, replaces Pause while paused
  - Stop button → red, always visible, requires window.confirm()
  - STOPPED badge shown after stop, Pause/Resume hidden
```

---

## How to Run

### Option A — Local Dev

```bash
# Terminal 1: Redis
docker run -d -p 6379:6379 redis:7-alpine

# Terminal 2: API Server
cd backend
npm run dev    # node --watch server.js

# Terminal 3: Worker
cd backend
npm run worker # node worker.js

# Terminal 4: Frontend
cd frontend
npm run dev
```

### Option B — Full Docker Compose

```bash
# Fill in backend/.env with at least one SMTP provider credential first
docker compose up --build

# Scale workers for higher throughput
docker compose up --build --scale worker=3
```

---

## Environment Variables

### Original variables (unchanged)
| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `RATE_LIMIT_PER_SECOND` | `5` | Max emails/sec |
| `MAX_RETRIES` | `3` | Retries per email task |
| `BATCH_SIZE` | `5000` | CSV rows per BullMQ job |
| `WORKER_CONCURRENCY` | `5` | Parallel batch jobs |
| `SMTP_USER` / `SMTP_PASS` | — | Legacy single-provider (still used by /api/send-emails) |

### New provider variables (fill in backend/.env)
```
DEFAULT_FROM_EMAIL=
BREVO_USER=          BREVO_PASS=
MAILJET_API_KEY=     MAILJET_SECRET_KEY=
SENDPULSE_USER=      SENDPULSE_PASS=
SENDER_NET_USER=     SENDER_NET_PASS=
GMAIL_1_USER=        GMAIL_1_PASS=
GMAIL_2_USER=        GMAIL_2_PASS=
OUTLOOK_1_USER=      OUTLOOK_1_PASS=
OUTLOOK_2_USER=      OUTLOOK_2_PASS=
MAILGUN_USER=        MAILGUN_PASS=
```

> [!IMPORTANT]
> For Gmail, use App Passwords (not your account password): myaccount.google.com/apppasswords

---

## Verification Checklist

| Check | Status |
|-------|--------|
| `smtpRotator.js` uses `node:sqlite` (DatabaseSync) | ✅ |
| `smtpRotator.js` skips unconfigured providers silently | ✅ |
| `smtpRotator.js` creates `smtp_usage` table with `IF NOT EXISTS` | ✅ |
| `smtpRotator.js` auto-resets counters at midnight | ✅ |
| `smtpRotator.js` marks permanent auth errors exhausted, tries next | ✅ |
| `worker.js` logs provider per send with usage counts | ✅ |
| `worker.js` checks quota before starting job | ✅ |
| `worker.js` prints stats table after each batch | ✅ |
| `worker.js` pauses mid-batch (3s poll) and resumes cleanly | ✅ |
| `worker.js` stops mid-batch without crashing or deleting data | ✅ |
| `server.js` `GET /api/smtp-stats` returns valid JSON | ✅ |
| `server.js` pause/resume/stop return `{ success, jobId, status }` | ✅ |
| `server.js` `/api/status/:jobId` includes `controlStatus` | ✅ |
| `job_control` table created with `IF NOT EXISTS` | ✅ |
| `smtp_usage` table created with `IF NOT EXISTS` | ✅ |
| Frontend SMTP panel visible on page load (no active job needed) | ✅ Fixed |
| Frontend Pause/Resume/Stop buttons show when job is active | ✅ |
| Frontend PAUSED badge pulses while paused | ✅ |
| Frontend Stop requires `window.confirm()` | ✅ |
| No new npm packages installed | ✅ |
| docker-compose.yml passes all provider env vars | ✅ |
