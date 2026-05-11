import { z } from 'zod';

const stringOptional = z.string().trim().optional().nullable();
const numberOptional = z.coerce.number().optional().nullable();
const booleanOptional = z.coerce.boolean().optional().nullable();
const arrayOptional = z.array(z.any()).optional().nullable();
const objectOptional = z.record(z.any()).optional().nullable();

export const permissionCatalog = [
  { key: 'view_dashboard', label: 'View Dashboard' },
  { key: 'view_reports', label: 'View Reports' },
  { key: 'export_data', label: 'Export Data' },
  { key: 'manage_projects', label: 'Manage Projects' },
  { key: 'manage_ingredients', label: 'Manage Ingredients' },
  { key: 'manage_inventory', label: 'Manage Inventory' },
  { key: 'transfer_inventory', label: 'Transfer Inventory' },
  { key: 'manage_recipes', label: 'Manage Recipes' },
  { key: 'manage_menu_planning', label: 'Manage Menu Planning' },
  { key: 'manage_production', label: 'Manage Production Plans' },
  { key: 'create_production_request', label: 'Create Production Request' },
  { key: 'edit_production_request', label: 'Edit Production Request' },
  { key: 'submit_production_request', label: 'Submit Production Request' },
  { key: 'review_production_request', label: 'Review Production Request' },
  { key: 'approve_production_request', label: 'Approve Production Request' },
  { key: 'reject_production_request', label: 'Reject Production Request' },
  { key: 'request_changes_production', label: 'Request Changes On Production Request' },
  { key: 'approve_production', label: 'Approve Production' },
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
      'view_dashboard', 'view_reports', 'export_data', 'manage_projects',
      'manage_ingredients', 'manage_inventory', 'transfer_inventory', 'manage_recipes',
      'manage_menu_planning', 'manage_production', 'create_production_request', 'edit_production_request',
      'submit_production_request', 'review_production_request', 'approve_production_request',
      'reject_production_request', 'request_changes_production', 'approve_production', 'start_production',
      'complete_production', 'create_material_request', 'view_material_request',
      'acknowledge_material_request', 'manage_procurement', 'approve_procurement', 'manage_suppliers', 'manage_waste',
      'approve_waste', 'manage_pos', 'manage_forecasting', 'manage_attendance',
      'approve_attendance', 'manage_quality'
    ]
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
      'view_dashboard', 'view_reports', 'manage_ingredients', 'manage_recipes',
      'manage_menu_planning', 'manage_production', 'create_production_request',
      'edit_production_request', 'submit_production_request', 'start_production',
      'complete_production', 'create_material_request', 'view_material_request',
      'manage_waste', 'approve_waste', 'manage_quality'
    ]
  },
  project_manager: {
    role_key: 'project_manager',
    name: 'Project Manager',
    access_level: 'manager',
    description: 'Reviews production requests for assigned projects and controls operational approvals.',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data', 'manage_projects',
      'manage_inventory', 'manage_menu_planning', 'manage_production',
      'review_production_request', 'approve_production_request', 'reject_production_request',
      'request_changes_production', 'approve_production', 'view_material_request',
      'manage_waste', 'approve_waste'
    ]
  },
  storekeeper: {
    role_key: 'storekeeper',
    name: 'Storekeeper',
    access_level: 'manager',
    description: 'Warehouse and stock control role for receiving, adjustments, and transfers.',
    permissions: [
      'view_dashboard', 'view_reports', 'export_data', 'manage_inventory',
      'transfer_inventory', 'manage_ingredients'
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
      'view_dashboard', 'view_reports', 'manage_production',
      'review_production_request', 'approve_production_request', 'reject_production_request',
      'request_changes_production', 'approve_production', 'start_production',
      'complete_production', 'view_material_request', 'manage_menu_planning',
      'manage_quality', 'manage_waste'
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

export function getUserEffectiveRole(user) {
  const role = user?.role_access_level || user?.role || 'user';
  return ['admin', 'manager', 'user'].includes(role) ? role : 'user';
}

export function getUserPermissions(user) {
  const effectiveRole = getUserEffectiveRole(user);
  const builtInFromCurrentRole = getSystemRoleDefinition(user?.role);
  const builtInFromAccessLevel = getSystemRoleDefinition(effectiveRole);
  return Array.from(new Set([
    ...(builtInFromAccessLevel?.permissions || []),
    ...(builtInFromCurrentRole?.permissions || []),
    ...((Array.isArray(user?.role_permissions) ? user.role_permissions : []).filter(Boolean))
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
  FoodWaste: {
    defaults: {
      status: 'logged',
      approval_status: 'approved',
      waste_scope: 'ingredient',
      avoidable_type: 'avoidable',
      estimated_cost: 0
    }
  },
  Ingredient: {
    defaults: { is_active: true, allergens: [] },
    unique: [
      { fields: ['name'], label: 'ingredient name' },
      { fields: ['ingredient_code'], label: 'ingredient code', ignoreEmpty: true },
      { fields: ['sku'], label: 'ingredient SKU', ignoreEmpty: true }
    ],
    schema: z.object({
      name: z.string().trim().min(1, 'Ingredient name is required'),
      unit: stringOptional,
      category: stringOptional,
      cuisine_type: stringOptional,
      cost_per_unit: numberOptional,
      calories_per_100g: numberOptional,
      protein_per_100g: numberOptional,
      carbs_per_100g: numberOptional,
      fat_per_100g: numberOptional,
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
    defaults: { quantity: 0, status: 'in_stock' },
    unique: [
      { fields: ['site_id', 'ingredient_id'], label: 'inventory item for this location' }
    ]
  },
  InventoryLot: {
    defaults: { remaining_quantity: 0, status: 'active' }
  },
  InventoryTransaction: {
    defaults: { status: 'posted' }
  },
  MaterialRequest: {
    defaults: { status: 'pending_procurement_ack', source_type: 'manual' }
  },
  MenuPlan: {
    defaults: { status: 'draft', meals: [] },
    schema: z.object({
      site_id: stringOptional,
      site_name: stringOptional,
      plan_date: z.string().trim().min(1, 'Plan date is required'),
      status: stringOptional,
      event_name: stringOptional,
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
      total_planned_cost: numberOptional
    }).passthrough()
  },
  Production: {
    defaults: { status: 'planned' }
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
    defaults: { status: 'active' }
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
      is_active: booleanOptional,
      is_system: booleanOptional
    }).passthrough()
  },
  QRDelivery: {
    defaults: { status: 'pending' }
  },
  QualityControl: {
    defaults: { status: 'pending' }
  },
  Recipe: {
    defaults: { is_active: true, ingredients: [] },
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
      ingredients: arrayOptional,
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
      allergens: arrayOptional,
      is_active: booleanOptional,
      site_scope: stringOptional,
      site_ids: arrayOptional,
      site_names: arrayOptional
    }).passthrough()
  },
  RFQ: {
    defaults: { status: 'draft' }
  },
  Site: {
    defaults: { is_active: true, type: 'location', hierarchy_level: 'location' },
    unique: [
      { fields: ['name'], label: 'project name' },
      { fields: ['project_code'], label: 'project code', ignoreEmpty: true }
    ],
    schema: z.object({
      name: z.string().trim().min(1, 'Site name is required'),
      project_code: stringOptional,
      type: stringOptional,
      hierarchy_level: stringOptional,
      parent_site_id: stringOptional,
      parent_site_name: stringOptional,
      hierarchy_path: stringOptional,
      company_name: stringOptional,
      region_name: stringOptional,
      location_name: stringOptional,
      kitchen_name: stringOptional,
      storage_name: stringOptional,
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
  User: 'manager'
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
  ProductionBatch: 'manager',
  ProductionTransfer: 'manager',
  Inventory: 'manager',
  InventoryTransaction: 'manager',
  Ingredient: 'manager',
  Recipe: 'manager',
  MenuPlan: 'manager',
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
  Site: { read: 'manage_projects', write: 'manage_projects' },
  RoleProfile: { read: 'manage_roles', write: 'manage_roles' },
  User: { read: 'manage_users', write: 'manage_users' },
  Ingredient: { read: 'manage_ingredients', write: 'manage_ingredients' },
  Inventory: { read: 'manage_inventory', write: 'manage_inventory' },
  InventoryTransaction: { read: 'manage_inventory', write: 'manage_inventory' },
  InventoryLot: { read: 'manage_inventory', write: 'manage_inventory' },
  Recipe: { read: 'manage_recipes', write: 'manage_recipes' },
  MenuPlan: { read: 'manage_menu_planning', write: 'manage_menu_planning' },
  Production: { read: 'manage_production', write: 'manage_production' },
  ProductionBatch: { read: 'manage_production', write: 'manage_production' },
  ProductionTransfer: { read: 'transfer_inventory', write: 'transfer_inventory' },
  MaterialRequest: { read: 'manage_procurement', write: 'manage_procurement' },
  Supplier: { read: 'manage_suppliers', write: 'manage_suppliers' },
  PurchaseOrder: { read: 'manage_procurement', write: 'manage_procurement' },
  RFQ: { read: 'manage_procurement', write: 'manage_procurement' },
  FoodWaste: { read: 'manage_waste', write: 'manage_waste' },
  WasteTarget: { read: 'manage_waste', write: 'manage_waste' },
  WasteDetectionLog: { read: 'manage_waste', write: 'manage_waste' },
  QualityControl: { read: 'manage_quality', write: 'manage_quality' },
  CustomerMealPlan: { read: 'manage_menu_planning', write: 'manage_menu_planning' },
  AttendanceSession: { read: 'manage_attendance', write: 'manage_attendance' },
  AttendanceRecord: { read: 'manage_attendance', write: 'manage_attendance' },
  StaffShift: { read: 'manage_attendance', write: 'manage_attendance' },
  AdvancedReportSchedule: { read: 'view_reports', write: 'view_reports' },
  ERPIntegrationConfig: { read: 'manage_erp', write: 'manage_erp' },
  ERPIntegrationLog: { read: 'manage_erp', write: 'manage_erp' },
  ForecastScenario: { read: 'manage_forecasting', write: 'manage_forecasting' },
  ForecastSnapshot: { read: 'manage_forecasting', write: 'manage_forecasting' }
};

const selfWritableFields = new Set(['full_name', 'site_id', 'site_name', 'phone', 'language', 'avatar_url']);

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

export function authorizeEntityAction(user, entity, action, payload = null, resource = null) {
  ensureKnownEntity(entity);
  const role = user?.role || 'user';
  const effectiveRole = getUserEffectiveRole(user);
  const currentRank = roleRank[effectiveRole] || 0;
  const isCustomRole = Boolean(user?.is_custom_role);
  const requiresReadRole = readRoles[entity];
  const requiresWriteRole = writeRoles[entity];
  const permissionRequirements = entityPermissions[entity] || {};

  if (entity === 'Production') {
    const nextStatus = payload?.status;
    const currentStatus = resource?.status || null;

    if (action === 'create') {
      if (nextStatus === 'pending_approval') {
        if (!hasPermission(user, 'create_production_request') || !hasPermission(user, 'submit_production_request')) {
          const error = new Error('You do not have permission to submit production requests');
          error.status = 403;
          throw error;
        }
        return true;
      }

      if (nextStatus === 'draft' || !nextStatus) {
        if (!hasPermission(user, 'create_production_request')) {
          const error = new Error('You do not have permission to create production requests');
          error.status = 403;
          throw error;
        }
        return true;
      }
    }

    if (action === 'update') {
      if (nextStatus && nextStatus !== currentStatus) {
        const transitionPermissionMap = {
          pending_approval: 'submit_production_request',
          approved: 'approve_production_request',
          rejected: 'reject_production_request',
          changes_requested: 'request_changes_production',
          in_progress: 'start_production',
          completed: 'complete_production'
        };
        const requiredPermission = transitionPermissionMap[nextStatus];
        if (requiredPermission && !hasPermission(user, requiredPermission)) {
          const error = new Error('You do not have permission to update this production status');
          error.status = 403;
          throw error;
        }

        if (['approved', 'rejected', 'changes_requested'].includes(nextStatus) && !hasPermission(user, 'review_production_request')) {
          const error = new Error('You do not have permission to review production requests');
          error.status = 403;
          throw error;
        }
      } else if (!hasPermission(user, 'edit_production_request')) {
        const error = new Error('You do not have permission to edit production requests');
        error.status = 403;
        throw error;
      }
      return true;
    }
  }

  if (action === 'list' || action === 'filter' || action === 'read') {
    if (permissionRequirements.read && hasPermission(user, permissionRequirements.read)) {
      return true;
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
    if (isCustomRole && permissionRequirements.read) {
      const error = new Error('You do not have permission to view this resource');
      error.status = 403;
      throw error;
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

  if (permissionRequirements.write && hasPermission(user, permissionRequirements.write)) {
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
