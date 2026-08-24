import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  assertUserDeactivationAllowed,
  isActiveAdministratorAccount,
  isAdministratorAccount,
  isUserAuthenticationAllowed
} from '../server/userDeactivation.js';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const administrator = {
  id: 'admin-1',
  email: 'admin@example.test',
  full_name: 'Admin One',
  role: 'admin',
  role_access_level: 'admin',
  status: 'active'
};
const target = {
  id: 'user-1',
  email: 'person@example.test',
  full_name: 'Person One',
  role: 'user',
  role_access_level: 'user',
  status: 'active'
};

assert.equal(isUserAuthenticationAllowed({ status: 'active' }), true);
assert.equal(isUserAuthenticationAllowed({ status: 'invited' }), true);
assert.equal(isUserAuthenticationAllowed({ status: 'deactivated' }), false);
assert.equal(isUserAuthenticationAllowed({ status: 'INACTIVE' }), false);
assert.equal(isUserAuthenticationAllowed(null), false);
assert.equal(isAdministratorAccount(administrator), true);
assert.equal(isAdministratorAccount({ role: 'super_admin' }), true);
assert.equal(isAdministratorAccount({ role: 'super_administrator' }), true);
assert.equal(isAdministratorAccount({ role: 'custom_admin', role_access_level: 'admin' }), true);
assert.equal(isAdministratorAccount({ role: 'manager', role_access_level: 'manager' }), false);
assert.equal(isActiveAdministratorAccount(administrator), true);
assert.equal(isActiveAdministratorAccount({ ...administrator, status: 'invited' }), false);

assert.deepEqual(assertUserDeactivationAllowed({
  actor: administrator,
  target,
  activeAdministratorCount: 2,
  confirmation: ' PERSON@example.test ',
  reason: '  Employment ended  '
}), { reason: 'Employment ended' });

assert.throws(
  () => assertUserDeactivationAllowed({
    actor: { ...administrator, role: 'manager', role_access_level: 'manager' },
    target,
    activeAdministratorCount: 2,
    confirmation: target.email,
    reason: 'Requested by HR'
  }),
  (error) => error.status === 403 && /Only administrators/i.test(error.message)
);
assert.throws(
  () => assertUserDeactivationAllowed({
    actor: administrator,
    target: { ...target, id: administrator.id },
    activeAdministratorCount: 2,
    confirmation: target.email,
    reason: 'Requested'
  }),
  (error) => error.status === 409 && /own account/i.test(error.message)
);
assert.throws(
  () => assertUserDeactivationAllowed({
    actor: administrator,
    target: { ...target, status: 'deactivated' },
    activeAdministratorCount: 2,
    confirmation: target.email,
    reason: 'Requested'
  }),
  (error) => error.status === 409 && /already deactivated/i.test(error.message)
);
assert.throws(
  () => assertUserDeactivationAllowed({
    actor: administrator,
    target,
    activeAdministratorCount: 2,
    confirmation: 'wrong@example.test',
    reason: 'Requested'
  }),
  (error) => error.status === 400 && /email exactly/i.test(error.message)
);
assert.throws(
  () => assertUserDeactivationAllowed({
    actor: administrator,
    target,
    activeAdministratorCount: 2,
    confirmation: target.email,
    reason: '   '
  }),
  (error) => error.status === 400 && /reason is required/i.test(error.message)
);
assert.throws(
  () => assertUserDeactivationAllowed({
    actor: administrator,
    target,
    activeAdministratorCount: 2,
    confirmation: target.email,
    reason: 'x'.repeat(501)
  }),
  (error) => error.status === 400 && /500 characters or fewer/i.test(error.message)
);
assert.throws(
  () => assertUserDeactivationAllowed({
    actor: administrator,
    target: { ...target, role: 'super_admin', role_access_level: 'admin' },
    activeAdministratorCount: 1,
    confirmation: target.email,
    reason: 'Requested'
  }),
  (error) => error.status === 409 && /one active administrator/i.test(error.message)
);

const dbSource = read('server/db.js');
const serverSource = read('server/index.js');
const entitySource = read('server/entities.js');
const clientSource = read('src/api/base44Client.js');
const usersPageSource = read('src/pages/UserRoleManagement.jsx');

assert.match(serverSource, /app\.post\('\/api\/users\/:id\/deactivate', requireAuth, requireRole\(\['admin'\]\)/);
assert.match(serverSource, /deactivateUserAccount\(\{/);
assert.match(dbSource, /SELECT id FROM users ORDER BY id FOR UPDATE/);
assert.match(dbSource, /DELETE FROM auth_tokens WHERE user_id = \$1/);
assert.match(dbSource, /action: 'USER_DEACTIVATED'/);
assert.match(dbSource, /acting_admin:/);
assert.match(dbSource, /previous_status:/);
assert.match(dbSource, /createAuditLog\([\s\S]*executor\)/);
assert.match(dbSource, /isUserAuthenticationAllowed\(user\) \? sanitizeUser\(user\) : null/);
assert.match(dbSource, /!isUserAuthenticationAllowed\(user\)/);
assert.match(dbSource, /WHEN LOWER\(COALESCE\(status, 'active'\)\) IN \('deactivated', 'disabled', 'inactive', 'deleted'\) THEN status/);
assert.match(entitySource, /User accounts must be deactivated from User & Role Management/);
assert.match(entitySource, /User account status can only be changed through the protected deactivation workflow/);
assert.match(clientSource, /deactivateUser\(id, \{ confirmation, reason \}\)/);
assert.match(usersPageSource, /Delete User/);
assert.match(usersPageSource, /Type <span[\s\S]*deactivationTarget\?\.email/);
assert.match(usersPageSource, /all existing sessions will end immediately/);
assert.match(usersPageSource, /At least one active administrator must remain/);

console.log('User deactivation safety tests passed.');
