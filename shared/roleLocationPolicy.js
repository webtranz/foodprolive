import { SITE_HIERARCHY_TYPES, normalizeSiteType } from './siteHierarchy.js';

export const ROLE_LOCATION_POLICIES = Object.freeze({
  general_manager: Object.freeze({
    role_key: 'general_manager',
    scope: 'all_areas',
    assignment_label: 'All Areas',
    primary_site_type: null,
    visibility_scope: 'all_locations'
  }),
  assistant_general_manager: Object.freeze({
    role_key: 'assistant_general_manager',
    scope: 'all_areas',
    assignment_label: 'All Areas',
    primary_site_type: null,
    visibility_scope: 'all_locations'
  }),
  area_manager: Object.freeze({
    role_key: 'area_manager',
    scope: 'subtree',
    assignment_label: 'Area',
    primary_site_type: SITE_HIERARCHY_TYPES.AREA,
    visibility_scope: 'subtree'
  }),
  project_manager: Object.freeze({
    role_key: 'project_manager',
    scope: 'subtree',
    assignment_label: 'Project',
    primary_site_type: SITE_HIERARCHY_TYPES.PROJECT,
    visibility_scope: 'subtree'
  }),
  storekeeper: Object.freeze({
    role_key: 'storekeeper',
    scope: 'assigned_only',
    assignment_label: 'Store',
    primary_site_type: SITE_HIERARCHY_TYPES.STORE,
    visibility_scope: 'assigned_only'
  })
});

function normalizeRoleKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function getRoleLocationPolicy(roleKey) {
  return ROLE_LOCATION_POLICIES[normalizeRoleKey(roleKey)] || null;
}

export function hasAllAreaAccess(roleKey) {
  return getRoleLocationPolicy(roleKey)?.scope === 'all_areas';
}

export function isRolePrimarySiteType(roleKey, siteType) {
  const requiredType = getRoleLocationPolicy(roleKey)?.primary_site_type;
  return Boolean(requiredType && normalizeSiteType(siteType) === requiredType);
}

export function normalizeRoleLocationFields(user = {}) {
  const policy = getRoleLocationPolicy(user.role);
  if (!policy) return { ...user };

  if (policy.scope === 'all_areas') {
    return {
      ...user,
      site_id: null,
      site_name: null,
      allowed_site_ids: [],
      allowed_site_names: [],
      visibility_scope: policy.visibility_scope
    };
  }

  const primarySiteId = String(user.site_id || '').trim() || null;
  const primarySiteName = primarySiteId ? (user.site_name || null) : null;
  return {
    ...user,
    site_id: primarySiteId,
    site_name: primarySiteName,
    allowed_site_ids: primarySiteId ? [primarySiteId] : [],
    allowed_site_names: primarySiteId && primarySiteName ? [primarySiteName] : [],
    visibility_scope: policy.visibility_scope
  };
}
