import assert from 'node:assert/strict';

import { assertCanCreateProject, hasAdminAccess } from '../server/accessControl.js';
import { systemRoleDefinitions } from '../server/entities.js';
import {
  ADMIN_DASHBOARD_VIEW_ORDER,
  DASHBOARD_VIEWS,
  MANAGEMENT_ROLE_DEFINITIONS,
  MANAGEMENT_ROLE_KEYS,
  SYSTEM_ROLE_KEYS,
  isManagementDashboardRole,
  isManagementScopeSiteType,
  mergeManagementRoleProfiles,
  mergeSystemRoleProfiles,
  normalizeManagementRoleProfile,
  resolveManagementDashboardView
} from '../shared/managementDashboardRoles.js';

const cases = [
  {
    name: 'canonical management roles resolve to their dedicated dashboards',
    run() {
      assert.equal(
        resolveManagementDashboardView({ role: 'general_manager' }),
        DASHBOARD_VIEWS.GENERAL_MANAGER
      );
      assert.equal(
        resolveManagementDashboardView({ role: 'assistant_general_manager' }),
        DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER
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
      assert.equal(resolveManagementDashboardView({ role: 'GM' }), DASHBOARD_VIEWS.GENERAL_MANAGER);
      assert.equal(resolveManagementDashboardView({ roleName: 'Assistant GM' }), DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER);
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
        DASHBOARD_VIEWS.GENERAL_MANAGER,
        DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER,
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
      }), DASHBOARD_VIEWS.GENERAL_MANAGER);
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
      assert.equal(isManagementScopeSiteType(DASHBOARD_VIEWS.GENERAL_MANAGER, 'company'), true);
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
  console.log(`PASS ${cases.length} management dashboard role tests`);
}
