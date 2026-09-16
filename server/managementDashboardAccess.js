import { hasAdminAccess } from './accessControl.js';
import {
  DASHBOARD_VIEWS,
  resolveManagementDashboardView
} from '../shared/managementDashboardRoles.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../shared/siteHierarchy.js';

const MANAGEMENT_VIEWS = new Map([
  ['default', DASHBOARD_VIEWS.DEFAULT],
  ['head_office', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['head-office', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['headoffice', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['ho', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['gm', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['general_manager', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['general-manager', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['agm', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['assistant_general_manager', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['assistant-general-manager', DASHBOARD_VIEWS.HEAD_OFFICE],
  ['area', DASHBOARD_VIEWS.AREA_MANAGER],
  ['area_manager', DASHBOARD_VIEWS.AREA_MANAGER],
  ['area-manager', DASHBOARD_VIEWS.AREA_MANAGER],
  ['pm', DASHBOARD_VIEWS.PROJECT_MANAGER],
  ['project_manager', DASHBOARD_VIEWS.PROJECT_MANAGER],
  ['project-manager', DASHBOARD_VIEWS.PROJECT_MANAGER]
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeManagementDashboardView(value) {
  const normalized = String(value || 'default').trim().toLowerCase().replace(/\s+/g, '_');
  const view = MANAGEMENT_VIEWS.get(normalized);
  if (!view) throw httpError(400, 'Unknown management dashboard view');
  return view;
}

export function assertManagementDashboardViewAccess(user, requestedView) {
  const view = normalizeManagementDashboardView(requestedView);
  if (user?.role_is_active === false) {
    throw httpError(403, 'The assigned role is inactive');
  }
  if (hasAdminAccess(user)) return view;
  if (user?.role_is_active === false) {
    throw httpError(403, 'The assigned management role is inactive');
  }

  // Canonical role keys are authoritative. A persisted display preference may
  // classify a custom management alias, but it cannot remap a built-in role to
  // another executive dashboard.
  const assignedView = resolveManagementDashboardView({ role: user?.role })
    || resolveManagementDashboardView({
      dashboardVariant: user?.dashboard_variant,
      roleName: user?.role_name
    });

  if (!assignedView) {
    throw httpError(403, 'A senior management role is required to access this dashboard');
  }
  if (view !== assignedView) {
    throw httpError(403, 'This dashboard is not assigned to your role');
  }
  return view;
}

export function selectDefaultProjectScope({ user = {}, sites = [], accessibleSiteIds = new Set() } = {}) {
  const allowed = accessibleSiteIds instanceof Set
    ? accessibleSiteIds
    : new Set((accessibleSiteIds || []).map(String));
  const candidates = (Array.isArray(sites) ? sites : [])
    .filter((site) => allowed.has(String(site?.id || '')))
    .filter((site) => normalizeSiteType(site?.type) === SITE_HIERARCHY_TYPES.PROJECT);

  const preferredIds = [
    user?.site_id,
    ...(Array.isArray(user?.allowed_site_ids) ? user.allowed_site_ids : [])
  ].filter(Boolean).map(String);
  const preferred = preferredIds
    .map((id) => candidates.find((site) => String(site.id) === id))
    .find(Boolean);
  if (preferred) return String(preferred.id);

  const first = candidates.sort((left, right) => (
    String(left?.name || '').localeCompare(String(right?.name || ''))
    || String(left?.id || '').localeCompare(String(right?.id || ''))
  ))[0];
  return first ? String(first.id) : null;
}

export const managementDashboardAccessInternals = {
  normalizeSiteType
};
