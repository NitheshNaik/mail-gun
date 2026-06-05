// abortRegistry.js
// Maps jobId → AbortController so any route handler can abort a running job.

import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const registry = new Map(); // jobId (string) → AbortController

// Create Redis connections for Pub/Sub
const pubClient = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const subClient = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// Subscribe to abort channel
subClient.subscribe('job-aborts').catch(err => {
  console.error('[AbortRegistry] Failed to subscribe to Redis abort channel:', err);
});

subClient.on('message', (channel, message) => {
  if (channel === 'job-aborts') {
    try {
      const { jobId } = JSON.parse(message);
      console.log(`[DEBUG] [AbortRegistry] Received abort signal via Redis for job: ${jobId}`);
      const controller = registry.get(String(jobId));
      if (controller) {
        controller.abort();
        registry.delete(String(jobId));
        console.log(`[DEBUG] [AbortRegistry] Successfully aborted job: ${jobId}`);
      }
    } catch (err) {
      console.error('[AbortRegistry] Error processing abort message:', err);
    }
  }
});

export function registerJob(jobId) {
  const controller = new AbortController();
  registry.set(String(jobId), controller);
  console.log(`[DEBUG] [AbortRegistry] Registered job: ${jobId}`);
  return controller;
}

export function abortJob(jobId) {
  console.log(`[DEBUG] [AbortRegistry] Calling abortJob for: ${jobId}`);
  const controller = registry.get(String(jobId));
  let abortedLocally = false;
  if (controller) {
    controller.abort();
    registry.delete(String(jobId));
    abortedLocally = true;
  }
  // Publish abort to Redis for other processes (worker)
  pubClient.publish('job-aborts', JSON.stringify({ jobId })).catch(err => {
    console.error('[AbortRegistry] Failed to publish abort to Redis:', err);
  });
  return abortedLocally;
}

export function isAborted(jobId) {
  const controller = registry.get(String(jobId));
  return controller ? controller.signal.aborted : true; // treat unknown as aborted
}

export function getSignal(jobId) {
  return registry.get(String(jobId))?.signal ?? null;
}

export function cleanupJob(jobId) {
  registry.delete(String(jobId));
  console.log(`[DEBUG] [AbortRegistry] Cleaned up job: ${jobId}`);
}
