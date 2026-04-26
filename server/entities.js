import { z } from 'zod';

const stringOptional = z.string().trim().optional().nullable();
const numberOptional = z.coerce.number().optional().nullable();
const booleanOptional = z.coerce.boolean().optional().nullable();
const arrayOptional = z.array(z.any()).optional().nullable();
const objectOptional = z.record(z.any()).optional().nullable();

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
  FoodWaste: {
    defaults: { status: 'logged' }
  },
  Ingredient: {
    defaults: { is_active: true, allergens: [] },
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
      cooking_yield_percent: numberOptional,
      shrinkage_percent: numberOptional,
      raw_weight_per_unit: numberOptional,
      cooked_weight_per_unit: numberOptional,
      is_active: booleanOptional,
      allergens: arrayOptional
    }).passthrough()
  },
  Inventory: {
    defaults: { quantity: 0, status: 'in_stock' }
  },
  InventoryLot: {
    defaults: { remaining_quantity: 0, status: 'active' }
  },
  InventoryTransaction: {
    defaults: { status: 'posted' }
  },
  MaterialRequest: {
    defaults: { status: 'pending' }
  },
  MenuPlan: {
    defaults: { status: 'planned' }
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
  QRDelivery: {
    defaults: { status: 'pending' }
  },
  QualityControl: {
    defaults: { status: 'pending' }
  },
  Recipe: {
    defaults: { is_active: true, ingredients: [] },
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
      total_calories: numberOptional,
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
    schema: z.object({
      email: z.string().trim().email('A valid email address is required'),
      full_name: stringOptional,
      role: z.enum(['admin', 'manager', 'user']).optional().nullable(),
      status: stringOptional,
      site_id: stringOptional,
      site_name: stringOptional,
      allowed_site_ids: arrayOptional,
      allowed_site_names: arrayOptional,
      visibility_scope: stringOptional,
      password: stringOptional,
      temporary_password: stringOptional,
      phone: stringOptional,
      language: stringOptional,
      avatar_url: stringOptional
    }).passthrough()
  },
  UserGroup: {
    defaults: { total_members: 0, members: [] }
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
  AdvancedReportSchedule: 'manager',
  ERPIntegrationConfig: 'admin',
  ERPIntegrationLog: 'manager',
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
  QRCode: 'manager',
  QRDelivery: 'manager',
  BranchOrder: 'manager',
  D365Master: 'manager',
  CategoryQRSession: 'manager',
  AttendanceSession: 'manager',
  StaffShift: 'manager',
  InventoryLot: 'manager'
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
  const currentRank = roleRank[role] || 0;
  const requiresReadRole = readRoles[entity];
  const requiresWriteRole = writeRoles[entity];

  if (action === 'list' || action === 'filter' || action === 'read') {
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
