import assert from 'node:assert/strict';
import {
  buildUserLocationScope,
  filterRecordsByLocation,
  hasOrganizationWideLocationAccess,
  hasUnrestrictedLocationAccess,
  isLocationScopedEntity,
  normalizeRecipeLocationPayload
} from '../server/locationScope.js';

const sites = [
  { id: 'area-a', type: 'area', is_active: true },
  { id: 'project-a', type: 'project', parent_site_id: 'area-a', is_active: true },
  { id: 'store-a', type: 'store', parent_site_id: 'project-a', is_active: true },
  { id: 'project-a2', type: 'project', parent_site_id: 'area-a', is_active: true },
  { id: 'area-b', type: 'area', is_active: true },
  { id: 'project-b', type: 'project', parent_site_id: 'area-b', is_active: true },
  { id: 'store-b', type: 'store', parent_site_id: 'project-b', is_active: true }
];

const ids = (scopeValue) => [...scopeValue.accessibleSiteIds].sort();
assert.deepEqual(ids(buildUserLocationScope({ role: 'general_manager', role_is_active: true }, sites)), sites.map((site) => site.id).sort());
assert.deepEqual(ids(buildUserLocationScope({
  role: 'area_manager', role_is_active: true, site_id: 'area-a',
  allowed_site_ids: ['area-a', 'area-b'], visibility_scope: 'all_locations'
}, sites)), ['area-a', 'project-a', 'project-a2', 'store-a']);
assert.deepEqual(ids(buildUserLocationScope({
  role: 'project_manager', role_is_active: true, site_id: 'project-a',
  allowed_site_ids: ['project-a', 'project-b'], visibility_scope: 'all_locations'
}, sites)), ['project-a', 'store-a']);
assert.deepEqual(ids(buildUserLocationScope({
  role: 'storekeeper', role_is_active: true, site_id: 'store-a',
  allowed_site_ids: ['store-a', 'store-b'], visibility_scope: 'all_locations'
}, sites)), ['store-a']);
assert.deepEqual(ids(buildUserLocationScope({
  role: 'storekeeper', role_is_active: true, site_id: 'project-a'
}, sites)), [], 'a storekeeper assigned to a project fails closed');

const areaUser = { role: 'area_manager', role_access_level: 'manager', role_is_active: true };
const scope = {
  accessibleSiteIds: new Set(['area-a', 'project-a', 'store-a']),
  accessibleTreeIds: new Set(['area-a', 'project-a', 'store-a'])
};

assert.deepEqual(
  filterRecordsByLocation(areaUser, 'Production', [
    { id: 'allowed', site_id: 'project-a' },
    { id: 'denied', site_id: 'project-b' },
    { id: 'unassigned' }
  ], scope).map((record) => record.id),
  ['allowed'],
  'scoped operational reads must fail closed for unattributed and out-of-area rows'
);

assert.equal(isLocationScopedEntity('Budget'), true, 'budgets must pass through the location-scope gate');

const areaBudgetScope = buildUserLocationScope({
  role: 'area_manager',
  role_access_level: 'manager',
  role_is_active: true,
  site_id: 'area-a'
}, sites);
assert.deepEqual(
  filterRecordsByLocation(areaUser, 'Budget', [
    { id: 'area-budget', site_id: 'area-a' },
    { id: 'project-budget', site_id: 'project-a' },
    { id: 'other-area-budget', site_id: 'project-b' },
    { id: 'unattributed-budget' }
  ], areaBudgetScope).map((record) => record.id),
  ['area-budget', 'project-budget'],
  'an Area Manager sees only budgets attributed to the assigned Area subtree'
);

const projectUser = { role: 'project_manager', role_access_level: 'manager', role_is_active: true };
const projectBudgetScope = buildUserLocationScope({
  ...projectUser,
  site_id: 'project-a'
}, sites);
assert.deepEqual(
  filterRecordsByLocation(projectUser, 'Budget', [
    { id: 'area-budget', site_id: 'area-a' },
    { id: 'project-budget', site_id: 'project-a' },
    { id: 'store-budget', site_id: 'store-a' },
    { id: 'sibling-project-budget', site_id: 'project-a2' },
    { id: 'unattributed-budget' }
  ], projectBudgetScope).map((record) => record.id),
  ['project-budget', 'store-budget'],
  'a Project Manager sees project and descendant Store budgets but not siblings or unattributed budgets'
);

assert.deepEqual(
  filterRecordsByLocation(areaUser, 'Recipe', [
    { id: 'global', site_scope: 'global', site_ids: [] },
    { id: 'area-recipe', site_scope: 'specific', site_ids: ['project-a'] },
    { id: 'other-recipe', site_scope: 'specific', site_ids: ['project-b'] }
  ], scope).map((record) => record.id),
  ['global', 'area-recipe']
);

assert.deepEqual(
  normalizeRecipeLocationPayload(
    { site_scope: 'specific', site_ids: ['KBR-384'], site_names: ['KBR'] },
    {
      sites: [
        { id: 'site-kbr-384', name: 'KBR', project_code: 'KBR-384', is_active: true }
      ]
    }
  ),
  {
    site_scope: 'specific',
    site_ids: ['site-kbr-384'],
    site_names: ['KBR']
  },
  'recipe uploads can use project codes from CSV templates and still store real Site IDs'
);

assert.equal(hasOrganizationWideLocationAccess({ role: 'general_manager', role_is_active: true }), true);
assert.equal(hasOrganizationWideLocationAccess({ role: 'assistant_general_manager', role_is_active: true }), true);
assert.equal(hasOrganizationWideLocationAccess({ role: 'general_manager', role_is_active: false }), false);
assert.equal(hasOrganizationWideLocationAccess({ role: 'gm', role_is_active: true }), false);
assert.equal(hasUnrestrictedLocationAccess({ role: 'general_manager', role_access_level: 'manager' }), false);

console.log('Location hierarchy scope tests passed');
