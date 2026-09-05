import assert from 'node:assert/strict';

import { listDocuments } from '../server/db.js';
import { buildEntityListQuery } from '../server/entityQuery.js';

const filtered = buildEntityListQuery({
  entity: 'Production',
  filters: { production_date: '2026-08-16', status: 'approved' },
  sort: '-production_date',
  limit: 50,
  offset: 100,
  location: { unrestricted: false, accessibleSiteIds: ['site-1', 'site-2'] },
  includeTotal: true
});

assert.match(filtered.text, /COUNT\(\*\) OVER\(\)/);
assert.match(filtered.text, /jsonb_array_elements_text/);
assert.match(filtered.text, /LIMIT \$\d+::integer/);
assert.match(filtered.text, /OFFSET \$\d+::integer/);
assert.equal(filtered.parameters[0], 'Production');
assert.deepEqual(filtered.parameters.find(Array.isArray), ['site-1', 'site-2']);
assert.equal(filtered.parameters.at(-2), 50);
assert.equal(filtered.parameters.at(-1), 100);

const sites = buildEntityListQuery({
  entity: 'Site',
  location: { unrestricted: false, accessibleSiteIds: ['site-a'] }
});
assert.match(sites.text, /record\.id = ANY/);
assert.deepEqual(sites.parameters[1], ['site-a']);

const setScopedSites = buildEntityListQuery({
  entity: 'Production',
  location: { unrestricted: false, accessibleSiteIds: new Set(['site-a', 'site-b']) }
});
assert.deepEqual(setScopedSites.parameters[1], ['site-a', 'site-b']);

const locked = buildEntityListQuery({ entity: 'Inventory', lock: true, limit: 5 });
assert.match(locked.text, /LIMIT \$\d+::integer\s+FOR UPDATE/);

const inventoryStatus = buildEntityListQuery({
  entity: 'Inventory',
  filters: { status: 'low_stock' },
  sort: 'status',
  limit: 25,
  includeTotal: true
});
assert.match(inventoryStatus.text, /WHEN .*quantity.* <= 0 THEN 'out_of_stock'/s);
assert.match(inventoryStatus.text, /THEN 'low_stock'/);
assert.match(inventoryStatus.text, /COUNT\(\*\) OVER\(\)/);
assert.deepEqual(inventoryStatus.parameters, ['Inventory', 'low_stock', 25]);
assert.doesNotMatch(inventoryStatus.text, /record\.data->>\$\d+.*status/);

const emptyFilter = buildEntityListQuery({ entity: 'Recipe', filters: { category: '' } });
assert.match(emptyFilter.text, /COALESCE\(record\.data->>\$2, ''\) = ''/);

const noSiteReference = buildEntityListQuery({
  entity: 'Production',
  location: { unrestricted: false, accessibleSiteIds: ['site-a'] }
});
assert.doesNotMatch(noSiteReference.text, /ELSE TRUE/);
assert.match(noSiteReference.text, /jsonb_array_length\(record\.data->'site_ids'\) > 0/);

const globalRecipe = buildEntityListQuery({
  entity: 'Recipe',
  location: { unrestricted: false, accessibleSiteIds: ['site-a'] }
});
assert.match(globalRecipe.text, /site_scope/);
assert.match(globalRecipe.text, /= 'global'/);

const dateRange = buildEntityListQuery({
  entity: 'MealServiceAttendance',
  filters: { meal_type: 'lunch' },
  rangeFilters: {
    service_date: { gte: '2026-08-01', lte: '2026-08-31' }
  },
  sort: '-service_date',
  limit: 1000,
  offset: 2000
});
assert.match(dateRange.text, /record\.data->>'service_date' >= \$\d+::text/);
assert.match(dateRange.text, /record\.data->>'service_date' <= \$\d+::text/);
assert.ok(dateRange.parameters.includes('2026-08-01'));
assert.ok(dateRange.parameters.includes('2026-08-31'));
assert.equal(dateRange.parameters.at(-2), 1000);
assert.equal(dateRange.parameters.at(-1), 2000);

assert.throws(
  () => buildEntityListQuery({
    entity: 'MealServiceAttendance',
    rangeFilters: { "service_date') OR TRUE --": { gte: '2026-08-01' } }
  }),
  /Invalid range filter field/
);
assert.throws(
  () => buildEntityListQuery({
    entity: 'MealServiceAttendance',
    rangeFilters: { service_date: { between: ['2026-08-01', '2026-08-31'] } }
  }),
  /Unsupported range operator/
);

const lowerBoundOnly = buildEntityListQuery({
  entity: 'ProducedItemBatch',
  rangeFilters: { production_date: { gte: '2026-08-01' } }
});
assert.match(lowerBoundOnly.text, /record\.data->>'production_date' >= \$\d+::text/);
assert.doesNotMatch(lowerBoundOnly.text, /record\.data->>'production_date' <=/);

let dbQuery;
await listDocuments('MealServiceConsumption', {
  rangeFilters: { service_date: { gte: '2026-08-01', lte: '2026-08-31' } },
  limit: 25
}, {
  query: async (text, parameters) => {
    dbQuery = { text, parameters };
    return { rows: [] };
  }
});
assert.match(dbQuery.text, /record\.data->>'service_date' >= \$\d+::text/);
assert.match(dbQuery.text, /record\.data->>'service_date' <= \$\d+::text/);
assert.ok(dbQuery.parameters.includes('2026-08-01'));
assert.ok(dbQuery.parameters.includes('2026-08-31'));

console.log('Entity SQL query builder tests passed.');
