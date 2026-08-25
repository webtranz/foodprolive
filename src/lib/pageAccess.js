import {
  GRANULAR_PAGE_ACCESS_PERMISSION,
  PAGE_ACCESS_PERMISSION_MAP
} from './rolePermissions.js';
import { isAdminOnlyBulkUploadPage } from '../../shared/bulkUploadAccess.js';

export const pagePermissionMap = {
  Menu: 'manage_menu_planning',
  MenuPlanning: 'manage_menu_planning',
  MenuBuilder: 'manage_menu_planning',
  AutoSchedule: 'manage_menu_planning',
  FoodCost: 'manage_menu_planning',
  EventPlanning: [
    'manage_menu_planning',
    'create_special_event',
    'edit_special_event',
    'submit_special_event',
    'review_special_event',
    'approve_special_event',
    'reject_special_event'
  ],
  FoodCategories: 'manage_food_categories',
  FoodWaste: 'manage_waste',
  FoodWasteQR: 'manage_waste',
  BulkUploadCenter: 'manage_bulk_uploads',
  BulkUploadTemplates: ['manage_bulk_uploads', 'export_data'],
  DataExports: 'export_data',
  AuditLogs: 'view_audit_logs',
  BulkUploadProgress: 'view_bulk_upload_progress',
  ReportsPreview: 'view_reports'
};

export function getRequiredPagePermission(pageName) {
  return pagePermissionMap[pageName] || null;
}

export function canAccessPage(pageName, can, { isAdmin = false } = {}) {
  if (typeof can !== 'function') {
    return false;
  }

  if (isAdminOnlyBulkUploadPage(pageName) && !isAdmin) {
    return false;
  }

  if (can(GRANULAR_PAGE_ACCESS_PERMISSION)) {
    const granularPermission = PAGE_ACCESS_PERMISSION_MAP[pageName];
    return granularPermission ? Boolean(can(granularPermission)) : false;
  }

  const requiredPermission = getRequiredPagePermission(pageName);
  if (!requiredPermission) {
    return true;
  }

  if (Array.isArray(requiredPermission)) {
    return requiredPermission.some((permission) => can(permission));
  }

  return Boolean(can(requiredPermission));
}
