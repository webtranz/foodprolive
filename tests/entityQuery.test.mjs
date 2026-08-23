import assert from 'node:assert/strict';

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

console.log('Entity SQL query builder tests passed.');
