import assert from 'node:assert/strict';

import { canAccessPage, getRequiredPagePermission } from '../src/lib/pageAccess.js';
import {
  GRANULAR_PAGE_ACCESS_PERMISSION,
  normalizeGranularPermissions,
  PAGE_ACCESS_PERMISSION_MAP,
  ROLE_PERMISSION_SECTIONS
} from '../src/lib/rolePermissions.js';

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
    name: 'utilities and activity pages require their matching capabilities',
    run() {
      assert.equal(canAccessPage('BulkUploadCenter', fakeCan([])), false);
      assert.equal(canAccessPage('BulkUploadCenter', fakeCan(['manage_bulk_uploads'])), true);
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
