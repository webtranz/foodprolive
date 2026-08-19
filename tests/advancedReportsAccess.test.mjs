import assert from 'node:assert/strict';

import { canAccessAdvancedReport } from '../shared/advancedReportAccess.js';

const managerReports = ['admin', 'manager'];
const adminReports = ['admin'];
const managementRoles = [
  'general_manager',
  'assistant_general_manager',
  'area_manager',
  'project_manager'
];

managementRoles.forEach((role) => {
  assert.equal(canAccessAdvancedReport({
    role,
    accessLevel: 'manager',
    permissions: ['view_reports']
  }, managerReports), true, `${role} receives manager reports from its hydrated access level`);
  assert.equal(canAccessAdvancedReport({
    role,
    accessLevel: 'manager',
    permissions: ['view_reports']
  }, adminReports), false, `${role} does not receive administrator-only reports`);
});

assert.equal(canAccessAdvancedReport({
  accessLevel: 'admin',
  permissions: ['view_reports']
}, adminReports), true, 'administrators retain administrator-only reports');

assert.equal(canAccessAdvancedReport({
  accessLevel: 'manager',
  permissions: []
}, managerReports), false, 'a manager access level cannot bypass the report permission');

assert.equal(canAccessAdvancedReport({
  accessLevel: 'user',
  permissions: ['view_reports']
}, managerReports), false, 'the report permission does not elevate the hydrated access level');

console.log('Advanced report access tests passed');
