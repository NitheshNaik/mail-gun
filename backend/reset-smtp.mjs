/**
 * reset-smtp.mjs
 * Resets all SMTP provider counters in smtp_usage table.
 * Run with: node reset-smtp.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'email_jobs.db');

const db = new DatabaseSync(DB_PATH);

// Reset all providers
const result = db.prepare(`
  UPDATE smtp_usage 
  SET sent_today = 0, reset_date = date('now')
`).run();

console.log(`\n✓ Reset ${result.changes} SMTP provider(s).\n`);

// Show current state
const providers = db.prepare(`
  SELECT provider_name, sent_today, daily_limit, reset_date FROM smtp_usage
`).all();

if (providers.length === 0) {
  console.log('No providers found in smtp_usage table.');
} else {
  console.table(providers.map(p => ({
    provider:   p.provider_name,
    sent_today: p.sent_today,
    limit:      p.daily_limit,
    remaining:  p.daily_limit - p.sent_today,
    reset_date: p.reset_date,
    status:     p.sent_today >= p.daily_limit ? '🔴 Exhausted' : '🟢 Available',
  })));
}

db.close();
