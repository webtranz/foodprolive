import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SOURCE_NAME, SOURCE_NAME_OPTIONS, isValidSourceName, normalizeSourceName } from '../shared/sourceNames.js';
import { validateEntityPayload } from '../server/entities.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

assert.deepEqual(SOURCE_NAME_OPTIONS, ['D365', 'Cash']);
assert.equal(DEFAULT_SOURCE_NAME, 'D365');
assert.equal(normalizeSourceName('d365'), 'D365');
assert.equal(normalizeSourceName(' CASH '), 'Cash');
assert.equal(normalizeSourceName('bad', ''), '');
assert.equal(isValidSourceName('Cash'), true);
assert.equal(isValidSourceName('bad'), false);

assert.equal(validateEntityPayload('Ingredient', { name: 'Rice' }).source_name, 'D365');
assert.equal(validateEntityPayload('Ingredient', { name: 'Rice', source_name: 'cash' }).source_name, 'Cash');
assert.throws(
  () => validateEntityPayload('Ingredient', { name: 'Rice', source_name: 'manual' }),
  /Invalid enum value|Expected 'D365' \| 'Cash'/
);
assert.equal(validateEntityPayload('Inventory', { source_name: 'D365' }).source_name, 'D365');
assert.throws(
  () => validateEntityPayload('Inventory', { source_name: 'supplier' }),
  /Invalid enum value|Expected 'D365' \| 'Cash'/
);

const bulkUploadCenter = read('src/pages/BulkUploadCenter.jsx');
assert.match(bulkUploadCenter, /requiresSourceName/);
assert.match(bulkUploadCenter, /Select Source Name: D365 or Cash before uploading/);
assert.match(bulkUploadCenter, /source_name: requiresSourceName \? sourceName : ''/);

const bulkUploadWorker = read('server/bulkUploadWorker.js');
assert.match(bulkUploadWorker, /source_name: resolveBulkUploadSourceName\(job, staged\.payload\)/);
assert.match(bulkUploadWorker, /const sourceName = resolveBulkUploadSourceName\(job, staged\.payload\)/);
assert.match(bulkUploadWorker, /job\.entity_name === 'Ingredient'/);

console.log('sourceName tests passed');
