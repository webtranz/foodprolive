import { z } from 'zod';
import {
  assertCanManageSiteStructure,
  getUserEffectiveRole,
  hasAdminAccess
} from './accessControl.js';
import {
  MANAGEMENT_ROLE_DEFINITIONS,
  normalizeManagementRoleProfile
} from '../shared/managementDashboardRoles.js';
import { SUPPORTED_SITE_TYPES } from '../shared/siteHierarchy.js';
import {
  canStartApprovedProduction,
  getProductionTransitionPermission,
  isAllowedProductionTransition,
  normalizeProductionStatus,
  requiresAreaProductionApproval
} from '../shared/productionWorkflow.js';
import { DEFAULT_SOURCE_NAME, normalizeSourceName } from '../shared/sourceNames.js';
import { normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';

export { getUserEffectiveRole } from './accessControl.js';

const stringOptional = z.string().trim().optional().nullable();
const numberOptional = z.coerce.number().optional().nullable();
const booleanOptional = z.coerce.boolean().optional().nullable();
const arrayOptional = z.array(z.any()).optional().nullable();
const objectOptional = z.record(z.any()).optional().nullable();
const sourceNameOptional = z.preprocess(
  (value) => (value === null || typeof value === 'undefined' || value === ''
    ? undefined
    : normalizeSourceName(value, '')),
  z.enum(['D365', 'Cash']).optional().nullable()
);
const menuCuisineOptional = z.preprocess(
  (value) => (value === null || typeof value === 'undefined' || value === ''
    ? undefined
    : normalizeMenuCuisine(value, '')),
  z.enum(['general', 'philippines']).optional().nullable()
);
const menuCategoryOptional = z.preprocess(
  (value) => (value === null || typeof value === 'undefined' || value === ''
    ? undefined
    : normalizeMenuCategory(value, '')),
  z.enum(['senior', 'junior', 'labor', 'management_menu']).optional().nullable()
);

const granularPagePermissionLabels = {
  access_dashboard: 'Open Dashboard',
  access_sites: 'Open Projects & Sites',
  access_budget: 'Open Budget',
  access_ingredients: 'Open Ingredients',
  access_food_categories: 'Open Food Categories',
  access_recipes: 'Open Recipes',
  access_nutrition_allergen: 'Open Nutrition & Allergens',
  access_ai_recipes: 'Open AI Recipe Generator',
  access_food_cost: 'Open Food Cost',
  access_menu: 'Open Menu',
  access_menu_planning: 'Open Menu Planning',
  access_event_planning: 'Open Event Planning',
  access_menu_builder: 'Open Menu Builder',
  access_auto_schedule: 'Open Auto Schedule',
  access_production: 'Open Production',
  access_inventory: 'Open Inventory',
  access_material_requests: 'Open Material Requests',
  access_yield_cost: 'Open Yield & Cost',
  access_batch_tracking: 'Open Batch Tracking',
  access_branch_orders: 'Open Branch Orders',
  access_production_transfer: 'Open Production Transfer',
  access_procurement_planning: 'Open Procurement Planning',
  access_procurement: 'Open Procurement',
  access_supplier_portal: 'Open Supplier Portal',
  access_pos: 'Open POS Integration',
  access_d365: 'Open D365 / ERP Integration',
  access_forecasting: 'Open Forecasting',
  access_meal_service: 'Open Meal Service',
  access_meal_qr_generator: 'Open Meal QR Generator',
  access_attendance: 'Open Food Consumption (Legacy)',
  access_daily_meal_checkin: 'Open Daily Meal Check-in',
  access_dining_scanner: 'Open Dining Scanner',
  access_event_dining_checkin: 'Open Event Dining Check-in',
  access_event_inquiry: 'Open Event Inquiry',
  access_qr_management: 'Open QR Management',
  access_user_roles: 'Open Users & Roles',
  access_food_waste: 'Open Food Waste',
  access_quality_control: 'Open Quality Control',
  access_reports: 'Open Reports',
  access_advanced_reports: 'Open Advanced Reports',
  access_cost_control: 'Open Cost Control',
  access_productivity_tracking: 'Open Productivity Tracking',
  access_production_calculator: 'Open Production Calculator',
  access_calories_calculator: 'Open Calories Calculator',
  access_bulk_upload_center: 'Open Bulk Upload Center',
  access_bulk_upload_templates: 'Open Bulk Upload Templates',
  access_data_exports: 'Open CSV / Excel / PDF Reports',
  access_audit_logs: 'Open Audit Logs',
  access_bulk_upload_progress: 'Open Bulk Upload Progress',
  access_reports_preview: 'Open Reports Preview'
};

export const permissionCatalog = [
  { key: 'granular_page_access', label: 'Use Granular Page Access' },
  ...Object.entries(granularPagePermissionLabels).map(([key, label]) => ({ key, label })),
  { key: 'scan_qr', label: 'Scan QR Codes' },
  { key: 'create_session', label: 'Create Attendance Sessions' },
  { key: 'manage_sessions', label: 'Manage Attendance Sessions' },
  { key: 'manage_groups', label: 'Manage User Groups' },
  { key: 'delete_records', label: 'Delete Protected Records' },
  { key: 'view_ai_waste', label: 'View AI Waste Detection' },
  { key: 'camera_detection', label: 'Use Camera Waste Detection' },
  { key: 'view_dashboard', label: 'View Dashboard' },
  { key: 'view_budget', label: 'View Budget Planning & Reporting' },
  { key: 'manage_budget', label: 'Manage Informational Food Budgets' },
  { key: 'view_reports', label: 'View Reports' },
  { key: 'export_data', label: 'Export Data' },
  { key: 'manage_bulk_uploads', label: 'Manage Background Bulk Uploads' },
  { key: 'view_audit_logs', label: 'View Audit Logs' },
  { key: 'view_bulk_upload_progress', label: 'View Bulk Upload Progress' },
  { key: 'manage_projects', label: 'Manage Projects' },
  { key: 'view_ingredients', label: 'View Ingredients' },
  { key: 'manage_ingredients', label: 'Manage Ingredients' },
  { key: 'manage_food_categories', label: 'Manage Food Categories' },
  { key: 'manage_inventory', label: 'Manage Inventory' },
  { key: 'view_inventory', label: 'View Inventory' },
  { key: 'transfer_inventory', label: 'Transfer Inventory' },
  { key: 'view_recipes', label: 'View Recipes' },
  { key: 'manage_recipes', label: 'Manage Recipes' },
  { key: 'manage_menu_planning', label: 'Manage Menu Planning' },
  { key: 'generate_menu_plan_pr', label: 'Generate Menu Planning Purchase Requests' },
  { key: 'create_special_event', label: 'Create Special Event Requests' },
  { key: 'edit_special_event', label: 'Edit Special Event Requests' },
  { key: 'submit_special_event', label: 'Submit Special Event Requests' },
  { key: 'review_special_event', label: 'Review Special Event Requests' },
  { key: 'approve_special_event', label: 'Approve Special Event Requests' },
  { key: 'reject_special_event', label: 'Reject Special Event Requests' },
  { key: 'manage_production', label: 'Manage Production Plans' },
  { key: 'create_production_request', label: 'Create Production Request' },
  { key: 'edit_production_request', label: 'Edit Production Request' },
  { key: 'submit_production_request', label: 'Submit Production Request' },
  { key: 'review_production_request', label: 'Review Production Request' },
  { key: 'approve_production_request', label: 'Approve Production Request' },
  { key: 'reject_production_request', label: 'Reject Production Request' },
  { key: 'request_changes_production', label: 'Request Changes On Production Request' },
  { key: 'approve_production', label: 'Approve Production' },
  { key: 'request_changes_area_production', label: 'Area Review: Request Production Changes' },
  { key: 'reject_area_production', label: 'Area Review: Reject Production' },
  { key: 'adjust_approved_production', label: 'Adjust Approved Production Quantity' },
  { key: 'cancel_production', label: 'Cancel Production & Return Inventory' },
  { key: 'start_production', label: 'Start Production' },
  { key: 'complete_production', label: 'Complete Production' },
  { key: 'create_material_request', label: 'Create Material Request' },
  { key: 'view_material_request', label: 'View Material Requests' },
  { key: 'acknowledge_material_request', label: 'Acknowledge Material Requests' },
  { key: 'manage_procurement', label: 'Manage Procurement' },
  { key: 'approve_procurement', label: 'Approve Procurement' },
  { key: 'manage_suppliers', label: 'Manage Suppliers' },
  { key: 'manage_waste', label: 'Manage Food Waste' },
  { key: 'approve_waste', label: 'Approve High-Value Waste' },
  { key: 'manage_pos', label: 'Manage POS Integration' },
  { key: 'manage_erp', label: 'Manage ERP & Accounting Integration' },
  { key: 'manage_forecasting', label: 'Manage Forecasting' },
  { key: 'manage_attendance', label: 'Manage Attendance & Scheduling' },
  { key: 'approve_attendance', label: 'Approve Attendance' },
  { key: 'view_customer_meal_service', label: 'View Meal Service production balances' },
  { key: 'record_customer_meal_service', label: 'Save Meal Service covers' },
  { key: 'generate_staff_meal_qr', label: 'Generate Meal Service cover QR codes' },
  { key: 'create_employee_meal_qr', label: 'Create meal QR codes' },
  { key: 'manage_quality', label: 'Manage Quality Control' },
  { key: 'manage_users', label: 'Manage Users' },
  { key: 'manage_roles', label: 'Manage Roles & Permissions' }
];

export const allPermissionKeys = permissionCatalog.map((permission) => permission.key);

export const systemRoleDefinitions = {
  admin: {
    role_key: 'admin',
    name: 'Administrator',
    access_level: 'admin',
    description: 'Central administration with unrestricted access across all modules and locations.',
    permissions: [...allPermissionKeys]
  },
  manager: {
    role_key: 'manager',
    name: 'Operations Manager',
    access_level: 'manager',
    description: 'Cross-functional operational management for assigned projects and kitchens.',
    permissions: [
      'view_dashboard', 'view_budget', 'manage_budget', 'view_reports', 'export_data',
      'view_audit_logs', 'view_bulk_upload_progress', 'manage_projects',
      'manage_ingredients', 'manage_food_categories', 'view_inventory', 'manage_inventory', 'transfer_inventory', 'manage_recipes',
      'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event', 'edit_special_event',
      'submit_special_event', 'review_special_event', 'approve_special_event', 'reject_special_event',
      'manage_production', 'create_production_request', 'edit_production_request',
      'submit_production_request', 'cancel_production', 'start_production',
      'complete_production', 'create_material_request', 'view_material_request',
      'acknowledge_material_request', 'manage_procurement', 'approve_procurement', 'manage_suppliers', 'manage_waste',
      'approve_waste', 'manage_pos', 'manage_forecasting', 'manage_attendance',
      'approve_attendance', 'view_customer_meal_service', 'record_customer_meal_service',
      'generate_staff_meal_qr', 'create_employee_meal_qr', 'manage_quality'
    ]
  },
  general_manager: {
    ...MANAGEMENT_ROLE_DEFINITIONS.general_manager,
    permissions: [...MANAGEMENT_ROLE_DEFINITIONS.general_manager.permissions]
  },
  assistant_general_manager: {
    ...MANAGEMENT_ROLE_DEFINITIONS.assistant_general_manager,
    permissions: [...MANAGEMENT_ROLE_DEFINITIONS.assistant_general_manager.permissions]
  },
  area_manager: {
    ...MANAGEMENT_ROLE_DEFINITIONS.area_manager,
    permissions: [...MANAGEMENT_ROLE_DEFINITIONS.area_manager.permissions]
  },
  user: {
    role_key: 'user',
    name: 'General User',
    access_level: 'user',
    description: 'Basic operational visibility for assigned projects.',
    permissions: ['view_dashboard']
  },
  chef: {
    role_key: 'chef',
    name: 'Chef',
    access_level: 'user',
    description: 'Kitchen leadership role focused on recipes, menus, production, and food quality.',
    permissions: [
      'view_dashboard', 'view_reports', 'view_inventory', 'manage_ingredients', 'manage_recipes',
      'manage_menu_planning', 'generate_menu_plan_pr', 'create_special_event', 'edit_special_event',
      'submit_special_event', 'manage_production', 'create_production_request',
      'edit_production_request', 'submit_production_request', 'cancel_production', 'start_production',
      'complete_production', 'create_material_request', 'view_material_request',
      'manage_waste', 'approve_waste', 'manage_quality'
    ]
  },
  project_manager: {
    ...MANAGEMENT_ROLE_DEFINITIONS.project_manager,
    permissions: [...MANAGEMENT_ROLE_DEFINITIONS.project_manager.permissions]
  },
  storekeeper: {
    role_key: 'storekeeper',
    name: 'Storekeeper',
    access_level: 'manager',
    description: 'Warehouse and stock control role for receiving, adjustments, and transfers.',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data', 'manage_inventory',
      'transfer_inventory', 'manage_ingredients', 'view_material_request',
      'acknowledge_material_request'
    ]
  },
  procurement_officer: {
    role_key: 'procurement_officer',
    name: 'Procurement Officer',
    access_level: 'manager',
    description: 'Procurement role for supplier management, requests, purchase orders, and invoices.',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data', 'manage_procurement',
      'approve_procurement', 'manage_suppliers', 'view_material_request',
      'acknowledge_material_request'
    ]
  },
  production_supervisor: {
    role_key: 'production_supervisor',
    name: 'Production Supervisor',
    access_level: 'manager',
    description: 'Supervises planning, approvals, batch completion, and kitchen execution.',
    permissions: [
      'view_dashboard', 'view_reports', 'create_special_event', 'edit_special_event',
      'submit_special_event', 'review_special_event', 'approve_special_event', 'reject_special_event', 'manage_production',
      'start_production', 'complete_production', 'view_material_request', 'view_inventory', 'manage_menu_planning',
      'access_meal_service', 'access_meal_qr_generator', 'access_attendance',
      'manage_attendance', 'approve_attendance', 'view_customer_meal_service',
      'record_customer_meal_service', 'generate_staff_meal_qr', 'create_employee_meal_qr', 'manage_quality', 'manage_waste'
    ]
  },
  supervisor: {
    role_key: 'supervisor',
    name: 'Supervisor',
    access_level: 'manager',
    description: 'Supervises staff scheduling, production-linked meal service, and operational execution.',
    permissions: [
      'view_dashboard', 'view_reports', 'access_meal_service', 'access_meal_qr_generator',
      'access_attendance', 'manage_attendance',
      'approve_attendance', 'view_customer_meal_service', 'record_customer_meal_service',
      'generate_staff_meal_qr', 'create_employee_meal_qr',
      'manage_production', 'start_production', 'complete_production',
      'view_material_request', 'view_inventory'
    ]
  },
  quality_controller: {
    role_key: 'quality_controller',
    name: 'Quality Controller',
    access_level: 'manager',
    description: 'Monitors quality, compliance, and food waste control with approval authority.',
    permissions: [
      'view_dashboard', 'view_reports', 'manage_quality',
      'manage_waste', 'approve_waste'
    ]
  },
  finance_controller: {
    role_key: 'finance_controller',
    name: 'Finance Controller',
    access_level: 'manager',
    description: 'Reviews costs, exports, reports, and ERP/accounting integrations.',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data',
      'manage_erp', 'manage_forecasting'
    ]
  }
};

export function getSystemRoleDefinition(roleKey) {
  return systemRoleDefinitions[roleKey] || null;
}

export function getUserPermissions(user) {
  const effectiveRole = getUserEffectiveRole(user);
  const builtInFromCurrentRole = getSystemRoleDefinition(user?.role);
  const builtInFromAccessLevel = getSystemRoleDefinition(effectiveRole);
  const explicitPermissions = (Array.isArray(user?.role_permissions) ? user.role_permissions : []).filter(Boolean);

  if (user?.is_custom_role) {
    return Array.from(new Set(explicitPermissions));
  }

  const usesAccessLevelBaseline = !builtInFromCurrentRole
    || ['admin', 'manager', 'user'].includes(String(user?.role || '').toLowerCase());

  return Array.from(new Set([
    ...(usesAccessLevelBaseline ? (builtInFromAccessLevel?.permissions || []) : []),
    ...(builtInFromCurrentRole?.permissions || []),
    ...explicitPermissions
  ]));
}

export function hasPermission(user, permission) {
  return getUserPermissions(user).includes(permission);
}

export const entityRegistry = {
  AdvancedReportSchedule: {
    defaults: { status: 'active', frequency: 'weekly' }
  },
  ERPIntegrationConfig: {
    defaults: { is_active: true, sync_schedule: 'manual', data_mapping: {} }
  },
  ERPIntegrationLog: {
    defaults: { status: 'pending', retry_count: 0, request_payload: {}, response_payload: {} }
  },
  ForecastScenario: {
    defaults: { status: 'draft', model_type: 'blended_average', forecast_horizon_days: 7, safety_buffer_percent: 10 }
  },
  ForecastSnapshot: {
    defaults: { status: 'ready', forecast_rows: [], summary: {} }
  },
  AttendanceRecord: {
    defaults: { status: 'checked_in', approval_status: 'pending', attendance_status: 'present' }
  },
  AttendanceSession: {
    defaults: { status: 'active' }
  },
  StaffShift: {
    defaults: { status: 'scheduled', break_minutes: 60, approval_status: 'pending' }
  },
  BranchOrder: {
    defaults: { status: 'draft' }
  },
  CategoryQRSession: {
    defaults: { status: 'active', scan_counts: {} }
  },
  D365Master: {
    defaults: { status: 'synced' }
  },
  DinerScan: {
    defaults: { status: 'scanned' }
  },
  CustomerMealPlan: {
    defaults: { status: 'draft', meals: [] }
  },
  ProducedItemBatch: {
    defaults: {
      status: 'available',
      served_servings: 0,
      served_weight_grams: 0,
      wasted_servings: 0,
      wasted_weight_grams: 0,
      cutover_version: 1
    },
    unique: [
      { fields: ['production_id'], label: 'produced-item batch for this production' },
      { fields: ['batch_number'], label: 'produced-item batch number' }
    ],
    schema: z.object({
      batch_number: z.string().trim().min(1, 'Produced-item batch number is required'),
      production_id: z.string().trim().min(1, 'Production is required'),
      production_name: stringOptional,
      production_date: z.string().trim().min(1, 'Production date is required'),
      completed_at: z.string().trim().min(1, 'Completion time is required'),
      site_id: z.string().trim().min(1, 'Produced-item location is required'),
      site_name: stringOptional,
      recipe_id: z.string().trim().min(1, 'Produced recipe is required'),
      recipe_name: z.string().trim().min(1, 'Produced recipe name is required'),
      source_type: stringOptional,
      source_event_id: stringOptional,
      menu_plan_id: stringOptional,
      meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
      menu_type: menuCuisineOptional,
      menu_category: menuCategoryOptional,
      portion_size_grams: z.coerce.number().positive('Serving size must be greater than zero'),
      service_portion_size_grams: z.coerce.number().positive().optional().nullable(),
      service_portion_updated_by: stringOptional,
      service_portion_updated_by_name: stringOptional,
      service_portion_updated_at: stringOptional,
      expected_servings: z.coerce.number().min(0),
      expected_finished_weight_grams: z.coerce.number().min(0),
      actual_finished_weight_grams: z.coerce.number().positive('Actual finished weight must be greater than zero'),
      produced_servings: z.coerce.number().positive('Produced servings must be greater than zero'),
      produced_weight_grams: z.coerce.number().positive('Produced weight must be greater than zero'),
      served_servings: z.coerce.number().min(0),
      served_weight_grams: z.coerce.number().min(0),
      wasted_servings: z.coerce.number().min(0).optional().default(0),
      wasted_weight_grams: z.coerce.number().min(0).optional().default(0),
      remaining_servings: z.coerce.number().min(0),
      remaining_weight_grams: z.coerce.number().min(0),
      completed_by: stringOptional,
      completed_by_name: stringOptional,
      status: z.enum(['available', 'partial', 'consumed']),
      cutover_version: z.coerce.number().int().min(1)
    }).passthrough().superRefine((batch, context) => {
      const tolerance = 0.00001;
      if (batch.served_servings - batch.produced_servings > tolerance
        || batch.remaining_servings - batch.produced_servings > tolerance
        || Math.abs((batch.served_servings + (batch.wasted_servings || 0) + batch.remaining_servings) - batch.produced_servings) > tolerance) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remaining_servings'],
          message: 'Produced-item serving balances must reconcile to produced servings'
        });
      }
      if (batch.served_weight_grams - batch.produced_weight_grams > tolerance
        || batch.remaining_weight_grams - batch.produced_weight_grams > tolerance
        || Math.abs((batch.served_weight_grams + (batch.wasted_weight_grams || 0) + batch.remaining_weight_grams) - batch.produced_weight_grams) > tolerance) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remaining_weight_grams'],
          message: 'Produced-item weight balances must reconcile to produced weight'
        });
      }
    })
  },
  MealServiceAttendance: {
    defaults: { status: 'posted', items: [], summary: {}, scan_method: 'manual_supervisor', cutover_version: 1 },
    unique: [
      { fields: ['service_reference'], label: 'meal-service reference' },
      { fields: ['idempotency_key'], label: 'meal-service idempotency key' },
      { fields: ['reversal_idempotency_key'], label: 'meal-service reversal key', ignoreEmpty: true }
    ],
    schema: z.object({
      service_reference: z.string().trim().min(1, 'Meal-service reference is required'),
      idempotency_key: z.string().trim().min(1, 'Idempotency key is required').max(200),
      request_fingerprint: z.string().trim().length(64, 'Request fingerprint must be a SHA-256 digest'),
      reversal_idempotency_key: stringOptional,
      reversal_request_fingerprint: stringOptional,
      scope_key: stringOptional,
      menu_plan_id: stringOptional,
      menu_plan_name: stringOptional,
      menu_type: menuCuisineOptional,
      menu_category: menuCategoryOptional,
      customer_meal_plan_id: stringOptional,
      customer_meal_plan_name: stringOptional,
      site_id: z.string().trim().min(1, 'Location is required'),
      site_name: stringOptional,
      service_date: z.string().trim().min(1, 'Service date is required'),
      meal_type: z.enum(['breakfast', 'lunch', 'dinner']),
      customer_name: z.string().trim().min(1, 'Customer or group name is required'),
      customer_id: stringOptional,
      category: stringOptional,
      attendee_count: z.coerce.number().int().min(1).max(1000000),
      scan_method: z.literal('manual_supervisor'),
      notes: stringOptional,
      items: arrayOptional,
      summary: objectOptional,
      required_servings: z.coerce.number().min(0),
      required_weight_grams: z.coerce.number().min(0),
      served_servings: z.coerce.number().min(0),
      served_weight_grams: z.coerce.number().min(0),
      shortage_servings: z.coerce.number().min(0),
      shortage_weight_grams: z.coerce.number().min(0),
      recorded_by: stringOptional,
      recorded_by_name: stringOptional,
      recorded_at: z.string().trim().min(1),
      reversed_by: stringOptional,
      reversed_by_name: stringOptional,
      reversed_at: stringOptional,
      reversal_reason: stringOptional,
      status: z.enum(['posted', 'partially_fulfilled', 'reversed']),
      cutover_version: z.coerce.number().int().min(1)
    }).passthrough()
  },
  MealServiceConsumption: {
    defaults: { status: 'posted', allocations: [], movement_type: 'consumption', cutover_version: 1 },
    unique: [
      { fields: ['idempotency_key'], label: 'meal-service consumption idempotency key' }
    ],
    schema: z.object({
      idempotency_key: z.string().trim().min(1).max(260),
      meal_service_attendance_id: z.string().trim().min(1),
      service_reference: z.string().trim().min(1),
      reverses_consumption_id: stringOptional,
      menu_plan_id: stringOptional,
      menu_type: menuCuisineOptional,
      menu_category: menuCategoryOptional,
      customer_meal_plan_id: stringOptional,
      site_id: z.string().trim().min(1),
      site_name: stringOptional,
      service_date: z.string().trim().min(1),
      meal_type: z.enum(['breakfast', 'lunch', 'dinner']),
      recipe_id: z.string().trim().min(1),
      recipe_name: z.string().trim().min(1),
      attendee_count: z.coerce.number().int().min(1).max(1000000),
      portions_per_attendee: z.coerce.number().positive().max(20).optional().nullable(),
      servings_per_attendee: z.coerce.number().positive(),
      portion_size_grams: z.coerce.number().positive(),
      manual_portion_size_grams: z.coerce.number().positive().max(100000).optional().nullable(),
      portion_size_source: z.enum(['meal_service_manual', 'meal_service_configured']).optional().nullable(),
      covers: z.coerce.number().int().min(0).max(1000000).optional().nullable(),
      required_servings: numberOptional,
      required_weight_grams: numberOptional,
      consumed_servings: numberOptional,
      consumed_production_equivalent_servings: numberOptional,
      consumed_weight_grams: numberOptional,
      shortage_servings: numberOptional,
      shortage_weight_grams: numberOptional,
      allocations: arrayOptional,
      movement_type: z.enum(['consumption', 'reversal']),
      reversal_reason: stringOptional,
      performed_by: stringOptional,
      performed_by_name: stringOptional,
      performed_at: z.string().trim().min(1),
      status: z.literal('posted'),
      cutover_version: z.coerce.number().int().min(1)
    }).passthrough()
  },
  FoodWaste: {
    defaults: {
      status: 'logged',
      approval_status: 'approved',
      waste_scope: 'ingredient',
      avoidable_type: 'avoidable',
      estimated_cost: 0
    },
    schema: z.object({
      site_id: stringOptional,
      site_name: stringOptional,
      waste_date: z.string().trim().min(1, 'Waste date is required'),
      meal_type: stringOptional,
      served_at: stringOptional,
      recording_deadline_at: stringOptional,
      menu_plan_id: stringOptional,
      menu_plan_name: stringOptional,
      waste_category: stringOptional,
      reason_code: stringOptional,
      reason: stringOptional,
      avoidable_type: stringOptional,
      preventable: booleanOptional,
      waste_scope: stringOptional,
      ingredient_id: stringOptional,
      ingredient_name: stringOptional,
      recipe_id: stringOptional,
      recipe_name: stringOptional,
      production_id: stringOptional,
      production_name: stringOptional,
      batch_reference: stringOptional,
      quantity: numberOptional,
      unit: stringOptional,
      estimated_cost: numberOptional,
      approval_status: stringOptional,
      status: stringOptional,
      high_value: booleanOptional,
      evidence_image_url: stringOptional,
      image_url: stringOptional,
      inventory_transaction_id: stringOptional,
      inventory_deduction_quantity: numberOptional,
      inventory_shortage_quantity: numberOptional,
      inventory_movement_layers: arrayOptional,
      notes: stringOptional
    }).passthrough()
  },
  Budget: {
    defaults: {
      status: 'active',
      currency: 'SAR',
      scope_type: 'site_period',
      meal_type: 'all'
    },
    schema: z.object({
      name: z.string().trim().min(1, 'Budget name is required'),
      site_id: stringOptional,
      site_name: stringOptional,
      start_date: z.string().trim().min(1, 'Budget start date is required'),
      end_date: z.string().trim().min(1, 'Budget end date is required'),
      budget_amount: z.coerce.number().min(0, 'Budget amount must be zero or greater'),
      currency: stringOptional,
      scope_type: stringOptional,
      meal_type: stringOptional,
      event_name: stringOptional,
      category: stringOptional,
      department: stringOptional,
      status: stringOptional,
      notes: stringOptional
    }).passthrough()
  },
  FoodCategory: {
    defaults: { status: 'active', color: '#10b981' },
    unique: [
      { fields: ['name'], label: 'food category name' },
      { fields: ['code'], label: 'food category code', ignoreEmpty: true }
    ],
    schema: z.object({
      name: z.string().trim().min(1, 'Category name is required'),
      code: stringOptional,
      description: stringOptional,
      color: stringOptional,
      status: stringOptional
    }).passthrough()
  },
  Ingredient: {
    defaults: { is_active: true, allergens: [], source_name: DEFAULT_SOURCE_NAME },
    unique: [
      { fields: ['name'], label: 'ingredient name' },
      { fields: ['item_code'], label: 'item code', ignoreEmpty: true },
      { fields: ['ingredient_code'], label: 'ingredient code', ignoreEmpty: true },
      { fields: ['sku'], label: 'ingredient SKU', ignoreEmpty: true },
      { fields: ['d365_item_id'], label: 'D365 item ID', ignoreEmpty: true }
    ],
    schema: z.object({
      name: z.string().trim().min(1, 'Ingredient name is required'),
      sku: stringOptional,
      ingredient_code: stringOptional,
      item_code: stringOptional,
      d365_item_id: stringOptional,
      unit: stringOptional,
      conversion_unit: stringOptional,
      conversion_factor: numberOptional,
      category: stringOptional,
      cuisine_type: stringOptional,
      alias: stringOptional,
      aliases: arrayOptional,
      alternative_name: stringOptional,
      alternative_names: arrayOptional,
      supplier_item_name: stringOptional,
      supplier_item_names: arrayOptional,
      source_name: sourceNameOptional,
      cost_per_unit: numberOptional,
      supplier: stringOptional,
      package_pack_count: numberOptional,
      package_inner_count: numberOptional,
      package_size_quantity: numberOptional,
      package_size_unit: stringOptional,
      package_base_quantity: numberOptional,
      package_base_unit: stringOptional,
      package_parse_source: stringOptional,
      calories_per_100g: numberOptional,
      protein_per_100g: numberOptional,
      carbs_per_100g: numberOptional,
      fat_per_100g: numberOptional,
      fiber_per_100g: numberOptional,
      sodium_per_100g: numberOptional,
      sugar_per_100g: numberOptional,
      cooking_yield_percent: numberOptional,
      shrinkage_percent: numberOptional,
      raw_weight_per_unit: numberOptional,
      cooked_weight_per_unit: numberOptional,
      is_active: booleanOptional,
      allergens: arrayOptional
    }).passthrough()
  },
  Inventory: {
    defaults: {
      quantity: 0,
      available_quantity: 0,
      reserved_quantity: 0,
      on_hand_quantity: 0,
      source_name: DEFAULT_SOURCE_NAME,
      status: 'in_stock'
    },
    unique: [
      { fields: ['site_id', 'ingredient_id'], label: 'inventory item for this location' }
    ],
    schema: z.object({
      min_stock_level: z.coerce.number().min(0, 'Minimum stock level must be zero or greater').optional().nullable(),
      max_stock_level: z.coerce.number().min(0, 'Maximum stock level must be zero or greater').optional().nullable(),
      reorder_level: z.coerce.number().min(0, 'Reorder level must be zero or greater').optional().nullable(),
      source_name: sourceNameOptional,
      valuation_method: z.enum(['fifo', 'weighted_average']).optional().nullable()
    }).passthrough().superRefine((record, context) => {
      const min = record.min_stock_level == null ? 0 : Number(record.min_stock_level);
      const max = record.max_stock_level == null ? null : Number(record.max_stock_level);
      if (max !== null && max > 0 && min > max) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['min_stock_level'],
          message: 'Minimum stock level cannot exceed the maximum stock level'
        });
      }
    })
  },
  InventoryLot: {
    defaults: { remaining_quantity: 0, reserved_quantity: 0, status: 'active' }
  },
  InventoryTransaction: {
    defaults: { status: 'posted' }
  },
  MaterialRequest: {
    defaults: { status: 'pending_procurement_ack', source_type: 'manual' }
  },
  MenuPlan: {
    defaults: { status: 'draft', meals: [], cuisine_type: 'general', menu_category: 'senior' },
    schema: z.object({
      site_id: stringOptional,
      site_name: stringOptional,
      plan_date: z.string().trim().min(1, 'Plan date is required'),
      cuisine_type: menuCuisineOptional,
      menu_category: menuCategoryOptional,
      status: stringOptional,
      event_name: stringOptional,
      event_date: stringOptional,
      expected_participants: numberOptional,
      estimated_cost: numberOptional,
      submitted_by: stringOptional,
      submitted_by_name: stringOptional,
      submitted_at: stringOptional,
      approved_by: stringOptional,
      approved_by_name: stringOptional,
      approved_at: stringOptional,
      rejected_by: stringOptional,
      rejected_by_name: stringOptional,
      rejected_at: stringOptional,
      rejection_reason: stringOptional,
      approval_notes: stringOptional,
      approval_history: z.array(z.object({
        action: z.string().trim().min(1, 'Action is required'),
        from_status: stringOptional,
        to_status: stringOptional,
        actor_email: stringOptional,
        actor_name: stringOptional,
        note: stringOptional,
        timestamp: stringOptional
      }).passthrough()).optional().nullable(),
      budget_source: stringOptional,
      budget_id: stringOptional,
      budget_name: stringOptional,
      manual_budget_name: stringOptional,
      budget_amount: numberOptional,
      meal_budget_limits: objectOptional,
      meals: z.array(z.object({
        meal_type: z.string().trim().min(1, 'Meal type is required'),
        recipe_id: stringOptional,
        recipe_name: stringOptional,
        expected_servings: numberOptional,
        cost_per_serving: numberOptional,
        total_cost: numberOptional,
        calories_per_serving: numberOptional,
        protein_per_serving: numberOptional,
        carbs_per_serving: numberOptional,
        fat_per_serving: numberOptional,
        sodium_per_serving: numberOptional,
        sugar_per_serving: numberOptional,
        allergens: arrayOptional
      }).passthrough()).optional().nullable(),
      total_expected_servings: numberOptional,
      total_calories: numberOptional,
      total_planned_cost: numberOptional,
      remaining_budget: numberOptional,
      exceeded_budget_by: numberOptional
    }).passthrough()
  },
  MenuPlanPRSchedule: {
    defaults: {
      is_active: true,
      cycle_days: 7,
      preferred_weekday: 'thursday'
    },
    unique: [
      { fields: ['site_id'], label: 'menu planning PR schedule for this project' }
    ],
    schema: z.object({
      site_id: z.string().trim().min(1, 'Project is required'),
      site_name: z.string().trim().min(1, 'Project name is required'),
      is_active: booleanOptional,
      cycle_days: z.coerce.number().int().min(1, 'Cycle days must be at least 1'),
      preferred_weekday: z.string().trim().min(1, 'Preferred weekday is required'),
      notes: stringOptional
    }).passthrough()
  },
  MenuPlanPRRun: {
    defaults: {
      status: 'pending',
      trigger_type: 'manual',
      generated_item_count: 0,
      total_estimated_cost: 0
    },
    unique: [
      { fields: ['generated_pr_id'], label: 'generated purchase request', ignoreEmpty: true }
    ],
    schema: z.object({
      site_id: z.string().trim().min(1, 'Project is required'),
      site_name: z.string().trim().min(1, 'Project name is required'),
      cycle_start: z.string().trim().min(1, 'Cycle start is required'),
      cycle_end: z.string().trim().min(1, 'Cycle end is required'),
      preferred_run_date: stringOptional,
      requested_run_date: stringOptional,
      cycle_days: z.coerce.number().int().min(1, 'Cycle days must be at least 1'),
      preferred_weekday: stringOptional,
      status: stringOptional,
      trigger_type: stringOptional,
      generated_pr_id: stringOptional,
      generated_pr_number: stringOptional,
      generated_request_id: stringOptional,
      generated_request_number: stringOptional,
      generated_item_count: numberOptional,
      total_estimated_cost: numberOptional,
      notes: stringOptional,
      missing_recipe_ids: arrayOptional,
      missing_ingredient_ids: arrayOptional
    }).passthrough()
  },
  Production: {
    defaults: { status: 'planned' },
    unique: [
      {
        fields: ['source_event_id', 'source_event_recipe_id'],
        label: 'production plan for this event recipe',
        ignoreEmpty: true
      }
    ]
  },
  ProductionConsumptionReport: {
    defaults: { status: 'posted', sections: [], ingredient_lines: [] },
    unique: [
      { fields: ['production_id'], label: 'consumption report for this production' },
      { fields: ['report_number'], label: 'production consumption report number' }
    ],
    schema: z.object({
      report_number: z.string().trim().min(1, 'Report number is required'),
      report_name: z.string().trim().min(1, 'Report name is required'),
      production_id: z.string().trim().min(1, 'Production is required'),
      production_name: stringOptional,
      production_date: stringOptional,
      site_id: stringOptional,
      site_name: stringOptional,
      recipe_id: stringOptional,
      recipe_name: stringOptional,
      meal_type: stringOptional,
      kitchen_station: stringOptional,
      target_servings: numberOptional,
      completed_by: stringOptional,
      completed_by_name: stringOptional,
      completed_at: stringOptional,
      quantity_basis: stringOptional,
      total_consumption_cost: numberOptional,
      total_shortage_cost: numberOptional,
      shortage_line_count: numberOptional,
      ingredient_line_count: numberOptional,
      ingredient_lines: arrayOptional,
      sections: arrayOptional,
      status: stringOptional
    }).passthrough()
  },
  ProductionBatch: {
    defaults: { status: 'planned' }
  },
  ProductionTransfer: {
    defaults: { status: 'draft' }
  },
  PurchaseOrder: {
    defaults: { status: 'draft' }
  },
  QRCode: {
    defaults: { status: 'active' },
    unique: [
      { fields: ['token'], label: 'QR code token', ignoreEmpty: true }
    ]
  },
  RoleProfile: {
    defaults: { is_active: true, is_system: false, access_level: 'user', permissions: [] },
    unique: [
      { fields: ['role_key'], label: 'role key', ignoreEmpty: true },
      { fields: ['name'], label: 'role name' }
    ],
    schema: z.object({
      role_key: z.string().trim().min(1, 'Role key is required'),
      name: z.string().trim().min(1, 'Role name is required'),
      description: stringOptional,
      access_level: z.enum(['admin', 'manager', 'user']).optional().nullable(),
      permissions: arrayOptional,
      dashboard_variant: stringOptional,
      is_active: booleanOptional,
      is_system: booleanOptional
    }).passthrough().transform((profile) => normalizeManagementRoleProfile(profile))
  },
  QRDelivery: {
    defaults: { status: 'pending' }
  },
  QualityControl: {
    defaults: { status: 'pending' }
  },
  Recipe: {
    defaults: { is_active: true, ingredients: [], sub_recipes: [], costing_method: 'average_cost', batch_yield: 1 },
    unique: [
      { fields: ['name'], label: 'recipe name' },
      { fields: ['recipe_code'], label: 'recipe code', ignoreEmpty: true }
    ],
    schema: z.object({
      name: z.string().trim().min(1, 'Recipe name is required'),
      description: stringOptional,
      cuisine_type: stringOptional,
      category: stringOptional,
      servings: numberOptional,
      portion_size_grams: numberOptional,
      batch_yield: numberOptional,
      costing_method: z.enum(['average_cost', 'last_cost', 'standard_cost']).optional().nullable(),
      target_selling_price: numberOptional,
      ingredients: arrayOptional,
      sub_recipes: arrayOptional,
      instructions: stringOptional,
      prep_time_minutes: numberOptional,
      cook_time_minutes: numberOptional,
      calories_per_serving: numberOptional,
      protein_per_serving: numberOptional,
      carbs_per_serving: numberOptional,
      fat_per_serving: numberOptional,
      sodium_per_serving: numberOptional,
      sugar_per_serving: numberOptional,
      total_calories: numberOptional,
      total_protein: numberOptional,
      total_carbs: numberOptional,
      total_fat: numberOptional,
      total_sodium: numberOptional,
      total_sugar: numberOptional,
      total_cost: numberOptional,
      cost_per_serving: numberOptional,
      cost_per_100g: numberOptional,
      total_recipe_weight_grams: numberOptional,
      margin_per_serving: numberOptional,
      food_cost_percent: numberOptional,
      costing_updated_at: stringOptional,
      allergens: arrayOptional,
      is_active: booleanOptional,
      site_scope: stringOptional,
      site_ids: arrayOptional,
      site_names: arrayOptional,
      image_url: stringOptional
    }).passthrough()
  },
  RFQ: {
    defaults: { status: 'draft' }
  },
  Site: {
    defaults: { is_active: true, type: 'area', hierarchy_level: 'area' },
    unique: [
      { fields: ['name'], label: 'project name' },
      { fields: ['project_code'], label: 'project code', ignoreEmpty: true },
      { fields: ['d365_warehouse_id'], label: 'D365 warehouse ID', ignoreEmpty: true }
    ],
    schema: z.object({
      name: z.string().trim().min(1, 'Site name is required'),
      project_code: stringOptional,
      d365_warehouse_id: stringOptional,
      type: z.enum(SUPPORTED_SITE_TYPES).optional().nullable(),
      hierarchy_level: stringOptional,
      parent_site_id: stringOptional,
      parent_site_name: stringOptional,
      hierarchy_path: stringOptional,
      company_name: stringOptional,
      region_name: stringOptional,
      location_name: stringOptional,
      kitchen_name: stringOptional,
      storage_name: stringOptional,
      area_name: stringOptional,
      project_name: stringOptional,
      store_name: stringOptional,
      address: stringOptional,
      city: stringOptional,
      country: stringOptional,
      capacity: numberOptional,
      contact_person: stringOptional,
      contact_phone: stringOptional,
      contact_email: stringOptional,
      is_active: booleanOptional
    }).passthrough()
  },
  Supplier: {
    defaults: { status: 'active' }
  },
  User: {
    defaults: { role: 'user', status: 'active' },
    unique: [
      { fields: ['email'], label: 'user email' }
    ],
    schema: z.object({
      email: z.string().trim().email('A valid email address is required'),
      full_name: stringOptional,
      role: stringOptional,
      status: stringOptional,
      site_id: stringOptional,
      site_name: stringOptional,
      allowed_site_ids: arrayOptional,
      allowed_site_names: arrayOptional,
      visibility_scope: stringOptional,
      role_access_level: stringOptional,
      role_permissions: arrayOptional,
      is_custom_role: booleanOptional,
      password: stringOptional,
      temporary_password: stringOptional,
      phone: stringOptional,
      language: stringOptional,
      avatar_url: stringOptional
    }).passthrough()
  },
  UserGroup: {
    defaults: { total_members: 0, members: [] },
    unique: [
      { fields: ['name'], label: 'group name' }
    ]
  },
  WasteTarget: {
    defaults: { target_percentage: 0, target_cost: 0, status: 'active' }
  },
  WasteDetectionLog: {
    defaults: { detection_method: 'camera' }
  }
};

export const knownEntities = new Set([
  ...Object.keys(entityRegistry),
  'EmailLog',
  'AppLog'
]);

const roleRank = { user: 1, manager: 2, admin: 3 };

const readRoles = {
  User: 'manager',
  FoodCategory: 'manager'
};

const writeRoles = {
  Site: 'admin',
  RoleProfile: 'admin',
  AdvancedReportSchedule: 'manager',
  ERPIntegrationConfig: 'admin',
  ERPIntegrationLog: 'manager',
  ForecastScenario: 'manager',
  ForecastSnapshot: 'manager',
  User: 'admin',
  UserGroup: 'manager',
  Production: 'manager',
  ProductionConsumptionReport: 'manager',
  ProducedItemBatch: 'manager',
  MealServiceAttendance: 'manager',
  MealServiceConsumption: 'manager',
  ProductionBatch: 'manager',
  ProductionTransfer: 'manager',
  Inventory: 'manager',
  InventoryTransaction: 'manager',
  Ingredient: 'manager',
  FoodCategory: 'manager',
  Recipe: 'manager',
  MenuPlan: 'manager',
  MenuPlanPRSchedule: 'manager',
  MenuPlanPRRun: 'manager',
  MaterialRequest: 'manager',
  Supplier: 'manager',
  PurchaseOrder: 'manager',
  RFQ: 'manager',
  FoodWaste: 'manager',
  QualityControl: 'manager',
  WasteDetectionLog: 'manager',
  WasteTarget: 'manager',
  QRCode: 'manager',
  QRDelivery: 'manager',
  BranchOrder: 'manager',
  CustomerMealPlan: 'manager',
  D365Master: 'manager',
  CategoryQRSession: 'manager',
  AttendanceSession: 'manager',
  StaffShift: 'manager',
  InventoryLot: 'manager'
};

const entityPermissions = {
  Site: { write: 'manage_projects' },
  RoleProfile: { read: 'manage_roles', write: 'manage_roles' },
  User: { read: 'manage_users', write: 'manage_users' },
  Ingredient: { read: ['view_ingredients', 'manage_ingredients'], write: 'manage_ingredients' },
  FoodCategory: { read: 'manage_food_categories', write: 'manage_food_categories' },
  Budget: { read: ['view_budget', 'manage_budget', 'manage_menu_planning'], write: 'manage_budget' },
  Inventory: { read: ['view_inventory', 'manage_inventory'], write: 'manage_inventory' },
  InventoryTransaction: { read: ['view_inventory', 'manage_inventory'], write: 'manage_inventory' },
  InventoryLot: { read: ['view_inventory', 'manage_inventory'], write: 'manage_inventory' },
  Recipe: { read: ['view_recipes', 'manage_recipes'], write: 'manage_recipes' },
  MenuPlan: { read: 'manage_menu_planning', write: 'manage_menu_planning' },
  MenuPlanPRSchedule: { read: 'manage_menu_planning', write: 'manage_menu_planning' },
  MenuPlanPRRun: { read: 'generate_menu_plan_pr', write: 'generate_menu_plan_pr' },
  Production: { read: 'manage_production', write: 'manage_production' },
  ProductionConsumptionReport: { read: 'manage_production', write: 'complete_production' },
  ProducedItemBatch: { read: 'view_customer_meal_service', write: 'record_customer_meal_service' },
  MealServiceAttendance: { read: 'view_customer_meal_service', write: 'record_customer_meal_service' },
  MealServiceConsumption: { read: 'view_customer_meal_service', write: 'record_customer_meal_service' },
  ProductionBatch: { read: 'manage_production', write: 'manage_production' },
  ProductionTransfer: { read: 'transfer_inventory', write: 'transfer_inventory' },
  MaterialRequest: {
    read: ['view_material_request', 'acknowledge_material_request', 'manage_procurement', 'approve_procurement'],
    write: 'manage_procurement'
  },
  Supplier: { read: 'manage_suppliers', write: 'manage_suppliers' },
  PurchaseOrder: { read: 'manage_procurement', write: 'manage_procurement' },
  RFQ: { read: 'manage_procurement', write: 'manage_procurement' },
  FoodWaste: { read: 'manage_waste', write: 'manage_waste' },
  WasteTarget: { read: 'manage_waste', write: 'manage_waste' },
  WasteDetectionLog: { read: 'manage_waste', write: 'manage_waste' },
  QualityControl: { read: 'manage_quality', write: 'manage_quality' },
  CustomerMealPlan: {
    read: ['manage_menu_planning', 'view_customer_meal_service', 'record_customer_meal_service'],
    write: 'manage_menu_planning'
  },
  AttendanceSession: { read: 'manage_attendance', write: 'manage_attendance' },
  AttendanceRecord: { read: 'manage_attendance', write: 'manage_attendance' },
  StaffShift: { read: 'manage_attendance', write: 'manage_attendance' },
  AdvancedReportSchedule: { read: 'view_reports', write: 'view_reports' },
  ERPIntegrationConfig: { read: 'manage_erp', write: 'manage_erp' },
  ERPIntegrationLog: { read: 'manage_erp', write: 'manage_erp' },
  D365Master: { read: 'manage_erp', write: 'manage_erp' },
  ForecastScenario: { read: 'manage_forecasting', write: 'manage_forecasting' },
  ForecastSnapshot: { read: 'manage_forecasting', write: 'manage_forecasting' }
};

const selfWritableFields = new Set(['full_name', 'phone', 'language', 'avatar_url']);

export function ensureKnownEntity(entity) {
  if (!knownEntities.has(entity)) {
    const error = new Error(`Unknown entity: ${entity}`);
    error.status = 404;
    throw error;
  }
}

export function validateEntityPayload(entity, payload = {}) {
  ensureKnownEntity(entity);
  const config = entityRegistry[entity];
  if (!config?.schema) {
    return { ...(config?.defaults || {}), ...payload };
  }

  const result = config.schema.safeParse(payload);
  if (!result.success) {
    const error = new Error(result.error.issues[0]?.message || 'Invalid payload');
    error.status = 400;
    throw error;
  }

  return { ...(config.defaults || {}), ...result.data };
}

export function sanitizeErpIntegrationConfig(record = {}, user = null) {
  if (hasAdminAccess(user)) return { ...record };
  const {
    api_endpoint: apiEndpoint,
    api_key: apiKey,
    ...operationalConfig
  } = record || {};
  return {
    ...operationalConfig,
    api_endpoint_configured: Boolean(String(apiEndpoint || '').trim()),
    api_key_configured: Boolean(String(apiKey || '').trim())
  };
}

export function authorizeEntityAction(user, entity, action, payload = null, resource = null) {
  ensureKnownEntity(entity);
  const role = user?.role || 'user';
  const effectiveRole = getUserEffectiveRole(user);
  const currentRank = roleRank[effectiveRole] || 0;
  const isCustomRole = Boolean(user?.is_custom_role);
  const requiresReadRole = readRoles[entity];
  const requiresWriteRole = writeRoles[entity];
  const permissionRequirements = entityPermissions[entity] || {};
  const hasRequiredPermission = (requirement) => (
    Array.isArray(requirement)
      ? requirement.some((permission) => hasPermission(user, permission))
      : Boolean(requirement && hasPermission(user, requirement))
  );

  if (entity === 'FoodWaste' && ['create', 'update', 'delete'].includes(action)) {
    const reservedFields = [
      'auto_generated',
      'output_allocations',
      'meal_service_attendance_id',
      'service_reference'
    ];
    const attemptsReservedWrite = ['create', 'update'].includes(action) && (
      reservedFields.some((field) => Object.prototype.hasOwnProperty.call(payload || {}, field))
      || String(payload?.source_type || '').trim().toLowerCase() === 'meal_service_leftover'
    );
    if (attemptsReservedWrite) {
      const error = new Error('Meal-service leftover fields are server-managed and cannot be supplied through Food Waste APIs');
      error.status = 409;
      throw error;
    }
    const protectedLeftover = resource?.auto_generated === true
      || String(resource?.source_type || '').trim().toLowerCase() === 'meal_service_leftover'
      || Boolean(String(resource?.meal_service_attendance_id || '').trim());
    if (protectedLeftover && ['update', 'delete'].includes(action)) {
      const error = new Error('Automatic meal-service leftover waste can only be changed by the protected meal-service reversal');
      error.status = 409;
      throw error;
    }
  }

  if (
    ['D365Master', 'ERPIntegrationLog'].includes(entity)
    && ['list', 'filter', 'read'].includes(action)
  ) {
    const error = new Error(entity === 'ERPIntegrationLog'
      ? 'Integration logs must be read through the protected scoped ERP log endpoints'
      : 'D365 processing markers are internal and cannot be read through generic APIs');
    error.status = 409;
    throw error;
  }

  if (
    entity === 'ERPIntegrationConfig'
    && ['create', 'update', 'delete'].includes(action)
    && !hasAdminAccess(user)
  ) {
    const error = new Error('Only administrators can change ERP integration configuration');
    error.status = 403;
    throw error;
  }

  if (entity === 'Site' && ['create', 'update', 'delete'].includes(action)) {
    return assertCanManageSiteStructure(user);
  }

  if (entity === 'User' && action === 'delete') {
    const error = new Error('User accounts must be deactivated from User & Role Management so access and audit history are preserved');
    error.status = 409;
    throw error;
  }

  if (
    ['InventoryLot', 'InventoryTransaction', 'D365Master', 'ERPIntegrationLog'].includes(entity)
    && ['create', 'update', 'delete'].includes(action)
  ) {
    const error = new Error(`${entity} records are immutable through generic APIs and must be posted by their protected service`);
    error.status = 409;
    throw error;
  }

  if (
    ['ProducedItemBatch', 'MealServiceAttendance', 'MealServiceConsumption'].includes(entity)
    && ['create', 'update', 'delete'].includes(action)
  ) {
    const error = new Error(`${entity} records are protected meal-service records and must be changed through the transactional meal-service workflow`);
    error.status = 409;
    throw error;
  }

  if (entity === 'Inventory' && ['create', 'delete'].includes(action)) {
    const error = new Error('Inventory balances must be created or removed through auditable stock movements');
    error.status = 409;
    throw error;
  }

  if (entity === 'Inventory' && action === 'update') {
    const inventorySettings = new Set([
      'min_stock_level',
      'max_stock_level',
      'reorder_level',
      'valuation_method',
      'notes'
    ]);
    const protectedFields = Object.keys(payload || {}).filter((field) => !inventorySettings.has(field));
    if (protectedFields.length > 0) {
      const error = new Error('Inventory quantities, costs, batches, and expiry dates must be changed through an auditable stock movement');
      error.status = 409;
      throw error;
    }
  }

  if (
    entity === 'User'
    && action === 'update'
    && Object.prototype.hasOwnProperty.call(payload || {}, 'status')
    && String(payload.status || '').trim().toLowerCase() !== String(resource?.status || 'active').trim().toLowerCase()
  ) {
    const error = new Error('User account status can only be changed through the protected deactivation workflow');
    error.status = 409;
    throw error;
  }

  if (entity === 'ProductionConsumptionReport' && ['create', 'update', 'delete'].includes(action)) {
    const error = new Error('Production consumption reports are immutable and are generated only by completing production');
    error.status = 409;
    throw error;
  }

  if (entity === 'MaterialRequest') {
    const isProductionGenerated = String(payload?.source_type || resource?.source_type || '').toLowerCase() === 'production'
      || Boolean(payload?.source_production_id || resource?.source_production_id);
    if (isProductionGenerated && ['create', 'update', 'delete'].includes(action)) {
      const error = new Error('Production material requests are managed only by the production and procurement workflow');
      error.status = 409;
      throw error;
    }
  }

  if (entity === 'Production') {
    const nextStatus = normalizeProductionStatus(payload?.status);
    const currentStatus = normalizeProductionStatus(resource?.status, 'draft');

    if (action === 'delete') {
      const error = new Error('Production records cannot be deleted because their workflow and inventory audit history must be preserved');
      error.status = 409;
      throw error;
    }

    if (action === 'create') {
      if (nextStatus === 'pending_approval') {
        if (!hasPermission(user, 'create_production_request') || !hasPermission(user, 'submit_production_request')) {
          const error = new Error('You do not have permission to submit production requests');
          error.status = 403;
          throw error;
        }
        return true;
      }

      if (['draft', 'planned'].includes(nextStatus) || !nextStatus) {
        if (!hasPermission(user, 'create_production_request')) {
          const error = new Error('You do not have permission to create production requests');
          error.status = 403;
          throw error;
        }
        return true;
      }

      const error = new Error('New production requests must start as Production Created or Pending PM Approval');
      error.status = 409;
      throw error;
    }

    if (action === 'update') {
      if (currentStatus === 'completed') {
        const error = new Error('Completed production and its consumption record are immutable');
        error.status = 409;
        throw error;
      }

      if (nextStatus && nextStatus !== currentStatus) {
        if (nextStatus === 'cancelled') {
          const error = new Error('Use the protected production cancellation action so committed inventory and the linked material request are returned together');
          error.status = 409;
          throw error;
        }
        const reviewAction = String(payload?.review_action || '').trim().toLowerCase();
        const transitionFieldAllowlist = new Set([
          'status', 'review_action', 'review_notes', 'rejection_reason', 'reviewed_at',
          'pm_approval_status', 'pm_approved_by', 'pm_approved_by_name', 'pm_approved_at',
          'area_approval_status', 'area_approved_by', 'area_approved_by_name', 'area_approved_at',
          'submitted_by', 'submitted_by_name', 'submitted_at',
          'started_by', 'started_by_name', 'started_at',
          'fulfillment_store_id', 'fulfillment_store_name'
        ]);
        const contentFields = Object.keys(payload || {}).filter((field) => !transitionFieldAllowlist.has(field));
        if (contentFields.length > 0) {
          const error = new Error('Production content and workflow status must be updated separately');
          error.status = 409;
          throw error;
        }

        if (!isAllowedProductionTransition(currentStatus, nextStatus)) {
          const error = new Error(`Invalid production workflow transition: ${currentStatus} → ${nextStatus}`);
          error.status = 409;
          throw error;
        }

        if (nextStatus === 'rejected') {
          const error = new Error('Rejected production requests must return to an actionable previous stage');
          error.status = 409;
          throw error;
        }

        if (
          currentStatus === 'pending_approval'
          && nextStatus === 'changes_requested'
          && !['changes_requested', 'rejected'].includes(reviewAction)
        ) {
          const error = new Error('Select Request Changes or Reject when returning a PM review');
          error.status = 400;
          throw error;
        }

        if (
          ['pending_production', 'approved'].includes(currentStatus)
          && nextStatus === 'pending_procurement'
          && reviewAction !== 'rejected'
        ) {
          const error = new Error('Only an Area Manager rejection can return production to Store / Procurement');
          error.status = 400;
          throw error;
        }

        if (
          currentStatus === 'approved'
          && nextStatus === 'pending_procurement'
          && !requiresAreaProductionApproval(resource)
        ) {
          const error = new Error('A production that is already Area-approved cannot be returned through the pending approval action');
          error.status = 409;
          throw error;
        }

        if (nextStatus === 'pending_production') {
          const error = new Error('Pending Production is set only after Store Keeper / Procurement acknowledgement');
          error.status = 409;
          throw error;
        }

        if (currentStatus === 'pending_production' && nextStatus === 'approved') {
          const error = new Error('Use the Area Manager approval action so procurement and fulfillment Store checks are enforced');
          error.status = 409;
          throw error;
        }

        if (
          ['changes_requested', 'rejected'].includes(reviewAction)
          && !String(payload?.rejection_reason || payload?.review_notes || '').trim()
        ) {
          const error = new Error('A reason is required when requesting changes or rejecting production');
          error.status = 400;
          throw error;
        }

        if (nextStatus === 'completed') {
          const error = new Error('Use the production completion action so inventory and the consumption report are posted together');
          error.status = 409;
          throw error;
        }

        const requiredPermission = getProductionTransitionPermission(currentStatus, nextStatus, { reviewAction });
        if (requiredPermission && !hasPermission(user, requiredPermission)) {
          const error = new Error('You do not have permission to update this production status');
          error.status = 403;
          throw error;
        }

        if (
          currentStatus === 'pending_approval'
          && ['pending_procurement', 'rejected', 'changes_requested'].includes(nextStatus)
          && !hasPermission(user, 'review_production_request')
        ) {
          const error = new Error('You do not have permission to review production requests');
          error.status = 403;
          throw error;
        }

        if (nextStatus === 'in_progress' && !canStartApprovedProduction(resource)) {
          const error = new Error('Production cannot start until procurement is acknowledged and the Area Manager has approved it');
          error.status = 409;
          throw error;
        }
      } else if (!['draft', 'planned', 'changes_requested'].includes(currentStatus) || !hasPermission(user, 'edit_production_request')) {
        const error = new Error('You do not have permission to edit production requests');
        error.status = 403;
        throw error;
      }
      return true;
    }
  }

  if (action === 'list' || action === 'filter' || action === 'read') {
    if (permissionRequirements.read) {
      if (hasRequiredPermission(permissionRequirements.read)) return true;
      const error = new Error('You do not have permission to view this resource');
      error.status = 403;
      throw error;
    }
    if (!requiresReadRole) {
      return true;
    }
    if (currentRank >= roleRank[requiresReadRole]) {
      return true;
    }
    if (entity === 'User' && resource?.id === user.id) {
      return true;
    }
    const error = new Error('You do not have permission to view this resource');
    error.status = 403;
    throw error;
  }

  if (action === 'update' && entity === 'User' && resource?.id === user.id) {
    const invalidFields = Object.keys(payload || {}).filter((field) => !selfWritableFields.has(field));
    if (invalidFields.length === 0) {
      return true;
    }
  }

  if (permissionRequirements.write && hasRequiredPermission(permissionRequirements.write)) {
    return true;
  }

  if (isCustomRole && permissionRequirements.write) {
    if (action === 'create' && (entity === 'AttendanceRecord' || entity === 'DinerScan')) {
      return true;
    }
    const error = new Error('You do not have permission to modify this resource');
    error.status = 403;
    throw error;
  }

  if (!requiresWriteRole || currentRank >= roleRank[requiresWriteRole]) {
    return true;
  }

  if (action === 'create' && (entity === 'AttendanceRecord' || entity === 'DinerScan')) {
    return true;
  }

  const error = new Error('You do not have permission to modify this resource');
  error.status = 403;
  throw error;
}
