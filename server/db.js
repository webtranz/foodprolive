import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client, Pool } from 'pg';
import {
  entityRegistry,
  ensureKnownEntity,
  validateEntityPayload,
  getSystemRoleDefinition as getEntitySystemRoleDefinition
} from './entities.js';
import { buildEntityListQuery } from './entityQuery.js';
import { deriveInventoryRecord } from '../shared/inventoryStatus.js';
import {
  getSystemRoleDefinition as getSharedSystemRoleDefinition,
  isManagementScopeSiteType,
  isSystemRoleKey,
  normalizeManagementRoleProfile,
  resolveManagementDashboardView
} from '../shared/managementDashboardRoles.js';
import {
  isCanonicalSiteType,
  normalizeSiteType,
  SITE_HIERARCHY_TYPES,
  validateCanonicalSiteParent,
  validateSiteChildrenForParent
} from '../shared/siteHierarchy.js';
import {
  getRoleLocationPolicy,
  isRolePrimarySiteType,
  normalizeRoleLocationFields
} from '../shared/roleLocationPolicy.js';
import {
  assertUserDeactivationAllowed,
  isActiveAdministratorAccount,
  isUserAuthenticationAllowed
} from './userDeactivation.js';

const rootDir = path.resolve(process.cwd());
const uploadsDir = path.join(rootDir, 'uploads');

await fs.mkdir(uploadsDir, { recursive: true });

const envValue = (key, fallback = '') => (process.env[key] || fallback).trim();
const envInteger = (key, fallback, minimum = 0) => {
  const parsed = Number.parseInt(process.env[key] || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
};

const connectionString = envValue('DATABASE_URL') || [
  `postgresql://${encodeURIComponent(envValue('POSTGRES_USER', 'foodpro'))}`,
  `:${encodeURIComponent(envValue('POSTGRES_PASSWORD', 'foodpro'))}`,
  `@${envValue('POSTGRES_HOST', '127.0.0.1')}`,
  `:${envValue('POSTGRES_PORT', '5432')}`,
  `/${encodeURIComponent(envValue('POSTGRES_DB', 'foodpro'))}`
].join('');

const pool = new Pool({
  connectionString,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  application_name: envValue('DB_APPLICATION_NAME', 'foodpro-api'),
  max: envInteger('DB_POOL_MAX', 20, 1),
  idleTimeoutMillis: envInteger('DB_POOL_IDLE_TIMEOUT_MS', 30000, 1000),
  connectionTimeoutMillis: envInteger('DB_POOL_CONNECTION_TIMEOUT_MS', 5000, 100),
  statement_timeout: envInteger('DB_STATEMENT_TIMEOUT_MS', 15000, 100),
  query_timeout: envInteger('DB_QUERY_TIMEOUT_MS', 20000, 100),
  maxLifetimeSeconds: envInteger('DB_POOL_MAX_LIFETIME_SECONDS', 1800, 0)
});

pool.on?.('error', (error) => {
  console.error(`Unexpected idle PostgreSQL client error: ${error.message}`);
});

function getConnectionUrl() {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

function getTargetDatabaseName() {
  const url = getConnectionUrl();
  if (!url) return null;
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, '')).trim();
  return databaseName || null;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists() {
  if (process.env.POSTGRES_AUTO_CREATE_DB === 'false') {
    return;
  }

  const url = getConnectionUrl();
  const databaseName = getTargetDatabaseName();

  if (!url || !databaseName || databaseName === 'postgres') {
    return;
  }

  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';

  const client = new Client({
    connectionString: maintenanceUrl.toString(),
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } catch (error) {
    if (error?.code !== '3D000') {
      console.warn(`Unable to ensure PostgreSQL database "${databaseName}" exists: ${error.message}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const nowIso = () => new Date().toISOString();
const randomId = (prefix = 'doc') => `${prefix}_${crypto.randomUUID()}`;
const dateOnlyOffset = (days = 0) => {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
};

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, temporary_password, password, ...publicUser } = user;
  return publicUser;
}

function resolvePasswordFields(data = {}, existing = null) {
  const nextPassword = typeof data.password === 'string' ? data.password.trim() : '';
  const nextTemporaryPassword = typeof data.temporary_password === 'string'
    ? data.temporary_password.trim()
    : '';

  if (nextPassword) {
    return {
      password_hash: bcrypt.hashSync(nextPassword, 10),
      temporary_password: null
    };
  }

  if (nextTemporaryPassword) {
    return {
      password_hash: bcrypt.hashSync(nextTemporaryPassword, 10),
      temporary_password: nextTemporaryPassword
    };
  }

  return {
    password_hash: data.password_hash || existing?.password_hash || null,
    temporary_password: existing?.temporary_password || null
  };
}

function toUserRecord(row) {
  if (!row) return null;
  const profile = row.profile || {};
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    status: row.status,
    site_id: row.site_id,
    site_name: row.site_name,
    password_hash: row.password_hash,
    temporary_password: row.temporary_password,
    created_date: row.created_at?.toISOString?.() || row.created_at,
    updated_date: row.updated_at?.toISOString?.() || row.updated_at,
    ...profile
  };
}

function normalizeRecord(entity, payload, existing = null) {
  const defaults = entityRegistry[entity]?.defaults || {};
  const base = existing ? { ...existing } : {};
  const withDefaults = {
    ...defaults,
    ...base,
    ...payload
  };

  const record = {
    id: withDefaults.id || existing?.id || randomId(entity.toLowerCase()),
    created_date: withDefaults.created_date || existing?.created_date || nowIso(),
    updated_date: nowIso(),
    ...withDefaults
  };

  return entity === 'Inventory' ? deriveInventoryRecord(record) : record;
}

function hydrateDerivedFields(entity, record) {
  if (!record) return null;
  const derivedRecord = entity === 'Inventory' ? deriveInventoryRecord(record) : record;
  return entity === 'RoleProfile' ? normalizeManagementRoleProfile(derivedRecord) : derivedRecord;
}

const roleProfileCache = new Map();
const roleProfileCacheTtlMs = envInteger('ROLE_PROFILE_CACHE_TTL_MS', 10000, 0);
let roleProfileCacheGeneration = 0;

function invalidateRoleProfileCache(roleKey = null) {
  roleProfileCacheGeneration += 1;
  const normalized = String(roleKey || '').trim().toLowerCase();
  if (normalized) {
    roleProfileCache.delete(normalized);
    return;
  }
  roleProfileCache.clear();
}

async function findRoleProfileByKey(roleKey, executor = pool) {
  const normalized = String(roleKey || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const canUseCache = executor === pool && roleProfileCacheTtlMs > 0;
  const cacheGeneration = roleProfileCacheGeneration;
  const cached = canUseCache ? roleProfileCache.get(normalized) : null;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const result = usesNormalizedCore('RoleProfile')
    ? await query(
      `SELECT payload AS data
       FROM role_profiles
       WHERE LOWER(COALESCE(payload->>'role_key', '')) = $1
       LIMIT 1`,
      [normalized],
      executor
    )
    : await query(
      `SELECT data
       FROM entity_records
       WHERE entity_name = 'RoleProfile'
         AND LOWER(COALESCE(data->>'role_key', '')) = $1
       LIMIT 1`,
      [normalized],
      executor
    );

  let value = result.rowCount ? normalizeManagementRoleProfile(result.rows[0].data) : null;
  if (!value) {
    const builtIn = getEntitySystemRoleDefinition(normalized);
    value = builtIn ? normalizeManagementRoleProfile({
      id: `role_${builtIn.role_key}`,
      ...builtIn,
      is_system: true,
      is_active: true
    }) : null;
  }

  if (canUseCache && cacheGeneration === roleProfileCacheGeneration) {
    roleProfileCache.set(normalized, {
      value,
      expiresAt: Date.now() + roleProfileCacheTtlMs
    });
  }
  return value;
}

async function hydrateUserRole(user, executor = pool) {
  if (!user) return null;

  const roleProfile = await findRoleProfileByKey(user.role || 'user', executor);
  const roleIsActive = roleProfile?.is_active !== false;
  const accessLevel = roleIsActive
    ? (roleProfile?.access_level || (['admin', 'manager', 'user'].includes(user.role) ? user.role : 'user'))
    : 'user';
  const rolePermissions = roleIsActive && Array.isArray(roleProfile?.permissions) ? roleProfile.permissions : [];

  return {
    ...user,
    role_name: roleProfile?.name || user.role || 'User',
    role_access_level: accessLevel,
    role_permissions: rolePermissions,
    role_is_active: roleIsActive,
    dashboard_variant: roleIsActive ? (roleProfile?.dashboard_variant || null) : null,
    is_custom_role: !['admin', 'manager', 'user'].includes(String(user.role || '').toLowerCase())
  };
}

async function validateManagementUserAssignment(user, executor = pool) {
  const roleProfile = await findRoleProfileByKey(user?.role || 'user', executor);
  if (roleProfile?.is_active === false) {
    const error = new Error('The selected role is inactive');
    error.status = 400;
    throw error;
  }

  const rolePolicy = getRoleLocationPolicy(user?.role);
  if (rolePolicy?.scope === 'all_areas') {
    return normalizeRoleLocationFields(user);
  }

  if (rolePolicy?.primary_site_type) {
    const primarySiteId = String(user?.site_id || '').trim();
    if (!primarySiteId) {
      const error = new Error(`A primary ${rolePolicy.assignment_label} is required for this role`);
      error.status = 400;
      throw error;
    }

    const primarySite = await findDocument('Site', primarySiteId, executor);
    if (!primarySite || primarySite.is_active === false || !isRolePrimarySiteType(user.role, primarySite.type)) {
      const error = new Error(`The selected primary location must be an active ${rolePolicy.assignment_label}`);
      error.status = 400;
      throw error;
    }

    const submittedAllowedIds = Array.isArray(user?.allowed_site_ids)
      ? [...new Set(user.allowed_site_ids.filter(Boolean).map(String))]
      : [];
    const extraRoot = submittedAllowedIds.find((siteId) => siteId !== primarySiteId);
    if (extraRoot) {
      const error = new Error(`${rolePolicy.assignment_label} access must use one assigned hierarchy root`);
      error.status = 400;
      throw error;
    }

    return normalizeRoleLocationFields({
      ...user,
      site_id: primarySiteId,
      site_name: primarySite.name || null
    });
  }

  const dashboardView = resolveManagementDashboardView({
    role: user?.role,
    dashboardVariant: roleProfile?.dashboard_variant,
    roleName: roleProfile?.name
  });
  if (!dashboardView) return user;

  const primarySiteId = String(user?.site_id || '').trim();
  if (!primarySiteId) {
    const error = new Error('A primary project or area is required for management dashboard roles');
    error.status = 400;
    throw error;
  }

  const primarySite = await findDocument('Site', primarySiteId, executor);
  if (!primarySite || !isManagementScopeSiteType(dashboardView, primarySite.type)) {
    const error = new Error('The selected primary location is not valid for this management role');
    error.status = 400;
    throw error;
  }

  const allowedSiteIds = Array.isArray(user?.allowed_site_ids)
    ? [...new Set(user.allowed_site_ids.filter(Boolean).map(String))]
    : [];
  if (allowedSiteIds.length > 0 && !allowedSiteIds.includes(primarySiteId)) {
    const error = new Error('The primary management location must be included in project access');
    error.status = 400;
    throw error;
  }
  for (const siteId of allowedSiteIds) {
    const allowedSite = siteId === primarySiteId
      ? primarySite
      : await findDocument('Site', siteId, executor);
    if (!allowedSite || !isManagementScopeSiteType(dashboardView, allowedSite.type)) {
      const error = new Error('Project access contains a location that is not valid for this management role');
      error.status = 400;
      throw error;
    }
  }
  return user;
}

function normalizeUniqueValue(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string') return value.trim().toLowerCase();
  return String(value).trim().toLowerCase();
}

function valuesMatchForUnique(left, right) {
  return normalizeUniqueValue(left) === normalizeUniqueValue(right);
}

async function ensureEntityUniqueness(entity, record, currentId = null, executor = pool) {
  const config = entityRegistry[entity];
  const uniqueRules = config?.unique || [];
  if (!uniqueRules.length) {
    return;
  }

  for (const rule of uniqueRules) {
    const fields = Array.isArray(rule.fields) ? rule.fields : [];
    if (!fields.length) continue;

    const candidateValues = fields.map((field) => record[field]);
    if (rule.ignoreEmpty && candidateValues.some((value) => normalizeUniqueValue(value) === '')) {
      continue;
    }

    await query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`entity-unique:${entity}:${fields.map((field) => normalizeUniqueValue(record[field])).join(':')}`],
      executor
    );

    const records = await listDocuments(entity, { limit: 10000 }, executor);
    const duplicate = records.find((existing) => {
      if (currentId && existing.id === currentId) {
        return false;
      }
      if (
        entity === 'ProducedItemBatch'
        && (fields.includes('production_id') || fields.includes('batch_number'))
        && String(existing.status || '').trim().toLowerCase() === 'voided'
      ) {
        return false;
      }
      if (
        entity === 'ProductionConsumptionReport'
        && fields.includes('production_id')
        && String(existing.status || '').trim().toLowerCase() === 'reversed'
      ) {
        return false;
      }
      return fields.every((field) => valuesMatchForUnique(existing[field], record[field]));
    });

    if (duplicate) {
      const error = new Error(`${rule.label || fields.join(' + ')} already exists`);
      error.status = 409;
      throw error;
    }
  }
}

function matchesFilter(record, filters = {}) {
  return Object.entries(filters).every(([key, expected]) => {
    const actual = record[key];

    if (expected === null || typeof expected === 'undefined' || expected === '') {
      return actual === null || typeof actual === 'undefined' || actual === '';
    }

    if (Array.isArray(actual)) {
      return actual.includes(expected);
    }

    if (typeof actual === 'string' && typeof expected === 'string') {
      return actual.toLowerCase() === expected.toLowerCase();
    }

    return actual === expected;
  });
}

function sortRecords(records, sort) {
  if (!sort) {
    return [...records];
  }

  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;

  return [...records].sort((left, right) => {
    const a = left[field];
    const b = right[field];

    if (a === b) return 0;
    if (a === null || typeof a === 'undefined') return 1;
    if (b === null || typeof b === 'undefined') return -1;

    const result = String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: 'base'
    });

    return descending ? result * -1 : result;
  });
}

const SAFE_RELATIONAL_PAYLOAD_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const relationalDocumentTables = Object.freeze({
  AdvancedReportSchedule: 'advanced_report_schedules',
  ERPIntegrationConfig: 'erp_integration_configs',
  ERPIntegrationLog: 'erp_integration_logs',
  ForecastScenario: 'forecast_scenarios',
  ForecastSnapshot: 'forecast_snapshots',
  AttendanceRecord: 'attendance_records',
  AttendanceSession: 'attendance_sessions',
  StaffShift: 'staff_shifts',
  BranchOrder: 'branch_orders',
  CategoryQRSession: 'category_qr_sessions',
  D365Master: 'd365_masters',
  DinerScan: 'diner_scans',
  CustomerMealPlan: 'customer_meal_plans',
  MaterialRequest: 'material_requests',
  Budget: 'budgets',
  FoodCategory: 'food_categories',
  MenuPlanPRSchedule: 'menu_plan_pr_schedules',
  MenuPlanPRRun: 'menu_plan_pr_runs',
  ProductionBatch: 'production_batches',
  ProductionTransfer: 'production_transfers',
  PurchaseOrder: 'purchase_order_documents',
  QRCode: 'qr_codes',
  RoleProfile: 'role_profiles',
  QRDelivery: 'qr_deliveries',
  QualityControl: 'quality_controls',
  RFQ: 'rfqs',
  UserGroup: 'user_groups',
  WasteTarget: 'waste_targets',
  WasteDetectionLog: 'waste_detection_logs'
});

const normalizedCoreEnabled = process.env.FOODPRO_NORMALIZED_CORE !== 'false';
const normalizedCoreEntities = new Set([
  'Site',
  'Ingredient',
  'Inventory',
  'InventoryLot',
  'InventoryTransaction',
  'Recipe',
  'MenuPlan',
  'Production',
  'ProductionConsumptionReport',
  'ProducedItemBatch',
  'MealServiceAttendance',
  'MealServiceConsumption',
  'FoodWaste',
  'Supplier',
  ...Object.keys(relationalDocumentTables)
]);

function usesNormalizedCore(entity) {
  return normalizedCoreEnabled && normalizedCoreEntities.has(entity);
}

function toNumberOrNull(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toNumberOrZero(value) {
  return toNumberOrNull(value) ?? 0;
}

function toDateOnlyOrNull(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function jsonPayload(record = {}) {
  return JSON.stringify(record || {});
}

function rowTimestamp(value) {
  return value?.toISOString?.() || value || null;
}

function withPayload(row = {}, explicit = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const { __entity: entity, ...fields } = explicit;
  return hydrateDerivedFields(entity || '', {
    ...payload,
    ...fields,
    created_date: payload.created_date || rowTimestamp(row.created_at),
    updated_date: payload.updated_date || rowTimestamp(row.updated_at)
  });
}

function usesRelationalDocumentTable(entity) {
  return Object.prototype.hasOwnProperty.call(relationalDocumentTables, entity);
}

function rowToRelationalDocument(entity, row = {}) {
  return withPayload(row, {
    __entity: entity,
    id: row.id,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    from_site_id: row.from_site_id || null,
    to_site_id: row.to_site_id || null,
    site_ids: Array.isArray(row.site_ids) ? row.site_ids : [],
    status: row.status || null,
    source_name: row.source_name || null,
    record_date: row.record_date ? String(row.record_date).slice(0, 10) : null
  });
}

function relationalDocumentSiteId(record = {}) {
  return record.site_id
    || record.warehouse_id
    || record.fulfillment_store_id
    || record.requesting_site_id
    || record.source_site_id
    || null;
}

function relationalDocumentRecordDate(record = {}) {
  return toDateOnlyOrNull(
    record.record_date
    || record.date
    || record.service_date
    || record.waste_date
    || record.plan_date
    || record.production_date
    || record.request_date
    || record.order_date
    || record.event_date
    || record.shift_date
    || record.scan_date
    || record.created_date
  );
}

async function listRelationalDocumentReferenceRows(executor = pool) {
  const rows = [];
  for (const [entity, table] of Object.entries(relationalDocumentTables)) {
    const result = await query(
      `SELECT id, $1::text AS entity_name, payload AS data
         FROM ${quoteIdentifier(table)}
        FOR SHARE`,
      [entity],
      executor
    );
    rows.push(...result.rows);
  }
  return rows;
}

function rowToSite(row = {}) {
  return withPayload(row, {
    __entity: 'Site',
    id: row.id,
    name: row.name,
    type: row.type,
    parent_site_id: row.parent_site_id || null,
    project_code: row.project_code || row.warehouse_code || row.area_code || row.project_code || null,
    d365_warehouse_id: row.d365_warehouse_id || null,
    source_name: row.source_name || null,
    is_active: row.status !== 'inactive',
    status: row.status || 'active'
  });
}

function rowToIngredient(row = {}) {
  return withPayload(row, {
    __entity: 'Ingredient',
    id: row.ingredient_id,
    name: row.name,
    item_code: row.item_code,
    ingredient_code: row.ingredient_code || null,
    sku: row.sku || null,
    d365_item_id: row.d365_item_id || null,
    unit: row.base_unit,
    base_unit: row.base_unit,
    category: row.category_id || null,
    source_name: row.source_name || null,
    is_active: row.status !== 'inactive',
    status: row.status || 'active'
  });
}

function rowToInventory(row = {}) {
  return withPayload(row, {
    __entity: 'Inventory',
    id: row.inventory_id,
    site_id: row.warehouse_id,
    ingredient_id: row.ingredient_id,
    available_quantity: Number(row.available_quantity || 0),
    reserved_quantity: Number(row.reserved_quantity || 0),
    on_hand_quantity: Number(row.on_hand_quantity || 0),
    quantity: Number(row.on_hand_quantity || row.available_quantity || 0),
    average_unit_cost: Number(row.average_unit_cost || 0),
    last_unit_cost: Number(row.last_unit_cost || 0),
    unit: row.stock_unit,
    status: row.status || 'active',
    source_name: row.source_name || null
  });
}

function rowToInventoryLot(row = {}) {
  return withPayload(row, {
    __entity: 'InventoryLot',
    id: row.lot_id,
    inventory_id: row.inventory_id,
    site_id: row.warehouse_id,
    ingredient_id: row.ingredient_id,
    batch_number: row.batch_number || null,
    received_date: row.received_date || null,
    stock_date: row.stock_date || null,
    expiry_date: row.expiry_date || null,
    original_quantity: Number(row.original_quantity || 0),
    remaining_quantity: Number(row.remaining_quantity || 0),
    unit: row.unit,
    unit_cost: Number(row.unit_cost || 0),
    status: row.status || 'active',
    source_name: row.source_name || null
  });
}

function rowToInventoryTransaction(row = {}) {
  return withPayload(row, {
    __entity: 'InventoryTransaction',
    id: row.inventory_transaction_id,
    inventory_id: row.inventory_id || null,
    site_id: row.warehouse_id || null,
    ingredient_id: row.ingredient_id || null,
    inventory_lot_id: row.lot_id || null,
    transaction_type: row.transaction_type,
    transaction_date: row.transaction_date || null,
    quantity: Number(row.quantity || 0),
    unit: row.unit || null,
    unit_cost: Number(row.unit_cost || 0),
    total_cost: Number(row.total_cost || 0),
    reference_type: row.reference_type || null,
    reference_id: row.reference_id || null,
    reason_code: row.reason_code || null,
    idempotency_key: row.idempotency_key || null,
    status: row.status || 'posted',
    source_name: row.source_name || null
  });
}

function rowToRecipe(row = {}) {
  return withPayload(row, {
    __entity: 'Recipe',
    id: row.recipe_version_id,
    recipe_master_id: row.recipe_id,
    name: row.display_name,
    recipe_code: row.recipe_code || null,
    cuisine_type: row.cuisine_type || null,
    category: row.menu_category || null,
    menu_category: row.menu_category || null,
    portion_size_grams: row.serving_size_grams === null ? null : Number(row.serving_size_grams || 0),
    batch_yield: Number(row.batch_yield || 1),
    total_recipe_weight_grams: row.total_recipe_weight_grams === null ? null : Number(row.total_recipe_weight_grams || 0),
    total_cost: Number(row.total_cost || 0),
    cost_per_serving: Number(row.cost_per_serving || 0),
    site_scope: row.warehouse_id ? 'warehouse' : row.project_id ? 'project' : row.area_id ? 'area' : 'global',
    site_ids: [row.warehouse_id, row.project_id, row.area_id].filter(Boolean),
    status: row.status || 'active',
    is_active: row.status !== 'inactive',
    source_name: row.source_name || null
  });
}

function rowToMenuPlan(row = {}) {
  return withPayload(row, {
    __entity: 'MenuPlan',
    id: row.menu_plan_id,
    site_id: row.warehouse_id,
    plan_date: row.plan_date,
    cuisine_type: row.menu_type,
    menu_type: row.menu_type,
    menu_category: row.menu_category,
    meal_type: row.meal_period,
    status: row.status || 'planned',
    source_name: row.source_name || null,
    created_by: row.created_by || null
  });
}

function rowToProduction(row = {}) {
  return withPayload(row, {
    __entity: 'Production',
    id: row.production_id,
    menu_plan_id: row.menu_plan_id || null,
    site_id: row.warehouse_id,
    fulfillment_store_id: row.warehouse_id,
    production_date: row.production_date,
    meal_type: row.meal_period,
    menu_type: row.menu_type,
    cuisine_type: row.menu_type,
    menu_category: row.menu_category,
    status: row.status || 'planned',
    issue_group_key: row.issue_group_key || null,
    completed_by: row.completed_by || null,
    completed_at: row.completed_at || null,
    reversed_by: row.reversed_by || null,
    reversed_at: row.reversed_at || null,
    reversal_reason: row.reversal_reason || null,
    source_name: row.source_name || null
  });
}

function rowToProductionConsumptionReport(row = {}) {
  return withPayload(row, {
    __entity: 'ProductionConsumptionReport',
    id: row.report_id,
    report_number: row.report_number,
    production_id: row.production_id,
    site_id: row.warehouse_id || null,
    production_date: row.production_date || null,
    total_consumption_cost: Number(row.total_consumption_cost || 0),
    total_shortage_cost: Number(row.total_shortage_cost || 0),
    status: row.status || 'posted'
  });
}

function rowToProducedItemBatch(row = {}) {
  return withPayload(row, {
    __entity: 'ProducedItemBatch',
    id: row.output_batch_id,
    production_id: row.production_id,
    production_line_id: row.production_line_id,
    site_id: row.warehouse_id,
    fulfillment_store_id: row.warehouse_id,
    production_date: row.production_date || null,
    meal_type: row.meal_period || null,
    menu_type: row.menu_type || null,
    cuisine_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    completed_at: row.completed_at || null,
    recipe_id: row.recipe_version_id || row.ingredient_id || null,
    item_name: row.item_name || null,
    batch_number: row.batch_number,
    initial_weight_grams: Number(row.initial_weight_grams || 0),
    remaining_weight_grams: Number(row.remaining_weight_grams || 0),
    produced_weight_grams: Number(row.initial_weight_grams || 0),
    available_weight_grams: Number(row.remaining_weight_grams || 0),
    initial_servings: row.initial_servings === null ? null : Number(row.initial_servings || 0),
    remaining_servings: row.remaining_servings === null ? null : Number(row.remaining_servings || 0),
    unit_cost: Number(row.unit_cost || 0),
    total_cost: Number(row.total_cost || 0),
    status: row.status || 'active',
    source_name: row.source_name || null
  });
}

function rowToMealServiceAttendance(row = {}) {
  return withPayload(row, {
    __entity: 'MealServiceAttendance',
    id: row.meal_service_id,
    service_reference: row.service_reference,
    idempotency_key: row.idempotency_key,
    site_id: row.warehouse_id,
    service_date: row.service_date,
    meal_type: row.meal_period,
    menu_type: row.menu_type,
    menu_category: row.menu_category,
    serving_size_grams: Number(row.serving_size_grams || 0),
    covers: Number(row.covers || 0),
    status: row.status || 'posted',
    posted_by: row.posted_by || null,
    reversed_by: row.reversed_by || null,
    reversed_at: row.reversed_at || null,
    source_name: row.source_name || null
  });
}

function rowToMealServiceConsumption(row = {}) {
  return withPayload(row, {
    __entity: 'MealServiceConsumption',
    id: row.meal_consumption_id,
    meal_service_attendance_id: row.meal_service_id,
    site_id: row.warehouse_id || null,
    produced_item_batch_id: row.output_batch_id || null,
    production_id: row.production_id || null,
    recipe_id: row.recipe_version_id || null,
    reverses_consumption_id: row.reverses_consumption_id || null,
    idempotency_key: row.idempotency_key,
    service_reference: row.service_reference,
    movement_type: row.movement_type || 'consumption',
    service_date: row.service_date || null,
    meal_type: row.meal_period || null,
    menu_type: row.menu_type || null,
    cuisine_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    consumed_weight_grams: Number(row.consumed_weight_grams || 0),
    consumed_servings: Number(row.consumed_servings || 0),
    cost: Number(row.cost || 0),
    status: row.status || 'posted'
  });
}

function rowToFoodWaste(row = {}) {
  return withPayload(row, {
    __entity: 'FoodWaste',
    id: row.food_waste_id,
    waste_reference: row.waste_reference || null,
    idempotency_key: row.idempotency_key || null,
    site_id: row.warehouse_id,
    waste_date: row.waste_date,
    meal_type: row.meal_period || null,
    menu_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    waste_category: row.waste_category,
    reason_code: row.reason_code || null,
    approval_status: row.approval_status || 'pending',
    status: row.status || 'posted',
    recorded_by: row.recorded_by || null,
    reversed_by: row.reversed_by || null,
    reversed_at: row.reversed_at || null,
    reversal_reason: row.reversal_reason || null,
    source_name: row.source_name || null
  });
}

function rowToSupplier(row = {}) {
  return withPayload(row, {
    __entity: 'Supplier',
    id: row.id,
    name: row.name,
    contact_person: row.contact_person || null,
    email: row.email || null,
    phone: row.phone || null,
    address: row.address || null,
    city: row.city || null,
    country: row.country || null,
    payment_terms: row.payment_terms || null,
    lead_time_days: Number(row.lead_time_days || 0),
    status: row.status || 'active',
    rating: Number(row.rating || 0),
    categories: Array.isArray(row.categories) ? row.categories : [],
    notes: row.notes || null,
    source_name: row.source_name || null
  });
}

const normalizedSimpleConfigs = {
  Supplier: {
    table: 'suppliers',
    idColumn: 'id',
    mapper: rowToSupplier,
    select: 'SELECT * FROM suppliers',
    insertSql: `INSERT INTO suppliers (
      id, name, contact_person, email, phone, address, city, country,
      payment_terms, lead_time_days, status, rating, categories, notes,
      source_name, payload, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,$17,$18)`,
    values(record) {
      return [
        record.id,
        record.name || record.supplier_name || 'Supplier',
        record.contact_person || null,
        record.email || null,
        record.phone || null,
        record.address || null,
        record.city || null,
        record.country || null,
        record.payment_terms || null,
        Math.max(0, Math.trunc(toNumberOrZero(record.lead_time_days))),
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        toNumberOrZero(record.rating),
        JSON.stringify(Array.isArray(record.categories) ? record.categories : []),
        record.notes || null,
        record.source_name || null,
        jsonPayload(record),
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE suppliers SET
      name = $2, contact_person = $3, email = $4, phone = $5, address = $6,
      city = $7, country = $8, payment_terms = $9, lead_time_days = $10,
      status = $11, rating = $12, categories = $13::jsonb, notes = $14,
      source_name = $15, payload = $16::jsonb, updated_at = $17
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 16), record.updated_date || nowIso()];
    }
  },
  Ingredient: {
    table: 'ingredients',
    idColumn: 'ingredient_id',
    mapper: rowToIngredient,
    select: 'SELECT * FROM ingredients',
    insertSql: `INSERT INTO ingredients (
      ingredient_id, item_code, ingredient_code, sku, d365_item_id, name, base_unit,
      category_id, status, source_name, payload, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
    values(record) {
      const itemCode = String(record.item_code || record.ingredient_code || record.sku || record.d365_item_id || record.id).trim();
      return [
        record.id,
        itemCode,
        record.ingredient_code || null,
        record.sku || null,
        record.d365_item_id || null,
        record.name,
        record.base_unit || record.unit || record.conversion_unit || 'EA',
        record.category || record.category_id || null,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        jsonPayload(record),
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE ingredients SET
      item_code = $2, ingredient_code = $3, sku = $4, d365_item_id = $5, name = $6,
      base_unit = $7, category_id = $8, status = $9, source_name = $10,
      payload = $11::jsonb, updated_at = $12
      WHERE ingredient_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 11), record.updated_date || nowIso()];
    }
  },
  Inventory: {
    table: 'warehouse_inventory',
    idColumn: 'inventory_id',
    mapper: rowToInventory,
    select: 'SELECT * FROM warehouse_inventory',
    insertSql: `INSERT INTO warehouse_inventory (
      inventory_id, warehouse_id, ingredient_id, available_quantity, reserved_quantity,
      on_hand_quantity, average_unit_cost, last_unit_cost, stock_unit, status,
      source_name, payload, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
    values(record) {
      return [
        record.id,
        record.site_id || record.warehouse_id,
        record.ingredient_id,
        toNumberOrZero(record.available_quantity ?? record.quantity),
        toNumberOrZero(record.reserved_quantity),
        toNumberOrZero(record.on_hand_quantity ?? record.quantity ?? record.available_quantity),
        toNumberOrZero(record.average_unit_cost ?? record.cost_per_unit),
        toNumberOrZero(record.last_unit_cost ?? record.cost_per_unit),
        record.stock_unit || record.unit || 'EA',
        record.status || 'active',
        record.source_name || null,
        jsonPayload(record),
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE warehouse_inventory SET
      warehouse_id = $2, ingredient_id = $3, available_quantity = $4, reserved_quantity = $5,
      on_hand_quantity = $6, average_unit_cost = $7, last_unit_cost = $8, stock_unit = $9,
      status = $10, source_name = $11, payload = $12::jsonb, updated_at = $13
      WHERE inventory_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 12), record.updated_date || nowIso()];
    }
  },
  InventoryLot: {
    table: 'inventory_lots',
    idColumn: 'lot_id',
    mapper: rowToInventoryLot,
    select: 'SELECT * FROM inventory_lots',
    insertSql: `INSERT INTO inventory_lots (
      lot_id, inventory_id, warehouse_id, ingredient_id, batch_number, received_date, stock_date,
      expiry_date, original_quantity, remaining_quantity, unit, unit_cost, status, source_name,
      payload, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
    values(record) {
      return [
        record.id,
        record.inventory_id,
        record.site_id || record.warehouse_id,
        record.ingredient_id,
        record.batch_number || null,
        toDateOnlyOrNull(record.received_date),
        toDateOnlyOrNull(record.stock_date),
        toDateOnlyOrNull(record.expiry_date),
        toNumberOrZero(record.original_quantity ?? record.quantity),
        toNumberOrZero(record.remaining_quantity ?? record.quantity),
        record.unit || 'EA',
        toNumberOrZero(record.unit_cost ?? record.cost_per_unit),
        record.status || 'active',
        record.source_name || null,
        jsonPayload(record),
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE inventory_lots SET
      inventory_id = $2, warehouse_id = $3, ingredient_id = $4, batch_number = $5,
      received_date = $6, stock_date = $7, expiry_date = $8, original_quantity = $9,
      remaining_quantity = $10, unit = $11, unit_cost = $12, status = $13,
      source_name = $14, payload = $15::jsonb, updated_at = $16
      WHERE lot_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 15), record.updated_date || nowIso()];
    }
  },
  InventoryTransaction: {
    table: 'inventory_transactions',
    idColumn: 'inventory_transaction_id',
    mapper: rowToInventoryTransaction,
    select: 'SELECT * FROM inventory_transactions',
    insertSql: `INSERT INTO inventory_transactions (
      inventory_transaction_id, inventory_id, warehouse_id, ingredient_id, lot_id,
      transaction_type, transaction_date, quantity, unit, unit_cost, total_cost,
      reference_type, reference_id, reason_code, idempotency_key, status, source_name,
      payload, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)`,
    values(record) {
      return [
        record.id,
        record.inventory_id || null,
        record.site_id || record.warehouse_id || null,
        record.ingredient_id || null,
        record.lot_id || record.inventory_lot_id || null,
        record.transaction_type || record.type || 'adjustment',
        toDateOnlyOrNull(record.transaction_date || record.date || record.created_date),
        toNumberOrZero(record.quantity),
        record.unit || null,
        toNumberOrZero(record.unit_cost ?? record.cost_per_unit),
        toNumberOrZero(record.total_cost ?? record.value),
        record.reference_type || null,
        record.reference_id || null,
        record.reason_code || null,
        record.idempotency_key || null,
        record.status || 'posted',
        record.source_name || null,
        jsonPayload(record),
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE inventory_transactions SET
      inventory_id = $2, warehouse_id = $3, ingredient_id = $4, lot_id = $5,
      transaction_type = $6, transaction_date = $7, quantity = $8, unit = $9,
      unit_cost = $10, total_cost = $11, reference_type = $12, reference_id = $13,
      reason_code = $14, idempotency_key = $15, status = $16, source_name = $17,
      payload = $18::jsonb, updated_at = $19
      WHERE inventory_transaction_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 18), record.updated_date || nowIso()];
    }
  }
};

function normalizedSelectForEntity(entity) {
  if (entity === 'Site') {
    return `SELECT area_id AS id, name, 'area' AS type, NULL::text AS parent_site_id,
                   area_code, NULL::text AS project_code, NULL::text AS warehouse_code,
                   NULL::text AS d365_warehouse_id, status, source_name, payload, created_at, updated_at
            FROM areas
            UNION ALL
            SELECT project_id AS id, name, 'project' AS type, area_id AS parent_site_id,
                   NULL::text AS area_code, project_code, NULL::text AS warehouse_code,
                   NULL::text AS d365_warehouse_id, status, source_name, payload, created_at, updated_at
            FROM projects
            UNION ALL
            SELECT warehouse_id AS id, name, 'store' AS type, project_id AS parent_site_id,
                   NULL::text AS area_code, NULL::text AS project_code, warehouse_code,
                   d365_warehouse_id, status, source_name, payload, created_at, updated_at
            FROM warehouses`;
  }
  if (entity === 'Recipe') {
    return `SELECT version.*, recipe.canonical_name
            FROM recipe_versions version
            JOIN recipes recipe ON recipe.recipe_id = version.recipe_id`;
  }
  if (entity === 'MenuPlan') return 'SELECT * FROM menu_plans';
  if (entity === 'Production') return 'SELECT * FROM production_events';
  if (entity === 'ProductionConsumptionReport') return 'SELECT * FROM production_consumption_reports';
  if (entity === 'ProducedItemBatch') {
    return `SELECT batch.*, event.production_date, event.meal_period, event.menu_type,
                   event.menu_category, event.completed_at, line.item_name
            FROM produced_output_batches batch
            JOIN production_events event ON event.production_id = batch.production_id
            JOIN production_manifest_lines line ON line.production_line_id = batch.production_line_id`;
  }
  if (entity === 'MealServiceAttendance') return 'SELECT * FROM meal_service_headers';
  if (entity === 'MealServiceConsumption') {
    return `SELECT consumption.*, header.warehouse_id, header.menu_type, header.menu_category
            FROM meal_service_consumptions consumption
            JOIN meal_service_headers header ON header.meal_service_id = consumption.meal_service_id`;
  }
  if (entity === 'FoodWaste') return 'SELECT * FROM food_waste_records';
  if (usesRelationalDocumentTable(entity)) {
    return `SELECT id, $q$${entity}$q$::text AS entity_name, site_id, site_name,
                   from_site_id, to_site_id, site_ids, status, record_date,
                   source_name, payload, created_at, updated_at
            FROM ${quoteIdentifier(relationalDocumentTables[entity])}`;
  }
  return normalizedSimpleConfigs[entity]?.select || null;
}

function normalizedIdColumn(entity) {
  if (usesRelationalDocumentTable(entity)) return 'id';
  return ({
    Site: 'id',
    Recipe: 'recipe_version_id',
    MenuPlan: 'menu_plan_id',
    Production: 'production_id',
    ProductionConsumptionReport: 'report_id',
    ProducedItemBatch: 'output_batch_id',
    MealServiceAttendance: 'meal_service_id',
    MealServiceConsumption: 'meal_consumption_id',
    FoodWaste: 'food_waste_id'
  })[entity] || normalizedSimpleConfigs[entity]?.idColumn;
}

function normalizedMapper(entity) {
  if (usesRelationalDocumentTable(entity)) {
    return (row) => rowToRelationalDocument(entity, row);
  }
  return ({
    Site: rowToSite,
    Recipe: rowToRecipe,
    MenuPlan: rowToMenuPlan,
    Production: rowToProduction,
    ProductionConsumptionReport: rowToProductionConsumptionReport,
    ProducedItemBatch: rowToProducedItemBatch,
    MealServiceAttendance: rowToMealServiceAttendance,
    MealServiceConsumption: rowToMealServiceConsumption,
    FoodWaste: rowToFoodWaste
  })[entity] || normalizedSimpleConfigs[entity]?.mapper;
}

function normalizedOrder(records, sort) {
  return sortRecords(records, sort || '-updated_date');
}

function normalizedSqlColumnForField(entity, field) {
  const idColumn = normalizedIdColumn(entity);
  const common = {
    id: idColumn,
    created_date: 'created_at',
    updated_date: 'updated_at',
    recorded_at: 'created_at',
    source_name: 'source_name',
    status: 'status'
  };
  const columns = {
    Site: {
      name: 'name',
      type: 'type',
      parent_site_id: 'parent_site_id',
      project_code: 'project_code',
      d365_warehouse_id: 'd365_warehouse_id',
      is_active: 'status'
    },
    Ingredient: {
      name: 'name',
      item_code: 'item_code',
      ingredient_code: 'ingredient_code',
      sku: 'sku',
      d365_item_id: 'd365_item_id',
      unit: 'base_unit',
      base_unit: 'base_unit',
      category: 'category_id',
      category_id: 'category_id',
      is_active: 'status'
    },
    Inventory: {
      inventory_id: 'inventory_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      ingredient_id: 'ingredient_id',
      available_quantity: 'available_quantity',
      reserved_quantity: 'reserved_quantity',
      on_hand_quantity: 'on_hand_quantity',
      quantity: 'on_hand_quantity',
      average_unit_cost: 'average_unit_cost',
      last_unit_cost: 'last_unit_cost',
      unit: 'stock_unit',
      stock_unit: 'stock_unit'
    },
    InventoryLot: {
      lot_id: 'lot_id',
      inventory_id: 'inventory_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      ingredient_id: 'ingredient_id',
      batch_number: 'batch_number',
      received_date: 'received_date',
      stock_date: 'stock_date',
      expiry_date: 'expiry_date',
      original_quantity: 'original_quantity',
      remaining_quantity: 'remaining_quantity',
      unit: 'unit',
      unit_cost: 'unit_cost'
    },
    InventoryTransaction: {
      inventory_transaction_id: 'inventory_transaction_id',
      inventory_id: 'inventory_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      ingredient_id: 'ingredient_id',
      inventory_lot_id: 'lot_id',
      lot_id: 'lot_id',
      transaction_type: 'transaction_type',
      transaction_date: 'transaction_date',
      quantity: 'quantity',
      unit: 'unit',
      unit_cost: 'unit_cost',
      total_cost: 'total_cost',
      reference_type: 'reference_type',
      reference_id: 'reference_id',
      reason_code: 'reason_code',
      idempotency_key: 'idempotency_key'
    },
    Recipe: {
      recipe_master_id: 'recipe_id',
      recipe_id: 'recipe_id',
      name: 'display_name',
      recipe_code: 'recipe_code',
      cuisine_type: 'cuisine_type',
      category: 'menu_category',
      menu_category: 'menu_category',
      portion_size_grams: 'serving_size_grams',
      serving_size_grams: 'serving_size_grams',
      batch_yield: 'batch_yield',
      total_recipe_weight_grams: 'total_recipe_weight_grams',
      total_cost: 'total_cost',
      cost_per_serving: 'cost_per_serving',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      project_id: 'project_id',
      area_id: 'area_id',
      is_active: 'status'
    },
    MenuPlan: {
      menu_plan_id: 'menu_plan_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      plan_date: 'plan_date',
      cuisine_type: 'menu_type',
      menu_type: 'menu_type',
      menu_category: 'menu_category',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      created_by: 'created_by'
    },
    Production: {
      production_id: 'production_id',
      menu_plan_id: 'menu_plan_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      fulfillment_store_id: 'warehouse_id',
      production_date: 'production_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      menu_type: 'menu_type',
      cuisine_type: 'menu_type',
      menu_category: 'menu_category',
      issue_group_key: 'issue_group_key',
      completed_by: 'completed_by',
      completed_at: 'completed_at',
      completed_date: 'completed_at',
      reversed_by: 'reversed_by',
      reversed_at: 'reversed_at'
    },
    ProductionConsumptionReport: {
      report_id: 'report_id',
      report_number: 'report_number',
      production_id: 'production_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      production_date: 'production_date',
      total_consumption_cost: 'total_consumption_cost',
      total_shortage_cost: 'total_shortage_cost'
    },
    ProducedItemBatch: {
      output_batch_id: 'output_batch_id',
      produced_item_batch_id: 'output_batch_id',
      production_id: 'production_id',
      production_line_id: 'production_line_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      fulfillment_store_id: 'warehouse_id',
      recipe_id: 'recipe_version_id',
      recipe_version_id: 'recipe_version_id',
      ingredient_id: 'ingredient_id',
      batch_number: 'batch_number',
      production_date: 'production_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      menu_type: 'menu_type',
      cuisine_type: 'menu_type',
      menu_category: 'menu_category',
      completed_at: 'completed_at',
      completed_date: 'completed_at',
      initial_weight_grams: 'initial_weight_grams',
      remaining_weight_grams: 'remaining_weight_grams',
      produced_weight_grams: 'initial_weight_grams',
      available_weight_grams: 'remaining_weight_grams',
      initial_servings: 'initial_servings',
      remaining_servings: 'remaining_servings',
      unit_cost: 'unit_cost',
      total_cost: 'total_cost'
    },
    MealServiceAttendance: {
      meal_service_id: 'meal_service_id',
      service_reference: 'service_reference',
      idempotency_key: 'idempotency_key',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      service_date: 'service_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      menu_type: 'menu_type',
      cuisine_type: 'menu_type',
      menu_category: 'menu_category',
      serving_size_grams: 'serving_size_grams',
      covers: 'covers',
      posted_by: 'posted_by',
      reversed_by: 'reversed_by',
      reversed_at: 'reversed_at',
      scope_key: "payload->>'scope_key'",
      reversal_idempotency_key: "payload->>'reversal_idempotency_key'"
    },
    MealServiceConsumption: {
      meal_consumption_id: 'meal_consumption_id',
      meal_service_attendance_id: 'meal_service_id',
      meal_service_id: 'meal_service_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      produced_item_batch_id: 'output_batch_id',
      output_batch_id: 'output_batch_id',
      production_id: 'production_id',
      recipe_id: 'recipe_version_id',
      recipe_version_id: 'recipe_version_id',
      reverses_consumption_id: 'reverses_consumption_id',
      idempotency_key: 'idempotency_key',
      service_reference: 'service_reference',
      movement_type: 'movement_type',
      service_date: 'service_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      menu_type: 'menu_type',
      cuisine_type: 'menu_type',
      menu_category: 'menu_category',
      consumed_weight_grams: 'consumed_weight_grams',
      consumed_servings: 'consumed_servings',
      cost: 'cost'
    },
    FoodWaste: {
      food_waste_id: 'food_waste_id',
      waste_reference: 'waste_reference',
      idempotency_key: 'idempotency_key',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      waste_date: 'waste_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      menu_type: 'menu_type',
      cuisine_type: 'menu_type',
      menu_category: 'menu_category',
      waste_category: 'waste_category',
      reason_code: 'reason_code',
      approval_status: 'approval_status',
      recorded_by: 'recorded_by',
      reversed_by: 'reversed_by',
      reversed_at: 'reversed_at',
      waste_scope: "payload->>'waste_scope'",
      meal_service_attendance_id: "payload->>'meal_service_attendance_id'",
      auto_generated: "payload->>'auto_generated'"
    },
    Supplier: {
      name: 'name',
      supplier_name: 'name',
      contact_person: 'contact_person',
      email: 'email',
      phone: 'phone',
      city: 'city',
      country: 'country',
      payment_terms: 'payment_terms',
      lead_time_days: 'lead_time_days',
      rating: 'rating',
      is_active: 'status',
      source_name: 'source_name'
    }
  };
  const column = {
    ...common,
    ...(columns[entity] || {})
  }[field];
  if (!column) {
    if (
      SAFE_RELATIONAL_PAYLOAD_FIELD_PATTERN.test(String(field || ''))
      && (
        usesRelationalDocumentTable(entity)
        || normalizedSimpleConfigs[entity]?.select?.includes('payload')
        || [
          'Recipe',
          'MenuPlan',
          'Production',
          'ProductionConsumptionReport',
          'ProducedItemBatch',
          'MealServiceAttendance',
          'MealServiceConsumption',
          'FoodWaste'
        ].includes(entity)
      )
    ) {
      return `normalized_record.payload->>'${field}'`;
    }
    return null;
  }
  return column.includes('->') || column.includes('(')
    ? `normalized_record.${column}`
    : `normalized_record.${column}`;
}

function normalizedSqlIdColumn(entity) {
  const idColumn = normalizedIdColumn(entity);
  return idColumn ? `normalized_record.${idColumn}` : 'normalized_record.id';
}

function addSqlParameter(parameters, value) {
  parameters.push(value);
  return `$${parameters.length}`;
}

function normalizeLocationIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
    return [...value].filter(Boolean).map(String);
  }
  return [String(value)];
}

function buildNormalizedFilterClause(entity, field, expected, parameters) {
  if (field === 'is_active') {
    const statusColumn = normalizedSqlColumnForField(entity, 'status');
    if (!statusColumn) return null;
    if (expected === null || typeof expected === 'undefined' || expected === '') {
      return `COALESCE(${statusColumn}::text, '') = ''`;
    }
    const expectsActive = expected === true || String(expected).toLowerCase() === 'true';
    return expectsActive
      ? `LOWER(COALESCE(${statusColumn}::text, '')) <> 'inactive'`
      : `LOWER(COALESCE(${statusColumn}::text, '')) = 'inactive'`;
  }

  const column = normalizedSqlColumnForField(entity, field);
  if (!column) return null;

  if (expected === null || typeof expected === 'undefined' || expected === '') {
    return `COALESCE(${column}::text, '') = ''`;
  }

  if (Array.isArray(expected)) {
    const values = expected
      .filter((value) => value !== null && typeof value !== 'undefined' && value !== '')
      .map((value) => String(value).toLowerCase());
    if (!values.length) return `COALESCE(${column}::text, '') = ''`;
    const parameter = addSqlParameter(parameters, values);
    return `LOWER(COALESCE(${column}::text, '')) = ANY(${parameter}::text[])`;
  }

  const parameter = addSqlParameter(parameters, String(expected));
  return `LOWER(COALESCE(${column}::text, '')) = LOWER(${parameter}::text)`;
}

function buildNormalizedRangeClauses(entity, rangeFilters = {}, parameters) {
  const clauses = [];
  const unsupported = [];
  for (const [field, bounds] of Object.entries(rangeFilters || {})) {
    const column = normalizedSqlColumnForField(entity, field);
    if (!column) {
      unsupported.push(field);
      continue;
    }
    if (bounds?.gte !== null && typeof bounds?.gte !== 'undefined' && bounds.gte !== '') {
      clauses.push(`${column} >= ${addSqlParameter(parameters, bounds.gte)}`);
    }
    if (bounds?.lte !== null && typeof bounds?.lte !== 'undefined' && bounds.lte !== '') {
      clauses.push(`${column} <= ${addSqlParameter(parameters, bounds.lte)}`);
    }
  }
  return { clauses, unsupported };
}

function buildNormalizedLocationClause(entity, location, parameters) {
  if (!location || location.unrestricted) return null;
  const allowedIds = [...new Set(normalizeLocationIds(location.accessibleSiteIds))];
  const parameter = addSqlParameter(parameters, allowedIds);
  if (entity === 'Site') {
    return allowedIds.length ? `normalized_record.id = ANY(${parameter}::text[])` : 'FALSE';
  }
  if (entity === 'Recipe') {
    const globalRecipe = `(
      COALESCE(normalized_record.warehouse_id::text, '') = ''
      AND COALESCE(normalized_record.project_id::text, '') = ''
      AND COALESCE(normalized_record.area_id::text, '') = ''
    )`;
    if (!allowedIds.length) return globalRecipe;
    return `(
      ${globalRecipe}
      OR normalized_record.warehouse_id = ANY(${parameter}::text[])
      OR normalized_record.project_id = ANY(${parameter}::text[])
      OR normalized_record.area_id = ANY(${parameter}::text[])
    )`;
  }
  const locationColumn = normalizedSqlColumnForField(entity, 'site_id')
    || normalizedSqlColumnForField(entity, 'warehouse_id')
    || normalizedSqlColumnForField(entity, 'fulfillment_store_id');
  if (!locationColumn) return null;
  if (!allowedIds.length) return `COALESCE(${locationColumn}::text, '') = ''`;
  return `(COALESCE(${locationColumn}::text, '') = '' OR ${locationColumn} = ANY(${parameter}::text[]))`;
}

function buildNormalizedOrderClause(entity, sort) {
  const normalizedSort = String(sort || '-updated_date').trim();
  const descending = normalizedSort.startsWith('-');
  const field = descending ? normalizedSort.slice(1) : normalizedSort;
  const column = normalizedSqlColumnForField(entity, field);
  if (!column) return null;
  const direction = descending ? 'DESC' : 'ASC';
  return `${column} ${direction} NULLS LAST, ${normalizedSqlIdColumn(entity)} ASC`;
}

function normalizedLimit(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(10000, Math.max(1, Math.trunc(numeric)));
}

function normalizedOffset(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function buildNormalizedListQuery({
  entity,
  filters = {},
  rangeFilters = {},
  sort,
  limit,
  offset = 0,
  lock = false,
  location = null,
  includeTotal = false
} = {}) {
  const select = normalizedSelectForEntity(entity);
  if (!select) return null;
  const parameters = [];
  const clauses = [];
  const unsupportedFilters = [];

  for (const [field, expected] of Object.entries(filters || {})) {
    const clause = buildNormalizedFilterClause(entity, field, expected, parameters);
    if (clause) clauses.push(clause);
    else unsupportedFilters.push(field);
  }

  const range = buildNormalizedRangeClauses(entity, rangeFilters, parameters);
  clauses.push(...range.clauses);
  unsupportedFilters.push(...range.unsupported);

  const locationClause = buildNormalizedLocationClause(entity, location, parameters);
  if (locationClause) clauses.push(locationClause);

  if (unsupportedFilters.length) {
    return { fallback: true, unsupportedFilters };
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join('\n        AND ')}` : '';
  const orderClause = buildNormalizedOrderClause(entity, sort);
  if (!orderClause) {
    return { fallback: true, unsupportedFilters: [`sort:${sort}`] };
  }
  const pageSize = normalizedLimit(limit);
  const pageOffset = normalizedOffset(offset);
  const limitClause = pageSize === null ? '' : `LIMIT ${addSqlParameter(parameters, pageSize)}::integer`;
  const offsetClause = pageOffset > 0 ? `OFFSET ${addSqlParameter(parameters, pageOffset)}::integer` : '';
  const lockClause = lock && entity !== 'Site' ? 'FOR UPDATE' : '';
  const totalColumn = includeTotal ? ', COUNT(*) OVER() AS total_count' : '';

  return {
    text: `SELECT normalized_record.*${totalColumn}
      FROM (${select}) normalized_record
      ${whereClause}
      ORDER BY ${orderClause}
      ${limitClause}
      ${offsetClause}
      ${lockClause}`,
    parameters,
    limit: pageSize,
    offset: pageOffset,
    fallback: false
  };
}

async function listNormalizedDocumentsInMemory(
  entity,
  { filters = {}, rangeFilters = {}, sort, limit, offset = 0, lock = false, location = null } = {},
  executor = pool
) {
  const select = normalizedSelectForEntity(entity);
  const mapper = normalizedMapper(entity);
  if (!select || !mapper) return null;
  const lockClause = lock && entity !== 'Site' ? 'FOR UPDATE' : '';
  const result = await query(`SELECT * FROM (${select}) normalized_record ${lockClause}`, [], executor);
  let records = result.rows.map(mapper);
  records = records.filter((record) => matchesFilter(record, filters));
  if (rangeFilters && typeof rangeFilters === 'object') {
    records = records.filter((record) => Object.entries(rangeFilters).every(([field, bounds]) => {
      const value = record[field];
      if (bounds?.gte && String(value || '') < String(bounds.gte)) return false;
      if (bounds?.lte && String(value || '') > String(bounds.lte)) return false;
      return true;
    }));
  }
  if (location && !location.unrestricted) {
    const allowed = new Set([...(location.accessibleSiteIds || [])].map(String));
    records = records.filter((record) => {
      if (entity === 'Site') return allowed.has(String(record.id));
      const siteIds = [record.site_id, record.fulfillment_store_id, record.warehouse_id]
        .filter(Boolean)
        .map(String);
      if (!siteIds.length && entity === 'Recipe' && record.site_scope === 'global') return true;
      return siteIds.length ? siteIds.every((siteId) => allowed.has(siteId)) : true;
    });
  }
  const ordered = normalizedOrder(records, sort);
  const start = Math.max(0, Number(offset) || 0);
  return typeof limit === 'number' ? ordered.slice(start, start + limit) : ordered.slice(start);
}

async function listNormalizedDocuments(
  entity,
  { filters = {}, rangeFilters = {}, sort, limit, offset = 0, lock = false, location = null } = {},
  executor = pool
) {
  const mapper = normalizedMapper(entity);
  if (!mapper) return null;
  const built = buildNormalizedListQuery({
    entity,
    filters,
    rangeFilters,
    sort,
    limit,
    offset,
    lock,
    location
  });
  if (!built || built.fallback) {
    return listNormalizedDocumentsInMemory(entity, {
      filters,
      rangeFilters,
      sort,
      limit,
      offset,
      lock,
      location
    }, executor);
  }
  const result = await query(built.text, built.parameters, executor);
  return result.rows.map(mapper);
}

async function listNormalizedDocumentsPage(
  entity,
  { filters = {}, rangeFilters = {}, sort, limit = 50, offset = 0, location = null } = {},
  executor = pool
) {
  const mapper = normalizedMapper(entity);
  if (!mapper) return null;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const built = buildNormalizedListQuery({
    entity,
    filters,
    rangeFilters,
    sort,
    limit: safeLimit,
    offset: safeOffset,
    location,
    includeTotal: true
  });
  if (!built || built.fallback) {
    const items = await listNormalizedDocumentsInMemory(entity, {
      filters,
      rangeFilters,
      sort,
      location
    }, executor);
    return {
      items: items.slice(safeOffset, safeOffset + safeLimit),
      total_count: items.length,
      limit: safeLimit,
      offset: safeOffset
    };
  }
  const result = await query(built.text, built.parameters, executor);
  let totalCount = result.rowCount ? Number(result.rows[0].total_count) : 0;
  if (!result.rowCount && safeOffset > 0) {
    const countProbe = buildNormalizedListQuery({
      entity,
      filters,
      rangeFilters,
      sort,
      limit: 1,
      offset: 0,
      location,
      includeTotal: true
    });
    if (countProbe && !countProbe.fallback) {
      const countResult = await query(countProbe.text, countProbe.parameters, executor);
      totalCount = countResult.rowCount ? Number(countResult.rows[0].total_count) : 0;
    }
  }
  return {
    items: result.rows.map(mapper),
    total_count: totalCount,
    limit: safeLimit,
    offset: safeOffset
  };
}

async function findNormalizedDocument(entity, id, executor = pool, lock = false) {
  const select = normalizedSelectForEntity(entity);
  const idColumn = normalizedIdColumn(entity);
  const mapper = normalizedMapper(entity);
  if (!select || !idColumn || !mapper) return null;
  const lockClause = lock && entity !== 'Site' ? 'FOR UPDATE' : '';
  const result = await query(
    `SELECT * FROM (${select}) normalized_record WHERE ${idColumn} = $1 LIMIT 1 ${lockClause}`,
    [id],
    executor
  );
  return result.rowCount ? mapper(result.rows[0]) : null;
}

async function insertOrUpdateNormalizedSite(record, existing = null, executor = pool) {
  const type = normalizeSiteType(record.type || existing?.type || SITE_HIERARCHY_TYPES.AREA);
  const createdAt = record.created_date || existing?.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  if (existing && normalizeSiteType(existing.type) !== type) {
    await deleteNormalizedDocument('Site', existing.id, executor);
  }
  if (type === SITE_HIERARCHY_TYPES.AREA) {
    await query(
      `INSERT INTO areas (area_id, area_code, name, legacy_site_id, status, source_name, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (area_id) DO UPDATE SET
         area_code = EXCLUDED.area_code, name = EXCLUDED.name, legacy_site_id = EXCLUDED.legacy_site_id,
         status = EXCLUDED.status, source_name = EXCLUDED.source_name, payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.area_code || record.project_code || null,
        record.name,
        record.legacy_site_id || record.id,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
  } else if (type === SITE_HIERARCHY_TYPES.PROJECT) {
    await query(
      `INSERT INTO projects (project_id, area_id, project_code, name, legacy_site_id, status, source_name, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (project_id) DO UPDATE SET
         area_id = EXCLUDED.area_id, project_code = EXCLUDED.project_code, name = EXCLUDED.name,
         legacy_site_id = EXCLUDED.legacy_site_id, status = EXCLUDED.status, source_name = EXCLUDED.source_name,
         payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.parent_site_id,
        record.project_code || null,
        record.name,
        record.legacy_site_id || record.id,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
  } else {
    await query(
      `INSERT INTO warehouses (warehouse_id, project_id, warehouse_code, d365_warehouse_id, name, legacy_site_id, status, source_name, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (warehouse_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, warehouse_code = EXCLUDED.warehouse_code,
         d365_warehouse_id = EXCLUDED.d365_warehouse_id, name = EXCLUDED.name,
         legacy_site_id = EXCLUDED.legacy_site_id, status = EXCLUDED.status, source_name = EXCLUDED.source_name,
         payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.parent_site_id,
        record.warehouse_code || record.project_code || null,
        record.d365_warehouse_id || null,
        record.name,
        record.legacy_site_id || record.id,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
  }
  return findNormalizedDocument('Site', record.id, executor);
}

async function insertOrUpdateNormalizedRecipe(record, existing = null, executor = pool) {
  const masterId = record.recipe_master_id || record.recipe_id || existing?.recipe_master_id || record.id;
  const createdAt = record.created_date || existing?.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  await query(
    `INSERT INTO recipes (recipe_id, canonical_name, description, status, source_name, payload, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (recipe_id) DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name, description = EXCLUDED.description,
       status = EXCLUDED.status, source_name = EXCLUDED.source_name,
       payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
    [
      masterId,
      record.canonical_name || record.name,
      record.description || null,
      record.status || (record.is_active === false ? 'inactive' : 'active'),
      record.source_name || null,
      jsonPayload(record),
      createdAt,
      updatedAt
    ],
    executor
  );
  const scopeIds = Array.isArray(record.site_ids) ? record.site_ids.filter(Boolean).map(String) : [];
  const scope = String(record.site_scope || '').toLowerCase();
  const warehouseId = record.warehouse_id || (scope === 'warehouse' || scope === 'store' ? scopeIds[0] : null);
  const projectId = record.project_id || (scope === 'project' ? scopeIds[0] : null);
  const areaId = record.area_id || (scope === 'area' ? scopeIds[0] : null);
  await query(
    `INSERT INTO recipe_versions (
      recipe_version_id, recipe_id, area_id, project_id, warehouse_id, recipe_code,
      display_name, version_label, cuisine_type, menu_category, serving_size_grams,
      batch_yield, total_recipe_weight_grams, total_cost, cost_per_serving,
      status, source_name, payload, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)
    ON CONFLICT (recipe_version_id) DO UPDATE SET
      recipe_id = EXCLUDED.recipe_id, area_id = EXCLUDED.area_id, project_id = EXCLUDED.project_id,
      warehouse_id = EXCLUDED.warehouse_id, recipe_code = EXCLUDED.recipe_code,
      display_name = EXCLUDED.display_name, version_label = EXCLUDED.version_label,
      cuisine_type = EXCLUDED.cuisine_type, menu_category = EXCLUDED.menu_category,
      serving_size_grams = EXCLUDED.serving_size_grams, batch_yield = EXCLUDED.batch_yield,
      total_recipe_weight_grams = EXCLUDED.total_recipe_weight_grams, total_cost = EXCLUDED.total_cost,
      cost_per_serving = EXCLUDED.cost_per_serving, status = EXCLUDED.status,
      source_name = EXCLUDED.source_name, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
    [
      record.id,
      masterId,
      areaId,
      projectId,
      warehouseId,
      record.recipe_code || null,
      record.name,
      record.version_label || 'v1',
      record.cuisine_type || null,
      record.menu_category || record.category || null,
      toNumberOrNull(record.portion_size_grams || record.serving_size_grams),
      toNumberOrZero(record.batch_yield) || 1,
      toNumberOrNull(record.total_recipe_weight_grams),
      toNumberOrZero(record.total_cost),
      toNumberOrZero(record.cost_per_serving),
      record.status || (record.is_active === false ? 'inactive' : 'active'),
      record.source_name || null,
      jsonPayload(record),
      createdAt,
      updatedAt
    ],
    executor
  );
  await query('DELETE FROM recipe_ingredient_lines WHERE recipe_version_id = $1', [record.id], executor);
  const lines = Array.isArray(record.ingredients) ? record.ingredients : [];
  for (const [index, line] of lines.entries()) {
    if (!line?.ingredient_id) continue;
    await query(
      `INSERT INTO recipe_ingredient_lines (
        recipe_line_id, recipe_version_id, ingredient_id, line_number, quantity, unit,
        converted_quantity, converted_unit, raw_weight_grams, yield_percent, yielded_weight_grams,
        cost, source_name, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        line.id || `${record.id}:line:${index + 1}`,
        record.id,
        line.ingredient_id,
        index + 1,
        toNumberOrZero(line.quantity),
        line.unit || 'EA',
        toNumberOrNull(line.converted_quantity),
        line.converted_unit || null,
        toNumberOrNull(line.raw_weight_grams),
        toNumberOrNull(line.yield_percent) ?? 100,
        toNumberOrNull(line.yielded_weight_grams),
        toNumberOrZero(line.cost ?? line.line_cost),
        line.source_name || record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
  }
  return findNormalizedDocument('Recipe', record.id, executor);
}

async function ensureProductionManifestLine(record, executor = pool) {
  const lineId = record.production_line_id || record.source_event_recipe_id || `${record.id}:line:1`;
  const existingLine = await query(
    'SELECT production_line_id FROM production_manifest_lines WHERE production_line_id = $1 LIMIT 1',
    [lineId],
    executor
  );
  if (existingLine.rowCount) return lineId;
  await query(
    `INSERT INTO production_manifest_lines (
      production_line_id, production_id, menu_plan_line_id, line_number, recipe_version_id,
      ingredient_id, item_name, requested_servings, requested_weight_grams, produced_servings,
      produced_weight_grams, estimated_cost, actual_cost, status, source_name, payload,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
    ON CONFLICT (production_line_id) DO NOTHING`,
    [
      lineId,
      record.id || record.production_id,
      record.menu_plan_line_id || null,
      1,
      record.recipe_id || null,
      record.ingredient_id || null,
      record.production_name || record.recipe_name || record.name || 'Production item',
      toNumberOrNull(record.target_servings || record.production_covers || record.produced_servings),
      toNumberOrNull(record.requested_weight_grams || record.production_size_grams),
      toNumberOrNull(record.produced_servings || record.production_covers),
      toNumberOrNull(record.produced_weight_grams || record.finished_weight_grams || record.production_size_grams),
      toNumberOrZero(record.estimated_cost || record.estimated_batch_cost),
      toNumberOrZero(record.actual_cost || record.production_cost_total || record.total_cost),
      'active',
      record.source_name || null,
      jsonPayload(record),
      record.created_date || nowIso(),
      record.updated_date || nowIso()
    ],
    executor
  );
  return lineId;
}

async function insertOrUpdateNormalizedDocument(entity, record, existing = null, executor = pool) {
  if (entity === 'Site') return insertOrUpdateNormalizedSite(record, existing, executor);
  if (entity === 'Recipe') return insertOrUpdateNormalizedRecipe(record, existing, executor);

  if (usesRelationalDocumentTable(entity)) {
    const table = quoteIdentifier(relationalDocumentTables[entity]);
    const createdAt = record.created_date || existing?.created_date || nowIso();
    const updatedAt = record.updated_date || nowIso();
    await query(
      `INSERT INTO ${table} (
        id, entity_name, site_id, site_name, from_site_id, to_site_id,
        site_ids, status, record_date, source_name, payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11::jsonb,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        site_id = EXCLUDED.site_id, site_name = EXCLUDED.site_name,
        from_site_id = EXCLUDED.from_site_id, to_site_id = EXCLUDED.to_site_id,
        site_ids = EXCLUDED.site_ids, status = EXCLUDED.status,
        record_date = EXCLUDED.record_date, source_name = EXCLUDED.source_name,
        payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        entity,
        relationalDocumentSiteId(record),
        record.site_name || record.warehouse_name || null,
        record.from_site_id || null,
        record.to_site_id || null,
        Array.isArray(record.site_ids) ? record.site_ids.map(String) : [],
        record.status || entityRegistry[entity]?.defaults?.status || 'active',
        relationalDocumentRecordDate(record),
        record.source_name || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }

  const config = normalizedSimpleConfigs[entity];
  if (config) {
    const sql = existing ? config.updateSql : config.insertSql;
    const values = existing ? config.updateValues(record) : config.values(record);
    await query(sql, values, executor);
    return findNormalizedDocument(entity, record.id, executor);
  }

  const createdAt = record.created_date || existing?.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  if (entity === 'MenuPlan') {
    await query(
      `INSERT INTO menu_plans (
        menu_plan_id, warehouse_id, plan_date, meal_period, menu_type, menu_category,
        status, source_name, created_by, payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
      ON CONFLICT (menu_plan_id) DO UPDATE SET
        warehouse_id = EXCLUDED.warehouse_id, plan_date = EXCLUDED.plan_date,
        meal_period = EXCLUDED.meal_period, menu_type = EXCLUDED.menu_type,
        menu_category = EXCLUDED.menu_category, status = EXCLUDED.status,
        source_name = EXCLUDED.source_name, created_by = EXCLUDED.created_by,
        payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.site_id || record.warehouse_id,
        toDateOnlyOrNull(record.plan_date),
        record.meal_type || 'all',
        record.menu_type || record.cuisine_type || 'general',
        record.menu_category || 'senior',
        record.status || 'planned',
        record.source_name || null,
        record.created_by || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'Production') {
    await query(
      `INSERT INTO production_events (
        production_id, menu_plan_id, warehouse_id, production_date, meal_period,
        menu_type, menu_category, status, issue_group_key, payload, started_by,
        completed_by, completed_at, reversed_by, reversed_at, reversal_reason,
        source_name, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (production_id) DO UPDATE SET
        menu_plan_id = EXCLUDED.menu_plan_id, warehouse_id = EXCLUDED.warehouse_id,
        production_date = EXCLUDED.production_date, meal_period = EXCLUDED.meal_period,
        menu_type = EXCLUDED.menu_type, menu_category = EXCLUDED.menu_category,
        status = EXCLUDED.status, issue_group_key = EXCLUDED.issue_group_key,
        payload = EXCLUDED.payload, started_by = EXCLUDED.started_by,
        completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at,
        reversed_by = EXCLUDED.reversed_by, reversed_at = EXCLUDED.reversed_at,
        reversal_reason = EXCLUDED.reversal_reason, source_name = EXCLUDED.source_name,
        updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.menu_plan_id || record.source_event_id || null,
        record.fulfillment_store_id || record.site_id || record.warehouse_id,
        toDateOnlyOrNull(record.production_date || record.date),
        record.meal_type || 'breakfast',
        record.menu_type || record.cuisine_type || 'general',
        record.menu_category || 'senior',
        record.status || 'planned',
        record.issue_group_key || record.id,
        jsonPayload(record),
        record.started_by || null,
        record.completed_by || null,
        record.completed_at || null,
        record.reversed_by || null,
        record.reversed_at || null,
        record.reversal_reason || null,
        record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
    await ensureProductionManifestLine(record, executor);
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'ProductionConsumptionReport') {
    await query(
      `INSERT INTO production_consumption_reports (
        report_id, report_number, production_id, warehouse_id, production_date,
        total_consumption_cost, total_shortage_cost, status, payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      ON CONFLICT (report_id) DO UPDATE SET
        report_number = EXCLUDED.report_number, production_id = EXCLUDED.production_id,
        warehouse_id = EXCLUDED.warehouse_id, production_date = EXCLUDED.production_date,
        total_consumption_cost = EXCLUDED.total_consumption_cost,
        total_shortage_cost = EXCLUDED.total_shortage_cost, status = EXCLUDED.status,
        payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.report_number,
        record.production_id,
        record.site_id || record.warehouse_id || null,
        toDateOnlyOrNull(record.production_date),
        toNumberOrZero(record.total_consumption_cost),
        toNumberOrZero(record.total_shortage_cost),
        record.status || 'posted',
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'ProducedItemBatch') {
    const productionLineId = await ensureProductionManifestLine({
      ...record,
      id: record.production_id,
      production_id: record.production_id,
      recipe_id: record.recipe_id,
      production_name: record.production_name || record.recipe_name
    }, executor);
    await query(
      `INSERT INTO produced_output_batches (
        output_batch_id, production_id, production_line_id, warehouse_id, recipe_version_id,
        ingredient_id, batch_number, initial_weight_grams, remaining_weight_grams,
        initial_servings, remaining_servings, unit_cost, total_cost, status, source_name,
        payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
      ON CONFLICT (output_batch_id) DO UPDATE SET
        production_id = EXCLUDED.production_id, production_line_id = EXCLUDED.production_line_id,
        warehouse_id = EXCLUDED.warehouse_id, recipe_version_id = EXCLUDED.recipe_version_id,
        ingredient_id = EXCLUDED.ingredient_id, batch_number = EXCLUDED.batch_number,
        initial_weight_grams = EXCLUDED.initial_weight_grams,
        remaining_weight_grams = EXCLUDED.remaining_weight_grams,
        initial_servings = EXCLUDED.initial_servings, remaining_servings = EXCLUDED.remaining_servings,
        unit_cost = EXCLUDED.unit_cost, total_cost = EXCLUDED.total_cost,
        status = EXCLUDED.status, source_name = EXCLUDED.source_name,
        payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.production_id,
        productionLineId,
        record.site_id || record.warehouse_id,
        record.recipe_id || null,
        record.ingredient_id || null,
        record.batch_number,
        toNumberOrZero(record.initial_weight_grams ?? record.produced_weight_grams),
        toNumberOrZero(record.remaining_weight_grams ?? record.available_weight_grams ?? record.produced_weight_grams),
        toNumberOrNull(record.initial_servings ?? record.produced_servings),
        toNumberOrNull(record.remaining_servings ?? record.available_servings ?? record.produced_servings),
        toNumberOrZero(record.unit_cost),
        toNumberOrZero(record.total_cost),
        record.status || 'active',
        record.source_name || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'MealServiceAttendance') {
    await query(
      `INSERT INTO meal_service_headers (
        meal_service_id, service_reference, idempotency_key, warehouse_id, service_date,
        meal_period, menu_type, menu_category, serving_size_grams, covers, status,
        payload, posted_by, reversed_by, reversed_at, source_name, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (meal_service_id) DO UPDATE SET
        service_reference = EXCLUDED.service_reference, idempotency_key = EXCLUDED.idempotency_key,
        warehouse_id = EXCLUDED.warehouse_id, service_date = EXCLUDED.service_date,
        meal_period = EXCLUDED.meal_period, menu_type = EXCLUDED.menu_type,
        menu_category = EXCLUDED.menu_category, serving_size_grams = EXCLUDED.serving_size_grams,
        covers = EXCLUDED.covers, status = EXCLUDED.status, payload = EXCLUDED.payload,
        posted_by = EXCLUDED.posted_by, reversed_by = EXCLUDED.reversed_by,
        reversed_at = EXCLUDED.reversed_at, source_name = EXCLUDED.source_name,
        updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.service_reference,
        record.idempotency_key,
        record.site_id || record.warehouse_id,
        toDateOnlyOrNull(record.service_date),
        record.meal_type || 'breakfast',
        record.menu_type || 'general',
        record.menu_category || 'senior',
        toNumberOrZero(record.serving_size_grams || record.portion_size_grams),
        toNumberOrZero(record.covers || record.attendee_count),
        record.status || 'posted',
        jsonPayload(record),
        record.posted_by || record.performed_by || null,
        record.reversed_by || null,
        record.reversed_at || null,
        record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'MealServiceConsumption') {
    const allocation = Array.isArray(record.allocations) ? record.allocations[0] || {} : {};
    await query(
      `INSERT INTO meal_service_consumptions (
        meal_consumption_id, meal_service_id, output_batch_id, production_id, recipe_version_id,
        reverses_consumption_id, idempotency_key, service_reference, movement_type, service_date, meal_period,
        consumed_weight_grams, consumed_servings, cost, status, payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
      ON CONFLICT (meal_consumption_id) DO UPDATE SET
        meal_service_id = EXCLUDED.meal_service_id, output_batch_id = EXCLUDED.output_batch_id,
        production_id = EXCLUDED.production_id, recipe_version_id = EXCLUDED.recipe_version_id,
        reverses_consumption_id = EXCLUDED.reverses_consumption_id,
        idempotency_key = EXCLUDED.idempotency_key, service_reference = EXCLUDED.service_reference,
        movement_type = EXCLUDED.movement_type, service_date = EXCLUDED.service_date,
        meal_period = EXCLUDED.meal_period, consumed_weight_grams = EXCLUDED.consumed_weight_grams,
        consumed_servings = EXCLUDED.consumed_servings, cost = EXCLUDED.cost,
        status = EXCLUDED.status, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.meal_service_attendance_id,
        record.produced_item_batch_id || allocation.produced_item_batch_id || allocation.batch_id || null,
        record.production_id || allocation.production_id || null,
        record.recipe_id || null,
        record.reverses_consumption_id || record.source_consumption_id || record.original_consumption_id || null,
        record.idempotency_key,
        record.service_reference,
        record.movement_type || 'consumption',
        toDateOnlyOrNull(record.service_date),
        record.meal_type || null,
        toNumberOrZero(record.consumed_weight_grams || record.required_weight_grams),
        toNumberOrZero(record.consumed_servings || record.required_servings),
        toNumberOrZero(record.cost || record.total_cost),
        record.status || 'posted',
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'FoodWaste') {
    await query(
      `INSERT INTO food_waste_records (
        food_waste_id, waste_reference, idempotency_key, warehouse_id, waste_date, meal_period,
        menu_type, menu_category, waste_category, reason_code, approval_status, status,
        recorded_by, reversed_by, reversed_at, reversal_reason, source_name, payload,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)
      ON CONFLICT (food_waste_id) DO UPDATE SET
        waste_reference = EXCLUDED.waste_reference, idempotency_key = EXCLUDED.idempotency_key,
        warehouse_id = EXCLUDED.warehouse_id, waste_date = EXCLUDED.waste_date,
        meal_period = EXCLUDED.meal_period, menu_type = EXCLUDED.menu_type,
        menu_category = EXCLUDED.menu_category, waste_category = EXCLUDED.waste_category,
        reason_code = EXCLUDED.reason_code, approval_status = EXCLUDED.approval_status,
        status = EXCLUDED.status, recorded_by = EXCLUDED.recorded_by,
        reversed_by = EXCLUDED.reversed_by, reversed_at = EXCLUDED.reversed_at,
        reversal_reason = EXCLUDED.reversal_reason, source_name = EXCLUDED.source_name,
        payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.waste_reference || record.service_reference || null,
        record.idempotency_key || null,
        record.site_id || record.warehouse_id,
        toDateOnlyOrNull(record.waste_date),
        record.meal_type || null,
        record.menu_type || null,
        record.menu_category || null,
        record.waste_category || 'ingredient',
        record.reason_code || null,
        record.approval_status || 'pending',
        record.status || 'posted',
        record.recorded_by || null,
        record.reversed_by || null,
        record.reversed_at || null,
        record.reversal_reason || null,
        record.source_name || null,
        jsonPayload(record),
        createdAt,
        updatedAt
      ],
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  return null;
}

async function createNormalizedDocument(entity, record, executor = pool) {
  return insertOrUpdateNormalizedDocument(entity, record, null, executor);
}

async function updateNormalizedDocument(entity, id, record, existing, executor = pool) {
  return insertOrUpdateNormalizedDocument(entity, { ...record, id }, existing, executor);
}

async function deleteNormalizedDocument(entity, id, executor = pool) {
  if (entity === 'Site') {
    const existing = await findNormalizedDocument('Site', id, executor, true);
    if (!existing) return false;
    const type = normalizeSiteType(existing.type);
    const table = type === SITE_HIERARCHY_TYPES.AREA
      ? 'areas'
      : type === SITE_HIERARCHY_TYPES.PROJECT
        ? 'projects'
        : 'warehouses';
    const idColumn = type === SITE_HIERARCHY_TYPES.AREA
      ? 'area_id'
      : type === SITE_HIERARCHY_TYPES.PROJECT
        ? 'project_id'
        : 'warehouse_id';
    const result = await query(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id], executor);
    return result.rowCount > 0;
  }
  if (entity === 'Recipe') {
    const result = await query('DELETE FROM recipe_versions WHERE recipe_version_id = $1', [id], executor);
    return result.rowCount > 0;
  }
  if (usesRelationalDocumentTable(entity)) {
    const result = await query(
      `DELETE FROM ${quoteIdentifier(relationalDocumentTables[entity])} WHERE id = $1`,
      [id],
      executor
    );
    return result.rowCount > 0;
  }
  const config = normalizedSimpleConfigs[entity];
  if (config) {
    const result = await query(`DELETE FROM ${config.table} WHERE ${config.idColumn} = $1`, [id], executor);
    return result.rowCount > 0;
  }
  const tableByEntity = {
    MenuPlan: ['menu_plans', 'menu_plan_id'],
    Production: ['production_events', 'production_id'],
    ProductionConsumptionReport: ['production_consumption_reports', 'report_id'],
    ProducedItemBatch: ['produced_output_batches', 'output_batch_id'],
    MealServiceAttendance: ['meal_service_headers', 'meal_service_id'],
    MealServiceConsumption: ['meal_service_consumptions', 'meal_consumption_id'],
    FoodWaste: ['food_waste_records', 'food_waste_id']
  };
  const target = tableByEntity[entity];
  if (!target) return false;
  const result = await query(`DELETE FROM ${target[0]} WHERE ${target[1]} = $1`, [id], executor);
  return result.rowCount > 0;
}

async function query(text, params = [], executor = pool) {
  return executor.query(text, params);
}

async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const singleReferenceTargets = new Map([
  ['site_id', 'Site'],
  ['requesting_site_id', 'Site'],
  ['fulfillment_store_id', 'Site'],
  ['from_site_id', 'Site'],
  ['to_site_id', 'Site'],
  ['parent_site_id', 'Site'],
  ['ingredient_id', 'Ingredient'],
  ['recipe_id', 'Recipe'],
  ['budget_id', 'Budget'],
  ['menu_plan_id', 'MenuPlan'],
  ['source_event_id', 'MenuPlan'],
  ['production_id', 'Production'],
  ['produced_item_batch_id', 'ProducedItemBatch'],
  ['meal_service_attendance_id', 'MealServiceAttendance'],
  ['customer_meal_plan_id', 'CustomerMealPlan'],
  ['reverses_consumption_id', 'MealServiceConsumption'],
  ['batch_id', 'ProductionBatch'],
  ['source_production_id', 'Production'],
  ['linked_material_request_id', 'MaterialRequest'],
  ['inventory_lot_id', 'InventoryLot'],
  ['scenario_id', 'ForecastScenario'],
  ['latest_snapshot_id', 'ForecastSnapshot']
]);

const arrayReferenceTargets = new Map([
  ['site_ids', 'Site'],
  ['allowed_site_ids', 'Site'],
  ['production_plan_ids', 'Production']
]);

const opaqueDocumentFields = new Set([
  'data_mapping',
  'payload',
  'raw_payload',
  'request_payload',
  'response_payload',
  'settings'
]);

function collectDocumentReferences(value, references = [], pathPrefix = '') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectDocumentReferences(entry, references, `${pathPrefix}[${index}]`));
    return references;
  }

  if (!value || typeof value !== 'object') {
    return references;
  }

  Object.entries(value).forEach(([field, nestedValue]) => {
    const pathName = pathPrefix ? `${pathPrefix}.${field}` : field;
    const singleTarget = singleReferenceTargets.get(field);
    const arrayTarget = arrayReferenceTargets.get(field);

    if (opaqueDocumentFields.has(field)) {
      return;
    }

    if (singleTarget && nestedValue !== null && typeof nestedValue !== 'undefined' && String(nestedValue).trim()) {
      references.push({
        targetEntity: singleTarget,
        id: String(nestedValue).trim(),
        path: pathName
      });
      return;
    }

    if (arrayTarget && Array.isArray(nestedValue)) {
      nestedValue
        .filter((entry) => entry !== null && typeof entry !== 'undefined' && String(entry).trim())
        .forEach((entry, index) => references.push({
          targetEntity: arrayTarget,
          id: String(entry).trim(),
          path: `${pathName}[${index}]`
        }));
      return;
    }

    collectDocumentReferences(nestedValue, references, pathName);
  });

  return references;
}

async function validateDocumentRelationships(entity, record, currentId = null, executor = pool) {
  const references = collectDocumentReferences(record);
  const uniqueReferences = new Map();
  let directSiteParent = null;

  references.forEach((reference) => {
    uniqueReferences.set(`${reference.targetEntity}:${reference.id}`, reference);
  });

  if (entity === 'Site') {
    await query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['site-hierarchy'],
      executor
    );
  }

  if (entity === 'Site' && record.parent_site_id) {
    const siteId = String(currentId || record.id || '');
    const visited = new Set(siteId ? [siteId] : []);
    let parentId = String(record.parent_site_id);

    while (parentId) {
      if (visited.has(parentId)) {
        const error = new Error('Site hierarchy cannot contain a cycle');
        error.status = 409;
        throw error;
      }
      visited.add(parentId);
      const parent = await findDocument('Site', parentId, executor);
      if (!parent) {
        break;
      }
      if (!directSiteParent) directSiteParent = parent;
      parentId = parent.parent_site_id ? String(parent.parent_site_id) : '';
    }
  }

  if (entity === 'Site' && isCanonicalSiteType(record.type)) {
    const hierarchyError = validateCanonicalSiteParent({
      type: record.type,
      parent: directSiteParent,
      parentId: record.parent_site_id
    });
    if (hierarchyError) {
      const error = new Error(hierarchyError);
      error.status = 409;
      throw error;
    }
  }

  const orderedReferences = [...uniqueReferences.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, reference]) => reference);

  for (const reference of orderedReferences) {
    if (
      reference.targetEntity === entity &&
      reference.id === String(currentId || record.id || '')
    ) {
      const error = new Error(`${reference.path} cannot reference the same ${entity} record`);
      error.status = 409;
      throw error;
    }

    await query(
      'SELECT pg_advisory_xact_lock_shared(hashtext($1))',
      [`entity-reference:${reference.targetEntity}:${reference.id}`],
      executor
    );
    const target = await findDocument(reference.targetEntity, reference.id, executor);
    if (!target) {
      const error = new Error(
        `${reference.path} references a missing ${reference.targetEntity} record (${reference.id})`
      );
      error.status = 409;
      throw error;
    }
  }
}

async function validateSiteChildrenAfterStructureChange(existing, record, executor = pool) {
  if (!existing || !record) return;
  const typeChanged = String(existing.type || '') !== String(record.type || '');
  const parentChanged = String(existing.parent_site_id || '') !== String(record.parent_site_id || '');
  if (!typeChanged && !parentChanged) return;

  if (usesNormalizedCore('Site')) {
    const children = (await listNormalizedDocuments('Site', {
      filters: { parent_site_id: String(record.id) }
    }, executor)) || [];
    const hierarchyError = validateSiteChildrenForParent(record, children);
    if (hierarchyError) {
      const error = new Error(hierarchyError);
      error.status = 409;
      throw error;
    }
    return;
  }

  const result = await query(
    `SELECT data
       FROM entity_records
      WHERE entity_name = 'Site'
        AND data->>'parent_site_id' = $1
      FOR SHARE`,
    [String(record.id)],
    executor
  );
  const hierarchyError = validateSiteChildrenForParent(
    record,
    result.rows.map((row) => row.data)
  );
  if (hierarchyError) {
    const error = new Error(hierarchyError);
    error.status = 409;
    throw error;
  }
}

const normalizedReferenceChecks = {
  Site: [
    {
      label: 'user location assignment',
      sql: `SELECT id FROM users
            WHERE site_id = $1
               OR COALESCE(profile->'allowed_site_ids', '[]'::jsonb) ? $1
            LIMIT 1`
    },
    { label: 'POS source', sql: 'SELECT id FROM pos_sources WHERE default_site_id = $1 LIMIT 1' },
    { label: 'POS sales order', sql: 'SELECT id FROM pos_sales_orders WHERE site_id = $1 LIMIT 1' },
    { label: 'POS sales item', sql: 'SELECT id FROM pos_sales_items WHERE site_id = $1 LIMIT 1' },
    { label: 'POS recipe mapping', sql: 'SELECT id FROM pos_recipe_mapping WHERE site_id = $1 LIMIT 1' },
    { label: 'purchase request', sql: 'SELECT id FROM purchase_requests WHERE site_id = $1 LIMIT 1' },
    { label: 'purchase order', sql: 'SELECT id FROM purchase_orders WHERE site_id = $1 LIMIT 1' },
    { label: 'goods receipt', sql: 'SELECT id FROM goods_receipts WHERE site_id = $1 LIMIT 1' },
    { label: 'supplier price history', sql: 'SELECT id FROM supplier_price_history WHERE site_id = $1 LIMIT 1' },
    { label: 'project', sql: 'SELECT project_id AS id FROM projects WHERE area_id = $1 LIMIT 1' },
    { label: 'warehouse', sql: 'SELECT warehouse_id AS id FROM warehouses WHERE project_id = $1 LIMIT 1' },
    { label: 'warehouse inventory', sql: 'SELECT inventory_id AS id FROM warehouse_inventory WHERE warehouse_id = $1 LIMIT 1' },
    { label: 'inventory lot', sql: 'SELECT lot_id AS id FROM inventory_lots WHERE warehouse_id = $1 LIMIT 1' },
    { label: 'menu plan', sql: 'SELECT menu_plan_id AS id FROM menu_plans WHERE warehouse_id = $1 LIMIT 1' },
    { label: 'production event', sql: 'SELECT production_id AS id FROM production_events WHERE warehouse_id = $1 LIMIT 1' },
    { label: 'produced output batch', sql: 'SELECT output_batch_id AS id FROM produced_output_batches WHERE warehouse_id = $1 LIMIT 1' },
    { label: 'meal service', sql: 'SELECT meal_service_id AS id FROM meal_service_headers WHERE warehouse_id = $1 LIMIT 1' },
    { label: 'food waste record', sql: 'SELECT food_waste_id AS id FROM food_waste_records WHERE warehouse_id = $1 LIMIT 1' }
  ],
  Ingredient: [
    { label: 'purchase request item', sql: 'SELECT id FROM purchase_request_items WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'purchase order item', sql: 'SELECT id FROM purchase_order_items WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'goods receipt item', sql: 'SELECT id FROM goods_receipt_items WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'supplier price history', sql: 'SELECT id FROM supplier_price_history WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'warehouse inventory', sql: 'SELECT inventory_id AS id FROM warehouse_inventory WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'inventory lot', sql: 'SELECT lot_id AS id FROM inventory_lots WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'recipe ingredient line', sql: 'SELECT recipe_line_id AS id FROM recipe_ingredient_lines WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'production manifest line', sql: 'SELECT production_line_id AS id FROM production_manifest_lines WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'production consumption line', sql: 'SELECT consumption_line_id AS id FROM production_consumption_lines WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'produced output batch', sql: 'SELECT output_batch_id AS id FROM produced_output_batches WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'food waste line', sql: 'SELECT food_waste_line_id AS id FROM food_waste_lines WHERE ingredient_id = $1 LIMIT 1' }
  ],
  Recipe: [
    { label: 'POS recipe mapping', sql: 'SELECT id FROM pos_recipe_mapping WHERE recipe_id = $1 LIMIT 1' },
    { label: 'POS sales item', sql: 'SELECT id FROM pos_sales_items WHERE recipe_id = $1 LIMIT 1' },
    { label: 'recipe ingredient line', sql: 'SELECT recipe_line_id AS id FROM recipe_ingredient_lines WHERE recipe_version_id = $1 LIMIT 1' },
    { label: 'menu plan line', sql: 'SELECT menu_plan_line_id AS id FROM menu_plan_lines WHERE recipe_version_id = $1 LIMIT 1' },
    { label: 'production manifest line', sql: 'SELECT production_line_id AS id FROM production_manifest_lines WHERE recipe_version_id = $1 LIMIT 1' },
    { label: 'produced output batch', sql: 'SELECT output_batch_id AS id FROM produced_output_batches WHERE recipe_version_id = $1 LIMIT 1' },
    { label: 'meal service consumption', sql: 'SELECT meal_consumption_id AS id FROM meal_service_consumptions WHERE recipe_version_id = $1 LIMIT 1' }
  ]
};

const siteSubtreeReferenceChecks = Object.freeze([
  {
    key: 'user_location_assignments',
    label: 'user location assignments',
    table: 'users',
    sql: `SELECT id FROM users
           WHERE site_id = ANY($1::text[])
              OR COALESCE(profile->'allowed_site_ids', '[]'::jsonb) ?| $1::text[]
           FOR SHARE`
  },
  {
    key: 'pos_sources',
    label: 'POS sources',
    table: 'pos_sources',
    sql: `SELECT id FROM pos_sources
           WHERE default_site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'pos_sales_orders',
    label: 'POS sales orders',
    table: 'pos_sales_orders',
    sql: `SELECT id FROM pos_sales_orders
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'pos_sales_items',
    label: 'POS sales items',
    table: 'pos_sales_items',
    sql: `SELECT id FROM pos_sales_items
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'pos_recipe_mappings',
    label: 'POS recipe mappings',
    table: 'pos_recipe_mapping',
    sql: `SELECT id FROM pos_recipe_mapping
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'purchase_requests',
    label: 'purchase requests',
    table: 'purchase_requests',
    sql: `SELECT id FROM purchase_requests
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'purchase_orders',
    label: 'purchase orders',
    table: 'purchase_orders',
    sql: `SELECT id FROM purchase_orders
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'goods_receipts',
    label: 'goods receipts',
    table: 'goods_receipts',
    sql: `SELECT id FROM goods_receipts
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'supplier_price_history',
    label: 'supplier price history',
    table: 'supplier_price_history',
    sql: `SELECT id FROM supplier_price_history
           WHERE site_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'warehouse_inventory',
    label: 'warehouse inventory',
    table: 'warehouse_inventory',
    sql: `SELECT inventory_id AS id FROM warehouse_inventory
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'inventory_lots',
    label: 'inventory lots',
    table: 'inventory_lots',
    sql: `SELECT lot_id AS id FROM inventory_lots
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'inventory_transactions',
    label: 'inventory transactions',
    table: 'inventory_transactions',
    sql: `SELECT inventory_transaction_id AS id FROM inventory_transactions
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'menu_plans',
    label: 'menu plans',
    table: 'menu_plans',
    sql: `SELECT menu_plan_id AS id FROM menu_plans
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'production_events',
    label: 'production events',
    table: 'production_events',
    sql: `SELECT production_id AS id FROM production_events
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'produced_output_batches',
    label: 'produced output batches',
    table: 'produced_output_batches',
    sql: `SELECT output_batch_id AS id FROM produced_output_batches
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'meal_service_headers',
    label: 'meal services',
    table: 'meal_service_headers',
    sql: `SELECT meal_service_id AS id FROM meal_service_headers
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  },
  {
    key: 'food_waste_records',
    label: 'food waste records',
    table: 'food_waste_records',
    sql: `SELECT food_waste_id AS id FROM food_waste_records
           WHERE warehouse_id = ANY($1::text[])
           FOR SHARE`
  }
]);

async function getExternalSiteSubtreeDependencies(siteIds, executor) {
  const subtreeIds = [...new Set((siteIds || []).map(String))].sort();
  const subtreeIdSet = new Set(subtreeIds);
  const groupedDocumentDependencies = new Map();
  const legacyDocumentRows = await query(
    `SELECT id, entity_name, data
       FROM entity_records
      WHERE NOT (entity_name = 'Site' AND id = ANY($1::text[]))
      FOR SHARE`,
    [subtreeIds],
    executor
  );
  const relationalDocumentRows = await listRelationalDocumentReferenceRows(executor);
  const documentRows = [
    ...legacyDocumentRows.rows,
    ...relationalDocumentRows
  ];

  for (const row of documentRows) {
    if (row.entity_name === 'Site' && subtreeIdSet.has(String(row.id))) continue;
    const matchingReferences = collectDocumentReferences(row.data).filter((reference) => (
      reference.targetEntity === 'Site' && subtreeIdSet.has(String(reference.id))
    ));
    if (!matchingReferences.length) continue;

    const key = `entity_records:${row.entity_name}`;
    const dependency = groupedDocumentDependencies.get(key) || {
      key,
      label: `${row.entity_name} records`,
      source: 'entity_records',
      entity_name: row.entity_name,
      count: 0,
      reference_count: 0,
      sample_ids: [],
      referenced_site_ids: []
    };
    dependency.count += 1;
    dependency.reference_count += matchingReferences.length;
    if (dependency.sample_ids.length < 5) dependency.sample_ids.push(String(row.id));
    dependency.referenced_site_ids = [...new Set([
      ...dependency.referenced_site_ids,
      ...matchingReferences.map((reference) => String(reference.id))
    ])].sort();
    groupedDocumentDependencies.set(key, dependency);
  }

  const normalizedDependencies = [];
  for (const check of siteSubtreeReferenceChecks) {
    const result = await query(check.sql, [subtreeIds], executor);
    const aggregateCount = result.rows[0]?.dependency_count;
    const count = Number(
      aggregateCount === null || typeof aggregateCount === 'undefined'
        ? (result.rowCount ?? result.rows.length ?? 0)
        : aggregateCount
    );
    if (count <= 0) continue;
    const aggregateSampleIds = result.rows[0]?.sample_ids;
    normalizedDependencies.push({
      key: check.key,
      label: check.label,
      source: check.table,
      count,
      sample_ids: Array.isArray(aggregateSampleIds)
        ? aggregateSampleIds.slice(0, 5).map(String)
        : result.rows.slice(0, 5).map((row) => String(row.id))
    });
  }

  return [
    ...groupedDocumentDependencies.values(),
    ...normalizedDependencies
  ].sort((left, right) => left.key.localeCompare(right.key));
}

async function deleteSiteSubtreeWithExecutor(rootId, executor) {
  const normalizedRootId = String(rootId || '').trim();
  if (!normalizedRootId) {
    const error = new Error('A root Site ID is required');
    error.status = 400;
    error.code = 'SITE_ID_REQUIRED';
    throw error;
  }

  await query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    ['site-hierarchy'],
    executor
  );
  const sites = usesNormalizedCore('Site')
    ? (await listNormalizedDocuments('Site', {}, executor)).map((site) => ({ ...site, id: String(site.id) }))
    : (await query(
      `SELECT id, data
         FROM entity_records
        WHERE entity_name = 'Site'
        FOR UPDATE`,
      [],
      executor
    )).rows.map((row) => ({
      ...(row.data && typeof row.data === 'object' ? row.data : {}),
      id: String(row.data?.id || row.id)
    }));
  const siteById = new Map(sites.map((site) => [String(site.id), site]));
  if (!siteById.has(normalizedRootId)) {
    const error = new Error('Site not found');
    error.status = 404;
    error.code = 'SITE_NOT_FOUND';
    error.details = { root_site_id: normalizedRootId };
    throw error;
  }

  const childrenByParentId = new Map();
  for (const site of sites) {
    const parentId = String(site.parent_site_id || '').trim();
    if (!parentId) continue;
    if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
    childrenByParentId.get(parentId).push(site);
  }

  const subtree = [];
  const visited = new Set();
  const queue = [siteById.get(normalizedRootId)];
  while (queue.length > 0) {
    const site = queue.shift();
    const siteId = String(site?.id || '');
    if (!siteId || visited.has(siteId)) continue;
    visited.add(siteId);
    subtree.push(site);
    queue.push(...(childrenByParentId.get(siteId) || []));
  }

  const subtreeIds = subtree.map((site) => String(site.id)).sort();
  for (const siteId of subtreeIds) {
    await query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`entity-reference:Site:${siteId}`],
      executor
    );
  }

  // The normalized operational tables do not use entity_records relationship
  // validation. A brief SHARE lock prevents a new Site reference from being
  // inserted between the dependency check and subtree deletion.
  const normalizedTables = [...new Set(siteSubtreeReferenceChecks.map((check) => check.table))];
  await query(
    `LOCK TABLE ${normalizedTables.join(', ')} IN SHARE MODE`,
    [],
    executor
  );

  const dependencies = await getExternalSiteSubtreeDependencies(subtreeIds, executor);
  if (dependencies.length > 0) {
    const dependencyCount = dependencies.reduce((sum, dependency) => sum + Number(dependency.count || 0), 0);
    const error = new Error(
      `Site hierarchy cannot be deleted because ${dependencyCount} external record${dependencyCount === 1 ? '' : 's'} still reference it.`
    );
    error.status = 409;
    error.code = 'SITE_IN_USE';
    error.details = {
      root_site_id: normalizedRootId,
      subtree_count: subtree.length,
      subtree_site_ids: subtreeIds,
      dependency_count: dependencyCount,
      blockers: dependencies,
      dependencies
    };
    throw error;
  }

  let deletedCount = 0;
  if (usesNormalizedCore('Site')) {
    const storeIds = subtree
      .filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE)
      .map((site) => String(site.id));
    const projectIds = subtree
      .filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT)
      .map((site) => String(site.id));
    const areaIds = subtree
      .filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.AREA)
      .map((site) => String(site.id));
    if (storeIds.length) {
      deletedCount += (await query(
        'DELETE FROM warehouses WHERE warehouse_id = ANY($1::text[])',
        [storeIds],
        executor
      )).rowCount;
    }
    if (projectIds.length) {
      deletedCount += (await query(
        'DELETE FROM projects WHERE project_id = ANY($1::text[])',
        [projectIds],
        executor
      )).rowCount;
    }
    if (areaIds.length) {
      deletedCount += (await query(
        'DELETE FROM areas WHERE area_id = ANY($1::text[])',
        [areaIds],
        executor
      )).rowCount;
    }
  } else {
    const deleteResult = await query(
      `DELETE FROM entity_records
        WHERE entity_name = 'Site'
          AND id = ANY($1::text[])
        RETURNING id`,
      [subtreeIds],
      executor
    );
    deletedCount = deleteResult.rowCount;
  }
  if (deletedCount !== subtree.length) {
    const error = new Error('Site hierarchy changed while it was being deleted. Retry the operation.');
    error.status = 409;
    error.code = 'SITE_DELETE_CONFLICT';
    error.details = {
      root_site_id: normalizedRootId,
      expected_count: subtree.length,
      deleted_count: deletedCount
    };
    throw error;
  }

  return {
    root_site_id: normalizedRootId,
    deleted_count: deletedCount,
    deleted_site_ids: subtreeIds,
    deleted_sites: subtree
  };
}

async function deleteSiteSubtree(rootId, executor = null) {
  if (executor) return deleteSiteSubtreeWithExecutor(rootId, executor);
  return withTransaction((client) => deleteSiteSubtreeWithExecutor(rootId, client));
}

async function ensureDocumentNotReferenced(entity, id, executor = pool) {
  if (entity === 'Site') {
    await query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['site-hierarchy'],
      executor
    );
  }

  await query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`entity-reference:${entity}:${id}`],
    executor
  );

  const legacyDocumentRows = await query(
    `SELECT id, entity_name, data
     FROM entity_records
     WHERE NOT (entity_name = $1 AND id = $2)
     FOR SHARE`,
    [entity, id],
    executor
  );
  const relationalDocumentRows = await listRelationalDocumentReferenceRows(executor);
  const documentRows = [
    ...legacyDocumentRows.rows,
    ...relationalDocumentRows.filter((row) => !(row.entity_name === entity && row.id === id))
  ];

  const documentReference = documentRows.find((row) =>
    collectDocumentReferences(row.data).some((reference) =>
      reference.targetEntity === entity && reference.id === String(id)
    )
  );

  if (documentReference) {
    const error = new Error(
      `${entity} ${id} is still referenced by ${documentReference.entity_name} ${documentReference.id}`
    );
    error.status = 409;
    throw error;
  }

  for (const check of normalizedReferenceChecks[entity] || []) {
    const result = await query(check.sql, [id], executor);
    if (result.rowCount > 0) {
      const error = new Error(`${entity} ${id} is still referenced by a ${check.label}`);
      error.status = 409;
      throw error;
    }
  }
}

async function initDatabase() {
  await ensureDatabaseExists();
  const sqlPath = path.join(rootDir, 'server', 'sql', 'init.sql');
  const sql = await fs.readFile(sqlPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['foodpro_schema_initialization']);
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query({ text: sql, query_timeout: 0 });
    await normalizeStoredManagementRoleProfiles(client);
    await ensureAdminAccounts(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function normalizeStoredManagementRoleProfiles(executor = pool) {
  const result = usesNormalizedCore('RoleProfile')
    ? await query(
      `SELECT id, payload AS data
         FROM role_profiles`,
      [],
      executor
    )
    : await query(
      `SELECT id, data
         FROM entity_records
        WHERE entity_name = 'RoleProfile'`,
      [],
      executor
    );
  for (const row of result.rows) {
    const normalized = normalizeManagementRoleProfile(row.data);
    if (normalized === row.data || JSON.stringify(normalized) === JSON.stringify(row.data)) continue;
    const next = { ...normalized, updated_date: nowIso() };
    if (usesNormalizedCore('RoleProfile')) {
      await query(
        `UPDATE role_profiles
            SET payload = $2::jsonb,
                updated_at = $3
          WHERE id = $1`,
        [row.id, JSON.stringify(next), next.updated_date],
        executor
      );
    } else {
      await query(
        `UPDATE entity_records
            SET data = $2::jsonb,
                updated_at = $3
          WHERE id = $1 AND entity_name = 'RoleProfile'`,
        [row.id, JSON.stringify(next), next.updated_date],
        executor
      );
    }
  }
}

async function ensureAdminAccounts(executor = pool) {
  const adminAccounts = [
    {
      email: process.env.ADMIN_EMAIL || 'humayoonkhizar12@gmail.com',
      password: process.env.ADMIN_PASSWORD || 'Tafga@2030',
      fullName: process.env.ADMIN_NAME || 'Humayun Khizar'
    },
    {
      email: process.env.SECOND_ADMIN_EMAIL || 'abutt@al-tamimi.com',
      password: process.env.SECOND_ADMIN_PASSWORD || 'Atb14@1978',
      fullName: process.env.SECOND_ADMIN_NAME || 'Abutt'
    }
  ];

  for (const admin of adminAccounts) {
    const passwordHash = bcrypt.hashSync(admin.password, 10);
    const existingUser = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [admin.email], executor);

    if (existingUser.rowCount > 0) {
      await query(
        `UPDATE users
         SET full_name = $2,
             role = 'admin',
             status = CASE
               WHEN LOWER(COALESCE(status, 'active')) IN ('deactivated', 'disabled', 'inactive', 'deleted') THEN status
               ELSE 'active'
             END,
             password_hash = $3,
             updated_at = NOW()
         WHERE email = $1`,
        [admin.email, admin.fullName, passwordHash],
        executor
      );
      continue;
    }

    await query(
      `INSERT INTO users (id, email, full_name, role, status, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', 'active', $4, NOW(), NOW())`,
      [randomId('user'), admin.email, admin.fullName, passwordHash],
      executor
    );
  }

  const seededUsers = [
    {
      email: 'patric.s@al-tamimi.com',
      fullName: 'Patric S',
      password: 'Init@2030',
      role: 'user'
    }
  ];

  for (const seededUser of seededUsers) {
    const existingSeededUser = await query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [seededUser.email],
      executor
    );

    if (existingSeededUser.rowCount === 0) {
      await query(
        `INSERT INTO users (id, email, full_name, role, status, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW())`,
        [
          randomId('user'),
          seededUser.email,
          seededUser.fullName,
          seededUser.role,
          bcrypt.hashSync(seededUser.password, 10)
        ],
        executor
      );
    }
  }
}

async function listUsers(executor = pool) {
  const result = await query('SELECT * FROM users ORDER BY updated_at DESC', [], executor);
  return Promise.all(result.rows.map(async (row) => sanitizeUser(await hydrateUserRole(toUserRecord(row), executor))));
}

async function findUserById(id, executor = pool) {
  const result = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id], executor);
  return result.rowCount ? hydrateUserRole(toUserRecord(result.rows[0]), executor) : null;
}

async function findUserByEmail(email, executor = pool) {
  const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email], executor);
  return result.rowCount ? hydrateUserRole(toUserRecord(result.rows[0]), executor) : null;
}

async function createUser(data, executor = pool) {
  const existing = await findUserByEmail(data.email, executor);
  if (existing) {
    const error = new Error('User already exists');
    error.status = 409;
    throw error;
  }

  const id = data.id || randomId('user');
  const timestamp = nowIso();
  data = await validateManagementUserAssignment(data, executor);
  await validateDocumentRelationships('User', { ...data, id }, null, executor);
  const credentials = resolvePasswordFields(data);
  if (!credentials.password_hash) {
    const error = new Error('Password is required when creating a user');
    error.status = 400;
    throw error;
  }
  const profile = { ...data };
  delete profile.id;
  delete profile.email;
  delete profile.full_name;
  delete profile.role;
  delete profile.status;
  delete profile.site_id;
  delete profile.site_name;
  delete profile.password;
  delete profile.password_hash;
  delete profile.temporary_password;
  delete profile.created_date;
  delete profile.updated_date;
  delete profile.role_name;
  delete profile.role_access_level;
  delete profile.role_permissions;
  delete profile.role_is_active;
  delete profile.dashboard_variant;
  delete profile.is_custom_role;

  await query(
    `INSERT INTO users (id, email, full_name, role, status, site_id, site_name, password_hash, temporary_password, profile, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11)`,
    [
      id,
      data.email,
      data.full_name || null,
      data.role || 'user',
      data.status || 'active',
      data.site_id || null,
      data.site_name || null,
      credentials.password_hash,
      credentials.temporary_password,
      JSON.stringify(profile),
      timestamp
    ],
    executor
  );

  return sanitizeUser(await findUserById(id, executor));
}

async function updateUser(id, patch, executor = pool) {
  const existing = await findUserById(id, executor);
  if (!existing) return null;

  if (patch.email && normalizeUniqueValue(patch.email) !== normalizeUniqueValue(existing.email)) {
    const duplicate = await findUserByEmail(patch.email, executor);
    if (duplicate && duplicate.id !== id) {
      const error = new Error('User email already exists');
      error.status = 409;
      throw error;
    }
  }

  const credentials = resolvePasswordFields(patch, existing);
  let merged = {
    ...existing,
    ...patch,
    ...credentials,
    id,
    updated_date: nowIso()
  };
  merged = await validateManagementUserAssignment(merged, executor);
  await validateDocumentRelationships('User', merged, id, executor);
  const profile = { ...merged };
  delete profile.id;
  delete profile.email;
  delete profile.full_name;
  delete profile.role;
  delete profile.status;
  delete profile.site_id;
  delete profile.site_name;
  delete profile.password;
  delete profile.password_hash;
  delete profile.temporary_password;
  delete profile.created_date;
  delete profile.updated_date;
  delete profile.role_name;
  delete profile.role_access_level;
  delete profile.role_permissions;
  delete profile.role_is_active;
  delete profile.dashboard_variant;
  delete profile.is_custom_role;

  await query(
    `UPDATE users
     SET email = $2,
         full_name = $3,
         role = $4,
         status = $5,
         site_id = $6,
         site_name = $7,
         password_hash = $8,
         temporary_password = $9,
         profile = $10::jsonb,
         updated_at = $11
     WHERE id = $1`,
    [
      id,
      merged.email,
      merged.full_name || null,
      merged.role || 'user',
      merged.status || 'active',
      merged.site_id || null,
      merged.site_name || null,
      merged.password_hash,
      merged.temporary_password || null,
      JSON.stringify(profile),
      merged.updated_date
    ],
    executor
  );

  return sanitizeUser(await findUserById(id, executor));
}

async function deactivateUserAccount({ actor, targetId, confirmation, reason }, executor = null) {
  if (!executor) {
    return withTransaction((client) => deactivateUserAccount({
      actor,
      targetId,
      confirmation,
      reason
    }, client));
  }

  // Lock the user set so two administrators cannot concurrently deactivate the
  // final accounts that keep administrative access available.
  await query('SELECT id FROM users ORDER BY id FOR UPDATE', [], executor);

  const target = await findUserById(targetId, executor);
  const users = await listUsers(executor);
  const activeAdministratorCount = users.filter(isActiveAdministratorAccount).length;
  const validated = assertUserDeactivationAllowed({
    actor,
    target,
    activeAdministratorCount,
    confirmation,
    reason
  });
  const deactivatedAt = nowIso();
  const deactivationMetadata = {
    deactivated_at: deactivatedAt,
    deactivated_by: actor.id,
    deactivated_by_email: actor.email || null,
    deactivation_reason: validated.reason
  };
  await query(
    `UPDATE users
     SET status = 'deactivated',
         profile = COALESCE(profile, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE id = $1`,
    [target.id, JSON.stringify(deactivationMetadata), deactivatedAt],
    executor
  );
  const deactivated = sanitizeUser(await findUserById(target.id, executor));

  await query('DELETE FROM auth_tokens WHERE user_id = $1', [target.id], executor);
  const auditLog = await createAuditLog({
    actor_id: actor.id,
    actor_email: actor.email || null,
    actor_name: actor.full_name || actor.email || 'Administrator',
    role: actor.role_name || actor.role || 'Administrator',
    action: 'USER_DEACTIVATED',
    entity: 'User',
    entity_id: target.id,
    site_id: target.site_id || null,
    site_name: target.site_name || null,
    details: {
      at: deactivatedAt,
      reason: validated.reason,
      target: {
        id: target.id,
        email: target.email,
        name: target.full_name || null,
        role: target.role,
        previous_status: target.status || 'active',
        status: 'deactivated'
      },
      acting_admin: {
        id: actor.id,
        email: actor.email || null,
        name: actor.full_name || null,
        role: actor.role_name || actor.role || null
      }
    }
  }, executor);

  return { user: deactivated, audit_log_id: auditLog.id };
}

async function listDocuments(
  entity,
  { filters = {}, rangeFilters = {}, sort, limit, offset = 0, lock = false, location = null } = {},
  executor = pool
) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    const filtered = (await listUsers(executor)).filter((record) => matchesFilter(record, filters));
    const sorted = sortRecords(filtered, sort);
    const start = Math.max(0, Number(offset) || 0);
    return typeof limit === 'number' ? sorted.slice(start, start + limit) : sorted.slice(start);
  }

  if (usesNormalizedCore(entity)) {
    return listNormalizedDocuments(entity, { filters, rangeFilters, sort, limit, offset, lock, location }, executor);
  }

  const built = buildEntityListQuery({ entity, filters, rangeFilters, sort, limit, offset, lock, location });
  const result = await query(built.text, built.parameters, executor);
  return result.rows.map((row) => hydrateDerivedFields(entity, row.data));
}

async function listDocumentsPage(
  entity,
  { filters = {}, rangeFilters = {}, sort, limit = 50, offset = 0, location = null } = {},
  executor = pool
) {
  ensureKnownEntity(entity);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  if (entity === 'User') {
    const filtered = (await listUsers(executor)).filter((record) => matchesFilter(record, filters));
    const sorted = sortRecords(filtered, sort);
    return {
      items: sorted.slice(safeOffset, safeOffset + safeLimit),
      total_count: sorted.length,
      limit: safeLimit,
      offset: safeOffset
    };
  }

  if (usesNormalizedCore(entity)) {
    return listNormalizedDocumentsPage(entity, {
      filters,
      rangeFilters,
      sort,
      limit: safeLimit,
      offset: safeOffset,
      location
    }, executor);
  }

  const built = buildEntityListQuery({
    entity,
    filters,
    rangeFilters,
    sort,
    limit: safeLimit,
    offset: safeOffset,
    location,
    includeTotal: true
  });
  const result = await query(built.text, built.parameters, executor);
  let totalCount = result.rowCount ? Number(result.rows[0].total_count) : 0;

  if (!result.rowCount && safeOffset > 0) {
    const countProbe = buildEntityListQuery({
      entity,
      filters,
      rangeFilters,
      sort,
      limit: 1,
      offset: 0,
      location,
      includeTotal: true
    });
    const probeResult = await query(countProbe.text, countProbe.parameters, executor);
    totalCount = probeResult.rowCount ? Number(probeResult.rows[0].total_count) : 0;
  }

  return {
    items: result.rows.map((row) => hydrateDerivedFields(entity, row.data)),
    total_count: totalCount,
    limit: safeLimit,
    offset: safeOffset
  };
}

async function findDocument(entity, id, executor = pool, lock = false) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    return sanitizeUser(await findUserById(id, executor));
  }

  if (usesNormalizedCore(entity)) {
    return findNormalizedDocument(entity, id, executor, lock);
  }

  const result = await query(
    `SELECT data
     FROM entity_records
     WHERE entity_name = $1 AND id = $2
     LIMIT 1
     ${lock ? 'FOR UPDATE' : ''}`,
    [entity, id],
    executor
  );
  return result.rowCount ? hydrateDerivedFields(entity, result.rows[0].data) : null;
}

async function createDocument(entity, payload, executor = null) {
  if (!executor) {
    return withTransaction((client) => createDocument(entity, payload, client));
  }

  ensureKnownEntity(entity);
  if (entity === 'User') {
    return createUser(payload, executor);
  }

  const preparedPayload = entity === 'RoleProfile' && isSystemRoleKey(payload?.role_key)
    ? normalizeManagementRoleProfile({
      ...payload,
      role_key: getSharedSystemRoleDefinition(payload.role_key).role_key,
      access_level: getSharedSystemRoleDefinition(payload.role_key).access_level,
      is_system: true
    })
    : payload;
  const validated = validateEntityPayload(entity, preparedPayload);
  const record = normalizeRecord(entity, validated);
  await validateDocumentRelationships(entity, record, null, executor);
  await ensureEntityUniqueness(entity, record, null, executor);

  if (usesNormalizedCore(entity)) {
    return createNormalizedDocument(entity, record, executor);
  }

  await query(
    `INSERT INTO entity_records (id, entity_name, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [record.id, entity, JSON.stringify(record), record.created_date, record.updated_date],
    executor
  );

  return record;
}

async function updateDocument(entity, id, patch, executor = null) {
  if (!executor) {
    return withTransaction((client) => updateDocument(entity, id, patch, client));
  }

  ensureKnownEntity(entity);
  if (entity === 'User') {
    return updateUser(id, patch, executor);
  }

  const existing = await findDocument(entity, id, executor);
  if (!existing) return null;

  let preparedPatch = patch;
  if (entity === 'RoleProfile' && isSystemRoleKey(existing.role_key)) {
    const builtIn = getSharedSystemRoleDefinition(existing.role_key);
    if (
      Object.prototype.hasOwnProperty.call(patch || {}, 'role_key')
      && getSharedSystemRoleDefinition(patch?.role_key)?.role_key !== builtIn.role_key
    ) {
      const error = new Error('Built-in role keys cannot be changed');
      error.status = 409;
      throw error;
    }
    if (
      Object.prototype.hasOwnProperty.call(patch || {}, 'access_level')
      && patch?.access_level !== builtIn.access_level
    ) {
      const error = new Error('Built-in role access levels cannot be changed');
      error.status = 409;
      throw error;
    }
    preparedPatch = {
      ...patch,
      role_key: builtIn.role_key,
      access_level: builtIn.access_level,
      is_system: true
    };
  }

  const validated = validateEntityPayload(entity, { ...existing, ...preparedPatch });
  const record = normalizeRecord(entity, validated, existing);
  await validateDocumentRelationships(entity, record, id, executor);
  if (entity === 'Site') {
    await validateSiteChildrenAfterStructureChange(existing, record, executor);
  }
  await ensureEntityUniqueness(entity, record, id, executor);

  if (usesNormalizedCore(entity)) {
    return updateNormalizedDocument(entity, id, record, existing, executor);
  }

  await query(
    `UPDATE entity_records
     SET data = $3::jsonb, updated_at = $4
     WHERE entity_name = $1 AND id = $2`,
    [entity, id, JSON.stringify(record), record.updated_date],
    executor
  );

  return record;
}

async function deleteDocument(entity, id, executor = null) {
  if (!executor) {
    return withTransaction((client) => deleteDocument(entity, id, client));
  }

  ensureKnownEntity(entity);
  if (entity === 'User') {
    const result = await query('DELETE FROM users WHERE id = $1', [id], executor);
    return result.rowCount > 0;
  }

  await ensureDocumentNotReferenced(entity, id, executor);
  if (usesNormalizedCore(entity)) {
    return deleteNormalizedDocument(entity, id, executor);
  }
  const result = await query(
    'DELETE FROM entity_records WHERE entity_name = $1 AND id = $2',
    [entity, id],
    executor
  );
  return result.rowCount > 0;
}

async function deleteDocumentRecordOnly(entity, id, executor = null) {
  if (!executor) {
    return withTransaction((client) => deleteDocumentRecordOnly(entity, id, client));
  }

  ensureKnownEntity(entity);
  if (entity === 'User') {
    throw new Error('User records must be deleted through deleteDocument');
  }

  if (usesNormalizedCore(entity)) {
    return deleteNormalizedDocument(entity, id, executor);
  }

  const result = await query(
    'DELETE FROM entity_records WHERE entity_name = $1 AND id = $2',
    [entity, id],
    executor
  );
  return result.rowCount > 0;
}

async function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    'INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, NULL)',
    [token, userId, nowIso()]
  );
  return token;
}

async function getUserByToken(token) {
  if (!token) return null;
  const result = await query(
    `SELECT u.* FROM auth_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token = $1
     LIMIT 1`,
    [token]
  );
  if (!result.rowCount) return null;
  const user = await hydrateUserRole(toUserRecord(result.rows[0]));
  return isUserAuthenticationAllowed(user) ? sanitizeUser(user) : null;
}

async function revokeToken(token) {
  await query('DELETE FROM auth_tokens WHERE token = $1', [token]);
}

async function loginUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.password_hash || !isUserAuthenticationAllowed(user)) {
    return null;
  }

  const isValid = bcrypt.compareSync(password, user.password_hash);
  if (!isValid) {
    return null;
  }

  const token = await createToken(user.id);
  return { token, user: sanitizeUser(user) };
}

async function inviteUser(email, role = 'user') {
  const existing = await findUserByEmail(email);
  if (existing) {
    return sanitizeUser(existing);
  }

  const temporaryPassword = crypto.randomBytes(6).toString('base64url');
  return createUser({
    email,
    full_name: email.split('@')[0],
    role,
    status: 'invited',
    temporary_password: temporaryPassword
  });
}

async function createAppLog({ page_name, user_id, user_email, payload = {} }) {
  const id = randomId('applog');
  await query(
    `INSERT INTO app_logs (id, user_id, user_email, page_name, payload, visited_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [id, user_id || null, user_email || null, page_name || null, JSON.stringify(payload), nowIso()]
  );
  return { id, page_name, user_id, user_email, payload };
}

async function createAuditLog({
  actor_id = null,
  actor_email = null,
  actor_name = null,
  role = null,
  action,
  entity,
  entity_id = null,
  site_id = null,
  site_name = null,
  details = {}
}, executor = pool) {
  const id = randomId('audit');
  const createdAt = nowIso();
  await query(
    `INSERT INTO audit_logs (
       id, actor_id, actor_email, actor_name, role, action, entity, entity_id,
       site_id, site_name, details, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      id,
      actor_id,
      actor_email,
      actor_name,
      role,
      action,
      entity,
      entity_id,
      site_id,
      site_name,
      JSON.stringify(details || {}),
      createdAt
    ],
    executor
  );
  await query(
    `SELECT pg_notify(
       'foodpro_entity_events',
       jsonb_build_object(
         'entity', 'AuditLog',
         'action', 'insert',
         'id', $1::text,
         'site_id', $2::text,
         'site_ids', '[]'::jsonb,
         'occurred_at', $3::text
       )::text
     )`,
    [id, site_id, createdAt],
    executor
  );
  return {
    id,
    actor_id,
    actor_email,
    actor_name,
    role,
    action,
    entity,
    entity_id,
    site_id,
    site_name,
    details,
    created_at: createdAt
  };
}

async function listAuditLogs({
  limit = 200,
  offset = 0,
  action = '',
  entity = '',
  search = '',
  siteIds = null,
  actorId = null
} = {}, executor = pool) {
  const conditions = [];
  const values = [];
  const bind = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (action) conditions.push(`action ILIKE ${bind(`%${action}%`)}`);
  if (entity) conditions.push(`entity ILIKE ${bind(`%${entity}%`)}`);
  if (search) {
    const pattern = `%${search}%`;
    const parameter = bind(pattern);
    conditions.push(`(
      actor_email ILIKE ${parameter}
      OR actor_name ILIKE ${parameter}
      OR action ILIKE ${parameter}
      OR entity ILIKE ${parameter}
      OR COALESCE(entity_id, '') ILIKE ${parameter}
      OR details::text ILIKE ${parameter}
    )`);
  }
  if (Array.isArray(siteIds)) {
    const actorParameter = actorId ? bind(actorId) : null;
    if (siteIds.length === 0) conditions.push(actorParameter ? `actor_id = ${actorParameter}` : 'FALSE');
    else {
      const siteParameter = bind(siteIds);
      conditions.push(actorParameter
        ? `(site_id = ANY(${siteParameter}::text[]) OR actor_id = ${actorParameter})`
        : `site_id = ANY(${siteParameter}::text[])`);
    }
  } else if (actorId) {
    conditions.push(`actor_id = ${bind(actorId)}`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  values.push(safeLimit, safeOffset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT id, actor_id, actor_email, actor_name, role, action, entity, entity_id,
            site_id, site_name, details, created_at
     FROM audit_logs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    executor
  );
  return result.rows;
}

async function createBulkUploadJob({
  module_key,
  entity_name,
  import_mode = 'keep_existing',
  file_name = null,
  file_path = null,
  file_size = 0,
  batch_size = 500,
  actor = null,
  site_id = null,
  site_name = null,
  source_name = null,
  options = {}
}, executor = pool) {
  const id = randomId('bulk');
  const createdAt = nowIso();
  const actorSnapshot = {
    ...(actor ? sanitizeUser(actor) : {}),
    ...(options && Object.keys(options).length ? { bulk_options: options } : {})
  };
  await query(
    `INSERT INTO bulk_upload_jobs (
       id, module_key, entity_name, import_mode, file_name, file_path, file_size,
       batch_size, actor_id, actor_email, actor_name, role, site_id, site_name, source_name,
       actor_snapshot, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $17)`,
    [
      id,
      module_key,
      entity_name,
      import_mode,
      file_name,
      file_path,
      Number(file_size) || 0,
      Number(batch_size) || 500,
      actor?.id || null,
      actor?.email || null,
      actor?.full_name || actor?.email || 'System',
      actor?.role || null,
      site_id,
      site_name,
      source_name,
      JSON.stringify(actorSnapshot),
      createdAt
    ],
    executor
  );
  return getBulkUploadJob(id, executor);
}

async function getBulkUploadJob(id, executor = pool) {
  const result = await query('SELECT * FROM bulk_upload_jobs WHERE id = $1 LIMIT 1', [id], executor);
  return result.rowCount ? result.rows[0] : null;
}

async function listBulkUploadJobs({ limit = 100, statuses = [], siteIds = null, actorId = null } = {}, executor = pool) {
  const conditions = [];
  const values = [];
  const bind = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (Array.isArray(statuses) && statuses.length) {
    conditions.push(`status = ANY(${bind(statuses)}::text[])`);
  }
  if (Array.isArray(siteIds)) {
    const actorParameter = actorId ? bind(actorId) : null;
    if (siteIds.length === 0) conditions.push(actorParameter ? `actor_id = ${actorParameter}` : 'FALSE');
    else {
      const siteParameter = bind(siteIds);
      conditions.push(actorParameter
        ? `(site_id = ANY(${siteParameter}::text[]) OR actor_id = ${actorParameter})`
        : `site_id = ANY(${siteParameter}::text[])`);
    }
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  values.push(safeLimit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT * FROM bulk_upload_jobs ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
    executor
  );
  return result.rows;
}

async function updateBulkUploadJob(id, patch = {}, executor = pool) {
  const fieldMap = {
    status: 'status',
    message: 'message',
    total_rows: 'total_rows',
    processed_rows: 'processed_rows',
    applied_rows: 'applied_rows',
    skipped_rows: 'skipped_rows',
    failed_rows: 'failed_rows',
    errors: 'errors',
    started_at: 'started_at',
    completed_at: 'completed_at'
  };
  const assignments = [];
  const values = [];
  Object.entries(fieldMap).forEach(([key, column]) => {
    if (!Object.hasOwn(patch, key)) return;
    const value = key === 'errors' ? JSON.stringify(patch[key] || []) : patch[key];
    values.push(value);
    assignments.push(`${column} = $${values.length}${key === 'errors' ? '::jsonb' : ''}`);
  });
  if (!assignments.length) return getBulkUploadJob(id, executor);
  values.push(id);
  await query(
    `UPDATE bulk_upload_jobs
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}`,
    values,
    executor
  );
  return getBulkUploadJob(id, executor);
}

async function claimNextBulkUploadJob({ staleAfterMs = 15 * 60 * 1000 } = {}) {
  return withTransaction(async (client) => {
    const staleBefore = new Date(Date.now() - Math.max(60000, Number(staleAfterMs) || 0)).toISOString();
    const result = await query(
      `WITH candidate AS (
         SELECT id
         FROM bulk_upload_jobs
         WHERE status = 'QUEUED'
            OR (status = 'PROCESSING' AND updated_at < $1)
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE bulk_upload_jobs job
       SET status = 'PROCESSING',
           started_at = COALESCE(job.started_at, NOW()),
           updated_at = NOW(),
           message = CASE
             WHEN job.status = 'PROCESSING' THEN 'Recovering a stale background upload job.'
             ELSE 'Background worker claimed this upload job.'
           END
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.*`,
      [staleBefore],
      client
    );
    return result.rowCount ? result.rows[0] : null;
  });
}

async function clearDocumentsForBulk(entity, siteIds = null, executor = pool) {
  ensureKnownEntity(entity);
  if (['ProducedItemBatch', 'MealServiceAttendance', 'MealServiceConsumption'].includes(entity)) {
    const error = new Error(`${entity} records cannot be cleared through bulk upload; use the protected meal-service workflow`);
    error.status = 409;
    error.code = 'MEAL_SERVICE_BULK_MUTATION_FORBIDDEN';
    throw error;
  }
  if (entity === 'Site') {
    const error = new Error(
      'Site hierarchy records cannot be cleared through bulk upload. Delete an unused subtree through the protected Site deletion endpoint.'
    );
    error.status = 409;
    error.code = 'SITE_BULK_CLEAR_FORBIDDEN';
    error.details = {
      protected_entity: 'Site',
      supported_delete_endpoint: '/api/entities/Site/:id?include_descendants=true'
    };
    throw error;
  }
  if (entity === 'User') {
    const error = new Error('Users cannot be deleted through bulk upload.');
    error.status = 400;
    throw error;
  }
  const preserveServerMealServiceWaste = entity === 'FoodWaste'
    ? `AND NOT (
         COALESCE(data->>'auto_generated', '') = 'true'
         OR LOWER(COALESCE(data->>'source_type', '')) IN ('meal_service_leftover', 'batch_overproduction')
         OR COALESCE(data->>'meal_service_attendance_id', '') <> ''
       )`
    : '';
  if (usesNormalizedCore(entity)) {
    const siteFilter = Array.isArray(siteIds)
      ? new Set(siteIds.map(String))
      : null;
    const records = await listNormalizedDocuments(entity, { limit: 10000, lock: true }, executor);
    const scopedRecords = (records || []).filter((record) => {
      if (entity === 'FoodWaste' && (
        record.auto_generated === true
        || ['meal_service_leftover', 'batch_overproduction'].includes(String(record.source_type || '').toLowerCase())
        || String(record.meal_service_attendance_id || '').trim()
      )) {
        return false;
      }
      if (!siteFilter) return true;
      const recordSiteIds = [
        record.site_id,
        record.warehouse_id,
        record.fulfillment_store_id,
        record.from_site_id,
        record.to_site_id,
        ...(Array.isArray(record.site_ids) ? record.site_ids : [])
      ].filter(Boolean).map(String);
      return recordSiteIds.some((siteId) => siteFilter.has(siteId));
    });
    let deletedCount = 0;
    for (const record of scopedRecords) {
      if (await deleteNormalizedDocument(entity, record.id, executor)) {
        deletedCount += 1;
      }
    }
    return deletedCount;
  }
  if (Array.isArray(siteIds)) {
    if (!siteIds.length) return 0;
    const result = await query(
      `DELETE FROM entity_records
       WHERE entity_name = $1
         AND (
           data->>'site_id' = ANY($2::text[])
           OR COALESCE(data->'site_ids', '[]'::jsonb) ?| $2::text[]
         )
       ${preserveServerMealServiceWaste}`,
      [entity, siteIds],
      executor
    );
    return result.rowCount;
  }
  const result = await query(
    `DELETE FROM entity_records WHERE entity_name = $1 ${preserveServerMealServiceWaste}`,
    [entity],
    executor
  );
  return result.rowCount;
}

async function acquireMealServiceScopeLock(scopeKey, executor = pool) {
  await query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`staff-meal-service:${String(scopeKey || '')}`],
    executor
  );
}

async function createEmailLog(payload) {
  const id = randomId('email');
  await query(
    `INSERT INTO email_logs (id, recipient, subject, payload, status, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [id, payload.to || null, payload.subject || null, JSON.stringify(payload), payload.status || 'logged_only', nowIso()]
  );
  return { id, ...payload };
}

export {
  pool,
  withTransaction,
  collectDocumentReferences,
  validateDocumentRelationships,
  validateSiteChildrenAfterStructureChange,
  uploadsDir,
  initDatabase,
  listDocuments,
  listDocumentsPage,
  findDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  deleteDocumentRecordOnly,
  deleteSiteSubtree,
  sanitizeUser,
  getUserByToken,
  revokeToken,
  loginUser,
  inviteUser,
  deactivateUserAccount,
  createAppLog,
  createAuditLog,
  listAuditLogs,
  createBulkUploadJob,
  getBulkUploadJob,
  listBulkUploadJobs,
  updateBulkUploadJob,
  claimNextBulkUploadJob,
  clearDocumentsForBulk,
  acquireMealServiceScopeLock,
  createEmailLog,
  invalidateRoleProfileCache
};
