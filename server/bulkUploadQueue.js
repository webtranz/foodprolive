import { Worker } from 'node:worker_threads';
import { listBulkUploadJobs, updateBulkUploadJob } from './db.js';

const maximumWorkers = Math.max(1, Number(process.env.BULK_UPLOAD_WORKERS || 1));
const pendingJobs = [];
const queuedIds = new Set();
let activeWorkers = 0;

function launchNext() {
  while (activeWorkers < maximumWorkers && pendingJobs.length) {
    const jobId = pendingJobs.shift();
    queuedIds.delete(jobId);
    activeWorkers += 1;
    const worker = new Worker(new URL('./bulkUploadWorker.js', import.meta.url), {
      workerData: { jobId }
    });
    let receivedResult = false;
    worker.on('message', () => {
      receivedResult = true;
    });
    worker.on('error', (error) => {
      console.error(`Bulk upload worker ${jobId} failed:`, error);
    });
    worker.on('exit', async (code) => {
      activeWorkers -= 1;
      if (code !== 0 || !receivedResult) {
        await updateBulkUploadJob(jobId, {
          status: 'FAILED',
          completed_at: new Date().toISOString(),
          message: `Background worker exited unexpectedly${code ? ` with code ${code}` : ''}.`
        }).catch(() => {});
      }
      launchNext();
    });
  }
}

export function enqueueBulkUpload(jobId) {
  if (!jobId || queuedIds.has(jobId)) return;
  queuedIds.add(jobId);
  pendingJobs.push(jobId);
  launchNext();
}

export async function resumeBulkUploadQueue() {
  const recoverable = await listBulkUploadJobs({
    limit: 100,
    statuses: ['QUEUED', 'PROCESSING']
  });
  for (const job of recoverable) {
    if (job.status === 'PROCESSING') {
      await updateBulkUploadJob(job.id, {
        status: 'QUEUED',
        message: 'Upload resumed after an application restart.'
      });
    }
    enqueueBulkUpload(job.id);
  }
}
