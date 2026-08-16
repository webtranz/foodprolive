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

const emptyFilter = buildEntityListQuery({ entity: 'Recipe', filters: { category: '' } });
assert.match(emptyFilter.text, /COALESCE\(record\.data->>\$2, ''\) = ''/);

const noSiteReference = buildEntityListQuery({
  entity: 'Production',
  location: { unrestricted: false, accessibleSiteIds: ['site-a'] }
});
assert.match(noSiteReference.text, /ELSE TRUE/);

console.log('Entity SQL query builder tests passed.');
