import assert from 'node:assert/strict';

import { canAccessPage, getRequiredPagePermission } from '../src/lib/pageAccess.js';

const fakeCan = (permissions = []) => (permission) => permissions.includes(permission);

const cases = [
  {
    name: 'menu planning pages require menu planning permission',
    run() {
      assert.equal(getRequiredPagePermission('MenuPlanning'), 'manage_menu_planning');
      assert.equal(canAccessPage('MenuPlanning', fakeCan([])), false);
      assert.equal(canAccessPage('MenuPlanning', fakeCan(['manage_menu_planning'])), true);
      assert.equal(canAccessPage('FoodCost', fakeCan([])), false);
      assert.equal(canAccessPage('FoodCost', fakeCan(['manage_menu_planning'])), true);
    }
  },
  {
    name: 'food waste pages require waste permission',
    run() {
      assert.equal(canAccessPage('FoodWaste', fakeCan([])), false);
      assert.equal(canAccessPage('FoodWaste', fakeCan(['manage_waste'])), true);
      assert.equal(canAccessPage('FoodWasteQR', fakeCan([])), false);
      assert.equal(canAccessPage('FoodWasteQR', fakeCan(['manage_waste'])), true);
    }
  },
  {
    name: 'food categories remain restricted to authorized users',
    run() {
      assert.equal(canAccessPage('FoodCategories', fakeCan([])), false);
      assert.equal(canAccessPage('FoodCategories', fakeCan(['manage_food_categories'])), true);
    }
  },
  {
    name: 'special event page accepts event-specific approver permissions',
    run() {
      assert.equal(canAccessPage('EventPlanning', fakeCan([])), false);
      assert.equal(canAccessPage('EventPlanning', fakeCan(['approve_special_event'])), true);
      assert.equal(canAccessPage('EventPlanning', fakeCan(['create_special_event'])), true);
      assert.equal(canAccessPage('EventPlanning', fakeCan(['manage_menu_planning'])), true);
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
  console.log(`PASS ${cases.length} navigation permission tests`);
}
