import { normalizeSiteType } from './siteHierarchy.js';

export const DASHBOARD_VIEWS = Object.freeze({
  DEFAULT: 'default',
  GENERAL_MANAGER: 'gm',
  GM: 'gm',
  ASSISTANT_GENERAL_MANAGER: 'agm',
  AGM: 'agm',
  AREA_MANAGER: 'area_manager',
  PROJECT_MANAGER: 'project_manager',
  PM: 'project_manager'
});

export const ADMIN_DASHBOARD_VIEW_ORDER = Object.freeze([
  DASHBOARD_VIEWS.DEFAULT,
  DASHBOARD_VIEWS.GENERAL_MANAGER,
  DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER,
  DASHBOARD_VIEWS.AREA_MANAGER,
  DASHBOARD_VIEWS.PROJECT_MANAGER
]);

const managementDashboardPermissions = Object.freeze([
  'granular_page_access',
  'access_dashboard',
  'access_reports',
  'access_advanced_reports',
  'access_data_exports',
  'access_reports_preview',
  'view_dashboard',
  'view_reports',
  'export_data'
]);

const projectManagerPermissions = Object.freeze([
  'view_dashboard', 'view_reports', 'export_data', 'manage_projects',
  'manage_inventory', 'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event',
  'edit_special_event', 'submit_special_event', 'review_special_event', 'approve_special_event',
  'reject_special_event', 'manage_production',
  'review_production_request', 'approve_production_request', 'reject_production_request',
  'request_changes_production', 'approve_production', 'view_material_request',
  'manage_waste', 'approve_waste'
]);

export const MANAGEMENT_ROLE_DEFINITIONS = Object.freeze({
  general_manager: Object.freeze({
    role_key: 'general_manager',
    name: 'General Manager',
    access_level: 'manager',
    dashboard_variant: DASHBOARD_VIEWS.GENERAL_MANAGER,
    description: 'Executive operational visibility across assigned locations and their descendants.',
    permissions: managementDashboardPermissions
  }),
  assistant_general_manager: Object.freeze({
    role_key: 'assistant_general_manager',
    name: 'Assistant General Manager',
    access_level: 'manager',
    dashboard_variant: DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER,
    description: 'Operational follow-up visibility across assigned locations and their descendants.',
    permissions: managementDashboardPermissions
  }),
  area_manager: Object.freeze({
    role_key: 'area_manager',
    name: 'Area Manager',
    access_level: 'manager',
    dashboard_variant: DASHBOARD_VIEWS.AREA_MANAGER,
    description: 'Area-level visibility for assigned regions, projects, and descendant locations.',
    permissions: managementDashboardPermissions
  }),
  project_manager: Object.freeze({
    role_key: 'project_manager',
    name: 'Project Manager',
    access_level: 'manager',
    dashboard_variant: DASHBOARD_VIEWS.PROJECT_MANAGER,
    description: 'Reviews production requests for assigned projects and controls operational approvals.',
    permissions: projectManagerPermissions
  })
});

export const MANAGEMENT_ROLE_KEYS = Object.freeze(Object.keys(MANAGEMENT_ROLE_DEFINITIONS));

const MANAGEMENT_SCOPE_TYPES = Object.freeze({
  [DASHBOARD_VIEWS.GENERAL_MANAGER]: new Set(['area', 'project']),
  [DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER]: new Set(['area', 'project']),
  [DASHBOARD_VIEWS.AREA_MANAGER]: new Set(['area']),
  [DASHBOARD_VIEWS.PROJECT_MANAGER]: new Set(['project'])
});

export const MANAGEMENT_ROLE_FALLBACK_PROFILES = Object.freeze(
  MANAGEMENT_ROLE_KEYS.map((roleKey) => Object.freeze({
    id: `system-role:${roleKey}`,
    ...MANAGEMENT_ROLE_DEFINITIONS[roleKey],
    is_system: true,
    is_active: true,
    is_fallback: true
  }))
);

// RoleProfile records are configurable data, so a new installation can have an
// empty RoleProfile table even though these operational roles are built into the
// server. Keep lightweight assignment profiles here so the administration UI
// can always offer every supported built-in role. Authentication and permission
// enforcement continue to use the server's authoritative role definitions.
const OPERATIONAL_ROLE_FALLBACK_DEFINITIONS = Object.freeze({
  admin: Object.freeze({
    role_key: 'admin',
    name: 'Administrator',
    access_level: 'admin',
    description: 'Central administration with unrestricted access across all modules and locations.'
  }),
  manager: Object.freeze({
    role_key: 'manager',
    name: 'Operations Manager',
    access_level: 'manager',
    description: 'Cross-functional operational management for assigned projects and stores.'
  }),
  user: Object.freeze({
    role_key: 'user',
    name: 'General User',
    access_level: 'user',
    description: 'Basic operational visibility for assigned projects.'
  }),
  chef: Object.freeze({
    role_key: 'chef',
    name: 'Chef',
    access_level: 'user',
    description: 'Kitchen leadership focused on recipes, menus, production, and food quality.'
  }),
  storekeeper: Object.freeze({
    role_key: 'storekeeper',
    name: 'Storekeeper',
    access_level: 'manager',
    description: 'Store-level stock control for receiving, adjustments, and transfers.'
  }),
  procurement_officer: Object.freeze({
    role_key: 'procurement_officer',
    name: 'Procurement Officer',
    access_level: 'manager',
    description: 'Procurement operations for suppliers, requests, purchase orders, and invoices.'
  }),
  production_supervisor: Object.freeze({
    role_key: 'production_supervisor',
    name: 'Production Supervisor',
    access_level: 'manager',
    description: 'Supervises production planning, approvals, batches, and kitchen execution.'
  }),
  quality_controller: Object.freeze({
    role_key: 'quality_controller',
    name: 'Quality Controller',
    access_level: 'manager',
    description: 'Monitors quality, compliance, and food-waste controls.'
  }),
  finance_controller: Object.freeze({
    role_key: 'finance_controller',
    name: 'Finance Controller',
    access_level: 'manager',
    description: 'Reviews costs, reports, exports, and accounting integrations.'
  })
});

export const OPERATIONAL_ROLE_FALLBACK_PROFILES = Object.freeze(
  Object.values(OPERATIONAL_ROLE_FALLBACK_DEFINITIONS).map((definition) => Object.freeze({
    id: `system-role:${definition.role_key}`,
    ...definition,
    permissions: Object.freeze([]),
    is_system: true,
    is_active: true,
    is_fallback: true
  }))
);

export const SYSTEM_ROLE_KEYS = Object.freeze([
  ...MANAGEMENT_ROLE_KEYS,
  ...OPERATIONAL_ROLE_FALLBACK_PROFILES.map((profile) => profile.role_key)
]);

function normalizeRoleToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const adminAliases = new Set([
  'admin',
  'administrator',
  'system_admin',
  'system_administrator',
  'super_admin',
  'super_administrator'
]);

const dashboardViewAliases = new Map([
  ['general_manager', DASHBOARD_VIEWS.GENERAL_MANAGER],
  ['general_manager_view', DASHBOARD_VIEWS.GENERAL_MANAGER],
  ['generalmanager', DASHBOARD_VIEWS.GENERAL_MANAGER],
  ['gm', DASHBOARD_VIEWS.GENERAL_MANAGER],
  ['gm_view', DASHBOARD_VIEWS.GENERAL_MANAGER],
  ['assistant_general_manager', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['assistant_general_manager_view', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['assistant_gm', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['asst_general_manager', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['deputy_general_manager', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['agm', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['agm_view', DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER],
  ['area_manager', DASHBOARD_VIEWS.AREA_MANAGER],
  ['area_manager_view', DASHBOARD_VIEWS.AREA_MANAGER],
  ['area_mgr', DASHBOARD_VIEWS.AREA_MANAGER],
  ['regional_manager', DASHBOARD_VIEWS.AREA_MANAGER],
  ['project_manager', DASHBOARD_VIEWS.PROJECT_MANAGER],
  ['project_manager_view', DASHBOARD_VIEWS.PROJECT_MANAGER],
  ['project_mgr', DASHBOARD_VIEWS.PROJECT_MANAGER],
  ['pm', DASHBOARD_VIEWS.PROJECT_MANAGER],
  ['pm_view', DASHBOARD_VIEWS.PROJECT_MANAGER]
]);

function viewFromCandidate(candidate) {
  const normalized = normalizeRoleToken(candidate);
  if (!normalized || normalized === DASHBOARD_VIEWS.DEFAULT || normalized === 'standard') {
    return null;
  }
  return dashboardViewAliases.get(normalized) || null;
}

export function resolveManagementDashboardView({ role, dashboardVariant, roleName } = {}) {
  const normalizedRole = normalizeRoleToken(role);
  if (adminAliases.has(normalizedRole)) {
    return null;
  }

  return viewFromCandidate(role)
    || viewFromCandidate(dashboardVariant)
    || viewFromCandidate(roleName)
    || null;
}

export function isManagementDashboardRole(role) {
  return Boolean(viewFromCandidate(role));
}

export function isReservedManagementRoleKey(roleKey) {
  return Object.prototype.hasOwnProperty.call(MANAGEMENT_ROLE_DEFINITIONS, normalizeRoleToken(roleKey));
}

export function isManagementScopeSiteType(view, siteType) {
  const allowedTypes = MANAGEMENT_SCOPE_TYPES[view];
  return Boolean(allowedTypes?.has(normalizeSiteType(siteType)));
}

export function normalizeManagementRoleProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return profile;

  const normalizedRoleKey = normalizeRoleToken(profile.role_key);
  const canonical = MANAGEMENT_ROLE_DEFINITIONS[normalizedRoleKey] || null;
  const dashboardVariant = canonical?.dashboard_variant || resolveManagementDashboardView({
    role: normalizedRoleKey,
    dashboardVariant: profile.dashboard_variant,
    roleName: profile.name
  });
  if (!dashboardVariant) return profile;

  const requiredPermissions = canonical?.permissions || managementDashboardPermissions;
  return {
    ...profile,
    ...(canonical ? { role_key: canonical.role_key } : {}),
    access_level: 'manager',
    dashboard_variant: dashboardVariant,
    permissions: Array.from(new Set([
      ...requiredPermissions,
      ...(Array.isArray(profile.permissions) ? profile.permissions.filter(Boolean) : [])
    ])),
    ...(canonical ? { is_system: true } : {})
  };
}

export function mergeManagementRoleProfiles(roleProfiles = []) {
  const persistedProfiles = Array.isArray(roleProfiles)
    ? roleProfiles.filter(Boolean).map((profile) => normalizeManagementRoleProfile(profile))
    : [];
  const persistedRoleKeys = new Set(
    persistedProfiles.map((profile) => normalizeRoleToken(profile?.role_key)).filter(Boolean)
  );

  return [
    ...persistedProfiles,
    ...MANAGEMENT_ROLE_FALLBACK_PROFILES.filter(
      (profile) => !persistedRoleKeys.has(normalizeRoleToken(profile.role_key))
    )
  ];
}

export function mergeSystemRoleProfiles(roleProfiles = []) {
  const withManagementFallbacks = mergeManagementRoleProfiles(roleProfiles);
  const existingRoleKeys = new Set(
    withManagementFallbacks
      .map((profile) => normalizeRoleToken(profile?.role_key))
      .filter(Boolean)
  );

  return [
    ...withManagementFallbacks,
    ...OPERATIONAL_ROLE_FALLBACK_PROFILES.filter(
      (profile) => !existingRoleKeys.has(normalizeRoleToken(profile.role_key))
    )
  ];
}
