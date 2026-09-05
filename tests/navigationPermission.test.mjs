import assert from 'node:assert/strict';
import fs from 'node:fs';

import { canAccessPage, getRequiredPagePermission } from '../src/lib/pageAccess.js';
import {
  canAccessGranularPage,
  GRANULAR_PAGE_ACCESS_PERMISSION,
  normalizeGranularPermissions,
  PAGE_ACCESS_PERMISSION_ALIASES,
  PAGE_ACCESS_PERMISSION_MAP,
  ROLE_PERMISSION_SECTIONS
} from '../src/lib/rolePermissions.js';

const fakeCan = (permissions = []) => (permission) => permissions.includes(permission);
const layoutSource = fs.readFileSync(new URL('../src/Layout.jsx', import.meta.url), 'utf8');

const cases = [
  {
    name: 'left panel follows the operations navigation order',
    run() {
      const orderedMarkers = [
        "{ name: n.dashboard, href: 'Dashboard'",
        "{ name: n.sites, href: 'Sites'",
        "{ name: n.budget || 'Budget', href: 'Budget'",
        "{ name: n.inventory, href: 'Inventory'",
        "{ name: n.ingredients, href: 'Ingredients'",
        "{ name: n.foodCategories || 'Food Categories'",
        "{ name: n.recipes, href: 'Recipes'",
        'name: n.menuPlanning',
        "{ name: n.nutritionAllergens, href: 'NutritionAllergen'",
        "{ name: n.yieldCost, href: 'YieldCost'",
        "{ name: n.production, href: 'Production'",
        "{ name: n.foodCost, href: 'FoodCost'",
        'name: n.attendance',
        "href: 'MealService'",
        "href: 'MealQRGenerator'",
        "{ name: n.foodWaste, href: 'FoodWaste'",
        'name: n.procurement',
        'name: n.cpuManagement',
        "name: n.integrations || 'Integrations'",
        "{ name: n.userRoles, href: 'UserRoleManagement'",
        "name: n.utilities || 'Utility Functions'",
        "name: n.activityLogs || 'Activity Logs'"
      ];
      const positions = orderedMarkers.map((marker) => {
        const index = layoutSource.indexOf(marker);
        assert.notEqual(index, -1, `Missing navigation marker: ${marker}`);
        return index;
      });
      positions.slice(1).forEach((position, index) => {
        assert.ok(position > positions[index], `${orderedMarkers[index + 1]} is out of order`);
      });
      assert.match(layoutSource, /name: n\.integrations[\s\S]*href: 'D365Integration'[\s\S]*href: 'POSIntegration'/);
    }
  },
  {
    name: 'role permission sections mirror the changed menu and submenu groups',
    run() {
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.map((section) => section.key),
        [
          'main-menu',
          'menu-planning',
          'food-consumption',
          'procurement',
          'cpu-management',
          'integrations',
          'utilities',
          'activity-logs',
          'additional-pages'
        ]
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'main-menu').subsections.map((subsection) => subsection.page),
        [
          'Dashboard',
          'Sites',
          'Budget',
          'Inventory',
          'Ingredients',
          'FoodCategories',
          'Recipes',
          'NutritionAllergen',
          'YieldCost',
          'Production',
          'FoodCost',
          'FoodWaste',
          'UserRoleManagement'
        ]
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'menu-planning').subsections.map((subsection) => subsection.page),
        ['Menu', 'MenuPlanning', 'EventPlanning', 'MenuBuilder', 'AutoSchedule']
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'food-consumption').subsections.map((subsection) => subsection.page),
        ['MealService', 'MealQRGenerator']
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'procurement').subsections.map((subsection) => subsection.page),
        ['ProcurementModule', 'MaterialRequests', 'SupplierPortal']
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'cpu-management').subsections.map((subsection) => subsection.page),
        ['BatchTracking', 'QualityControl', 'BranchOrders', 'ProductionTransfer']
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'integrations').subsections.map((subsection) => subsection.page),
        ['D365Integration', 'POSIntegration']
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'utilities').subsections.map((subsection) => subsection.page),
        ['BulkUploadCenter', 'BulkUploadTemplates', 'DataExports']
      );
      assert.deepEqual(
        ROLE_PERMISSION_SECTIONS.find((section) => section.key === 'activity-logs').subsections.map((subsection) => subsection.page),
        ['AuditLogs', 'BulkUploadProgress', 'ReportsPreview']
      );
    }
  },
  {
    name: 'budget page requires budget permissions',
    run() {
      assert.deepEqual(getRequiredPagePermission('Budget'), ['view_budget', 'manage_budget']);
      assert.equal(canAccessPage('Budget', fakeCan([])), false);
      assert.equal(canAccessPage('Budget', fakeCan(['view_budget'])), true);
      assert.equal(canAccessPage('Budget', fakeCan(['manage_budget'])), true);
      assert.equal(PAGE_ACCESS_PERMISSION_MAP.Budget, 'access_budget');
      assert.equal(canAccessPage('Budget', fakeCan([
        GRANULAR_PAGE_ACCESS_PERMISSION,
        'access_budget'
      ])), true);
    }
  },
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
      assert.equal(layoutSource.includes('FoodWasteQR'), false);
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
    name: 'utilities and activity pages require their matching capabilities',
    run() {
      assert.equal(canAccessPage('BulkUploadCenter', fakeCan([])), false);
      assert.equal(canAccessPage('BulkUploadCenter', fakeCan(['manage_bulk_uploads'])), false);
      assert.equal(canAccessPage('BulkUploadCenter', fakeCan(['manage_bulk_uploads']), { isAdmin: true }), true);
      assert.equal(canAccessPage('BulkUploadTemplates', fakeCan(['manage_bulk_uploads'])), true);
      assert.equal(canAccessPage('BulkUploadTemplates', fakeCan(['export_data'])), true);
      assert.equal(canAccessPage('AuditLogs', fakeCan(['view_audit_logs'])), true);
      assert.equal(canAccessPage('BulkUploadProgress', fakeCan(['view_bulk_upload_progress'])), true);
      assert.equal(canAccessPage('DataExports', fakeCan(['view_reports'])), false);
      assert.equal(canAccessPage('DataExports', fakeCan(['export_data'])), true);
      assert.equal(canAccessPage('ReportsPreview', fakeCan(['view_reports'])), true);
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
  },
  {
    name: 'granular roles require the selected subsection permission',
    run() {
      const granularOnly = [GRANULAR_PAGE_ACCESS_PERMISSION, 'access_inventory'];
      assert.equal(canAccessPage('Inventory', fakeCan(granularOnly)), true);
      assert.equal(canAccessPage('Dashboard', fakeCan(granularOnly)), false);
      assert.equal(canAccessPage('MenuPlanning', fakeCan([
        GRANULAR_PAGE_ACCESS_PERMISSION,
        'manage_menu_planning'
      ])), false);
    }
  },
  {
    name: 'food consumption child pages match meal service and QR permissions',
    run() {
      assert.deepEqual(getRequiredPagePermission('MealService'), [
        'view_customer_meal_service',
        'record_customer_meal_service',
        'generate_staff_meal_qr'
      ]);
      assert.equal(getRequiredPagePermission('MealQRGenerator'), 'create_employee_meal_qr');
      assert.equal(PAGE_ACCESS_PERMISSION_MAP.MealService, 'access_meal_service');
      assert.equal(PAGE_ACCESS_PERMISSION_MAP.MealQRGenerator, 'access_meal_qr_generator');
      assert.equal(canAccessPage('MealService', fakeCan([])), false);
      assert.equal(canAccessPage('MealService', fakeCan(['view_customer_meal_service'])), true);
      assert.equal(canAccessPage('MealQRGenerator', fakeCan(['view_customer_meal_service'])), false);
      assert.equal(canAccessPage('MealQRGenerator', fakeCan(['create_employee_meal_qr'])), true);
      assert.equal(canAccessGranularPage('MealQRGenerator', fakeCan(['create_employee_meal_qr'])), true);
      assert.equal(canAccessPage('MealQRGenerator', fakeCan([
        GRANULAR_PAGE_ACCESS_PERMISSION,
        'create_employee_meal_qr'
      ])), true);
      assert.equal(PAGE_ACCESS_PERMISSION_ALIASES.Attendance.includes('access_meal_service'), true);
      assert.equal(PAGE_ACCESS_PERMISSION_ALIASES.MealService.includes('access_attendance'), true);
      assert.equal(PAGE_ACCESS_PERMISSION_ALIASES.MealQRGenerator.includes('create_employee_meal_qr'), true);
    }
  },
  {
    name: 'every configured role subsection maps to a route permission',
    run() {
      const subsectionPages = ROLE_PERMISSION_SECTIONS.flatMap((section) => (
        section.subsections.map((subsection) => subsection.page)
      ));
      assert.equal(new Set(subsectionPages).size, subsectionPages.length);
      subsectionPages.forEach((page) => {
        assert.match(PAGE_ACCESS_PERMISSION_MAP[page], /^access_/);
      });
    }
  },
  {
    name: 'role permission controls do not duplicate page or action keys',
    run() {
      const subsectionKeys = ROLE_PERMISSION_SECTIONS.flatMap((section) => (
        section.subsections.map((subsection) => subsection.key)
      ));
      const capabilityKeys = ROLE_PERMISSION_SECTIONS.flatMap((section) => (
        section.capabilities.map((capability) => capability.key)
      ));
      assert.equal(new Set(subsectionKeys).size, subsectionKeys.length);
      assert.equal(new Set(capabilityKeys).size, capabilityKeys.length);
    }
  },
  {
    name: 'new role permissions always enable granular page enforcement',
    run() {
      assert.deepEqual(normalizeGranularPermissions([]), [GRANULAR_PAGE_ACCESS_PERMISSION]);
      assert.deepEqual(
        normalizeGranularPermissions(['access_dashboard', 'access_dashboard']),
        [GRANULAR_PAGE_ACCESS_PERMISSION, 'access_dashboard']
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
  console.log(`PASS ${cases.length} navigation permission tests`);
}
