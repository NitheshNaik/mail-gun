/**
 * smtpRotator.js — Multi-Provider SMTP Rotation Manager
 *
 * Manages a pool of SMTP providers, rotating sends across them to
 * stack their free daily limits. Tracks usage in SQLite, auto-resets
 * counters at midnight, and falls back to the next provider on
 * permanent auth errors.
 *
 * IMPORTANT: Uses ES module syntax (import/export) — consistent with
 * the rest of the backend (package.json "type": "module").
 */

import nodemailer from 'nodemailer';

// ─────────────────────────────────────────────────────────────────────────────
// Provider definitions (priority order — first provider used first)
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_CONFIGS = [
  {
    name:       'brevo',
    host:       'smtp-relay.brevo.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'BREVO_USER',
    passEnv:    'BREVO_PASS',
  },
  {
    name:       'mailjet',
    host:       'in-v3.mailjet.com',
    port:       587,
    dailyLimit: 200,
    userEnv:    'MAILJET_API_KEY',
    passEnv:    'MAILJET_SECRET_KEY',
  },
  {
    name:       'sendpulse',
    host:       'smtp-pulse.com',
    port:       587,
    dailyLimit: 400,
    userEnv:    'SENDPULSE_USER',
    passEnv:    'SENDPULSE_PASS',
  },
  {
    name:       'sender_net',
    host:       'smtp.sender.net',
    port:       587,
    dailyLimit: 500,
    userEnv:    'SENDER_NET_USER',
    passEnv:    'SENDER_NET_PASS',
  },
  {
    name:       'gmail_1',
    host:       'smtp.gmail.com',
    port:       587,
    dailyLimit: 500,
    userEnv:    'GMAIL_1_USER',
    passEnv:    'GMAIL_1_PASS',
  },
  {
    name:       'gmail_2',
    host:       'smtp.gmail.com',
    port:       587,
    dailyLimit: 500,
    userEnv:    'GMAIL_2_USER',
    passEnv:    'GMAIL_2_PASS',
  },
  {
    name:       'outlook_1',
    host:       'smtp-mail.outlook.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'OUTLOOK_1_USER',
    passEnv:    'OUTLOOK_1_PASS',
  },
  {
    name:       'outlook_2',
    host:       'smtp-mail.outlook.com',
    port:       587,
    dailyLimit: 300,
    userEnv:    'OUTLOOK_2_USER',
    passEnv:    'OUTLOOK_2_PASS',
  },
  {
    name:       'mailgun',
    host:       'smtp.mailgun.org',
    port:       587,
    dailyLimit: 1000,
    userEnv:    'MAILGUN_USER',
    passEnv:    'MAILGUN_PASS',
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
  // Check numeric SMTP response code
  if (err.responseCode && PERMANENT_ERROR_CODES.has(err.responseCode)) return true;
  if (err.code        && PERMANENT_ERROR_CODES.has(Number(err.code)))  return true;

  // Check error message text
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
        // Re-fetch after reset
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
          // Mark as fully used in DB so it also appears exhausted to the API
          this._db.prepare(`
            UPDATE smtp_usage SET sent_today = daily_limit WHERE provider_name = ?
          `).run(provider.name);
          // Try next provider
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

    // Also un-exhaust in-memory flag if it was set due to quota (not auth error)
    const provider = this._providers.find(p => p.name === providerName);
    if (provider && !isPermanentError({ message: '' })) {
      // Only un-exhaust quota-based exhaustion, not auth-error exhaustion
      // Check: if the row was exhausted due to quota (not auth), reset the flag
      // We track auth-exhausted separately via the provider.exhausted flag which
      // is only set on a permanent auth error — daily quota reset should un-exhaust it
      // if the exhaustion was quota-based (i.e., not an auth error)
      // For simplicity: always reset — if auth errors recur they'll re-exhaust
      provider.exhausted = false;
    }
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
    const now        = new Date();
    const tomorrow   = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 5, 0);         // 00:00:05 to clear any clock drift
    const msUntilMidnight = tomorrow - now;

    this._midnightTimer = setTimeout(() => {
      console.log('[SmtpRotator] 🔄 Midnight reached — resetting all provider daily counters.');
      this._resetAllCounters();
      // Re-schedule for the following midnight
      this._scheduleMidnightReset();
    }, msUntilMidnight);

    // Allow Node.js to exit even if this timer is pending
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
