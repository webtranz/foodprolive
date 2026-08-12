import assert from 'node:assert/strict';

import { assertCanCreateProject, hasAdminAccess } from '../server/accessControl.js';

const cases = [
  {
    name: 'built-in administrators can create projects',
    run() {
      const user = { role: 'admin' };
      assert.equal(hasAdminAccess(user), true);
      assert.doesNotThrow(() => assertCanCreateProject(user));
    }
  },
  {
    name: 'custom administrator roles can create projects',
    run() {
      const user = {
        role: 'super_admin',
        role_access_level: 'admin',
        role_permissions: ['manage_projects'],
        is_custom_role: true
      };
      assert.equal(hasAdminAccess(user), true);
      assert.doesNotThrow(() => assertCanCreateProject(user));
    }
  },
  {
    name: 'manager roles cannot create projects even with project-management permission',
    run() {
      const user = {
        role: 'manager',
        role_access_level: 'manager',
        role_permissions: ['manage_projects']
      };
      assert.equal(hasAdminAccess(user), false);
      assert.throws(
        () => assertCanCreateProject(user),
        /only administrators/i
      );
    }
  },
  {
    name: 'custom manager roles cannot create projects even when granted manage_projects',
    run() {
      const user = {
        role: 'project_manager_custom',
        role_access_level: 'manager',
        role_permissions: ['manage_projects'],
        is_custom_role: true
      };
      assert.equal(hasAdminAccess(user), false);
      assert.throws(
        () => assertCanCreateProject(user),
        /only administrators/i
      );
    }
  }
];

let failed = false;

for (const testCase of cases) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`PASS ${cases.length} project creation access tests`);
}
