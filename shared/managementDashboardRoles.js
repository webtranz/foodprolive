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

const areaManagerPermissions = Object.freeze([
  ...managementDashboardPermissions,
  'access_production',
  'manage_production',
  'view_inventory',
  'view_ingredients',
  'view_recipes',
  'view_material_request',
  'approve_production',
  'adjust_approved_production',
  'cancel_production',
  'request_changes_area_production',
  'reject_area_production'
]);

const projectManagerPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_sites', 'access_menu',
  'access_menu_planning', 'access_event_planning', 'access_production',
  'access_inventory', 'access_material_requests', 'access_food_waste',
  'access_reports', 'access_advanced_reports', 'access_data_exports',
  'access_reports_preview', 'view_dashboard', 'view_reports', 'export_data', 'manage_projects',
  'view_ingredients', 'view_recipes', 'view_inventory',
  'manage_inventory', 'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event',
  'edit_special_event', 'submit_special_event', 'review_special_event', 'approve_special_event',
  'reject_special_event', 'manage_production',
  'review_production_request', 'approve_production_request', 'reject_production_request',
  'request_changes_production', 'view_material_request',
  'cancel_production',
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
    permissions: areaManagerPermissions
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

const allGranularPagePermissions = Object.freeze([
  'granular_page_access',
  'access_dashboard', 'access_sites', 'access_ingredients', 'access_food_categories',
  'access_recipes', 'access_nutrition_allergen', 'access_ai_recipes', 'access_food_cost',
  'access_menu', 'access_menu_planning', 'access_event_planning', 'access_menu_builder',
  'access_auto_schedule', 'access_production', 'access_inventory', 'access_material_requests',
  'access_yield_cost', 'access_batch_tracking', 'access_branch_orders',
  'access_production_transfer', 'access_procurement_planning', 'access_procurement',
  'access_supplier_portal', 'access_pos', 'access_d365', 'access_forecasting',
  'access_attendance', 'access_daily_meal_checkin', 'access_dining_scanner',
  'access_event_dining_checkin', 'access_event_inquiry', 'access_qr_management',
  'access_user_roles', 'access_food_waste', 'access_food_waste_qr',
  'access_quality_control', 'access_reports', 'access_advanced_reports',
  'access_cost_control', 'access_productivity_tracking', 'access_production_calculator',
  'access_calories_calculator', 'access_bulk_upload_center', 'access_bulk_upload_templates',
  'access_data_exports', 'access_audit_logs', 'access_bulk_upload_progress',
  'access_reports_preview'
]);

const allCapabilityPermissions = Object.freeze([
  'scan_qr', 'create_session', 'manage_sessions', 'manage_groups', 'delete_records',
  'view_ai_waste', 'camera_detection', 'view_dashboard', 'view_reports', 'export_data',
  'manage_bulk_uploads', 'view_audit_logs', 'view_bulk_upload_progress', 'manage_projects',
  'view_ingredients', 'manage_ingredients', 'manage_food_categories', 'view_inventory', 'manage_inventory',
  'transfer_inventory', 'view_recipes', 'manage_recipes', 'manage_menu_planning',
  'generate_menu_plan_pr', 'create_special_event',
  'edit_special_event', 'submit_special_event', 'review_special_event',
  'approve_special_event', 'reject_special_event', 'manage_production',
  'create_production_request', 'edit_production_request', 'submit_production_request',
  'review_production_request', 'approve_production_request', 'reject_production_request',
  'request_changes_production', 'approve_production', 'request_changes_area_production',
  'reject_area_production', 'adjust_approved_production', 'cancel_production', 'start_production',
  'complete_production', 'create_material_request', 'view_material_request',
  'acknowledge_material_request', 'manage_procurement', 'approve_procurement',
  'manage_suppliers', 'manage_waste', 'approve_waste', 'manage_pos', 'manage_erp',
  'manage_forecasting', 'manage_attendance', 'approve_attendance', 'manage_quality',
  'manage_users', 'manage_roles'
]);

const adminPermissions = Object.freeze([
  ...allGranularPagePermissions,
  ...allCapabilityPermissions
]);

const managerPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_sites', 'access_ingredients',
  'access_food_categories', 'access_recipes', 'access_nutrition_allergen', 'access_food_cost',
  'access_menu', 'access_menu_planning', 'access_event_planning', 'access_menu_builder',
  'access_auto_schedule', 'access_production', 'access_inventory', 'access_material_requests',
  'access_yield_cost', 'access_batch_tracking', 'access_branch_orders',
  'access_production_transfer', 'access_procurement_planning', 'access_procurement',
  'access_supplier_portal', 'access_pos', 'access_forecasting', 'access_attendance',
  'access_daily_meal_checkin', 'access_dining_scanner', 'access_event_dining_checkin',
  'access_event_inquiry', 'access_qr_management', 'access_food_waste',
  'access_food_waste_qr', 'access_quality_control', 'access_reports',
  'access_advanced_reports', 'access_cost_control', 'access_productivity_tracking',
  'access_production_calculator', 'access_calories_calculator',
  'access_bulk_upload_templates', 'access_data_exports',
  'access_audit_logs', 'access_bulk_upload_progress', 'access_reports_preview',
  'scan_qr', 'view_dashboard', 'view_reports', 'export_data', 'create_session',
  'view_audit_logs', 'view_bulk_upload_progress', 'manage_sessions',
  'manage_groups', 'view_ai_waste', 'camera_detection', 'manage_projects',
  'manage_ingredients', 'manage_food_categories', 'view_inventory', 'manage_inventory', 'transfer_inventory',
  'manage_recipes', 'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event',
  'edit_special_event', 'submit_special_event', 'review_special_event',
  'approve_special_event', 'reject_special_event', 'manage_production',
  'create_production_request', 'edit_production_request', 'submit_production_request',
  'cancel_production', 'start_production', 'complete_production', 'create_material_request', 'view_material_request',
  'acknowledge_material_request', 'manage_procurement', 'approve_procurement',
  'manage_suppliers', 'manage_waste', 'approve_waste', 'manage_pos',
  'manage_forecasting', 'manage_attendance', 'approve_attendance', 'manage_quality'
]);

const userPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_dining_scanner',
  'view_dashboard', 'scan_qr'
]);

const chefPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_ingredients', 'access_recipes',
  'access_menu', 'access_menu_planning', 'access_event_planning', 'access_production',
  'access_material_requests', 'access_food_waste', 'access_quality_control', 'access_reports',
  'view_dashboard', 'view_reports', 'view_inventory', 'manage_ingredients', 'manage_recipes',
  'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event',
  'edit_special_event', 'submit_special_event', 'manage_production',
  'create_production_request', 'edit_production_request', 'submit_production_request',
  'cancel_production', 'start_production', 'complete_production', 'create_material_request',
  'view_material_request', 'manage_waste', 'approve_waste', 'manage_quality'
]);

const storekeeperPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_ingredients', 'access_inventory',
  'access_material_requests', 'access_production_transfer', 'access_reports',
  'access_data_exports', 'view_dashboard', 'view_reports', 'export_data',
  'manage_inventory', 'transfer_inventory', 'manage_ingredients',
  'view_material_request', 'acknowledge_material_request'
]);

const procurementOfficerPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_material_requests',
  'access_procurement_planning', 'access_procurement', 'access_supplier_portal',
  'access_reports', 'access_data_exports', 'view_dashboard', 'view_reports', 'export_data',
  'manage_procurement', 'approve_procurement', 'manage_suppliers',
  'view_material_request', 'acknowledge_material_request'
]);

const productionSupervisorPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_menu_planning',
  'access_event_planning', 'access_production', 'access_material_requests',
  'access_batch_tracking', 'access_yield_cost', 'access_food_waste',
  'access_quality_control', 'access_reports', 'view_dashboard', 'view_reports',
  'view_ingredients', 'view_recipes', 'view_inventory',
  'create_special_event', 'edit_special_event', 'submit_special_event',
  'review_special_event', 'approve_special_event', 'reject_special_event',
  'manage_production', 'start_production', 'complete_production', 'view_material_request',
  'manage_menu_planning', 'manage_quality', 'manage_waste'
]);

const qualityControllerPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_food_waste',
  'access_food_waste_qr', 'access_quality_control', 'access_reports',
  'view_dashboard', 'view_reports', 'manage_quality', 'manage_waste', 'approve_waste'
]);

const financeControllerPermissions = Object.freeze([
  'granular_page_access', 'access_dashboard', 'access_d365', 'access_forecasting',
  'access_reports', 'access_advanced_reports', 'access_cost_control',
  'access_data_exports', 'view_dashboard', 'view_reports', 'export_data',
  'manage_erp', 'manage_forecasting'
]);

// RoleProfile records are configurable data, so a new installation can have an
// empty RoleProfile table even though these operational roles are built in. The
// shared definitions keep both the fallback UI and effective-permission clients
// aligned on the non-removable permission floor for each built-in role.
export const OPERATIONAL_ROLE_DEFINITIONS = Object.freeze({
  admin: Object.freeze({
    role_key: 'admin',
    name: 'Administrator',
    access_level: 'admin',
    description: 'Central administration with unrestricted access across all modules and locations.',
    permissions: adminPermissions
  }),
  manager: Object.freeze({
    role_key: 'manager',
    name: 'Operations Manager',
    access_level: 'manager',
    description: 'Cross-functional operational management for assigned projects and stores.',
    permissions: managerPermissions
  }),
  user: Object.freeze({
    role_key: 'user',
    name: 'General User',
    access_level: 'user',
    description: 'Basic operational visibility for assigned projects.',
    permissions: userPermissions
  }),
  chef: Object.freeze({
    role_key: 'chef',
    name: 'Chef',
    access_level: 'user',
    description: 'Kitchen leadership focused on recipes, menus, production, and food quality.',
    permissions: chefPermissions
  }),
  storekeeper: Object.freeze({
    role_key: 'storekeeper',
    name: 'Storekeeper',
    access_level: 'manager',
    description: 'Store-level stock control for receiving, adjustments, transfers, and material-request acknowledgement.',
    permissions: storekeeperPermissions
  }),
  procurement_officer: Object.freeze({
    role_key: 'procurement_officer',
    name: 'Procurement Officer',
    access_level: 'manager',
    description: 'Procurement operations for suppliers, requests, purchase orders, and invoices.',
    permissions: procurementOfficerPermissions
  }),
  production_supervisor: Object.freeze({
    role_key: 'production_supervisor',
    name: 'Production Supervisor',
    access_level: 'manager',
    description: 'Supervises production planning, approvals, batches, and kitchen execution.',
    permissions: productionSupervisorPermissions
  }),
  quality_controller: Object.freeze({
    role_key: 'quality_controller',
    name: 'Quality Controller',
    access_level: 'manager',
    description: 'Monitors quality, compliance, and food-waste controls.',
    permissions: qualityControllerPermissions
  }),
  finance_controller: Object.freeze({
    role_key: 'finance_controller',
    name: 'Finance Controller',
    access_level: 'manager',
    description: 'Reviews costs, reports, exports, and accounting integrations.',
    permissions: financeControllerPermissions
  })
});

export const OPERATIONAL_ROLE_FALLBACK_PROFILES = Object.freeze(
  Object.values(OPERATIONAL_ROLE_DEFINITIONS).map((definition) => Object.freeze({
    id: `system-role:${definition.role_key}`,
    ...definition,
    is_system: true,
    is_active: true,
    is_fallback: true
  }))
);

export const SYSTEM_ROLE_KEYS = Object.freeze([
  ...MANAGEMENT_ROLE_KEYS,
  ...OPERATIONAL_ROLE_FALLBACK_PROFILES.map((profile) => profile.role_key)
]);

export const SYSTEM_ROLE_DEFINITIONS = Object.freeze({
  ...OPERATIONAL_ROLE_DEFINITIONS,
  ...MANAGEMENT_ROLE_DEFINITIONS
});

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

export function getSystemRoleDefinition(roleKey) {
  return SYSTEM_ROLE_DEFINITIONS[normalizeRoleToken(roleKey)] || null;
}

export function isSystemRoleKey(roleKey) {
  return Boolean(getSystemRoleDefinition(roleKey));
}

export function getRequiredSystemRolePermissions(roleKey) {
  return getSystemRoleDefinition(roleKey)?.permissions || Object.freeze([]);
}

export function isManagementScopeSiteType(view, siteType) {
  const allowedTypes = MANAGEMENT_SCOPE_TYPES[view];
  return Boolean(allowedTypes?.has(normalizeSiteType(siteType)));
}

export function normalizeManagementRoleProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return profile;

  const normalizedRoleKey = normalizeRoleToken(profile.role_key);
  const canonical = getSystemRoleDefinition(normalizedRoleKey);
  const managementCanonical = MANAGEMENT_ROLE_DEFINITIONS[normalizedRoleKey] || null;
  const dashboardVariant = managementCanonical?.dashboard_variant || resolveManagementDashboardView({
    role: normalizedRoleKey,
    dashboardVariant: profile.dashboard_variant,
    roleName: profile.name
  });
  if (!canonical && !dashboardVariant) return profile;

  const requiredPermissions = canonical?.permissions || managementDashboardPermissions;
  return {
    ...profile,
    ...(canonical ? { role_key: canonical.role_key } : {}),
    access_level: canonical?.access_level || 'manager',
    ...(dashboardVariant ? { dashboard_variant: dashboardVariant } : {}),
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
  const withManagementFallbacks = mergeManagementRoleProfiles(roleProfiles)
    .map((profile) => normalizeManagementRoleProfile(profile));
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
