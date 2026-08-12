import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client, Pool } from 'pg';
import {
  entityRegistry,
  ensureKnownEntity,
  validateEntityPayload,
  getSystemRoleDefinition
} from './entities.js';

const rootDir = path.resolve(process.cwd());
const uploadsDir = path.join(rootDir, 'uploads');

await fs.mkdir(uploadsDir, { recursive: true });

const envValue = (key, fallback = '') => (process.env[key] || fallback).trim();

const connectionString = envValue('DATABASE_URL') || [
  `postgresql://${encodeURIComponent(envValue('POSTGRES_USER', 'foodpro'))}`,
  `:${encodeURIComponent(envValue('POSTGRES_PASSWORD', 'foodpro'))}`,
  `@${envValue('POSTGRES_HOST', '127.0.0.1')}`,
  `:${envValue('POSTGRES_PORT', '5432')}`,
  `/${encodeURIComponent(envValue('POSTGRES_DB', 'foodpro'))}`
].join('');

const pool = new Pool({
  connectionString,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false
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

  return {
    id: withDefaults.id || existing?.id || randomId(entity.toLowerCase()),
    created_date: withDefaults.created_date || existing?.created_date || nowIso(),
    updated_date: nowIso(),
    ...withDefaults
  };
}

async function findRoleProfileByKey(roleKey, executor = pool) {
  const normalized = String(roleKey || '').trim().toLowerCase();
  if (!normalized) {
    return null;
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

  if (result.rowCount) {
    return result.rows[0].data;
  }

  const builtIn = getSystemRoleDefinition(normalized);
  if (!builtIn) {
    return null;
  }

  return {
    id: `role_${builtIn.role_key}`,
    ...builtIn,
    is_system: true,
    is_active: true
  };
}

async function hydrateUserRole(user, executor = pool) {
  if (!user) return null;

  const roleProfile = await findRoleProfileByKey(user.role || 'user', executor);
  const accessLevel = roleProfile?.access_level || (['admin', 'manager', 'user'].includes(user.role) ? user.role : 'user');
  const rolePermissions = Array.isArray(roleProfile?.permissions) ? roleProfile.permissions : [];

  return {
    ...user,
    role_name: roleProfile?.name || user.role || 'User',
    role_access_level: accessLevel,
    role_permissions: rolePermissions,
    is_custom_role: !['admin', 'manager', 'user'].includes(String(user.role || '').toLowerCase())
  };
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
  ['from_site_id', 'Site'],
  ['to_site_id', 'Site'],
  ['parent_site_id', 'Site'],
  ['ingredient_id', 'Ingredient'],
  ['recipe_id', 'Recipe'],
  ['budget_id', 'Budget'],
  ['menu_plan_id', 'MenuPlan'],
  ['production_id', 'Production'],
  ['source_production_id', 'Production'],
  ['linked_material_request_id', 'MaterialRequest'],
  ['inventory_lot_id', 'InventoryLot'],
  ['scenario_id', 'ForecastScenario'],
  ['latest_snapshot_id', 'ForecastSnapshot']
]);

const arrayReferenceTargets = new Map([
  ['site_ids', 'Site'],
  ['allowed_site_ids', 'Site']
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
      parentId = parent.parent_site_id ? String(parent.parent_site_id) : '';
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
  await query(sql);
  await ensureAdminAccounts();
}

async function ensureAdminAccounts() {
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
    const existingUser = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [admin.email]);

    if (existingUser.rowCount > 0) {
      await query(
        `UPDATE users
         SET full_name = $2,
             role = 'admin',
             status = 'active',
             password_hash = $3,
             updated_at = NOW()
         WHERE email = $1`,
        [admin.email, admin.fullName, passwordHash]
      );
      continue;
    }

    await query(
      `INSERT INTO users (id, email, full_name, role, status, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', 'active', $4, NOW(), NOW())`,
      [randomId('user'), admin.email, admin.fullName, passwordHash]
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
      [seededUser.email]
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
        ]
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
  const merged = {
    ...existing,
    ...patch,
    ...credentials,
    id,
    updated_date: nowIso()
  };
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

async function listDocuments(entity, { filters = {}, sort, limit, lock = false } = {}, executor = pool) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    const filtered = (await listUsers(executor)).filter((record) => matchesFilter(record, filters));
    const sorted = sortRecords(filtered, sort);
    return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
  }

  const result = await query(
    `SELECT data
     FROM entity_records
     WHERE entity_name = $1
     ORDER BY updated_at DESC
     ${lock ? 'FOR UPDATE' : ''}`,
    [entity],
    executor
  );
  const records = result.rows.map((row) => row.data).filter((record) => matchesFilter(record, filters));
  const sorted = sortRecords(records, sort);
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
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
  return result.rowCount ? result.rows[0].data : null;
}

async function createDocument(entity, payload, executor = null) {
  if (!executor) {
    return withTransaction((client) => createDocument(entity, payload, client));
  }

  ensureKnownEntity(entity);
  if (entity === 'User') {
    return createUser(payload, executor);
  }

  const validated = validateEntityPayload(entity, payload);
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

  const validated = validateEntityPayload(entity, { ...existing, ...patch });
  const record = normalizeRecord(entity, validated, existing);
  await validateDocumentRelationships(entity, record, id, executor);
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
  uploadsDir,
  initDatabase,
  listDocuments,
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
  createEmailLog
};
