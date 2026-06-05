/*
Step 1 — Diagnostics:
1. Where does the frontend Pause/Stop button send its signal?
   - Pause sends a POST request to /api/jobs/:jobId/pause.
   - Stop sends a POST request to /api/jobs/:jobId/stop.
2. Does that signal actually reach the BullMQ worker process?
   - No, the worker runs in a separate process and was not listening or checking. We added console.log('[DEBUG] pause/stop received') and a Redis Pub/Sub link to ensure the signal is propagated from server to worker.
3. Inside the worker's process function, is there ANY check for a pause/stop signal between individual email sends?
   - No, there were no checks between individual email sends in the worker or parallel rotator.
4. Is the worker using Promise.allSettled or parallel group sends? If yes, are those parallel loops also checked for the signal, or only the outer loop?
   - Yes, the worker uses Promise.allSettled to run 4 group workers. None of these loops checked for any signal. We updated all of them to check the abort signal.
5. Is ParallelSmtpRotator.sendBatch or SmtpRotator.sendMail called in a loop that has no escape hatch?
   - Yes, the _sendChunk loop in ParallelSmtpRotator had no escape hatch. We added an immediate check for signal.aborted.
*/

/**
 * worker.js — BullMQ Email Worker
 *
 * Run this as a SEPARATE process: `node worker.js`
 *
 * Responsibilities:
 *  1. Pull email batch jobs from the BullMQ "email-queue" queue
 *  2. Split recipients across 4 provider groups, each running in parallel
 *  3. Per-provider rate-limit delays: Gmail 800ms, Brevo 400ms, Mailjet 500ms
 *  4. Update SQLite state: pending → processing → sent | failed
 *  5. Never load all 800K rows into memory — only processes the batch it receives
 */

import { Worker } from 'bullmq';
import { SmtpRotator, ParallelSmtpRotator } from './smtpRotator.js';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import { registerJob, cleanupJob } from './abortRegistry.js';
import {
  initDb,
  getDb,
  getPendingTasks,
  markTaskProcessing,
  markTaskSent,
  markTaskFailed,
} from './db.js';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (all tunable via .env)
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_HOST          = process.env.REDIS_HOST          || '127.0.0.1';
const REDIS_PORT          = parseInt(process.env.REDIS_PORT  || '6379', 10);
const RATE_LIMIT_PER_SEC  = parseInt(process.env.RATE_LIMIT_PER_SECOND || '5', 10); // informational only — actual throttle is per-provider delay in ParallelSmtpRotator
const MAX_RETRIES         = parseInt(process.env.MAX_RETRIES  || '3', 10);
// Each BullMQ job itself runs 4 internal parallel group workers, so keep concurrency low
const WORKER_CONCURRENCY  = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);

console.log('╔══════════════════════════════════════════════╗');
console.log('║       Bulk Email Worker — Starting Up        ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  Redis         : ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`║  Rate limit    : Per-provider delays (Gmail 800ms / Brevo 400ms / Mailjet 500ms)`);
console.log(`║  Max retries   : ${MAX_RETRIES}`);
console.log(`║  Concurrency   : ${WORKER_CONCURRENCY} batch jobs × 4 parallel groups each`);
console.log('╚══════════════════════════════════════════════╝\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Redis Connectivity Check (Avoid silent hangs if Redis is not running)
// ─────────────────────────────────────────────────────────────────────────────
console.log(`[Redis] Testing connection to Redis at ${REDIS_HOST}:${REDIS_PORT}...`);
const redisTest = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  connectTimeout: 5000, // 5 seconds timeout
  maxRetriesPerRequest: 1,
});

try {
  await redisTest.ping();
  console.log('[Redis] ✅ Connected successfully.');
  redisTest.disconnect();
} catch (err) {
  console.error('\n[Redis] ❌ Connection failed:', err.message);
  console.error('        Make sure Redis is running and accessible (e.g. `redis-server` or Docker Redis).');
  console.error('        Shutting down worker.\n');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Initialize DB
// ─────────────────────────────────────────────────────────────────────────────
console.log('[DB] Initializing SQLite database connection...');
await initDb();
console.log('[DB] ✅ SQLite initialized and connected to disk.');

// ─────────────────────────────────────────────────────────────────────────────
// 3. SMTP Rotator — Multi-provider pool
// ─────────────────────────────────────────────────────────────────────────────
console.log('[SMTP] Initializing parallel SMTP group rotator (4 groups × 3 providers)...');
const db = getDb();

// Ensure job_control table exists (worker may start before API server)
db.exec(`
  CREATE TABLE IF NOT EXISTS job_control (
    job_id  TEXT PRIMARY KEY,
    status  TEXT NOT NULL DEFAULT 'running'
  )
`);

// ParallelSmtpRotator — 4 group workers run concurrently per batch job
const parallelRotator = new ParallelSmtpRotator(db);
parallelRotator.printStats(); // show capacity on startup

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Build a mailFactory function for a given subject/template.
 * Returns a function that takes a recipient and returns nodemailer mail options.
 */
function buildMailFactory(subject, template) {
  const fromName = process.env.SMTP_FROM_NAME || 'Bulk Mailer';
  const fromEmail = process.env.DEFAULT_FROM_EMAIL || process.env.SMTP_USER;
  return (recipient) => {
    const name = capitalizeName(recipient.name);
    const body = `Hi ${name} ${template.trim()}`;
    return {
      from:    `"${fromName}" <${fromEmail}>`,
      to:      recipient.email,
      subject: subject,
      html:    body,
    };
  };
}

/**
 * Capitalize each word in a name string.
 */
function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}


// ─────────────────────────────────────────────────────────────────────────────
// BullMQ Worker — processes one job = one batch of email tasks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[WORKER] Starting BullMQ worker subscription...');
const worker = new Worker(
  'email-queue',
  async (job) => {
    const { jobId, subject, template } = job.data;

    console.log(`\n==================================================`);
    console.log(`[JOB] Picked up job from queue: ${job.id}`);
    console.log(`[JOB] Targeting Job ID:         ${jobId}`);
    console.log(`[JOB] Subject:                  "${subject}"`);
    console.log(`==================================================`);

    // Check total SMTP capacity before starting
    if (parallelRotator.getTotalRemainingToday() <= 0) {
      throw new Error('All SMTP providers exhausted for today. Job will retry tomorrow.');
    }

    // Upsert 'running' status for this job into job_control
    db.prepare(`
      INSERT INTO job_control (job_id, status) VALUES (?, 'running')
      ON CONFLICT(job_id) DO UPDATE SET status = 'running'
    `).run(jobId);

    // Fetch only PENDING tasks for this job
    let tasks = getPendingTasks(jobId);

    // Filter out already-sent recipients from sentRecipients in job.data
    const sentRecipients = job.data.sentRecipients || [];
    const sentRecipientsSet = new Set(sentRecipients);
    tasks = tasks.filter(t => !sentRecipientsSet.has(t.email));

    if (tasks.length === 0) {
      console.log(`[JOB] ⚠️ No pending tasks found in SQLite for jobId: ${jobId}. Skipping.`);
      return { processed: 0 };
    }

    // Check for stop/pause before starting
    const controlPre = db.prepare(`SELECT status FROM job_control WHERE job_id = ?`).get(jobId);
    if (controlPre?.status === 'stopped') {
      console.log(`[Worker] Job ${jobId} was stopped before starting.`);
      return { sent: 0, failed: 0, stopped: true };
    }

    // If paused, wait until resumed or stopped
    if (controlPre?.status === 'paused') {
      console.log(`[Worker] Job ${jobId} is paused before start. Waiting...`);
      while (true) {
        await sleep(3000);
        const recheck = db.prepare(`SELECT status FROM job_control WHERE job_id = ?`).get(jobId);
        if (recheck?.status === 'running') break;
        if (recheck?.status === 'stopped') return { sent: 0, failed: 0, stopped: true };
      }
    }

    // Register job with AbortController registry
    const controller = registerJob(jobId);
    const { signal } = controller;

    try {
      console.log(`[JOB] Found ${tasks.length} pending email tasks — dispatching across 4 parallel groups.`);

      // Mark all tasks as processing
      for (const task of tasks) {
        markTaskProcessing(task.id);
      }

      // Build the mail factory function
      const mailFactory = buildMailFactory(subject, template);

      // Track per-recipient task IDs (by email address, keyed for fast lookup)
      const taskByEmail = Object.fromEntries(tasks.map(t => [t.email, t]));

      // onProgress callback — wired to BullMQ job progress reporting
      let sentCount   = 0;
      let failedCount = 0;
      const onProgress = (progress) => {
        const task = taskByEmail[progress.recipient];
        if (!task) return;

        if (progress.success) {
          markTaskSent(task.id);
          sentCount++;
          
          // Append to sentRecipients array and update job data
          sentRecipients.push(progress.recipient);
          job.updateData({
            ...job.data,
            sentRecipients
          }).catch(() => {});

          console.log(`[Worker] ✅ ${progress.recipient} → via ${progress.provider} (Group ${progress.group})`);
        } else {
          markTaskFailed(task.id, progress.error || 'Unknown error');
          failedCount++;
          console.log(`[Worker] ❌ ${progress.recipient} — ${progress.error}`);
        }

        // Update BullMQ job progress (total done / total tasks)
        const totalDone = sentCount + failedCount;
        const pct = tasks.length > 0 ? Math.round((totalDone / tasks.length) * 100) : 0;
        job.updateProgress(pct).catch(() => {}); // fire-and-forget
      };

      // ── Parallel send across 4 groups ────────────────────────────────────────
      const { sent, failed, results } = await parallelRotator.sendBatch(
        tasks,
        mailFactory,
        onProgress,
        signal,
      );

      // Print stats after batch completes
      parallelRotator.printStats();

      console.log(`\n==================================================`);
      console.log(`[JOB] Finished batch ${job.id}`);
      console.log(`[JOB] Summary - Total: ${tasks.length}, Sent: ${sent}, Failed: ${failed}`);
      console.log(`==================================================\n`);

      return { sent, failed };
    } finally {
      cleanupJob(jobId);
    }
  },
  {
    connection: {
      host: REDIS_HOST,
      port: REDIS_PORT,
    },
    concurrency: WORKER_CONCURRENCY,
  }
);

console.log('[WORKER] ✅ Worker is listening and waiting for new email tasks...');

// Worker event handlers
worker.on('completed', (job, result) => {
  console.log(`[WORKER] Job completed successfully: ${job.id}`);
});

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job failed: ${job.id} — Error: ${err.message}`);
});

worker.on('error', (err) => {
  console.error('[WORKER] Unexpected error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[WORKER] SIGTERM received — closing worker gracefully...');
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[WORKER] SIGINT received — closing worker gracefully...');
  await worker.close();
  process.exit(0);
});
