import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  SYSTEM_ROLE_DEFINITIONS,
  normalizeManagementRoleProfile,
  resolveManagementDashboardView
} from '../../../shared/managementDashboardRoles.js';

export function usePermissions() {
  const [currentUser, setCurrentUser] = useState(null);
  const [roleProfiles, setRoleProfiles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      base44.auth.me(),
      base44.entities.RoleProfile.list().catch(() => [])
    ])
      .then(([user, profiles]) => {
        setCurrentUser(user);
        setRoleProfiles(Array.isArray(profiles) ? profiles : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const role = currentUser?.role || 'user';
  const persistedRoleProfile = normalizeManagementRoleProfile(
    roleProfiles.find((profile) => profile.role_key === role) || null
  );
  const systemRoleProfile = SYSTEM_ROLE_DEFINITIONS[role] || null;
  const roleProfile = persistedRoleProfile || systemRoleProfile;
  const roleIsActive = currentUser?.role_is_active !== false && roleProfile?.is_active !== false;
  const accessLevel = roleIsActive
    ? (currentUser?.role_access_level || roleProfile?.access_level || (['admin', 'manager', 'user'].includes(role) ? role : 'user'))
    : 'user';
  const roleSpecificPermissions = roleIsActive
    ? (persistedRoleProfile?.permissions
      ?? currentUser?.role_permissions
      ?? systemRoleProfile?.permissions
      ?? [])
    : [];
  const usesAccessLevelBaseline = !systemRoleProfile
    || ['admin', 'manager', 'user'].includes(String(role || '').toLowerCase());
  const permissions = Array.from(new Set([
    ...(currentUser?.is_custom_role || !usesAccessLevelBaseline
      ? []
      : (SYSTEM_ROLE_DEFINITIONS[accessLevel]?.permissions || [])),
    ...roleSpecificPermissions
  ]));

  const can = (permission) => permissions.includes(permission);
  const isAdmin = accessLevel === 'admin';
  const isManager = accessLevel === 'manager' || accessLevel === 'admin';
  const allowedSiteIds = Array.isArray(currentUser?.accessible_site_ids)
    ? currentUser.accessible_site_ids
    : Array.isArray(currentUser?.allowed_site_ids)
    ? currentUser.allowed_site_ids
    : (currentUser?.site_id ? [currentUser.site_id] : []);
  const visibilityScope = currentUser?.visibility_scope || (isAdmin ? 'all_locations' : 'subtree');
  const dashboardView = roleIsActive
    ? resolveManagementDashboardView({
      role,
      dashboardVariant: currentUser?.dashboard_variant || roleProfile?.dashboard_variant,
      roleName: currentUser?.role_name || roleProfile?.name
    })
    : null;

  return {
    currentUser,
    role,
    accessLevel,
    roleProfile,
    permissions,
    can,
    isAdmin,
    isManager,
    allowedSiteIds,
    visibilityScope,
    dashboardView,
    roleIsActive,
    loading
  };
}
