import express from 'express';
import cors from 'cors';
import multer from 'multer';
import csv from 'csv-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import {
  initDb,
  getDb,
  createJob,
  insertEmailTaskBatch,
  incrementJobTotal,
  getJobStatus,
  getAllJobs,
} from './db.js';
import { SmtpRotator } from './smtpRotator.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_HOST  = process.env.REDIS_HOST  || '127.0.0.1';
const REDIS_PORT  = parseInt(process.env.REDIS_PORT || '6379', 10);
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  || '5000', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ Queue (API server only enqueues — worker dequeues)
// ─────────────────────────────────────────────────────────────────────────────

const emailQueue = new Queue('email-queue', {
  connection: { host: REDIS_HOST, port: REDIS_PORT },
  defaultJobOptions: {
    attempts:    1,          // BullMQ-level retries = 1 (retry logic is in worker.js)
    removeOnComplete: 100,   // keep last 100 completed job records in Redis
    removeOnFail:     500,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// File upload setup (disk storage)
// ─────────────────────────────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = /csv/.test(path.extname(file.originalname).toLowerCase()) ||
               /csv/.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only CSV files are allowed!'));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/parse-csv
// Preview endpoint (unchanged from original) — loads CSV for table preview
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/parse-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const rows = await new Promise((resolve, reject) => {
      const data = [];
      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', row => {
          const clean = {};
          Object.keys(row).forEach(k => { clean[k.trim()] = row[k]; });
          data.push(clean);
        })
        .on('end',   () => resolve(data))
        .on('error', reject);
    });

    fs.unlinkSync(req.file.path);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty' });
    }

    const firstRow  = rows[0];
    const nameKey   = Object.keys(firstRow).find(k => k.toLowerCase().includes('name'));
    const emailKey  = Object.keys(firstRow).find(k => k.toLowerCase().includes('email'));

    if (!nameKey || !emailKey) {
      return res.status(400).json({
        error: 'CSV must contain columns for "name" and "email"',
        detectedHeaders: Object.keys(firstRow),
      });
    }

    // Return only a preview slice (max 200 rows) to keep response fast
    const preview = rows.slice(0, 200).map((row, index) => {
      const originalName = row[nameKey] ? row[nameKey].trim() : '';
      const email        = row[emailKey] ? row[emailKey].trim() : '';
      return {
        id:    index + 1,
        name:  capitalizeName(originalName),
        email,
        valid: email !== '' && email.includes('@'),
      };
    });

    res.json({
      recipients:  preview,
      totalInFile: rows.length,
      preview:     rows.length > 200,
    });
  } catch (error) {
    console.error('Error parsing CSV:', error);
    res.status(500).json({ error: error.message || 'Failed to parse CSV' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/upload-job
//
// THE CORE SCALABLE ENDPOINT:
//  1. Accepts: multipart form (file + subject + templateMessage)
//  2. Creates a job record in SQLite
//  3. Streams the CSV — NEVER loads all rows into memory
//  4. Inserts rows into SQLite in chunks of BATCH_SIZE
//  5. Enqueues one BullMQ job per chunk (so workers can parallelize)
//  6. Returns { jobId } IMMEDIATELY — does not wait for sending
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/upload-job', upload.single('file'), async (req, res) => {
  const { subject, templateMessage } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded.' });
  }
  if (!subject || !subject.trim()) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Email subject is required.' });
  }
  if (!templateMessage || !templateMessage.trim()) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Message template is required.' });
  }

  // Detect name/email column headers from first row
  let nameKey  = null;
  let emailKey = null;
  let headerDetected = false;

  const jobId = uuidv4();
  let   totalInserted = 0;
  let   chunk         = [];
  let   batchIndex    = 0;
  let   dbReady       = false;

  const filePath = req.file.path;

  // Flush current chunk to SQLite + enqueue a BullMQ job
  async function flushChunk() {
    if (chunk.length === 0) return;

    // Lazy-init job row (only after we've confirmed headers are valid)
    if (!dbReady) {
      createJob(jobId, subject.trim(), templateMessage.trim());
      dbReady = true;
    }

    const rowsToInsert = chunk.splice(0);          // move out & reset
    insertEmailTaskBatch(jobId, rowsToInsert);
    incrementJobTotal(jobId, rowsToInsert.length);
    totalInserted += rowsToInsert.length;

    // Enqueue one BullMQ job per batch — worker picks it up asynchronously
    await emailQueue.add(`batch-${jobId}-${batchIndex++}`, {
      jobId,
      subject:  subject.trim(),
      template: templateMessage.trim(),
    });
  }

  try {
    // Stream-parse the CSV
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath).pipe(csv());

      stream.on('data', async (row) => {
        // Clean column keys
        const clean = {};
        Object.keys(row).forEach(k => { clean[k.trim()] = row[k]; });

        // Auto-detect headers from first row
        if (!headerDetected) {
          nameKey  = Object.keys(clean).find(k => k.toLowerCase().includes('name'));
          emailKey = Object.keys(clean).find(k => k.toLowerCase().includes('email'));
          headerDetected = true;

          if (!emailKey) {
            stream.destroy(new Error('CSV must contain an "email" column.'));
            return;
          }
        }

        const email = clean[emailKey] ? clean[emailKey].trim() : '';
        const name  = nameKey && clean[nameKey] ? clean[nameKey].trim() : '';

        // Skip rows with no email at all (but don't crash)
        if (!email) return;

        chunk.push({ name, email });

        // Flush when chunk reaches BATCH_SIZE
        if (chunk.length >= BATCH_SIZE) {
          stream.pause();
          try {
            await flushChunk();
          } catch (e) {
            stream.destroy(e);
            return;
          }
          stream.resume();
        }
      });

      stream.on('end',   resolve);
      stream.on('error', reject);
    });

    // Flush any remaining rows (< BATCH_SIZE)
    await flushChunk();

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    if (totalInserted === 0) {
      return res.status(400).json({ error: 'No valid email rows found in the CSV.' });
    }

    console.log(`[UPLOAD] ✅ Job ${jobId} — ${totalInserted} tasks queued in ${batchIndex} batches.`);

    res.status(202).json({
      message:        'File accepted. Email sending started in the background.',
      jobId,
      totalQueued:    totalInserted,
      batches:        batchIndex,
    });

  } catch (error) {
    // Clean up on error
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('[UPLOAD] Error processing CSV:', error);
    res.status(500).json({ error: error.message || 'Failed to process CSV.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /api/status/:jobId
//
// Polling endpoint — called by UI every 2s to show live progress.
// Queries SQLite (fast indexed lookup) and returns status breakdown.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;

  const status = getJobStatus(jobId);

  if (!status) {
    return res.status(404).json({ error: `Job "${jobId}" not found.` });
  }

  // Task 3d: include controlStatus in the response
  const controlStatus = getJobControlStatus(jobId);

  res.json({ ...status, controlStatus });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /api/jobs
//
// Returns a list of recent jobs (for dashboard overview).
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/jobs', (req, res) => {
  const jobs = getAllJobs();
  res.json({ jobs });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/send-emails  (legacy compatibility — small batches only)
//
// Kept for backward compatibility with the original frontend flow.
// NOT suitable for 800K — use /api/upload-job for scale.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/send-emails', async (req, res) => {
  const { recipients, subject, templateMessage } = req.body;

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Recipients list is empty or invalid' });
  }
  if (recipients.length > 500) {
    return res.status(400).json({
      error: 'Too many recipients for direct send. Use /api/upload-job for batches over 500.',
    });
  }
  if (!subject?.trim())         return res.status(400).json({ error: 'Subject is required' });
  if (!templateMessage?.trim()) return res.status(400).json({ error: 'Template is required' });

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  try {
    await transporter.verify();
  } catch (err) {
    return res.status(500).json({ error: 'SMTP verification failed', details: err.message });
  }

  const results = [];

  for (const recipient of recipients) {
    const { name, email } = recipient;
    if (!email || !email.includes('@')) {
      results.push({ ...recipient, status: 'failed', error: 'Invalid email' });
      continue;
    }
    const body = `Hi ${capitalizeName(name)} ${templateMessage.trim()}`;
    try {
      const info = await transporter.sendMail({
        from:    `"${process.env.SMTP_FROM_NAME || 'Bulk Mailer'}" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: subject,
        text:    body,
      });
      results.push({ ...recipient, status: 'sent', messageId: info.messageId });
    } catch (err) {
      results.push({ ...recipient, status: 'failed', error: err.message });
    }
  }

  const sentCount   = results.filter(r => r.status === 'sent').length;
  const failedCount = results.length - sentCount;
  res.json({ summary: { total: results.length, sent: sentCount, failed: failedCount }, results });
});

// ─────────────────────────────────────────────────────────────────────────────
// Initialize DB on startup and start server
// ─────────────────────────────────────────────────────────────────────────────
await initDb();
console.log('[DB] SQLite initialized.');

// ─────────────────────────────────────────────────────────────────────────────
// Create job_control table (Task 3c)
// ─────────────────────────────────────────────────────────────────────────────
const db = getDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS job_control (
    job_id  TEXT PRIMARY KEY,
    status  TEXT NOT NULL DEFAULT 'running'
  )
`);
console.log('[DB] job_control table ready.');

// ─────────────────────────────────────────────────────────────────────────────
// Shared SmtpRotator instance (Task 3a)
// ─────────────────────────────────────────────────────────────────────────────
const rotator = new SmtpRotator(db);

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /api/smtp-stats  (Task 3b)
//
// Returns per-provider usage stats for the live dashboard panel.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/smtp-stats', (req, res) => {
  try {
    const stats          = rotator.getStats();
    const totalCapacity  = rotator.getTotalDailyCapacity();
    const totalSentToday = rotator.getTotalSentToday();
    const totalRemaining = rotator.getTotalRemainingToday();
    res.json({ stats, totalCapacity, totalSentToday, totalRemaining });
  } catch (err) {
    console.error('[API] /api/smtp-stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch SMTP stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes: Job Pause / Resume / Stop / Control  (Task 3c)
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: upsert a control status for a job. */
function setJobControlStatus(jobId, status) {
  db.prepare(`
    INSERT INTO job_control (job_id, status) VALUES (?, ?)
    ON CONFLICT(job_id) DO UPDATE SET status = excluded.status
  `).run(jobId, status);
}

/** Helper: get the current control status for a job (defaults to 'running'). */
function getJobControlStatus(jobId) {
  const row = db.prepare(`SELECT status FROM job_control WHERE job_id = ?`).get(jobId);
  return row?.status ?? 'running';
}

app.post('/api/jobs/:jobId/pause', (req, res) => {
  const { jobId } = req.params;
  try {
    setJobControlStatus(jobId, 'paused');
    console.log(`[CONTROL] Job ${jobId} paused.`);
    res.json({ success: true, jobId, status: 'paused' });
  } catch (err) {
    console.error('[API] pause error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:jobId/resume', (req, res) => {
  const { jobId } = req.params;
  try {
    setJobControlStatus(jobId, 'running');
    console.log(`[CONTROL] Job ${jobId} resumed.`);
    res.json({ success: true, jobId, status: 'running' });
  } catch (err) {
    console.error('[API] resume error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:jobId/stop', (req, res) => {
  const { jobId } = req.params;
  try {
    setJobControlStatus(jobId, 'stopped');
    console.log(`[CONTROL] Job ${jobId} stopped.`);
    res.json({ success: true, jobId, status: 'stopped' });
  } catch (err) {
    console.error('[API] stop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:jobId/control', (req, res) => {
  const { jobId } = req.params;
  try {
    const status = getJobControlStatus(jobId);
    res.json({ jobId, status });
  } catch (err) {
    console.error('[API] control status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 API Server running on port ${PORT}`);
  console.log(`   SMTP User : ${process.env.SMTP_USER || 'Not Configured'}`);
  console.log(`   Redis     : ${REDIS_HOST}:${REDIS_PORT}`);
  console.log(`   Batch Size: ${BATCH_SIZE} rows/chunk\n`);
});
