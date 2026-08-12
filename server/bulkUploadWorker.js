import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import readline from 'node:readline';
import { once } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import {
  pool,
  withTransaction,
  createDocument,
  listDocuments,
  getBulkUploadJob,
  updateBulkUploadJob,
  clearDocumentsForBulk
} from './db.js';
import { authorizeEntityAction } from './entities.js';
import { createSiteGraph, getLocationScope, assertPayloadLocationAccess } from './locationScope.js';
import {
  getUtilityModule,
  mapCsvRow,
  parseCsvLine,
  validateCsvHeaders
} from './utilities.js';
import { auditAction } from './audit.js';
import { prepareEntityPayload } from './entityPreparation.js';

const MAX_RECORDED_ERRORS = 100;

function isDuplicateError(error) {
  return error?.status === 409 || error?.code === '23505' || /already exists/i.test(error?.message || '');
}

async function readCsv(filePath, onHeaders, onRow) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  let rowNumber = 0;
  for await (const line of lines) {
    if (!headers) {
      if (!line.trim()) continue;
      headers = parseCsvLine(line);
      await onHeaders(headers);
      continue;
    }
    if (!line.trim()) continue;
    rowNumber += 1;
    await onRow(headers, parseCsvLine(line), rowNumber);
  }
  return rowNumber;
}

async function validateToJsonLines(job, definition, stagedPath) {
  const output = fs.createWriteStream(stagedPath, { encoding: 'utf8' });
  const errors = [];
  let validRows = 0;
  let totalRows = 0;
  try {
    await readCsv(
      job.file_path,
      async (headers) => {
        const headerErrors = validateCsvHeaders(job.module_key, headers);
        if (headerErrors.length) throw new Error(headerErrors.join(' '));
      },
      async (headers, values, rowNumber) => {
        totalRows += 1;
        try {
          const payload = mapCsvRow(job.module_key, headers, values);
          if (job.site_id && definition.headers.includes('site_id') && !payload.site_id) {
            payload.site_id = job.site_id;
            payload.site_name = payload.site_name || job.site_name || undefined;
          }
          if (!output.write(`${JSON.stringify({ rowNumber, payload })}\n`)) {
            await once(output, 'drain');
          }
          validRows += 1;
        } catch (error) {
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({ row: rowNumber, message: error.message || 'Invalid row' });
          }
        }
        if (totalRows % job.batch_size === 0) {
          await updateBulkUploadJob(job.id, {
            total_rows: totalRows,
            failed_rows: totalRows - validRows,
            errors,
            message: `Validated ${totalRows} rows in background batches.`
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    );
  } finally {
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on('error', reject);
    });
  }
  return { errors, validRows, invalidRows: totalRows - validRows, totalRows, definition };
}

async function processBatch({ job, batch, user, context, counters, errors, executor = null, failFast = false }) {
  const applyBatch = async (client) => {
    for (const staged of batch) {
      await client.query('SAVEPOINT bulk_upload_row');
      try {
        authorizeEntityAction(user, job.entity_name, 'create', staged.payload);
        const preparedPayload = await prepareEntityPayload(
          user,
          job.entity_name,
          staged.payload,
          null,
          context
        );
        assertPayloadLocationAccess(user, job.entity_name, preparedPayload, context.scope);
        const created = await createDocument(job.entity_name, preparedPayload, client);
        if (job.entity_name === 'Recipe' && Array.isArray(context.recipeCatalog)) {
          context.recipeCatalog.push(created);
        }
        if (job.entity_name === 'Site') {
          context.scope.sites = [...(context.scope.sites || []), created];
          context.scope.graph = createSiteGraph(context.scope.sites);
        }
        counters.applied += 1;
        await client.query('RELEASE SAVEPOINT bulk_upload_row');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT bulk_upload_row');
        await client.query('RELEASE SAVEPOINT bulk_upload_row');
        if (isDuplicateError(error) && job.import_mode === 'keep_existing') {
          counters.skipped += 1;
        } else {
          counters.failed += 1;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({ row: staged.rowNumber, message: error.message || 'Import failed' });
          }
          if (failFast) throw error;
        }
      }
      counters.processed += 1;
    }
  };
  return executor ? applyBatch(executor) : withTransaction(applyBatch);
}

async function applyStagedRows(job, stagedPath, user, context, validationErrors, invalidRows, options = {}) {
  const input = fs.createReadStream(stagedPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const counters = { processed: 0, applied: 0, skipped: 0, failed: invalidRows };
  const errors = [...validationErrors];
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    await processBatch({
      job,
      batch,
      user,
      context,
      counters,
      errors,
      executor: options.executor || null,
      failFast: Boolean(options.failFast)
    });
    batch = [];
    await updateBulkUploadJob(job.id, {
      processed_rows: counters.processed + invalidRows,
      applied_rows: counters.applied,
      skipped_rows: counters.skipped,
      failed_rows: counters.failed,
      errors,
      message: `Processed ${counters.processed + invalidRows} of ${job.total_rows} rows in batches of ${job.batch_size}.`
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    batch.push(JSON.parse(line));
    const effectiveBatchSize = job.entity_name === 'Site' ? 1 : job.batch_size;
    if (batch.length >= effectiveBatchSize) await flush();
  }
  await flush();
  return { counters, errors };
}

async function run() {
  const job = await getBulkUploadJob(workerData.jobId);
  if (!job) throw new Error('Bulk upload job was not found.');
  const definition = getUtilityModule(job.module_key);
  if (!definition) throw new Error('Bulk upload module is not supported.');
  const user = job.actor_snapshot || null;
  const scope = await getLocationScope(user);
  const context = {
    scope,
    recipeCatalog: job.entity_name === 'Recipe'
      ? await listDocuments('Recipe', { limit: 5000 })
      : null
  };
  const scopedSiteIds = scope.unrestricted ? null : [...scope.accessibleSiteIds];
  const destructiveSiteIds = job.site_id ? [String(job.site_id)] : scopedSiteIds;
  if (
    scopedSiteIds !== null
    && ['replace_existing', 'delete_existing'].includes(job.import_mode)
    && !definition.headers.includes('site_id')
  ) {
    throw new Error('Replace and delete modes for global modules require administrator access.');
  }
  const startedAt = new Date().toISOString();
  await updateBulkUploadJob(job.id, {
    status: 'PROCESSING',
    started_at: startedAt,
    message: 'Preparing background batch upload.'
  });

  if (job.import_mode === 'delete_existing') {
    authorizeEntityAction(user, job.entity_name, 'delete');
    const deleted = await withTransaction((client) => clearDocumentsForBulk(job.entity_name, destructiveSiteIds, client));
    const completedAt = new Date().toISOString();
    await updateBulkUploadJob(job.id, {
      status: 'COMPLETED',
      applied_rows: deleted,
      completed_at: completedAt,
      message: `Deleted ${deleted} existing ${definition.label} records.`
    });
    await auditAction({
      user,
      action: 'BULK_DELETE_COMPLETED',
      entity: job.entity_name,
      entityId: job.id,
      siteId: job.site_id,
      siteName: job.site_name,
      details: { module: job.module_key, deleted_rows: deleted }
    });
    return;
  }

  const stagedPath = `${job.file_path}.validated.jsonl`;
  const validation = await validateToJsonLines(job, definition, stagedPath);
  await updateBulkUploadJob(job.id, {
    total_rows: validation.totalRows,
    failed_rows: validation.invalidRows,
    errors: validation.errors,
    message: `Validation complete. ${validation.validRows} valid rows are ready.`
  });
  if (validation.validRows === 0) {
    throw new Error(validation.errors[0]?.message || 'The upload does not contain any valid data rows.');
  }
  if (job.import_mode === 'replace_existing' && validation.errors.length) {
    throw new Error('Replace mode was cancelled because one or more rows failed validation. Existing data was not changed.');
  }
  if (job.import_mode === 'replace_existing') {
    authorizeEntityAction(user, job.entity_name, 'delete');
    if (job.entity_name === 'Recipe') context.recipeCatalog = [];
    if (job.entity_name === 'Site') {
      context.scope.sites = [];
      context.scope.graph = createSiteGraph([]);
    }
  }

  const refreshedJob = await getBulkUploadJob(job.id);
  const applyRows = (options = {}) => applyStagedRows(
    refreshedJob,
    stagedPath,
    user,
    context,
    validation.errors,
    validation.invalidRows,
    options
  );
  const { counters, errors } = job.import_mode === 'replace_existing'
    ? await withTransaction(async (client) => {
      await clearDocumentsForBulk(job.entity_name, destructiveSiteIds, client);
      return applyRows({ executor: client, failFast: true });
    })
    : await applyRows();
  const status = counters.applied > 0 || counters.skipped > 0 ? 'COMPLETED' : 'FAILED';
  const completedAt = new Date().toISOString();
  await updateBulkUploadJob(job.id, {
    status,
    processed_rows: validation.totalRows,
    applied_rows: counters.applied,
    skipped_rows: counters.skipped,
    failed_rows: counters.failed,
    errors,
    completed_at: completedAt,
    message: `${counters.applied} rows applied, ${counters.skipped} skipped, ${counters.failed} failed.`
  });
  await auditAction({
    user,
    action: `BULK_UPLOAD_${status}`,
    entity: job.entity_name,
    entityId: job.id,
    siteId: job.site_id,
    siteName: job.site_name,
    details: {
      module: job.module_key,
      file_name: job.file_name,
      import_mode: job.import_mode,
      total_rows: validation.totalRows,
      applied_rows: counters.applied,
      skipped_rows: counters.skipped,
      failed_rows: counters.failed
    }
  });
  await fsPromises.unlink(stagedPath).catch(() => {});
}

run()
  .then(() => parentPort?.postMessage({ ok: true }))
  .catch(async (error) => {
    const failedJob = await getBulkUploadJob(workerData.jobId).catch(() => null);
    const rolledBack = failedJob?.import_mode === 'replace_existing';
    const existingErrors = Array.isArray(failedJob?.errors) ? failedJob.errors : [];
    await updateBulkUploadJob(workerData.jobId, {
      status: 'FAILED',
      ...(rolledBack ? { applied_rows: 0, skipped_rows: 0 } : {}),
      errors: existingErrors.length < MAX_RECORDED_ERRORS
        ? [...existingErrors, { row: null, message: error.message || 'Bulk upload failed.' }]
        : existingErrors,
      completed_at: new Date().toISOString(),
      message: rolledBack
        ? `Replace upload was rolled back. Existing data was preserved. ${error.message || ''}`.trim()
        : (error.message || 'Bulk upload failed.')
    }).catch(() => {});
    parentPort?.postMessage({ ok: false, message: error.message || 'Bulk upload failed.' });
  })
  .finally(async () => {
    const job = await getBulkUploadJob(workerData.jobId).catch(() => null);
    if (job?.file_path) {
      await fsPromises.unlink(job.file_path).catch(() => {});
      await fsPromises.unlink(`${job.file_path}.validated.jsonl`).catch(() => {});
    }
    await pool.end().catch(() => {});
  });
