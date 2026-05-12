import assert from 'node:assert/strict';

import { authorizeEntityAction, hasPermission } from '../server/entities.js';
import { canAccessPage } from '../src/lib/pageAccess.js';

function createUser(role, extra = {}) {
  const accessLevel = role === 'admin' ? 'admin' : (role === 'manager' || role === 'project_manager' || role === 'procurement_officer' || role === 'production_supervisor' || role === 'finance_controller' ? 'manager' : 'user');
  return {
    role,
    role_access_level: accessLevel,
    ...extra
  };
}

const cases = [
  {
    name: 'admin retains food category permission',
    run() {
      const user = createUser('admin');
      assert.equal(hasPermission(user, 'manage_food_categories'), true);
      assert.doesNotThrow(() => authorizeEntityAction(user, 'FoodCategory', 'list'));
      assert.equal(canAccessPage('FoodCategories', (permission) => hasPermission(user, permission)), true);
    }
  },
  {
    name: 'manager retains food category permission',
    run() {
      const user = createUser('manager');
      assert.equal(hasPermission(user, 'manage_food_categories'), true);
      assert.doesNotThrow(() => authorizeEntityAction(user, 'FoodCategory', 'create', { name: 'Breakfast' }));
    }
  },
  {
    name: 'normal user is blocked from food category permission',
    run() {
      const user = createUser('user');
      assert.equal(hasPermission(user, 'manage_food_categories'), false);
      assert.throws(() => authorizeEntityAction(user, 'FoodCategory', 'list'), /permission|access/i);
      assert.equal(canAccessPage('FoodCategories', (permission) => hasPermission(user, permission)), false);
    }
  },
  {
    name: 'custom role can access food categories when explicitly permitted',
    run() {
      const user = createUser('user', {
        role_permissions: ['manage_food_categories']
      });
      assert.equal(hasPermission(user, 'manage_food_categories'), true);
      assert.doesNotThrow(() => authorizeEntityAction(user, 'FoodCategory', 'update', { name: 'Lunch' }, { id: 'cat1', name: 'Lunch' }));
      assert.equal(canAccessPage('FoodCategories', (permission) => hasPermission(user, permission)), true);
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
  console.log(`PASS ${cases.length} food category access tests`);
}
