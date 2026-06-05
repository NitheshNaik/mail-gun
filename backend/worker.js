/**
 * worker.js — BullMQ Email Worker
 *
 * Run this as a SEPARATE process: `node worker.js`
 *
 * Responsibilities:
 *  1. Pull email batch jobs from the BullMQ "email-queue" queue
 *  2. Rate-limit sends to RATE_LIMIT_PER_SECOND (configurable)
 *  3. Send each email via Nodemailer with exponential backoff (up to MAX_RETRIES)
 *  4. Update SQLite state: pending → processing → sent | failed
 *  5. Never load all 800K rows into memory — only processes the batch it receives
 */

import { Worker } from 'bullmq';
import { SmtpRotator } from './smtpRotator.js';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import {
  initDb,
  getDb,
  getPendingTasks,
  markTaskProcessing,
  markTaskSent,
  markTaskFailed,
  incrementAttempt,
} from './db.js';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (all tunable via .env)
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_HOST          = process.env.REDIS_HOST          || '127.0.0.1';
const REDIS_PORT          = parseInt(process.env.REDIS_PORT  || '6379', 10);
const RATE_LIMIT_PER_SEC  = parseInt(process.env.RATE_LIMIT_PER_SECOND || '5', 10);
const MAX_RETRIES         = parseInt(process.env.MAX_RETRIES  || '3', 10);
const WORKER_CONCURRENCY  = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

// Interval in ms between each email send to honour the rate limit
const SEND_INTERVAL_MS = Math.floor(1000 / RATE_LIMIT_PER_SEC);

console.log('╔══════════════════════════════════════════════╗');
console.log('║       Bulk Email Worker — Starting Up        ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  Redis         : ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`║  Rate limit    : ${RATE_LIMIT_PER_SEC} emails/sec (${SEND_INTERVAL_MS}ms gap)`);
console.log(`║  Max retries   : ${MAX_RETRIES}`);
console.log(`║  Concurrency   : ${WORKER_CONCURRENCY} batch jobs in parallel`);
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
console.log('[SMTP] Initializing multi-provider SMTP rotator...');
const db = getDb();

// Ensure job_control table exists (worker may start before API server)
db.exec(`
  CREATE TABLE IF NOT EXISTS job_control (
    job_id  TEXT PRIMARY KEY,
    status  TEXT NOT NULL DEFAULT 'running'
  )
`);

const rotator = new SmtpRotator(db);
rotator.printStats(); // show capacity on startup

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

/**
 * Send one email via the SMTP rotator with exponential backoff retry.
 */
async function sendWithRetry(task, subject, template) {
  const { id: taskId, name, email } = task;
  const capitalizedName = capitalizeName(name);
  const body = `Hi ${capitalizedName} ${template.trim()}`;
  const fromName = process.env.SMTP_FROM_NAME || 'Bulk Mailer';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      incrementAttempt(taskId);

      const { messageId, provider } = await rotator.sendMail({
        from:    `"${fromName}" <${process.env.DEFAULT_FROM_EMAIL || process.env.SMTP_USER}>`,
        to:      email,
        subject: subject,
        html:    body,
      });

      return { success: true, provider };

    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s

      console.warn(
        `[RETRY] Task ${taskId} | ${email} | Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`
      );

      if (isLastAttempt) {
        return { success: false, error: err.message };
      }

      console.log(`[RETRY] Backing off for ${backoffMs}ms before attempt ${attempt + 1}...`);
      await sleep(backoffMs);
    }
  }
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

    // ── Task 2 Change 5: Check total SMTP capacity before starting ──────────
    if (rotator.getTotalRemainingToday() <= 0) {
      throw new Error('All SMTP providers exhausted for today. Job will retry tomorrow.');
    }

    // ── Task 4: Upsert 'running' status for this job into job_control ────────
    db.prepare(`
      INSERT INTO job_control (job_id, status) VALUES (?, 'running')
      ON CONFLICT(job_id) DO UPDATE SET status = 'running'
    `).run(jobId);

    // Fetch only PENDING tasks for this job (safely re-reads the updated SQLite file)
    const tasks = getPendingTasks(jobId);

    if (tasks.length === 0) {
      console.log(`[JOB] ⚠️ No pending tasks found in SQLite for jobId: ${jobId}. Skipping.`);
      return { processed: 0 };
    }

    console.log(`[JOB] Found ${tasks.length} pending email tasks to dispatch.`);

    let sentCount   = 0;
    let failedCount = 0;
    let stopped     = false;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];

      // ── Task 4: Pause / Stop control check ─────────────────────────────────
      const control = db.prepare(
        `SELECT status FROM job_control WHERE job_id = ?`
      ).get(jobId);

      if (control?.status === 'stopped') {
        console.log(`[Worker] Job ${jobId} was stopped. Halting.`);
        stopped = true;
        break; // exit the for loop, do not send remaining emails
      }

      if (control?.status === 'paused') {
        console.log(`[Worker] Job ${jobId} is paused. Waiting...`);
        // Poll every 3 seconds until resumed or stopped
        while (true) {
          await new Promise(r => setTimeout(r, 3000));
          const recheck = db.prepare(
            `SELECT status FROM job_control WHERE job_id = ?`
          ).get(jobId);
          if (recheck?.status === 'running') break;
          if (recheck?.status === 'stopped') {
            console.log(`[Worker] Job ${jobId} stopped while paused.`);
            return { sent: sentCount, failed: failedCount, stopped: true };
          }
        }
        console.log(`[Worker] Job ${jobId} resumed.`);
      }
      // ───────────────────────────────────────────────────────────────────────

      // Mark as processing (so a server/worker restart skips it)
      markTaskProcessing(task.id);

      console.log(`[SENDING ${i + 1}/${tasks.length}] ${task.email} (Name: ${task.name || 'N/A'})...`);
      const result = await sendWithRetry(task, subject, template);

      if (result.success) {
        markTaskSent(task.id);
        sentCount++;
        // Show usage stats after send (constraint #9)
        const stats = rotator.getStats();
        const provStat = stats.find(s => s.provider === result.provider);
        console.log(`[Worker] ✅ ${task.email} → via ${result.provider} (${provStat?.sent ?? '?'}/${provStat?.limit ?? '?'} today)`);
      } else {
        markTaskFailed(task.id, result.error);
        failedCount++;
        console.log(`[FAILURE] ❌ Failed for ${task.email} — Error: ${result.error}`);
      }

      // Rate limiting: honour the send interval between emails
      if (i < tasks.length - 1) {
        await sleep(SEND_INTERVAL_MS);
      }
    }

    // ── Task 2 Change 4: Print stats after each batch completes ─────────────
    rotator.printStats();

    console.log(`\n==================================================`);
    console.log(`[JOB] Finished batch ${job.id}${stopped ? ' (stopped by user)' : ''}`);
    console.log(`[JOB] Summary - Total: ${tasks.length}, Sent: ${sentCount}, Failed: ${failedCount}`);
    console.log(`==================================================\n`);

    return { sent: sentCount, failed: failedCount };
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
