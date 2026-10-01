import assert from 'node:assert/strict';

import { authorizeEntityAction, hasPermission } from '../server/entities.js';
import {
  READ_ONLY_ROLE_KEY,
  READ_ONLY_ROLE_PERMISSIONS
} from '../shared/managementDashboardRoles.js';

const readOnlyUser = {
  id: 'read-only-user',
  email: 'read-only@example.test',
  role: READ_ONLY_ROLE_KEY,
  role_access_level: 'manager',
  is_custom_role: false
};

const customReadOnlyUser = {
  ...readOnlyUser,
  id: 'custom-read-only-user',
  is_custom_role: true,
  role_permissions: [...READ_ONLY_ROLE_PERMISSIONS]
};

function assertDenied(fn, pattern = /Read Only Auditor|permission|cannot/i) {
  assert.throws(fn, pattern);
}

const cases = [
  {
    name: 'read only role has page and view permissions but no transaction permissions',
    run() {
      assert.equal(hasPermission(readOnlyUser, 'granular_page_access'), true);
      assert.equal(hasPermission(readOnlyUser, 'access_production'), true);
      assert.equal(hasPermission(readOnlyUser, 'access_menu_planning'), true);
      assert.equal(hasPermission(readOnlyUser, 'access_user_roles'), true);
      assert.equal(hasPermission(readOnlyUser, 'view_production'), true);
      assert.equal(hasPermission(readOnlyUser, 'view_menu_planning'), true);
      assert.equal(hasPermission(readOnlyUser, 'view_users'), true);
      assert.equal(hasPermission(readOnlyUser, 'view_roles'), true);

      assert.equal(hasPermission(readOnlyUser, 'manage_production'), false);
      assert.equal(hasPermission(readOnlyUser, 'create_production_request'), false);
      assert.equal(hasPermission(readOnlyUser, 'submit_production_request'), false);
      assert.equal(hasPermission(readOnlyUser, 'approve_production_request'), false);
      assert.equal(hasPermission(readOnlyUser, 'acknowledge_material_request'), false);
      assert.equal(hasPermission(readOnlyUser, 'manage_waste'), false);
      assert.equal(hasPermission(readOnlyUser, 'export_data'), false);
      assert.equal(hasPermission(readOnlyUser, 'manage_users'), false);
      assert.equal(hasPermission(readOnlyUser, 'manage_roles'), false);
      assert.equal(hasPermission(readOnlyUser, 'scan_qr'), false);
    }
  },
  {
    name: 'read only role can list/read application entities',
    run() {
      assert.equal(authorizeEntityAction(readOnlyUser, 'Site', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'RoleProfile', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'User', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'FoodCategory', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'MenuPlan', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'Production', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'ProductionConsumptionReport', 'read'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'Inventory', 'filter'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'Supplier', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'FoodWaste', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'QualityControl', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'ERPIntegrationConfig', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'ForecastScenario', 'list'), true);
      assert.equal(authorizeEntityAction(readOnlyUser, 'AttendanceSession', 'list'), true);
    }
  },
  {
    name: 'custom read only role profile keeps the same read behavior',
    run() {
      assert.equal(authorizeEntityAction(customReadOnlyUser, 'MenuPlan', 'list'), true);
      assert.equal(authorizeEntityAction(customReadOnlyUser, 'Production', 'list'), true);
      assert.equal(authorizeEntityAction(customReadOnlyUser, 'FoodWaste', 'list'), true);
    }
  },
  {
    name: 'read only role is blocked from generic writes even with manager access level',
    run() {
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'Site', 'create', { name: 'New Site' }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'RoleProfile', 'update', { name: 'Changed' }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'User', 'create', { email: 'user@example.test' }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'UserGroup', 'create', { name: 'Group' }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'MenuPlan', 'update', { meals: [] }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'Production', 'create', { status: 'draft' }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'FoodWaste', 'create', { waste_category: 'plate_waste' }));
      assertDenied(() => authorizeEntityAction(readOnlyUser, 'AdvancedReportSchedule', 'create', { report_key: 'food_cost' }));
    }
  }
];

for (const testCase of cases) {
  testCase.run();
  console.log(`✓ ${testCase.name}`);
}
