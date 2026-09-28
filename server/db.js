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

function normalizeTextArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
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

  const result = await query(
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
  );

  let value = result.rowCount
    ? normalizeManagementRoleProfile(rowToRoleProfile(result.rows[0]))
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

const normalizedAuxiliaryEntities = [
  'ERPIntegrationConfig',
  'ERPIntegrationLog',
  'ForecastSnapshot',
  'BranchOrder',
  'MaterialRequest',
  'MenuPlanPRSchedule',
  'MenuPlanPRRun',
  'ProductionBatch',
  'ProductionTransfer',
  'PurchaseOrder',
  'QualityControl',
  'RFQ',
  'AttendanceSession',
  'CategoryQRSession',
  'DinerScan',
  'CustomerMealPlan',
  'QRCode',
  'QRDelivery',
  'UserGroup',
  'AttendanceRecord',
  'StaffShift',
  'D365Master',
  'ForecastScenario',
  'WasteDetectionLog',
  'AdvancedReportSchedule',
  'WasteTarget',
  'Budget',
  'FoodCategory'
];

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
  ...normalizedAuxiliaryEntities
]);

function usesNormalizedCore(entity) {
  return normalizedCoreEntities.has(entity);
}

function normalizedStorageError(entity) {
  const error = new Error(`${entity} is not backed by normalized relational storage`);
  error.status = 501;
  error.code = 'NORMALIZED_STORAGE_REQUIRED';
  error.details = {
    entity
  };
  return error;
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

function rowNumberOrNull(value) {
  return toNumberOrNull(value);
}

function nullableText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function textList(value) {
  if (Array.isArray(value)) return normalizeTextArray(value);
  const text = String(value ?? '').trim();
  if (!text) return [];
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? normalizeTextArray(parsed) : [];
    } catch {
      return [text];
    }
  }
  return [text];
}

function numericStockSummaryValue(source, record, sourceField, recordField) {
  return rowNumberOrNull(source[sourceField] ?? record?.[recordField]);
}

function ingredientStockSummaryFromRecord(record = {}) {
  const source = rowJsonObject(record.stock_summary);
  const summary = {
    on_hand_quantity: numericStockSummaryValue(source, record, 'on_hand_quantity', 'stock_summary_on_hand_quantity'),
    reserved_quantity: numericStockSummaryValue(source, record, 'reserved_quantity', 'stock_summary_reserved_quantity'),
    available_quantity: numericStockSummaryValue(source, record, 'available_quantity', 'stock_summary_available_quantity'),
    total_value: numericStockSummaryValue(source, record, 'total_value', 'stock_summary_total_value'),
    site_count: rowNumberOrNull(source.site_count ?? record.stock_summary_site_count),
    unit: nullableText(source.unit ?? record.stock_summary_unit)
  };
  const hasValue = Object.entries(summary).some(([key, value]) => (key === 'unit' ? Boolean(value) : value !== null));
  return hasValue ? summary : null;
}

function ingredientStockSummaryFromRow(row = {}) {
  return ingredientStockSummaryFromRecord({
    stock_summary_on_hand_quantity: row.stock_summary_on_hand_quantity,
    stock_summary_reserved_quantity: row.stock_summary_reserved_quantity,
    stock_summary_available_quantity: row.stock_summary_available_quantity,
    stock_summary_total_value: row.stock_summary_total_value,
    stock_summary_site_count: row.stock_summary_site_count,
    stock_summary_unit: row.stock_summary_unit
  });
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function metadataValueFromColumns(entry = {}, prefix = 'value') {
  const booleanValue = entry[`${prefix}_boolean`];
  if (booleanValue !== null && typeof booleanValue !== 'undefined') return booleanValue === true;
  const numericValue = entry[`${prefix}_numeric`];
  if (numericValue !== null && typeof numericValue !== 'undefined') return Number(numericValue);
  const dateValue = entry[`${prefix}_date`];
  if (dateValue !== null && typeof dateValue !== 'undefined') return rowTimestamp(dateValue);
  const textValue = entry[`${prefix}_text`];
  return textValue === null || typeof textValue === 'undefined' ? null : textValue;
}

function metadataWriteColumns(value) {
  if (typeof value === 'boolean') {
    return { text: null, numeric: null, boolean: value, date: null };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { text: null, numeric: value, boolean: null, date: null };
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { text: null, numeric: null, boolean: null, date: value.toISOString() };
  }
  if (typeof value === 'string') {
    return { text: value, numeric: null, boolean: null, date: null };
  }
  return { text: value === null || typeof value === 'undefined' ? null : String(value), numeric: null, boolean: null, date: null };
}

function inventoryTransactionMetadata(row = {}) {
  const metadata = {};
  rowJsonArray(row.metadata_entries).forEach((entry) => {
    if (!entry?.metadata_key) return;
    metadata[entry.metadata_key] = metadataValueFromColumns(entry, 'value');
  });

  const itemGroups = new Map();
  rowJsonArray(row.metadata_items).forEach((entry) => {
    if (!entry?.metadata_key) return;
    const containerType = entry.container_type || 'array';
    const itemOrder = Number(entry.item_order || 1);
    const groupKey = `${entry.metadata_key}::${containerType}::${itemOrder}`;
    if (!itemGroups.has(groupKey)) {
      itemGroups.set(groupKey, {
        metadata_key: entry.metadata_key,
        container_type: containerType,
        item_order: itemOrder,
        attributes: {}
      });
    }
    itemGroups.get(groupKey).attributes[entry.attribute_name || 'value'] = metadataValueFromColumns(entry, 'attribute_value');
  });

  const groupedByMetadataKey = new Map();
  for (const item of itemGroups.values()) {
    if (item.container_type === 'object') {
      metadata[item.metadata_key] = { ...(metadata[item.metadata_key] || {}), ...item.attributes };
      continue;
    }
    const list = groupedByMetadataKey.get(item.metadata_key) || [];
    const attributeKeys = Object.keys(item.attributes);
    list.push({
      order: item.item_order,
      value: attributeKeys.length === 1 && attributeKeys[0] === 'value'
        ? item.attributes.value
        : item.attributes
    });
    groupedByMetadataKey.set(item.metadata_key, list);
  }

  for (const [metadataKey, items] of groupedByMetadataKey.entries()) {
    metadata[metadataKey] = items
      .sort((left, right) => left.order - right.order)
      .map((item) => item.value);
  }

  return metadata;
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

function rowToSite(row = {}) {
  return hydrateDerivedFields('Site', {
    __entity: 'Site',
    id: row.id,
    name: row.name,
    type: row.type,
    parent_site_id: row.parent_site_id || null,
    project_code: row.project_code || row.warehouse_code || row.area_code || row.project_code || null,
    d365_warehouse_id: row.d365_warehouse_id || null,
    source_name: row.source_name || null,
    is_active: row.status !== 'inactive',
    status: row.status || 'active',
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToIngredient(row = {}) {
  const aliases = rowJsonArray(row.aliases);
  const alternativeNames = rowJsonArray(row.alternative_names);
  const supplierItemNames = rowJsonArray(row.supplier_item_names);
  const allergens = rowJsonArray(row.allergens);
  const stockSummary = ingredientStockSummaryFromRow(row);
  return hydrateDerivedFields('Ingredient', {
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
    alias: row.alias || aliases[0] || null,
    aliases,
    alternative_name: row.alternative_name || alternativeNames[0] || null,
    alternative_names: alternativeNames,
    supplier_item_name: row.supplier_item_name || supplierItemNames[0] || null,
    supplier_item_names: supplierItemNames,
    supplier: row.supplier || null,
    cost_per_unit: rowNumberOrNull(row.cost_per_unit),
    package_pack_count: rowNumberOrNull(row.package_pack_count),
    package_inner_count: rowNumberOrNull(row.package_inner_count),
    package_size_quantity: rowNumberOrNull(row.package_size_quantity),
    package_size_unit: row.package_size_unit || null,
    package_base_quantity: rowNumberOrNull(row.package_base_quantity),
    package_base_unit: row.package_base_unit || null,
    package_parse_source: row.package_parse_source || null,
    calories_per_100g: rowNumberOrNull(row.calories_per_100g),
    protein_per_100g: rowNumberOrNull(row.protein_per_100g),
    carbs_per_100g: rowNumberOrNull(row.carbs_per_100g),
    fat_per_100g: rowNumberOrNull(row.fat_per_100g),
    fiber_per_100g: rowNumberOrNull(row.fiber_per_100g),
    sodium_per_100g: rowNumberOrNull(row.sodium_per_100g),
    sugar_per_100g: rowNumberOrNull(row.sugar_per_100g),
    cooking_yield_percent: rowNumberOrNull(row.cooking_yield_percent),
    shrinkage_percent: rowNumberOrNull(row.shrinkage_percent),
    raw_weight_per_unit: rowNumberOrNull(row.raw_weight_per_unit),
    cooked_weight_per_unit: rowNumberOrNull(row.cooked_weight_per_unit),
    allergens,
    conversion_unit: row.conversion_unit || null,
    conversion_factor: rowNumberOrNull(row.conversion_factor),
    ...(stockSummary ? { stock_summary: stockSummary } : {}),
    is_active: row.status !== 'inactive',
    status: row.status || 'active',
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToInventory(row = {}) {
  return hydrateDerivedFields('Inventory', {
    __entity: 'Inventory',
    id: row.inventory_id,
    site_id: row.warehouse_id,
    warehouse_id: row.warehouse_id,
    site_name: row.warehouse_name || row.site_name || null,
    warehouse_name: row.warehouse_name || row.site_name || null,
    ingredient_id: row.ingredient_id,
    ingredient_name: row.ingredient_name || row.item_name || null,
    item_code: row.item_code || row.ingredient_code || row.sku || row.d365_item_id || null,
    ingredient_code: row.ingredient_code || null,
    sku: row.sku || null,
    d365_item_id: row.d365_item_id || null,
    available_quantity: Number(row.available_quantity || 0),
    reserved_quantity: Number(row.reserved_quantity || 0),
    on_hand_quantity: Number(row.on_hand_quantity || 0),
    quantity: Number(row.on_hand_quantity || row.available_quantity || 0),
    average_unit_cost: Number(row.average_unit_cost || 0),
    last_unit_cost: Number(row.last_unit_cost || 0),
    unit: row.stock_unit,
    stock_unit: row.stock_unit,
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function ingredientAliasRows(record = {}) {
  const rows = [];
  const pushRows = (aliasType, values) => {
    textList(values).forEach((alias) => {
      rows.push({ alias_type: aliasType, alias });
    });
  };
  pushRows('alias', [record.alias, ...textList(record.aliases)]);
  pushRows('alternative_name', [record.alternative_name, ...textList(record.alternative_names)]);
  pushRows('supplier_item_name', [record.supplier_item_name, ...textList(record.supplier_item_names)]);
  const unique = new Map();
  rows.forEach((row) => {
    const key = `${row.alias_type}:${row.alias.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()];
}

async function replaceIngredientAliases(record = {}, executor = pool) {
  await query('DELETE FROM ingredient_aliases WHERE ingredient_id = $1', [record.id], executor);
  const rows = ingredientAliasRows(record);
  for (const row of rows) {
    await query(
      `INSERT INTO ingredient_aliases (
        ingredient_alias_id, ingredient_id, alias, alias_type, source_name, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING`,
      [
        randomId('ingredient_alias'),
        record.id,
        row.alias,
        row.alias_type,
        record.source_name || null,
        record.updated_date || nowIso()
      ],
      executor
    );
  }
}

async function replaceIngredientAllergens(record = {}, executor = pool) {
  await query('DELETE FROM ingredient_allergen_tags WHERE ingredient_id = $1', [record.id], executor);
  const rows = normalizeTextArray(record.allergens);
  for (const tag of rows) {
    await query(
      `INSERT INTO ingredient_allergen_tags (
        ingredient_allergen_id, ingredient_id, tag, source_name, created_at
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`,
      [
        randomId('ingredient_allergen'),
        record.id,
        tag,
        record.source_name || null,
        record.updated_date || nowIso()
      ],
      executor
    );
  }
}

async function upsertIngredientDetails(record = {}, executor = pool) {
  await query(
    `INSERT INTO ingredient_details (
      ingredient_id, supplier_item_name, supplier_name, cost_per_unit,
      package_pack_count, package_inner_count, package_size_quantity, package_size_unit,
      package_base_quantity, package_base_unit, package_parse_source,
      cooking_yield_percent, shrinkage_percent, raw_weight_per_unit, cooked_weight_per_unit,
      source_name, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
    )
    ON CONFLICT (ingredient_id) DO UPDATE SET
      supplier_item_name = EXCLUDED.supplier_item_name,
      supplier_name = EXCLUDED.supplier_name,
      cost_per_unit = EXCLUDED.cost_per_unit,
      package_pack_count = EXCLUDED.package_pack_count,
      package_inner_count = EXCLUDED.package_inner_count,
      package_size_quantity = EXCLUDED.package_size_quantity,
      package_size_unit = EXCLUDED.package_size_unit,
      package_base_quantity = EXCLUDED.package_base_quantity,
      package_base_unit = EXCLUDED.package_base_unit,
      package_parse_source = EXCLUDED.package_parse_source,
      cooking_yield_percent = EXCLUDED.cooking_yield_percent,
      shrinkage_percent = EXCLUDED.shrinkage_percent,
      raw_weight_per_unit = EXCLUDED.raw_weight_per_unit,
      cooked_weight_per_unit = EXCLUDED.cooked_weight_per_unit,
      source_name = EXCLUDED.source_name,
      updated_at = EXCLUDED.updated_at`,
    [
      record.id,
      nullableText(record.supplier_item_name || textList(record.supplier_item_names)[0]),
      nullableText(record.supplier ?? record.supplier_name),
      rowNumberOrNull(record.cost_per_unit),
      rowNumberOrNull(record.package_pack_count),
      rowNumberOrNull(record.package_inner_count),
      rowNumberOrNull(record.package_size_quantity),
      nullableText(record.package_size_unit),
      rowNumberOrNull(record.package_base_quantity),
      nullableText(record.package_base_unit),
      nullableText(record.package_parse_source),
      rowNumberOrNull(record.cooking_yield_percent),
      rowNumberOrNull(record.shrinkage_percent),
      rowNumberOrNull(record.raw_weight_per_unit),
      rowNumberOrNull(record.cooked_weight_per_unit),
      record.source_name || null,
      record.created_date || nowIso(),
      record.updated_date || nowIso()
    ],
    executor
  );
}

async function upsertIngredientNutritionProfile(record = {}, executor = pool) {
  await query(
    `INSERT INTO ingredient_nutrition_profiles (
      ingredient_id, calories_per_100g, protein_per_100g, carbs_per_100g,
      fat_per_100g, fiber_per_100g, sodium_per_100g, sugar_per_100g,
      source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (ingredient_id) DO UPDATE SET
      calories_per_100g = EXCLUDED.calories_per_100g,
      protein_per_100g = EXCLUDED.protein_per_100g,
      carbs_per_100g = EXCLUDED.carbs_per_100g,
      fat_per_100g = EXCLUDED.fat_per_100g,
      fiber_per_100g = EXCLUDED.fiber_per_100g,
      sodium_per_100g = EXCLUDED.sodium_per_100g,
      sugar_per_100g = EXCLUDED.sugar_per_100g,
      source_name = EXCLUDED.source_name,
      updated_at = EXCLUDED.updated_at`,
    [
      record.id,
      rowNumberOrNull(record.calories_per_100g),
      rowNumberOrNull(record.protein_per_100g),
      rowNumberOrNull(record.carbs_per_100g),
      rowNumberOrNull(record.fat_per_100g),
      rowNumberOrNull(record.fiber_per_100g),
      rowNumberOrNull(record.sodium_per_100g),
      rowNumberOrNull(record.sugar_per_100g),
      record.source_name || null,
      record.created_date || nowIso(),
      record.updated_date || nowIso()
    ],
    executor
  );
}

async function upsertIngredientUnitConversion(record = {}, executor = pool) {
  const fromUnit = nullableText(record.base_unit || record.unit);
  const toUnit = nullableText(record.conversion_unit);
  const factor = rowNumberOrNull(record.conversion_factor);
  if (!fromUnit || !toUnit || !factor || factor <= 0) return;
  await query(
    `INSERT INTO ingredient_unit_conversions (
      conversion_id, ingredient_id, from_unit, to_unit, factor, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (ingredient_id, from_unit, to_unit) DO UPDATE SET
      factor = EXCLUDED.factor,
      source_name = EXCLUDED.source_name,
      updated_at = EXCLUDED.updated_at`,
    [
      randomId('ingredient_conversion'),
      record.id,
      fromUnit,
      toUnit,
      factor,
      record.source_name || null,
      record.created_date || nowIso(),
      record.updated_date || nowIso()
    ],
    executor
  );
}

async function upsertIngredientStockSummary(record = {}, executor = pool) {
  const stockSummary = ingredientStockSummaryFromRecord(record);
  if (!stockSummary) return;
  await query(
    `INSERT INTO ingredient_stock_summaries (
      ingredient_id, on_hand_quantity, reserved_quantity, available_quantity,
      total_value, site_count, unit, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (ingredient_id) DO UPDATE SET
      on_hand_quantity = EXCLUDED.on_hand_quantity,
      reserved_quantity = EXCLUDED.reserved_quantity,
      available_quantity = EXCLUDED.available_quantity,
      total_value = EXCLUDED.total_value,
      site_count = EXCLUDED.site_count,
      unit = EXCLUDED.unit,
      source_name = EXCLUDED.source_name,
      updated_at = EXCLUDED.updated_at`,
    [
      record.id,
      stockSummary.on_hand_quantity,
      stockSummary.reserved_quantity,
      stockSummary.available_quantity,
      stockSummary.total_value,
      stockSummary.site_count === null ? null : Math.trunc(stockSummary.site_count),
      stockSummary.unit,
      record.source_name || null,
      record.created_date || nowIso(),
      record.updated_date || nowIso()
    ],
    executor
  );
}

async function replaceIngredientRelationalDetails(record = {}, executor = pool) {
  await upsertIngredientDetails(record, executor);
  await upsertIngredientNutritionProfile(record, executor);
  await replaceIngredientAliases(record, executor);
  await replaceIngredientAllergens(record, executor);
  await upsertIngredientUnitConversion(record, executor);
  await upsertIngredientStockSummary(record, executor);
}

function rowToInventoryLot(row = {}) {
  return hydrateDerivedFields('InventoryLot', {
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
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToInventoryTransaction(row = {}) {
  return hydrateDerivedFields('InventoryTransaction', {
    id: row.inventory_transaction_id,
    inventory_id: row.inventory_id || null,
    site_id: row.warehouse_id || null,
    warehouse_id: row.warehouse_id || null,
    site_name: row.warehouse_name || null,
    warehouse_name: row.warehouse_name || null,
    ingredient_id: row.ingredient_id || null,
    ingredient_name: row.ingredient_name || null,
    item_code: row.item_code || null,
    inventory_lot_id: row.lot_id || null,
    lot_id: row.lot_id || null,
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
    source_name: row.source_name || null,
    notes: row.notes || null,
    performed_by: row.performed_by || null,
    batch_number: row.batch_number || null,
    expiry_date: toDateOnlyOrNull(row.expiry_date),
    stock_date: toDateOnlyOrNull(row.stock_date),
    received_date: toDateOnlyOrNull(row.received_date),
    from_site_id: row.from_warehouse_id || null,
    from_site_name: row.from_warehouse_name || null,
    from_warehouse_id: row.from_warehouse_id || null,
    from_warehouse_name: row.from_warehouse_name || null,
    to_site_id: row.to_warehouse_id || null,
    to_site_name: row.to_warehouse_name || null,
    to_warehouse_id: row.to_warehouse_id || null,
    to_warehouse_name: row.to_warehouse_name || null,
    source: row.source || null,
    source_type: row.source_type || null,
    balance_before: toNumberOrNull(row.balance_before),
    balance_after: toNumberOrNull(row.balance_after),
    opening_quantity: toNumberOrNull(row.opening_quantity),
    addition_quantity: toNumberOrNull(row.addition_quantity),
    consumption_quantity: toNumberOrNull(row.consumption_quantity),
    remaining_quantity: toNumberOrNull(row.remaining_quantity),
    operation: row.operation || null,
    operation_id: row.operation_id || null,
    commitment_revision: toNumberOrNull(row.commitment_revision),
    movement_layers: rowJsonArray(row.movement_layers),
    metadata: inventoryTransactionMetadata(row),
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToRecipe(row = {}) {
  const ingredients = rowJsonArray(row.ingredients).map((line = {}, index) => ({
    id: line.id || line.recipe_line_id || `${row.recipe_version_id}:line:${index + 1}`,
    recipe_line_id: line.recipe_line_id || line.id || `${row.recipe_version_id}:line:${index + 1}`,
    ingredient_id: line.ingredient_id || null,
    item_code: line.item_code || line.ingredient_code || line.sku || line.d365_item_id || null,
    ingredient_code: line.ingredient_code || null,
    sku: line.sku || null,
    d365_item_id: line.d365_item_id || null,
    ingredient_name: line.ingredient_name || line.name || null,
    name: line.ingredient_name || line.name || null,
    line_number: Number(line.line_number || index + 1),
    quantity: Number(line.quantity || 0),
    line_quantity: Number(line.quantity || 0),
    unit: line.unit || 'EA',
    line_unit: line.unit || 'EA',
    converted_quantity: rowNumberOrNull(line.converted_quantity),
    converted_unit: line.converted_unit || null,
    raw_weight_grams: rowNumberOrNull(line.raw_weight_grams),
    yield_percent: rowNumberOrNull(line.yield_percent) ?? 100,
    line_yield_percent: rowNumberOrNull(line.yield_percent) ?? 100,
    yielded_weight_grams: rowNumberOrNull(line.yielded_weight_grams),
    cost: Number(line.cost || 0),
    line_cost: Number(line.cost || 0),
    source_name: line.source_name || null
  }));
  const scopedSiteIds = [row.warehouse_id, row.project_id, row.area_id].filter(Boolean);
  return hydrateDerivedFields('Recipe', {
    __entity: 'Recipe',
    id: row.recipe_version_id,
    recipe_master_id: row.recipe_id,
    canonical_name: row.canonical_name || null,
    description: row.description || null,
    name: row.display_name,
    recipe_code: row.recipe_code || null,
    cuisine_type: row.cuisine_type || null,
    category: row.menu_category || null,
    menu_category: row.menu_category || null,
    servings: Number(row.batch_yield || 1),
    portion_size_grams: row.serving_size_grams === null ? null : Number(row.serving_size_grams || 0),
    batch_yield: Number(row.batch_yield || 1),
    total_recipe_weight_grams: row.total_recipe_weight_grams === null ? null : Number(row.total_recipe_weight_grams || 0),
    total_cost: Number(row.total_cost || 0),
    cost_per_serving: Number(row.cost_per_serving || 0),
    ingredients,
    site_scope: scopedSiteIds.length ? 'specific' : 'global',
    site_ids: scopedSiteIds,
    warehouse_id: row.warehouse_id || null,
    project_id: row.project_id || null,
    area_id: row.area_id || null,
    status: row.status || 'active',
    is_active: row.status !== 'inactive',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToMenuPlan(row = {}) {
  return hydrateDerivedFields('MenuPlan', {
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
    created_by: row.created_by || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
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
  const categories = Array.isArray(row.categories)
    ? row.categories.map((category) => String(category || '').trim()).filter(Boolean)
    : [];
  return hydrateDerivedFields('Supplier', {
    __entity: 'Supplier',
    id: row.id,
    name: row.name,
    supplier_code: row.supplier_code || null,
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
    categories,
    notes: row.notes || null,
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToFoodCategory(row = {}) {
  return hydrateDerivedFields('FoodCategory', {
    __entity: 'FoodCategory',
    id: row.id,
    name: row.name || 'Food Category',
    code: row.code || null,
    description: row.description || null,
    color: row.color || '#10b981',
    status: row.status || (row.is_active === false ? 'inactive' : 'active'),
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToBudget(row = {}) {
  return hydrateDerivedFields('Budget', {
    __entity: 'Budget',
    id: row.id,
    budget_key: row.budget_key || null,
    name: row.name || 'Budget',
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    start_date: row.start_date ? String(row.start_date).slice(0, 10) : null,
    end_date: row.end_date ? String(row.end_date).slice(0, 10) : null,
    budget_amount: toNumberOrZero(row.budget_amount),
    currency: row.currency || 'SAR',
    scope_type: row.scope_type || 'site_period',
    meal_type: row.meal_type || 'all',
    event_name: row.event_name || null,
    category: row.category || null,
    department: row.department || null,
    source_module: row.source_module || null,
    budget_level: row.budget_level || null,
    budget_mode: row.budget_mode || null,
    daily_budget_amount: toNumberOrZero(row.daily_budget_amount),
    monthly_budget_amount: toNumberOrZero(row.monthly_budget_amount),
    status: row.status || 'active',
    notes: row.notes || null,
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToWasteTarget(row = {}) {
  return hydrateDerivedFields('WasteTarget', {
    __entity: 'WasteTarget',
    id: row.id,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    target_month: row.target_month || null,
    target_percentage: toNumberOrZero(row.target_percentage),
    target_cost: toNumberOrZero(row.target_cost),
    notes: row.notes || null,
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToAdvancedReportSchedule(row = {}) {
  return hydrateDerivedFields('AdvancedReportSchedule', {
    __entity: 'AdvancedReportSchedule',
    id: row.id,
    report_key: row.report_key || 'food_cost',
    recipients: row.recipients || '',
    frequency: row.frequency || 'weekly',
    format: row.format || 'pdf',
    location_id: row.location_id || row.site_id || 'all',
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    category: row.category || 'all',
    notes: row.notes || '',
    next_run_date: row.next_run_date ? String(row.next_run_date).slice(0, 10) : null,
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToWasteDetectionLog(row = {}) {
  return hydrateDerivedFields('WasteDetectionLog', {
    __entity: 'WasteDetectionLog',
    id: row.id,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    image_url: row.image_url || null,
    detected_food_types: normalizeTextArray(row.detected_food_types),
    estimated_waste_grams: toNumberOrZero(row.estimated_waste_grams),
    waste_percentage: toNumberOrZero(row.waste_percentage),
    waste_category: row.waste_category || null,
    confidence_score: toNumberOrZero(row.confidence_score),
    ai_suggestions: normalizeTextArray(row.ai_suggestions),
    cost_estimate: toNumberOrZero(row.cost_estimate),
    detection_method: row.detection_method || 'camera',
    detected_by: row.detected_by || null,
    detected_at: rowTimestamp(row.detected_at) || rowTimestamp(row.created_at),
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToD365Master(row = {}) {
  return hydrateDerivedFields('D365Master', {
    __entity: 'D365Master',
    id: row.id,
    status: row.status || 'synced',
    source_system: row.source_system || null,
    module_key: row.module_key || null,
    sync_id: row.sync_id || null,
    idempotency_key: row.idempotency_key || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    ingredient_id: row.ingredient_id || null,
    ingredient_name: row.ingredient_name || null,
    d365_item_id: row.d365_item_id || null,
    d365_warehouse_id: row.d365_warehouse_id || null,
    integration_log_id: row.integration_log_id || null,
    processed_at: rowTimestamp(row.processed_at) || rowTimestamp(row.created_at),
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToForecastScenario(row = {}) {
  return hydrateDerivedFields('ForecastScenario', {
    __entity: 'ForecastScenario',
    id: row.id,
    name: row.name || 'Forecast Scenario',
    location_id: row.location_id || null,
    location_name: row.location_name || null,
    site_id: row.site_id || row.location_id || null,
    site_name: row.site_name || row.location_name || null,
    category: row.category || 'all',
    status_filter: row.status_filter || 'all',
    start_date: row.start_date ? String(row.start_date).slice(0, 10) : null,
    end_date: row.end_date ? String(row.end_date).slice(0, 10) : null,
    forecast_horizon_days: Math.max(1, Math.trunc(toNumberOrZero(row.forecast_horizon_days) || 7)),
    safety_buffer_percent: toNumberOrZero(row.safety_buffer_percent),
    model_type: row.model_type || 'blended_average',
    status: row.status || 'draft',
    notes: row.notes || '',
    last_run_date: rowTimestamp(row.last_run_date),
    latest_snapshot_id: row.latest_snapshot_id || null,
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToAttendanceRecord(row = {}) {
  const attendeeId = row.attendee_id || row.employee_id || null;
  const attendeeName = row.attendee_name || row.employee_name || null;
  const attendanceDate = row.attendance_date || row.session_date || row.service_date || row.shift_date || null;
  return hydrateDerivedFields('AttendanceRecord', {
    __entity: 'AttendanceRecord',
    id: row.id,
    shift_id: row.shift_id || null,
    session_id: row.session_id || null,
    session_name: row.session_name || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    shift_date: row.shift_date ? String(row.shift_date).slice(0, 10) : null,
    attendance_date: attendanceDate ? String(attendanceDate).slice(0, 10) : null,
    session_date: row.session_date ? String(row.session_date).slice(0, 10) : null,
    service_date: row.service_date ? String(row.service_date).slice(0, 10) : null,
    meal_type: row.meal_type || null,
    menu_type: row.menu_type || null,
    menu_category: row.menu_category || null,
    employee_id: attendeeId,
    employee_name: attendeeName,
    attendee_id: attendeeId,
    attendee_name: attendeeName,
    attendee_phone: row.attendee_phone || null,
    category: row.category || null,
    check_in: row.check_in || null,
    check_out: row.check_out || null,
    check_in_at: rowTimestamp(row.check_in_at),
    check_out_at: rowTimestamp(row.check_out_at),
    marked_at: rowTimestamp(row.marked_at),
    scan_method: row.scan_method || null,
    qr_code_id: row.qr_code_id || null,
    scanned_by: row.scanned_by || null,
    scanned_by_name: row.scanned_by_name || null,
    attendance_status: row.attendance_status || 'present',
    approval_status: row.approval_status || 'pending',
    status: row.status || 'checked_in',
    notes: row.notes || null,
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToStaffShift(row = {}) {
  return hydrateDerivedFields('StaffShift', {
    __entity: 'StaffShift',
    id: row.id,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    shift_date: row.shift_date ? String(row.shift_date).slice(0, 10) : null,
    employee_id: row.employee_id || null,
    employee_name: row.employee_name || null,
    role: row.role || null,
    category: row.category || null,
    shift_type: row.shift_type || null,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    break_minutes: Math.max(0, Math.trunc(toNumberOrZero(row.break_minutes))),
    approval_status: row.approval_status || 'pending',
    status: row.status || 'scheduled',
    notes: row.notes || null,
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function mealWindowRowsFromValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry && typeof entry === 'object' ? entry : null))
      .filter(Boolean);
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .map(([mealType, window]) => {
      if (!window || typeof window !== 'object') return null;
      return {
        meal_type: mealType,
        label: window.label || mealType,
        start_time: window.start_time || window.start || null,
        end_time: window.end_time || window.end || null
      };
    })
    .filter(Boolean);
}

function mealWindowObjectFromRows(rows = []) {
  const entries = rowJsonArray(rows);
  return entries.reduce((windows, entry) => {
    const mealType = entry.meal_type || entry.key || entry.name;
    if (!mealType) return windows;
    windows[mealType] = {
      label: entry.label || mealType,
      start_time: entry.start_time || null,
      end_time: entry.end_time || null
    };
    return windows;
  }, {});
}

function rowToAttendanceSession(row = {}) {
  return hydrateDerivedFields('AttendanceSession', {
    __entity: 'AttendanceSession',
    id: row.id,
    session_name: row.session_name || row.title || 'Attendance Session',
    title: row.title || row.session_name || 'Attendance Session',
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    meal_type: row.meal_type || null,
    session_date: row.session_date ? String(row.session_date).slice(0, 10) : null,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    qr_token: row.qr_token || null,
    qr_expiry: rowTimestamp(row.qr_expiry),
    expected_labor: toNumberOrZero(row.expected_labor),
    expected_junior: toNumberOrZero(row.expected_junior),
    expected_senior: toNumberOrZero(row.expected_senior),
    actual_labor: toNumberOrZero(row.actual_labor),
    actual_junior: toNumberOrZero(row.actual_junior),
    actual_senior: toNumberOrZero(row.actual_senior),
    validity_minutes: Math.max(0, Math.trunc(toNumberOrZero(row.validity_minutes))),
    notes: row.notes || null,
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToCategoryQRSession(row = {}) {
  const categories = rowJsonArray(row.categories);
  const scanCounts = categories.reduce((counts, category) => {
    if (category?.category) counts[category.category] = toNumberOrZero(category.scan_count);
    return counts;
  }, rowJsonObject(row.scan_counts));
  return hydrateDerivedFields('CategoryQRSession', {
    __entity: 'CategoryQRSession',
    id: row.id,
    title: row.title || 'Category QR Session',
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    session_date: row.session_date ? String(row.session_date).slice(0, 10) : null,
    from_date: row.from_date ? String(row.from_date).slice(0, 10) : null,
    to_date: row.to_date ? String(row.to_date).slice(0, 10) : null,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    categories,
    scan_counts: scanCounts,
    notes: row.notes || null,
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToDinerScan(row = {}) {
  return hydrateDerivedFields('DinerScan', {
    __entity: 'DinerScan',
    id: row.id,
    event_id: row.event_id || null,
    event_name: row.event_name || null,
    event_qr_token: row.event_qr_token || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    plan_date: row.plan_date ? String(row.plan_date).slice(0, 10) : null,
    meal_type: row.meal_type || null,
    guest_token: row.guest_token || null,
    scan_method: row.scan_method || null,
    scanned_at: rowTimestamp(row.scanned_at) || rowTimestamp(row.created_at),
    status: row.status || 'scanned',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToCustomerMealPlan(row = {}) {
  return hydrateDerivedFields('CustomerMealPlan', {
    __entity: 'CustomerMealPlan',
    id: row.id,
    name: row.name || 'Customer Meal Plan',
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    plan_date: row.plan_date ? String(row.plan_date).slice(0, 10) : null,
    customer_id: row.customer_id || null,
    customer_name: row.customer_name || null,
    meals: rowJsonArray(row.meals),
    notes: row.notes || null,
    status: row.status || 'draft',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToQRCode(row = {}) {
  const title = row.title || row.name || row.employee_name || 'QR Code';
  return hydrateDerivedFields('QRCode', {
    __entity: 'QRCode',
    id: row.id,
    title,
    name: row.name || title,
    category: row.category || null,
    description: row.description || null,
    token: row.token || null,
    linked_item: row.linked_item || null,
    is_one_time: row.is_one_time === true,
    one_time: row.is_one_time === true,
    max_scans: Math.max(0, Math.trunc(toNumberOrZero(row.max_scans))),
    scan_count: Math.max(0, Math.trunc(toNumberOrZero(row.scan_count))),
    expiry_date: rowTimestamp(row.expiry_date),
    last_scanned_at: rowTimestamp(row.last_scanned_at),
    employee_name: row.employee_name || null,
    company_id_number: row.company_id_number || null,
    mobile_number: row.mobile_number || null,
    active_whatsapp: row.active_whatsapp === true,
    created_by: row.created_by || null,
    created_by_name: row.created_by_name || null,
    meal_windows: mealWindowObjectFromRows(row.meal_windows),
    scan_history: rowJsonArray(row.scan_history),
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToQRDelivery(row = {}) {
  return hydrateDerivedFields('QRDelivery', {
    __entity: 'QRDelivery',
    id: row.id,
    qr_code_id: row.qr_code_id || null,
    qr_code_title: row.qr_code_title || null,
    qr_token: row.qr_token || null,
    delivery_method: row.delivery_method || 'email',
    subject: row.subject || null,
    message: row.message || null,
    scheduled_at: rowTimestamp(row.scheduled_at),
    sent_at: rowTimestamp(row.sent_at),
    sent_count: Math.max(0, Math.trunc(toNumberOrZero(row.sent_count))),
    failed_count: Math.max(0, Math.trunc(toNumberOrZero(row.failed_count))),
    recipients: rowJsonArray(row.recipients),
    group_ids: normalizeTextArray(row.group_ids),
    status: row.status || 'pending',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToUserGroup(row = {}) {
  const members = rowJsonArray(row.members);
  return hydrateDerivedFields('UserGroup', {
    __entity: 'UserGroup',
    id: row.id,
    name: row.name || 'User Group',
    description: row.description || null,
    members,
    total_members: Math.max(0, Math.trunc(toNumberOrZero(row.total_members) || members.length)),
    status: row.status || 'active',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

async function replaceCategoryQRSessionCategories(record = {}, executor = pool) {
  await query('DELETE FROM category_qr_session_categories WHERE session_id = $1', [record.id], executor);
  const scanCounts = rowJsonObject(record.scan_counts);
  const categories = rowJsonArray(record.categories);
  for (const [index, category] of categories.entries()) {
    await query(
      `INSERT INTO category_qr_session_categories (
        session_id, category, label, token, scan_count, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        record.id,
        category.category || category.value || null,
        category.label || category.name || category.category || null,
        category.token || null,
        toNumberOrZero(scanCounts[category.category] ?? category.scan_count),
        index
      ],
      executor
    );
  }
}

async function replaceCustomerMealPlanMeals(record = {}, executor = pool) {
  await query('DELETE FROM customer_meal_plan_meals WHERE customer_meal_plan_id = $1', [record.id], executor);
  const meals = rowJsonArray(record.meals);
  for (const [index, meal] of meals.entries()) {
    await query(
      `INSERT INTO customer_meal_plan_meals (
        customer_meal_plan_id, recipe_id, recipe_name, meal_type,
        portions, servings_per_attendee, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        record.id,
        meal.recipe_id || null,
        meal.recipe_name || null,
        meal.meal_type || null,
        toNumberOrZero(meal.portions),
        toNumberOrZero(meal.servings_per_attendee || 1),
        index
      ],
      executor
    );
  }
}

async function replaceQRCodeMealWindows(record = {}, executor = pool) {
  await query('DELETE FROM qr_code_meal_windows WHERE qr_code_id = $1', [record.id], executor);
  const windows = mealWindowRowsFromValue(record.meal_windows);
  for (const [index, window] of windows.entries()) {
    await query(
      `INSERT INTO qr_code_meal_windows (
        qr_code_id, meal_type, label, start_time, end_time, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        record.id,
        window.meal_type || window.key || window.name || null,
        window.label || window.meal_type || null,
        window.start_time || null,
        window.end_time || null,
        index
      ],
      executor
    );
  }
}

async function replaceQRCodeScanHistory(record = {}, executor = pool) {
  await query('DELETE FROM qr_code_scan_history WHERE qr_code_id = $1', [record.id], executor);
  const history = rowJsonArray(record.scan_history);
  for (const [index, scan] of history.entries()) {
    await query(
      `INSERT INTO qr_code_scan_history (
        qr_code_id, scan_key, attendance_record_id, meal_type, session_date,
        site_id, menu_type, menu_category, scanned_at, scanned_by, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.id,
        scan.scan_key || null,
        scan.attendance_record_id || null,
        scan.meal_type || null,
        toDateOnlyOrNull(scan.session_date),
        scan.site_id || null,
        scan.menu_type || null,
        scan.menu_category || null,
        scan.scanned_at || null,
        scan.scanned_by || null,
        index
      ],
      executor
    );
  }
}

async function replaceQRDeliveryRecipients(record = {}, executor = pool) {
  await query('DELETE FROM qr_delivery_recipients WHERE qr_delivery_id = $1', [record.id], executor);
  const recipients = rowJsonArray(record.recipients);
  for (const [index, recipient] of recipients.entries()) {
    await query(
      `INSERT INTO qr_delivery_recipients (
        qr_delivery_id, name, email, phone, category, status, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        record.id,
        recipient.name || null,
        recipient.email || null,
        recipient.phone || null,
        recipient.category || null,
        recipient.status || 'pending',
        index
      ],
      executor
    );
  }

  await query('DELETE FROM qr_delivery_groups WHERE qr_delivery_id = $1', [record.id], executor);
  for (const [index, groupId] of normalizeTextArray(record.group_ids).entries()) {
    await query(
      'INSERT INTO qr_delivery_groups (qr_delivery_id, group_id, sort_order) VALUES ($1,$2,$3)',
      [record.id, groupId, index],
      executor
    );
  }
}

async function replaceUserGroupMembers(record = {}, executor = pool) {
  await query('DELETE FROM user_group_members WHERE user_group_id = $1', [record.id], executor);
  const members = rowJsonArray(record.members);
  for (const [index, member] of members.entries()) {
    await query(
      `INSERT INTO user_group_members (
        user_group_id, name, email, phone, category, status, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        record.id,
        member.name || null,
        member.email || null,
        member.phone || null,
        member.category || null,
        member.status || 'active',
        index
      ],
      executor
    );
  }
}

function documentFieldValue(entry = {}) {
  return metadataValueFromColumns(entry, 'value');
}

function scalarListFromDocumentFieldRows(rows = [], collectionKey) {
  return rowJsonArray(rows)
    .filter((entry) => entry.collection_key === collectionKey)
    .sort((left, right) => (
      Number(left.item_order || 0) - Number(right.item_order || 0)
      || String(left.field_name || '').localeCompare(String(right.field_name || ''))
    ))
    .map(documentFieldValue)
    .filter((value) => value !== null && typeof value !== 'undefined' && value !== '');
}

function objectFromDocumentFieldRows(rows = [], collectionKey) {
  const object = {};
  rowJsonArray(rows)
    .filter((entry) => entry.collection_key === collectionKey)
    .forEach((entry) => {
      const fieldName = entry.field_name || 'value';
      object[fieldName] = documentFieldValue(entry);
    });
  return object;
}

function objectArrayFromDocumentFieldRows(rows = [], collectionKey) {
  const grouped = new Map();
  rowJsonArray(rows)
    .filter((entry) => entry.collection_key === collectionKey)
    .forEach((entry) => {
      const order = Number(entry.item_order || 0);
      const item = grouped.get(order) || {};
      item[entry.field_name || 'value'] = documentFieldValue(entry);
      grouped.set(order, item);
    });
  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, item]) => {
      if (Object.keys(item).length === 1 && Object.prototype.hasOwnProperty.call(item, 'value')) {
        return item.value;
      }
      return item;
    });
}

async function insertDocumentField({
  entity,
  recordId,
  collectionKey,
  itemOrder = 0,
  fieldName = 'value',
  value
}, executor = pool) {
  const columns = metadataWriteColumns(value);
  await query(
    `INSERT INTO document_object_fields (
      entity_name, record_id, collection_key, item_order, field_name,
      value_text, value_numeric, value_boolean, value_date
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entity,
      recordId,
      collectionKey,
      itemOrder,
      fieldName,
      columns.text,
      columns.numeric,
      columns.boolean,
      columns.date
    ],
    executor
  );
}

async function replaceDocumentCollections(entity, recordId, collections = {}, executor = pool) {
  await query(
    'DELETE FROM document_object_fields WHERE entity_name = $1 AND record_id = $2',
    [entity, recordId],
    executor
  );
  for (const [collectionKey, value] of Object.entries(collections || {})) {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          for (const [fieldName, fieldValue] of Object.entries(item)) {
            await insertDocumentField({
              entity,
              recordId,
              collectionKey,
              itemOrder: index,
              fieldName,
              value: fieldValue
            }, executor);
          }
        } else {
          await insertDocumentField({
            entity,
            recordId,
            collectionKey,
            itemOrder: index,
            fieldName: 'value',
            value: item
          }, executor);
        }
      }
    } else if (value && typeof value === 'object') {
      for (const [fieldName, fieldValue] of Object.entries(value)) {
        await insertDocumentField({
          entity,
          recordId,
          collectionKey,
          itemOrder: 0,
          fieldName,
          value: fieldValue
        }, executor);
      }
    } else if (value !== null && typeof value !== 'undefined') {
      await insertDocumentField({
        entity,
        recordId,
        collectionKey,
        itemOrder: 0,
        fieldName: 'value',
        value
      }, executor);
    }
  }
}

async function replaceMaterialRequestItems(record = {}, executor = pool) {
  await query('DELETE FROM material_request_items WHERE material_request_id = $1', [record.id], executor);
  const items = rowJsonArray(record.items);
  for (const [index, item] of items.entries()) {
    const itemResult = await query(
      `INSERT INTO material_request_items (
        material_request_id, ingredient_id, item_code, ingredient_name,
        required_quantity, current_stock, shortage_quantity, request_quantity,
        unit, estimated_cost, live_reservable_quantity, live_shortage_quantity,
        source_line_count, validation_status, repairable_issue_count, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id`,
      [
        record.id,
        item.ingredient_id || null,
        item.item_code || null,
        item.ingredient_name || null,
        toNumberOrZero(item.required_quantity),
        toNumberOrZero(item.current_stock),
        toNumberOrZero(item.shortage_quantity),
        toNumberOrZero(item.request_quantity ?? item.required_quantity),
        item.unit || null,
        toNumberOrZero(item.estimated_cost),
        toNumberOrZero(item.live_reservable_quantity ?? item.current_stock),
        toNumberOrZero(item.live_shortage_quantity),
        Math.max(0, Math.trunc(toNumberOrZero(item.source_line_count))),
        item.validation_status || null,
        Math.max(0, Math.trunc(toNumberOrZero(item.repairable_issue_count))),
        index
      ],
      executor
    );
    const itemId = itemResult.rows[0]?.id;
    for (const [issueIndex, issue] of rowJsonArray(item.validation_issues).entries()) {
      await query(
        `INSERT INTO material_request_item_issues (
          material_request_item_id, code, message, severity, repairable, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          itemId,
          issue.code || null,
          issue.message || null,
          issue.severity || 'warning',
          issue.repairable === true,
          issueIndex
        ],
        executor
      );
    }
  }
}

function rowToERPIntegrationConfig(row = {}) {
  return hydrateDerivedFields('ERPIntegrationConfig', {
    __entity: 'ERPIntegrationConfig',
    id: row.id,
    provider_name: row.provider_name || 'Dynamics 365',
    api_endpoint: row.api_endpoint || null,
    api_key: row.api_key || null,
    sync_schedule: row.sync_schedule || 'manual',
    data_mapping: objectFromDocumentFieldRows(row.field_rows, 'data_mapping'),
    error_notes: row.error_notes || null,
    is_active: row.is_active !== false,
    status: row.status || (row.is_active === false ? 'inactive' : 'active'),
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToERPIntegrationLog(row = {}) {
  const requestRecords = objectArrayFromDocumentFieldRows(row.field_rows, 'request_records');
  const responseRows = objectArrayFromDocumentFieldRows(row.field_rows, 'response_rows');
  const requestExtra = objectFromDocumentFieldRows(row.field_rows, 'request_payload');
  const responseSummary = objectFromDocumentFieldRows(row.field_rows, 'response_summary');
  const requestPayload = {
    ...requestExtra,
    configId: row.request_config_id || row.config_id || null,
    moduleKey: row.request_module_key || row.module_key || null,
    transport: row.request_transport || row.transport || null,
    startDate: row.request_start_date || '',
    endDate: row.request_end_date || '',
    locationId: row.request_location_id || '',
    category: row.request_category || '',
    operation: row.operation || requestExtra.operation || null,
    module_key: row.module_key || requestExtra.module_key || null,
    source_system: row.source_system || requestExtra.source_system || null,
    sync_id: row.sync_id || requestExtra.sync_id || null,
    quantity_semantics: row.quantity_semantics || requestExtra.quantity_semantics || null,
    received_at: rowTimestamp(row.received_at) || requestExtra.received_at || null,
    records: requestRecords
  };
  const responsePayload = {
    summary: responseSummary,
    rows: responseRows
  };
  return hydrateDerivedFields('ERPIntegrationLog', {
    __entity: 'ERPIntegrationLog',
    id: row.id,
    config_id: row.config_id || null,
    provider_name: row.provider_name || null,
    module_key: row.module_key || null,
    operation: row.operation || null,
    direction: row.direction || null,
    transport: row.transport || null,
    status: row.status || 'pending',
    message: row.message || null,
    records_count: toNumberOrZero(row.records_count),
    applied_count: toNumberOrZero(row.applied_count),
    skipped_count: toNumberOrZero(row.skipped_count),
    failed_count: toNumberOrZero(row.failed_count),
    source_system: row.source_system || null,
    sync_id: row.sync_id || null,
    quantity_semantics: row.quantity_semantics || null,
    received_at: rowTimestamp(row.received_at),
    retry_of_log_id: row.retry_of_log_id || null,
    retry_count: toNumberOrZero(row.retry_count),
    retried_at: rowTimestamp(row.retried_at),
    last_retry_status: row.last_retry_status || null,
    last_retry_log_id: row.last_retry_log_id || null,
    last_retry_error: row.last_retry_error || null,
    site_id: row.site_id || null,
    site_ids: normalizeTextArray(row.site_ids),
    attempted_by: row.attempted_by || null,
    attempted_by_name: row.attempted_by_name || null,
    attempted_at: rowTimestamp(row.attempted_at),
    completed_at: rowTimestamp(row.completed_at),
    request_payload: requestPayload,
    response_payload: responsePayload,
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToForecastSnapshot(row = {}) {
  return hydrateDerivedFields('ForecastSnapshot', {
    __entity: 'ForecastSnapshot',
    id: row.id,
    scenario_id: row.scenario_id || null,
    scenario_name: row.scenario_name || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    start_date: row.start_date ? String(row.start_date).slice(0, 10) : null,
    end_date: row.end_date ? String(row.end_date).slice(0, 10) : null,
    forecast_horizon_days: Math.max(1, Math.trunc(toNumberOrZero(row.forecast_horizon_days) || 7)),
    generated_by_id: row.generated_by_id || null,
    generated_by_email: row.generated_by_email || null,
    generated_at: rowTimestamp(row.generated_at),
    forecast_rows: objectArrayFromDocumentFieldRows(row.field_rows, 'forecast_rows'),
    summary: objectFromDocumentFieldRows(row.field_rows, 'summary'),
    chart: objectArrayFromDocumentFieldRows(row.field_rows, 'chart'),
    inventory_coverage: objectArrayFromDocumentFieldRows(row.field_rows, 'inventory_coverage'),
    status: row.status || 'ready',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToBranchOrder(row = {}) {
  return hydrateDerivedFields('BranchOrder', {
    __entity: 'BranchOrder',
    id: row.id,
    order_number: row.order_number || null,
    branch_id: row.branch_id || row.site_id || null,
    branch_name: row.branch_name || row.site_name || null,
    site_id: row.site_id || row.branch_id || null,
    site_name: row.site_name || row.branch_name || null,
    order_date: rowTimestamp(row.order_date) || rowTimestamp(row.created_at),
    required_date: row.required_date ? String(row.required_date).slice(0, 10) : null,
    priority: row.priority || 'medium',
    items: objectArrayFromDocumentFieldRows(row.field_rows, 'items'),
    notes: row.notes || null,
    approved_by: row.approved_by || null,
    approved_at: rowTimestamp(row.approved_at),
    status: row.status || 'draft',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToMaterialRequest(row = {}) {
  const items = rowJsonArray(row.items).map((item) => ({
    ...item,
    validation_issues: rowJsonArray(item.validation_issues)
  }));
  return hydrateDerivedFields('MaterialRequest', {
    __entity: 'MaterialRequest',
    id: row.id,
    request_number: row.request_number || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    requesting_site_id: row.requesting_site_id || null,
    requesting_site_name: row.requesting_site_name || null,
    fulfillment_store_id: row.fulfillment_store_id || null,
    fulfillment_store_name: row.fulfillment_store_name || null,
    request_date: row.request_date ? String(row.request_date).slice(0, 10) : null,
    period_start: row.period_start ? String(row.period_start).slice(0, 10) : null,
    period_end: row.period_end ? String(row.period_end).slice(0, 10) : null,
    items,
    total_estimated_cost: toNumberOrZero(row.total_estimated_cost),
    source_type: row.source_type || 'manual',
    source_production_id: row.source_production_id || null,
    source_production_name: row.source_production_name || null,
    created_by: row.created_by || null,
    created_by_name: row.created_by_name || null,
    acknowledged_by: row.acknowledged_by || null,
    acknowledged_by_name: row.acknowledged_by_name || null,
    acknowledged_at: rowTimestamp(row.acknowledged_at),
    procurement_notes: row.procurement_notes || null,
    notes: row.notes || null,
    status: row.status || 'pending_procurement_ack',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToMenuPlanPRSchedule(row = {}) {
  return hydrateDerivedFields('MenuPlanPRSchedule', {
    __entity: 'MenuPlanPRSchedule',
    id: row.id,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    is_active: row.is_active !== false,
    cycle_days: Math.max(1, Math.trunc(toNumberOrZero(row.cycle_days) || 7)),
    preferred_weekday: row.preferred_weekday || 'thursday',
    notes: row.notes || null,
    status: row.status || (row.is_active === false ? 'inactive' : 'active'),
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToMenuPlanPRRun(row = {}) {
  return hydrateDerivedFields('MenuPlanPRRun', {
    __entity: 'MenuPlanPRRun',
    id: row.id,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    cycle_start: row.cycle_start ? String(row.cycle_start).slice(0, 10) : null,
    cycle_end: row.cycle_end ? String(row.cycle_end).slice(0, 10) : null,
    preferred_run_date: row.preferred_run_date ? String(row.preferred_run_date).slice(0, 10) : null,
    requested_run_date: row.requested_run_date ? String(row.requested_run_date).slice(0, 10) : null,
    cycle_days: Math.max(1, Math.trunc(toNumberOrZero(row.cycle_days) || 7)),
    preferred_weekday: row.preferred_weekday || null,
    trigger_type: row.trigger_type || 'manual',
    generated_pr_id: row.generated_pr_id || null,
    generated_pr_number: row.generated_pr_number || null,
    generated_request_id: row.generated_request_id || null,
    generated_request_number: row.generated_request_number || null,
    generated_item_count: toNumberOrZero(row.generated_item_count),
    total_estimated_cost: toNumberOrZero(row.total_estimated_cost),
    notes: row.notes || null,
    missing_recipe_ids: scalarListFromDocumentFieldRows(row.field_rows, 'missing_recipe_ids'),
    missing_ingredient_ids: scalarListFromDocumentFieldRows(row.field_rows, 'missing_ingredient_ids'),
    status: row.status || 'pending',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToProductionBatch(row = {}) {
  return hydrateDerivedFields('ProductionBatch', {
    __entity: 'ProductionBatch',
    id: row.id,
    batch_number: row.batch_number || null,
    production_id: row.production_id || null,
    recipe_id: row.recipe_id || null,
    recipe_name: row.recipe_name || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    meal_type: row.meal_type || null,
    quantity: toNumberOrZero(row.quantity),
    unit: row.unit || 'servings',
    production_date: row.production_date ? String(row.production_date).slice(0, 10) : null,
    expiry_date: row.expiry_date ? String(row.expiry_date).slice(0, 10) : null,
    process_stage: row.process_stage || 'cleaning',
    qc_status: row.qc_status || 'pending',
    packaging_status: row.packaging_status || 'pending',
    process_logs: objectArrayFromDocumentFieldRows(row.field_rows, 'process_logs'),
    notes: row.notes || null,
    status: row.status || 'planned',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToProductionTransfer(row = {}) {
  return hydrateDerivedFields('ProductionTransfer', {
    __entity: 'ProductionTransfer',
    id: row.id,
    transfer_number: row.transfer_number || null,
    from_site_id: row.from_site_id || null,
    from_site_name: row.from_site_name || null,
    to_site_id: row.to_site_id || null,
    to_site_name: row.to_site_name || null,
    site_id: row.from_site_id || null,
    transfer_date: row.transfer_date ? String(row.transfer_date).slice(0, 10) : null,
    transfer_type: row.transfer_type || 'inventory',
    items: objectArrayFromDocumentFieldRows(row.field_rows, 'items'),
    requested_by: row.requested_by || null,
    received_by: row.received_by || null,
    notes: row.notes || null,
    status: row.status || 'draft',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToPurchaseOrder(row = {}) {
  return hydrateDerivedFields('PurchaseOrder', {
    __entity: 'PurchaseOrder',
    id: row.id,
    po_number: row.po_number || row.order_number || null,
    order_number: row.order_number || row.po_number || null,
    supplier_id: row.supplier_id || null,
    supplier_name: row.supplier_name || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    order_date: row.order_date ? String(row.order_date).slice(0, 10) : null,
    expected_delivery_date: row.expected_delivery_date ? String(row.expected_delivery_date).slice(0, 10) : null,
    total_amount: toNumberOrZero(row.total_amount),
    items: objectArrayFromDocumentFieldRows(row.field_rows, 'items'),
    notes: row.notes || null,
    status: row.status || 'draft',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToQualityControl(row = {}) {
  return hydrateDerivedFields('QualityControl', {
    __entity: 'QualityControl',
    id: row.id,
    batch_id: row.batch_id || null,
    batch_number: row.batch_number || null,
    production_id: row.production_id || null,
    recipe_id: row.recipe_id || null,
    recipe_name: row.recipe_name || null,
    site_id: row.site_id || null,
    site_name: row.site_name || null,
    inspection_date: rowTimestamp(row.inspection_date) || rowTimestamp(row.created_at),
    inspector_name: row.inspector_name || null,
    temperature_logs: objectArrayFromDocumentFieldRows(row.field_rows, 'temperature_logs'),
    hygiene_checklist: objectArrayFromDocumentFieldRows(row.field_rows, 'hygiene_checklist'),
    quality_checklist: objectArrayFromDocumentFieldRows(row.field_rows, 'quality_checklist'),
    overall_status: row.overall_status || null,
    approval_notes: row.approval_notes || null,
    approved_by: row.approved_by || null,
    approved_at: rowTimestamp(row.approved_at),
    status: row.status || 'pending',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function rowToRFQ(row = {}) {
  return hydrateDerivedFields('RFQ', {
    __entity: 'RFQ',
    id: row.id,
    rfq_number: row.rfq_number || null,
    issue_date: row.issue_date ? String(row.issue_date).slice(0, 10) : null,
    response_deadline: row.response_deadline ? String(row.response_deadline).slice(0, 10) : null,
    suppliers: scalarListFromDocumentFieldRows(row.field_rows, 'suppliers'),
    items: objectArrayFromDocumentFieldRows(row.field_rows, 'items'),
    notes: row.notes || null,
    status: row.status || 'draft',
    source_name: row.source_name || null,
    created_date: rowTimestamp(row.created_at),
    updated_date: rowTimestamp(row.updated_at)
  });
}

function documentFieldRowsSelect(entity, aliasName = 'record') {
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'collection_key', field.collection_key,
      'item_order', field.item_order,
      'field_name', field.field_name,
      'value_text', field.value_text,
      'value_numeric', field.value_numeric,
      'value_boolean', field.value_boolean,
      'value_date', field.value_date
    ) ORDER BY field.collection_key, field.item_order, field.field_name, field.id)
    FROM document_object_fields field
    WHERE field.entity_name = '${entity}' AND field.record_id = ${aliasName}.id
  ), '[]'::jsonb) AS field_rows`;
}

const normalizedSimpleConfigs = {
  ERPIntegrationConfig: {
    table: 'erp_integration_configs',
    idColumn: 'id',
    mapper: rowToERPIntegrationConfig,
    select: `SELECT record.*, ${documentFieldRowsSelect('ERPIntegrationConfig', 'record')} FROM erp_integration_configs record`,
    insertSql: `INSERT INTO erp_integration_configs (
      id, provider_name, api_endpoint, api_key, sync_schedule,
      error_notes, is_active, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    values(record) {
      const isActive = record.is_active !== false;
      return [
        record.id,
        record.provider_name || 'Dynamics 365',
        record.api_endpoint || null,
        record.api_key || null,
        record.sync_schedule || 'manual',
        record.error_notes || null,
        isActive,
        record.status || (isActive ? 'active' : 'inactive'),
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE erp_integration_configs SET
      provider_name = $2, api_endpoint = $3, api_key = $4,
      sync_schedule = $5, error_notes = $6, is_active = $7,
      status = $8, source_name = $9, updated_at = $10
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 9), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('ERPIntegrationConfig', record.id, {
      data_mapping: record.data_mapping || {}
    }, executor)
  },
  ERPIntegrationLog: {
    table: 'erp_integration_logs',
    idColumn: 'id',
    mapper: rowToERPIntegrationLog,
    select: `SELECT record.*, ${documentFieldRowsSelect('ERPIntegrationLog', 'record')} FROM erp_integration_logs record`,
    insertSql: `INSERT INTO erp_integration_logs (
      id, config_id, provider_name, module_key, operation, direction, transport,
      status, message, records_count, applied_count, skipped_count, failed_count,
      source_system, sync_id, quantity_semantics, received_at, retry_of_log_id,
      retry_count, retried_at, last_retry_status, last_retry_log_id, last_retry_error,
      site_id, site_ids, attempted_by, attempted_by_name, attempted_at, completed_at,
      request_config_id, request_module_key, request_transport, request_start_date,
      request_end_date, request_location_id, request_category, source_name,
      created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24,$25::text[],$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39
    )`,
    values(record) {
      const requestPayload = rowJsonObject(record.request_payload);
      const responseSummary = rowJsonObject(record.response_payload?.summary);
      const appliedCount = toNumberOrZero(record.applied_count ?? responseSummary.applied_rows);
      const skippedCount = toNumberOrZero(record.skipped_count ?? responseSummary.skipped_rows);
      const failedCount = toNumberOrZero(record.failed_count ?? responseSummary.failed_rows);
      return [
        record.id,
        record.config_id || null,
        record.provider_name || null,
        record.module_key || requestPayload.moduleKey || requestPayload.module_key || null,
        record.operation || requestPayload.operation || null,
        record.direction || null,
        record.transport || requestPayload.transport || null,
        record.status || 'pending',
        record.message || null,
        toNumberOrZero(record.records_count),
        appliedCount,
        skippedCount,
        failedCount,
        record.source_system || requestPayload.source_system || null,
        record.sync_id || requestPayload.sync_id || null,
        record.quantity_semantics || requestPayload.quantity_semantics || null,
        record.received_at || requestPayload.received_at || null,
        record.retry_of_log_id || null,
        Math.max(0, Math.trunc(toNumberOrZero(record.retry_count))),
        record.retried_at || null,
        record.last_retry_status || null,
        record.last_retry_log_id || null,
        record.last_retry_error || null,
        record.site_id || null,
        normalizeTextArray(record.site_ids),
        record.attempted_by || null,
        record.attempted_by_name || null,
        record.attempted_at || record.created_date || nowIso(),
        record.completed_at || null,
        requestPayload.configId || record.config_id || null,
        requestPayload.moduleKey || record.module_key || null,
        requestPayload.transport || record.transport || null,
        toDateOnlyOrNull(requestPayload.startDate),
        toDateOnlyOrNull(requestPayload.endDate),
        requestPayload.locationId || null,
        requestPayload.category || null,
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE erp_integration_logs SET
      config_id = $2, provider_name = $3, module_key = $4, operation = $5,
      direction = $6, transport = $7, status = $8, message = $9,
      records_count = $10, applied_count = $11, skipped_count = $12,
      failed_count = $13, source_system = $14, sync_id = $15,
      quantity_semantics = $16, received_at = $17, retry_of_log_id = $18,
      retry_count = $19, retried_at = $20, last_retry_status = $21,
      last_retry_log_id = $22, last_retry_error = $23, site_id = $24,
      site_ids = $25::text[], attempted_by = $26, attempted_by_name = $27,
      attempted_at = $28, completed_at = $29, request_config_id = $30,
      request_module_key = $31, request_transport = $32, request_start_date = $33,
      request_end_date = $34, request_location_id = $35, request_category = $36,
      source_name = $37, updated_at = $38
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 37), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('ERPIntegrationLog', record.id, {
      request_payload: {
        operation: record.request_payload?.operation || record.operation || null,
        module_key: record.request_payload?.module_key || record.module_key || null,
        source_system: record.request_payload?.source_system || record.source_system || null,
        sync_id: record.request_payload?.sync_id || record.sync_id || null,
        quantity_semantics: record.request_payload?.quantity_semantics || record.quantity_semantics || null,
        received_at: record.request_payload?.received_at || record.received_at || null
      },
      request_records: rowJsonArray(record.request_payload?.records),
      response_summary: record.response_payload?.summary || {},
      response_rows: rowJsonArray(record.response_payload?.rows)
    }, executor)
  },
  ForecastSnapshot: {
    table: 'forecast_snapshots',
    idColumn: 'id',
    mapper: rowToForecastSnapshot,
    select: `SELECT record.*, ${documentFieldRowsSelect('ForecastSnapshot', 'record')} FROM forecast_snapshots record`,
    insertSql: `INSERT INTO forecast_snapshots (
      id, scenario_id, scenario_name, site_id, site_name, start_date, end_date,
      forecast_horizon_days, generated_by_id, generated_by_email, generated_at,
      status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    values(record) {
      return [
        record.id,
        record.scenario_id || null,
        record.scenario_name || null,
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.start_date),
        toDateOnlyOrNull(record.end_date),
        Math.max(1, Math.trunc(toNumberOrZero(record.forecast_horizon_days) || 7)),
        record.generated_by_id || null,
        record.generated_by_email || null,
        record.generated_at || record.created_date || nowIso(),
        record.status || 'ready',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE forecast_snapshots SET
      scenario_id = $2, scenario_name = $3, site_id = $4, site_name = $5,
      start_date = $6, end_date = $7, forecast_horizon_days = $8,
      generated_by_id = $9, generated_by_email = $10, generated_at = $11,
      status = $12, source_name = $13, updated_at = $14
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 13), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('ForecastSnapshot', record.id, {
      forecast_rows: rowJsonArray(record.forecast_rows),
      summary: record.summary || {},
      chart: rowJsonArray(record.chart),
      inventory_coverage: rowJsonArray(record.inventory_coverage)
    }, executor)
  },
  BranchOrder: {
    table: 'branch_orders',
    idColumn: 'id',
    mapper: rowToBranchOrder,
    select: `SELECT record.*, ${documentFieldRowsSelect('BranchOrder', 'record')} FROM branch_orders record`,
    insertSql: `INSERT INTO branch_orders (
      id, order_number, branch_id, branch_name, site_id, site_name,
      order_date, required_date, priority, notes, approved_by, approved_at,
      status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    values(record) {
      return [
        record.id,
        record.order_number || null,
        record.branch_id || record.site_id || null,
        record.branch_name || record.site_name || null,
        record.site_id || record.branch_id || null,
        record.site_name || record.branch_name || null,
        record.order_date || record.created_date || nowIso(),
        toDateOnlyOrNull(record.required_date),
        record.priority || 'medium',
        record.notes || null,
        record.approved_by || null,
        record.approved_at || null,
        record.status || 'draft',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE branch_orders SET
      order_number = $2, branch_id = $3, branch_name = $4, site_id = $5,
      site_name = $6, order_date = $7, required_date = $8, priority = $9,
      notes = $10, approved_by = $11, approved_at = $12, status = $13,
      source_name = $14, updated_at = $15
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 14), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('BranchOrder', record.id, {
      items: rowJsonArray(record.items)
    }, executor)
  },
  MaterialRequest: {
    table: 'material_requests',
    idColumn: 'id',
    mapper: rowToMaterialRequest,
    select: `SELECT request.*,
                    COALESCE(item_rows.items, '[]'::jsonb) AS items
               FROM material_requests request
               LEFT JOIN (
                 SELECT item.material_request_id,
                        jsonb_agg(jsonb_build_object(
                          'id', item.id,
                          'ingredient_id', item.ingredient_id,
                          'item_code', item.item_code,
                          'ingredient_name', item.ingredient_name,
                          'required_quantity', item.required_quantity,
                          'current_stock', item.current_stock,
                          'shortage_quantity', item.shortage_quantity,
                          'request_quantity', item.request_quantity,
                          'unit', item.unit,
                          'estimated_cost', item.estimated_cost,
                          'live_reservable_quantity', item.live_reservable_quantity,
                          'live_shortage_quantity', item.live_shortage_quantity,
                          'source_line_count', item.source_line_count,
                          'validation_status', item.validation_status,
                          'repairable_issue_count', item.repairable_issue_count,
                          'validation_issues', COALESCE(issue_rows.issues, '[]'::jsonb)
                        ) ORDER BY item.sort_order, item.id) AS items
                   FROM material_request_items item
                   LEFT JOIN (
                     SELECT material_request_item_id,
                            jsonb_agg(jsonb_build_object(
                              'code', code,
                              'message', message,
                              'severity', severity,
                              'repairable', repairable
                            ) ORDER BY sort_order, id) AS issues
                       FROM material_request_item_issues
                      GROUP BY material_request_item_id
                   ) issue_rows ON issue_rows.material_request_item_id = item.id
                  GROUP BY item.material_request_id
               ) item_rows ON item_rows.material_request_id = request.id`,
    insertSql: `INSERT INTO material_requests (
      id, request_number, site_id, site_name, requesting_site_id, requesting_site_name,
      fulfillment_store_id, fulfillment_store_name, request_date, period_start, period_end,
      total_estimated_cost, source_type, source_production_id, source_production_name,
      created_by, created_by_name, acknowledged_by, acknowledged_by_name, acknowledged_at,
      procurement_notes, notes, status, source_name, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
    )`,
    values(record) {
      return [
        record.id,
        record.request_number || null,
        record.site_id || null,
        record.site_name || null,
        record.requesting_site_id || null,
        record.requesting_site_name || null,
        record.fulfillment_store_id || null,
        record.fulfillment_store_name || null,
        toDateOnlyOrNull(record.request_date) || dateOnlyOffset(0),
        toDateOnlyOrNull(record.period_start),
        toDateOnlyOrNull(record.period_end),
        toNumberOrZero(record.total_estimated_cost),
        record.source_type || 'manual',
        record.source_production_id || null,
        record.source_production_name || null,
        record.created_by || null,
        record.created_by_name || null,
        record.acknowledged_by || null,
        record.acknowledged_by_name || null,
        record.acknowledged_at || null,
        record.procurement_notes || null,
        record.notes || null,
        record.status || 'pending_procurement_ack',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE material_requests SET
      request_number = $2, site_id = $3, site_name = $4,
      requesting_site_id = $5, requesting_site_name = $6,
      fulfillment_store_id = $7, fulfillment_store_name = $8,
      request_date = $9, period_start = $10, period_end = $11,
      total_estimated_cost = $12, source_type = $13,
      source_production_id = $14, source_production_name = $15,
      created_by = $16, created_by_name = $17, acknowledged_by = $18,
      acknowledged_by_name = $19, acknowledged_at = $20,
      procurement_notes = $21, notes = $22, status = $23,
      source_name = $24, updated_at = $25
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 24), record.updated_date || nowIso()];
    },
    afterSave: replaceMaterialRequestItems
  },
  MenuPlanPRSchedule: {
    table: 'menu_plan_pr_schedules',
    idColumn: 'id',
    mapper: rowToMenuPlanPRSchedule,
    select: 'SELECT * FROM menu_plan_pr_schedules',
    insertSql: `INSERT INTO menu_plan_pr_schedules (
      id, site_id, site_name, is_active, cycle_days, preferred_weekday,
      notes, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    values(record) {
      const isActive = record.is_active !== false;
      return [
        record.id,
        record.site_id || null,
        record.site_name || null,
        isActive,
        Math.max(1, Math.trunc(toNumberOrZero(record.cycle_days) || 7)),
        record.preferred_weekday || 'thursday',
        record.notes || null,
        record.status || (isActive ? 'active' : 'inactive'),
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE menu_plan_pr_schedules SET
      site_id = $2, site_name = $3, is_active = $4,
      cycle_days = $5, preferred_weekday = $6, notes = $7,
      status = $8, source_name = $9, updated_at = $10
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 9), record.updated_date || nowIso()];
    }
  },
  MenuPlanPRRun: {
    table: 'menu_plan_pr_runs',
    idColumn: 'id',
    mapper: rowToMenuPlanPRRun,
    select: `SELECT record.*, ${documentFieldRowsSelect('MenuPlanPRRun', 'record')} FROM menu_plan_pr_runs record`,
    insertSql: `INSERT INTO menu_plan_pr_runs (
      id, site_id, site_name, cycle_start, cycle_end, preferred_run_date,
      requested_run_date, cycle_days, preferred_weekday, trigger_type,
      generated_pr_id, generated_pr_number, generated_request_id,
      generated_request_number, generated_item_count, total_estimated_cost,
      notes, status, source_name, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
    )`,
    values(record) {
      return [
        record.id,
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.cycle_start),
        toDateOnlyOrNull(record.cycle_end),
        toDateOnlyOrNull(record.preferred_run_date),
        toDateOnlyOrNull(record.requested_run_date),
        Math.max(1, Math.trunc(toNumberOrZero(record.cycle_days) || 7)),
        record.preferred_weekday || null,
        record.trigger_type || 'manual',
        record.generated_pr_id || null,
        record.generated_pr_number || null,
        record.generated_request_id || null,
        record.generated_request_number || null,
        Math.max(0, Math.trunc(toNumberOrZero(record.generated_item_count))),
        toNumberOrZero(record.total_estimated_cost),
        record.notes || null,
        record.status || 'pending',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE menu_plan_pr_runs SET
      site_id = $2, site_name = $3, cycle_start = $4,
      cycle_end = $5, preferred_run_date = $6, requested_run_date = $7,
      cycle_days = $8, preferred_weekday = $9, trigger_type = $10,
      generated_pr_id = $11, generated_pr_number = $12,
      generated_request_id = $13, generated_request_number = $14,
      generated_item_count = $15, total_estimated_cost = $16,
      notes = $17, status = $18, source_name = $19, updated_at = $20
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 19), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('MenuPlanPRRun', record.id, {
      missing_recipe_ids: rowJsonArray(record.missing_recipe_ids),
      missing_ingredient_ids: rowJsonArray(record.missing_ingredient_ids)
    }, executor)
  },
  ProductionBatch: {
    table: 'production_batches',
    idColumn: 'id',
    mapper: rowToProductionBatch,
    select: `SELECT record.*, ${documentFieldRowsSelect('ProductionBatch', 'record')} FROM production_batches record`,
    insertSql: `INSERT INTO production_batches (
      id, batch_number, production_id, recipe_id, recipe_name, site_id,
      site_name, meal_type, quantity, unit, production_date, expiry_date,
      process_stage, qc_status, packaging_status, notes, status,
      source_name, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
    )`,
    values(record) {
      return [
        record.id,
        record.batch_number || null,
        record.production_id || null,
        record.recipe_id || null,
        record.recipe_name || null,
        record.site_id || null,
        record.site_name || null,
        record.meal_type || null,
        toNumberOrZero(record.quantity),
        record.unit || 'servings',
        toDateOnlyOrNull(record.production_date),
        toDateOnlyOrNull(record.expiry_date),
        record.process_stage || 'cleaning',
        record.qc_status || 'pending',
        record.packaging_status || 'pending',
        record.notes || null,
        record.status || 'planned',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE production_batches SET
      batch_number = $2, production_id = $3, recipe_id = $4,
      recipe_name = $5, site_id = $6, site_name = $7, meal_type = $8,
      quantity = $9, unit = $10, production_date = $11, expiry_date = $12,
      process_stage = $13, qc_status = $14, packaging_status = $15,
      notes = $16, status = $17, source_name = $18, updated_at = $19
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 18), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('ProductionBatch', record.id, {
      process_logs: rowJsonArray(record.process_logs)
    }, executor)
  },
  ProductionTransfer: {
    table: 'production_transfers',
    idColumn: 'id',
    mapper: rowToProductionTransfer,
    select: `SELECT record.*, ${documentFieldRowsSelect('ProductionTransfer', 'record')} FROM production_transfers record`,
    insertSql: `INSERT INTO production_transfers (
      id, transfer_number, from_site_id, from_site_name, to_site_id,
      to_site_name, site_id, transfer_date, transfer_type, requested_by,
      received_by, notes, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    values(record) {
      const fromSiteId = record.from_site_id || record.site_id || null;
      return [
        record.id,
        record.transfer_number || null,
        fromSiteId,
        record.from_site_name || null,
        record.to_site_id || null,
        record.to_site_name || null,
        record.site_id || fromSiteId,
        toDateOnlyOrNull(record.transfer_date),
        record.transfer_type || 'inventory',
        record.requested_by || null,
        record.received_by || null,
        record.notes || null,
        record.status || 'draft',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE production_transfers SET
      transfer_number = $2, from_site_id = $3, from_site_name = $4,
      to_site_id = $5, to_site_name = $6, site_id = $7,
      transfer_date = $8, transfer_type = $9, requested_by = $10,
      received_by = $11, notes = $12, status = $13,
      source_name = $14, updated_at = $15
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 14), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('ProductionTransfer', record.id, {
      items: rowJsonArray(record.items)
    }, executor)
  },
  PurchaseOrder: {
    table: 'purchase_order_documents',
    idColumn: 'id',
    mapper: rowToPurchaseOrder,
    select: `SELECT record.*, ${documentFieldRowsSelect('PurchaseOrder', 'record')} FROM purchase_order_documents record`,
    insertSql: `INSERT INTO purchase_order_documents (
      id, po_number, order_number, supplier_id, supplier_name, site_id,
      site_name, order_date, expected_delivery_date, total_amount,
      notes, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    values(record) {
      const orderNumber = record.order_number || record.po_number || null;
      return [
        record.id,
        record.po_number || orderNumber,
        orderNumber,
        record.supplier_id || null,
        record.supplier_name || null,
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.order_date) || dateOnlyOffset(0),
        toDateOnlyOrNull(record.expected_delivery_date),
        toNumberOrZero(record.total_amount),
        record.notes || null,
        record.status || 'draft',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE purchase_order_documents SET
      po_number = $2, order_number = $3, supplier_id = $4,
      supplier_name = $5, site_id = $6, site_name = $7,
      order_date = $8, expected_delivery_date = $9, total_amount = $10,
      notes = $11, status = $12, source_name = $13, updated_at = $14
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 13), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('PurchaseOrder', record.id, {
      items: rowJsonArray(record.items)
    }, executor)
  },
  QualityControl: {
    table: 'quality_controls',
    idColumn: 'id',
    mapper: rowToQualityControl,
    select: `SELECT record.*, ${documentFieldRowsSelect('QualityControl', 'record')} FROM quality_controls record`,
    insertSql: `INSERT INTO quality_controls (
      id, batch_id, batch_number, production_id, recipe_id, recipe_name,
      site_id, site_name, inspection_date, inspector_name, overall_status,
      approval_notes, approved_by, approved_at, status, source_name,
      created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
    )`,
    values(record) {
      return [
        record.id,
        record.batch_id || null,
        record.batch_number || null,
        record.production_id || null,
        record.recipe_id || null,
        record.recipe_name || null,
        record.site_id || null,
        record.site_name || null,
        record.inspection_date || record.created_date || nowIso(),
        record.inspector_name || null,
        record.overall_status || null,
        record.approval_notes || null,
        record.approved_by || null,
        record.approved_at || null,
        record.status || 'pending',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE quality_controls SET
      batch_id = $2, batch_number = $3, production_id = $4,
      recipe_id = $5, recipe_name = $6, site_id = $7,
      site_name = $8, inspection_date = $9, inspector_name = $10,
      overall_status = $11, approval_notes = $12, approved_by = $13,
      approved_at = $14, status = $15, source_name = $16,
      updated_at = $17
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 16), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('QualityControl', record.id, {
      temperature_logs: rowJsonArray(record.temperature_logs),
      hygiene_checklist: rowJsonArray(record.hygiene_checklist),
      quality_checklist: rowJsonArray(record.quality_checklist)
    }, executor)
  },
  RFQ: {
    table: 'rfqs',
    idColumn: 'id',
    mapper: rowToRFQ,
    select: `SELECT record.*, ${documentFieldRowsSelect('RFQ', 'record')} FROM rfqs record`,
    insertSql: `INSERT INTO rfqs (
      id, rfq_number, issue_date, response_deadline, notes,
      status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values(record) {
      return [
        record.id,
        record.rfq_number || null,
        toDateOnlyOrNull(record.issue_date) || dateOnlyOffset(0),
        toDateOnlyOrNull(record.response_deadline),
        record.notes || null,
        record.status || 'draft',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE rfqs SET
      rfq_number = $2, issue_date = $3, response_deadline = $4,
      notes = $5, status = $6, source_name = $7, updated_at = $8
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 7), record.updated_date || nowIso()];
    },
    afterSave: (record, executor) => replaceDocumentCollections('RFQ', record.id, {
      suppliers: rowJsonArray(record.suppliers),
      items: rowJsonArray(record.items)
    }, executor)
  },
  AttendanceSession: {
    table: 'attendance_sessions',
    idColumn: 'id',
    mapper: rowToAttendanceSession,
    select: 'SELECT * FROM attendance_sessions',
    insertSql: `INSERT INTO attendance_sessions (
      id, session_name, title, site_id, site_name, meal_type, session_date,
      start_time, end_time, qr_token, qr_expiry, expected_labor,
      expected_junior, expected_senior, actual_labor, actual_junior,
      actual_senior, validity_minutes, notes, status, source_name,
      created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
    )`,
    values(record) {
      return [
        record.id,
        record.session_name || record.title || 'Attendance Session',
        record.title || record.session_name || 'Attendance Session',
        record.site_id || null,
        record.site_name || null,
        record.meal_type || null,
        toDateOnlyOrNull(record.session_date),
        record.start_time || null,
        record.end_time || null,
        record.qr_token || null,
        record.qr_expiry || null,
        toNumberOrZero(record.expected_labor),
        toNumberOrZero(record.expected_junior),
        toNumberOrZero(record.expected_senior),
        toNumberOrZero(record.actual_labor),
        toNumberOrZero(record.actual_junior),
        toNumberOrZero(record.actual_senior),
        Math.max(0, Math.trunc(toNumberOrZero(record.validity_minutes))),
        record.notes || null,
        record.status || 'active',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE attendance_sessions SET
      session_name = $2, title = $3, site_id = $4, site_name = $5,
      meal_type = $6, session_date = $7, start_time = $8, end_time = $9,
      qr_token = $10, qr_expiry = $11, expected_labor = $12,
      expected_junior = $13, expected_senior = $14, actual_labor = $15,
      actual_junior = $16, actual_senior = $17, validity_minutes = $18,
      notes = $19, status = $20, source_name = $21, updated_at = $22
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 21), record.updated_date || nowIso()];
    }
  },
  CategoryQRSession: {
    table: 'category_qr_sessions',
    idColumn: 'id',
    mapper: rowToCategoryQRSession,
    select: `SELECT session.*,
                    COALESCE(category_rows.categories, '[]'::jsonb) AS categories
               FROM category_qr_sessions session
               LEFT JOIN (
                 SELECT session_id,
                        jsonb_agg(jsonb_build_object(
                          'category', category,
                          'label', label,
                          'token', token,
                          'scan_count', scan_count
                        ) ORDER BY sort_order, id) AS categories
                   FROM category_qr_session_categories
                  GROUP BY session_id
               ) category_rows ON category_rows.session_id = session.id`,
    insertSql: `INSERT INTO category_qr_sessions (
      id, title, site_id, site_name, session_date, from_date, to_date,
      start_time, end_time, notes, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    values(record) {
      const sessionDate = toDateOnlyOrNull(record.session_date || record.from_date || record.date);
      return [
        record.id,
        record.title || 'Category QR Session',
        record.site_id || null,
        record.site_name || null,
        sessionDate,
        toDateOnlyOrNull(record.from_date || sessionDate),
        toDateOnlyOrNull(record.to_date || sessionDate),
        record.start_time || null,
        record.end_time || null,
        record.notes || null,
        record.status || 'active',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE category_qr_sessions SET
      title = $2, site_id = $3, site_name = $4, session_date = $5,
      from_date = $6, to_date = $7, start_time = $8, end_time = $9,
      notes = $10, status = $11, source_name = $12, updated_at = $13
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 12), record.updated_date || nowIso()];
    },
    afterSave: replaceCategoryQRSessionCategories
  },
  DinerScan: {
    table: 'diner_scans',
    idColumn: 'id',
    mapper: rowToDinerScan,
    select: 'SELECT * FROM diner_scans',
    insertSql: `INSERT INTO diner_scans (
      id, event_id, event_name, event_qr_token, site_id, site_name,
      plan_date, meal_type, guest_token, scan_method, scanned_at,
      status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    values(record) {
      return [
        record.id,
        record.event_id || null,
        record.event_name || null,
        record.event_qr_token || null,
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.plan_date),
        record.meal_type || null,
        record.guest_token || null,
        record.scan_method || null,
        record.scanned_at || record.created_date || nowIso(),
        record.status || 'scanned',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE diner_scans SET
      event_id = $2, event_name = $3, event_qr_token = $4, site_id = $5,
      site_name = $6, plan_date = $7, meal_type = $8, guest_token = $9,
      scan_method = $10, scanned_at = $11, status = $12,
      source_name = $13, updated_at = $14
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 13), record.updated_date || nowIso()];
    }
  },
  CustomerMealPlan: {
    table: 'customer_meal_plans',
    idColumn: 'id',
    mapper: rowToCustomerMealPlan,
    select: `SELECT plan.*,
                    COALESCE(meal_rows.meals, '[]'::jsonb) AS meals
               FROM customer_meal_plans plan
               LEFT JOIN (
                 SELECT customer_meal_plan_id,
                        jsonb_agg(jsonb_build_object(
                          'recipe_id', recipe_id,
                          'recipe_name', recipe_name,
                          'meal_type', meal_type,
                          'portions', portions,
                          'servings_per_attendee', servings_per_attendee
                        ) ORDER BY sort_order, id) AS meals
                   FROM customer_meal_plan_meals
                  GROUP BY customer_meal_plan_id
               ) meal_rows ON meal_rows.customer_meal_plan_id = plan.id`,
    insertSql: `INSERT INTO customer_meal_plans (
      id, name, site_id, site_name, plan_date, customer_id, customer_name,
      notes, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    values(record) {
      return [
        record.id,
        record.name || 'Customer Meal Plan',
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.plan_date),
        record.customer_id || null,
        record.customer_name || null,
        record.notes || null,
        record.status || 'draft',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE customer_meal_plans SET
      name = $2, site_id = $3, site_name = $4, plan_date = $5,
      customer_id = $6, customer_name = $7, notes = $8, status = $9,
      source_name = $10, updated_at = $11
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 10), record.updated_date || nowIso()];
    },
    afterSave: replaceCustomerMealPlanMeals
  },
  QRCode: {
    table: 'qr_codes',
    idColumn: 'id',
    mapper: rowToQRCode,
    select: `SELECT qr_code.*,
                    COALESCE(window_rows.meal_windows, '[]'::jsonb) AS meal_windows,
                    COALESCE(history_rows.scan_history, '[]'::jsonb) AS scan_history
               FROM qr_codes qr_code
               LEFT JOIN (
                 SELECT qr_code_id,
                        jsonb_agg(jsonb_build_object(
                          'meal_type', meal_type,
                          'label', label,
                          'start_time', start_time,
                          'end_time', end_time
                        ) ORDER BY sort_order, id) AS meal_windows
                   FROM qr_code_meal_windows
                  GROUP BY qr_code_id
               ) window_rows ON window_rows.qr_code_id = qr_code.id
               LEFT JOIN (
                 SELECT qr_code_id,
                        jsonb_agg(jsonb_build_object(
                          'scan_key', scan_key,
                          'attendance_record_id', attendance_record_id,
                          'meal_type', meal_type,
                          'session_date', session_date,
                          'site_id', site_id,
                          'menu_type', menu_type,
                          'menu_category', menu_category,
                          'scanned_at', scanned_at,
                          'scanned_by', scanned_by
                        ) ORDER BY sort_order, id) AS scan_history
                   FROM qr_code_scan_history
                  GROUP BY qr_code_id
               ) history_rows ON history_rows.qr_code_id = qr_code.id`,
    insertSql: `INSERT INTO qr_codes (
      id, title, name, category, description, token, linked_item,
      is_one_time, max_scans, scan_count, expiry_date, last_scanned_at,
      employee_name, company_id_number, mobile_number, active_whatsapp,
      created_by, created_by_name, status, source_name, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
    )`,
    values(record) {
      const title = record.title || record.name || record.employee_name || 'QR Code';
      return [
        record.id,
        title,
        record.name || title,
        record.category || null,
        record.description || null,
        record.token || null,
        record.linked_item || null,
        record.is_one_time === true || record.one_time === true,
        Math.max(0, Math.trunc(toNumberOrZero(record.max_scans))),
        Math.max(0, Math.trunc(toNumberOrZero(record.scan_count))),
        record.expiry_date || record.exp || null,
        record.last_scanned_at || null,
        record.employee_name || null,
        record.company_id_number || null,
        record.mobile_number || null,
        record.active_whatsapp === true,
        record.created_by || null,
        record.created_by_name || null,
        record.status || 'active',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE qr_codes SET
      title = $2, name = $3, category = $4, description = $5,
      token = $6, linked_item = $7, is_one_time = $8, max_scans = $9,
      scan_count = $10, expiry_date = $11, last_scanned_at = $12,
      employee_name = $13, company_id_number = $14, mobile_number = $15,
      active_whatsapp = $16, created_by = $17, created_by_name = $18,
      status = $19, source_name = $20, updated_at = $21
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 20), record.updated_date || nowIso()];
    },
    afterSave: async (record, executor) => {
      await replaceQRCodeMealWindows(record, executor);
      await replaceQRCodeScanHistory(record, executor);
    }
  },
  QRDelivery: {
    table: 'qr_deliveries',
    idColumn: 'id',
    mapper: rowToQRDelivery,
    select: `SELECT delivery.*,
                    COALESCE(recipient_rows.recipients, '[]'::jsonb) AS recipients,
                    COALESCE(group_rows.group_ids, ARRAY[]::text[]) AS group_ids
               FROM qr_deliveries delivery
               LEFT JOIN (
                 SELECT qr_delivery_id,
                        jsonb_agg(jsonb_build_object(
                          'name', name,
                          'email', email,
                          'phone', phone,
                          'category', category,
                          'status', status
                        ) ORDER BY sort_order, id) AS recipients
                   FROM qr_delivery_recipients
                  GROUP BY qr_delivery_id
               ) recipient_rows ON recipient_rows.qr_delivery_id = delivery.id
               LEFT JOIN (
                 SELECT qr_delivery_id,
                        ARRAY_AGG(group_id ORDER BY sort_order, id) AS group_ids
                   FROM qr_delivery_groups
                  GROUP BY qr_delivery_id
               ) group_rows ON group_rows.qr_delivery_id = delivery.id`,
    insertSql: `INSERT INTO qr_deliveries (
      id, qr_code_id, qr_code_title, qr_token, delivery_method, subject,
      message, scheduled_at, sent_at, sent_count, failed_count, status,
      source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    values(record) {
      return [
        record.id,
        record.qr_code_id || null,
        record.qr_code_title || null,
        record.qr_token || null,
        record.delivery_method || 'email',
        record.subject || null,
        record.message || null,
        record.scheduled_at || null,
        record.sent_at || null,
        Math.max(0, Math.trunc(toNumberOrZero(record.sent_count))),
        Math.max(0, Math.trunc(toNumberOrZero(record.failed_count))),
        record.status || 'pending',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE qr_deliveries SET
      qr_code_id = $2, qr_code_title = $3, qr_token = $4,
      delivery_method = $5, subject = $6, message = $7,
      scheduled_at = $8, sent_at = $9, sent_count = $10,
      failed_count = $11, status = $12, source_name = $13,
      updated_at = $14
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 13), record.updated_date || nowIso()];
    },
    afterSave: replaceQRDeliveryRecipients
  },
  UserGroup: {
    table: 'user_groups',
    idColumn: 'id',
    mapper: rowToUserGroup,
    select: `SELECT group_record.*,
                    COALESCE(member_rows.members, '[]'::jsonb) AS members
               FROM user_groups group_record
               LEFT JOIN (
                 SELECT user_group_id,
                        jsonb_agg(jsonb_build_object(
                          'name', name,
                          'email', email,
                          'phone', phone,
                          'category', category,
                          'status', status
                        ) ORDER BY sort_order, id) AS members
                   FROM user_group_members
                  GROUP BY user_group_id
               ) member_rows ON member_rows.user_group_id = group_record.id`,
    insertSql: `INSERT INTO user_groups (
      id, name, description, total_members, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    values(record) {
      const members = rowJsonArray(record.members);
      return [
        record.id,
        record.name || 'User Group',
        record.description || null,
        Math.max(0, Math.trunc(toNumberOrZero(record.total_members) || members.length)),
        record.status || 'active',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE user_groups SET
      name = $2, description = $3, total_members = $4, status = $5,
      source_name = $6, updated_at = $7
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 6), record.updated_date || nowIso()];
    },
    afterSave: replaceUserGroupMembers
  },
  AttendanceRecord: {
    table: 'attendance_records',
    idColumn: 'id',
    mapper: rowToAttendanceRecord,
    select: 'SELECT * FROM attendance_records',
    insertSql: `INSERT INTO attendance_records (
      id, shift_id, session_id, session_name, site_id, site_name, shift_date,
      attendance_date, session_date, service_date, meal_type, menu_type, menu_category,
      employee_id, employee_name, attendee_id, attendee_name, attendee_phone,
      category, check_in, check_out, check_in_at, check_out_at, marked_at,
      scan_method, qr_code_id, scanned_by, scanned_by_name, attendance_status,
      approval_status, status, notes, source_name, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
    )`,
    values(record) {
      const markedAt = record.marked_at || record.check_in_at || record.created_date || nowIso();
      const attendanceDate = toDateOnlyOrNull(
        record.attendance_date
        || record.session_date
        || record.service_date
        || record.shift_date
        || markedAt
      );
      const attendeeId = record.attendee_id || record.employee_id || null;
      const attendeeName = record.attendee_name || record.employee_name || null;
      return [
        record.id,
        record.shift_id || null,
        record.session_id || null,
        record.session_name || null,
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.shift_date),
        attendanceDate,
        toDateOnlyOrNull(record.session_date || attendanceDate),
        toDateOnlyOrNull(record.service_date),
        record.meal_type || null,
        record.menu_type || null,
        record.menu_category || null,
        attendeeId,
        attendeeName,
        attendeeId,
        attendeeName,
        record.attendee_phone || null,
        record.category || null,
        record.check_in || null,
        record.check_out || null,
        record.check_in_at || null,
        record.check_out_at || null,
        markedAt,
        record.scan_method || null,
        record.qr_code_id || null,
        record.scanned_by || null,
        record.scanned_by_name || null,
        record.attendance_status || 'present',
        record.approval_status || 'pending',
        record.status || 'checked_in',
        record.notes || null,
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE attendance_records SET
      shift_id = $2, session_id = $3, session_name = $4, site_id = $5,
      site_name = $6, shift_date = $7, attendance_date = $8,
      session_date = $9, service_date = $10, meal_type = $11, menu_type = $12,
      menu_category = $13, employee_id = $14, employee_name = $15,
      attendee_id = $16, attendee_name = $17, attendee_phone = $18,
      category = $19, check_in = $20, check_out = $21, check_in_at = $22,
      check_out_at = $23, marked_at = $24, scan_method = $25,
      qr_code_id = $26, scanned_by = $27, scanned_by_name = $28,
      attendance_status = $29, approval_status = $30, status = $31,
      notes = $32, source_name = $33, updated_at = $34
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 33), record.updated_date || nowIso()];
    }
  },
  StaffShift: {
    table: 'staff_shifts',
    idColumn: 'id',
    mapper: rowToStaffShift,
    select: 'SELECT * FROM staff_shifts',
    insertSql: `INSERT INTO staff_shifts (
      id, site_id, site_name, shift_date, employee_id, employee_name,
      role, category, shift_type, start_time, end_time, break_minutes,
      approval_status, status, notes, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    values(record) {
      return [
        record.id,
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.shift_date),
        record.employee_id || null,
        record.employee_name || null,
        record.role || null,
        record.category || null,
        record.shift_type || null,
        record.start_time || null,
        record.end_time || null,
        Math.max(0, Math.trunc(toNumberOrZero(record.break_minutes) || 60)),
        record.approval_status || 'pending',
        record.status || 'scheduled',
        record.notes || null,
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE staff_shifts SET
      site_id = $2, site_name = $3, shift_date = $4, employee_id = $5,
      employee_name = $6, role = $7, category = $8, shift_type = $9,
      start_time = $10, end_time = $11, break_minutes = $12,
      approval_status = $13, status = $14, notes = $15, source_name = $16,
      updated_at = $17
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 16), record.updated_date || nowIso()];
    }
  },
  D365Master: {
    table: 'd365_masters',
    idColumn: 'id',
    mapper: rowToD365Master,
    select: 'SELECT * FROM d365_masters',
    insertSql: `INSERT INTO d365_masters (
      id, status, source_system, module_key, sync_id, idempotency_key,
      site_id, site_name, ingredient_id, ingredient_name, d365_item_id,
      d365_warehouse_id, integration_log_id, processed_at, source_name,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    values(record) {
      const createdAt = record.created_date || nowIso();
      return [
        record.id,
        record.status || 'synced',
        record.source_system || null,
        record.module_key || null,
        record.sync_id || null,
        record.idempotency_key || null,
        record.site_id || null,
        record.site_name || null,
        record.ingredient_id || null,
        record.ingredient_name || null,
        record.d365_item_id || null,
        record.d365_warehouse_id || null,
        record.integration_log_id || null,
        record.processed_at || createdAt,
        record.source_name || null,
        createdAt,
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE d365_masters SET
      status = $2, source_system = $3, module_key = $4, sync_id = $5,
      idempotency_key = $6, site_id = $7, site_name = $8, ingredient_id = $9,
      ingredient_name = $10, d365_item_id = $11, d365_warehouse_id = $12,
      integration_log_id = $13, processed_at = $14, source_name = $15,
      updated_at = $16
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 15), record.updated_date || nowIso()];
    }
  },
  ForecastScenario: {
    table: 'forecast_scenarios',
    idColumn: 'id',
    mapper: rowToForecastScenario,
    select: 'SELECT * FROM forecast_scenarios',
    insertSql: `INSERT INTO forecast_scenarios (
      id, name, location_id, location_name, site_id, site_name, category,
      status_filter, start_date, end_date, forecast_horizon_days,
      safety_buffer_percent, model_type, status, notes, last_run_date,
      latest_snapshot_id, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    values(record) {
      const locationId = record.location_id || record.site_id || null;
      return [
        record.id,
        record.name || 'Forecast Scenario',
        locationId,
        record.location_name || record.site_name || null,
        record.site_id || locationId,
        record.site_name || record.location_name || null,
        record.category || 'all',
        record.status_filter || 'all',
        toDateOnlyOrNull(record.start_date),
        toDateOnlyOrNull(record.end_date),
        Math.max(1, Math.trunc(toNumberOrZero(record.forecast_horizon_days) || 7)),
        toNumberOrZero(record.safety_buffer_percent || 10),
        record.model_type || 'blended_average',
        record.status || 'draft',
        record.notes || '',
        record.last_run_date || null,
        record.latest_snapshot_id || null,
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE forecast_scenarios SET
      name = $2, location_id = $3, location_name = $4, site_id = $5,
      site_name = $6, category = $7, status_filter = $8, start_date = $9,
      end_date = $10, forecast_horizon_days = $11, safety_buffer_percent = $12,
      model_type = $13, status = $14, notes = $15, last_run_date = $16,
      latest_snapshot_id = $17, source_name = $18, updated_at = $19
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 18), record.updated_date || nowIso()];
    }
  },
  WasteDetectionLog: {
    table: 'waste_detection_logs',
    idColumn: 'id',
    mapper: rowToWasteDetectionLog,
    select: 'SELECT * FROM waste_detection_logs',
    insertSql: `INSERT INTO waste_detection_logs (
      id, site_id, site_name, image_url, detected_food_types, estimated_waste_grams,
      waste_percentage, waste_category, confidence_score, ai_suggestions, cost_estimate,
      detection_method, detected_by, detected_at, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17,$18)`,
    values(record) {
      const createdAt = record.created_date || nowIso();
      return [
        record.id,
        record.site_id || null,
        record.site_name || null,
        record.image_url || null,
        normalizeTextArray(record.detected_food_types),
        toNumberOrZero(record.estimated_waste_grams),
        toNumberOrZero(record.waste_percentage),
        record.waste_category || null,
        toNumberOrZero(record.confidence_score),
        normalizeTextArray(record.ai_suggestions || record.suggestions),
        toNumberOrZero(record.cost_estimate),
        record.detection_method || 'camera',
        record.detected_by || null,
        record.detected_at || createdAt,
        record.status || 'active',
        record.source_name || null,
        createdAt,
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE waste_detection_logs SET
      site_id = $2, site_name = $3, image_url = $4, detected_food_types = $5::text[],
      estimated_waste_grams = $6, waste_percentage = $7, waste_category = $8,
      confidence_score = $9, ai_suggestions = $10::text[], cost_estimate = $11,
      detection_method = $12, detected_by = $13, detected_at = $14,
      status = $15, source_name = $16, updated_at = $17
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 16), record.updated_date || nowIso()];
    }
  },
  AdvancedReportSchedule: {
    table: 'advanced_report_schedules',
    idColumn: 'id',
    mapper: rowToAdvancedReportSchedule,
    select: 'SELECT * FROM advanced_report_schedules',
    insertSql: `INSERT INTO advanced_report_schedules (
      id, report_key, recipients, frequency, format, location_id, site_id, site_name,
      category, notes, next_run_date, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    values(record) {
      const locationId = record.location_id || record.site_id || 'all';
      const scopedSiteId = record.site_id || (locationId && locationId !== 'all' ? locationId : null);
      return [
        record.id,
        record.report_key || 'food_cost',
        record.recipients || '',
        record.frequency || 'weekly',
        record.format || 'pdf',
        locationId,
        scopedSiteId,
        record.site_name || null,
        record.category || 'all',
        record.notes || '',
        toDateOnlyOrNull(record.next_run_date),
        record.status || 'active',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE advanced_report_schedules SET
      report_key = $2, recipients = $3, frequency = $4, format = $5,
      location_id = $6, site_id = $7, site_name = $8, category = $9,
      notes = $10, next_run_date = $11, status = $12, source_name = $13,
      updated_at = $14
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 13), record.updated_date || nowIso()];
    }
  },
  WasteTarget: {
    table: 'waste_targets',
    idColumn: 'id',
    mapper: rowToWasteTarget,
    select: 'SELECT * FROM waste_targets',
    insertSql: `INSERT INTO waste_targets (
      id, site_id, site_name, target_month, target_percentage, target_cost,
      notes, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    values(record) {
      return [
        record.id,
        record.site_id || null,
        record.site_name || null,
        record.target_month || null,
        toNumberOrZero(record.target_percentage),
        toNumberOrZero(record.target_cost),
        record.notes || null,
        record.status || 'active',
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE waste_targets SET
      site_id = $2, site_name = $3, target_month = $4,
      target_percentage = $5, target_cost = $6, notes = $7,
      status = $8, source_name = $9, updated_at = $10
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 9), record.updated_date || nowIso()];
    }
  },
  Budget: {
    table: 'budgets',
    idColumn: 'id',
    mapper: rowToBudget,
    select: 'SELECT * FROM budgets',
    insertSql: `INSERT INTO budgets (
      id, budget_key, name, site_id, site_name, start_date, end_date, budget_amount,
      currency, scope_type, meal_type, event_name, category, department, source_module,
      budget_level, budget_mode, daily_budget_amount, monthly_budget_amount, status,
      notes, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    values(record) {
      return [
        record.id,
        record.budget_key || null,
        record.name || 'Budget',
        record.site_id || null,
        record.site_name || null,
        toDateOnlyOrNull(record.start_date),
        toDateOnlyOrNull(record.end_date),
        toNumberOrZero(record.budget_amount),
        record.currency || 'SAR',
        record.scope_type || 'site_period',
        record.meal_type || 'all',
        record.event_name || null,
        record.category || null,
        record.department || null,
        record.source_module || null,
        record.budget_level || null,
        record.budget_mode || null,
        toNumberOrZero(record.daily_budget_amount),
        toNumberOrZero(record.monthly_budget_amount),
        record.status || 'active',
        record.notes || null,
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE budgets SET
      budget_key = $2, name = $3, site_id = $4, site_name = $5,
      start_date = $6, end_date = $7, budget_amount = $8, currency = $9,
      scope_type = $10, meal_type = $11, event_name = $12, category = $13,
      department = $14, source_module = $15, budget_level = $16,
      budget_mode = $17, daily_budget_amount = $18, monthly_budget_amount = $19,
      status = $20, notes = $21, source_name = $22, updated_at = $23
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 22), record.updated_date || nowIso()];
    }
  },
  FoodCategory: {
    table: 'food_categories',
    idColumn: 'id',
    mapper: rowToFoodCategory,
    select: 'SELECT * FROM food_categories',
    insertSql: `INSERT INTO food_categories (
      id, name, code, description, color, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values(record) {
      return [
        record.id,
        record.name || 'Food Category',
        record.code || null,
        record.description || null,
        record.color || '#10b981',
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE food_categories SET
      name = $2, code = $3, description = $4, color = $5,
      status = $6, source_name = $7, updated_at = $8
      WHERE id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 7), record.updated_date || nowIso()];
    }
  },
  Supplier: {
    table: 'suppliers',
    idColumn: 'id',
    mapper: rowToSupplier,
    select: 'SELECT * FROM suppliers',
    insertSql: `INSERT INTO suppliers (
      id, name, supplier_code, contact_person, email, phone, address, city, country,
      payment_terms, lead_time_days, status, rating, categories, notes,
      source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15,$16,$17,$18)`,
    values(record) {
      return [
        record.id,
        record.name || record.supplier_name || 'Supplier',
        record.supplier_code || record.code || null,
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
        Array.isArray(record.categories) ? record.categories.map(String).filter(Boolean) : [],
        record.notes || null,
        record.source_name || null,
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE suppliers SET
      name = $2, supplier_code = $3, contact_person = $4, email = $5, phone = $6, address = $7,
      city = $8, country = $9, payment_terms = $10, lead_time_days = $11,
      status = $12, rating = $13, categories = $14::text[], notes = $15,
      source_name = $16, updated_at = $17
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
    select: `SELECT ingredient.*,
                    detail.supplier_item_name,
                    detail.supplier_name AS supplier,
                    detail.cost_per_unit,
                    detail.package_pack_count,
                    detail.package_inner_count,
                    detail.package_size_quantity,
                    detail.package_size_unit,
                    detail.package_base_quantity,
                    detail.package_base_unit,
                    detail.package_parse_source,
                    detail.cooking_yield_percent,
                    detail.shrinkage_percent,
                    detail.raw_weight_per_unit,
                    detail.cooked_weight_per_unit,
                    nutrition.calories_per_100g,
                    nutrition.protein_per_100g,
                    nutrition.carbs_per_100g,
                    nutrition.fat_per_100g,
                    nutrition.fiber_per_100g,
                    nutrition.sodium_per_100g,
                    nutrition.sugar_per_100g,
                    conversion.to_unit AS conversion_unit,
                    conversion.factor AS conversion_factor,
                    COALESCE(alias_rows.aliases, ARRAY[]::text[]) AS aliases,
                    COALESCE(alternative_rows.alternative_names, ARRAY[]::text[]) AS alternative_names,
                    COALESCE(supplier_rows.supplier_item_names, ARRAY[]::text[]) AS supplier_item_names,
                    COALESCE(allergen_rows.allergens, ARRAY[]::text[]) AS allergens,
                    stock.on_hand_quantity AS stock_summary_on_hand_quantity,
                    stock.reserved_quantity AS stock_summary_reserved_quantity,
                    stock.available_quantity AS stock_summary_available_quantity,
                    stock.total_value AS stock_summary_total_value,
                    stock.site_count AS stock_summary_site_count,
                    stock.unit AS stock_summary_unit
               FROM ingredients ingredient
               LEFT JOIN ingredient_details detail
                 ON detail.ingredient_id = ingredient.ingredient_id
               LEFT JOIN ingredient_nutrition_profiles nutrition
                 ON nutrition.ingredient_id = ingredient.ingredient_id
               LEFT JOIN LATERAL (
                 SELECT unit_conversion.to_unit, unit_conversion.factor
                 FROM ingredient_unit_conversions unit_conversion
                 WHERE unit_conversion.ingredient_id = ingredient.ingredient_id
                   AND unit_conversion.from_unit = ingredient.base_unit
                 ORDER BY unit_conversion.updated_at DESC, unit_conversion.conversion_id
                 LIMIT 1
               ) conversion ON TRUE
               LEFT JOIN (
                 SELECT ingredient_id, ARRAY_AGG(alias ORDER BY alias) AS aliases
                 FROM ingredient_aliases
                 WHERE alias_type = 'alias'
                 GROUP BY ingredient_id
               ) alias_rows ON alias_rows.ingredient_id = ingredient.ingredient_id
               LEFT JOIN (
                 SELECT ingredient_id, ARRAY_AGG(alias ORDER BY alias) AS alternative_names
                 FROM ingredient_aliases
                 WHERE alias_type = 'alternative_name'
                 GROUP BY ingredient_id
               ) alternative_rows ON alternative_rows.ingredient_id = ingredient.ingredient_id
               LEFT JOIN (
                 SELECT ingredient_id, ARRAY_AGG(alias ORDER BY alias) AS supplier_item_names
                 FROM ingredient_aliases
                 WHERE alias_type = 'supplier_item_name'
                 GROUP BY ingredient_id
               ) supplier_rows ON supplier_rows.ingredient_id = ingredient.ingredient_id
               LEFT JOIN (
                 SELECT ingredient_id, ARRAY_AGG(tag ORDER BY tag) AS allergens
                 FROM ingredient_allergen_tags
                 GROUP BY ingredient_id
               ) allergen_rows ON allergen_rows.ingredient_id = ingredient.ingredient_id
               LEFT JOIN ingredient_stock_summaries stock
                 ON stock.ingredient_id = ingredient.ingredient_id`,
    insertSql: `INSERT INTO ingredients (
      ingredient_id, item_code, ingredient_code, sku, d365_item_id, name, base_unit,
      category_id, status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE ingredients SET
      item_code = $2, ingredient_code = $3, sku = $4, d365_item_id = $5, name = $6,
      base_unit = $7, category_id = $8, status = $9, source_name = $10,
      updated_at = $11
      WHERE ingredient_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 10), record.updated_date || nowIso()];
    },
    afterSave: replaceIngredientRelationalDetails
  },
  Inventory: {
    table: 'warehouse_inventory',
    idColumn: 'inventory_id',
    mapper: rowToInventory,
    select: `SELECT inventory.*,
                warehouse.name AS warehouse_name,
                ingredient.name AS ingredient_name,
                ingredient.item_code,
                ingredient.ingredient_code,
                ingredient.sku,
                ingredient.d365_item_id
           FROM warehouse_inventory inventory
           LEFT JOIN warehouses warehouse
             ON warehouse.warehouse_id = inventory.warehouse_id
           LEFT JOIN ingredients ingredient
             ON ingredient.ingredient_id = inventory.ingredient_id`,
    insertSql: `INSERT INTO warehouse_inventory (
      inventory_id, warehouse_id, ingredient_id, available_quantity, reserved_quantity,
      on_hand_quantity, average_unit_cost, last_unit_cost, stock_unit, status,
      source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE warehouse_inventory SET
      warehouse_id = $2, ingredient_id = $3, available_quantity = $4, reserved_quantity = $5,
      on_hand_quantity = $6, average_unit_cost = $7, last_unit_cost = $8, stock_unit = $9,
      status = $10, source_name = $11, updated_at = $12
      WHERE inventory_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 11), record.updated_date || nowIso()];
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
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE inventory_lots SET
      inventory_id = $2, warehouse_id = $3, ingredient_id = $4, batch_number = $5,
      received_date = $6, stock_date = $7, expiry_date = $8, original_quantity = $9,
      remaining_quantity = $10, unit = $11, unit_cost = $12, status = $13,
      source_name = $14, updated_at = $15
      WHERE lot_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 14), record.updated_date || nowIso()];
    }
  },
  InventoryTransaction: {
    table: 'inventory_transactions',
    idColumn: 'inventory_transaction_id',
    mapper: rowToInventoryTransaction,
    select: `SELECT txn.*,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'inventory_transaction_layer_id', layer.inventory_transaction_layer_id,
                 'id', layer.inventory_transaction_layer_id,
                 'layer_order', layer.layer_order,
                 'lot_id', layer.inventory_lot_id,
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
                 'source_transaction_id', layer.source_transaction_id,
                 'source_name', layer.source_name
               ) ORDER BY layer.layer_order)
               FROM inventory_transaction_layers layer
               WHERE layer.inventory_transaction_id = txn.inventory_transaction_id
             ), '[]'::jsonb) AS movement_layers,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'metadata_key', meta.metadata_key,
                 'value_text', meta.value_text,
                 'value_numeric', meta.value_numeric,
                 'value_boolean', meta.value_boolean,
                 'value_date', meta.value_date
               ) ORDER BY meta.metadata_key)
               FROM inventory_transaction_metadata meta
               WHERE meta.inventory_transaction_id = txn.inventory_transaction_id
             ), '[]'::jsonb) AS metadata_entries,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'metadata_key', item.metadata_key,
                 'container_type', item.container_type,
                 'item_order', item.item_order,
                 'attribute_name', item.attribute_name,
                 'attribute_value_text', item.attribute_value_text,
                 'attribute_value_numeric', item.attribute_value_numeric,
                 'attribute_value_boolean', item.attribute_value_boolean,
                 'attribute_value_date', item.attribute_value_date
               ) ORDER BY item.metadata_key, item.container_type, item.item_order, item.attribute_name)
               FROM inventory_transaction_metadata_items item
               WHERE item.inventory_transaction_id = txn.inventory_transaction_id
             ), '[]'::jsonb) AS metadata_items
             FROM inventory_transactions txn`,
    insertSql: `INSERT INTO inventory_transactions (
      inventory_transaction_id, inventory_id, warehouse_id, warehouse_name,
      ingredient_id, ingredient_name, item_code, lot_id, transaction_type,
      transaction_date, quantity, unit, unit_cost, total_cost, reference_type,
      reference_id, reason_code, idempotency_key, status, source_name, notes,
      performed_by, batch_number, expiry_date, stock_date, received_date,
      from_warehouse_id, from_warehouse_name, to_warehouse_id, to_warehouse_name,
      source, source_type, balance_before, balance_after, opening_quantity,
      addition_quantity, consumption_quantity, remaining_quantity, operation,
      operation_id, commitment_revision, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
      $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
      $41,$42,$43
    )`,
    values(record) {
      return [
        record.id,
        record.inventory_id || null,
        record.site_id || record.warehouse_id || null,
        record.site_name || record.warehouse_name || null,
        record.ingredient_id || null,
        record.ingredient_name || null,
        record.item_code || null,
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
        record.notes || null,
        record.performed_by || null,
        record.batch_number || null,
        toDateOnlyOrNull(record.expiry_date),
        toDateOnlyOrNull(record.stock_date),
        toDateOnlyOrNull(record.received_date),
        record.from_site_id || record.from_warehouse_id || null,
        record.from_site_name || record.from_warehouse_name || null,
        record.to_site_id || record.to_warehouse_id || null,
        record.to_site_name || record.to_warehouse_name || null,
        record.source || null,
        record.source_type || null,
        toNumberOrNull(record.balance_before),
        toNumberOrNull(record.balance_after),
        toNumberOrNull(record.opening_quantity),
        toNumberOrNull(record.addition_quantity),
        toNumberOrNull(record.consumption_quantity),
        toNumberOrNull(record.remaining_quantity),
        record.operation || null,
        record.operation_id || null,
        record.commitment_revision === null || typeof record.commitment_revision === 'undefined'
          ? null
          : Math.max(0, Math.trunc(toNumberOrZero(record.commitment_revision))),
        record.created_date || nowIso(),
        record.updated_date || nowIso()
      ];
    },
    updateSql: `UPDATE inventory_transactions SET
      inventory_id = $2, warehouse_id = $3, warehouse_name = $4,
      ingredient_id = $5, ingredient_name = $6, item_code = $7, lot_id = $8,
      transaction_type = $9, transaction_date = $10, quantity = $11, unit = $12,
      unit_cost = $13, total_cost = $14, reference_type = $15, reference_id = $16,
      reason_code = $17, idempotency_key = $18, status = $19, source_name = $20,
      notes = $21, performed_by = $22, batch_number = $23, expiry_date = $24,
      stock_date = $25, received_date = $26, from_warehouse_id = $27,
      from_warehouse_name = $28, to_warehouse_id = $29, to_warehouse_name = $30,
      source = $31, source_type = $32, balance_before = $33, balance_after = $34,
      opening_quantity = $35, addition_quantity = $36, consumption_quantity = $37,
      remaining_quantity = $38, operation = $39, operation_id = $40,
      commitment_revision = $41, updated_at = $42
      WHERE inventory_transaction_id = $1`,
    updateValues(record) {
      const values = this.values(record);
      return [values[0], ...values.slice(1, 41), record.updated_date || nowIso()];
    },
    afterSave: replaceInventoryTransactionDetails
  }
};

function normalizedSelectForEntity(entity) {
  if (entity === 'Site') {
    return `SELECT area_id AS id, name, 'area' AS type, NULL::text AS parent_site_id,
                   area_code, NULL::text AS project_code, NULL::text AS warehouse_code,
                   NULL::text AS d365_warehouse_id, status, source_name, created_at, updated_at
            FROM areas
            UNION ALL
            SELECT project_id AS id, name, 'project' AS type, area_id AS parent_site_id,
                   NULL::text AS area_code, project_code, NULL::text AS warehouse_code,
                   NULL::text AS d365_warehouse_id, status, source_name, created_at, updated_at
            FROM projects
            UNION ALL
            SELECT warehouse_id AS id, name, 'store' AS type, project_id AS parent_site_id,
                   NULL::text AS area_code, NULL::text AS project_code, warehouse_code,
                   d365_warehouse_id, status, source_name, created_at, updated_at
            FROM warehouses`;
  }
  if (entity === 'Recipe') {
    return `SELECT version.*, recipe.canonical_name, recipe.description,
                   COALESCE((
                     SELECT jsonb_agg(
                       jsonb_build_object(
                         'id', line.recipe_line_id,
                         'recipe_line_id', line.recipe_line_id,
                         'ingredient_id', line.ingredient_id,
                         'item_code', ingredient.item_code,
                         'ingredient_code', ingredient.ingredient_code,
                         'sku', ingredient.sku,
                         'd365_item_id', ingredient.d365_item_id,
                         'ingredient_name', COALESCE(ingredient.name, line.ingredient_id),
                         'name', COALESCE(ingredient.name, line.ingredient_id),
                         'line_number', line.line_number,
                         'quantity', line.quantity,
                         'unit', line.unit,
                         'converted_quantity', line.converted_quantity,
                         'converted_unit', line.converted_unit,
                         'raw_weight_grams', line.raw_weight_grams,
                         'yield_percent', line.yield_percent,
                         'yielded_weight_grams', line.yielded_weight_grams,
                         'cost', line.cost,
                         'source_name', line.source_name
                       )
                       ORDER BY line.line_number, line.recipe_line_id
                     )
                     FROM recipe_ingredient_lines line
                     LEFT JOIN ingredients ingredient
                       ON ingredient.ingredient_id = line.ingredient_id
                     WHERE line.recipe_version_id = version.recipe_version_id
                   ), '[]'::jsonb) AS ingredients
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
  return normalizedSimpleConfigs[entity]?.select || null;
}

function normalizedIdColumn(entity) {
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
      supplier_item_name: 'supplier_item_name',
      supplier: 'supplier',
      cost_per_unit: 'cost_per_unit',
      cooking_yield_percent: 'cooking_yield_percent',
      calories_per_100g: 'calories_per_100g',
      is_active: 'status'
    },
    Inventory: {
      inventory_id: 'inventory_id',
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      site_name: 'warehouse_name',
      warehouse_name: 'warehouse_name',
      ingredient_id: 'ingredient_id',
      ingredient_name: 'ingredient_name',
      item_code: 'item_code',
      ingredient_code: 'ingredient_code',
      sku: 'sku',
      d365_item_id: 'd365_item_id',
      available_quantity: 'available_quantity',
      reserved_quantity: 'reserved_quantity',
      on_hand_quantity: 'on_hand_quantity',
      quantity: 'on_hand_quantity',
      average_unit_cost: 'average_unit_cost',
      last_unit_cost: 'last_unit_cost',
      unit: 'stock_unit',
      stock_unit: 'stock_unit',
      source_name: 'source_name'
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
      site_name: 'warehouse_name',
      warehouse_name: 'warehouse_name',
      ingredient_name: 'ingredient_name',
      item_code: 'item_code',
      transaction_type: 'transaction_type',
      transaction_date: 'transaction_date',
      quantity: 'quantity',
      unit: 'unit',
      unit_cost: 'unit_cost',
      total_cost: 'total_cost',
      reference_type: 'reference_type',
      reference_id: 'reference_id',
      reason_code: 'reason_code',
      idempotency_key: 'idempotency_key',
      notes: 'notes',
      performed_by: 'performed_by',
      batch_number: 'batch_number',
      expiry_date: 'expiry_date',
      stock_date: 'stock_date',
      received_date: 'received_date',
      from_site_id: 'from_warehouse_id',
      from_warehouse_id: 'from_warehouse_id',
      to_site_id: 'to_warehouse_id',
      to_warehouse_id: 'to_warehouse_id',
      source: 'source',
      source_type: 'source_type',
      operation: 'operation',
      operation_id: 'operation_id',
      commitment_revision: 'commitment_revision'
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
    FoodCategory: {
      name: 'name',
      code: 'code',
      description: 'description',
      color: 'color',
      status: 'status',
      is_active: 'status',
      source_name: 'source_name'
    },
    Budget: {
      budget_key: 'budget_key',
      name: 'name',
      site_id: 'site_id',
      site_name: 'site_name',
      start_date: 'start_date',
      end_date: 'end_date',
      budget_amount: 'budget_amount',
      currency: 'currency',
      scope_type: 'scope_type',
      meal_type: 'meal_type',
      event_name: 'event_name',
      category: 'category',
      department: 'department',
      source_module: 'source_module',
      budget_level: 'budget_level',
      budget_mode: 'budget_mode',
      daily_budget_amount: 'daily_budget_amount',
      monthly_budget_amount: 'monthly_budget_amount',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    WasteTarget: {
      site_id: 'site_id',
      site_name: 'site_name',
      target_month: 'target_month',
      target_percentage: 'target_percentage',
      target_cost: 'target_cost',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    AdvancedReportSchedule: {
      report_key: 'report_key',
      recipients: 'recipients',
      frequency: 'frequency',
      format: 'format',
      location_id: 'location_id',
      site_id: 'site_id',
      site_name: 'site_name',
      category: 'category',
      notes: 'notes',
      next_run_date: 'next_run_date',
      status: 'status',
      source_name: 'source_name'
    },
    WasteDetectionLog: {
      site_id: 'site_id',
      site_name: 'site_name',
      image_url: 'image_url',
      detected_food_types: 'detected_food_types',
      estimated_waste_grams: 'estimated_waste_grams',
      waste_percentage: 'waste_percentage',
      waste_category: 'waste_category',
      confidence_score: 'confidence_score',
      ai_suggestions: 'ai_suggestions',
      cost_estimate: 'cost_estimate',
      detection_method: 'detection_method',
      detected_by: 'detected_by',
      detected_at: 'detected_at',
      status: 'status',
      source_name: 'source_name'
    },
    D365Master: {
      status: 'status',
      source_system: 'source_system',
      module_key: 'module_key',
      sync_id: 'sync_id',
      idempotency_key: 'idempotency_key',
      site_id: 'site_id',
      site_name: 'site_name',
      ingredient_id: 'ingredient_id',
      ingredient_name: 'ingredient_name',
      d365_item_id: 'd365_item_id',
      d365_warehouse_id: 'd365_warehouse_id',
      integration_log_id: 'integration_log_id',
      processed_at: 'processed_at',
      source_name: 'source_name'
    },
    ForecastScenario: {
      name: 'name',
      location_id: 'location_id',
      location_name: 'location_name',
      site_id: 'site_id',
      site_name: 'site_name',
      category: 'category',
      status_filter: 'status_filter',
      start_date: 'start_date',
      end_date: 'end_date',
      forecast_horizon_days: 'forecast_horizon_days',
      safety_buffer_percent: 'safety_buffer_percent',
      model_type: 'model_type',
      status: 'status',
      notes: 'notes',
      last_run_date: 'last_run_date',
      latest_snapshot_id: 'latest_snapshot_id',
      source_name: 'source_name'
    },
    AttendanceRecord: {
      shift_id: 'shift_id',
      session_id: 'session_id',
      session_name: 'session_name',
      site_id: 'site_id',
      site_name: 'site_name',
      shift_date: 'shift_date',
      attendance_date: 'attendance_date',
      session_date: 'session_date',
      service_date: 'service_date',
      meal_type: 'meal_type',
      menu_type: 'menu_type',
      menu_category: 'menu_category',
      employee_id: 'employee_id',
      employee_name: 'employee_name',
      attendee_id: 'attendee_id',
      attendee_name: 'attendee_name',
      attendee_phone: 'attendee_phone',
      category: 'category',
      check_in: 'check_in',
      check_out: 'check_out',
      check_in_at: 'check_in_at',
      check_out_at: 'check_out_at',
      marked_at: 'marked_at',
      scan_method: 'scan_method',
      qr_code_id: 'qr_code_id',
      scanned_by: 'scanned_by',
      scanned_by_name: 'scanned_by_name',
      attendance_status: 'attendance_status',
      approval_status: 'approval_status',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    StaffShift: {
      site_id: 'site_id',
      site_name: 'site_name',
      shift_date: 'shift_date',
      employee_id: 'employee_id',
      employee_name: 'employee_name',
      role: 'role',
      category: 'category',
      shift_type: 'shift_type',
      start_time: 'start_time',
      end_time: 'end_time',
      break_minutes: 'break_minutes',
      approval_status: 'approval_status',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    ERPIntegrationConfig: {
      provider_name: 'provider_name',
      api_endpoint: 'api_endpoint',
      sync_schedule: 'sync_schedule',
      is_active: 'is_active',
      status: 'status',
      source_name: 'source_name'
    },
    ERPIntegrationLog: {
      config_id: 'config_id',
      provider_name: 'provider_name',
      module_key: 'module_key',
      operation: 'operation',
      direction: 'direction',
      transport: 'transport',
      records_count: 'records_count',
      applied_count: 'applied_count',
      skipped_count: 'skipped_count',
      failed_count: 'failed_count',
      source_system: 'source_system',
      sync_id: 'sync_id',
      quantity_semantics: 'quantity_semantics',
      received_at: 'received_at',
      retry_of_log_id: 'retry_of_log_id',
      retry_count: 'retry_count',
      retried_at: 'retried_at',
      site_id: 'site_id',
      attempted_by: 'attempted_by',
      attempted_at: 'attempted_at',
      completed_at: 'completed_at',
      status: 'status',
      source_name: 'source_name'
    },
    ForecastSnapshot: {
      scenario_id: 'scenario_id',
      scenario_name: 'scenario_name',
      site_id: 'site_id',
      site_name: 'site_name',
      start_date: 'start_date',
      end_date: 'end_date',
      forecast_horizon_days: 'forecast_horizon_days',
      generated_by_id: 'generated_by_id',
      generated_by_email: 'generated_by_email',
      generated_at: 'generated_at',
      status: 'status',
      source_name: 'source_name'
    },
    BranchOrder: {
      order_number: 'order_number',
      branch_id: 'branch_id',
      branch_name: 'branch_name',
      site_id: 'site_id',
      site_name: 'site_name',
      order_date: 'order_date',
      required_date: 'required_date',
      priority: 'priority',
      approved_by: 'approved_by',
      approved_at: 'approved_at',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    MaterialRequest: {
      request_number: 'request_number',
      site_id: 'site_id',
      site_name: 'site_name',
      requesting_site_id: 'requesting_site_id',
      requesting_site_name: 'requesting_site_name',
      fulfillment_store_id: 'fulfillment_store_id',
      fulfillment_store_name: 'fulfillment_store_name',
      request_date: 'request_date',
      period_start: 'period_start',
      period_end: 'period_end',
      total_estimated_cost: 'total_estimated_cost',
      source_type: 'source_type',
      source_production_id: 'source_production_id',
      source_production_name: 'source_production_name',
      created_by: 'created_by',
      created_by_name: 'created_by_name',
      acknowledged_by: 'acknowledged_by',
      acknowledged_at: 'acknowledged_at',
      procurement_notes: 'procurement_notes',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    MenuPlanPRSchedule: {
      site_id: 'site_id',
      site_name: 'site_name',
      is_active: 'is_active',
      cycle_days: 'cycle_days',
      preferred_weekday: 'preferred_weekday',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    MenuPlanPRRun: {
      site_id: 'site_id',
      site_name: 'site_name',
      cycle_start: 'cycle_start',
      cycle_end: 'cycle_end',
      preferred_run_date: 'preferred_run_date',
      requested_run_date: 'requested_run_date',
      cycle_days: 'cycle_days',
      preferred_weekday: 'preferred_weekday',
      trigger_type: 'trigger_type',
      generated_pr_id: 'generated_pr_id',
      generated_pr_number: 'generated_pr_number',
      generated_request_id: 'generated_request_id',
      generated_request_number: 'generated_request_number',
      generated_item_count: 'generated_item_count',
      total_estimated_cost: 'total_estimated_cost',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    ProductionBatch: {
      batch_number: 'batch_number',
      production_id: 'production_id',
      recipe_id: 'recipe_id',
      recipe_name: 'recipe_name',
      site_id: 'site_id',
      site_name: 'site_name',
      meal_type: 'meal_type',
      quantity: 'quantity',
      unit: 'unit',
      production_date: 'production_date',
      expiry_date: 'expiry_date',
      process_stage: 'process_stage',
      qc_status: 'qc_status',
      packaging_status: 'packaging_status',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    ProductionTransfer: {
      transfer_number: 'transfer_number',
      from_site_id: 'from_site_id',
      from_site_name: 'from_site_name',
      to_site_id: 'to_site_id',
      to_site_name: 'to_site_name',
      site_id: 'site_id',
      transfer_date: 'transfer_date',
      transfer_type: 'transfer_type',
      requested_by: 'requested_by',
      received_by: 'received_by',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    PurchaseOrder: {
      po_number: 'po_number',
      order_number: 'order_number',
      supplier_id: 'supplier_id',
      supplier_name: 'supplier_name',
      site_id: 'site_id',
      site_name: 'site_name',
      order_date: 'order_date',
      expected_delivery_date: 'expected_delivery_date',
      total_amount: 'total_amount',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    QualityControl: {
      batch_id: 'batch_id',
      batch_number: 'batch_number',
      production_id: 'production_id',
      recipe_id: 'recipe_id',
      recipe_name: 'recipe_name',
      site_id: 'site_id',
      site_name: 'site_name',
      inspection_date: 'inspection_date',
      inspector_name: 'inspector_name',
      overall_status: 'overall_status',
      approval_notes: 'approval_notes',
      approved_by: 'approved_by',
      approved_at: 'approved_at',
      status: 'status',
      source_name: 'source_name'
    },
    RFQ: {
      rfq_number: 'rfq_number',
      issue_date: 'issue_date',
      response_deadline: 'response_deadline',
      notes: 'notes',
      status: 'status',
      source_name: 'source_name'
    },
    AttendanceSession: {
      session_name: 'session_name',
      title: 'title',
      site_id: 'site_id',
      site_name: 'site_name',
      meal_type: 'meal_type',
      session_date: 'session_date',
      start_time: 'start_time',
      end_time: 'end_time',
      qr_token: 'qr_token',
      qr_expiry: 'qr_expiry',
      expected_labor: 'expected_labor',
      expected_junior: 'expected_junior',
      expected_senior: 'expected_senior',
      actual_labor: 'actual_labor',
      actual_junior: 'actual_junior',
      actual_senior: 'actual_senior',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    CategoryQRSession: {
      title: 'title',
      site_id: 'site_id',
      site_name: 'site_name',
      session_date: 'session_date',
      from_date: 'from_date',
      to_date: 'to_date',
      start_time: 'start_time',
      end_time: 'end_time',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    DinerScan: {
      event_id: 'event_id',
      event_name: 'event_name',
      site_id: 'site_id',
      site_name: 'site_name',
      plan_date: 'plan_date',
      meal_type: 'meal_type',
      guest_token: 'guest_token',
      scan_method: 'scan_method',
      scanned_at: 'scanned_at',
      status: 'status',
      source_name: 'source_name'
    },
    CustomerMealPlan: {
      name: 'name',
      site_id: 'site_id',
      site_name: 'site_name',
      plan_date: 'plan_date',
      customer_id: 'customer_id',
      customer_name: 'customer_name',
      status: 'status',
      notes: 'notes',
      source_name: 'source_name'
    },
    QRCode: {
      title: 'title',
      name: 'name',
      category: 'category',
      description: 'description',
      token: 'token',
      linked_item: 'linked_item',
      is_one_time: 'is_one_time',
      max_scans: 'max_scans',
      scan_count: 'scan_count',
      expiry_date: 'expiry_date',
      last_scanned_at: 'last_scanned_at',
      employee_name: 'employee_name',
      company_id_number: 'company_id_number',
      mobile_number: 'mobile_number',
      active_whatsapp: 'active_whatsapp',
      created_by: 'created_by',
      created_by_name: 'created_by_name',
      status: 'status',
      source_name: 'source_name'
    },
    QRDelivery: {
      qr_code_id: 'qr_code_id',
      qr_code_title: 'qr_code_title',
      qr_token: 'qr_token',
      delivery_method: 'delivery_method',
      subject: 'subject',
      scheduled_at: 'scheduled_at',
      sent_at: 'sent_at',
      sent_count: 'sent_count',
      failed_count: 'failed_count',
      status: 'status',
      source_name: 'source_name'
    },
    UserGroup: {
      name: 'name',
      description: 'description',
      total_members: 'total_members',
      status: 'status',
      source_name: 'source_name'
    },
    Supplier: {
      name: 'name',
      supplier_name: 'name',
      contact_person: 'contact_person',
      supplier_code: 'supplier_code',
      email: 'email',
      phone: 'phone',
      city: 'city',
      country: 'country',
      payment_terms: 'payment_terms',
      lead_time_days: 'lead_time_days',
      rating: 'rating',
      is_active: 'status',
      source_name: 'source_name'
    },
    Recipe: {
      recipe_master_id: 'recipe_id',
      recipe_id: 'recipe_version_id',
      recipe_version_id: 'recipe_version_id',
      name: 'display_name',
      display_name: 'display_name',
      canonical_name: 'canonical_name',
      description: 'description',
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
      source_name: 'source_name'
    },
    MenuPlan: {
      site_id: 'warehouse_id',
      warehouse_id: 'warehouse_id',
      plan_date: 'plan_date',
      date: 'plan_date',
      meal_type: 'meal_period',
      meal_period: 'meal_period',
      cuisine_type: 'menu_type',
      menu_type: 'menu_type',
      menu_category: 'menu_category',
      created_by: 'created_by',
      source_name: 'source_name'
    }
  };
  const column = {
    ...common,
    ...(columns[entity] || {})
  }[field];
  if (!column) {
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
      `INSERT INTO areas (area_id, area_code, name, legacy_site_id, status, source_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (area_id) DO UPDATE SET
         area_code = EXCLUDED.area_code, name = EXCLUDED.name, legacy_site_id = EXCLUDED.legacy_site_id,
         status = EXCLUDED.status, source_name = EXCLUDED.source_name,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.area_code || record.project_code || null,
        record.name,
        record.legacy_site_id || record.id,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
  } else if (type === SITE_HIERARCHY_TYPES.PROJECT) {
    await query(
      `INSERT INTO projects (project_id, area_id, project_code, name, legacy_site_id, status, source_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id) DO UPDATE SET
         area_id = EXCLUDED.area_id, project_code = EXCLUDED.project_code, name = EXCLUDED.name,
         legacy_site_id = EXCLUDED.legacy_site_id, status = EXCLUDED.status, source_name = EXCLUDED.source_name,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.parent_site_id,
        record.project_code || null,
        record.name,
        record.legacy_site_id || record.id,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
        createdAt,
        updatedAt
      ],
      executor
    );
  } else {
    await query(
      `INSERT INTO warehouses (warehouse_id, project_id, warehouse_code, d365_warehouse_id, name, legacy_site_id, status, source_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (warehouse_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, warehouse_code = EXCLUDED.warehouse_code,
         d365_warehouse_id = EXCLUDED.d365_warehouse_id, name = EXCLUDED.name,
         legacy_site_id = EXCLUDED.legacy_site_id, status = EXCLUDED.status, source_name = EXCLUDED.source_name,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.parent_site_id,
        record.warehouse_code || record.project_code || null,
        record.d365_warehouse_id || null,
        record.name,
        record.legacy_site_id || record.id,
        record.status || (record.is_active === false ? 'inactive' : 'active'),
        record.source_name || null,
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
    `INSERT INTO recipes (recipe_id, canonical_name, description, status, source_name, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (recipe_id) DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name, description = EXCLUDED.description,
       status = EXCLUDED.status, source_name = EXCLUDED.source_name,
       updated_at = EXCLUDED.updated_at`,
    [
      masterId,
      record.canonical_name || record.name,
      record.description || null,
      record.status || (record.is_active === false ? 'inactive' : 'active'),
      record.source_name || null,
      createdAt,
      updatedAt
    ],
    executor
  );
  const scopeIds = Array.isArray(record.site_ids) ? record.site_ids.filter(Boolean).map(String) : [];
  const scope = String(record.site_scope || '').toLowerCase();
  let warehouseId = record.warehouse_id || (scope === 'warehouse' || scope === 'store' ? scopeIds[0] : null);
  let projectId = record.project_id || (scope === 'project' ? scopeIds[0] : null);
  let areaId = record.area_id || (scope === 'area' ? scopeIds[0] : null);
  if (!warehouseId && !projectId && !areaId && scope === 'specific' && scopeIds.length > 0) {
    const scopedId = scopeIds[0];
    if (/^area[_-]/i.test(scopedId)) {
      areaId = scopedId;
    } else if (/^project[_-]/i.test(scopedId)) {
      projectId = scopedId;
    } else {
      warehouseId = scopedId;
    }
  }
  await query(
    `INSERT INTO recipe_versions (
      recipe_version_id, recipe_id, area_id, project_id, warehouse_id, recipe_code,
      display_name, version_label, cuisine_type, menu_category, serving_size_grams,
      batch_yield, total_recipe_weight_grams, total_cost, cost_per_serving,
      status, source_name, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (recipe_version_id) DO UPDATE SET
      recipe_id = EXCLUDED.recipe_id, area_id = EXCLUDED.area_id, project_id = EXCLUDED.project_id,
      warehouse_id = EXCLUDED.warehouse_id, recipe_code = EXCLUDED.recipe_code,
      display_name = EXCLUDED.display_name, version_label = EXCLUDED.version_label,
      cuisine_type = EXCLUDED.cuisine_type, menu_category = EXCLUDED.menu_category,
      serving_size_grams = EXCLUDED.serving_size_grams, batch_yield = EXCLUDED.batch_yield,
      total_recipe_weight_grams = EXCLUDED.total_recipe_weight_grams, total_cost = EXCLUDED.total_cost,
      cost_per_serving = EXCLUDED.cost_per_serving, status = EXCLUDED.status,
      source_name = EXCLUDED.source_name, updated_at = EXCLUDED.updated_at`,
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

function relationalKeyPart(value, fallback = 'value') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^A-Za-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

async function replaceInventoryTransactionLayers(record, executor = pool) {
  await query('DELETE FROM inventory_transaction_layers WHERE inventory_transaction_id = $1', [record.id], executor);
  const layers = Array.isArray(record.movement_layers) ? record.movement_layers : [];
  const createdAt = record.created_date || nowIso();
  for (const [index, layer] of layers.entries()) {
    const layerOrder = index + 1;
    await query(
      `INSERT INTO inventory_transaction_layers (
        inventory_transaction_layer_id, inventory_transaction_id, layer_order,
        inventory_lot_id, batch_number, stock_date, received_date, expiry_date,
        quantity, quantity_before, quantity_after, reserved_quantity_before,
        reserved_quantity_after, available_quantity_before, available_quantity_after,
        unit_cost, total_cost, accounting_unit_cost, accounting_total_cost,
        production_id, commitment_revision, operation_id, source_transaction_id,
        source_name, created_at
      ) VALUES (
        $1,$2,$3,
        (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF($4::text, '') LIMIT 1),
        $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        (SELECT production_id FROM production_events WHERE production_id = NULLIF($20::text, '') LIMIT 1),
        $21,$22,$23,$24,$25
      )`,
      [
        layer.inventory_transaction_layer_id || layer.id || lineNumberedId('layer', record.id, layerOrder),
        record.id,
        layerOrder,
        layer.inventory_lot_id || layer.lot_id || null,
        layer.batch_number || null,
        toDateOnlyOrNull(layer.stock_date),
        toDateOnlyOrNull(layer.received_date),
        toDateOnlyOrNull(layer.expiry_date),
        toNumberOrZero(layer.quantity ?? layer.deducted_quantity),
        toNumberOrNull(layer.quantity_before),
        toNumberOrNull(layer.quantity_after),
        toNumberOrNull(layer.reserved_quantity_before),
        toNumberOrNull(layer.reserved_quantity_after),
        toNumberOrNull(layer.available_quantity_before),
        toNumberOrNull(layer.available_quantity_after),
        toNumberOrZero(layer.unit_cost),
        toNumberOrZero(layer.total_cost ?? layer.cost),
        toNumberOrNull(layer.accounting_unit_cost),
        toNumberOrNull(layer.accounting_total_cost),
        layer.production_id || null,
        layer.commitment_revision === null || typeof layer.commitment_revision === 'undefined'
          ? null
          : Math.max(0, Math.trunc(toNumberOrZero(layer.commitment_revision))),
        layer.operation_id || null,
        layer.source_transaction_id || layer.transaction_id || null,
        layer.source_name || record.source_name || null,
        createdAt
      ],
      executor
    );
  }
}

async function insertInventoryTransactionMetadataScalar(recordId, key, value, createdAt, executor = pool) {
  const columns = metadataWriteColumns(value);
  await query(
    `INSERT INTO inventory_transaction_metadata (
      inventory_transaction_metadata_id, inventory_transaction_id, metadata_key,
      value_text, value_numeric, value_boolean, value_date, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      `${recordId}:meta:${relationalKeyPart(key)}`,
      recordId,
      key,
      columns.text,
      columns.numeric,
      columns.boolean,
      columns.date,
      createdAt
    ],
    executor
  );
}

async function insertInventoryTransactionMetadataAttribute({
  recordId,
  key,
  containerType,
  itemOrder,
  attributeName,
  value,
  createdAt,
  executor = pool
}) {
  const columns = metadataWriteColumns(value);
  await query(
    `INSERT INTO inventory_transaction_metadata_items (
      inventory_transaction_metadata_item_id, inventory_transaction_id, metadata_key,
      container_type, item_order, attribute_name, attribute_value_text,
      attribute_value_numeric, attribute_value_boolean, attribute_value_date, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      `${recordId}:meta-item:${relationalKeyPart(key)}:${containerType}:${itemOrder}:${relationalKeyPart(attributeName)}`,
      recordId,
      key,
      containerType,
      itemOrder,
      attributeName,
      columns.text,
      columns.numeric,
      columns.boolean,
      columns.date,
      createdAt
    ],
    executor
  );
}

async function replaceInventoryTransactionMetadata(record, executor = pool) {
  await query('DELETE FROM inventory_transaction_metadata_items WHERE inventory_transaction_id = $1', [record.id], executor);
  await query('DELETE FROM inventory_transaction_metadata WHERE inventory_transaction_id = $1', [record.id], executor);
  if (!isPlainObject(record.metadata)) return;

  const createdAt = record.created_date || nowIso();
  for (const [key, value] of Object.entries(record.metadata)) {
    if (!key) continue;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const attributes = isPlainObject(item) ? Object.entries(item) : [['value', item]];
        for (const [attributeName, attributeValue] of attributes) {
          await insertInventoryTransactionMetadataAttribute({
            recordId: record.id,
            key,
            containerType: 'array',
            itemOrder: index + 1,
            attributeName,
            value: attributeValue,
            createdAt,
            executor
          });
        }
      }
      continue;
    }
    if (isPlainObject(value)) {
      for (const [attributeName, attributeValue] of Object.entries(value)) {
        await insertInventoryTransactionMetadataAttribute({
          recordId: record.id,
          key,
          containerType: 'object',
          itemOrder: 1,
          attributeName,
          value: attributeValue,
          createdAt,
          executor
        });
      }
      continue;
    }
    await insertInventoryTransactionMetadataScalar(record.id, key, value, createdAt, executor);
  }
}

async function replaceInventoryTransactionDetails(record, executor = pool) {
  await replaceInventoryTransactionLayers(record, executor);
  await replaceInventoryTransactionMetadata(record, executor);
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
        estimated_cost, status, source_name, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (menu_plan_line_id) DO UPDATE SET
        line_number = EXCLUDED.line_number, line_type = EXCLUDED.line_type,
        recipe_version_id = EXCLUDED.recipe_version_id, ingredient_id = EXCLUDED.ingredient_id,
        item_name = EXCLUDED.item_name, planned_servings = EXCLUDED.planned_servings,
        planned_weight_grams = EXCLUDED.planned_weight_grams, planned_unit = EXCLUDED.planned_unit,
        estimated_cost = EXCLUDED.estimated_cost, status = EXCLUDED.status,
        source_name = EXCLUDED.source_name,
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
       id, role_key, name, description, access_level,
       dashboard_variant, is_active, is_system, status, source_name,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
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

  const config = normalizedSimpleConfigs[entity];
  if (config) {
    const sql = existing ? config.updateSql : config.insertSql;
    const values = existing ? config.updateValues(record) : config.values(record);
    await query(sql, values, executor);
    if (typeof config.afterSave === 'function') {
      await config.afterSave(record, executor);
    }
    return findNormalizedDocument(entity, record.id, executor);
  }

  const createdAt = record.created_date || existing?.created_date || nowIso();
  const updatedAt = record.updated_date || nowIso();
  if (entity === 'MenuPlan') {
    await query(
      `INSERT INTO menu_plans (
        menu_plan_id, warehouse_id, plan_date, meal_period, menu_type, menu_category,
        status, source_name, created_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (menu_plan_id) DO UPDATE SET
        warehouse_id = EXCLUDED.warehouse_id, plan_date = EXCLUDED.plan_date,
        meal_period = EXCLUDED.meal_period, menu_type = EXCLUDED.menu_type,
        menu_category = EXCLUDED.menu_category, status = EXCLUDED.status,
        source_name = EXCLUDED.source_name, created_by = EXCLUDED.created_by,
        updated_at = EXCLUDED.updated_at`,
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
  const config = normalizedSimpleConfigs[entity];
  if (config) {
    const result = await query(`DELETE FROM ${config.table} WHERE ${config.idColumn} = $1`, [id], executor);
    await query(
      'DELETE FROM document_object_fields WHERE entity_name = $1 AND record_id = $2',
      [entity, id],
      executor
    );
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

  const children = (await listNormalizedDocuments('Site', {
    filters: { parent_site_id: String(record.id) }
  }, executor)) || [];
  const hierarchyError = validateSiteChildrenForParent(
    record,
    children
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

  return normalizedDependencies.sort((left, right) => left.key.localeCompare(right.key));
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
  const sites = (await listNormalizedDocuments('Site', {}, executor))
    .map((site) => ({ ...site, id: String(site.id) }));
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

  // A brief SHARE lock prevents a new Site reference from being inserted
  // between the dependency check and subtree deletion.
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
  const result = await query(
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
  );
  for (const row of result.rows) {
    const current = rowToRoleProfile(row);
    const normalized = normalizeManagementRoleProfile(current);
    if (normalized === current || JSON.stringify(normalized) === JSON.stringify(current)) continue;
    const next = { ...normalized, updated_date: nowIso() };
    await insertOrUpdateRoleProfile(next, current, executor);
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

  throw normalizedStorageError(entity);
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

  throw normalizedStorageError(entity);
}

async function findDocument(entity, id, executor = pool, lock = false) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    return sanitizeUser(await findUserById(id, executor));
  }

  if (usesNormalizedCore(entity)) {
    return findNormalizedDocument(entity, id, executor, lock);
  }

  throw normalizedStorageError(entity);
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

  throw normalizedStorageError(entity);
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

  throw normalizedStorageError(entity);
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
  throw normalizedStorageError(entity);
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

  throw normalizedStorageError(entity);
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
  const textField = (value) => {
    const text = String(value || '').trim();
    return text || null;
  };
  const detailsText = payload && Object.keys(payload).length ? JSON.stringify(payload) : null;
  await query(
    `INSERT INTO app_logs (
       id, user_id, user_email, page_name, action, site_id, reference_id, details_text, visited_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      user_id || null,
      user_email || null,
      page_name || null,
      textField(payload.action || payload.event || payload.type),
      textField(payload.site_id || payload.location_id || payload.warehouse_id),
      textField(
        payload.reference_id
        || payload.generated_pr_id
        || payload.request_id
        || payload.scenario_id
        || payload.snapshot_id
      ),
      detailsText,
      nowIso()
    ]
  );
  return { id, page_name, user_id, user_email, payload };
}

function auditDetailRowsFromValue(value, path = [], rows = []) {
  const safePath = path.map((segment) => String(segment ?? '').trim()).filter(Boolean);
  const pushPrimitive = (primitiveValue) => {
    if (!safePath.length) safePath.push('value');
    let valueType = 'null';
    let stringValue = null;
    let numericValue = null;
    let booleanValue = null;
    if (typeof primitiveValue === 'string') {
      valueType = 'string';
      stringValue = primitiveValue;
    } else if (typeof primitiveValue === 'number' && Number.isFinite(primitiveValue)) {
      valueType = 'number';
      numericValue = primitiveValue;
    } else if (typeof primitiveValue === 'boolean') {
      valueType = 'boolean';
      booleanValue = primitiveValue;
    } else if (primitiveValue !== null && typeof primitiveValue !== 'undefined') {
      valueType = 'string';
      stringValue = String(primitiveValue);
    }
    rows.push({ path: safePath, valueType, stringValue, numericValue, booleanValue });
  };

  if (Array.isArray(value)) {
    if (safePath.length) {
      rows.push({ path: safePath, valueType: 'array', stringValue: null, numericValue: null, booleanValue: null });
    }
    value.slice(0, 200).forEach((item, index) => auditDetailRowsFromValue(item, [...safePath, String(index)], rows));
    return rows.slice(0, 1000);
  }

  if (value && typeof value === 'object') {
    if (safePath.length) {
      rows.push({ path: safePath, valueType: 'object', stringValue: null, numericValue: null, booleanValue: null });
    }
    Object.entries(value).slice(0, 200).forEach(([key, nested]) => {
      auditDetailRowsFromValue(nested, [...safePath, key], rows);
    });
    return rows.slice(0, 1000);
  }

  pushPrimitive(value);
  return rows.slice(0, 1000);
}

function auditDetailValueFromRow(row = {}) {
  const valueType = String(row.value_type || '').toLowerCase();
  if (valueType === 'array') return [];
  if (valueType === 'object') return {};
  if (valueType === 'number') {
    const value = Number(row.numeric_value);
    return Number.isFinite(value) ? value : null;
  }
  if (valueType === 'boolean') return row.boolean_value === true;
  if (valueType === 'null') return null;
  return row.string_value ?? '';
}

function rebuildAuditDetails(rows = []) {
  const root = {};
  const sortedRows = [...rows].sort((left, right) => {
    const leftPath = Array.isArray(left.detail_path) ? left.detail_path : [];
    const rightPath = Array.isArray(right.detail_path) ? right.detail_path : [];
    return leftPath.length - rightPath.length;
  });
  for (const row of sortedRows) {
    const path = (Array.isArray(row.detail_path) ? row.detail_path : [])
      .map((segment) => String(segment ?? '').trim())
      .filter(Boolean);
    if (!path.length) continue;
    let cursor = root;
    for (let index = 0; index < path.length; index += 1) {
      const segment = path[index];
      const key = Array.isArray(cursor) && /^\d+$/.test(segment) ? Number(segment) : segment;
      const isLast = index === path.length - 1;
      if (isLast) {
        const nextValue = auditDetailValueFromRow(row);
        if ((row.value_type === 'array' || row.value_type === 'object') && cursor[key] && typeof cursor[key] === 'object') continue;
        cursor[key] = nextValue;
        continue;
      }
      if (!cursor[key] || typeof cursor[key] !== 'object') {
        cursor[key] = /^\d+$/.test(path[index + 1]) ? [] : {};
      }
      cursor = cursor[key];
    }
  }
  return root;
}

async function replaceAuditLogDetails(auditLogId, details = {}, createdAt = nowIso(), executor = pool) {
  await query('DELETE FROM audit_log_details WHERE audit_log_id = $1', [auditLogId], executor);
  const rows = auditDetailRowsFromValue(details || {});
  let order = 0;
  for (const row of rows) {
    order += 1;
    await query(
      `INSERT INTO audit_log_details (
         id, audit_log_id, detail_path, value_type, string_value, numeric_value,
         boolean_value, value_order, created_at
       ) VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9)`,
      [
        randomId('auditdet'),
        auditLogId,
        row.path,
        row.valueType,
        row.stringValue,
        row.numericValue,
        row.booleanValue,
        order,
        createdAt
      ],
      executor
    );
  }
}

async function listAuditLogDetails(auditLogIds = [], executor = pool) {
  const ids = normalizeTextArray(auditLogIds);
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT audit_log_id, detail_path, value_type, string_value, numeric_value, boolean_value, value_order
       FROM audit_log_details
      WHERE audit_log_id = ANY($1::text[])
      ORDER BY audit_log_id ASC, value_order ASC, id ASC`,
    [ids],
    executor
  );
  const grouped = result.rows.reduce((map, row) => {
    if (!map.has(row.audit_log_id)) map.set(row.audit_log_id, []);
    map.get(row.audit_log_id).push(row);
    return map;
  }, new Map());
  for (const [auditLogId, rows] of grouped.entries()) {
    grouped.set(auditLogId, rebuildAuditDetails(rows));
  }
  return grouped;
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
       site_id, site_name, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      createdAt
    ],
    executor
  );
  await replaceAuditLogDetails(id, details || {}, createdAt, executor);
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
      OR EXISTS (
        SELECT 1
        FROM audit_log_details detail
        WHERE detail.audit_log_id = audit_logs.id
          AND (
            array_to_string(detail.detail_path, '.') ILIKE ${parameter}
            OR COALESCE(detail.string_value, '') ILIKE ${parameter}
            OR COALESCE(detail.numeric_value::text, '') ILIKE ${parameter}
            OR COALESCE(detail.boolean_value::text, '') ILIKE ${parameter}
          )
      )
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
            site_id, site_name, created_at
     FROM audit_logs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    executor
  );
  const detailsByLog = await listAuditLogDetails(result.rows.map((row) => row.id), executor);
  return result.rows.map((row) => ({
    ...row,
    details: detailsByLog.get(row.id) || {}
  }));
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
  const safeActor = actor ? sanitizeUser(actor) : {};
  await query(
    `INSERT INTO bulk_upload_jobs (
       id, module_key, entity_name, import_mode, file_name, file_path, file_size,
       batch_size, actor_id, actor_email, actor_name, role, site_id, site_name, source_name,
       recipe_type, menu_cuisine, menu_category, actor_role_access_level, actor_role_is_active,
       actor_site_id, actor_site_name, actor_visibility_scope, actor_allowed_site_ids,
       actor_allowed_site_names, actor_role_permissions, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19,
       $20, $21, $22, $23, $24::text[], $25::text[], $26::text[], $27, $27
     )`,
    [
      id,
      module_key,
      entity_name,
      import_mode,
      file_name,
      file_path,
      Number(file_size) || 0,
      Number(batch_size) || 500,
      safeActor?.id || null,
      safeActor?.email || null,
      safeActor?.full_name || safeActor?.email || 'System',
      safeActor?.role || null,
      site_id,
      site_name,
      source_name,
      options?.recipe_type || null,
      options?.menu_cuisine || null,
      options?.menu_category || null,
      safeActor?.role_access_level || safeActor?.access_level || null,
      safeActor?.role_is_active === false ? false : true,
      safeActor?.site_id || null,
      safeActor?.site_name || null,
      safeActor?.visibility_scope || null,
      normalizeTextArray(safeActor?.allowed_site_ids),
      normalizeTextArray(safeActor?.allowed_site_names),
      normalizeTextArray(safeActor?.role_permissions),
      createdAt
    ],
    executor
  );
  return getBulkUploadJob(id, executor);
}

function buildBulkUploadJobActor(job = {}) {
  if (!job?.actor_id && !job?.actor_email && !job?.role) return null;
  return {
    id: job.actor_id || null,
    email: job.actor_email || null,
    full_name: job.actor_name || job.actor_email || null,
    role: job.role || null,
    role_access_level: job.actor_role_access_level || null,
    role_is_active: job.actor_role_is_active !== false,
    site_id: job.actor_site_id || null,
    site_name: job.actor_site_name || null,
    visibility_scope: job.actor_visibility_scope || null,
    allowed_site_ids: normalizeTextArray(job.actor_allowed_site_ids),
    allowed_site_names: normalizeTextArray(job.actor_allowed_site_names),
    role_permissions: normalizeTextArray(job.actor_role_permissions)
  };
}

function bulkUploadJobOptions(job = {}) {
  const options = {};
  if (job.recipe_type) options.recipe_type = job.recipe_type;
  if (job.menu_cuisine) options.menu_cuisine = job.menu_cuisine;
  if (job.menu_category) options.menu_category = job.menu_category;
  return options;
}

function hydrateBulkUploadJob(row = {}, errors = []) {
  const job = {
    ...row,
    errors: Array.isArray(errors) ? errors : []
  };
  const actor = buildBulkUploadJobActor(job);
  job.actor_snapshot = actor
    ? {
        ...actor,
        bulk_options: bulkUploadJobOptions(job)
      }
    : null;
  return job;
}

async function listBulkUploadJobErrors(jobIds = [], executor = pool) {
  const ids = normalizeTextArray(jobIds);
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT job_id, row_number, message, error_order
       FROM bulk_upload_job_errors
      WHERE job_id = ANY($1::text[])
      ORDER BY job_id ASC, error_order ASC, created_at ASC`,
    [ids],
    executor
  );
  return result.rows.reduce((map, row) => {
    if (!map.has(row.job_id)) map.set(row.job_id, []);
    map.get(row.job_id).push({
      row: row.row_number,
      message: row.message
    });
    return map;
  }, new Map());
}

async function replaceBulkUploadJobErrors(jobId, errors = [], executor = pool) {
  await query('DELETE FROM bulk_upload_job_errors WHERE job_id = $1', [jobId], executor);
  const safeErrors = (Array.isArray(errors) ? errors : [])
    .map((error, index) => ({
      row: error?.row !== null && error?.row !== undefined && Number.isFinite(Number(error.row))
        ? Number(error.row)
        : null,
      message: String(error?.message || 'Bulk upload failed.').trim() || 'Bulk upload failed.',
      order: index + 1
    }))
    .slice(0, 100);
  for (const error of safeErrors) {
    await query(
      `INSERT INTO bulk_upload_job_errors (
         id, job_id, row_number, message, error_order, created_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [randomId('bulkerr'), jobId, error.row, error.message, error.order],
      executor
    );
  }
}

async function getBulkUploadJob(id, executor = pool) {
  const result = await query('SELECT * FROM bulk_upload_jobs WHERE id = $1 LIMIT 1', [id], executor);
  if (!result.rowCount) return null;
  const errorsByJob = await listBulkUploadJobErrors([id], executor);
  return hydrateBulkUploadJob(result.rows[0], errorsByJob.get(id) || []);
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
  const errorsByJob = await listBulkUploadJobErrors(result.rows.map((row) => row.id), executor);
  return result.rows.map((row) => hydrateBulkUploadJob(row, errorsByJob.get(row.id) || []));
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
    started_at: 'started_at',
    completed_at: 'completed_at'
  };
  const hasErrorsPatch = Object.hasOwn(patch, 'errors');
  const assignments = [];
  const values = [];
  Object.entries(fieldMap).forEach(([key, column]) => {
    if (!Object.hasOwn(patch, key)) return;
    values.push(patch[key]);
    assignments.push(`${column} = $${values.length}`);
  });
  if (assignments.length) {
    values.push(id);
    await query(
      `UPDATE bulk_upload_jobs
       SET ${assignments.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}`,
      values,
      executor
    );
  }
  if (hasErrorsPatch) {
    await replaceBulkUploadJobErrors(id, patch.errors, executor);
    if (!assignments.length) {
      await query('UPDATE bulk_upload_jobs SET updated_at = NOW() WHERE id = $1', [id], executor);
    }
  }
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
  throw normalizedStorageError(entity);
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
    `INSERT INTO email_logs (id, recipient, subject, body_html, body_text, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      Array.isArray(payload.to) ? payload.to.join(', ') : (payload.to || null),
      payload.subject || null,
      payload.html || null,
      payload.body || null,
      payload.status || 'logged_only',
      nowIso()
    ]
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
