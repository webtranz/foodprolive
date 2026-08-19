import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  applyLinkedProductionLocation,
  applyRequiredOperationalLocation
} from '../shared/productionQualityLocation.js';

const sites = [
  { id: 'site-a', name: 'Project A' },
  { id: 'site-b', name: 'Project B' }
];

const linked = applyLinkedProductionLocation(
  { batch_id: 'batch-1' },
  { id: 'production-1', site_id: 'site-a', site_name: 'Stale site label' },
  sites,
  'linked production plan'
);
assert.equal(linked.site_id, 'site-a');
assert.equal(linked.site_name, 'Project A');

assert.throws(
  () => applyLinkedProductionLocation(
    { site_id: 'site-b' },
    { site_id: 'site-a' },
    sites,
    'linked production plan'
  ),
  (error) => error.status === 409 && /does not match/.test(error.message)
);

assert.throws(
  () => applyLinkedProductionLocation({}, { id: 'legacy-batch' }, sites, 'linked production batch'),
  (error) => error.status === 400 && /not assigned to a site/.test(error.message)
);

const assigned = applyRequiredOperationalLocation({}, sites, 'site-b', 'production batch');
assert.equal(assigned.site_id, 'site-b');
assert.equal(assigned.site_name, 'Project B');

assert.throws(
  () => applyRequiredOperationalLocation({}, sites, '', 'quality-control inspection'),
  (error) => error.status === 400 && /site is required/.test(error.message)
);

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const preparation = read('server/entityPreparation.js');
const batchPage = read('src/pages/BatchTracking.jsx');
const qualityPage = read('src/pages/QualityControl.jsx');
const database = read('server/db.js');

assert.match(preparation, /entity === 'ProductionBatch'/);
assert.match(preparation, /entity === 'QualityControl'/);
assert.match(preparation, /applyLinkedProductionLocation/);
assert.match(preparation, /assertPayloadLocationAccess\(user, entity, preparedQualityControl, scope\)/);
assert.match(batchPage, /production_id: production\.id/);
assert.match(batchPage, /site_id: production\.site_id/);
assert.match(qualityPage, /site_id: selectedBatch\.site_id/);
assert.match(qualityPage, /production_id: selectedBatch\.production_id/);
assert.match(database, /\['batch_id', 'ProductionBatch'\]/);

console.log('Production batch and quality-control location tests passed.');
