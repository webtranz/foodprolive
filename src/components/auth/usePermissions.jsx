import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { ALL_GRANULAR_ROLE_PERMISSION_KEYS } from '@/lib/rolePermissions';

const SYSTEM_ROLES = {
  admin: {
    access_level: 'admin',
    permissions: [
      'scan_qr', 'view_dashboard', 'view_reports', 'export_data', 'create_session',
      'manage_sessions', 'manage_groups', 'manage_users', 'manage_roles', 'delete_records',
      'view_ai_waste', 'camera_detection', 'manage_projects', 'manage_ingredients', 'manage_food_categories',
      'manage_inventory', 'transfer_inventory', 'manage_recipes', 'manage_menu_planning', 'generate_menu_plan_pr',
      'create_special_event', 'edit_special_event', 'submit_special_event', 'review_special_event', 'approve_special_event', 'reject_special_event',
      'manage_production', 'create_production_request', 'edit_production_request',
      'submit_production_request', 'review_production_request', 'approve_production_request',
      'reject_production_request', 'request_changes_production', 'approve_production',
      'start_production', 'complete_production', 'create_material_request', 'view_material_request',
      'acknowledge_material_request', 'manage_procurement',
      'approve_procurement', 'manage_suppliers', 'manage_waste', 'approve_waste',
      'manage_pos', 'manage_erp', 'manage_forecasting', 'manage_attendance',
      'approve_attendance', 'manage_quality', ...ALL_GRANULAR_ROLE_PERMISSION_KEYS
    ]
  },
  manager: {
    access_level: 'manager',
    permissions: [
      'scan_qr', 'view_dashboard', 'view_reports', 'export_data', 'create_session',
      'manage_sessions', 'manage_groups', 'view_ai_waste', 'camera_detection',
      'manage_projects', 'manage_ingredients', 'manage_food_categories', 'manage_inventory', 'transfer_inventory',
      'manage_recipes', 'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event', 'edit_special_event',
      'submit_special_event', 'review_special_event', 'approve_special_event', 'reject_special_event', 'manage_production', 'create_production_request',
      'edit_production_request', 'submit_production_request', 'review_production_request',
      'approve_production_request', 'reject_production_request', 'request_changes_production',
      'approve_production', 'start_production', 'complete_production', 'create_material_request',
      'view_material_request', 'acknowledge_material_request', 'manage_procurement', 'approve_procurement', 'manage_suppliers',
      'manage_waste', 'approve_waste', 'manage_pos', 'manage_forecasting',
      'manage_attendance', 'approve_attendance', 'manage_quality'
    ]
  },
  project_manager: {
    access_level: 'manager',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data', 'manage_projects',
      'manage_inventory', 'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event',
      'edit_special_event', 'submit_special_event', 'review_special_event', 'approve_special_event', 'reject_special_event', 'manage_production',
      'review_production_request', 'approve_production_request', 'reject_production_request',
      'request_changes_production', 'approve_production', 'view_material_request',
      'manage_waste', 'approve_waste'
    ]
  },
  chef: {
    access_level: 'user',
    permissions: [
      'view_dashboard', 'view_reports', 'manage_ingredients', 'manage_recipes',
      'manage_menu_planning', 'create_special_event', 'edit_special_event', 'submit_special_event', 'manage_production', 'create_production_request',
      'edit_production_request', 'submit_production_request', 'start_production',
      'complete_production', 'create_material_request', 'view_material_request',
      'manage_waste', 'approve_waste', 'manage_quality'
    ]
  },
  procurement_officer: {
    access_level: 'manager',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data', 'manage_procurement',
      'approve_procurement', 'manage_suppliers', 'view_material_request',
      'acknowledge_material_request'
    ]
  },
  user: {
    access_level: 'user',
    permissions: ['scan_qr', 'view_dashboard']
  }
};

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
  const roleProfile = roleProfiles.find((profile) => profile.role_key === role) || SYSTEM_ROLES[role] || null;
  const accessLevel = currentUser?.role_access_level || roleProfile?.access_level || (['admin', 'manager', 'user'].includes(role) ? role : 'user');
  const roleSpecificPermissions = roleProfile?.permissions || currentUser?.role_permissions || [];
  const permissions = Array.from(new Set([
    ...(currentUser?.is_custom_role ? [] : (SYSTEM_ROLES[accessLevel]?.permissions || [])),
    ...roleSpecificPermissions
  ]));

  const can = (permission) => permissions.includes(permission);
  const isAdmin = accessLevel === 'admin';
  const isManager = accessLevel === 'manager' || accessLevel === 'admin';
  const allowedSiteIds = Array.isArray(currentUser?.allowed_site_ids)
    ? currentUser.allowed_site_ids
    : (currentUser?.site_id ? [currentUser.site_id] : []);
  const visibilityScope = currentUser?.visibility_scope || (isAdmin ? 'all_locations' : 'subtree');

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
    loading
  };
}
