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
 * smtpRotator.js — Multi-Provider SMTP Rotation Manager
 *
 * Manages a pool of SMTP providers, rotating sends across them to
 * stack their free daily limits. Tracks usage in SQLite, auto-resets
 * counters at midnight, and falls back to the next provider on
 * permanent auth errors.
 *
 * Provider layout (priority order):
 *   Group 1: gmail_1 → brevo_1 → mailjet_1
 *   Group 2: gmail_2 → brevo_2 → mailjet_2
 *   Group 3: gmail_3 → brevo_3 → mailjet_3
 *   Group 4: gmail_4 → brevo_4 → mailjet_4
 *
 * Total max daily capacity: 4 × (500 + 300 + 200) = 4,000 emails/day
 *
 * IMPORTANT: Uses ES module syntax (import/export) — consistent with
 * the rest of the backend (package.json "type": "module").
 */

import nodemailer from 'nodemailer';

// ─────────────────────────────────────────────────────────────────────────────
// Provider definitions (priority order — first provider used first)
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_CONFIGS = [
  // ── Group 1 ───────────────────────────────────────────
  {
    name:       'gmail_1',
    host:       'smtp.gmail.com',
    port:       587,
    dailyLimit: 500,
    userEnv:    'GMAIL_1_USER',
    passEnv:    'GMAIL_1_PASS',
  },
  {
    name:       'brevo_1',
    host:       'smtp-relay.brevo.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'BREVO_1_USER',
    passEnv:    'BREVO_1_PASS',
  },
  {
    name:       'mailjet_1',
    host:       'in-v3.mailjet.com',
    port:       587,
    dailyLimit: 200,
    userEnv:    'MAILJET_1_API_KEY',
    passEnv:    'MAILJET_1_SECRET_KEY',
  },

  // ── Group 2 ───────────────────────────────────────────
  {
    name:       'gmail_2',
    host:       'smtp.gmail.com',
    port:       587,
    dailyLimit: 500,
    userEnv:    'GMAIL_2_USER',
    passEnv:    'GMAIL_2_PASS',
  },
  {
    name:       'brevo_2',
    host:       'smtp-relay.brevo.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'BREVO_2_USER',
    passEnv:    'BREVO_2_PASS',
  },
  {
    name:       'mailjet_2',
    host:       'in-v3.mailjet.com',
    port:       587,
    dailyLimit: 200,
    userEnv:    'MAILJET_2_API_KEY',
    passEnv:    'MAILJET_2_SECRET_KEY',
  },

  // ── Group 3 ───────────────────────────────────────────
  {
    name:       'gmail_3',
    host:       'smtp.gmail.com',
    port:       587,
    dailyLimit: 500,
    userEnv:    'GMAIL_3_USER',
    passEnv:    'GMAIL_3_PASS',
  },
  {
    name:       'brevo_3',
    host:       'smtp-relay.brevo.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'BREVO_3_USER',
    passEnv:    'BREVO_3_PASS',
  },
  {
    name:       'mailjet_3',
    host:       'in-v3.mailjet.com',
    port:       587,
    dailyLimit: 200,
    userEnv:    'MAILJET_3_API_KEY',
    passEnv:    'MAILJET_3_SECRET_KEY',
  },

  // ── Group 4 ───────────────────────────────────────────
  {
    name:       'gmail_4',
    host:       'smtp.gmail.com',
    port:       587,
    dailyLimit: 2000,
    userEnv:    'GMAIL_4_USER',
    passEnv:    'GMAIL_4_PASS',
  },
  {
    name:       'brevo_4',
    host:       'smtp-relay.brevo.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'BREVO_4_USER',
    passEnv:    'BREVO_4_PASS',
  },
  {
    name:       'mailjet_4',
    host:       'in-v3.mailjet.com',
    port:       587,
    dailyLimit: 200,
    userEnv:    'MAILJET_4_API_KEY',
    passEnv:    'MAILJET_4_SECRET_KEY',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Permanent error detection helpers
// ─────────────────────────────────────────────────────────────────────────────

/** SMTP response codes that indicate a permanent auth / credentials failure. */
const PERMANENT_ERROR_CODES = new Set([535, 534, 530, 550, 554]);

/** Error message fragments that indicate a permanent failure. */
const PERMANENT_ERROR_KEYWORDS = [
  'authentication',
  'credentials',
  'not authorized',
  'rejected',
];

/**
 * Returns true if the error should be treated as a permanent provider failure
 * (mark it exhausted and move on — do NOT retry on this provider).
 */
function isPermanentError(err) {
  if (err.responseCode && PERMANENT_ERROR_CODES.has(err.responseCode)) return true;
  if (err.code        && PERMANENT_ERROR_CODES.has(Number(err.code)))  return true;

  const msg = (err.message || '').toLowerCase();
  return PERMANENT_ERROR_KEYWORDS.some(kw => msg.includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// SmtpRotator class
// ─────────────────────────────────────────────────────────────────────────────

export class SmtpRotator {
  /**
   * @param {import('node:sqlite').DatabaseSync} db — The shared DatabaseSync instance.
   */
  constructor(db) {
    this._db = db;

    // Ensure the smtp_usage table exists
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS smtp_usage (
        provider_name TEXT PRIMARY KEY,
        sent_today    INTEGER NOT NULL DEFAULT 0,
        daily_limit   INTEGER NOT NULL DEFAULT 0,
        reset_date    TEXT    NOT NULL DEFAULT (date('now'))
      )
    `);

    // Build active providers: skip any whose env vars are missing/empty
    this._providers = [];
    for (const cfg of PROVIDER_CONFIGS) {
      const user = process.env[cfg.userEnv];
      const pass = process.env[cfg.passEnv];
      if (!user || !pass) {
        // Silently skip — credentials not configured
        continue;
      }

      const transporter = nodemailer.createTransport({
        host:   cfg.host,
        port:   cfg.port,
        secure: false,          // STARTTLS on port 587
        auth:   { user, pass },
        pool:            true,  // connection pooling
        maxConnections:  3,
        maxMessages:     Infinity,
      });

      this._providers.push({
        name:        cfg.name,
        dailyLimit:  cfg.dailyLimit,
        transporter,
        exhausted:   false,     // runtime flag (permanent error this session)
      });

      // Upsert row into smtp_usage so the table has a record for this provider
      this._db.prepare(`
        INSERT INTO smtp_usage (provider_name, sent_today, daily_limit, reset_date)
        VALUES (?, 0, ?, date('now'))
        ON CONFLICT(provider_name) DO UPDATE
          SET daily_limit = excluded.daily_limit
      `).run(cfg.name, cfg.dailyLimit);
    }

    if (this._providers.length === 0) {
      console.warn('[SmtpRotator] ⚠️  No SMTP providers are configured. All env vars are missing.');
    } else {
      console.log(`[SmtpRotator] ✅ Loaded ${this._providers.length} active SMTP provider(s).`);
    }

    // Schedule a midnight reset — runs every day at 00:00
    this._scheduleMidnightReset();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Send one email, rotating through providers by quota availability.
   *
   * @param {object} mailOptions — Nodemailer mail options (from, to, subject, html, …)
   * @returns {Promise<{ messageId: string, provider: string }>}
   */
  async sendMail(mailOptions) {
    // Reset any providers whose date has rolled over (safety net between midnight timer fires)
    this._maybeResetCounters();

    for (const provider of this._providers) {
      // Skip if permanently exhausted (auth error this session)
      if (provider.exhausted) continue;

      // Check daily quota from SQLite
      const row = this._getUsageRow(provider.name);
      if (!row) continue;

      // If today's date doesn't match reset_date, reset first
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      if (row.reset_date !== today) {
        this._resetProvider(provider.name, provider.dailyLimit);
        const freshRow = this._getUsageRow(provider.name);
        if (!freshRow || freshRow.sent_today >= freshRow.daily_limit) continue;
      } else {
        if (row.sent_today >= row.daily_limit) continue; // quota used up
      }

      // Attempt to send
      try {
        const info = await provider.transporter.sendMail(mailOptions);

        // Increment counter
        this._db.prepare(`
          UPDATE smtp_usage SET sent_today = sent_today + 1 WHERE provider_name = ?
        `).run(provider.name);

        return { messageId: info.messageId, provider: provider.name };

      } catch (err) {
        if (isPermanentError(err)) {
          console.error(`[SmtpRotator] ❌ Permanent error on ${provider.name}: ${err.message}. Marking exhausted.`);
          provider.exhausted = true;
          this._db.prepare(`
            UPDATE smtp_usage SET sent_today = daily_limit WHERE provider_name = ?
          `).run(provider.name);
          continue;
        }
        // Transient error — re-throw so caller can retry
        throw err;
      }
    }

    throw new Error('[SmtpRotator] All SMTP providers exhausted for today. No quota remaining.');
  }

  /**
   * Returns stats for all active providers.
   * @returns {Array<{ provider, sent, limit, remaining, exhausted, pct }>}
   */
  getStats() {
    this._maybeResetCounters();
    const stats = [];
    for (const provider of this._providers) {
      const row = this._getUsageRow(provider.name);
      const sent      = row?.sent_today   ?? 0;
      const limit     = row?.daily_limit  ?? provider.dailyLimit;
      const remaining = Math.max(0, limit - sent);
      const pct       = limit > 0 ? Math.round((sent / limit) * 100) : 0;
      stats.push({
        provider:  provider.name,
        sent,
        limit,
        remaining,
        exhausted: provider.exhausted || sent >= limit,
        pct,
      });
    }
    return stats;
  }

  /** Sum of all active providers' daily limits. */
  getTotalDailyCapacity() {
    return this._providers.reduce((sum, p) => sum + p.dailyLimit, 0);
  }

  /** Total emails sent today across all active providers. */
  getTotalSentToday() {
    return this.getStats().reduce((sum, s) => sum + s.sent, 0);
  }

  /** Total remaining capacity across all active providers today. */
  getTotalRemainingToday() {
    return this.getStats().reduce((sum, s) => sum + s.remaining, 0);
  }

  /** Print a formatted table of provider usage to console. */
  printStats() {
    const stats = this.getStats();
    if (stats.length === 0) {
      console.log('[SmtpRotator] No active providers configured.');
      return;
    }

    const totalCapacity  = this.getTotalDailyCapacity();
    const totalSent      = this.getTotalSentToday();
    const totalRemaining = this.getTotalRemainingToday();

    console.log('\n┌──────────────────────────────────────────────────────────────┐');
    console.log('│              SMTP Provider Pool — Daily Usage                │');
    console.log('├─────────────┬──────────┬──────────┬──────────┬──────────────┤');
    console.log('│ Provider    │    Sent  │   Limit  │ Remain.  │ Status       │');
    console.log('├─────────────┼──────────┼──────────┼──────────┼──────────────┤');
    for (const s of stats) {
      const prov     = s.provider.padEnd(11);
      const sent     = String(s.sent).padStart(7);
      const limit    = String(s.limit).padStart(7);
      const remain   = String(s.remaining).padStart(7);
      const statusIcon = s.exhausted ? '🔴 Exhausted'
                       : s.pct >= 80  ? '🟡 Near limit'
                       :               '🟢 Available ';
      console.log(`│ ${prov} │ ${sent}  │ ${limit}  │ ${remain}  │ ${statusIcon} │`);
    }
    console.log('├─────────────┼──────────┼──────────┼──────────┼──────────────┤');
    console.log(`│ TOTAL       │ ${String(totalSent).padStart(7)}  │ ${String(totalCapacity).padStart(7)}  │ ${String(totalRemaining).padStart(7)}  │              │`);
    console.log('└─────────────┴──────────┴──────────┴──────────┴──────────────┘\n');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  _getUsageRow(providerName) {
    return this._db.prepare(
      `SELECT provider_name, sent_today, daily_limit, reset_date FROM smtp_usage WHERE provider_name = ?`
    ).get(providerName);
  }

  _resetProvider(providerName, dailyLimit) {
    this._db.prepare(`
      UPDATE smtp_usage
      SET sent_today = 0, reset_date = date('now')
      WHERE provider_name = ?
    `).run(providerName);

    // Un-exhaust in-memory flag (quota-based exhaustion only — auth errors re-exhaust on next send)
    const provider = this._providers.find(p => p.name === providerName);
    if (provider) provider.exhausted = false;
  }

  /** Reset all providers whose reset_date is not today. */
  _maybeResetCounters() {
    const today = new Date().toISOString().slice(0, 10);
    for (const provider of this._providers) {
      const row = this._getUsageRow(provider.name);
      if (row && row.reset_date !== today) {
        this._resetProvider(provider.name, provider.dailyLimit);
      }
    }
  }

  /**
   * Schedule a timer that fires exactly at the next midnight and then
   * resets all counters. Re-schedules itself for the day after.
   */
  _scheduleMidnightReset() {
    const now      = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 5, 0);         // 00:00:05 to clear any clock drift
    const msUntilMidnight = tomorrow - now;

    this._midnightTimer = setTimeout(() => {
      console.log('[SmtpRotator] 🔄 Midnight reached — resetting all provider daily counters.');
      this._resetAllCounters();
      this._scheduleMidnightReset();
    }, msUntilMidnight);

    if (this._midnightTimer.unref) this._midnightTimer.unref();
  }

  _resetAllCounters() {
    for (const provider of this._providers) {
      this._resetProvider(provider.name, provider.dailyLimit);
    }
    console.log('[SmtpRotator] ✅ All provider counters reset for the new day.');
    this.printStats();
  }
}

export default SmtpRotator;

// =============================================================================
// ParallelSmtpRotator — 4 concurrent group workers (named export)
// =============================================================================

/**
 * Provider group definitions — each group gets its own SmtpRotator instance.
 * Order within each group is the rotation priority (gmail → brevo → mailjet).
 */
const GROUP_CONFIGS = [
  ['gmail_1', 'brevo_1', 'mailjet_1'],
  ['gmail_2', 'brevo_2', 'mailjet_2'],
  ['gmail_3', 'brevo_3', 'mailjet_3'],
  ['gmail_4', 'brevo_4', 'mailjet_4'],
];

/**
 * Per-provider inter-message delay in ms.
 * Keeps individual account send rates within safe limits.
 */
const PROVIDER_DELAY_MS = {
  gmail:   800,   // Google flags > ~1.2 sends/sec/account
  brevo:   400,   // Brevo free tier ~2–3/sec
  mailjet: 500,   // Mailjet free burst ~2/sec
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Infer delay from provider name string.
 * Falls back to 500 ms for unknown types.
 */
function delayForProvider(providerName) {
  const n = (providerName || '').toLowerCase();
  if (n.includes('gmail'))   return PROVIDER_DELAY_MS.gmail;
  if (n.includes('brevo'))   return PROVIDER_DELAY_MS.brevo;
  if (n.includes('mailjet')) return PROVIDER_DELAY_MS.mailjet;
  return 500;
}

export class ParallelSmtpRotator {
  /**
   * @param {import('node:sqlite').DatabaseSync} db — Shared DatabaseSync instance (WAL mode).
   */
  constructor(db) {
    this._db = db;

    // Instantiate one SmtpRotator per group, each receiving only its 3 providers.
    // We temporarily override PROVIDER_CONFIGS by filtering at construction time.
    this._groups = GROUP_CONFIGS.map((providerNames, idx) => {
      const rotator = new SmtpRotator(db);
      // Filter the rotator's _providers list to only include this group's providers
      rotator._providers = rotator._providers.filter(p =>
        providerNames.includes(p.name)
      );
      return { groupNum: idx + 1, rotator, providerNames };
    });

    console.log('[ParallelSmtpRotator] ✅ Initialized 4 group rotators.');
    this._groups.forEach(g =>
      console.log(`  Group ${g.groupNum}: [${g.rotator._providers.map(p => p.name).join(', ')}]`)
    );
  }

  /**
   * Split recipients into 4 equal chunks and send all groups concurrently.
   *
   * @param {Array<{id,name,email}>} recipients
   * @param {(recipient) => object} mailFactory   — Returns nodemailer mail options
   * @param {(progress) => void}    onProgress    — Called after every send attempt
   * @param {AbortSignal}           signal        — Abort signal to halt execution
   * @returns {Promise<{sent:number, failed:number, results:Array}>}
   */
  async sendBatch(recipients, mailFactory, onProgress = () => {}, signal = null) {
    const chunkSize = Math.ceil(recipients.length / 4);
    const chunks    = [];
    for (let i = 0; i < 4; i++) {
      chunks.push(recipients.slice(i * chunkSize, (i + 1) * chunkSize));
    }

    const groupResults = await Promise.allSettled(
      this._groups.map((g, i) =>
        this._sendChunk(g.groupNum, g.rotator, chunks[i] || [], mailFactory, onProgress, signal)
      )
    );

    let sent    = 0;
    let failed  = 0;
    const results = [];

    for (const outcome of groupResults) {
      if (outcome.status === 'fulfilled') {
        sent   += outcome.value.sent;
        failed += outcome.value.failed;
        results.push(...outcome.value.results);
      } else {
        // Entire group worker crashed — log but don't propagate
        console.error('[ParallelSmtpRotator] Group worker rejected:', outcome.reason?.message);
        failed++;
      }
    }

    return { sent, failed, results };
  }

  /**
   * Send a chunk of recipients sequentially through one group's rotator.
   * Rate-limited by per-provider delay. Never throws — records failures inline.
   */
  async _sendChunk(groupNum, rotator, chunk, mailFactory, onProgress, signal) {
    let sent   = 0;
    let failed = 0;
    const results = [];

    for (const recipient of chunk) {
      // ── ABORT CHECK — must be FIRST line inside the loop ──────────────
      if (signal && signal.aborted) {
        console.log(`[Group ${groupNum}] Abort signal received — stopping chunk.`);
        break;  // exit loop immediately, do not send any more emails
      }
      // ──────────────────────────────────────────────────────────────────

      if (rotator.getTotalRemainingToday() <= 0) {
        console.log(`[Group ${groupNum}] All providers exhausted — stopping chunk early.`);
        results.push({ group: groupNum, provider: null, recipient: recipient.email, success: false, error: 'Group exhausted' });
        failed++;
        continue;
      }

      let lastProvider = null;
      try {
        const mailOpts = mailFactory(recipient);
        const { messageId, provider } = await rotator.sendMail(mailOpts);
        lastProvider = provider;

        sent++;
        results.push({ group: groupNum, provider, recipient: recipient.email, success: true, messageId, error: null });
        onProgress({ group: groupNum, provider, recipient: recipient.email, success: true, messageId, error: null });

        // Per-provider rate-limit delay
        if (!signal?.aborted) {
          await sleep(delayForProvider(provider));
        }

      } catch (err) {
        failed++;
        results.push({ group: groupNum, provider: lastProvider, recipient: recipient.email, success: false, messageId: null, error: err.message });
        onProgress({ group: groupNum, provider: lastProvider, recipient: recipient.email, success: false, messageId: null, error: err.message });
        console.warn(`[Group ${groupNum}] ❌ Failed for ${recipient.email}: ${err.message}`);
        // Brief pause after failure before continuing
        if (!signal?.aborted) {
          await sleep(200);
        }
      }
    }

    return { sent, failed, results };
  }

  /** Delegate stats to all group rotators, merged. */
  getStats() {
    const all = [];
    for (const g of this._groups) {
      all.push(...g.rotator.getStats());
    }
    return all;
  }

  getTotalDailyCapacity() {
    return this._groups.reduce((sum, g) => sum + g.rotator.getTotalDailyCapacity(), 0);
  }

  getTotalSentToday() {
    return this._groups.reduce((sum, g) => sum + g.rotator.getTotalSentToday(), 0);
  }

  getTotalRemainingToday() {
    return this._groups.reduce((sum, g) => sum + g.rotator.getTotalRemainingToday(), 0);
  }

  printStats() {
    this._groups.forEach(g => g.rotator.printStats());
  }
}