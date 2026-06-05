/**
 * db.js — SQLite State Management Layer
 *
 * Uses Node.js built-in 'node:sqlite' DatabaseSync.
 * Operating directly on the disk file avoids stale in-memory state
 * between the API server and worker processes.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'email_jobs.db');

let _db = null;  // DatabaseSync instance

/**
 * Initialize SQLite database file.
 * Must be called at startup.
 */
export async function initDb() {
  if (_db) return _db;

  // DatabaseSync automatically creates the file if it does not exist
  _db = new DatabaseSync(DB_PATH);

  // Enable WAL mode for high performance concurrent reads and writes
  _db.exec(`PRAGMA journal_mode = WAL`);
  _db.exec(`PRAGMA synchronous = NORMAL`);
  _db.exec(`PRAGMA foreign_keys = ON`);

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id         TEXT    PRIMARY KEY,
      created_at DATETIME DEFAULT (datetime('now')),
      total      INTEGER DEFAULT 0,
      subject    TEXT    NOT NULL,
      template   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_tasks (
      id         INTEGER  PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT     NOT NULL,
      name       TEXT,
      email      TEXT     NOT NULL,
      status     TEXT     DEFAULT 'pending',
      attempts   INTEGER  DEFAULT 0,
      error      TEXT,
      updated_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_tasks_job_id
      ON email_tasks(job_id);

    CREATE INDEX IF NOT EXISTS idx_email_tasks_status
      ON email_tasks(job_id, status);
  `);

  return _db;
}

/**
 * Return the current db instance (throws if not initialized).
 */
export function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

/**
 * No-op for backward compatibility.
 * Native SQLite writes directly to disk, so manual export is no longer needed.
 */
export function persist() {
  // No-op
}

// ─────────────────────────────────────────────────────────────────────────────
// Job helpers
// ─────────────────────────────────────────────────────────────────────────────

export function createJob(id, subject, template) {
  const stmt = getDb().prepare(
    `INSERT INTO jobs (id, subject, template) VALUES (?, ?, ?)`
  );
  stmt.run(id, subject, template);
}

export function incrementJobTotal(jobId, count) {
  const stmt = getDb().prepare(
    `UPDATE jobs SET total = total + ? WHERE id = ?`
  );
  stmt.run(count, jobId);
}

export function getJob(jobId) {
  const stmt = getDb().prepare(`SELECT * FROM jobs WHERE id = ?`);
  return stmt.get(jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Email task helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-insert a batch of email tasks.
 * Uses manual transaction (BEGIN/COMMIT) for high throughput.
 */
export function insertEmailTaskBatch(jobId, rows) {
  const dbInstance = getDb();
  dbInstance.exec('BEGIN TRANSACTION');
  try {
    const stmt = dbInstance.prepare(
      `INSERT INTO email_tasks (job_id, name, email, status) VALUES (?, ?, ?, 'pending')`
    );
    for (const row of rows) {
      stmt.run(jobId, row.name || '', row.email || '');
    }
    dbInstance.exec('COMMIT');
  } catch (err) {
    dbInstance.exec('ROLLBACK');
    throw err;
  }
}

export function getPendingTasks(jobId) {
  const stmt = getDb().prepare(
    `SELECT id, name, email FROM email_tasks WHERE job_id = ? AND status = 'pending' ORDER BY id ASC`
  );
  return stmt.all(jobId);
}

export function markTaskProcessing(taskId) {
  const stmt = getDb().prepare(
    `UPDATE email_tasks SET status = 'processing', updated_at = datetime('now') WHERE id = ?`
  );
  stmt.run(taskId);
}

export function markTaskSent(taskId) {
  const stmt = getDb().prepare(
    `UPDATE email_tasks SET status = 'sent', updated_at = datetime('now') WHERE id = ?`
  );
  stmt.run(taskId);
}

export function markTaskFailed(taskId, errorMsg) {
  const stmt = getDb().prepare(
    `UPDATE email_tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`
  );
  stmt.run(errorMsg, taskId);
}

export function incrementAttempt(taskId) {
  const stmt = getDb().prepare(
    `UPDATE email_tasks SET attempts = attempts + 1 WHERE id = ?`
  );
  stmt.run(taskId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status / Progress helpers (called by API server)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a full status summary for a job.
 * Returns: { total, pending, processing, sent, failed, percentage, completed }
 */
export function getJobStatus(jobId) {
  const job = getJob(jobId);
  if (!job) return null;

  const stmt = getDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'sent'       THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) AS failed,
      COUNT(*)                                                AS total_tasks
    FROM email_tasks
    WHERE job_id = ?
  `);
  const counts = stmt.get(jobId);

  const total = job.total || counts?.total_tasks || 0;
  const done  = (counts?.sent || 0) + (counts?.failed || 0);
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    jobId,
    total,
    pending:    counts?.pending    || 0,
    processing: counts?.processing || 0,
    sent:       counts?.sent       || 0,
    failed:     counts?.failed     || 0,
    percentage,
    completed:  percentage === 100,
  };
}

/**
 * Return summary rows for the /api/jobs list endpoint.
 */
export function getAllJobs() {
  const stmt = getDb().prepare(`
    SELECT
      j.id,
      j.created_at,
      j.total,
      j.subject,
      SUM(CASE WHEN t.status = 'sent'       THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN t.status = 'failed'     THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN t.status = 'pending'    THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN t.status = 'processing' THEN 1 ELSE 0 END) AS processing
    FROM jobs j
    LEFT JOIN email_tasks t ON t.job_id = j.id
    GROUP BY j.id
    ORDER BY j.created_at DESC
    LIMIT 20
  `);
  return stmt.all();
}
