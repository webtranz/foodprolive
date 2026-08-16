import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const database = read('server/db.js');
const schema = read('server/sql/init.sql');
const queue = read('server/bulkUploadQueue.js');
const client = read('src/api/base44Client.js');
const compose = read('docker-compose.yml');
const deployment = read('deploy/kubernetes/foodpro.yaml');
const loadTest = read('load-tests/read-baseline.js');

assert.match(database, /buildEntityListQuery/);
assert.match(database, /DB_POOL_MAX/);
assert.match(database, /listDocumentsPage/);
assert.match(schema, /foodpro_entity_events/);
assert.match(schema, /idx_entity_records_production_site_date_status_ci/);
assert.match(database, /FOR UPDATE SKIP LOCKED/);
assert.doesNotMatch(queue, /pendingJobs/);
assert.match(queue, /claimNextBulkUploadJob/);
assert.match(client, /fetch\('\/api\/events'/);
assert.match(compose, /OBJECT_STORAGE_ENDPOINT/);
assert.match(deployment, /kind: HorizontalPodAutoscaler/);
assert.match(deployment, /replicas: 3/);
assert.match(loadTest, /TARGET_USERS \|\| 1000/);
assert.match(loadTest, /p\(95\)<500/);

console.log('Scalability architecture tests passed.');
