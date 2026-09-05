import {
  canAccessGranularPage,
  GRANULAR_PAGE_ACCESS_PERMISSION,
} from './rolePermissions.js';
import { isAdminOnlyBulkUploadPage } from '../../shared/bulkUploadAccess.js';

export const pagePermissionMap = {
  Budget: ['view_budget', 'manage_budget'],
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
  Attendance: [
    'view_customer_meal_service',
    'record_customer_meal_service',
    'generate_staff_meal_qr'
  ],
  MealService: [
    'view_customer_meal_service',
    'record_customer_meal_service',
    'generate_staff_meal_qr'
  ],
  MealQRGenerator: 'create_employee_meal_qr',
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
    return canAccessGranularPage(pageName, can);
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
