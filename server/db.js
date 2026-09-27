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
import { normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';
import {
  assertUserDeactivationAllowed,
  isActiveAdministratorAccount,
  isUserAuthenticationAllowed
} from './userDeactivation.js';
import { normalizeProductionDisplayTitle } from '../shared/productionLabels.js';

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

const USER_SELECT_SQL = `
SELECT app_user.*,
       COALESCE(site_access.allowed_site_ids, ARRAY[]::text[]) AS allowed_site_ids,
       COALESCE(site_access.allowed_site_names, ARRAY[]::text[]) AS allowed_site_names
  FROM users app_user
  LEFT JOIN (
    SELECT user_id,
           ARRAY_AGG(site_id ORDER BY site_id) AS allowed_site_ids,
           ARRAY_AGG(site_name ORDER BY site_id) FILTER (WHERE site_name IS NOT NULL) AS allowed_site_names
      FROM user_site_access
     GROUP BY user_id
  ) site_access ON site_access.user_id = app_user.id`;

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
    allowed_site_ids: Array.isArray(row.allowed_site_ids) ? row.allowed_site_ids : [],
    allowed_site_names: Array.isArray(row.allowed_site_names) ? row.allowed_site_names : [],
    visibility_scope: row.visibility_scope || null,
    phone: row.phone || null,
    language: row.language || null,
    avatar_url: row.avatar_url || null,
    deactivated_at: row.deactivated_at?.toISOString?.() || row.deactivated_at || null,
    deactivated_by: row.deactivated_by || null,
    deactivation_reason: row.deactivation_reason || null,
    created_date: row.created_at?.toISOString?.() || row.created_at,
    updated_date: row.updated_at?.toISOString?.() || row.updated_at
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
  const normalizedRecord = entity === 'RoleProfile' ? normalizeManagementRoleProfile(derivedRecord) : derivedRecord;
  if (![
    'Production',
    'ProductionConsumptionReport',
    'ProducedItemBatch',
    'MealServiceAttendance',
    'MealServiceConsumption',
    'FoodWaste',
    'MaterialRequest'
  ].includes(entity)) {
    return normalizedRecord;
  }
  const fields = ['production_name', 'recipe_name', 'name', 'report_name', 'source_production_name', 'original_recipe_name'];
  let nextRecord = normalizedRecord;
  for (const field of fields) {
    const currentValue = nextRecord?.[field];
    if (typeof currentValue !== 'string' || !currentValue.trim()) continue;
    const displayValue = normalizeProductionDisplayTitle(currentValue);
    if (displayValue && displayValue !== currentValue) {
      if (nextRecord === normalizedRecord) nextRecord = { ...normalizedRecord };
      nextRecord[field] = displayValue;
    }
  }
  return nextRecord;
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
      `SELECT role_profile.*,
              COALESCE(
                ARRAY_AGG(permission.permission_key ORDER BY permission.permission_key)
                  FILTER (WHERE permission.permission_key IS NOT NULL),
                ARRAY[]::text[]
              ) AS permissions
         FROM role_profiles role_profile
         LEFT JOIN role_profile_permissions permission
           ON permission.role_profile_id = role_profile.id
        WHERE LOWER(COALESCE(role_profile.role_key, '')) = $1
        GROUP BY role_profile.id
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

  let value = result.rowCount
    ? normalizeManagementRoleProfile(
      usesNormalizedCore('RoleProfile')
        ? rowToRoleProfile(result.rows[0])
        : result.rows[0].data
    )
    : null;
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

function normalizeUserAllowedSiteIds(user = {}) {
  const explicitIds = Array.isArray(user.allowed_site_ids)
    ? user.allowed_site_ids
    : [];
  const ids = explicitIds
    .map((siteId) => String(siteId || '').trim())
    .filter(Boolean);
  if (ids.length === 0 && user.site_id) {
    ids.push(String(user.site_id).trim());
  }
  return [...new Set(ids.filter(Boolean))];
}

async function replaceUserSiteAccess(userId, user = {}, executor = pool) {
  await query('DELETE FROM user_site_access WHERE user_id = $1', [userId], executor);
  const allowedSiteIds = normalizeUserAllowedSiteIds(user);
  if (allowedSiteIds.length === 0) return;
  const allowedNames = Array.isArray(user.allowed_site_names) ? user.allowed_site_names : [];
  for (const [index, siteId] of allowedSiteIds.entries()) {
    const siteName = allowedNames[index]
      || (siteId === String(user.site_id || '').trim() ? user.site_name : null)
      || null;
    await query(
      `INSERT INTO user_site_access (user_id, site_id, site_name, access_scope, assigned_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, site_id) DO UPDATE SET
         site_name = EXCLUDED.site_name,
         access_scope = EXCLUDED.access_scope`,
      [userId, siteId, siteName, user.visibility_scope || 'assigned'],
      executor
    );
  }
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
  'RoleProfile',
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

function firstPositiveNumber(values = []) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function toDateOnlyOrNull(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (value && typeof value.toISOString === 'function') {
    const isoValue = value.toISOString();
    const isoMatch = String(isoValue || '').match(/^\d{4}-\d{2}-\d{2}/);
    if (isoMatch) return isoMatch[0];
  }
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function jsonPayload(record = {}) {
  return JSON.stringify(record || {});
}

function appendStringValues(target, value) {
  if (Array.isArray(value)) {
    value.forEach((entry) => appendStringValues(target, entry));
    return;
  }
  if (value && typeof value === 'object') {
    if (typeof value.image_url === 'string') appendStringValues(target, value.image_url);
    if (typeof value.url === 'string') appendStringValues(target, value.url);
    return;
  }
  const text = String(value || '').trim();
  if (!text) return;
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      appendStringValues(target, JSON.parse(text));
      return;
    } catch {
      // Keep the original string below when it is not parseable JSON.
    }
  }
  target.push(text);
}

function uniqueStringList(...values) {
  const entries = [];
  values.forEach((value) => appendStringValues(entries, value));
  return [...new Set(entries)];
}

function normalizeFoodWasteImageUrls(record = {}) {
  return uniqueStringList(
    record.evidence_image_urls,
    record.image_urls,
    record.evidence_image_url,
    record.image_url
  );
}

function userReferenceSql(parameterNumber) {
  return `(SELECT app_user.id FROM users app_user WHERE app_user.id = NULLIF($${parameterNumber}::text, '') OR LOWER(app_user.email) = LOWER(NULLIF($${parameterNumber}::text, '')) LIMIT 1)`;
}

function rowTimestamp(value) {
  return value?.toISOString?.() || value || null;
}

function rowJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function rowJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function productionConsumptionReportSections(ingredientLines = []) {
  const lines = rowJsonArray(ingredientLines);
  const lotLines = lines.flatMap((line) => (
    rowJsonArray(line?.movement_layers).map((layer) => ({
      item_code: line.item_code || null,
      ingredient_id: line.ingredient_id || null,
      ingredient_name: line.ingredient_name || null,
      unit: line.unit || line.inventory_unit || null,
      ...layer
    }))
  ));
  const shortageLines = lines.filter((line) => toNumberOrZero(line?.shortage_quantity) > 0);
  return [
    {
      key: 'ingredient_consumption',
      title: 'Ingredient Consumption',
      lines
    },
    {
      key: 'inventory_lot_usage',
      title: 'Inventory Lots Consumed',
      lines: lotLines
    },
    {
      key: 'shortages',
      title: 'Shortages and Exceptions',
      lines: shortageLines
    }
  ];
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

function rowToRoleProfile(row = {}) {
  const permissions = Array.isArray(row.permissions)
    ? row.permissions.filter(Boolean)
    : [];
  return hydrateDerivedFields('RoleProfile', {
    id: row.id,
    role_key: row.role_key || null,
    name: row.name || row.role_key || 'Role',
    description: row.description || null,
    access_level: row.access_level || 'user',
    permissions,
    dashboard_variant: row.dashboard_variant || null,
    is_active: row.is_active !== false,
    is_system: row.is_system === true,
    status: row.status || (row.is_active === false ? 'inactive' : 'active'),
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
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
    received_date: toDateOnlyOrNull(row.received_date),
    stock_date: toDateOnlyOrNull(row.stock_date),
    expiry_date: toDateOnlyOrNull(row.expiry_date),
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
    transaction_date: toDateOnlyOrNull(row.transaction_date),
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
    plan_date: toDateOnlyOrNull(row.plan_date),
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
  const manifestLines = Array.isArray(row.manifest_lines) ? row.manifest_lines : [];
  return withPayload(row, {
    __entity: 'Production',
    id: row.production_id,
    menu_plan_id: row.menu_plan_id || null,
    site_id: row.warehouse_id,
    fulfillment_store_id: row.warehouse_id,
    production_date: toDateOnlyOrNull(row.production_date),
    meal_type: row.meal_period,
    menu_type: row.menu_type,
    cuisine_type: row.menu_type,
    menu_category: row.menu_category,
    status: row.status || 'planned',
    issue_group_key: row.issue_group_key || null,
    source_type: row.source_type || null,
    source_event_id: row.source_event_id || null,
    source_event_name: row.source_event_name || null,
    source_event_recipe_id: row.source_event_recipe_id || null,
    source_menu_plan_item_key: row.source_menu_plan_item_key || null,
    production_issue_grouped: row.production_issue_grouped === true,
    production_issue_group_key: row.production_issue_group_key || null,
    production_issue_scope: row.production_issue_scope || null,
    production_issue_item_count: toNumberOrNull(row.production_issue_item_count),
    production_issue_dish_count: toNumberOrNull(row.production_issue_dish_count),
    production_issue_admin_reissue: row.production_issue_admin_reissue === true,
    production_issue_reissue_run_id: row.production_issue_reissue_run_id || null,
    production_issue_reissue_original_group_key: row.production_issue_reissue_original_group_key || null,
    target_servings: toNumberOrNull(row.target_servings),
    ingredient_cost_total: Number(row.ingredient_cost_total || 0),
    production_cost_total: Number(row.production_cost_total || 0),
    cost_per_serving: Number(row.cost_per_serving || 0),
    total_shortage_quantity: Number(row.total_shortage_quantity || 0),
    consumption_report_id: row.consumption_report_id || null,
    consumption_report_number: row.consumption_report_number || null,
    consumption_report_name: row.consumption_report_name || null,
    consumption_report_generated_at: rowTimestamp(row.consumption_report_generated_at),
    produced_item_batch_id: row.produced_item_batch_id || null,
    produced_item_batch_number: row.produced_item_batch_number || null,
    yield_adjustment_applied: row.yield_adjustment_applied === true,
    yield_adjustment_version: toNumberOrNull(row.yield_adjustment_version),
    yield_adjustment_updated_at: rowTimestamp(row.yield_adjustment_updated_at),
    yield_snapshot_source: row.yield_snapshot_source || null,
    quantity_semantics: row.quantity_semantics || null,
    reconciliation_mode: row.reconciliation_mode || null,
    output_calculation_source: row.output_calculation_source || null,
    recipe_raw_weight_grams: toNumberOrNull(row.recipe_raw_weight_grams),
    total_raw_consumption_weight_grams: toNumberOrNull(row.total_raw_consumption_weight_grams),
    total_yielded_weight_grams: toNumberOrNull(row.total_yielded_weight_grams),
    expected_finished_weight_grams: toNumberOrNull(row.expected_finished_weight_grams),
    actual_finished_weight_grams: toNumberOrNull(row.actual_finished_weight_grams),
    portion_size_grams: toNumberOrNull(row.portion_size_grams),
    portion_size_source: row.portion_size_source || null,
    expected_yield_servings: toNumberOrNull(row.expected_yield_servings),
    produced_servings: toNumberOrNull(row.produced_servings),
    produced_weight_grams: toNumberOrNull(row.produced_weight_grams),
    completed_by_name: row.completed_by_name || null,
    fulfillment_store_name: row.fulfillment_store_name || null,
    linked_material_request_id: row.linked_material_request_id || null,
    linked_material_request_number: row.linked_material_request_number || null,
    material_request_status: row.material_request_status || null,
    last_review_action: row.last_review_action || null,
    rejection_reason: row.rejection_reason || null,
    cancellation_reason: row.cancellation_reason || null,
    cancelled_at: rowTimestamp(row.cancelled_at),
    cancelled_by: row.cancelled_by || null,
    cancelled_by_name: row.cancelled_by_name || null,
    completed_by: row.completed_by || null,
    completed_at: rowTimestamp(row.completed_at),
    reversed_by: row.reversed_by || null,
    reversed_at: rowTimestamp(row.reversed_at),
    reversal_reason: row.reversal_reason || null,
    source_name: row.source_name || null,
    manifest_lines: manifestLines,
    menu_issue_items: manifestLines
  });
}

function rowToProductionConsumptionReport(row = {}) {
  const ingredientLines = rowJsonArray(row.ingredient_lines);
  const menuIssueItems = rowJsonArray(row.menu_issue_items);
  const partialReversalHistory = rowJsonArray(row.partial_reversal_history);
  return hydrateDerivedFields('ProductionConsumptionReport', {
    id: row.report_id,
    report_number: row.report_number,
    report_name: row.report_name || null,
    production_id: row.production_id,
    production_name: row.production_name || null,
    original_production_name: row.original_production_name || null,
    site_id: row.warehouse_id || null,
    warehouse_id: row.warehouse_id || null,
    site_name: row.warehouse_name || null,
    requesting_site_id: row.requesting_warehouse_id || null,
    requesting_site_name: row.requesting_warehouse_name || null,
    fulfillment_store_id: row.fulfillment_store_id || row.warehouse_id || null,
    fulfillment_store_name: row.fulfillment_store_name || null,
    recipe_id: row.recipe_version_id || null,
    recipe_name: row.recipe_name || null,
    original_recipe_name: row.original_recipe_name || null,
    production_date: toDateOnlyOrNull(row.production_date),
    meal_type: row.meal_period || null,
    menu_type: row.menu_type || null,
    cuisine_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    menu_scope_label: row.menu_scope_label || null,
    production_issue_grouped: row.production_issue_grouped === true,
    production_issue_item_count: toNumberOrNull(row.production_issue_item_count),
    production_issue_dish_count: toNumberOrNull(row.production_issue_dish_count),
    menu_issue_items: menuIssueItems,
    manifest_lines: menuIssueItems,
    kitchen_station: row.kitchen_station || null,
    target_servings: toNumberOrZero(row.target_servings),
    completed_by: row.completed_by || null,
    completed_by_name: row.completed_by_name || null,
    completed_at: rowTimestamp(row.completed_at),
    quantity_basis: row.quantity_basis || null,
    reconciliation_mode: row.reconciliation_mode || null,
    output_calculation_source: row.output_calculation_source || null,
    recipe_raw_weight_grams: toNumberOrNull(row.recipe_raw_weight_grams),
    expected_finished_weight_grams: toNumberOrNull(row.expected_finished_weight_grams),
    total_raw_consumption_weight_grams: toNumberOrNull(row.total_raw_consumption_weight_grams),
    total_yielded_weight_grams: toNumberOrNull(row.total_yielded_weight_grams),
    portion_size_grams: toNumberOrNull(row.portion_size_grams),
    expected_yield_servings: toNumberOrNull(row.expected_yield_servings),
    total_consumption_cost: Number(row.total_consumption_cost || 0),
    total_shortage_cost: Number(row.total_shortage_cost || 0),
    shortage_line_count: Number(row.shortage_line_count || 0),
    shortage_totals_by_unit: rowJsonObject(row.shortage_totals_by_unit),
    ingredient_line_count: Number(row.ingredient_line_count || ingredientLines.length || 0),
    ingredient_lines: ingredientLines,
    sections: productionConsumptionReportSections(ingredientLines),
    partial_reversal_summary: rowJsonObject(row.partial_reversal_summary),
    partial_reversal_history: partialReversalHistory,
    reversal_summary: rowJsonObject(row.reversal_summary),
    reversed_at: rowTimestamp(row.reversed_at),
    reversed_by: row.reversed_by || null,
    reversed_by_name: row.reversed_by_name || null,
    reversal_reason: row.reversal_reason || null,
    status: row.status || 'posted',
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToProducedItemBatch(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const productionDate = toDateOnlyOrNull(row.production_date)
    || toDateOnlyOrNull(payload.production_date)
    || toDateOnlyOrNull(row.created_at);
  const completedAt = rowTimestamp(row.completed_at)
    || rowTimestamp(payload.completed_at)
    || rowTimestamp(row.updated_at)
    || rowTimestamp(row.created_at)
    || nowIso();
  const producedWeightGrams = firstPositiveNumber([
    row.initial_weight_grams,
    payload.produced_weight_grams,
    payload.initial_weight_grams,
    payload.actual_finished_weight_grams,
    payload.expected_finished_weight_grams
  ]) || 1;
  const remainingWeightValue = toNumberOrNull(
    row.remaining_weight_grams
      ?? payload.remaining_weight_grams
      ?? payload.available_weight_grams
  );
  const remainingWeightGrams = remainingWeightValue === null
    ? producedWeightGrams
    : Math.max(0, Math.min(Number(remainingWeightValue), producedWeightGrams));
  const producedServings = firstPositiveNumber([
    row.initial_servings,
    payload.produced_servings,
    payload.initial_servings,
    payload.expected_servings,
    payload.remaining_servings
  ]) || 1;
  const remainingServingsValue = toNumberOrNull(
    row.remaining_servings
      ?? payload.remaining_servings
      ?? payload.available_servings
  );
  const remainingServings = remainingServingsValue === null
    ? producedServings
    : Math.max(0, Math.min(Number(remainingServingsValue), producedServings));
  const payloadServedWeight = toNumberOrNull(payload.served_weight_grams);
  const payloadWastedWeight = toNumberOrNull(payload.wasted_weight_grams);
  const rowServedWeight = toNumberOrNull(row.served_weight_grams);
  const rowWastedWeight = toNumberOrNull(row.wasted_weight_grams);
  const servedWeightGrams = rowServedWeight ?? payloadServedWeight ?? (
    payloadWastedWeight === null && remainingWeightGrams < producedWeightGrams
      ? Math.max(0, producedWeightGrams - remainingWeightGrams)
      : 0
  );
  const wastedWeightGrams = rowWastedWeight ?? payloadWastedWeight ?? Math.max(0, producedWeightGrams - remainingWeightGrams - servedWeightGrams);
  const payloadServedServings = toNumberOrNull(payload.served_servings);
  const payloadWastedServings = toNumberOrNull(payload.wasted_servings);
  const rowServedServings = toNumberOrNull(row.served_servings);
  const rowWastedServings = toNumberOrNull(row.wasted_servings);
  const servedServings = rowServedServings ?? payloadServedServings ?? (
    payloadWastedServings === null && remainingServings < producedServings
      ? Math.max(0, producedServings - remainingServings)
      : 0
  );
  const wastedServings = rowWastedServings ?? payloadWastedServings ?? Math.max(0, producedServings - remainingServings - servedServings);
  const portionSizeGrams = firstPositiveNumber([
    row.portion_size_grams,
    payload.portion_size_grams,
    producedServings > 0 ? producedWeightGrams / producedServings : 0,
    row.service_portion_size_grams,
    payload.service_portion_size_grams
  ]) || 1;
  const normalizeMealPeriod = (value) => {
    const candidate = String(value || '').trim().toLowerCase();
    return ['breakfast', 'lunch', 'dinner', 'snack'].includes(candidate) ? candidate : 'breakfast';
  };
  const normalizeBatchStatus = (value) => {
    const candidate = String(value || '').trim().toLowerCase();
    if (candidate === 'reversed') return 'voided';
    if (['available', 'partial', 'consumed', 'voided'].includes(candidate)) return candidate;
    if (candidate === 'active') {
      return remainingWeightGrams < producedWeightGrams || remainingServings < producedServings
        ? 'partial'
        : 'available';
    }
    return remainingWeightGrams <= 0 || remainingServings <= 0 ? 'consumed' : 'available';
  };
  return withPayload(row, {
    __entity: 'ProducedItemBatch',
    id: row.output_batch_id,
    production_id: row.production_id || payload.production_id || null,
    production_line_id: row.production_line_id || payload.production_line_id || null,
    site_id: row.warehouse_id || payload.site_id || payload.warehouse_id || null,
    fulfillment_store_id: row.warehouse_id || payload.fulfillment_store_id || payload.site_id || null,
    production_date: productionDate,
    meal_type: normalizeMealPeriod(row.meal_period || payload.meal_type),
    menu_type: row.menu_type || payload.menu_type || payload.cuisine_type || null,
    cuisine_type: row.menu_type || payload.cuisine_type || payload.menu_type || null,
    menu_category: row.menu_category || payload.menu_category || null,
    completed_at: completedAt,
    consumption_report_id: row.consumption_report_id || payload.consumption_report_id || null,
    consumption_report_number: row.consumption_report_number || payload.consumption_report_number || null,
    source_type: row.source_type || payload.source_type || null,
    source_event_id: row.source_event_id || payload.source_event_id || null,
    menu_plan_id: row.menu_plan_id || payload.menu_plan_id || null,
    production_issue_grouped: row.production_issue_grouped === true || payload.production_issue_grouped === true,
    production_issue_item_count: toNumberOrNull(row.production_issue_item_count ?? payload.production_issue_item_count),
    production_issue_dish_count: toNumberOrNull(row.production_issue_dish_count ?? payload.production_issue_dish_count),
    recipe_id: row.recipe_version_id || null,
    recipe_name: row.item_name || payload.recipe_name || payload.production_name || null,
    ingredient_id: row.ingredient_id || payload.ingredient_id || null,
    item_name: row.item_name || null,
    batch_number: row.batch_number || payload.batch_number || row.output_batch_id,
    initial_weight_grams: producedWeightGrams,
    remaining_weight_grams: remainingWeightGrams,
    produced_weight_grams: producedWeightGrams,
    available_weight_grams: remainingWeightGrams,
    initial_servings: producedServings,
    expected_servings: toNumberOrNull(row.expected_servings ?? payload.expected_servings) ?? producedServings,
    expected_finished_weight_grams: toNumberOrNull(row.expected_finished_weight_grams ?? payload.expected_finished_weight_grams) ?? producedWeightGrams,
    actual_finished_weight_grams: toNumberOrNull(row.actual_finished_weight_grams ?? payload.actual_finished_weight_grams) ?? producedWeightGrams,
    produced_servings: producedServings,
    served_servings: servedServings,
    served_weight_grams: servedWeightGrams,
    wasted_servings: wastedServings,
    wasted_weight_grams: wastedWeightGrams,
    remaining_servings: remainingServings,
    portion_size_grams: portionSizeGrams,
    service_portion_size_grams: toNumberOrNull(row.service_portion_size_grams ?? payload.service_portion_size_grams),
    service_portion_updated_by: row.service_portion_updated_by || payload.service_portion_updated_by || null,
    service_portion_updated_by_name: row.service_portion_updated_by_name || payload.service_portion_updated_by_name || null,
    service_portion_updated_at: rowTimestamp(row.service_portion_updated_at) || rowTimestamp(payload.service_portion_updated_at),
    unit_cost: Number(row.unit_cost || 0),
    total_cost: Number(row.total_cost || 0),
    status: normalizeBatchStatus(row.status || payload.status),
    completed_by: row.completed_by || payload.completed_by || null,
    completed_by_name: row.completed_by_name || payload.completed_by_name || null,
    reconciliation_mode: row.reconciliation_mode || payload.reconciliation_mode || null,
    output_calculation_source: row.output_calculation_source || payload.output_calculation_source || null,
    cutover_version: Number(row.cutover_version || payload.cutover_version || 1),
    source_name: row.source_name || null
  });
}

function rowToMealServiceAttendance(row = {}) {
  const items = Array.isArray(row.items) ? row.items : [];
  const summary = {
    required_servings: Number(row.required_servings || 0),
    required_weight_grams: Number(row.required_weight_grams || 0),
    served_servings: Number(row.served_servings || 0),
    served_weight_grams: Number(row.served_weight_grams || 0),
    shortage_servings: Number(row.shortage_servings || 0),
    short_servings: Number(row.shortage_servings || 0),
    shortage_weight_grams: Number(row.shortage_weight_grams || 0),
    short_weight_grams: Number(row.shortage_weight_grams || 0)
  };
  return withPayload(row, {
    __entity: 'MealServiceAttendance',
    id: row.meal_service_id,
    service_reference: row.service_reference,
    idempotency_key: row.idempotency_key,
    request_fingerprint: row.request_fingerprint || null,
    reversal_idempotency_key: row.reversal_idempotency_key || null,
    reversal_request_fingerprint: row.reversal_request_fingerprint || null,
    scope_key: row.scope_key || null,
    menu_plan_id: row.menu_plan_id || null,
    menu_plan_name: row.menu_plan_name || null,
    customer_meal_plan_id: row.customer_meal_plan_id || null,
    customer_meal_plan_name: row.customer_meal_plan_name || null,
    site_id: row.warehouse_id,
    service_date: toDateOnlyOrNull(row.service_date),
    meal_type: row.meal_period,
    menu_type: row.menu_type,
    menu_category: row.menu_category,
    serving_size_grams: Number(row.serving_size_grams || 0),
    covers: Number(row.covers || 0),
    customer_name: row.customer_name || null,
    customer_id: row.customer_id || null,
    category: row.category || null,
    attendee_count: Number(row.attendee_count || 0),
    scan_method: row.scan_method || null,
    notes: row.notes || null,
    items,
    summary,
    required_servings: summary.required_servings,
    required_weight_grams: summary.required_weight_grams,
    served_servings: summary.served_servings,
    served_weight_grams: summary.served_weight_grams,
    shortage_servings: summary.shortage_servings,
    shortage_weight_grams: summary.shortage_weight_grams,
    recorded_by: row.recorded_by || null,
    recorded_by_name: row.recorded_by_name || null,
    recorded_at: rowTimestamp(row.recorded_at),
    status: row.status || 'posted',
    posted_by: row.posted_by || null,
    reversed_by: row.reversed_by || null,
    reversed_by_name: row.reversed_by_name || null,
    reversed_at: rowTimestamp(row.reversed_at),
    reversal_reason: row.reversal_reason || null,
    cutover_version: Number(row.cutover_version || 1),
    source_name: row.source_name || null
  });
}

function rowToMealServiceConsumption(row = {}) {
  const allocations = Array.isArray(row.allocations) ? row.allocations : [];
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
    service_date: toDateOnlyOrNull(row.service_date),
    meal_type: row.meal_period || null,
    menu_type: row.menu_type || null,
    cuisine_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    consumed_weight_grams: Number(row.consumed_weight_grams || 0),
    consumed_servings: Number(row.consumed_servings || 0),
    menu_plan_id: row.menu_plan_id || null,
    customer_meal_plan_id: row.customer_meal_plan_id || null,
    recipe_name: row.recipe_name || null,
    attendee_count: toNumberOrNull(row.attendee_count),
    portions_per_attendee: toNumberOrNull(row.portions_per_attendee),
    servings_per_attendee: toNumberOrNull(row.servings_per_attendee),
    portion_size_grams: toNumberOrNull(row.portion_size_grams),
    manual_portion_size_grams: toNumberOrNull(row.manual_portion_size_grams),
    portion_size_source: row.portion_size_source || null,
    covers: toNumberOrNull(row.covers),
    required_servings: toNumberOrNull(row.required_servings),
    required_weight_grams: toNumberOrNull(row.required_weight_grams),
    consumed_production_equivalent_servings: toNumberOrNull(row.consumed_production_equivalent_servings),
    shortage_servings: toNumberOrNull(row.shortage_servings),
    shortage_weight_grams: toNumberOrNull(row.shortage_weight_grams),
    reversal_reason: row.reversal_reason || null,
    performed_by: row.performed_by || null,
    performed_by_name: row.performed_by_name || null,
    performed_at: rowTimestamp(row.performed_at),
    cost: Number(row.cost || 0),
    status: row.status || 'posted',
    allocations,
    cutover_version: Number(row.cutover_version || 1)
  });
}

function rowToFoodWaste(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const evidenceImageUrls = normalizeFoodWasteImageUrls({
    ...payload,
    evidence_image_urls: row.evidence_image_urls || payload.evidence_image_urls,
    image_urls: row.image_urls || payload.image_urls,
    evidence_image_url: row.evidence_image_url || payload.evidence_image_url,
    image_url: row.image_url || payload.image_url
  });
  const outputAllocations = Array.isArray(row.output_allocations)
    ? row.output_allocations
    : Array.isArray(payload.output_allocations)
      ? payload.output_allocations
      : [];
  const inventoryMovementLayers = Array.isArray(row.inventory_movement_layers)
    ? row.inventory_movement_layers
    : Array.isArray(payload.inventory_movement_layers)
      ? payload.inventory_movement_layers
      : [];
  const storedWasteWeightGrams = toNumberOrZero(
    row.total_waste_weight_grams
    ?? row.quantity_grams
    ?? payload.waste_weight_grams
    ?? payload.quantity_grams
  );
  const totalWasteWeightGrams = storedWasteWeightGrams || foodWasteQuantityToGrams(payload.quantity, payload.unit);
  const totalWasteCost = toNumberOrZero(
    row.total_waste_cost
    ?? row.estimated_cost
    ?? payload.estimated_cost
    ?? payload.waste_cost
    ?? payload.cost
  );
  return withPayload(row, {
    __entity: 'FoodWaste',
    id: row.food_waste_id,
    waste_reference: row.waste_reference || null,
    idempotency_key: row.idempotency_key || null,
    site_id: row.warehouse_id,
    waste_date: toDateOnlyOrNull(row.waste_date),
    meal_type: row.meal_period || null,
    menu_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    waste_category: row.waste_category,
    reason_code: row.reason_code || null,
    reason: row.reason || null,
    waste_scope: row.waste_scope || 'ingredient',
    source_type: row.source_type || 'manual_entry',
    avoidable_type: row.avoidable_type || 'avoidable',
    preventable: row.preventable !== false,
    auto_generated: row.auto_generated === true,
    high_value: row.high_value === true,
    served_at: rowTimestamp(row.served_at),
    production_completed_at: rowTimestamp(row.production_completed_at),
    recording_window_basis: row.recording_window_basis || null,
    recording_window_open_at: rowTimestamp(row.recording_window_open_at),
    recording_deadline_at: rowTimestamp(row.recording_deadline_at),
    menu_plan_id: row.menu_plan_id || null,
    menu_plan_name: row.menu_plan_name || null,
    meal_service_attendance_id: row.meal_service_id || null,
    meal_service_id: row.meal_service_id || null,
    production_id: row.production_id || null,
    production_name: row.production_name || null,
    recipe_id: row.recipe_version_id || null,
    recipe_version_id: row.recipe_version_id || null,
    recipe_name: row.recipe_name || null,
    ingredient_id: row.ingredient_id || null,
    ingredient_name: row.ingredient_name || null,
    batch_reference: row.batch_reference || null,
    batch_overproduction_item_key: row.batch_overproduction_item_key || null,
    manifest_item_key: row.manifest_item_key || null,
    source_menu_plan_item_key: row.source_menu_plan_item_key || null,
    batch_recipe_id: row.batch_recipe_id || null,
    batch_recipe_name: row.batch_recipe_name || null,
    produced_weight_grams: toNumberOrNull(row.produced_weight_grams),
    available_weight_grams_before: toNumberOrNull(row.available_weight_grams_before),
    wasted_production_equivalent_servings: toNumberOrNull(row.wasted_production_equivalent_servings),
    meal_service_adjustment_cost: toNumberOrZero(row.meal_service_adjustment_cost),
    inventory_transaction_id: row.inventory_transaction_id || null,
    inventory_deduction_quantity: toNumberOrZero(row.inventory_deduction_quantity),
    inventory_shortage_quantity: toNumberOrZero(row.inventory_shortage_quantity),
    inventory_movement_layers: inventoryMovementLayers,
    notes: row.notes || null,
    approval_status: row.approval_status || 'pending',
    status: row.status || 'posted',
    recorded_by: row.recorded_by || null,
    reversed_by: row.reversed_by || null,
    reversed_at: rowTimestamp(row.reversed_at),
    reversal_reason: row.reversal_reason || null,
    source_name: row.source_name || null,
    quantity: totalWasteWeightGrams,
    quantity_grams: totalWasteWeightGrams,
    waste_weight_grams: totalWasteWeightGrams,
    unit: row.unit || 'g',
    estimated_cost: totalWasteCost,
    waste_cost: totalWasteCost,
    cost: totalWasteCost,
    output_allocations: outputAllocations,
    evidence_image_url: evidenceImageUrls[0] || null,
    image_url: evidenceImageUrls[0] || null,
    evidence_image_urls: evidenceImageUrls,
    image_urls: evidenceImageUrls
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
  if (entity === 'Production') {
    return `SELECT event.*,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', line.production_line_id,
                         'production_line_id', line.production_line_id,
                         'menu_plan_line_id', line.menu_plan_line_id,
                         'line_number', line.line_number,
                         'line_type', line.line_type,
                         'key', COALESCE(line.item_key, line.source_menu_plan_item_key, line.production_line_id),
                         'manifest_item_key', COALESCE(line.item_key, line.source_menu_plan_item_key, line.production_line_id),
                         'source_menu_plan_item_key', line.source_menu_plan_item_key,
                         'recipe_id', line.recipe_version_id,
                         'recipe_version_id', line.recipe_version_id,
                         'recipe_code', line.recipe_code,
                         'ingredient_id', line.ingredient_id,
                         'ingredient_name', line.ingredient_name,
                         'item_name', line.item_name,
                         'recipe_name', line.item_name,
                         'name', line.item_name,
                         'meal_type', line.meal_period,
                         'requested_servings', line.requested_servings,
                         'requested_weight_grams', line.requested_weight_grams,
                         'produced_servings', line.produced_servings,
                         'produced_weight_grams', line.produced_weight_grams,
                         'production_covers', line.production_covers,
                         'expected_servings', COALESCE(line.production_covers, line.requested_servings, line.produced_servings),
                         'raw_weight_grams', line.raw_weight_grams,
                         'yielded_weight_grams', line.yielded_weight_grams,
                         'expected_finished_weight_grams', line.expected_finished_weight_grams,
                         'portion_size_grams', line.portion_size_grams,
                         'expected_yield_servings', line.expected_yield_servings,
                         'output_calculation_source', line.output_calculation_source,
                         'weight_calculation_source', line.weight_calculation_source,
                         'yield_calculation_source', line.yield_calculation_source,
                         'weight_snapshot_version', line.weight_snapshot_version,
                         'estimated_cost', line.estimated_cost,
                         'estimated_batch_cost', line.estimated_cost,
                         'actual_cost', line.actual_cost,
                         'status', line.status,
                         'source_name', line.source_name
                       )
                       ORDER BY line.line_number
                     )
                     FROM production_manifest_lines line
                     WHERE line.production_id = event.production_id
                   ), '[]'::jsonb) AS manifest_lines
            FROM production_events event`;
  }
  if (entity === 'ProductionConsumptionReport') {
    return `SELECT report.*,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'ingredient_id', line.ingredient_id,
                         'item_code', line.item_code,
                         'ingredient_name', line.ingredient_name,
                         'unit', line.unit,
                         'recipe_quantity', line.recipe_quantity,
                         'recipe_unit', line.recipe_unit,
                         'inventory_unit', line.inventory_unit,
                         'planned_quantity', line.planned_quantity,
                         'actual_requested_quantity', line.actual_requested_quantity,
                         'issued_quantity', line.issued_quantity,
                         'shortage_quantity', line.shortage_quantity,
                         'posted_cost', line.posted_cost,
                         'estimated_shortage_cost', line.estimated_shortage_cost,
                         'quantity_basis', line.quantity_basis,
                         'source_recipe_names', COALESCE((
                           SELECT jsonb_agg(source.recipe_name ORDER BY source.source_order)
                           FROM production_consumption_report_line_sources source
                           WHERE source.report_line_id = line.report_line_id
                         ), '[]'::jsonb),
                         'yield_percent', line.yield_percent,
                         'raw_weight_grams', line.raw_weight_grams,
                         'yielded_weight_grams', line.yielded_weight_grams,
                         'weight_calculation_source', line.weight_calculation_source,
                         'yield_calculation_source', line.yield_calculation_source,
                         'unit_status', line.unit_status,
                         'conversion_note', line.conversion_note,
                         'inventory_transaction_id', line.inventory_transaction_id,
                         'inventory_transaction_ids', COALESCE((
                           SELECT jsonb_agg(txn.inventory_transaction_id ORDER BY txn.transaction_order)
                           FROM production_consumption_report_line_transactions txn
                           WHERE txn.report_line_id = line.report_line_id
                         ), CASE WHEN COALESCE(line.inventory_transaction_id, '') <> ''
                           THEN jsonb_build_array(line.inventory_transaction_id)
                           ELSE '[]'::jsonb
                         END),
                         'movement_layers', COALESCE((
                           SELECT jsonb_agg(
                             jsonb_build_object(
                               'inventory_lot_id', layer.inventory_lot_id,
                               'batch_number', layer.batch_number,
                               'stock_date', layer.stock_date,
                               'received_date', layer.received_date,
                               'expiry_date', layer.expiry_date,
                               'quantity', layer.quantity,
                               'quantity_before', layer.quantity_before,
                               'quantity_after', layer.quantity_after,
                               'reserved_quantity_before', layer.reserved_quantity_before,
                               'reserved_quantity_after', layer.reserved_quantity_after,
                               'available_quantity_before', layer.available_quantity_before,
                               'available_quantity_after', layer.available_quantity_after,
                               'unit_cost', layer.unit_cost,
                               'total_cost', layer.total_cost,
                               'accounting_unit_cost', layer.accounting_unit_cost,
                               'accounting_total_cost', layer.accounting_total_cost,
                               'production_id', layer.production_id,
                               'commitment_revision', layer.commitment_revision,
                               'operation_id', layer.operation_id,
                               'source_name', layer.source_name
                             )
                             ORDER BY layer.layer_order
                           )
                           FROM production_consumption_report_line_layers layer
                           WHERE layer.report_line_id = line.report_line_id
                         ), '[]'::jsonb),
                         'status', line.status,
                         'source_name', line.source_name
                       )
                       ORDER BY line.line_number
                     )
                     FROM production_consumption_report_lines line
                     WHERE line.report_id = report.report_id
                   ), '[]'::jsonb) AS ingredient_lines,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', item.production_line_id,
                         'production_line_id', item.production_line_id,
                         'recipe_id', item.recipe_version_id,
                         'recipe_version_id', item.recipe_version_id,
                         'ingredient_id', item.ingredient_id,
                         'item_name', item.item_name,
                         'recipe_name', item.recipe_name,
                         'name', COALESCE(item.recipe_name, item.item_name),
                         'line_type', item.line_type,
                         'key', item.item_key,
                         'manifest_item_key', item.item_key,
                         'source_menu_plan_item_key', item.source_menu_plan_item_key,
                         'original_source_menu_plan_item_key', item.original_source_menu_plan_item_key,
                         'recipe_code', item.recipe_code,
                         'ingredient_name', item.ingredient_name,
                         'meal_type', item.meal_period,
                         'requested_servings', item.requested_servings,
                         'requested_weight_grams', item.requested_weight_grams,
                         'produced_servings', item.produced_servings,
                         'produced_weight_grams', item.produced_weight_grams,
                         'production_covers', item.production_covers,
                         'expected_servings', item.production_covers,
                         'raw_weight_grams', item.raw_weight_grams,
                         'yielded_weight_grams', item.yielded_weight_grams,
                         'expected_finished_weight_grams', item.expected_finished_weight_grams,
                         'portion_size_grams', item.portion_size_grams,
                         'expected_yield_servings', item.expected_yield_servings,
                         'output_calculation_source', item.output_calculation_source,
                         'weight_calculation_source', item.weight_calculation_source,
                         'yield_calculation_source', item.yield_calculation_source,
                         'weight_snapshot_version', item.weight_snapshot_version,
                         'estimated_cost', item.estimated_cost,
                         'estimated_batch_cost', item.estimated_cost,
                         'actual_cost', item.actual_cost,
                         'status', item.status,
                         'source_name', item.source_name
                       )
                       ORDER BY item.item_order
                     )
                     FROM production_consumption_report_menu_items item
                     WHERE item.report_id = report.report_id
                   ), '[]'::jsonb) AS menu_issue_items,
                   COALESCE((
                     SELECT jsonb_object_agg(unit_total.unit, unit_total.shortage_quantity)
                     FROM production_consumption_report_unit_totals unit_total
                     WHERE unit_total.report_id = report.report_id
                   ), '{}'::jsonb) AS shortage_totals_by_unit,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'partially_reversed_at', event.event_timestamp,
                         'partially_reversed_by', COALESCE(event.actor_email, event.actor_id),
                         'partially_reversed_by_name', event.actor_name,
                         'reason', event.reason,
                         'returned_line_count', event.returned_line_count,
                         'returned_total_cost', event.returned_total_cost,
                         'reversed_manifest_items', COALESCE((
                           SELECT jsonb_agg(
                             jsonb_build_object(
                               'key', manifest.item_key,
                               'name', manifest.item_name,
                               'reversed_weight_grams', manifest.reversed_weight_grams,
                               'reversal_ratio', manifest.reversal_ratio
                             )
                             ORDER BY manifest.item_order
                           )
                           FROM production_consumption_report_event_manifest_items manifest
                           WHERE manifest.report_event_id = event.report_event_id
                         ), '[]'::jsonb),
                         'returned_lines', COALESCE((
                           SELECT jsonb_agg(
                             jsonb_build_object(
                               'source_line_index', event_line.source_line_index,
                               'ingredient_id', event_line.ingredient_id,
                               'ingredient_name', event_line.ingredient_name,
                               'item_code', event_line.item_code,
                               'unit', event_line.unit,
                               'requested_quantity', event_line.requested_quantity,
                               'returned_quantity', event_line.returned_quantity,
                               'total_cost', event_line.total_cost,
                               'transaction_id', event_line.inventory_transaction_id,
                               'movement_layers', COALESCE((
                                 SELECT jsonb_agg(
                                   jsonb_build_object(
                                     'inventory_lot_id', event_layer.inventory_lot_id,
                                     'batch_number', event_layer.batch_number,
                                     'stock_date', event_layer.stock_date,
                                     'received_date', event_layer.received_date,
                                     'expiry_date', event_layer.expiry_date,
                                     'quantity', event_layer.quantity,
                                     'quantity_before', event_layer.quantity_before,
                                     'quantity_after', event_layer.quantity_after,
                                     'reserved_quantity_before', event_layer.reserved_quantity_before,
                                     'reserved_quantity_after', event_layer.reserved_quantity_after,
                                     'available_quantity_before', event_layer.available_quantity_before,
                                     'available_quantity_after', event_layer.available_quantity_after,
                                     'unit_cost', event_layer.unit_cost,
                                     'total_cost', event_layer.total_cost,
                                     'accounting_unit_cost', event_layer.accounting_unit_cost,
                                     'accounting_total_cost', event_layer.accounting_total_cost,
                                     'production_id', event_layer.production_id,
                                     'commitment_revision', event_layer.commitment_revision,
                                     'operation_id', event_layer.operation_id,
                                     'source_name', event_layer.source_name
                                   )
                                   ORDER BY event_layer.layer_order
                                 )
                                 FROM production_consumption_report_event_line_layers event_layer
                                 WHERE event_layer.report_event_line_id = event_line.report_event_line_id
                               ), '[]'::jsonb)
                             )
                             ORDER BY event_line.line_order
                           )
                           FROM production_consumption_report_event_lines event_line
                           WHERE event_line.report_event_id = event.report_event_id
                         ), '[]'::jsonb),
                         'preserved_active_output_usage', jsonb_build_object(
                           'served_weight_grams', event.served_weight_grams,
                           'wasted_weight_grams', event.wasted_weight_grams,
                           'served_servings', event.served_servings,
                           'wasted_servings', event.wasted_servings
                         )
                       )
                       ORDER BY event.event_order
                     )
                     FROM production_consumption_report_events event
                     WHERE event.report_id = report.report_id
                       AND event.event_type = 'partial_reversal'
                   ), '[]'::jsonb) AS partial_reversal_history,
                   COALESCE((
                     SELECT jsonb_build_object(
                       'partially_reversed_at', event.event_timestamp,
                       'partially_reversed_by', COALESCE(event.actor_email, event.actor_id),
                       'partially_reversed_by_name', event.actor_name,
                       'reason', event.reason,
                       'returned_line_count', event.returned_line_count,
                       'returned_total_cost', event.returned_total_cost,
                       'reversed_manifest_items', COALESCE((
                         SELECT jsonb_agg(
                           jsonb_build_object(
                             'key', manifest.item_key,
                             'name', manifest.item_name,
                             'reversed_weight_grams', manifest.reversed_weight_grams,
                             'reversal_ratio', manifest.reversal_ratio
                           )
                           ORDER BY manifest.item_order
                         )
                         FROM production_consumption_report_event_manifest_items manifest
                         WHERE manifest.report_event_id = event.report_event_id
                       ), '[]'::jsonb),
                       'returned_lines', COALESCE((
                         SELECT jsonb_agg(
                           jsonb_build_object(
                             'source_line_index', event_line.source_line_index,
                             'ingredient_id', event_line.ingredient_id,
                             'ingredient_name', event_line.ingredient_name,
                             'item_code', event_line.item_code,
                             'unit', event_line.unit,
                             'requested_quantity', event_line.requested_quantity,
                             'returned_quantity', event_line.returned_quantity,
                             'total_cost', event_line.total_cost,
                             'transaction_id', event_line.inventory_transaction_id
                           )
                           ORDER BY event_line.line_order
                         )
                         FROM production_consumption_report_event_lines event_line
                         WHERE event_line.report_event_id = event.report_event_id
                       ), '[]'::jsonb),
                       'preserved_active_output_usage', jsonb_build_object(
                         'served_weight_grams', event.served_weight_grams,
                         'wasted_weight_grams', event.wasted_weight_grams,
                         'served_servings', event.served_servings,
                         'wasted_servings', event.wasted_servings
                       )
                     )
                     FROM production_consumption_report_events event
                     WHERE event.report_id = report.report_id
                       AND event.event_type = 'partial_reversal'
                     ORDER BY event.event_order DESC
                     LIMIT 1
                   ), '{}'::jsonb) AS partial_reversal_summary,
                   COALESCE((
                     SELECT jsonb_build_object(
                       'reversed_at', event.event_timestamp,
                       'reversed_by', COALESCE(event.actor_email, event.actor_id),
                       'reversed_by_name', event.actor_name,
                       'reason', event.reason,
                       'returned_line_count', event.returned_line_count,
                       'returned_total_cost', event.returned_total_cost,
                       'returned_lines', COALESCE((
                         SELECT jsonb_agg(
                           jsonb_build_object(
                             'ingredient_id', event_line.ingredient_id,
                             'ingredient_name', event_line.ingredient_name,
                             'item_code', event_line.item_code,
                             'unit', event_line.unit,
                             'returned_quantity', event_line.returned_quantity,
                             'total_cost', event_line.total_cost,
                             'transaction_id', event_line.inventory_transaction_id
                           )
                           ORDER BY event_line.line_order
                         )
                         FROM production_consumption_report_event_lines event_line
                         WHERE event_line.report_event_id = event.report_event_id
                       ), '[]'::jsonb)
                     )
                     FROM production_consumption_report_events event
                     WHERE event.report_id = report.report_id
                       AND event.event_type = 'full_reversal'
                     ORDER BY event.event_order DESC
                     LIMIT 1
                   ), '{}'::jsonb) AS reversal_summary
            FROM production_consumption_reports report`;
  }
  if (entity === 'ProducedItemBatch') {
    return `SELECT batch.*, event.production_date, event.meal_period, event.menu_type,
                   event.menu_category, event.completed_at, line.item_name
            FROM produced_output_batches batch
            JOIN production_events event ON event.production_id = batch.production_id
            JOIN production_manifest_lines line ON line.production_line_id = batch.production_line_id`;
  }
  if (entity === 'MealServiceAttendance') {
    return `SELECT header.*,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', item.meal_service_item_id,
                         'meal_service_item_id', item.meal_service_item_id,
                         'output_batch_id', item.output_batch_id,
                         'produced_item_batch_id', item.output_batch_id,
                         'batch_id', item.output_batch_id,
                         'production_id', item.production_id,
                         'recipe_id', item.recipe_version_id,
                         'recipe_version_id', item.recipe_version_id,
                         'recipe_name', item.recipe_name,
                         'item_name', item.item_name,
                         'attendee_count', item.attendee_count,
                         'portions_per_attendee', item.portions_per_attendee,
                         'servings_per_attendee', item.servings_per_attendee,
                         'portion_size_grams', item.portion_size_grams,
                         'manual_portion_size_grams', item.manual_portion_size_grams,
                         'portion_size_source', item.portion_size_source,
                         'required_servings', item.required_servings,
                         'required_weight_grams', item.required_weight_grams,
                         'served_servings', item.served_servings,
                         'served_weight_grams', item.served_weight_grams,
                         'consumed_production_equivalent_servings', item.consumed_production_equivalent_servings,
                         'shortage_servings', item.shortage_servings,
                         'short_servings', item.shortage_servings,
                         'shortage_weight_grams', item.shortage_weight_grams,
                         'short_weight_grams', item.shortage_weight_grams,
                         'cost', item.cost,
                         'total_cost', item.cost,
                         'status', item.status
                       )
                       ORDER BY item.item_order
                     )
                     FROM meal_service_items item
                     WHERE item.meal_service_id = header.meal_service_id
                   ), '[]'::jsonb) AS items
            FROM meal_service_headers header`;
  }
  if (entity === 'MealServiceConsumption') {
    return `SELECT consumption.*, header.warehouse_id,
                   COALESCE(consumption.menu_type, header.menu_type) AS menu_type,
                   COALESCE(consumption.menu_category, header.menu_category) AS menu_category,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', allocation.meal_service_consumption_allocation_id,
                         'meal_service_consumption_allocation_id', allocation.meal_service_consumption_allocation_id,
                         'output_batch_id', allocation.output_batch_id,
                         'produced_item_batch_id', allocation.output_batch_id,
                         'batch_id', allocation.output_batch_id,
                         'production_id', allocation.production_id,
                         'batch_number', allocation.batch_number,
                         'portion_size_grams', allocation.portion_size_grams,
                         'service_portion_size_grams', allocation.service_portion_size_grams,
                         'servings', allocation.servings,
                         'production_equivalent_servings', allocation.production_equivalent_servings,
                         'meal_portions', allocation.meal_portions,
                         'weight_grams', allocation.weight_grams,
                         'remaining_servings_before', allocation.remaining_servings_before,
                         'remaining_servings_after', allocation.remaining_servings_after,
                         'remaining_weight_grams_before', allocation.remaining_weight_grams_before,
                         'remaining_weight_grams_after', allocation.remaining_weight_grams_after,
                         'status', allocation.status
                       )
                       ORDER BY allocation.allocation_order
                     )
                     FROM meal_service_consumption_allocations allocation
                     WHERE allocation.meal_consumption_id = consumption.meal_consumption_id
                   ), '[]'::jsonb) AS allocations
            FROM meal_service_consumptions consumption
            JOIN meal_service_headers header ON header.meal_service_id = consumption.meal_service_id`;
  }
  if (entity === 'FoodWaste') {
    return `SELECT waste.*,
                   COALESCE((
                     SELECT ARRAY_AGG(image.image_url ORDER BY image.image_order, image.created_at, image.food_waste_image_id)
                     FROM food_waste_images image
                     WHERE image.food_waste_id = waste.food_waste_id
                   ), ARRAY[]::text[]) AS evidence_image_urls,
                   COALESCE((
                     SELECT ARRAY_AGG(image.image_url ORDER BY image.image_order, image.created_at, image.food_waste_image_id)
                     FROM food_waste_images image
                     WHERE image.food_waste_id = waste.food_waste_id
                   ), ARRAY[]::text[]) AS image_urls,
                   (
                     SELECT image.image_url
                     FROM food_waste_images image
                     WHERE image.food_waste_id = waste.food_waste_id
                     ORDER BY image.image_order, image.created_at, image.food_waste_image_id
                     LIMIT 1
                   ) AS evidence_image_url,
                   (
                     SELECT image.image_url
                     FROM food_waste_images image
                     WHERE image.food_waste_id = waste.food_waste_id
                     ORDER BY image.image_order, image.created_at, image.food_waste_image_id
                     LIMIT 1
                   ) AS image_url,
                   COALESCE((
                     SELECT SUM(line.waste_weight_grams)
                     FROM food_waste_lines line
                     WHERE line.food_waste_id = waste.food_waste_id
                       AND COALESCE(line.status, 'posted') <> 'reversed'
                   ), 0) AS total_waste_weight_grams,
                   COALESCE((
                     SELECT SUM(line.cost)
                     FROM food_waste_lines line
                     WHERE line.food_waste_id = waste.food_waste_id
                       AND COALESCE(line.status, 'posted') <> 'reversed'
                   ), 0) AS total_waste_cost,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', line.food_waste_line_id,
                         'food_waste_line_id', line.food_waste_line_id,
                         'produced_item_batch_id', line.output_batch_id,
                         'output_batch_id', line.output_batch_id,
                         'production_id', line.production_id,
                         'production_line_id', line.production_line_id,
                         'recipe_id', line.recipe_version_id,
                         'recipe_version_id', line.recipe_version_id,
                         'ingredient_id', line.ingredient_id,
                         'line_number', line.line_number,
                         'item_name', line.item_name,
                         'recipe_name', line.item_name,
                         'batch_number', line.batch_number,
                         'batch_overproduction_item_key', line.batch_overproduction_item_key,
                         'manifest_item_key', line.manifest_item_key,
                         'source_menu_plan_item_key', line.source_menu_plan_item_key,
                         'waste_weight_grams', line.waste_weight_grams,
                         'quantity_grams', line.waste_weight_grams,
                         'wasted_production_equivalent_servings', line.wasted_production_equivalent_servings,
                         'produced_weight_grams', line.produced_weight_grams_before,
                         'available_weight_grams_before', line.available_weight_grams_before,
                         'cost', line.cost,
                         'status', line.status
                       )
                       ORDER BY line.created_at, line.food_waste_line_id
                     )
                     FROM food_waste_lines line
                     WHERE line.food_waste_id = waste.food_waste_id
                   ), '[]'::jsonb) AS output_allocations,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', movement.food_waste_inventory_movement_id,
                         'inventory_transaction_id', movement.inventory_transaction_id,
                         'inventory_id', movement.inventory_id,
                         'lot_id', movement.lot_id,
                         'ingredient_id', movement.ingredient_id,
                         'quantity', movement.quantity,
                         'unit', movement.unit,
                         'unit_cost', movement.unit_cost,
                         'total_cost', movement.total_cost,
                         'stock_date', movement.stock_date,
                         'expiry_date', movement.expiry_date,
                         'source_name', movement.source_name
                       )
                       ORDER BY movement.movement_order, movement.food_waste_inventory_movement_id
                     )
                     FROM food_waste_inventory_movements movement
                     WHERE movement.food_waste_id = waste.food_waste_id
                   ), '[]'::jsonb) AS inventory_movement_layers
            FROM food_waste_records waste`;
  }
  if (entity === 'RoleProfile') {
    return `SELECT role_profile.id,
                   role_profile.role_key,
                   role_profile.name,
                   role_profile.description,
                   role_profile.access_level,
                   role_profile.dashboard_variant,
                   role_profile.is_active,
                   role_profile.is_system,
                   role_profile.status,
                   role_profile.source_name,
                   role_profile.created_at,
                   role_profile.updated_at,
                   COALESCE(
                     ARRAY_AGG(permission.permission_key ORDER BY permission.permission_key)
                       FILTER (WHERE permission.permission_key IS NOT NULL),
                     ARRAY[]::text[]
                   ) AS permissions
              FROM role_profiles role_profile
              LEFT JOIN role_profile_permissions permission
                ON permission.role_profile_id = role_profile.id
             GROUP BY role_profile.id`;
  }
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
    FoodWaste: 'food_waste_id',
    RoleProfile: 'id'
  })[entity] || normalizedSimpleConfigs[entity]?.idColumn;
}

function normalizedMapper(entity) {
  if (entity === 'RoleProfile') return rowToRoleProfile;
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
      source_type: 'source_type',
      source_event_id: 'source_event_id',
      source_event_recipe_id: 'source_event_recipe_id',
      source_menu_plan_item_key: 'source_menu_plan_item_key',
      production_issue_grouped: 'production_issue_grouped',
      production_issue_group_key: 'production_issue_group_key',
      production_issue_scope: 'production_issue_scope',
      production_issue_item_count: 'production_issue_item_count',
      production_issue_dish_count: 'production_issue_dish_count',
      target_servings: 'target_servings',
      ingredient_cost_total: 'ingredient_cost_total',
      production_cost_total: 'production_cost_total',
      cost_per_serving: 'cost_per_serving',
      total_shortage_quantity: 'total_shortage_quantity',
      consumption_report_id: 'consumption_report_id',
      consumption_report_number: 'consumption_report_number',
      produced_item_batch_id: 'produced_item_batch_id',
      produced_item_batch_number: 'produced_item_batch_number',
      reconciliation_mode: 'reconciliation_mode',
      output_calculation_source: 'output_calculation_source',
      portion_size_grams: 'portion_size_grams',
      expected_yield_servings: 'expected_yield_servings',
      produced_servings: 'produced_servings',
      produced_weight_grams: 'produced_weight_grams',
      completed_by: 'completed_by',
      completed_at: 'completed_at',
      completed_date: 'completed_at',
      reversed_by: 'reversed_by',
      reversed_at: 'reversed_at'
    },
    ProductionConsumptionReport: {
      report_id: 'report_id',
      report_number: 'report_number',
      report_name: 'report_name',
      production_id: 'production_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      requesting_site_id: 'requesting_warehouse_id',
      fulfillment_store_id: 'fulfillment_store_id',
      recipe_id: 'recipe_version_id',
      recipe_version_id: 'recipe_version_id',
      production_date: 'production_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      menu_type: 'menu_type',
      cuisine_type: 'menu_type',
      menu_category: 'menu_category',
      production_issue_grouped: 'production_issue_grouped',
      production_issue_item_count: 'production_issue_item_count',
      production_issue_dish_count: 'production_issue_dish_count',
      target_servings: 'target_servings',
      completed_by: 'completed_by',
      completed_at: 'completed_at',
      quantity_basis: 'quantity_basis',
      reconciliation_mode: 'reconciliation_mode',
      output_calculation_source: 'output_calculation_source',
      recipe_raw_weight_grams: 'recipe_raw_weight_grams',
      expected_finished_weight_grams: 'expected_finished_weight_grams',
      total_raw_consumption_weight_grams: 'total_raw_consumption_weight_grams',
      total_yielded_weight_grams: 'total_yielded_weight_grams',
      portion_size_grams: 'portion_size_grams',
      expected_yield_servings: 'expected_yield_servings',
      total_consumption_cost: 'total_consumption_cost',
      total_shortage_cost: 'total_shortage_cost',
      shortage_line_count: 'shortage_line_count',
      ingredient_line_count: 'ingredient_line_count',
      reversed_by: 'reversed_by',
      reversed_at: 'reversed_at'
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
      served_weight_grams: 'served_weight_grams',
      wasted_weight_grams: 'wasted_weight_grams',
      served_servings: 'served_servings',
      wasted_servings: 'wasted_servings',
      portion_size_grams: 'portion_size_grams',
      service_portion_size_grams: 'service_portion_size_grams',
      expected_servings: 'expected_servings',
      expected_finished_weight_grams: 'expected_finished_weight_grams',
      actual_finished_weight_grams: 'actual_finished_weight_grams',
      source_type: 'source_type',
      source_event_id: 'source_event_id',
      menu_plan_id: 'menu_plan_id',
      consumption_report_id: 'consumption_report_id',
      consumption_report_number: 'consumption_report_number',
      production_issue_grouped: 'production_issue_grouped',
      production_issue_item_count: 'production_issue_item_count',
      production_issue_dish_count: 'production_issue_dish_count',
      completed_by: 'completed_by',
      reconciliation_mode: 'reconciliation_mode',
      output_calculation_source: 'output_calculation_source',
      cutover_version: 'cutover_version',
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
      request_fingerprint: 'request_fingerprint',
      reversal_idempotency_key: 'reversal_idempotency_key',
      reversal_request_fingerprint: 'reversal_request_fingerprint',
      scope_key: 'scope_key',
      menu_plan_id: 'menu_plan_id',
      menu_plan_name: 'menu_plan_name',
      customer_meal_plan_id: 'customer_meal_plan_id',
      customer_meal_plan_name: 'customer_meal_plan_name',
      customer_name: 'customer_name',
      customer_id: 'customer_id',
      category: 'category',
      attendee_count: 'attendee_count',
      scan_method: 'scan_method',
      notes: 'notes',
      required_servings: 'required_servings',
      required_weight_grams: 'required_weight_grams',
      served_servings: 'served_servings',
      served_weight_grams: 'served_weight_grams',
      shortage_servings: 'shortage_servings',
      short_servings: 'shortage_servings',
      shortage_weight_grams: 'shortage_weight_grams',
      short_weight_grams: 'shortage_weight_grams',
      recorded_by: 'recorded_by',
      recorded_by_name: 'recorded_by_name',
      recorded_at: 'recorded_at',
      posted_by: 'posted_by',
      reversed_by: 'reversed_by',
      reversed_by_name: 'reversed_by_name',
      reversed_at: 'reversed_at',
      reversal_reason: 'reversal_reason',
      cutover_version: 'cutover_version'
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
      menu_plan_id: 'menu_plan_id',
      customer_meal_plan_id: 'customer_meal_plan_id',
      recipe_name: 'recipe_name',
      attendee_count: 'attendee_count',
      portions_per_attendee: 'portions_per_attendee',
      servings_per_attendee: 'servings_per_attendee',
      portion_size_grams: 'portion_size_grams',
      manual_portion_size_grams: 'manual_portion_size_grams',
      portion_size_source: 'portion_size_source',
      covers: 'covers',
      required_servings: 'required_servings',
      required_weight_grams: 'required_weight_grams',
      consumed_production_equivalent_servings: 'consumed_production_equivalent_servings',
      shortage_servings: 'shortage_servings',
      short_servings: 'shortage_servings',
      shortage_weight_grams: 'shortage_weight_grams',
      short_weight_grams: 'shortage_weight_grams',
      reversal_reason: 'reversal_reason',
      performed_by: 'performed_by',
      performed_by_name: 'performed_by_name',
      performed_at: 'performed_at',
      cutover_version: 'cutover_version',
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
      reason: 'reason',
      waste_scope: 'waste_scope',
      source_type: 'source_type',
      avoidable_type: 'avoidable_type',
      preventable: 'preventable',
      auto_generated: 'auto_generated',
      high_value: 'high_value',
      quantity: 'quantity_grams',
      quantity_grams: 'quantity_grams',
      waste_weight_grams: 'quantity_grams',
      unit: 'unit',
      estimated_cost: 'estimated_cost',
      cost: 'estimated_cost',
      menu_plan_id: 'menu_plan_id',
      meal_service_attendance_id: 'meal_service_id',
      meal_service_id: 'meal_service_id',
      production_id: 'production_id',
      recipe_id: 'recipe_version_id',
      recipe_version_id: 'recipe_version_id',
      ingredient_id: 'ingredient_id',
      batch_reference: 'batch_reference',
      batch_overproduction_item_key: 'batch_overproduction_item_key',
      manifest_item_key: 'manifest_item_key',
      source_menu_plan_item_key: 'source_menu_plan_item_key',
      inventory_transaction_id: 'inventory_transaction_id',
      approval_status: 'approval_status',
      recorded_by: 'recorded_by',
      reversed_by: 'reversed_by',
      reversed_at: 'reversed_at'
    },
    RoleProfile: {
      role_key: 'role_key',
      name: 'name',
      access_level: 'access_level',
      dashboard_variant: 'dashboard_variant',
      is_active: 'is_active',
      is_system: 'is_system'
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
          'MenuPlan'
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
      ingredient_id, item_name, line_type, item_key, source_menu_plan_item_key,
      recipe_code, ingredient_name, meal_period, requested_servings, requested_weight_grams,
      produced_servings, produced_weight_grams, production_covers, raw_weight_grams,
      yielded_weight_grams, expected_finished_weight_grams, portion_size_grams,
      expected_yield_servings, output_calculation_source, weight_calculation_source,
      yield_calculation_source, weight_snapshot_version, estimated_cost, actual_cost,
      status, source_name,
      created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
      $31,$32,$33
    )
    ON CONFLICT (production_line_id) DO NOTHING`,
    [
      lineId,
      record.id || record.production_id,
      record.menu_plan_line_id || null,
      1,
      record.recipe_id || null,
      record.ingredient_id || null,
      record.production_name || record.recipe_name || record.name || 'Production item',
      record.line_type || 'recipe',
      record.key || record.manifest_item_key || record.source_menu_plan_item_key || null,
      record.source_menu_plan_item_key || null,
      record.recipe_code || null,
      record.ingredient_name || null,
      record.meal_type || null,
      toNumberOrNull(record.target_servings || record.production_covers || record.produced_servings),
      toNumberOrNull(record.requested_weight_grams || record.production_size_grams),
      toNumberOrNull(record.produced_servings || record.production_covers),
      toNumberOrNull(record.produced_weight_grams || record.finished_weight_grams || record.production_size_grams),
      toNumberOrNull(record.production_covers || record.target_servings),
      toNumberOrNull(record.raw_weight_grams),
      toNumberOrNull(record.yielded_weight_grams),
      toNumberOrNull(record.expected_finished_weight_grams),
      toNumberOrNull(record.portion_size_grams),
      toNumberOrNull(record.expected_yield_servings),
      record.output_calculation_source || null,
      record.weight_calculation_source || null,
      record.yield_calculation_source || record.yield_source || null,
      toNumberOrNull(record.weight_snapshot_version),
      toNumberOrZero(record.estimated_cost || record.estimated_batch_cost),
      toNumberOrZero(record.actual_cost || record.production_cost_total || record.total_cost),
      'active',
      record.source_name || null,
      record.created_date || nowIso(),
      record.updated_date || nowIso()
    ],
    executor
  );
  return lineId;
}

function safeLineNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function normalizedMenuPlanLineType(value) {
  const type = String(value || 'recipe').trim().toLowerCase();
  return ['recipe', 'ingredient', 'manual'].includes(type) ? type : 'recipe';
}

function lineNumberedId(prefix, parentId, lineNumber) {
  return `${parentId}:${prefix}:${lineNumber}`;
}

async function replaceMenuPlanLines(record, executor = pool) {
  const sourceLines = Array.isArray(record.menu_plan_lines)
    ? record.menu_plan_lines
    : Array.isArray(record.meals)
      ? record.meals
      : null;
  if (!Array.isArray(sourceLines)) return;

  await query('DELETE FROM menu_plan_lines WHERE menu_plan_id = $1', [record.id], executor);
  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, sourceLine] of sourceLines.entries()) {
    const lineNumber = safeLineNumber(sourceLine?.line_number, index + 1);
    const lineType = normalizedMenuPlanLineType(sourceLine?.line_type);
    const itemName = String(
      sourceLine?.item_name
      || sourceLine?.recipe_name
      || sourceLine?.ingredient_name
      || sourceLine?.name
      || `Menu plan line ${lineNumber}`
    ).trim();
    await query(
      `INSERT INTO menu_plan_lines (
        menu_plan_line_id, menu_plan_id, line_number, line_type, recipe_version_id,
        ingredient_id, item_name, planned_servings, planned_weight_grams, planned_unit,
        estimated_cost, status, source_name, payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
      ON CONFLICT (menu_plan_line_id) DO UPDATE SET
        line_number = EXCLUDED.line_number, line_type = EXCLUDED.line_type,
        recipe_version_id = EXCLUDED.recipe_version_id, ingredient_id = EXCLUDED.ingredient_id,
        item_name = EXCLUDED.item_name, planned_servings = EXCLUDED.planned_servings,
        planned_weight_grams = EXCLUDED.planned_weight_grams, planned_unit = EXCLUDED.planned_unit,
        estimated_cost = EXCLUDED.estimated_cost, status = EXCLUDED.status,
        source_name = EXCLUDED.source_name, payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at`,
      [
        sourceLine?.menu_plan_line_id || sourceLine?.id || lineNumberedId('line', record.id, lineNumber),
        record.id,
        lineNumber,
        lineType,
        sourceLine?.recipe_id || sourceLine?.recipe_version_id || null,
        sourceLine?.ingredient_id || null,
        itemName,
        toNumberOrNull(sourceLine?.planned_servings ?? sourceLine?.expected_servings),
        toNumberOrNull(sourceLine?.planned_weight_grams),
        sourceLine?.planned_unit || sourceLine?.unit || null,
        toNumberOrZero(sourceLine?.estimated_cost ?? sourceLine?.total_cost),
        sourceLine?.status || record.status || 'planned',
        sourceLine?.source_name || record.source_name || null,
        jsonPayload(sourceLine),
        createdAt,
        updatedAt
      ],
      executor
    );
  }
}

async function replaceProductionManifestLines(record, executor = pool) {
  const sourceLines = Array.isArray(record.manifest_lines) ? record.manifest_lines : null;
  if (!Array.isArray(sourceLines)) {
    await ensureProductionManifestLine(record, executor);
    return;
  }

  await query('DELETE FROM production_manifest_lines WHERE production_id = $1', [record.id], executor);
  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, sourceLine] of sourceLines.entries()) {
    const lineNumber = safeLineNumber(sourceLine?.line_number, index + 1);
    const requestedServings = toNumberOrNull(sourceLine?.requested_servings);
    const requestedWeightGrams = toNumberOrNull(sourceLine?.requested_weight_grams);
    const producedServings = toNumberOrNull(sourceLine?.produced_servings);
    const producedWeightGrams = toNumberOrNull(sourceLine?.produced_weight_grams);
    const hasQuantity = [
      requestedServings,
      requestedWeightGrams,
      producedServings,
      producedWeightGrams
    ].some((value) => Number(value || 0) > 0);
    if (!hasQuantity) {
      const error = new Error(`Production manifest line ${lineNumber} requires servings or weight.`);
      error.status = 400;
      throw error;
    }
    await query(
      `INSERT INTO production_manifest_lines (
        production_line_id, production_id, menu_plan_line_id, line_number, recipe_version_id,
        ingredient_id, item_name, line_type, item_key, source_menu_plan_item_key,
        recipe_code, ingredient_name, meal_period, requested_servings, requested_weight_grams,
        produced_servings, produced_weight_grams, production_covers, raw_weight_grams,
        yielded_weight_grams, expected_finished_weight_grams, portion_size_grams,
        expected_yield_servings, output_calculation_source, weight_calculation_source,
        yield_calculation_source, weight_snapshot_version, estimated_cost, actual_cost,
        status, source_name,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33
      )
      ON CONFLICT (production_line_id) DO UPDATE SET
        menu_plan_line_id = EXCLUDED.menu_plan_line_id, line_number = EXCLUDED.line_number,
        recipe_version_id = EXCLUDED.recipe_version_id, ingredient_id = EXCLUDED.ingredient_id,
        item_name = EXCLUDED.item_name, line_type = EXCLUDED.line_type,
        item_key = EXCLUDED.item_key, source_menu_plan_item_key = EXCLUDED.source_menu_plan_item_key,
        recipe_code = EXCLUDED.recipe_code, ingredient_name = EXCLUDED.ingredient_name,
        meal_period = EXCLUDED.meal_period, requested_servings = EXCLUDED.requested_servings,
        requested_weight_grams = EXCLUDED.requested_weight_grams,
        produced_servings = EXCLUDED.produced_servings,
        produced_weight_grams = EXCLUDED.produced_weight_grams,
        production_covers = EXCLUDED.production_covers,
        raw_weight_grams = EXCLUDED.raw_weight_grams,
        yielded_weight_grams = EXCLUDED.yielded_weight_grams,
        expected_finished_weight_grams = EXCLUDED.expected_finished_weight_grams,
        portion_size_grams = EXCLUDED.portion_size_grams,
        expected_yield_servings = EXCLUDED.expected_yield_servings,
        output_calculation_source = EXCLUDED.output_calculation_source,
        weight_calculation_source = EXCLUDED.weight_calculation_source,
        yield_calculation_source = EXCLUDED.yield_calculation_source,
        weight_snapshot_version = EXCLUDED.weight_snapshot_version,
        estimated_cost = EXCLUDED.estimated_cost, actual_cost = EXCLUDED.actual_cost,
        status = EXCLUDED.status, source_name = EXCLUDED.source_name,
        updated_at = EXCLUDED.updated_at`,
      [
        sourceLine?.production_line_id || sourceLine?.id || lineNumberedId('line', record.id, lineNumber),
        record.id,
        sourceLine?.menu_plan_line_id || null,
        lineNumber,
        sourceLine?.recipe_id || sourceLine?.recipe_version_id || null,
        sourceLine?.ingredient_id || null,
        sourceLine?.item_name || sourceLine?.recipe_name || sourceLine?.ingredient_name || `Production line ${lineNumber}`,
        sourceLine?.line_type || (sourceLine?.ingredient_id && !sourceLine?.recipe_id ? 'ingredient' : 'recipe'),
        sourceLine?.key || sourceLine?.manifest_item_key || sourceLine?.source_menu_plan_item_key || null,
        sourceLine?.source_menu_plan_item_key || sourceLine?.original_source_menu_plan_item_key || null,
        sourceLine?.recipe_code || null,
        sourceLine?.ingredient_name || null,
        sourceLine?.meal_type || record.meal_type || null,
        requestedServings,
        requestedWeightGrams,
        producedServings,
        producedWeightGrams,
        toNumberOrNull(sourceLine?.production_covers ?? sourceLine?.expected_servings ?? requestedServings),
        toNumberOrNull(sourceLine?.raw_weight_grams),
        toNumberOrNull(sourceLine?.yielded_weight_grams),
        toNumberOrNull(sourceLine?.expected_finished_weight_grams ?? sourceLine?.yielded_weight_grams),
        toNumberOrNull(sourceLine?.portion_size_grams),
        toNumberOrNull(sourceLine?.expected_yield_servings),
        sourceLine?.output_calculation_source || null,
        sourceLine?.weight_calculation_source || null,
        sourceLine?.yield_calculation_source || sourceLine?.yield_source || null,
        toNumberOrNull(sourceLine?.weight_snapshot_version),
        toNumberOrZero(sourceLine?.estimated_cost),
        toNumberOrZero(sourceLine?.actual_cost),
        sourceLine?.status || 'active',
        sourceLine?.source_name || record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
  }
}

async function replaceProductionConsumptionReportLines(record, executor = pool) {
  await query('DELETE FROM production_consumption_report_lines WHERE report_id = $1', [record.id], executor);
  const sourceLines = Array.isArray(record.ingredient_lines) ? record.ingredient_lines : [];
  if (!sourceLines.length) return;

  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, sourceLine] of sourceLines.entries()) {
    const lineNumber = safeLineNumber(sourceLine?.line_number, index + 1);
    const reportLineId = sourceLine?.report_line_id || sourceLine?.id || lineNumberedId('line', record.id, lineNumber);
    await query(
      `INSERT INTO production_consumption_report_lines (
        report_line_id, report_id, line_number, ingredient_id, item_code, ingredient_name,
        unit, recipe_quantity, recipe_unit, inventory_unit, planned_quantity,
        actual_requested_quantity, issued_quantity, shortage_quantity, posted_cost,
        estimated_shortage_cost, quantity_basis, yield_percent, raw_weight_grams,
        yielded_weight_grams, weight_calculation_source, yield_calculation_source,
        unit_status, conversion_note, inventory_transaction_id, status, source_name,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,
        (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF($4::text, '') LIMIT 1),
        $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29
      )
      ON CONFLICT (report_line_id) DO UPDATE SET
        line_number = EXCLUDED.line_number,
        ingredient_id = EXCLUDED.ingredient_id,
        item_code = EXCLUDED.item_code,
        ingredient_name = EXCLUDED.ingredient_name,
        unit = EXCLUDED.unit,
        recipe_quantity = EXCLUDED.recipe_quantity,
        recipe_unit = EXCLUDED.recipe_unit,
        inventory_unit = EXCLUDED.inventory_unit,
        planned_quantity = EXCLUDED.planned_quantity,
        actual_requested_quantity = EXCLUDED.actual_requested_quantity,
        issued_quantity = EXCLUDED.issued_quantity,
        shortage_quantity = EXCLUDED.shortage_quantity,
        posted_cost = EXCLUDED.posted_cost,
        estimated_shortage_cost = EXCLUDED.estimated_shortage_cost,
        quantity_basis = EXCLUDED.quantity_basis,
        yield_percent = EXCLUDED.yield_percent,
        raw_weight_grams = EXCLUDED.raw_weight_grams,
        yielded_weight_grams = EXCLUDED.yielded_weight_grams,
        weight_calculation_source = EXCLUDED.weight_calculation_source,
        yield_calculation_source = EXCLUDED.yield_calculation_source,
        unit_status = EXCLUDED.unit_status,
        conversion_note = EXCLUDED.conversion_note,
        inventory_transaction_id = EXCLUDED.inventory_transaction_id,
        status = EXCLUDED.status,
        source_name = EXCLUDED.source_name,
        updated_at = EXCLUDED.updated_at`,
      [
        reportLineId,
        record.id,
        lineNumber,
        sourceLine?.ingredient_id || null,
        sourceLine?.item_code || null,
        sourceLine?.ingredient_name || null,
        sourceLine?.unit || sourceLine?.inventory_unit || null,
        toNumberOrNull(sourceLine?.recipe_quantity),
        sourceLine?.recipe_unit || null,
        sourceLine?.inventory_unit || sourceLine?.unit || null,
        toNumberOrZero(sourceLine?.planned_quantity),
        toNumberOrZero(sourceLine?.actual_requested_quantity),
        toNumberOrZero(sourceLine?.issued_quantity),
        toNumberOrZero(sourceLine?.shortage_quantity),
        toNumberOrZero(sourceLine?.posted_cost ?? sourceLine?.total_cost),
        toNumberOrZero(sourceLine?.estimated_shortage_cost),
        sourceLine?.quantity_basis || record.quantity_basis || null,
        toNumberOrNull(sourceLine?.yield_percent),
        toNumberOrNull(sourceLine?.raw_weight_grams),
        toNumberOrNull(sourceLine?.yielded_weight_grams),
        sourceLine?.weight_calculation_source || null,
        sourceLine?.yield_calculation_source || sourceLine?.yield_source || null,
        sourceLine?.unit_status || null,
        sourceLine?.conversion_note || null,
        sourceLine?.inventory_transaction_id || null,
        sourceLine?.status || record.status || 'posted',
        sourceLine?.source_name || record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );

    const sourceRecipeNames = Array.isArray(sourceLine?.source_recipe_names)
      ? sourceLine.source_recipe_names.filter(Boolean)
      : [];
    for (const [sourceIndex, recipeName] of sourceRecipeNames.entries()) {
      await query(
        `INSERT INTO production_consumption_report_line_sources (
          report_line_source_id, report_line_id, report_id, source_order, recipe_name
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (report_line_source_id) DO UPDATE SET
          source_order = EXCLUDED.source_order,
          recipe_name = EXCLUDED.recipe_name`,
        [
          lineNumberedId(`line:${lineNumber}:source`, record.id, sourceIndex + 1),
          reportLineId,
          record.id,
          sourceIndex + 1,
          String(recipeName)
        ],
        executor
      );
    }

    const transactionIds = uniqueStringList(sourceLine?.inventory_transaction_ids, sourceLine?.inventory_transaction_id);
    for (const [transactionIndex, transactionId] of transactionIds.entries()) {
      await query(
        `INSERT INTO production_consumption_report_line_transactions (
          report_line_transaction_id, report_line_id, report_id, transaction_order, inventory_transaction_id
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (report_line_transaction_id) DO UPDATE SET
          transaction_order = EXCLUDED.transaction_order,
          inventory_transaction_id = EXCLUDED.inventory_transaction_id`,
        [
          lineNumberedId(`line:${lineNumber}:txn`, record.id, transactionIndex + 1),
          reportLineId,
          record.id,
          transactionIndex + 1,
          transactionId
        ],
        executor
      );
    }

    const movementLayers = Array.isArray(sourceLine?.movement_layers) ? sourceLine.movement_layers : [];
    for (const [layerIndex, layer] of movementLayers.entries()) {
      await query(
        `INSERT INTO production_consumption_report_line_layers (
          report_line_layer_id, report_line_id, report_id, layer_order, inventory_lot_id,
          batch_number, stock_date, received_date, expiry_date, quantity, quantity_before,
          quantity_after, reserved_quantity_before, reserved_quantity_after,
          available_quantity_before, available_quantity_after, unit_cost, total_cost,
          accounting_unit_cost, accounting_total_cost, production_id, commitment_revision,
          operation_id, source_name, created_at
        ) VALUES (
          $1,$2,$3,$4,
          (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF($5::text, '') LIMIT 1),
          $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          (SELECT production_id FROM production_events WHERE production_id = NULLIF($21::text, '') LIMIT 1),
          $22,$23,$24,$25
        )
        ON CONFLICT (report_line_layer_id) DO UPDATE SET
          layer_order = EXCLUDED.layer_order,
          inventory_lot_id = EXCLUDED.inventory_lot_id,
          batch_number = EXCLUDED.batch_number,
          stock_date = EXCLUDED.stock_date,
          received_date = EXCLUDED.received_date,
          expiry_date = EXCLUDED.expiry_date,
          quantity = EXCLUDED.quantity,
          quantity_before = EXCLUDED.quantity_before,
          quantity_after = EXCLUDED.quantity_after,
          reserved_quantity_before = EXCLUDED.reserved_quantity_before,
          reserved_quantity_after = EXCLUDED.reserved_quantity_after,
          available_quantity_before = EXCLUDED.available_quantity_before,
          available_quantity_after = EXCLUDED.available_quantity_after,
          unit_cost = EXCLUDED.unit_cost,
          total_cost = EXCLUDED.total_cost,
          accounting_unit_cost = EXCLUDED.accounting_unit_cost,
          accounting_total_cost = EXCLUDED.accounting_total_cost,
          production_id = EXCLUDED.production_id,
          commitment_revision = EXCLUDED.commitment_revision,
          operation_id = EXCLUDED.operation_id,
          source_name = EXCLUDED.source_name`,
        [
          lineNumberedId(`line:${lineNumber}:layer`, record.id, layerIndex + 1),
          reportLineId,
          record.id,
          layerIndex + 1,
          layer?.inventory_lot_id || layer?.lot_id || null,
          layer?.batch_number || null,
          toDateOnlyOrNull(layer?.stock_date),
          toDateOnlyOrNull(layer?.received_date),
          toDateOnlyOrNull(layer?.expiry_date),
          toNumberOrZero(layer?.quantity),
          toNumberOrNull(layer?.quantity_before),
          toNumberOrNull(layer?.quantity_after),
          toNumberOrNull(layer?.reserved_quantity_before),
          toNumberOrNull(layer?.reserved_quantity_after),
          toNumberOrNull(layer?.available_quantity_before),
          toNumberOrNull(layer?.available_quantity_after),
          toNumberOrZero(layer?.unit_cost),
          toNumberOrZero(layer?.total_cost),
          toNumberOrNull(layer?.accounting_unit_cost),
          toNumberOrNull(layer?.accounting_total_cost),
          layer?.production_id || record.production_id || null,
          toNumberOrNull(layer?.commitment_revision),
          layer?.operation_id || null,
          layer?.source_name || null,
          createdAt
        ],
        executor
      );
    }
  }
}

async function replaceProductionConsumptionReportMenuItems(record, executor = pool) {
  await query('DELETE FROM production_consumption_report_menu_items WHERE report_id = $1', [record.id], executor);
  const sourceItems = Array.isArray(record.menu_issue_items) ? record.menu_issue_items : [];
  if (!sourceItems.length) return;

  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, item] of sourceItems.entries()) {
    const itemOrder = safeLineNumber(item?.item_order ?? item?.line_number, index + 1);
    await query(
      `INSERT INTO production_consumption_report_menu_items (
        report_menu_item_id, report_id, item_order, production_line_id, recipe_version_id,
        ingredient_id, item_name, recipe_name, line_type, item_key, source_menu_plan_item_key,
        original_source_menu_plan_item_key, recipe_code, ingredient_name, meal_period,
        requested_servings, requested_weight_grams, produced_servings, produced_weight_grams,
        production_covers, raw_weight_grams, yielded_weight_grams, expected_finished_weight_grams,
        portion_size_grams, expected_yield_servings, output_calculation_source,
        weight_calculation_source, yield_calculation_source, weight_snapshot_version,
        estimated_cost, actual_cost, status, source_name, created_at, updated_at
      ) VALUES (
        $1,$2,$3,
        (SELECT production_line_id FROM production_manifest_lines WHERE production_line_id = NULLIF($4::text, '') LIMIT 1),
        (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF($5::text, '') LIMIT 1),
        (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF($6::text, '') LIMIT 1),
        $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
      )
      ON CONFLICT (report_menu_item_id) DO UPDATE SET
        item_order = EXCLUDED.item_order,
        production_line_id = EXCLUDED.production_line_id,
        recipe_version_id = EXCLUDED.recipe_version_id,
        ingredient_id = EXCLUDED.ingredient_id,
        item_name = EXCLUDED.item_name,
        recipe_name = EXCLUDED.recipe_name,
        line_type = EXCLUDED.line_type,
        item_key = EXCLUDED.item_key,
        source_menu_plan_item_key = EXCLUDED.source_menu_plan_item_key,
        original_source_menu_plan_item_key = EXCLUDED.original_source_menu_plan_item_key,
        recipe_code = EXCLUDED.recipe_code,
        ingredient_name = EXCLUDED.ingredient_name,
        meal_period = EXCLUDED.meal_period,
        requested_servings = EXCLUDED.requested_servings,
        requested_weight_grams = EXCLUDED.requested_weight_grams,
        produced_servings = EXCLUDED.produced_servings,
        produced_weight_grams = EXCLUDED.produced_weight_grams,
        production_covers = EXCLUDED.production_covers,
        raw_weight_grams = EXCLUDED.raw_weight_grams,
        yielded_weight_grams = EXCLUDED.yielded_weight_grams,
        expected_finished_weight_grams = EXCLUDED.expected_finished_weight_grams,
        portion_size_grams = EXCLUDED.portion_size_grams,
        expected_yield_servings = EXCLUDED.expected_yield_servings,
        output_calculation_source = EXCLUDED.output_calculation_source,
        weight_calculation_source = EXCLUDED.weight_calculation_source,
        yield_calculation_source = EXCLUDED.yield_calculation_source,
        weight_snapshot_version = EXCLUDED.weight_snapshot_version,
        estimated_cost = EXCLUDED.estimated_cost,
        actual_cost = EXCLUDED.actual_cost,
        status = EXCLUDED.status,
        source_name = EXCLUDED.source_name,
        updated_at = EXCLUDED.updated_at`,
      [
        item?.report_menu_item_id || item?.id || lineNumberedId('menu-item', record.id, itemOrder),
        record.id,
        itemOrder,
        item?.production_line_id || item?.id || null,
        item?.recipe_id || item?.recipe_version_id || null,
        item?.ingredient_id || null,
        item?.item_name || item?.recipe_name || item?.name || `Production menu item ${itemOrder}`,
        item?.recipe_name || item?.name || item?.item_name || null,
        item?.line_type || (item?.ingredient_id && !item?.recipe_id ? 'ingredient' : 'recipe'),
        item?.key || item?.manifest_item_key || null,
        item?.source_menu_plan_item_key || null,
        item?.original_source_menu_plan_item_key || null,
        item?.recipe_code || null,
        item?.ingredient_name || null,
        item?.meal_type || record.meal_type || null,
        toNumberOrNull(item?.requested_servings),
        toNumberOrNull(item?.requested_weight_grams),
        toNumberOrNull(item?.produced_servings),
        toNumberOrNull(item?.produced_weight_grams),
        toNumberOrNull(item?.production_covers ?? item?.expected_servings),
        toNumberOrNull(item?.raw_weight_grams),
        toNumberOrNull(item?.yielded_weight_grams),
        toNumberOrNull(item?.expected_finished_weight_grams),
        toNumberOrNull(item?.portion_size_grams),
        toNumberOrNull(item?.expected_yield_servings),
        item?.output_calculation_source || null,
        item?.weight_calculation_source || null,
        item?.yield_calculation_source || item?.yield_source || null,
        toNumberOrNull(item?.weight_snapshot_version),
        toNumberOrZero(item?.estimated_cost ?? item?.estimated_batch_cost),
        toNumberOrZero(item?.actual_cost ?? item?.total_cost),
        item?.status || 'active',
        item?.source_name || record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
  }
}

async function replaceProductionConsumptionReportUnitTotals(record, executor = pool) {
  await query('DELETE FROM production_consumption_report_unit_totals WHERE report_id = $1', [record.id], executor);
  const totals = rowJsonObject(record.shortage_totals_by_unit);
  for (const [unit, quantity] of Object.entries(totals)) {
    if (!String(unit || '').trim()) continue;
    await query(
      `INSERT INTO production_consumption_report_unit_totals (
        report_unit_total_id, report_id, unit, shortage_quantity
      ) VALUES ($1,$2,$3,$4)
      ON CONFLICT (report_unit_total_id) DO UPDATE SET
        unit = EXCLUDED.unit,
        shortage_quantity = EXCLUDED.shortage_quantity`,
      [
        `${record.id}:unit-total:${unit}`,
        record.id,
        unit,
        toNumberOrZero(quantity)
      ],
      executor
    );
  }
}

async function replaceProductionConsumptionReportEvents(record, executor = pool) {
  await query('DELETE FROM production_consumption_report_events WHERE report_id = $1', [record.id], executor);

  const createdAt = record.created_date || nowIso();
  const partialEvents = Array.isArray(record.partial_reversal_history)
    ? record.partial_reversal_history
    : [];
  const latestPartial = record.partial_reversal_summary && Object.keys(record.partial_reversal_summary).length
    ? record.partial_reversal_summary
    : null;
  const partialSummaries = latestPartial && !partialEvents.includes(latestPartial)
    ? [...partialEvents, latestPartial]
    : partialEvents;
  const eventInputs = partialSummaries.map((summary) => ({ type: 'partial_reversal', summary }));
  if (record.reversal_summary && Object.keys(record.reversal_summary).length) {
    eventInputs.push({ type: 'full_reversal', summary: record.reversal_summary });
  }

  for (const [eventIndex, { type, summary }] of eventInputs.entries()) {
    const eventOrder = eventIndex + 1;
    const reportEventId = `${record.id}:event:${type}:${eventOrder}`;
    const preservedUsage = summary?.preserved_active_output_usage || {};
    await query(
      `INSERT INTO production_consumption_report_events (
        report_event_id, report_id, event_type, event_order, event_timestamp,
        actor_id, actor_email, actor_name, reason, returned_line_count,
        returned_total_cost, served_weight_grams, wasted_weight_grams,
        served_servings, wasted_servings, status, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (report_event_id) DO UPDATE SET
        event_type = EXCLUDED.event_type,
        event_order = EXCLUDED.event_order,
        event_timestamp = EXCLUDED.event_timestamp,
        actor_id = EXCLUDED.actor_id,
        actor_email = EXCLUDED.actor_email,
        actor_name = EXCLUDED.actor_name,
        reason = EXCLUDED.reason,
        returned_line_count = EXCLUDED.returned_line_count,
        returned_total_cost = EXCLUDED.returned_total_cost,
        served_weight_grams = EXCLUDED.served_weight_grams,
        wasted_weight_grams = EXCLUDED.wasted_weight_grams,
        served_servings = EXCLUDED.served_servings,
        wasted_servings = EXCLUDED.wasted_servings,
        status = EXCLUDED.status`,
      [
        reportEventId,
        record.id,
        type,
        eventOrder,
        summary?.partially_reversed_at || summary?.reversed_at || summary?.timestamp || record.updated_date || nowIso(),
        summary?.actor_id || null,
        summary?.actor_email || summary?.partially_reversed_by || summary?.reversed_by || null,
        summary?.actor_name || summary?.partially_reversed_by_name || summary?.reversed_by_name || null,
        summary?.reason || record.reversal_reason || null,
        toNumberOrZero(summary?.returned_line_count),
        toNumberOrZero(summary?.returned_total_cost),
        toNumberOrNull(preservedUsage.served_weight_grams),
        toNumberOrNull(preservedUsage.wasted_weight_grams),
        toNumberOrNull(preservedUsage.served_servings),
        toNumberOrNull(preservedUsage.wasted_servings),
        summary?.status || 'posted',
        createdAt
      ],
      executor
    );

    const manifestItems = Array.isArray(summary?.reversed_manifest_items) ? summary.reversed_manifest_items : [];
    for (const [manifestIndex, item] of manifestItems.entries()) {
      await query(
        `INSERT INTO production_consumption_report_event_manifest_items (
          report_event_manifest_item_id, report_event_id, report_id, item_order,
          item_key, item_name, reversed_weight_grams, reversal_ratio
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (report_event_manifest_item_id) DO UPDATE SET
          item_order = EXCLUDED.item_order,
          item_key = EXCLUDED.item_key,
          item_name = EXCLUDED.item_name,
          reversed_weight_grams = EXCLUDED.reversed_weight_grams,
          reversal_ratio = EXCLUDED.reversal_ratio`,
        [
          `${reportEventId}:manifest:${manifestIndex + 1}`,
          reportEventId,
          record.id,
          manifestIndex + 1,
          item?.key || null,
          item?.name || item?.item_name || null,
          toNumberOrNull(item?.reversed_weight_grams),
          toNumberOrNull(item?.reversal_ratio)
        ],
        executor
      );
    }

    const returnedLines = Array.isArray(summary?.returned_lines) ? summary.returned_lines : [];
    for (const [lineIndex, line] of returnedLines.entries()) {
      const eventLineId = `${reportEventId}:line:${lineIndex + 1}`;
      await query(
        `INSERT INTO production_consumption_report_event_lines (
          report_event_line_id, report_event_id, report_id, line_order, source_line_index,
          ingredient_id, item_code, ingredient_name, unit, requested_quantity,
          returned_quantity, total_cost, inventory_transaction_id
        ) VALUES (
          $1,$2,$3,$4,$5,
          (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF($6::text, '') LIMIT 1),
          $7,$8,$9,$10,$11,$12,$13
        )
        ON CONFLICT (report_event_line_id) DO UPDATE SET
          line_order = EXCLUDED.line_order,
          source_line_index = EXCLUDED.source_line_index,
          ingredient_id = EXCLUDED.ingredient_id,
          item_code = EXCLUDED.item_code,
          ingredient_name = EXCLUDED.ingredient_name,
          unit = EXCLUDED.unit,
          requested_quantity = EXCLUDED.requested_quantity,
          returned_quantity = EXCLUDED.returned_quantity,
          total_cost = EXCLUDED.total_cost,
          inventory_transaction_id = EXCLUDED.inventory_transaction_id`,
        [
          eventLineId,
          reportEventId,
          record.id,
          lineIndex + 1,
          toNumberOrNull(line?.source_line_index),
          line?.ingredient_id || null,
          line?.item_code || null,
          line?.ingredient_name || null,
          line?.unit || null,
          toNumberOrNull(line?.requested_quantity),
          toNumberOrZero(line?.returned_quantity),
          toNumberOrZero(line?.total_cost),
          line?.transaction_id || line?.inventory_transaction_id || null
        ],
        executor
      );

      const movementLayers = Array.isArray(line?.movement_layers) ? line.movement_layers : [];
      for (const [layerIndex, layer] of movementLayers.entries()) {
        await query(
          `INSERT INTO production_consumption_report_event_line_layers (
            report_event_line_layer_id, report_event_line_id, report_event_id, report_id,
            layer_order, inventory_lot_id, batch_number, stock_date, received_date,
            expiry_date, quantity, quantity_before, quantity_after,
            reserved_quantity_before, reserved_quantity_after,
            available_quantity_before, available_quantity_after, unit_cost, total_cost,
            accounting_unit_cost, accounting_total_cost, production_id, commitment_revision,
            operation_id, source_name, created_at
          ) VALUES (
            $1,$2,$3,$4,$5,
            (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF($6::text, '') LIMIT 1),
            $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,
            (SELECT production_id FROM production_events WHERE production_id = NULLIF($22::text, '') LIMIT 1),
            $23,$24,$25,$26
          )
          ON CONFLICT (report_event_line_layer_id) DO UPDATE SET
            layer_order = EXCLUDED.layer_order,
            inventory_lot_id = EXCLUDED.inventory_lot_id,
            batch_number = EXCLUDED.batch_number,
            stock_date = EXCLUDED.stock_date,
            received_date = EXCLUDED.received_date,
            expiry_date = EXCLUDED.expiry_date,
            quantity = EXCLUDED.quantity,
            quantity_before = EXCLUDED.quantity_before,
            quantity_after = EXCLUDED.quantity_after,
            reserved_quantity_before = EXCLUDED.reserved_quantity_before,
            reserved_quantity_after = EXCLUDED.reserved_quantity_after,
            available_quantity_before = EXCLUDED.available_quantity_before,
            available_quantity_after = EXCLUDED.available_quantity_after,
            unit_cost = EXCLUDED.unit_cost,
            total_cost = EXCLUDED.total_cost,
            accounting_unit_cost = EXCLUDED.accounting_unit_cost,
            accounting_total_cost = EXCLUDED.accounting_total_cost,
            production_id = EXCLUDED.production_id,
            commitment_revision = EXCLUDED.commitment_revision,
            operation_id = EXCLUDED.operation_id,
            source_name = EXCLUDED.source_name`,
          [
            `${eventLineId}:layer:${layerIndex + 1}`,
            eventLineId,
            reportEventId,
            record.id,
            layerIndex + 1,
            layer?.inventory_lot_id || layer?.lot_id || null,
            layer?.batch_number || null,
            toDateOnlyOrNull(layer?.stock_date),
            toDateOnlyOrNull(layer?.received_date),
            toDateOnlyOrNull(layer?.expiry_date),
            toNumberOrZero(layer?.quantity),
            toNumberOrNull(layer?.quantity_before),
            toNumberOrNull(layer?.quantity_after),
            toNumberOrNull(layer?.reserved_quantity_before),
            toNumberOrNull(layer?.reserved_quantity_after),
            toNumberOrNull(layer?.available_quantity_before),
            toNumberOrNull(layer?.available_quantity_after),
            toNumberOrZero(layer?.unit_cost),
            toNumberOrZero(layer?.total_cost),
            toNumberOrNull(layer?.accounting_unit_cost),
            toNumberOrNull(layer?.accounting_total_cost),
            layer?.production_id || record.production_id || null,
            toNumberOrNull(layer?.commitment_revision),
            layer?.operation_id || null,
            layer?.source_name || null,
            createdAt
          ],
          executor
        );
      }
    }
  }
}

async function replaceMealServiceItems(record, executor = pool) {
  if (!Array.isArray(record.items)) return;

  await query('DELETE FROM meal_service_items WHERE meal_service_id = $1', [record.id], executor);
  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, item] of record.items.entries()) {
    const itemOrder = safeLineNumber(item?.item_order ?? item?.line_number, index + 1);
    const outputBatchId = item?.output_batch_id || item?.produced_item_batch_id || item?.batch_id || null;
    const itemName = item?.item_name || item?.recipe_name || `Meal service item ${itemOrder}`;
    await query(
      `INSERT INTO meal_service_items (
        meal_service_item_id, meal_service_id, item_order, output_batch_id, production_id,
        recipe_version_id, recipe_name, item_name, attendee_count, portions_per_attendee,
        servings_per_attendee, portion_size_grams, manual_portion_size_grams,
        portion_size_source, required_servings, required_weight_grams, served_servings,
        served_weight_grams, consumed_production_equivalent_servings, shortage_servings,
        shortage_weight_grams, cost, status, created_at, updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF($4::text, '') LIMIT 1),
        (SELECT production_id FROM production_events WHERE production_id = NULLIF($5::text, '') LIMIT 1),
        (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF($6::text, '') LIMIT 1),
        $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
      )
      ON CONFLICT (meal_service_item_id) DO UPDATE SET
        item_order = EXCLUDED.item_order,
        output_batch_id = EXCLUDED.output_batch_id,
        production_id = EXCLUDED.production_id,
        recipe_version_id = EXCLUDED.recipe_version_id,
        recipe_name = EXCLUDED.recipe_name,
        item_name = EXCLUDED.item_name,
        attendee_count = EXCLUDED.attendee_count,
        portions_per_attendee = EXCLUDED.portions_per_attendee,
        servings_per_attendee = EXCLUDED.servings_per_attendee,
        portion_size_grams = EXCLUDED.portion_size_grams,
        manual_portion_size_grams = EXCLUDED.manual_portion_size_grams,
        portion_size_source = EXCLUDED.portion_size_source,
        required_servings = EXCLUDED.required_servings,
        required_weight_grams = EXCLUDED.required_weight_grams,
        served_servings = EXCLUDED.served_servings,
        served_weight_grams = EXCLUDED.served_weight_grams,
        consumed_production_equivalent_servings = EXCLUDED.consumed_production_equivalent_servings,
        shortage_servings = EXCLUDED.shortage_servings,
        shortage_weight_grams = EXCLUDED.shortage_weight_grams,
        cost = EXCLUDED.cost,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at`,
      [
        item?.meal_service_item_id || item?.id || lineNumberedId('item', record.id, itemOrder),
        record.id,
        itemOrder,
        outputBatchId,
        item?.production_id || null,
        item?.recipe_id || item?.recipe_version_id || null,
        item?.recipe_name || itemName,
        itemName,
        toNumberOrNull(item?.attendee_count ?? record.attendee_count ?? record.covers),
        toNumberOrNull(item?.portions_per_attendee),
        toNumberOrNull(item?.servings_per_attendee),
        toNumberOrNull(item?.portion_size_grams),
        toNumberOrNull(item?.manual_portion_size_grams),
        item?.portion_size_source || null,
        toNumberOrZero(item?.required_servings),
        toNumberOrZero(item?.required_weight_grams),
        toNumberOrZero(item?.served_servings),
        toNumberOrZero(item?.served_weight_grams),
        toNumberOrNull(item?.consumed_production_equivalent_servings),
        toNumberOrZero(item?.shortage_servings ?? item?.short_servings),
        toNumberOrZero(item?.shortage_weight_grams ?? item?.short_weight_grams),
        toNumberOrZero(item?.cost ?? item?.total_cost),
        item?.status || record.status || 'posted',
        createdAt,
        updatedAt
      ],
      executor
    );
  }
}

async function replaceMealServiceConsumptionAllocations(record, executor = pool) {
  if (!Array.isArray(record.allocations)) return;

  await query('DELETE FROM meal_service_consumption_allocations WHERE meal_consumption_id = $1', [record.id], executor);
  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, allocation] of record.allocations.entries()) {
    const allocationOrder = safeLineNumber(allocation?.allocation_order ?? allocation?.line_number, index + 1);
    const outputBatchId = allocation?.output_batch_id
      || allocation?.produced_item_batch_id
      || allocation?.batch_id
      || null;
    await query(
      `INSERT INTO meal_service_consumption_allocations (
        meal_service_consumption_allocation_id, meal_consumption_id, allocation_order,
        output_batch_id, production_id, batch_number, portion_size_grams,
        service_portion_size_grams, servings, production_equivalent_servings,
        meal_portions, weight_grams, remaining_servings_before,
        remaining_servings_after, remaining_weight_grams_before,
        remaining_weight_grams_after, status, created_at, updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF($4::text, '') LIMIT 1),
        (SELECT production_id FROM production_events WHERE production_id = NULLIF($5::text, '') LIMIT 1),
        $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      ON CONFLICT (meal_service_consumption_allocation_id) DO UPDATE SET
        allocation_order = EXCLUDED.allocation_order,
        output_batch_id = EXCLUDED.output_batch_id,
        production_id = EXCLUDED.production_id,
        batch_number = EXCLUDED.batch_number,
        portion_size_grams = EXCLUDED.portion_size_grams,
        service_portion_size_grams = EXCLUDED.service_portion_size_grams,
        servings = EXCLUDED.servings,
        production_equivalent_servings = EXCLUDED.production_equivalent_servings,
        meal_portions = EXCLUDED.meal_portions,
        weight_grams = EXCLUDED.weight_grams,
        remaining_servings_before = EXCLUDED.remaining_servings_before,
        remaining_servings_after = EXCLUDED.remaining_servings_after,
        remaining_weight_grams_before = EXCLUDED.remaining_weight_grams_before,
        remaining_weight_grams_after = EXCLUDED.remaining_weight_grams_after,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at`,
      [
        allocation?.meal_service_consumption_allocation_id || allocation?.id || lineNumberedId('allocation', record.id, allocationOrder),
        record.id,
        allocationOrder,
        outputBatchId,
        allocation?.production_id || record.production_id || null,
        allocation?.batch_number || null,
        toNumberOrNull(allocation?.portion_size_grams),
        toNumberOrNull(allocation?.service_portion_size_grams),
        toNumberOrZero(allocation?.servings),
        toNumberOrZero(allocation?.production_equivalent_servings ?? allocation?.servings),
        toNumberOrZero(allocation?.meal_portions),
        toNumberOrZero(allocation?.weight_grams),
        toNumberOrNull(allocation?.remaining_servings_before),
        toNumberOrNull(allocation?.remaining_servings_after),
        toNumberOrNull(allocation?.remaining_weight_grams_before),
        toNumberOrNull(allocation?.remaining_weight_grams_after),
        allocation?.status || record.status || 'posted',
        createdAt,
        updatedAt
      ],
      executor
    );
  }
}

function foodWasteQuantityToGrams(quantity, unit = 'g') {
  const value = toNumberOrZero(quantity);
  if (value <= 0) return 0;
  const normalizedUnit = String(unit || 'g').trim().toLowerCase();
  if (normalizedUnit === 'kg') return value * 1000;
  return value;
}

function foodWasteLineSources(record = {}) {
  const allocations = Array.isArray(record.output_allocations)
    ? record.output_allocations
    : Array.isArray(record.allocations)
      ? record.allocations
      : [];
  if (allocations.length) {
    return allocations.map((allocation, index) => ({
      ...allocation,
      line_number: safeLineNumber(allocation?.line_number, index + 1),
      production_id: allocation?.production_id || record.production_id || null,
      recipe_id: allocation?.recipe_id || allocation?.recipe_version_id || record.recipe_id || null,
      ingredient_id: allocation?.ingredient_id || record.ingredient_id || null,
      item_name: allocation?.item_name || allocation?.recipe_name || allocation?.ingredient_name || record.recipe_name || record.ingredient_name || null,
      batch_number: allocation?.batch_number || record.batch_reference || null,
      batch_overproduction_item_key: allocation?.batch_overproduction_item_key || record.batch_overproduction_item_key || null,
      manifest_item_key: allocation?.manifest_item_key || record.manifest_item_key || null,
      source_menu_plan_item_key: allocation?.source_menu_plan_item_key || record.source_menu_plan_item_key || null,
      waste_weight_grams: toNumberOrZero(
        allocation?.wasted_weight_grams
        ?? allocation?.waste_weight_grams
        ?? allocation?.quantity_grams
        ?? allocation?.quantity
      )
    }));
  }
  const wasteWeightGrams = toNumberOrZero(
    record.wasted_weight_grams
    ?? record.waste_weight_grams
    ?? record.quantity_grams
  ) || foodWasteQuantityToGrams(record.quantity, record.unit);
  if (wasteWeightGrams <= 0) return [];
  return [{
    line_number: 1,
    produced_item_batch_id: record.produced_item_batch_id || null,
    output_batch_id: record.output_batch_id || null,
    production_id: record.production_id || null,
    production_line_id: record.production_line_id || null,
    recipe_id: record.recipe_id || record.recipe_version_id || null,
    ingredient_id: record.ingredient_id || null,
    item_name: record.recipe_name || record.ingredient_name || null,
    batch_number: record.batch_reference || null,
    batch_overproduction_item_key: record.batch_overproduction_item_key || null,
    manifest_item_key: record.manifest_item_key || null,
    source_menu_plan_item_key: record.source_menu_plan_item_key || null,
    wasted_production_equivalent_servings: record.wasted_production_equivalent_servings || null,
    produced_weight_grams: record.produced_weight_grams || null,
    available_weight_grams_before: record.available_weight_grams_before || null,
    waste_weight_grams: wasteWeightGrams,
    cost: record.estimated_cost || record.waste_cost || record.total_cost || 0
  }];
}

async function replaceFoodWasteLines(record, executor = pool) {
  await query('DELETE FROM food_waste_lines WHERE food_waste_id = $1', [record.id], executor);
  const sources = foodWasteLineSources(record).filter((line) => toNumberOrZero(line?.waste_weight_grams) > 0);
  if (!sources.length) return;

  const createdAt = record.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  for (const [index, sourceLine] of sources.entries()) {
    const lineNumber = safeLineNumber(sourceLine?.line_number, index + 1);
    const lineWeightGrams = toNumberOrZero(sourceLine?.waste_weight_grams);
    const lineCost = firstPositiveNumber([
      sourceLine?.cost,
      sourceLine?.estimated_cost,
      sourceLine?.waste_cost,
      sourceLine?.estimated_cost_per_gram && lineWeightGrams
        ? Number(sourceLine.estimated_cost_per_gram) * lineWeightGrams
        : null,
      sources.length === 1 ? record.estimated_cost : null
    ]);
    const outputBatchId = sourceLine?.output_batch_id
      || sourceLine?.produced_item_batch_id
      || sourceLine?.batch_id
      || null;
    await query(
      `INSERT INTO food_waste_lines (
        food_waste_line_id, food_waste_id, output_batch_id, production_line_id,
        production_id, recipe_version_id, ingredient_id, line_number, item_name,
        batch_number, batch_overproduction_item_key, manifest_item_key,
        source_menu_plan_item_key, wasted_production_equivalent_servings,
        produced_weight_grams_before, available_weight_grams_before,
        waste_weight_grams, cost, status, created_at, updated_at
      ) VALUES (
        $1,
        $2,
        (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF($3::text, '') LIMIT 1),
        (SELECT production_line_id FROM production_manifest_lines WHERE production_line_id = NULLIF($4::text, '') LIMIT 1),
        (SELECT production_id FROM production_events WHERE production_id = NULLIF($5::text, '') LIMIT 1),
        (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF($6::text, '') LIMIT 1),
        (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF($7::text, '') LIMIT 1),
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21
      )
      ON CONFLICT (food_waste_line_id) DO UPDATE SET
        output_batch_id = EXCLUDED.output_batch_id,
        production_line_id = EXCLUDED.production_line_id,
        production_id = EXCLUDED.production_id,
        recipe_version_id = EXCLUDED.recipe_version_id,
        ingredient_id = EXCLUDED.ingredient_id,
        line_number = EXCLUDED.line_number,
        item_name = EXCLUDED.item_name,
        batch_number = EXCLUDED.batch_number,
        batch_overproduction_item_key = EXCLUDED.batch_overproduction_item_key,
        manifest_item_key = EXCLUDED.manifest_item_key,
        source_menu_plan_item_key = EXCLUDED.source_menu_plan_item_key,
        wasted_production_equivalent_servings = EXCLUDED.wasted_production_equivalent_servings,
        produced_weight_grams_before = EXCLUDED.produced_weight_grams_before,
        available_weight_grams_before = EXCLUDED.available_weight_grams_before,
        waste_weight_grams = EXCLUDED.waste_weight_grams,
        cost = EXCLUDED.cost,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at`,
      [
        sourceLine?.food_waste_line_id || sourceLine?.id || lineNumberedId('line', record.id, lineNumber),
        record.id,
        outputBatchId,
        sourceLine?.production_line_id || sourceLine?.manifest_item_key || null,
        sourceLine?.production_id || record.production_id || null,
        sourceLine?.recipe_id || sourceLine?.recipe_version_id || record.recipe_id || null,
        sourceLine?.ingredient_id || record.ingredient_id || null,
        lineNumber,
        sourceLine?.item_name || sourceLine?.recipe_name || sourceLine?.ingredient_name || record.recipe_name || record.ingredient_name || null,
        sourceLine?.batch_number || record.batch_reference || null,
        sourceLine?.batch_overproduction_item_key || record.batch_overproduction_item_key || null,
        sourceLine?.manifest_item_key || record.manifest_item_key || null,
        sourceLine?.source_menu_plan_item_key || record.source_menu_plan_item_key || null,
        toNumberOrNull(sourceLine?.wasted_production_equivalent_servings ?? record.wasted_production_equivalent_servings),
        toNumberOrNull(sourceLine?.produced_weight_grams ?? sourceLine?.produced_weight_grams_before ?? record.produced_weight_grams),
        toNumberOrNull(sourceLine?.available_weight_grams_before ?? sourceLine?.available_weight_grams ?? record.available_weight_grams_before),
        lineWeightGrams,
        toNumberOrZero(lineCost),
        sourceLine?.status || record.status || 'posted',
        createdAt,
        updatedAt
      ],
      executor
    );
  }
}

async function replaceFoodWasteImages(record, executor = pool) {
  await query('DELETE FROM food_waste_images WHERE food_waste_id = $1', [record.id], executor);
  const imageUrls = normalizeFoodWasteImageUrls(record).slice(0, 8);
  if (!imageUrls.length) return;

  for (const [index, imageUrl] of imageUrls.entries()) {
    await query(
      `INSERT INTO food_waste_images (
        food_waste_image_id, food_waste_id, image_url, image_order, original_name,
        content_type, byte_size, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (food_waste_id, image_url) DO UPDATE SET
        image_order = EXCLUDED.image_order,
        original_name = COALESCE(EXCLUDED.original_name, food_waste_images.original_name),
        content_type = COALESCE(EXCLUDED.content_type, food_waste_images.content_type),
        byte_size = COALESCE(EXCLUDED.byte_size, food_waste_images.byte_size)`,
      [
        lineNumberedId('image', record.id, index + 1),
        record.id,
        imageUrl,
        index + 1,
        record.original_file_names?.[index] || record.image_original_names?.[index] || null,
        record.image_content_types?.[index] || null,
        toNumberOrNull(record.image_byte_sizes?.[index]),
        record.created_date || nowIso()
      ],
      executor
    );
  }
}

async function replaceFoodWasteInventoryMovements(record, executor = pool) {
  await query('DELETE FROM food_waste_inventory_movements WHERE food_waste_id = $1', [record.id], executor);
  const movements = Array.isArray(record.inventory_movement_layers)
    ? record.inventory_movement_layers
    : [];
  if (!movements.length) return;

  const createdAt = record.created_date || nowIso();
  for (const [index, movement] of movements.entries()) {
    const movementOrder = safeLineNumber(movement?.movement_order ?? movement?.line_number, index + 1);
    await query(
      `INSERT INTO food_waste_inventory_movements (
        food_waste_inventory_movement_id, food_waste_id, movement_order,
        inventory_transaction_id, inventory_id, lot_id, ingredient_id,
        quantity, unit, unit_cost, total_cost, stock_date, expiry_date, source_name,
        created_at
      ) VALUES (
        $1,$2,$3,$4,
        (SELECT inventory_id FROM warehouse_inventory WHERE inventory_id = NULLIF($5::text, '') LIMIT 1),
        (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF($6::text, '') LIMIT 1),
        (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF($7::text, '') LIMIT 1),
        $8,$9,$10,$11,$12,$13,$14,$15
      )
      ON CONFLICT (food_waste_inventory_movement_id) DO UPDATE SET
        movement_order = EXCLUDED.movement_order,
        inventory_transaction_id = EXCLUDED.inventory_transaction_id,
        inventory_id = EXCLUDED.inventory_id,
        lot_id = EXCLUDED.lot_id,
        ingredient_id = EXCLUDED.ingredient_id,
        quantity = EXCLUDED.quantity,
        unit = EXCLUDED.unit,
        unit_cost = EXCLUDED.unit_cost,
        total_cost = EXCLUDED.total_cost,
        stock_date = EXCLUDED.stock_date,
        expiry_date = EXCLUDED.expiry_date,
        source_name = EXCLUDED.source_name`,
      [
        movement?.food_waste_inventory_movement_id || movement?.id || lineNumberedId('movement', record.id, movementOrder),
        record.id,
        movementOrder,
        movement?.inventory_transaction_id || record.inventory_transaction_id || null,
        movement?.inventory_id || null,
        movement?.lot_id || null,
        movement?.ingredient_id || record.ingredient_id || null,
        toNumberOrZero(movement?.quantity ?? movement?.deducted_quantity),
        movement?.unit || record.unit || null,
        toNumberOrZero(movement?.unit_cost),
        toNumberOrZero(movement?.total_cost ?? movement?.cost),
        toDateOnlyOrNull(movement?.stock_date),
        toDateOnlyOrNull(movement?.expiry_date),
        movement?.source_name || record.source_name || null,
        createdAt
      ],
      executor
    );
  }
}

async function replaceRoleProfilePermissions(roleProfileId, permissions = [], executor = pool) {
  await query('DELETE FROM role_profile_permissions WHERE role_profile_id = $1', [roleProfileId], executor);
  const uniquePermissions = [...new Set((Array.isArray(permissions) ? permissions : [])
    .map((permission) => String(permission || '').trim())
    .filter(Boolean))];
  for (const permission of uniquePermissions) {
    await query(
      `INSERT INTO role_profile_permissions (role_profile_id, permission_key, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (role_profile_id, permission_key) DO NOTHING`,
      [roleProfileId, permission],
      executor
    );
  }
}

async function insertOrUpdateRoleProfile(record, existing = null, executor = pool) {
  const createdAt = record.created_date || existing?.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  const isActive = record.is_active !== false;
  await query(
    `INSERT INTO role_profiles (
       id, entity_name, role_key, name, description, access_level,
       dashboard_variant, is_active, is_system, status, source_name,
       created_at, updated_at
     ) VALUES (
       $1, 'RoleProfile', $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12
     )
     ON CONFLICT (id) DO UPDATE SET
       role_key = EXCLUDED.role_key,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       access_level = EXCLUDED.access_level,
       dashboard_variant = EXCLUDED.dashboard_variant,
       is_active = EXCLUDED.is_active,
       is_system = EXCLUDED.is_system,
       status = EXCLUDED.status,
       source_name = EXCLUDED.source_name,
       updated_at = EXCLUDED.updated_at`,
    [
      record.id,
      record.role_key,
      record.name,
      record.description || null,
      record.access_level || 'user',
      record.dashboard_variant || null,
      isActive,
      record.is_system === true,
      record.status || (isActive ? 'active' : 'inactive'),
      record.source_name || null,
      createdAt,
      updatedAt
    ],
    executor
  );
  await replaceRoleProfilePermissions(record.id, record.permissions, executor);
  invalidateRoleProfileCache(record.role_key);
  return findNormalizedDocument('RoleProfile', record.id, executor);
}

async function insertOrUpdateNormalizedDocument(entity, record, existing = null, executor = pool) {
  if (entity === 'Site') return insertOrUpdateNormalizedSite(record, existing, executor);
  if (entity === 'Recipe') return insertOrUpdateNormalizedRecipe(record, existing, executor);
  if (entity === 'RoleProfile') return insertOrUpdateRoleProfile(record, existing, executor);

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
    await replaceMenuPlanLines(record, executor);
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
    const productionColumns = [
      ['production_id', record.id],
      ['menu_plan_id', record.menu_plan_id || (String(record.source_type || '').toLowerCase() === 'menu_plan' ? record.source_event_id : null) || null],
      ['warehouse_id', record.fulfillment_store_id || record.site_id || record.warehouse_id],
      ['production_date', toDateOnlyOrNull(record.production_date || record.date)],
      ['meal_period', record.meal_type || 'breakfast'],
      ['menu_type', record.menu_type || record.cuisine_type || 'general'],
      ['menu_category', record.menu_category || 'senior'],
      ['status', record.status || 'planned'],
      ['issue_group_key', record.issue_group_key || record.id],
      ['source_type', record.source_type || null],
      ['source_event_id', record.source_event_id || null],
      ['source_event_name', record.source_event_name || null],
      ['source_event_recipe_id', record.source_event_recipe_id || null],
      ['source_menu_plan_item_key', record.source_menu_plan_item_key || null],
      ['production_issue_grouped', record.production_issue_grouped === true],
      ['production_issue_group_key', record.production_issue_group_key || null],
      ['production_issue_scope', record.production_issue_scope || null],
      ['production_issue_item_count', toNumberOrNull(record.production_issue_item_count)],
      ['production_issue_dish_count', toNumberOrNull(record.production_issue_dish_count)],
      ['production_issue_admin_reissue', record.production_issue_admin_reissue === true],
      ['production_issue_reissue_run_id', record.production_issue_reissue_run_id || null],
      ['production_issue_reissue_original_group_key', record.production_issue_reissue_original_group_key || null],
      ['target_servings', toNumberOrNull(record.target_servings || record.production_covers)],
      ['ingredient_cost_total', toNumberOrZero(record.ingredient_cost_total)],
      ['production_cost_total', toNumberOrZero(record.production_cost_total ?? record.total_cost)],
      ['cost_per_serving', toNumberOrZero(record.cost_per_serving)],
      ['total_shortage_quantity', toNumberOrZero(record.total_shortage_quantity)],
      ['consumption_report_id', record.consumption_report_id || null],
      ['consumption_report_number', record.consumption_report_number || null],
      ['consumption_report_name', record.consumption_report_name || null],
      ['consumption_report_generated_at', record.consumption_report_generated_at || null],
      ['produced_item_batch_id', record.produced_item_batch_id || null],
      ['produced_item_batch_number', record.produced_item_batch_number || null],
      ['yield_adjustment_applied', record.yield_adjustment_applied === true],
      ['yield_adjustment_version', toNumberOrNull(record.yield_adjustment_version)],
      ['yield_adjustment_updated_at', record.yield_adjustment_updated_at || null],
      ['yield_snapshot_source', record.yield_snapshot_source || null],
      ['quantity_semantics', record.quantity_semantics || null],
      ['reconciliation_mode', record.reconciliation_mode || null],
      ['output_calculation_source', record.output_calculation_source || null],
      ['recipe_raw_weight_grams', toNumberOrNull(record.recipe_raw_weight_grams)],
      ['total_raw_consumption_weight_grams', toNumberOrNull(record.total_raw_consumption_weight_grams)],
      ['total_yielded_weight_grams', toNumberOrNull(record.total_yielded_weight_grams)],
      ['expected_finished_weight_grams', toNumberOrNull(record.expected_finished_weight_grams)],
      ['actual_finished_weight_grams', toNumberOrNull(record.actual_finished_weight_grams)],
      ['portion_size_grams', toNumberOrNull(record.portion_size_grams)],
      ['portion_size_source', record.portion_size_source || null],
      ['expected_yield_servings', toNumberOrNull(record.expected_yield_servings)],
      ['produced_servings', toNumberOrNull(record.produced_servings)],
      ['produced_weight_grams', toNumberOrNull(record.produced_weight_grams)],
      ['completed_by_name', record.completed_by_name || null],
      ['fulfillment_store_name', record.fulfillment_store_name || null],
      ['linked_material_request_id', record.linked_material_request_id || null],
      ['linked_material_request_number', record.linked_material_request_number || null],
      ['material_request_status', record.material_request_status || null],
      ['last_review_action', record.last_review_action || null],
      ['rejection_reason', record.rejection_reason || null],
      ['cancellation_reason', record.cancellation_reason || null],
      ['cancelled_at', record.cancelled_at || null],
      ['cancelled_by', record.cancelled_by || null, 'user'],
      ['cancelled_by_name', record.cancelled_by_name || null],
      ['started_by', record.started_by || null, 'user'],
      ['completed_by', record.completed_by || null, 'user'],
      ['completed_at', record.completed_at || null],
      ['reversed_by', record.reversed_by || null, 'user'],
      ['reversed_at', record.reversed_at || null],
      ['reversal_reason', record.reversal_reason || null],
      ['source_name', record.source_name || null],
      ['created_at', createdAt],
      ['updated_at', updatedAt]
    ];
    const productionColumnNames = productionColumns.map(([column]) => column);
    const productionValues = productionColumns.map(([, value]) => value);
    const productionPlaceholders = productionColumns.map(([, , kind], index) => (
      kind === 'user' ? userReferenceSql(index + 1) : `$${index + 1}`
    ));
    const productionUpdates = productionColumnNames
      .filter((column) => !['production_id', 'created_at'].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await query(
      `INSERT INTO production_events (
        ${productionColumnNames.join(', ')}
      ) VALUES (${productionPlaceholders.join(', ')})
      ON CONFLICT (production_id) DO UPDATE SET ${productionUpdates}`,
      productionValues,
      executor
    );
    await replaceProductionManifestLines(record, executor);
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'ProductionConsumptionReport') {
    await query(
      `INSERT INTO production_consumption_reports (
        report_id, report_number, report_name, production_id, warehouse_id, warehouse_name,
        requesting_warehouse_id, requesting_warehouse_name, fulfillment_store_id, fulfillment_store_name,
        recipe_version_id, recipe_name, original_recipe_name, production_name, original_production_name,
        production_date, meal_period, menu_type, menu_category, menu_scope_label,
        production_issue_grouped, production_issue_item_count, production_issue_dish_count,
        kitchen_station, target_servings, completed_by, completed_by_name, completed_at,
        quantity_basis, reconciliation_mode, output_calculation_source,
        recipe_raw_weight_grams, expected_finished_weight_grams,
        total_raw_consumption_weight_grams, total_yielded_weight_grams,
        portion_size_grams, expected_yield_servings,
        total_consumption_cost, total_shortage_cost, shortage_line_count,
        ingredient_line_count, status, reversed_at, reversed_by, reversed_by_name,
        reversal_reason, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF($11::text, '') LIMIT 1),
        $12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48
      )
      ON CONFLICT (report_id) DO UPDATE SET
        report_number = EXCLUDED.report_number, report_name = EXCLUDED.report_name,
        production_id = EXCLUDED.production_id,
        warehouse_id = EXCLUDED.warehouse_id, warehouse_name = EXCLUDED.warehouse_name,
        requesting_warehouse_id = EXCLUDED.requesting_warehouse_id,
        requesting_warehouse_name = EXCLUDED.requesting_warehouse_name,
        fulfillment_store_id = EXCLUDED.fulfillment_store_id,
        fulfillment_store_name = EXCLUDED.fulfillment_store_name,
        recipe_version_id = EXCLUDED.recipe_version_id,
        recipe_name = EXCLUDED.recipe_name,
        original_recipe_name = EXCLUDED.original_recipe_name,
        production_name = EXCLUDED.production_name,
        original_production_name = EXCLUDED.original_production_name,
        production_date = EXCLUDED.production_date,
        meal_period = EXCLUDED.meal_period,
        menu_type = EXCLUDED.menu_type,
        menu_category = EXCLUDED.menu_category,
        menu_scope_label = EXCLUDED.menu_scope_label,
        production_issue_grouped = EXCLUDED.production_issue_grouped,
        production_issue_item_count = EXCLUDED.production_issue_item_count,
        production_issue_dish_count = EXCLUDED.production_issue_dish_count,
        kitchen_station = EXCLUDED.kitchen_station,
        target_servings = EXCLUDED.target_servings,
        completed_by = EXCLUDED.completed_by,
        completed_by_name = EXCLUDED.completed_by_name,
        completed_at = EXCLUDED.completed_at,
        quantity_basis = EXCLUDED.quantity_basis,
        reconciliation_mode = EXCLUDED.reconciliation_mode,
        output_calculation_source = EXCLUDED.output_calculation_source,
        recipe_raw_weight_grams = EXCLUDED.recipe_raw_weight_grams,
        expected_finished_weight_grams = EXCLUDED.expected_finished_weight_grams,
        total_raw_consumption_weight_grams = EXCLUDED.total_raw_consumption_weight_grams,
        total_yielded_weight_grams = EXCLUDED.total_yielded_weight_grams,
        portion_size_grams = EXCLUDED.portion_size_grams,
        expected_yield_servings = EXCLUDED.expected_yield_servings,
        total_consumption_cost = EXCLUDED.total_consumption_cost,
        total_shortage_cost = EXCLUDED.total_shortage_cost,
        shortage_line_count = EXCLUDED.shortage_line_count,
        ingredient_line_count = EXCLUDED.ingredient_line_count,
        status = EXCLUDED.status,
        reversed_at = EXCLUDED.reversed_at,
        reversed_by = EXCLUDED.reversed_by,
        reversed_by_name = EXCLUDED.reversed_by_name,
        reversal_reason = EXCLUDED.reversal_reason,
        updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.report_number,
        record.report_name || null,
        record.production_id,
        record.site_id || record.warehouse_id || null,
        record.site_name || record.warehouse_name || null,
        record.requesting_site_id || record.requesting_warehouse_id || null,
        record.requesting_site_name || record.requesting_warehouse_name || null,
        record.fulfillment_store_id || null,
        record.fulfillment_store_name || null,
        record.recipe_id || record.recipe_version_id || null,
        record.recipe_name || null,
        record.original_recipe_name || null,
        record.production_name || null,
        record.original_production_name || null,
        toDateOnlyOrNull(record.production_date),
        record.meal_type || record.meal_period || null,
        record.menu_type || record.cuisine_type || null,
        record.menu_category || null,
        record.menu_scope_label || null,
        Boolean(record.production_issue_grouped),
        toNumberOrNull(record.production_issue_item_count),
        toNumberOrNull(record.production_issue_dish_count),
        record.kitchen_station || null,
        toNumberOrNull(record.target_servings),
        record.completed_by || null,
        record.completed_by_name || null,
        record.completed_at || null,
        record.quantity_basis || null,
        record.reconciliation_mode || null,
        record.output_calculation_source || null,
        toNumberOrNull(record.recipe_raw_weight_grams),
        toNumberOrNull(record.expected_finished_weight_grams),
        toNumberOrNull(record.total_raw_consumption_weight_grams),
        toNumberOrNull(record.total_yielded_weight_grams),
        toNumberOrNull(record.portion_size_grams),
        toNumberOrNull(record.expected_yield_servings),
        toNumberOrZero(record.total_consumption_cost),
        toNumberOrZero(record.total_shortage_cost),
        toNumberOrZero(record.shortage_line_count),
        toNumberOrZero(record.ingredient_line_count ?? (Array.isArray(record.ingredient_lines) ? record.ingredient_lines.length : 0)),
        record.status || 'posted',
        record.reversed_at || null,
        record.reversed_by || null,
        record.reversed_by_name || null,
        record.reversal_reason || null,
        createdAt,
        updatedAt
      ],
      executor
    );
    await replaceProductionConsumptionReportLines(record, executor);
    await replaceProductionConsumptionReportMenuItems(record, executor);
    await replaceProductionConsumptionReportUnitTotals(record, executor);
    await replaceProductionConsumptionReportEvents(record, executor);
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
    const producedBatchColumns = [
      ['output_batch_id', record.id],
      ['production_id', record.production_id],
      ['production_line_id', productionLineId],
      ['warehouse_id', record.site_id || record.warehouse_id],
      ['recipe_version_id', record.recipe_id || null],
      ['ingredient_id', record.ingredient_id || null],
      ['batch_number', record.batch_number],
      ['initial_weight_grams', toNumberOrZero(record.initial_weight_grams ?? record.produced_weight_grams)],
      ['remaining_weight_grams', toNumberOrZero(record.remaining_weight_grams ?? record.available_weight_grams ?? record.produced_weight_grams)],
      ['initial_servings', toNumberOrNull(record.initial_servings ?? record.produced_servings)],
      ['remaining_servings', toNumberOrNull(record.remaining_servings ?? record.available_servings ?? record.produced_servings)],
      ['served_weight_grams', toNumberOrZero(record.served_weight_grams)],
      ['wasted_weight_grams', toNumberOrZero(record.wasted_weight_grams)],
      ['served_servings', toNumberOrZero(record.served_servings)],
      ['wasted_servings', toNumberOrZero(record.wasted_servings)],
      ['portion_size_grams', toNumberOrNull(record.portion_size_grams)],
      ['service_portion_size_grams', toNumberOrNull(record.service_portion_size_grams)],
      ['service_portion_updated_by', record.service_portion_updated_by || null],
      ['service_portion_updated_by_name', record.service_portion_updated_by_name || null],
      ['service_portion_updated_at', record.service_portion_updated_at || null],
      ['expected_servings', toNumberOrNull(record.expected_servings ?? record.produced_servings)],
      ['expected_finished_weight_grams', toNumberOrNull(record.expected_finished_weight_grams ?? record.produced_weight_grams)],
      ['actual_finished_weight_grams', toNumberOrNull(record.actual_finished_weight_grams ?? record.produced_weight_grams)],
      ['source_type', record.source_type || null],
      ['source_event_id', record.source_event_id || null],
      ['menu_plan_id', record.menu_plan_id || null],
      ['consumption_report_id', record.consumption_report_id || null],
      ['consumption_report_number', record.consumption_report_number || null],
      ['production_issue_grouped', record.production_issue_grouped === true],
      ['production_issue_item_count', toNumberOrNull(record.production_issue_item_count)],
      ['production_issue_dish_count', toNumberOrNull(record.production_issue_dish_count)],
      ['completed_by', record.completed_by || null],
      ['completed_by_name', record.completed_by_name || null],
      ['reconciliation_mode', record.reconciliation_mode || null],
      ['output_calculation_source', record.output_calculation_source || null],
      ['cutover_version', toNumberOrNull(record.cutover_version) || 1],
      ['unit_cost', toNumberOrZero(record.unit_cost)],
      ['total_cost', toNumberOrZero(record.total_cost)],
      ['status', record.status || 'active'],
      ['source_name', record.source_name || null],
      ['created_at', createdAt],
      ['updated_at', updatedAt]
    ];
    const producedBatchColumnNames = producedBatchColumns.map(([column]) => column);
    const producedBatchValues = producedBatchColumns.map(([, value]) => value);
    const producedBatchPlaceholders = producedBatchValues.map((_, index) => `$${index + 1}`);
    const producedBatchUpdates = producedBatchColumnNames
      .filter((column) => !['output_batch_id', 'created_at'].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await query(
      `INSERT INTO produced_output_batches (
        ${producedBatchColumnNames.join(', ')}
      ) VALUES (${producedBatchPlaceholders.join(', ')})
      ON CONFLICT (output_batch_id) DO UPDATE SET ${producedBatchUpdates}`,
      producedBatchValues,
      executor
    );
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'MealServiceAttendance') {
    const summary = record.summary && typeof record.summary === 'object' ? record.summary : {};
    const mealServiceHeaderColumns = [
      ['meal_service_id', record.id],
      ['service_reference', record.service_reference],
      ['idempotency_key', record.idempotency_key],
      ['warehouse_id', record.site_id || record.warehouse_id],
      ['service_date', toDateOnlyOrNull(record.service_date)],
      ['meal_period', record.meal_type || 'breakfast'],
      ['menu_type', record.menu_type || record.cuisine_type || 'general'],
      ['menu_category', record.menu_category || 'senior'],
      ['serving_size_grams', toNumberOrZero(record.serving_size_grams || record.portion_size_grams) || 1],
      ['covers', toNumberOrZero(record.covers || record.attendee_count)],
      ['status', record.status || 'posted'],
      ['request_fingerprint', record.request_fingerprint || null],
      ['reversal_idempotency_key', record.reversal_idempotency_key || null],
      ['reversal_request_fingerprint', record.reversal_request_fingerprint || null],
      ['scope_key', record.scope_key || null],
      ['menu_plan_id', record.menu_plan_id || null, 'menu_plan'],
      ['menu_plan_name', record.menu_plan_name || null],
      ['customer_meal_plan_id', record.customer_meal_plan_id || null],
      ['customer_meal_plan_name', record.customer_meal_plan_name || null],
      ['customer_name', record.customer_name || null],
      ['customer_id', record.customer_id || null],
      ['category', record.category || null],
      ['attendee_count', toNumberOrZero(record.attendee_count ?? record.covers)],
      ['scan_method', record.scan_method || null],
      ['notes', record.notes || null],
      ['required_servings', toNumberOrZero(record.required_servings ?? summary.required_servings)],
      ['required_weight_grams', toNumberOrZero(record.required_weight_grams ?? summary.required_weight_grams)],
      ['served_servings', toNumberOrZero(record.served_servings ?? summary.served_servings)],
      ['served_weight_grams', toNumberOrZero(record.served_weight_grams ?? summary.served_weight_grams)],
      ['shortage_servings', toNumberOrZero(record.shortage_servings ?? record.short_servings ?? summary.shortage_servings ?? summary.short_servings)],
      ['shortage_weight_grams', toNumberOrZero(record.shortage_weight_grams ?? record.short_weight_grams ?? summary.shortage_weight_grams ?? summary.short_weight_grams)],
      ['recorded_by', record.recorded_by || null],
      ['recorded_by_name', record.recorded_by_name || null],
      ['recorded_at', record.recorded_at || null],
      ['posted_by', record.posted_by || record.performed_by || record.recorded_by || null, 'user'],
      ['reversed_by', record.reversed_by || null, 'user'],
      ['reversed_by_name', record.reversed_by_name || null],
      ['reversed_at', record.reversed_at || null],
      ['reversal_reason', record.reversal_reason || null],
      ['cutover_version', toNumberOrNull(record.cutover_version) || 1],
      ['source_name', record.source_name || null],
      ['created_at', createdAt],
      ['updated_at', updatedAt]
    ];
    const mealServiceHeaderColumnNames = mealServiceHeaderColumns.map(([column]) => column);
    const mealServiceHeaderValues = mealServiceHeaderColumns.map(([, value]) => value);
    const mealServiceHeaderPlaceholders = mealServiceHeaderColumns.map(([, , kind], index) => {
      if (kind === 'user') return userReferenceSql(index + 1);
      if (kind === 'menu_plan') {
        return `(SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF($${index + 1}::text, '') LIMIT 1)`;
      }
      return `$${index + 1}`;
    });
    const mealServiceHeaderUpdates = mealServiceHeaderColumnNames
      .filter((column) => !['meal_service_id', 'created_at'].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await query(
      `INSERT INTO meal_service_headers (
        ${mealServiceHeaderColumnNames.join(', ')}
      ) VALUES (${mealServiceHeaderPlaceholders.join(', ')})
      ON CONFLICT (meal_service_id) DO UPDATE SET ${mealServiceHeaderUpdates}`,
      mealServiceHeaderValues,
      executor
    );
    await replaceMealServiceItems(record, executor);
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'MealServiceConsumption') {
    const allocation = Array.isArray(record.allocations) ? record.allocations[0] || {} : {};
    const mealServiceConsumptionColumns = [
      ['meal_consumption_id', record.id],
      ['meal_service_id', record.meal_service_attendance_id || record.meal_service_id],
      ['output_batch_id', record.produced_item_batch_id || allocation.produced_item_batch_id || allocation.output_batch_id || allocation.batch_id || null, 'output_batch'],
      ['production_id', record.production_id || allocation.production_id || null, 'production'],
      ['recipe_version_id', record.recipe_id || record.recipe_version_id || null, 'recipe_version'],
      ['reverses_consumption_id', record.reverses_consumption_id || record.source_consumption_id || record.original_consumption_id || null],
      ['idempotency_key', record.idempotency_key],
      ['service_reference', record.service_reference],
      ['movement_type', record.movement_type || 'consumption'],
      ['service_date', toDateOnlyOrNull(record.service_date)],
      ['meal_period', record.meal_type || null],
      ['consumed_weight_grams', toNumberOrZero(record.consumed_weight_grams || record.required_weight_grams)],
      ['consumed_servings', toNumberOrZero(record.consumed_servings || record.required_servings)],
      ['cost', toNumberOrZero(record.cost || record.total_cost)],
      ['status', record.status || 'posted'],
      ['menu_plan_id', record.menu_plan_id || null, 'menu_plan'],
      ['menu_type', record.menu_type || record.cuisine_type || null],
      ['menu_category', record.menu_category || null],
      ['customer_meal_plan_id', record.customer_meal_plan_id || null],
      ['recipe_name', record.recipe_name || null],
      ['attendee_count', toNumberOrNull(record.attendee_count)],
      ['portions_per_attendee', toNumberOrNull(record.portions_per_attendee)],
      ['servings_per_attendee', toNumberOrNull(record.servings_per_attendee)],
      ['portion_size_grams', toNumberOrNull(record.portion_size_grams)],
      ['manual_portion_size_grams', toNumberOrNull(record.manual_portion_size_grams)],
      ['portion_size_source', record.portion_size_source || null],
      ['covers', toNumberOrNull(record.covers)],
      ['required_servings', toNumberOrNull(record.required_servings)],
      ['required_weight_grams', toNumberOrNull(record.required_weight_grams)],
      ['consumed_production_equivalent_servings', toNumberOrNull(record.consumed_production_equivalent_servings)],
      ['shortage_servings', toNumberOrNull(record.shortage_servings ?? record.short_servings)],
      ['shortage_weight_grams', toNumberOrNull(record.shortage_weight_grams ?? record.short_weight_grams)],
      ['reversal_reason', record.reversal_reason || null],
      ['performed_by', record.performed_by || null],
      ['performed_by_name', record.performed_by_name || null],
      ['performed_at', record.performed_at || null],
      ['cutover_version', toNumberOrNull(record.cutover_version) || 1],
      ['created_at', createdAt],
      ['updated_at', updatedAt]
    ];
    const mealServiceConsumptionColumnNames = mealServiceConsumptionColumns.map(([column]) => column);
    const mealServiceConsumptionValues = mealServiceConsumptionColumns.map(([, value]) => value);
    const mealServiceConsumptionPlaceholders = mealServiceConsumptionColumns.map(([, , kind], index) => {
      if (kind === 'menu_plan') {
        return `(SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF($${index + 1}::text, '') LIMIT 1)`;
      }
      if (kind === 'output_batch') {
        return `(SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF($${index + 1}::text, '') LIMIT 1)`;
      }
      if (kind === 'production') {
        return `(SELECT production_id FROM production_events WHERE production_id = NULLIF($${index + 1}::text, '') LIMIT 1)`;
      }
      if (kind === 'recipe_version') {
        return `(SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF($${index + 1}::text, '') LIMIT 1)`;
      }
      return `$${index + 1}`;
    });
    const mealServiceConsumptionUpdates = mealServiceConsumptionColumnNames
      .filter((column) => !['meal_consumption_id', 'created_at'].includes(column))
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await query(
      `INSERT INTO meal_service_consumptions (
        ${mealServiceConsumptionColumnNames.join(', ')}
      ) VALUES (${mealServiceConsumptionPlaceholders.join(', ')})
      ON CONFLICT (meal_consumption_id) DO UPDATE SET ${mealServiceConsumptionUpdates}`,
      mealServiceConsumptionValues,
      executor
    );
    await replaceMealServiceConsumptionAllocations(record, executor);
    return findNormalizedDocument(entity, record.id, executor);
  }
  if (entity === 'FoodWaste') {
    const wasteWeightGrams = toNumberOrZero(
      record.wasted_weight_grams
      ?? record.waste_weight_grams
      ?? record.quantity_grams
    ) || foodWasteQuantityToGrams(record.quantity, record.unit);
    const estimatedCost = toNumberOrZero(
      record.estimated_cost
      ?? record.waste_cost
      ?? record.cost
      ?? record.total_cost
    );
    await query(
      `INSERT INTO food_waste_records (
        food_waste_id, waste_reference, idempotency_key, warehouse_id, waste_date, meal_period,
        menu_type, menu_category, waste_category, reason_code, reason, waste_scope,
        source_type, avoidable_type, preventable, auto_generated, high_value,
        quantity_grams, unit, estimated_cost, menu_plan_id, menu_plan_name,
        meal_service_id, production_id, recipe_version_id, ingredient_id,
        production_name, recipe_name, ingredient_name, batch_reference,
        batch_overproduction_item_key, manifest_item_key, source_menu_plan_item_key,
        batch_recipe_id, batch_recipe_name, produced_weight_grams,
        available_weight_grams_before, wasted_production_equivalent_servings,
        served_at, production_completed_at, recording_window_basis,
        recording_window_open_at, recording_deadline_at, meal_service_adjustment_cost,
        inventory_transaction_id, inventory_deduction_quantity, inventory_shortage_quantity,
        notes, approval_status, status, recorded_by, reversed_by, reversed_at,
        reversal_reason, source_name, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF($21::text, '') LIMIT 1),
        $22,
        (SELECT meal_service_id FROM meal_service_headers WHERE meal_service_id = NULLIF($23::text, '') LIMIT 1),
        (SELECT production_id FROM production_events WHERE production_id = NULLIF($24::text, '') LIMIT 1),
        (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF($25::text, '') LIMIT 1),
        (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF($26::text, '') LIMIT 1),
        $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
        ${userReferenceSql(51)},
        ${userReferenceSql(52)},
        $53,$54,$55,$56,$57
      )
      ON CONFLICT (food_waste_id) DO UPDATE SET
        waste_reference = EXCLUDED.waste_reference, idempotency_key = EXCLUDED.idempotency_key,
        warehouse_id = EXCLUDED.warehouse_id, waste_date = EXCLUDED.waste_date,
        meal_period = EXCLUDED.meal_period, menu_type = EXCLUDED.menu_type,
        menu_category = EXCLUDED.menu_category, waste_category = EXCLUDED.waste_category,
        reason_code = EXCLUDED.reason_code, reason = EXCLUDED.reason,
        waste_scope = EXCLUDED.waste_scope, source_type = EXCLUDED.source_type,
        avoidable_type = EXCLUDED.avoidable_type, preventable = EXCLUDED.preventable,
        auto_generated = EXCLUDED.auto_generated, high_value = EXCLUDED.high_value,
        quantity_grams = EXCLUDED.quantity_grams, unit = EXCLUDED.unit,
        estimated_cost = EXCLUDED.estimated_cost, menu_plan_id = EXCLUDED.menu_plan_id,
        menu_plan_name = EXCLUDED.menu_plan_name, meal_service_id = EXCLUDED.meal_service_id,
        production_id = EXCLUDED.production_id, recipe_version_id = EXCLUDED.recipe_version_id,
        ingredient_id = EXCLUDED.ingredient_id, production_name = EXCLUDED.production_name,
        recipe_name = EXCLUDED.recipe_name, ingredient_name = EXCLUDED.ingredient_name,
        batch_reference = EXCLUDED.batch_reference,
        batch_overproduction_item_key = EXCLUDED.batch_overproduction_item_key,
        manifest_item_key = EXCLUDED.manifest_item_key,
        source_menu_plan_item_key = EXCLUDED.source_menu_plan_item_key,
        batch_recipe_id = EXCLUDED.batch_recipe_id,
        batch_recipe_name = EXCLUDED.batch_recipe_name,
        produced_weight_grams = EXCLUDED.produced_weight_grams,
        available_weight_grams_before = EXCLUDED.available_weight_grams_before,
        wasted_production_equivalent_servings = EXCLUDED.wasted_production_equivalent_servings,
        served_at = EXCLUDED.served_at,
        production_completed_at = EXCLUDED.production_completed_at,
        recording_window_basis = EXCLUDED.recording_window_basis,
        recording_window_open_at = EXCLUDED.recording_window_open_at,
        recording_deadline_at = EXCLUDED.recording_deadline_at,
        meal_service_adjustment_cost = EXCLUDED.meal_service_adjustment_cost,
        inventory_transaction_id = EXCLUDED.inventory_transaction_id,
        inventory_deduction_quantity = EXCLUDED.inventory_deduction_quantity,
        inventory_shortage_quantity = EXCLUDED.inventory_shortage_quantity,
        notes = EXCLUDED.notes, approval_status = EXCLUDED.approval_status,
        status = EXCLUDED.status, recorded_by = EXCLUDED.recorded_by,
        reversed_by = EXCLUDED.reversed_by, reversed_at = EXCLUDED.reversed_at,
        reversal_reason = EXCLUDED.reversal_reason, source_name = EXCLUDED.source_name,
        updated_at = EXCLUDED.updated_at`,
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
        record.reason || null,
        record.waste_scope || 'ingredient',
        record.source_type || 'manual_entry',
        record.avoidable_type || 'avoidable',
        record.preventable !== false,
        record.auto_generated === true,
        record.high_value === true,
        wasteWeightGrams,
        record.unit || 'g',
        estimatedCost,
        record.menu_plan_id || null,
        record.menu_plan_name || null,
        record.meal_service_attendance_id || record.meal_service_id || null,
        record.production_id || null,
        record.recipe_id || record.recipe_version_id || null,
        record.ingredient_id || null,
        record.production_name || null,
        record.recipe_name || null,
        record.ingredient_name || null,
        record.batch_reference || null,
        record.batch_overproduction_item_key || null,
        record.manifest_item_key || null,
        record.source_menu_plan_item_key || null,
        record.batch_recipe_id || null,
        record.batch_recipe_name || null,
        toNumberOrNull(record.produced_weight_grams),
        toNumberOrNull(record.available_weight_grams_before),
        toNumberOrNull(record.wasted_production_equivalent_servings),
        record.served_at || null,
        record.production_completed_at || null,
        record.recording_window_basis || null,
        record.recording_window_open_at || null,
        record.recording_deadline_at || null,
        toNumberOrZero(record.meal_service_adjustment_cost),
        record.inventory_transaction_id || null,
        toNumberOrZero(record.inventory_deduction_quantity),
        toNumberOrZero(record.inventory_shortage_quantity),
        record.notes || null,
        record.approval_status || 'pending',
        record.status || 'posted',
        record.recorded_by || null,
        record.reversed_by || null,
        record.reversed_at || null,
        record.reversal_reason || null,
        record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
    await replaceFoodWasteLines(record, executor);
    await replaceFoodWasteImages(record, executor);
    await replaceFoodWasteInventoryMovements(record, executor);
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
  'allocations',
  'data_mapping',
  'evidence_image_urls',
  'image_urls',
  'inventory_movement_layers',
  'meal_service_adjustment_consumption_ids',
  'meal_service_source_consumption_ids',
  'output_allocations',
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
               OR EXISTS (
                 SELECT 1
                   FROM user_site_access access
                  WHERE access.user_id = users.id
                    AND access.site_id = $1
               )
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
              OR EXISTS (
                SELECT 1
                  FROM user_site_access access
                 WHERE access.user_id = users.id
                   AND access.site_id = ANY($1::text[])
              )
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
      `SELECT role_profile.*,
              COALESCE(
                ARRAY_AGG(permission.permission_key ORDER BY permission.permission_key)
                  FILTER (WHERE permission.permission_key IS NOT NULL),
                ARRAY[]::text[]
              ) AS permissions
         FROM role_profiles role_profile
         LEFT JOIN role_profile_permissions permission
           ON permission.role_profile_id = role_profile.id
        GROUP BY role_profile.id`,
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
    const current = usesNormalizedCore('RoleProfile') ? rowToRoleProfile(row) : row.data;
    const normalized = normalizeManagementRoleProfile(current);
    if (normalized === current || JSON.stringify(normalized) === JSON.stringify(current)) continue;
    const next = { ...normalized, updated_date: nowIso() };
    if (usesNormalizedCore('RoleProfile')) {
      await insertOrUpdateRoleProfile(next, current, executor);
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
  const result = await query(`${USER_SELECT_SQL} ORDER BY app_user.updated_at DESC`, [], executor);
  return Promise.all(result.rows.map(async (row) => sanitizeUser(await hydrateUserRole(toUserRecord(row), executor))));
}

async function findUserById(id, executor = pool) {
  const result = await query(`${USER_SELECT_SQL} WHERE app_user.id = $1 LIMIT 1`, [id], executor);
  return result.rowCount ? hydrateUserRole(toUserRecord(result.rows[0]), executor) : null;
}

async function findUserByEmail(email, executor = pool) {
  const result = await query(`${USER_SELECT_SQL} WHERE LOWER(app_user.email) = LOWER($1) LIMIT 1`, [email], executor);
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
  await query(
    `INSERT INTO users (
       id, email, full_name, role, status, site_id, site_name,
       phone, language, avatar_url, visibility_scope,
       password_hash, temporary_password, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
    [
      id,
      data.email,
      data.full_name || null,
      data.role || 'user',
      data.status || 'active',
      data.site_id || null,
      data.site_name || null,
      data.phone || null,
      data.language || null,
      data.avatar_url || null,
      data.visibility_scope || null,
      credentials.password_hash,
      credentials.temporary_password,
      timestamp
    ],
    executor
  );
  await replaceUserSiteAccess(id, data, executor);

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
  await query(
    `UPDATE users
     SET email = $2,
         full_name = $3,
         role = $4,
         status = $5,
         site_id = $6,
         site_name = $7,
         phone = $8,
         language = $9,
         avatar_url = $10,
         visibility_scope = $11,
         password_hash = $12,
         temporary_password = $13,
         updated_at = $14
     WHERE id = $1`,
    [
      id,
      merged.email,
      merged.full_name || null,
      merged.role || 'user',
      merged.status || 'active',
      merged.site_id || null,
      merged.site_name || null,
      merged.phone || null,
      merged.language || null,
      merged.avatar_url || null,
      merged.visibility_scope || null,
      merged.password_hash,
      merged.temporary_password || null,
      merged.updated_date
    ],
    executor
  );
  await replaceUserSiteAccess(id, merged, executor);

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
         deactivated_at = $2,
         deactivated_by = $3,
         deactivation_reason = $4,
         updated_at = $2
     WHERE id = $1`,
    [
      target.id,
      deactivatedAt,
      deactivationMetadata.deactivated_by,
      deactivationMetadata.deactivation_reason
    ],
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

function bulkMenuPlanScopeOptions(options = {}) {
  const planDates = Array.isArray(options.plan_dates ?? options.planDates)
    ? (options.plan_dates ?? options.planDates)
      .map((value) => String(value || '').trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    : [];
  return {
    cuisine_type: normalizeMenuCuisine(options.menu_cuisine ?? options.menuCuisine ?? options.cuisine_type ?? options.cuisineType, ''),
    menu_category: normalizeMenuCategory(options.menu_category ?? options.menuCategory, ''),
    plan_dates: [...new Set(planDates)]
  };
}

function menuPlanMatchesBulkClearScope(record = {}, options = {}) {
  const scope = bulkMenuPlanScopeOptions(options);
  if (scope.cuisine_type && normalizeMenuCuisine(record?.cuisine_type ?? record?.menu_type, 'general') !== scope.cuisine_type) {
    return false;
  }
  if (scope.menu_category && normalizeMenuCategory(record?.menu_category, 'senior') !== scope.menu_category) {
    return false;
  }
  if (scope.plan_dates.length && !scope.plan_dates.includes(String(record?.plan_date || '').trim().slice(0, 10))) {
    return false;
  }
  return true;
}

async function clearDocumentsForBulk(entity, siteIds = null, executor = pool, options = {}) {
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
      if (entity === 'MenuPlan' && !menuPlanMatchesBulkClearScope(record, options)) {
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
  const menuPlanScope = entity === 'MenuPlan' ? bulkMenuPlanScopeOptions(options) : { cuisine_type: '', menu_category: '' };
  const menuPlanScopeFilter = entity === 'MenuPlan'
    ? `AND ($3::text = '' OR LOWER(REPLACE(COALESCE(data->>'cuisine_type', data->>'menu_type', 'general'), ' ', '_')) = $3)
       AND ($4::text = '' OR LOWER(REPLACE(COALESCE(data->>'menu_category', 'senior'), ' ', '_')) = $4)
       AND (COALESCE(array_length($5::text[], 1), 0) = 0 OR data->>'plan_date' = ANY($5::text[]))`
    : '';
  const globalMenuPlanScopeFilter = entity === 'MenuPlan'
    ? `AND ($2::text = '' OR LOWER(REPLACE(COALESCE(data->>'cuisine_type', data->>'menu_type', 'general'), ' ', '_')) = $2)
       AND ($3::text = '' OR LOWER(REPLACE(COALESCE(data->>'menu_category', 'senior'), ' ', '_')) = $3)
       AND (COALESCE(array_length($4::text[], 1), 0) = 0 OR data->>'plan_date' = ANY($4::text[]))`
    : '';
  if (Array.isArray(siteIds)) {
    if (!siteIds.length) return 0;
    const result = await query(
      `DELETE FROM entity_records
       WHERE entity_name = $1
         AND (
           data->>'site_id' = ANY($2::text[])
           OR COALESCE(data->'site_ids', '[]'::jsonb) ?| $2::text[]
         )
       ${menuPlanScopeFilter}
      ${preserveServerMealServiceWaste}`,
      entity === 'MenuPlan'
        ? [entity, siteIds, menuPlanScope.cuisine_type, menuPlanScope.menu_category, menuPlanScope.plan_dates]
        : [entity, siteIds],
      executor
    );
    return result.rowCount;
  }
  const result = await query(
    `DELETE FROM entity_records WHERE entity_name = $1 ${globalMenuPlanScopeFilter} ${preserveServerMealServiceWaste}`,
    entity === 'MenuPlan'
      ? [entity, menuPlanScope.cuisine_type, menuPlanScope.menu_category, menuPlanScope.plan_dates]
      : [entity],
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
