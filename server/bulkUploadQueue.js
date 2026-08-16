import { Worker } from 'node:worker_threads';
import { claimNextBulkUploadJob, updateBulkUploadJob } from './db.js';

const maximumWorkers = Math.max(1, Number(process.env.BULK_UPLOAD_WORKERS || 1));
const pollIntervalMs = Math.max(500, Number(process.env.BULK_UPLOAD_QUEUE_POLL_MS || 2000));
const staleAfterMs = Math.max(60000, Number(process.env.BULK_UPLOAD_STALE_AFTER_MS || 15 * 60 * 1000));
let activeWorkers = 0;
let drainPromise = null;
let pollTimer = null;
let shuttingDown = false;
const workers = new Map();

async function drainQueue() {
  while (!shuttingDown && activeWorkers < maximumWorkers) {
    const job = await claimNextBulkUploadJob({ staleAfterMs });
    if (!job) break;
    const jobId = job.id;
    activeWorkers += 1;
    const worker = new Worker(new URL('./bulkUploadWorker.js', import.meta.url), {
      workerData: { jobId }
    });
    workers.set(jobId, worker);
    let receivedResult = false;
    worker.on('message', () => {
      receivedResult = true;
    });
    worker.on('error', (error) => {
      console.error(`Bulk upload worker ${jobId} failed:`, error);
    });
    worker.on('exit', async (code) => {
      activeWorkers -= 1;
      workers.delete(jobId);
      if (!shuttingDown && (code !== 0 || !receivedResult)) {
        await updateBulkUploadJob(jobId, {
          status: 'FAILED',
          completed_at: new Date().toISOString(),
          message: `Background worker exited unexpectedly${code ? ` with code ${code}` : ''}.`
        }).catch(() => {});
      }
      scheduleQueueDrain();
    });
  }
}

function scheduleQueueDrain() {
  if (shuttingDown) return Promise.resolve();
  if (drainPromise) return drainPromise;
  drainPromise = drainQueue()
    .catch((error) => {
      console.error(`Bulk upload queue polling failed: ${error.message}`);
    })
    .finally(() => {
      drainPromise = null;
    });
  return drainPromise;
}

export function enqueueBulkUpload(jobId) {
  if (!jobId) return;
  scheduleQueueDrain();
}

export async function resumeBulkUploadQueue() {
  shuttingDown = false;
  if (!pollTimer) {
    pollTimer = setInterval(scheduleQueueDrain, pollIntervalMs);
    pollTimer.unref?.();
  }
  await scheduleQueueDrain();
}

export async function stopBulkUploadQueue() {
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  const activeEntries = [...workers.entries()];
  await Promise.all(activeEntries.map(([, worker]) => worker.terminate().catch(() => {})));
  await Promise.all(activeEntries.map(([jobId]) => updateBulkUploadJob(jobId, {
    status: 'QUEUED',
    message: 'Upload paused during application shutdown and will resume automatically.'
  }).catch(() => {})));
}
