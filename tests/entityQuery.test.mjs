import assert from 'node:assert/strict';

import { listDocuments, listDocumentsPage } from '../server/db.js';

function createCapturingExecutor(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, parameters) {
      calls.push({ text, parameters });
      return {
        rows,
        rowCount: rows.length
      };
    }
  };
}

const pagedExecutor = createCapturingExecutor([]);
const paged = await listDocumentsPage('Production', {
  filters: {
    production_date: '2026-08-16',
    status: 'approved'
  },
  rangeFilters: {
    production_date: { gte: '2026-08-01', lte: '2026-08-31' }
  },
  sort: '-production_date',
  limit: 50,
  offset: 100,
  location: { unrestricted: false, accessibleSiteIds: ['site-1', 'site-2'] }
}, pagedExecutor);

assert.equal(paged.total_count, 0);
assert.equal(paged.limit, 50);
assert.equal(paged.offset, 100);
assert.ok(pagedExecutor.calls.length >= 1);
const pagedQuery = pagedExecutor.calls[0];
assert.match(pagedQuery.text, /COUNT\(\*\) OVER\(\) AS total_count/);
assert.match(pagedQuery.text, /FROM production_events event\) normalized_record/);
assert.match(pagedQuery.text, /normalized_record\.production_date >= \$\d+/);
assert.match(pagedQuery.text, /normalized_record\.production_date <= \$\d+/);
assert.match(pagedQuery.text, /normalized_record\.warehouse_id = ANY\(\$\d+::text\[\]\)/);
assert.match(pagedQuery.text, /ORDER BY normalized_record\.production_date DESC/);
assert.match(pagedQuery.text, /LIMIT \$\d+::integer/);
assert.match(pagedQuery.text, /OFFSET \$\d+::integer/);
assert.doesNotMatch(pagedQuery.text, /entity_records|record\.data|jsonb_array_elements_text/);
assert.ok(pagedQuery.parameters.includes('2026-08-16'));
assert.ok(pagedQuery.parameters.includes('approved'));
assert.ok(pagedQuery.parameters.includes('2026-08-01'));
assert.ok(pagedQuery.parameters.includes('2026-08-31'));
assert.deepEqual(pagedQuery.parameters.find(Array.isArray), ['site-1', 'site-2']);
assert.equal(pagedQuery.parameters.at(-2), 50);
assert.equal(pagedQuery.parameters.at(-1), 100);

const inventoryExecutor = createCapturingExecutor([]);
await listDocuments('Inventory', {
  filters: { ingredient_id: 'ing-1', site_id: 'site-384' },
  sort: 'ingredient_id',
  limit: 25,
  lock: true
}, inventoryExecutor);
assert.match(inventoryExecutor.calls[0].text, /FROM \(SELECT \* FROM warehouse_inventory\) normalized_record/);
assert.match(inventoryExecutor.calls[0].text, /normalized_record\.ingredient_id/);
assert.match(inventoryExecutor.calls[0].text, /normalized_record\.warehouse_id/);
assert.match(inventoryExecutor.calls[0].text, /FOR UPDATE/);
assert.doesNotMatch(inventoryExecutor.calls[0].text, /entity_records|record\.data/);
assert.deepEqual(inventoryExecutor.calls[0].parameters.slice(0, 2), ['ing-1', 'site-384']);

await assert.rejects(
  () => listDocuments('EmailLog', {}, createCapturingExecutor()),
  /EmailLog is not backed by normalized relational storage/
);

console.log('Normalized entity SQL query tests passed.');
