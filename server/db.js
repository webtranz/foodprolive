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
  validateCanonicalSiteParent,
  validateSiteChildrenForParent
} from '../shared/siteHierarchy.js';
import {
  getRoleLocationPolicy,
  isRolePrimarySiteType,
  normalizeRoleLocationFields
} from '../shared/roleLocationPolicy.js';

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

  const result = await query(
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
    { label: 'supplier price history', sql: 'SELECT id FROM supplier_price_history WHERE site_id = $1 LIMIT 1' }
  ],
  Ingredient: [
    { label: 'purchase request item', sql: 'SELECT id FROM purchase_request_items WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'purchase order item', sql: 'SELECT id FROM purchase_order_items WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'goods receipt item', sql: 'SELECT id FROM goods_receipt_items WHERE ingredient_id = $1 LIMIT 1' },
    { label: 'supplier price history', sql: 'SELECT id FROM supplier_price_history WHERE ingredient_id = $1 LIMIT 1' }
  ],
  Recipe: [
    { label: 'POS recipe mapping', sql: 'SELECT id FROM pos_recipe_mapping WHERE recipe_id = $1 LIMIT 1' },
    { label: 'POS sales item', sql: 'SELECT id FROM pos_sales_items WHERE recipe_id = $1 LIMIT 1' }
  ]
};

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

  const documentRows = await query(
    `SELECT id, entity_name, data
     FROM entity_records
     WHERE NOT (entity_name = $1 AND id = $2)
     FOR SHARE`,
    [entity, id],
    executor
  );

  const documentReference = documentRows.rows.find((row) =>
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
  const result = await query(
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
             status = 'active',
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

async function listDocuments(
  entity,
  { filters = {}, sort, limit, offset = 0, lock = false, location = null } = {},
  executor = pool
) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    const filtered = (await listUsers(executor)).filter((record) => matchesFilter(record, filters));
    const sorted = sortRecords(filtered, sort);
    const start = Math.max(0, Number(offset) || 0);
    return typeof limit === 'number' ? sorted.slice(start, start + limit) : sorted.slice(start);
  }

  const built = buildEntityListQuery({ entity, filters, sort, limit, offset, lock, location });
  const result = await query(built.text, built.parameters, executor);
  return result.rows.map((row) => hydrateDerivedFields(entity, row.data));
}

async function listDocumentsPage(
  entity,
  { filters = {}, sort, limit = 50, offset = 0, location = null } = {},
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

  const built = buildEntityListQuery({
    entity,
    filters,
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
  return result.rowCount ? sanitizeUser(await hydrateUserRole(toUserRecord(result.rows[0]))) : null;
}

async function revokeToken(token) {
  await query('DELETE FROM auth_tokens WHERE token = $1', [token]);
}

async function loginUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.password_hash) {
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
  site_name = null
}, executor = pool) {
  const id = randomId('bulk');
  const createdAt = nowIso();
  const actorSnapshot = actor ? sanitizeUser(actor) : {};
  await query(
    `INSERT INTO bulk_upload_jobs (
       id, module_key, entity_name, import_mode, file_name, file_path, file_size,
       batch_size, actor_id, actor_email, actor_name, role, site_id, site_name,
       actor_snapshot, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $16)`,
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
  if (entity === 'User') {
    const error = new Error('Users cannot be deleted through bulk upload.');
    error.status = 400;
    throw error;
  }
  if (Array.isArray(siteIds)) {
    if (!siteIds.length) return 0;
    const result = entity === 'Site'
      ? await query('DELETE FROM entity_records WHERE entity_name = $1 AND id = ANY($2::text[])', [entity, siteIds], executor)
      : await query(
        `DELETE FROM entity_records
         WHERE entity_name = $1 AND data->>'site_id' = ANY($2::text[])`,
        [entity, siteIds],
        executor
      );
    return result.rowCount;
  }
  const result = await query('DELETE FROM entity_records WHERE entity_name = $1', [entity], executor);
  return result.rowCount;
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
  sanitizeUser,
  getUserByToken,
  revokeToken,
  loginUser,
  inviteUser,
  createAppLog,
  createAuditLog,
  listAuditLogs,
  createBulkUploadJob,
  getBulkUploadJob,
  listBulkUploadJobs,
  updateBulkUploadJob,
  claimNextBulkUploadJob,
  clearDocumentsForBulk,
  createEmailLog,
  invalidateRoleProfileCache
};
