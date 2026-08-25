import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertManagementDashboardViewAccess,
  normalizeManagementDashboardView,
  selectDefaultProjectScope
} from '../server/managementDashboardAccess.js';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const page = read('src/pages/Dashboard.jsx');
const managementUi = read('src/components/dashboard/ManagementDashboard.jsx');
const client = read('src/api/base44Client.js');
const server = read('server/managementDashboard.js');
const serverIndex = read('server/index.js');
const roles = read('shared/managementDashboardRoles.js');

assert.match(page, /function DefaultDashboard\(\)/);
assert.match(page, /if \(isAdmin\) return <AdminDashboardCarousel \/>/);
assert.match(page, /ADMIN_DASHBOARD_VIEW_ORDER/);
assert.match(page, /aria-label="Show previous dashboard"/);
assert.match(page, /aria-label="Show next dashboard"/);
assert.match(page, /aria-pressed=\{index === activeIndex\}/);
assert.match(page, /aria-live="polite"/);
assert.match(page, /<ManagementDashboard view=\{dashboardView\}/);
assert.match(page, /useState\(getInitialManagementDateRange\)/);
assert.match(page, /dateRange=\{managementDateRange\}/);
assert.match(page, /onDateRangeChange=\{setManagementDateRange\}/);

assert.match(managementUi, /base44\.managementDashboard\.getSnapshot/);
assert.match(managementUi, /refetchInterval: 60_000/);
assert.match(managementUi, /\.subscribe\(/);
assert.match(managementUi, /'PurchaseRequest'/);
assert.match(managementUi, /'GoodsReceipt'/);
assert.match(managementUi, /Date range start/);
assert.match(managementUi, /Date range end/);
assert.match(managementUi, /const MAX_RANGE_OFFSET_DAYS = 365/);
assert.match(managementUi, /startDate: shiftDateValue\(endDate, -6\)/);
assert.match(managementUi, /start_date: startDate/);
assert.match(managementUi, /end_date: endDate/);
assert.match(managementUi, /\['management-dashboard', normalizedView, startDate, endDate, siteId \|\| 'all'\]/);
assert.match(managementUi, /placeholderData: \(previousData\) => previousData\?\.view === normalizedView/);
assert.equal((managementUi.match(/min=\{MIN_DATE_VALUE\}/g) || []).length, 2);
assert.equal((managementUi.match(/max=\{MAX_DATE_VALUE\}/g) || []).length, 2);
assert.match(managementUi, /const latestEndDate = shiftDateValue\(value, MAX_RANGE_OFFSET_DAYS\)/);
assert.match(managementUi, /const earliestStartDate = shiftDateValue\(value, -MAX_RANGE_OFFSET_DAYS\)/);
assert.match(managementUi, /Range Budget/);
assert.match(managementUi, /Range Spent/);
assert.match(managementUi, /aria-labelledby=\{scopeLabelId\}/);
assert.match(managementUi, /Reset to last 7 days/);
assert.match(managementUi, /Operational metrics, tables and trends use the selected date range; current stock and unresolved approvals show current state/);
assert.doesNotMatch(managementUi, /Reporting date/);
assert.doesNotMatch(managementUi, /Daily operational control/);
assert.match(managementUi, /normalizedView === 'agm' \? locationRef : chartRef/);
assert.match(managementUi, /awaitingProjectScope/);
assert.match(managementUi, /isRefetchError/);
assert.match(managementUi, /formatCurrency/);
assert.match(managementUi, /GM View/);
assert.match(managementUi, /AGM View/);
assert.match(managementUi, /Area Manager View/);
assert.match(managementUi, /Project Manager View/);
assert.doesNotMatch(managementUi, /SAR\s*[0-9]/);
assert.doesNotMatch(managementUi, /48,260|620,000|598,424|16,755|13,620/);

assert.match(client, /managementDashboard:\s*\{/);
assert.match(client, /\/api\/dashboard\/management/);
assert.match(client, /start_date: filters\.start_date \?\? filters\.startDate/);
assert.match(client, /end_date: filters\.end_date \?\? filters\.endDate/);
assert.match(serverIndex, /app\.get\('\/api\/dashboard\/management', requireAuth, requirePermission\('view_dashboard'\)/);
assert.match(serverIndex, /start_date: request\.query\.start_date/);
assert.match(serverIndex, /end_date: request\.query\.end_date/);
assert.match(serverIndex, /Cache-Control', 'private, no-store'/);

assert.match(server, /getLocationScope\(user\)/);
assert.match(server, /assertManagementDashboardViewAccess\(user, filters\.view\)/);
assert.match(server, /You do not have access to the selected location/);
assert.match(server, /return false;\s*\n\s*\}\);/);
assert.match(server, /purchase_requests/);
assert.match(server, /purchase_orders/);
assert.match(server, /goods_receipts/);
assert.match(server, /buildManagementDashboardSnapshot/);
assert.match(server, /listInventoryRiskCounts/);
assert.match(server, /MANAGEMENT_DASHBOARD_SOURCE_LIMIT/);
assert.match(server, /withSnapshotCache/);
assert.match(server, /openStatusFields:\s*\['approval_status'/);
assert.equal((server.match(/REGEXP_REPLACE\(LOWER\(BTRIM\(COALESCE/g) || []).length, 2);
assert.doesNotMatch(server, /itemTable|itemForeignKey|itemsByHeader/);

assert.match(roles, /general_manager/);
assert.match(roles, /assistant_general_manager/);
assert.match(roles, /area_manager/);
assert.match(roles, /project_manager/);
assert.match(roles, /normalizeManagementRoleProfile/);
assert.match(roles, /isManagementScopeSiteType/);

const db = read('server/db.js');
const usersPage = read('src/pages/UserRoleManagement.jsx');
const usePermissions = read('src/components/auth/usePermissions.jsx');
const initSql = read('server/sql/init.sql');
assert.match(db, /validateManagementUserAssignment/);
assert.match(db, /Built-in role keys cannot be changed/);
assert.match(db, /Built-in role access levels cannot be changed/);
assert.match(db, /A primary project or area is required/);
assert.match(usersPage, /managementViewForRole/);
assert.match(usersPage, /assignableSitesForRole/);
assert.match(usersPage, /getRequiredSystemRolePermissions/);
assert.match(usersPage, /materializeFallback/);
assert.match(usersPage, /RoleProfile\.create\(data\)/);
assert.match(usersPage, /disabled=\{isLocked\}/);
assert.match(usersPage, />Built-in<\/Badge>/);
assert.match(usersPage, />Admin only<\/Badge>/);
assert.match(usersPage, /Required permissions are locked/);
assert.match(usePermissions, /SYSTEM_ROLE_DEFINITIONS/);
assert.match(initSql, /purchase_requests_realtime_change/);
assert.match(initSql, /purchase_orders_realtime_change/);
assert.match(initSql, /goods_receipts_realtime_change/);

assert.equal(normalizeManagementDashboardView('General Manager'), 'gm');
assert.equal(
  assertManagementDashboardViewAccess({ role: 'general_manager', role_access_level: 'manager' }, 'gm'),
  'gm'
);
assert.throws(
  () => assertManagementDashboardViewAccess({ role: 'general_manager', role_access_level: 'manager' }, 'agm'),
  (error) => error.status === 403 && /not assigned/i.test(error.message)
);
assert.throws(
  () => assertManagementDashboardViewAccess({
    role: 'general_manager',
    role_access_level: 'manager',
    dashboard_variant: 'agm'
  }, 'agm'),
  (error) => error.status === 403 && /not assigned/i.test(error.message)
);
assert.throws(
  () => assertManagementDashboardViewAccess({ role: 'user', role_access_level: 'user' }, 'gm'),
  (error) => error.status === 403 && /senior management role/i.test(error.message)
);
assert.throws(
  () => assertManagementDashboardViewAccess({ role: 'general_manager', role_access_level: 'manager', role_is_active: false }, 'gm'),
  (error) => error.status === 403 && /inactive/i.test(error.message)
);
assert.throws(
  () => assertManagementDashboardViewAccess({ role: 'general_manager', role_access_level: 'user', role_is_active: false }, 'gm'),
  (error) => error.status === 403 && /inactive/i.test(error.message)
);
assert.equal(
  assertManagementDashboardViewAccess({ role: 'super_admin', role_access_level: 'admin' }, 'area_manager'),
  'area_manager'
);
assert.throws(
  () => normalizeManagementDashboardView('finance_controller'),
  (error) => error.status === 400 && /unknown/i.test(error.message)
);

const projectSites = [
  { id: 'region', name: 'Western Region', type: 'region' },
  { id: 'makkah', name: 'Makkah Site', type: 'camp', parent_site_id: 'region' },
  { id: 'jeddah', name: 'Jeddah Project', type: 'location', parent_site_id: 'region' },
  { id: 'kitchen', name: 'Main Kitchen', type: 'kitchen', parent_site_id: 'jeddah' }
];
assert.equal(selectDefaultProjectScope({
  user: { site_id: 'makkah' },
  sites: projectSites,
  accessibleSiteIds: new Set(projectSites.map((site) => site.id))
}), 'makkah');
assert.equal(selectDefaultProjectScope({
  user: { site_id: 'region' },
  sites: projectSites,
  accessibleSiteIds: new Set(projectSites.map((site) => site.id))
}), 'jeddah');
assert.equal(selectDefaultProjectScope({
  user: { site_id: 'region' },
  sites: projectSites,
  accessibleSiteIds: new Set(['region', 'kitchen'])
}), null);

console.log('Management dashboard integration wiring tests passed.');
