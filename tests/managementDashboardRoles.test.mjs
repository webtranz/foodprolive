import assert from 'node:assert/strict';

import { assertCanCreateProject, hasAdminAccess } from '../server/accessControl.js';
import { createDocument, updateDocument } from '../server/db.js';
import { allPermissionKeys, systemRoleDefinitions } from '../server/entities.js';
import {
  ADMIN_DASHBOARD_VIEW_ORDER,
  DASHBOARD_VIEWS,
  MANAGEMENT_ROLE_DEFINITIONS,
  MANAGEMENT_ROLE_KEYS,
  OPERATIONAL_ROLE_DEFINITIONS,
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  getRequiredSystemRolePermissions,
  getSystemRoleDefinition,
  isManagementDashboardRole,
  isManagementScopeSiteType,
  isSystemRoleKey,
  mergeManagementRoleProfiles,
  mergeSystemRoleProfiles,
  normalizeManagementRoleProfile,
  resolveManagementDashboardView
} from '../shared/managementDashboardRoles.js';

function createRoleProfileExecutor(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.id, { ...record }]));
  return {
    records,
    async query(text, parameters = []) {
      const sql = String(text);
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT data') && sql.includes('id = $2')) {
        const record = records.get(parameters[1]);
        return { rows: record ? [{ data: record }] : [], rowCount: record ? 1 : 0 };
      }
      if (sql.includes('FROM entity_records')) {
        const rows = Array.from(records.values(), (data) => ({ data }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('INSERT INTO entity_records')) {
        const data = JSON.parse(parameters[2]);
        records.set(parameters[0], data);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE entity_records')) {
        const data = JSON.parse(parameters[2]);
        records.set(parameters[1], data);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected role-profile query: ${sql}`);
    }
  };
}

const cases = [
  {
    name: 'built-in fallbacks materialize by create and persist additive updates safely',
    async run() {
      const executor = createRoleProfileExecutor();
      const created = await createDocument('RoleProfile', {
        role_key: 'Area Manager',
        name: 'Area Manager',
        access_level: 'admin',
        permissions: ['manage_pos'],
        is_system: true
      }, executor);

      assert.equal(created.role_key, 'area_manager');
      assert.equal(created.access_level, 'manager');
      assert.equal(created.is_system, true);
      assert.equal(created.permissions.includes('approve_production'), true);
      assert.equal(created.permissions.includes('manage_pos'), true);

      const updated = await updateDocument('RoleProfile', created.id, {
        permissions: ['manage_quality']
      }, executor);
      assert.equal(updated.permissions.includes('approve_production'), true, 'mandatory permissions are restored');
      assert.equal(updated.permissions.includes('manage_quality'), true, 'optional permissions are saved');
      assert.equal(updated.permissions.includes('manage_pos'), false, 'optional permissions can be removed');

      await assert.rejects(
        updateDocument('RoleProfile', created.id, { role_key: 'custom_area' }, executor),
        (error) => error.status === 409 && /keys cannot be changed/i.test(error.message)
      );
      await assert.rejects(
        updateDocument('RoleProfile', created.id, { access_level: 'admin' }, executor),
        (error) => error.status === 409 && /access levels cannot be changed/i.test(error.message)
      );
    }
  },
  {
    name: 'custom role persistence remains fully configurable',
    async run() {
      const executor = createRoleProfileExecutor();
      const created = await createDocument('RoleProfile', {
        role_key: 'meal_auditor',
        name: 'Meal Auditor',
        access_level: 'user',
        permissions: ['view_reports']
      }, executor);
      const updated = await updateDocument('RoleProfile', created.id, {
        role_key: 'senior_meal_auditor',
        access_level: 'manager',
        permissions: ['manage_quality']
      }, executor);

      assert.equal(updated.role_key, 'senior_meal_auditor');
      assert.equal(updated.access_level, 'manager');
      assert.deepEqual(updated.permissions, ['manage_quality']);
      assert.notEqual(updated.is_system, true);
    }
  },
  {
    name: 'shared built-in floors preserve every server default permission',
    run() {
      assert.deepEqual(
        new Set(SYSTEM_ROLE_DEFINITIONS.admin.permissions),
        new Set(allPermissionKeys),
        'administrator baseline remains complete'
      );
      Object.entries(systemRoleDefinitions).forEach(([roleKey, definition]) => {
        const sharedDefinition = getSystemRoleDefinition(roleKey);
        assert.ok(sharedDefinition, `${roleKey} has a shared definition`);
        definition.permissions.forEach((permission) => {
          assert.equal(
            sharedDefinition.permissions.includes(permission),
            true,
            `${roleKey} preserves ${permission}`
          );
        });
      });
    }
  },
  {
    name: 'built-in operational overrides keep their mandatory floor and locked identity',
    run() {
      const normalized = normalizeManagementRoleProfile({
        id: 'stored-storekeeper',
        role_key: 'Storekeeper',
        name: 'Cold Store Keeper',
        access_level: 'admin',
        permissions: ['manage_pos']
      });

      assert.equal(normalized.role_key, 'storekeeper');
      assert.equal(normalized.access_level, 'manager');
      assert.equal(normalized.is_system, true);
      assert.equal(normalized.permissions.includes('manage_pos'), true, 'optional permissions remain additive');
      getRequiredSystemRolePermissions('storekeeper').forEach((permission) => {
        assert.equal(normalized.permissions.includes(permission), true, `${permission} remains mandatory`);
      });
    }
  },
  {
    name: 'production approval baselines separate PM review from Area final approval',
    run() {
      const areaPermissions = getRequiredSystemRolePermissions('area_manager');
      const projectPermissions = getRequiredSystemRolePermissions('project_manager');
      const storekeeperPermissions = getRequiredSystemRolePermissions('storekeeper');

      assert.equal(areaPermissions.includes('access_production'), true);
      assert.equal(areaPermissions.includes('access_budget'), true);
      assert.equal(areaPermissions.includes('view_budget'), true);
      assert.equal(areaPermissions.includes('manage_budget'), true);
      assert.equal(areaPermissions.includes('manage_production'), true);
      assert.equal(areaPermissions.includes('view_ingredients'), true);
      assert.equal(areaPermissions.includes('view_recipes'), true);
      assert.equal(areaPermissions.includes('view_material_request'), true);
      assert.equal(areaPermissions.includes('approve_production'), true);
      assert.equal(areaPermissions.includes('approve_production_request'), false);
      assert.equal(areaPermissions.includes('access_meal_service'), true);
      assert.equal(areaPermissions.includes('access_meal_qr_generator'), false);
      assert.equal(areaPermissions.includes('access_attendance'), true);
      assert.equal(areaPermissions.includes('view_customer_meal_service'), true);
      assert.equal(projectPermissions.includes('approve_production_request'), true);
      assert.equal(projectPermissions.includes('access_budget'), true);
      assert.equal(projectPermissions.includes('view_budget'), true);
      assert.equal(projectPermissions.includes('manage_budget'), true);
      assert.equal(projectPermissions.includes('view_ingredients'), true);
      assert.equal(projectPermissions.includes('view_recipes'), true);
      assert.equal(projectPermissions.includes('approve_production'), false);
      assert.equal(projectPermissions.includes('record_customer_meal_service'), true);
      assert.equal(projectPermissions.includes('generate_staff_meal_qr'), true);
      assert.equal(projectPermissions.includes('create_employee_meal_qr'), true);
      assert.equal(projectPermissions.includes('access_meal_service'), true);
      assert.equal(projectPermissions.includes('access_meal_qr_generator'), true);
      assert.equal(getRequiredSystemRolePermissions('general_manager').includes('view_customer_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('general_manager').includes('access_budget'), true);
      assert.equal(getRequiredSystemRolePermissions('general_manager').includes('manage_budget'), true);
      assert.equal(getRequiredSystemRolePermissions('general_manager').includes('record_customer_meal_service'), false);
      assert.equal(getRequiredSystemRolePermissions('general_manager').includes('generate_staff_meal_qr'), false);
      assert.equal(getRequiredSystemRolePermissions('assistant_general_manager').includes('view_customer_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('assistant_general_manager').includes('access_budget'), true);
      assert.equal(getRequiredSystemRolePermissions('assistant_general_manager').includes('manage_budget'), true);
      assert.equal(getRequiredSystemRolePermissions('manager').includes('approve_production'), false);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('approve_production'), false);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('access_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('access_meal_qr_generator'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('access_attendance'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('manage_attendance'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('approve_attendance'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('view_customer_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('record_customer_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('generate_staff_meal_qr'), true);
      assert.equal(getRequiredSystemRolePermissions('production_supervisor').includes('create_employee_meal_qr'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('access_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('access_meal_qr_generator'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('access_attendance'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('manage_attendance'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('record_customer_meal_service'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('generate_staff_meal_qr'), true);
      assert.equal(getRequiredSystemRolePermissions('supervisor').includes('create_employee_meal_qr'), true);
      assert.equal(getRequiredSystemRolePermissions('admin').includes('approve_production'), true);
      assert.equal(storekeeperPermissions.includes('access_material_requests'), true);
      assert.equal(storekeeperPermissions.includes('view_material_request'), true);
      assert.equal(storekeeperPermissions.includes('acknowledge_material_request'), true);
    }
  },
  {
    name: 'every built-in fallback carries its shared mandatory permissions',
    run() {
      const merged = mergeSystemRoleProfiles([]);
      Object.values(SYSTEM_ROLE_DEFINITIONS).forEach((definition) => {
        const fallback = merged.find((profile) => profile.role_key === definition.role_key);
        assert.ok(fallback, `${definition.role_key} fallback is present`);
        assert.equal(fallback.is_system, true);
        assert.equal(fallback.is_fallback, true);
        assert.equal(fallback.access_level, definition.access_level);
        definition.permissions.forEach((permission) => {
          assert.equal(fallback.permissions.includes(permission), true, `${definition.role_key} keeps ${permission}`);
        });
      });
    }
  },
  {
    name: 'system role helpers normalize aliases without changing custom roles',
    run() {
      assert.equal(isSystemRoleKey(' Area Manager '), true);
      assert.equal(getSystemRoleDefinition('STOREKEEPER'), OPERATIONAL_ROLE_DEFINITIONS.storekeeper);
      assert.equal(isSystemRoleKey('meal_auditor'), false);

      const custom = {
        role_key: 'meal_auditor',
        name: 'Meal Auditor',
        access_level: 'user',
        permissions: ['view_reports']
      };
      assert.equal(normalizeManagementRoleProfile(custom), custom);
    }
  },
  {
    name: 'canonical management roles resolve to the consolidated dashboards',
    run() {
      assert.equal(
        resolveManagementDashboardView({ role: 'general_manager' }),
        DASHBOARD_VIEWS.HEAD_OFFICE
      );
      assert.equal(
        resolveManagementDashboardView({ role: 'assistant_general_manager' }),
        DASHBOARD_VIEWS.HEAD_OFFICE
      );
      assert.equal(
        resolveManagementDashboardView({ role: 'area_manager' }),
        DASHBOARD_VIEWS.AREA_MANAGER
      );
      assert.equal(
        resolveManagementDashboardView({ role: 'project_manager' }),
        DASHBOARD_VIEWS.PROJECT_MANAGER
      );
    }
  },
  {
    name: 'common GM, AGM, area, and PM aliases resolve consistently',
    run() {
      assert.equal(resolveManagementDashboardView({ role: 'GM' }), DASHBOARD_VIEWS.HEAD_OFFICE);
      assert.equal(resolveManagementDashboardView({ roleName: 'Assistant GM' }), DASHBOARD_VIEWS.HEAD_OFFICE);
      assert.equal(resolveManagementDashboardView({ roleName: 'Regional Manager' }), DASHBOARD_VIEWS.AREA_MANAGER);
      assert.equal(resolveManagementDashboardView({ dashboardVariant: 'PM View' }), DASHBOARD_VIEWS.PROJECT_MANAGER);
      assert.equal(isManagementDashboardRole('AGM'), true);
      assert.equal(isManagementDashboardRole('chef'), false);
    }
  },
  {
    name: 'administrators retain the default dashboard and receive the complete rollable order',
    run() {
      assert.equal(resolveManagementDashboardView({ role: 'admin', dashboardVariant: 'gm' }), null);
      assert.deepEqual(ADMIN_DASHBOARD_VIEW_ORDER, [
        DASHBOARD_VIEWS.DEFAULT,
        DASHBOARD_VIEWS.HEAD_OFFICE,
        DASHBOARD_VIEWS.AREA_MANAGER,
        DASHBOARD_VIEWS.PROJECT_MANAGER
      ]);
    }
  },
  {
    name: 'persisted canonical roles retain labels but cannot override manager safety controls',
    run() {
      const persisted = {
        id: 'db-area-manager',
        role_key: 'area_manager',
        name: 'Western Area Manager',
        access_level: 'admin',
        dashboard_variant: 'agm',
        permissions: ['view_dashboard'],
        is_active: false
      };
      const merged = mergeManagementRoleProfiles([persisted]);
      const matching = merged.filter((profile) => profile.role_key === 'area_manager');

      assert.equal(matching.length, 1);
      assert.notEqual(matching[0], persisted);
      assert.equal(matching[0].name, 'Western Area Manager');
      assert.equal(matching[0].access_level, 'manager');
      assert.equal(matching[0].dashboard_variant, DASHBOARD_VIEWS.AREA_MANAGER);
      assert.equal(matching[0].is_system, true);
      assert.equal(matching[0].permissions.includes('access_dashboard'), true);
      assert.equal(matching[0].is_active, false);
      assert.equal(merged.length, MANAGEMENT_ROLE_KEYS.length);
    }
  },
  {
    name: 'canonical and alias role keys cannot be redirected by a conflicting variant',
    run() {
      assert.equal(resolveManagementDashboardView({
        role: 'general_manager',
        dashboardVariant: 'agm'
      }), DASHBOARD_VIEWS.HEAD_OFFICE);
      assert.equal(resolveManagementDashboardView({
        role: 'PM',
        dashboardVariant: 'gm'
      }), DASHBOARD_VIEWS.PROJECT_MANAGER);
    }
  },
  {
    name: 'custom management aliases are normalized to scoped manager profiles',
    run() {
      const normalized = normalizeManagementRoleProfile({
        role_key: 'western_ops',
        name: 'Regional Manager',
        access_level: 'admin',
        permissions: []
      });
      assert.equal(normalized.role_key, 'western_ops');
      assert.equal(normalized.access_level, 'manager');
      assert.equal(normalized.dashboard_variant, DASHBOARD_VIEWS.AREA_MANAGER);
      assert.equal(normalized.permissions.includes('view_dashboard'), true);
      assert.notEqual(normalized.is_system, true);
    }
  },
  {
    name: 'management scope types prevent project managers from using warehouse-only roots',
    run() {
      assert.equal(isManagementScopeSiteType(DASHBOARD_VIEWS.PROJECT_MANAGER, 'project'), true);
      assert.equal(isManagementScopeSiteType(DASHBOARD_VIEWS.PROJECT_MANAGER, 'camp'), true);
      assert.equal(isManagementScopeSiteType(DASHBOARD_VIEWS.PROJECT_MANAGER, 'warehouse'), false);
      assert.equal(isManagementScopeSiteType(DASHBOARD_VIEWS.HEAD_OFFICE, 'company'), true);
    }
  },
  {
    name: 'missing management roles are exposed as active manager-level system fallbacks',
    run() {
      const merged = mergeManagementRoleProfiles([]);
      assert.deepEqual(merged.map((role) => role.role_key), MANAGEMENT_ROLE_KEYS);
      merged.forEach((role) => {
        assert.equal(role.access_level, 'manager');
        assert.equal(role.is_system, true);
        assert.equal(role.is_fallback, true);
      });
    }
  },
  {
    name: 'fresh installations expose every built-in role for user assignment',
    run() {
      const merged = mergeSystemRoleProfiles([]);
      const roleKeys = merged.map((profile) => profile.role_key);

      assert.deepEqual(new Set(roleKeys), new Set(SYSTEM_ROLE_KEYS));
      assert.deepEqual(new Set(roleKeys), new Set(Object.keys(systemRoleDefinitions)));
      assert.equal(roleKeys.includes('admin'), true);
      assert.equal(roleKeys.includes('storekeeper'), true);
      assert.equal(roleKeys.includes('user'), true);
      assert.equal(merged.find((profile) => profile.role_key === 'storekeeper')?.is_fallback, true);
    }
  },
  {
    name: 'persisted and custom roles override matching fallbacks without being dropped',
    run() {
      const persistedStorekeeper = {
        id: 'persisted-storekeeper',
        role_key: 'storekeeper',
        name: 'Cold Store Keeper',
        access_level: 'manager',
        permissions: ['manage_inventory'],
        is_active: true
      };
      const customRole = {
        id: 'custom-role',
        role_key: 'meal_auditor',
        name: 'Meal Auditor',
        access_level: 'user',
        permissions: ['view_reports'],
        is_active: true
      };
      const merged = mergeSystemRoleProfiles([persistedStorekeeper, customRole]);

      assert.equal(merged.filter((profile) => profile.role_key === 'storekeeper').length, 1);
      assert.equal(merged.find((profile) => profile.role_key === 'storekeeper')?.name, 'Cold Store Keeper');
      assert.equal(merged.some((profile) => profile.role_key === 'meal_auditor'), true);
    }
  },
  {
    name: 'every canonical management profile forces its canonical access and dashboard',
    run() {
      Object.values(MANAGEMENT_ROLE_DEFINITIONS).forEach((definition) => {
        const normalized = normalizeManagementRoleProfile({
          role_key: definition.role_key,
          name: `Custom ${definition.name}`,
          access_level: 'admin',
          dashboard_variant: DASHBOARD_VIEWS.DEFAULT,
          permissions: []
        });
        assert.equal(normalized.access_level, 'manager');
        assert.equal(normalized.dashboard_variant, definition.dashboard_variant);
        assert.equal(normalized.is_system, true);
      });
    }
  },
  {
    name: 'management roles never acquire administrator project-creation access',
    run() {
      Object.values(MANAGEMENT_ROLE_DEFINITIONS).forEach((definition) => {
        const user = {
          role: definition.role_key,
          role_access_level: definition.access_level,
          role_permissions: definition.permissions,
          is_custom_role: true
        };
        assert.equal(hasAdminAccess(user), false);
        assert.throws(() => assertCanCreateProject(user), /only administrators/i);
      });
    }
  },
  {
    name: 'unknown operational roles keep the existing default dashboard',
    run() {
      assert.equal(resolveManagementDashboardView({ role: 'chef' }), null);
      assert.equal(resolveManagementDashboardView({ role: 'manager' }), null);
      assert.equal(resolveManagementDashboardView(), null);
    }
  }
];

let failed = false;

for (const testCase of cases) {
  try {
    await testCase.run();
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
  console.log(`PASS ${cases.length} management dashboard role tests`);
}
