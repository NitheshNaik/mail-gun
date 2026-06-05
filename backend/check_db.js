import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = './email_jobs.db';

async function main() {
  console.log('Loading database from:', DB_PATH);
  if (!fs.existsSync(DB_PATH)) {
    console.log('DB file does not exist');
    return;
  }
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(fileBuffer);
  
  // Get all jobs
  const jobsStmt = db.prepare('SELECT * FROM jobs');
  const jobs = [];
  while (jobsStmt.step()) {
    jobs.push(jobsStmt.getAsObject());
  }
  jobsStmt.free();
  console.log('Jobs found:', jobs);

  // Get task status summary
  const tasksStmt = db.prepare('SELECT status, count(*) as count FROM email_tasks GROUP BY status');
  const taskCounts = [];
  while (tasksStmt.step()) {
    taskCounts.push(tasksStmt.getAsObject());
  }
  tasksStmt.free();
  console.log('Task status counts:', taskCounts);
}

main().catch(console.error);
