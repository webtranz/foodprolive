import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  getRoleLocationPolicy,
  hasAllAreaAccess,
  isRolePrimarySiteType,
  normalizeRoleLocationFields
} from '../shared/roleLocationPolicy.js';

assert.equal(hasAllAreaAccess('general_manager'), true);
assert.equal(hasAllAreaAccess('assistant_general_manager'), true);
assert.equal(hasAllAreaAccess('area_manager'), false);
assert.equal(hasAllAreaAccess('GM'), false, 'display aliases must not receive global location access');
assert.equal(hasAllAreaAccess('assistant-general-manager'), false, 'only canonical role keys receive global access');

assert.equal(getRoleLocationPolicy('area_manager')?.assignment_label, 'Area');
assert.equal(isRolePrimarySiteType('area_manager', 'area'), true);
assert.equal(isRolePrimarySiteType('area_manager', 'region'), true, 'legacy area aliases remain assignable');
assert.equal(isRolePrimarySiteType('project_manager', 'project'), true);
assert.equal(isRolePrimarySiteType('project_manager', 'location'), true, 'legacy project aliases remain assignable');
assert.equal(isRolePrimarySiteType('storekeeper', 'store'), true);
assert.equal(isRolePrimarySiteType('storekeeper', 'warehouse'), true, 'legacy store aliases remain assignable');
assert.equal(isRolePrimarySiteType('storekeeper', 'project'), false);

assert.deepEqual(
  normalizeRoleLocationFields({
    role: 'general_manager',
    site_id: 'area-a',
    site_name: 'Area A',
    allowed_site_ids: ['area-a'],
    allowed_site_names: ['Area A'],
    visibility_scope: 'subtree'
  }),
  {
    role: 'general_manager',
    site_id: null,
    site_name: null,
    allowed_site_ids: [],
    allowed_site_names: [],
    visibility_scope: 'all_locations'
  }
);

assert.deepEqual(
  normalizeRoleLocationFields({
    role: 'area_manager',
    site_id: 'area-a',
    site_name: 'Area A',
    allowed_site_ids: ['area-a', 'area-b'],
    allowed_site_names: ['Area A', 'Area B'],
    visibility_scope: 'all_locations'
  }),
  {
    role: 'area_manager',
    site_id: 'area-a',
    site_name: 'Area A',
    allowed_site_ids: ['area-a'],
    allowed_site_names: ['Area A'],
    visibility_scope: 'subtree'
  }
);

assert.equal(
  normalizeRoleLocationFields({ role: 'storekeeper', site_id: 'store-a' }).visibility_scope,
  'assigned_only'
);

const entityAuthorization = await fs.readFile(new URL('../server/entities.js', import.meta.url), 'utf8');
const selfWritableMatch = entityAuthorization.match(/const selfWritableFields = new Set\(\[([^\]]*)\]\)/);
assert.ok(selfWritableMatch, 'self-writable field policy must remain explicit');
assert.doesNotMatch(selfWritableMatch[1], /site_id|site_name/, 'users cannot reassign their own location scope');

console.log('Role location policy tests passed');
