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

async function findRoleProfileByKey(roleKey) {
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
    [normalized]
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

async function hydrateUserRole(user) {
  if (!user) return null;

  const roleProfile = await findRoleProfileByKey(user.role || 'user');
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

async function ensureEntityUniqueness(entity, record, currentId = null) {
  const config = entityRegistry[entity];
  const uniqueRules = config?.unique || [];
  if (!uniqueRules.length) {
    return;
  }

  const records = await listDocuments(entity, { limit: 10000 });
  for (const rule of uniqueRules) {
    const fields = Array.isArray(rule.fields) ? rule.fields : [];
    if (!fields.length) continue;

    const candidateValues = fields.map((field) => record[field]);
    if (rule.ignoreEmpty && candidateValues.some((value) => normalizeUniqueValue(value) === '')) {
      continue;
    }

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

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDatabase() {
  await ensureDatabaseExists();
  const sqlPath = path.join(rootDir, 'server', 'sql', 'init.sql');
  const sql = await fs.readFile(sqlPath, 'utf8');
  await query(sql);
  await seedDefaults();
}

async function seedDefaults() {
  const adminEmail = process.env.ADMIN_EMAIL || 'humayoonkhizar12@gmail.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Tafga@2030';
  const adminName = process.env.ADMIN_NAME || 'Humayun Khizar';

  const existingSite = await query(`SELECT id FROM entity_records WHERE entity_name = 'Site' LIMIT 1`);
  if (existingSite.rowCount === 0) {
    const siteId = randomId('site');
    const timestamp = nowIso();
    await query(
      `INSERT INTO entity_records (id, entity_name, data, created_at, updated_at)
       VALUES ($1, 'Site', $2::jsonb, $3, $3)`,
      [siteId, JSON.stringify({
        id: siteId,
        name: 'Main Production Kitchen',
        project_code: 'MAIN',
        type: 'kitchen',
        city: 'Riyadh',
        country: 'Saudi Arabia',
        is_active: true,
        created_date: timestamp,
        updated_date: timestamp
      }), timestamp]
    );
  }

  const ensureSeedDocument = async (entity, id, payload) => {
    const existing = await findDocument(entity, id);
    if (existing) return existing;
    return createDocument(entity, { id, ...payload });
  };

  const roleSeeds = [
    {
      id: 'role_profile_admin',
      role_key: 'admin',
      name: 'Administrator',
      description: 'Central administration with unrestricted access across all modules and locations.',
      access_level: 'admin',
      permissions: getSystemRoleDefinition('admin')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_manager',
      role_key: 'manager',
      name: 'Operations Manager',
      description: 'Cross-functional operational management for assigned projects and kitchens.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('manager')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_user',
      role_key: 'user',
      name: 'General User',
      description: 'Basic operational visibility for assigned projects.',
      access_level: 'user',
      permissions: getSystemRoleDefinition('user')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_chef',
      role_key: 'chef',
      name: 'Chef',
      description: 'Kitchen leadership role focused on recipes, menus, production, and food quality.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('chef')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_storekeeper',
      role_key: 'storekeeper',
      name: 'Storekeeper',
      description: 'Warehouse and stock control role for receiving, adjustments, and transfers.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('storekeeper')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_procurement_officer',
      role_key: 'procurement_officer',
      name: 'Procurement Officer',
      description: 'Procurement role for suppliers, requests, orders, and invoices.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('procurement_officer')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_production_supervisor',
      role_key: 'production_supervisor',
      name: 'Production Supervisor',
      description: 'Supervises planning, approvals, batch completion, and kitchen execution.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('production_supervisor')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_quality_controller',
      role_key: 'quality_controller',
      name: 'Quality Controller',
      description: 'Monitors quality, compliance, and food waste control with approval authority.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('quality_controller')?.permissions || [],
      is_system: true,
      is_active: true
    },
    {
      id: 'role_profile_finance_controller',
      role_key: 'finance_controller',
      name: 'Finance Controller',
      description: 'Reviews costs, exports, and ERP/accounting integrations.',
      access_level: 'manager',
      permissions: getSystemRoleDefinition('finance_controller')?.permissions || [],
      is_system: true,
      is_active: true
    }
  ];

  for (const roleSeed of roleSeeds) {
    const existingRole = await findDocument('RoleProfile', roleSeed.id);
    if (existingRole) {
      await updateDocument('RoleProfile', roleSeed.id, roleSeed);
    } else {
      await createDocument('RoleProfile', roleSeed);
    }
  }

  const siteRecords = await listDocuments('Site', { sort: 'name', limit: 100 });
  const primarySite = siteRecords[0] || null;

  const branchKitchen = primarySite ? await ensureSeedDocument('Site', 'site_demo_branch_kitchen', {
    name: 'Airport Branch Kitchen',
    project_code: 'BRN-01',
    type: 'kitchen',
    hierarchy_level: 'kitchen',
    parent_site_id: primarySite.id,
    parent_site_name: primarySite.name,
    hierarchy_path: `${primarySite.name} / Airport Branch Kitchen`,
    company_name: primarySite.company_name || 'Tamimi Global',
    region_name: primarySite.region_name || 'Central Region',
    location_name: 'Riyadh Airport',
    kitchen_name: 'Airport Branch Kitchen',
    city: 'Riyadh',
    country: 'Saudi Arabia',
    capacity: 650,
    is_active: true
  }) : null;

  const campKitchen = primarySite ? await ensureSeedDocument('Site', 'site_demo_camp_kitchen', {
    name: 'North Camp Kitchen',
    project_code: 'CMP-01',
    type: 'camp',
    hierarchy_level: 'location',
    parent_site_id: primarySite.id,
    parent_site_name: primarySite.name,
    hierarchy_path: `${primarySite.name} / North Camp Kitchen`,
    company_name: primarySite.company_name || 'Tamimi Global',
    region_name: primarySite.region_name || 'Central Region',
    location_name: 'North Camp',
    kitchen_name: 'North Camp Kitchen',
    city: 'Riyadh',
    country: 'Saudi Arabia',
    capacity: 900,
    is_active: true
  }) : null;

  const warehouseSite = primarySite ? await ensureSeedDocument('Site', 'site_demo_central_warehouse', {
    name: 'Central Dry Store',
    project_code: 'STORE-01',
    type: 'warehouse',
    hierarchy_level: 'store',
    parent_site_id: primarySite.id,
    parent_site_name: primarySite.name,
    hierarchy_path: `${primarySite.name} / Central Dry Store`,
    company_name: primarySite.company_name || 'Tamimi Global',
    region_name: primarySite.region_name || 'Central Region',
    location_name: primarySite.location_name || 'Riyadh',
    kitchen_name: primarySite.kitchen_name || primarySite.name,
    storage_name: 'Central Dry Store',
    city: primarySite.city || 'Riyadh',
    country: primarySite.country || 'Saudi Arabia',
    is_active: true
  }) : null;

  const coldStore = primarySite ? await ensureSeedDocument('Site', 'site_demo_cold_store', {
    name: 'Central Cold Store',
    project_code: 'COLD-01',
    type: 'warehouse',
    hierarchy_level: 'store',
    parent_site_id: primarySite.id,
    parent_site_name: primarySite.name,
    hierarchy_path: `${primarySite.name} / Central Cold Store`,
    company_name: primarySite.company_name || 'Tamimi Global',
    region_name: primarySite.region_name || 'Central Region',
    location_name: primarySite.location_name || 'Riyadh',
    kitchen_name: primarySite.kitchen_name || primarySite.name,
    storage_name: 'Central Cold Store',
    city: primarySite.city || 'Riyadh',
    country: primarySite.country || 'Saudi Arabia',
    is_active: true
  }) : null;

  const seededSiteRecords = await listDocuments('Site', { sort: 'name', limit: 200 });
  const warehouseLocations = seededSiteRecords.filter((site) => ['warehouse', 'store'].includes(String(site.type || '').toLowerCase()));

  const ingredientSeeds = [
    ['ingredient_chicken_breast', { name: 'Chicken Breast', unit: 'kg', category: 'protein', cuisine_type: 'universal', cost_per_unit: 24, calories_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6, sodium_per_100g: 74, sugar_per_100g: 0, cooking_yield_percent: 78, shrinkage_percent: 22, raw_weight_per_unit: 1000, cooked_weight_per_unit: 780, allergens: [] }],
    ['ingredient_basmati_rice', { name: 'Basmati Rice', unit: 'kg', category: 'grain', cuisine_type: 'middle_eastern', cost_per_unit: 8.5, calories_per_100g: 365, protein_per_100g: 7.1, carbs_per_100g: 80, fat_per_100g: 0.7, sodium_per_100g: 5, sugar_per_100g: 0.1, cooking_yield_percent: 260, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 2600, allergens: [] }],
    ['ingredient_yogurt', { name: 'Plain Yogurt', unit: 'kg', category: 'dairy', cuisine_type: 'middle_eastern', cost_per_unit: 7, calories_per_100g: 61, protein_per_100g: 3.5, carbs_per_100g: 4.7, fat_per_100g: 3.3, sodium_per_100g: 46, sugar_per_100g: 4.7, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: ['dairy'] }],
    ['ingredient_mixed_vegetables', { name: 'Mixed Vegetables', unit: 'kg', category: 'vegetable', cuisine_type: 'universal', cost_per_unit: 9.75, calories_per_100g: 45, protein_per_100g: 2.2, carbs_per_100g: 8.8, fat_per_100g: 0.4, sodium_per_100g: 48, sugar_per_100g: 3.6, cooking_yield_percent: 92, shrinkage_percent: 8, raw_weight_per_unit: 1000, cooked_weight_per_unit: 920, allergens: [] }],
    ['ingredient_flatbread', { name: 'Arabic Flatbread', unit: 'pieces', category: 'bakery', cuisine_type: 'middle_eastern', cost_per_unit: 1.2, calories_per_100g: 275, protein_per_100g: 9, carbs_per_100g: 55, fat_per_100g: 1.2, sodium_per_100g: 510, sugar_per_100g: 2.5, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 90, cooked_weight_per_unit: 90, allergens: ['gluten'] }],
    ['ingredient_hummus', { name: 'Hummus', unit: 'kg', category: 'dip', cuisine_type: 'middle_eastern', cost_per_unit: 12.5, calories_per_100g: 166, protein_per_100g: 7.9, carbs_per_100g: 14.3, fat_per_100g: 9.6, sodium_per_100g: 240, sugar_per_100g: 0.3, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: ['sesame'] }],
    ['ingredient_beef_mince', { name: 'Beef Mince', unit: 'kg', category: 'protein', cuisine_type: 'middle_eastern', cost_per_unit: 32, calories_per_100g: 250, protein_per_100g: 26, carbs_per_100g: 0, fat_per_100g: 15, sodium_per_100g: 72, sugar_per_100g: 0, cooking_yield_percent: 80, shrinkage_percent: 20, raw_weight_per_unit: 1000, cooked_weight_per_unit: 800, allergens: [] }],
    ['ingredient_potato', { name: 'Potato', unit: 'kg', category: 'vegetable', cuisine_type: 'universal', cost_per_unit: 4.25, calories_per_100g: 77, protein_per_100g: 2, carbs_per_100g: 17, fat_per_100g: 0.1, sodium_per_100g: 6, sugar_per_100g: 0.8, cooking_yield_percent: 88, shrinkage_percent: 12, raw_weight_per_unit: 1000, cooked_weight_per_unit: 880, allergens: [] }],
    ['ingredient_lentils', { name: 'Red Lentils', unit: 'kg', category: 'legume', cuisine_type: 'middle_eastern', cost_per_unit: 6.8, calories_per_100g: 352, protein_per_100g: 24, carbs_per_100g: 63, fat_per_100g: 1.1, sodium_per_100g: 6, sugar_per_100g: 2, cooking_yield_percent: 240, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 2400, allergens: [] }],
    ['ingredient_pasta_penne', { name: 'Penne Pasta', unit: 'kg', category: 'grain', cuisine_type: 'italian', cost_per_unit: 7.2, calories_per_100g: 371, protein_per_100g: 13, carbs_per_100g: 75, fat_per_100g: 1.5, sodium_per_100g: 6, sugar_per_100g: 2.7, cooking_yield_percent: 220, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 2200, allergens: ['gluten'] }],
    ['ingredient_tomato_sauce', { name: 'Tomato Sauce', unit: 'kg', category: 'sauce', cuisine_type: 'italian', cost_per_unit: 5.5, calories_per_100g: 50, protein_per_100g: 1.7, carbs_per_100g: 10, fat_per_100g: 0.2, sodium_per_100g: 427, sugar_per_100g: 7.5, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: [] }],
    ['ingredient_salmon_fillet', { name: 'Salmon Fillet', unit: 'kg', category: 'seafood', cuisine_type: 'mediterranean', cost_per_unit: 48, calories_per_100g: 208, protein_per_100g: 20, carbs_per_100g: 0, fat_per_100g: 13, sodium_per_100g: 59, sugar_per_100g: 0, cooking_yield_percent: 84, shrinkage_percent: 16, raw_weight_per_unit: 1000, cooked_weight_per_unit: 840, allergens: ['seafood'] }],
    ['ingredient_eggs', { name: 'Eggs', unit: 'pieces', category: 'protein', cuisine_type: 'breakfast', cost_per_unit: 0.55, calories_per_100g: 155, protein_per_100g: 13, carbs_per_100g: 1.1, fat_per_100g: 11, sodium_per_100g: 124, sugar_per_100g: 1.1, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 50, cooked_weight_per_unit: 50, allergens: ['eggs'] }],
    ['ingredient_milk', { name: 'Fresh Milk', unit: 'l', category: 'dairy', cuisine_type: 'breakfast', cost_per_unit: 4.1, calories_per_100g: 42, protein_per_100g: 3.4, carbs_per_100g: 5, fat_per_100g: 1, sodium_per_100g: 44, sugar_per_100g: 5, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: ['dairy'] }],
    ['ingredient_chickpeas', { name: 'Boiled Chickpeas', unit: 'kg', category: 'legume', cuisine_type: 'middle_eastern', cost_per_unit: 6.2, calories_per_100g: 164, protein_per_100g: 8.9, carbs_per_100g: 27.4, fat_per_100g: 2.6, sodium_per_100g: 24, sugar_per_100g: 4.8, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: [] }],
    ['ingredient_onion', { name: 'Onion', unit: 'kg', category: 'vegetable', cuisine_type: 'universal', cost_per_unit: 3.4, calories_per_100g: 40, protein_per_100g: 1.1, carbs_per_100g: 9.3, fat_per_100g: 0.1, sodium_per_100g: 4, sugar_per_100g: 4.2, cooking_yield_percent: 89, shrinkage_percent: 11, raw_weight_per_unit: 1000, cooked_weight_per_unit: 890, allergens: [] }],
    ['ingredient_tomato', { name: 'Tomato', unit: 'kg', category: 'vegetable', cuisine_type: 'universal', cost_per_unit: 4.8, calories_per_100g: 18, protein_per_100g: 0.9, carbs_per_100g: 3.9, fat_per_100g: 0.2, sodium_per_100g: 5, sugar_per_100g: 2.6, cooking_yield_percent: 95, shrinkage_percent: 5, raw_weight_per_unit: 1000, cooked_weight_per_unit: 950, allergens: [] }],
    ['ingredient_garlic', { name: 'Garlic', unit: 'kg', category: 'aromatic', cuisine_type: 'universal', cost_per_unit: 9.5, calories_per_100g: 149, protein_per_100g: 6.4, carbs_per_100g: 33, fat_per_100g: 0.5, sodium_per_100g: 17, sugar_per_100g: 1, cooking_yield_percent: 92, shrinkage_percent: 8, raw_weight_per_unit: 1000, cooked_weight_per_unit: 920, allergens: [] }],
    ['ingredient_olive_oil', { name: 'Olive Oil', unit: 'l', category: 'oil', cuisine_type: 'mediterranean', cost_per_unit: 18, calories_per_100g: 884, protein_per_100g: 0, carbs_per_100g: 0, fat_per_100g: 100, sodium_per_100g: 2, sugar_per_100g: 0, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: [] }],
    ['ingredient_flour', { name: 'All Purpose Flour', unit: 'kg', category: 'bakery', cuisine_type: 'universal', cost_per_unit: 4.6, calories_per_100g: 364, protein_per_100g: 10.3, carbs_per_100g: 76.3, fat_per_100g: 1, sodium_per_100g: 2, sugar_per_100g: 0.3, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: ['gluten'] }],
    ['ingredient_sugar', { name: 'Sugar', unit: 'kg', category: 'bakery', cuisine_type: 'universal', cost_per_unit: 3.9, calories_per_100g: 387, protein_per_100g: 0, carbs_per_100g: 100, fat_per_100g: 0, sodium_per_100g: 1, sugar_per_100g: 100, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: [] }],
    ['ingredient_butter', { name: 'Butter', unit: 'kg', category: 'dairy', cuisine_type: 'bakery', cost_per_unit: 22, calories_per_100g: 717, protein_per_100g: 0.9, carbs_per_100g: 0.1, fat_per_100g: 81, sodium_per_100g: 11, sugar_per_100g: 0.1, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: ['dairy'] }],
    ['ingredient_cheese', { name: 'Cheddar Cheese', unit: 'kg', category: 'dairy', cuisine_type: 'breakfast', cost_per_unit: 26, calories_per_100g: 403, protein_per_100g: 25, carbs_per_100g: 1.3, fat_per_100g: 33, sodium_per_100g: 621, sugar_per_100g: 0.5, cooking_yield_percent: 100, shrinkage_percent: 0, raw_weight_per_unit: 1000, cooked_weight_per_unit: 1000, allergens: ['dairy'] }],
    ['ingredient_lettuce', { name: 'Lettuce', unit: 'kg', category: 'vegetable', cuisine_type: 'universal', cost_per_unit: 7.4, calories_per_100g: 15, protein_per_100g: 1.4, carbs_per_100g: 2.9, fat_per_100g: 0.2, sodium_per_100g: 28, sugar_per_100g: 0.8, cooking_yield_percent: 90, shrinkage_percent: 10, raw_weight_per_unit: 1000, cooked_weight_per_unit: 900, allergens: [] }],
    ['ingredient_cucumber', { name: 'Cucumber', unit: 'kg', category: 'vegetable', cuisine_type: 'universal', cost_per_unit: 5.2, calories_per_100g: 15, protein_per_100g: 0.7, carbs_per_100g: 3.6, fat_per_100g: 0.1, sodium_per_100g: 2, sugar_per_100g: 1.7, cooking_yield_percent: 96, shrinkage_percent: 4, raw_weight_per_unit: 1000, cooked_weight_per_unit: 960, allergens: [] }]
  ];

  for (const [id, payload] of ingredientSeeds) {
    await ensureSeedDocument('Ingredient', id, payload);
  }

  const availableIngredients = await listDocuments('Ingredient', { sort: 'name', limit: 200 });

  const recipeSeeds = [
    ['recipe_chicken_kabsa', { name: 'Chicken Kabsa', recipe_code: 'RCP-001', recipe_type: 'full', category: 'lunch', cuisine_type: 'middle_eastern', description: 'Saudi-style spiced rice with roasted chicken and vegetables.', prep_time_minutes: 40, cook_time_minutes: 65, servings: 25, instructions: 'Marinate chicken, roast until tender, cook rice with stock and spices, and portion with vegetables.', ingredients: [{ ingredient_id: 'ingredient_chicken_breast', ingredient_name: 'Chicken Breast', quantity: 6, unit: 'kg' }, { ingredient_id: 'ingredient_basmati_rice', ingredient_name: 'Basmati Rice', quantity: 4.5, unit: 'kg' }, { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 1.5, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_chicken_shawarma_wrap', { name: 'Chicken Shawarma Wrap', recipe_code: 'RCP-002', recipe_type: 'full', category: 'dinner', cuisine_type: 'middle_eastern', description: 'Grilled chicken wrapped in Arabic bread with yogurt sauce.', prep_time_minutes: 30, cook_time_minutes: 20, servings: 20, instructions: 'Season chicken, grill in batches, assemble wraps with sauce and garnish.', ingredients: [{ ingredient_id: 'ingredient_chicken_breast', ingredient_name: 'Chicken Breast', quantity: 4, unit: 'kg' }, { ingredient_id: 'ingredient_flatbread', ingredient_name: 'Arabic Flatbread', quantity: 20, unit: 'pieces' }, { ingredient_id: 'ingredient_yogurt', ingredient_name: 'Plain Yogurt', quantity: 1.2, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_hummus_platter', { name: 'Hummus Mezze Platter', recipe_code: 'RCP-003', recipe_type: 'full', category: 'snack', cuisine_type: 'middle_eastern', description: 'Shared platter with hummus, flatbread, and fresh vegetables.', prep_time_minutes: 15, cook_time_minutes: 0, servings: 12, instructions: 'Plate hummus, cut flatbread, and garnish with vegetables.', ingredients: [{ ingredient_id: 'ingredient_hummus', ingredient_name: 'Hummus', quantity: 1.5, unit: 'kg' }, { ingredient_id: 'ingredient_flatbread', ingredient_name: 'Arabic Flatbread', quantity: 10, unit: 'pieces' }, { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 0.8, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_beef_kofta_rice_bowl', { name: 'Beef Kofta Rice Bowl', recipe_code: 'RCP-004', recipe_type: 'full', category: 'lunch', cuisine_type: 'middle_eastern', description: 'Grilled kofta over rice with vegetables.', prep_time_minutes: 45, cook_time_minutes: 30, servings: 22, instructions: 'Shape kofta, grill until cooked, cook rice and serve with vegetables.', ingredients: [{ ingredient_id: 'ingredient_beef_mince', ingredient_name: 'Beef Mince', quantity: 5.2, unit: 'kg' }, { ingredient_id: 'ingredient_basmati_rice', ingredient_name: 'Basmati Rice', quantity: 4, unit: 'kg' }, { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 1.4, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_lentil_soup', { name: 'Red Lentil Soup', recipe_code: 'RCP-005', recipe_type: 'full', category: 'dinner', cuisine_type: 'middle_eastern', description: 'Comforting lentil soup for camps and staff meals.', prep_time_minutes: 20, cook_time_minutes: 35, servings: 30, instructions: 'Simmer lentils with vegetables until tender and blend lightly.', ingredients: [{ ingredient_id: 'ingredient_lentils', ingredient_name: 'Red Lentils', quantity: 3.5, unit: 'kg' }, { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 1.2, unit: 'kg' }, { ingredient_id: 'ingredient_tomato_sauce', ingredient_name: 'Tomato Sauce', quantity: 1.1, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_salmon_tray_bake', { name: 'Herb Salmon Tray Bake', recipe_code: 'RCP-006', recipe_type: 'full', category: 'dinner', cuisine_type: 'mediterranean', description: 'Premium salmon with potatoes and vegetables.', prep_time_minutes: 25, cook_time_minutes: 30, servings: 18, instructions: 'Season salmon, tray bake with potatoes and vegetables, and portion hot.', ingredients: [{ ingredient_id: 'ingredient_salmon_fillet', ingredient_name: 'Salmon Fillet', quantity: 4.5, unit: 'kg' }, { ingredient_id: 'ingredient_potato', ingredient_name: 'Potato', quantity: 3.8, unit: 'kg' }, { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 1.6, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_pasta_bake', { name: 'Vegetable Pasta Bake', recipe_code: 'RCP-007', recipe_type: 'full', category: 'lunch', cuisine_type: 'italian', description: 'Hearty baked pasta for bulk catering service.', prep_time_minutes: 35, cook_time_minutes: 40, servings: 28, instructions: 'Boil pasta, combine with sauce and vegetables, bake until set.', ingredients: [{ ingredient_id: 'ingredient_pasta_penne', ingredient_name: 'Penne Pasta', quantity: 4.2, unit: 'kg' }, { ingredient_id: 'ingredient_tomato_sauce', ingredient_name: 'Tomato Sauce', quantity: 2.5, unit: 'kg' }, { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 2, unit: 'kg' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }],
    ['recipe_scrambled_eggs_breakfast', { name: 'Scrambled Eggs Breakfast Tray', recipe_code: 'RCP-008', recipe_type: 'full', category: 'breakfast', cuisine_type: 'breakfast', description: 'Breakfast tray with eggs, flatbread, and milk.', prep_time_minutes: 15, cook_time_minutes: 12, servings: 24, instructions: 'Whisk eggs with milk, cook in trays, and serve with flatbread.', ingredients: [{ ingredient_id: 'ingredient_eggs', ingredient_name: 'Eggs', quantity: 48, unit: 'pieces' }, { ingredient_id: 'ingredient_milk', ingredient_name: 'Fresh Milk', quantity: 2.4, unit: 'l' }, { ingredient_id: 'ingredient_flatbread', ingredient_name: 'Arabic Flatbread', quantity: 24, unit: 'pieces' }], site_scope: 'global', site_ids: primarySite ? [primarySite.id] : [], site_names: primarySite ? [primarySite.name] : [] }]
  ];

  for (const [id, payload] of recipeSeeds) {
    await ensureSeedDocument('Recipe', id, payload);
  }

  const availableRecipes = await listDocuments('Recipe', { sort: 'name', limit: 200 });
  const recipeMap = new Map(availableRecipes.map((recipe) => [recipe.id, recipe]));

  const buildMeal = (recipeId, mealType, servings) => {
    const recipe = recipeMap.get(recipeId);
    return {
      meal_type: mealType,
      recipe_id: recipeId,
      recipe_name: recipe?.name || '',
      expected_servings: servings,
      calories_per_serving: recipe?.calories_per_serving || 0,
      protein_per_serving: recipe?.protein_per_serving || 0,
      carbs_per_serving: recipe?.carbs_per_serving || 0,
      fat_per_serving: recipe?.fat_per_serving || 0,
      sodium_per_serving: recipe?.sodium_per_serving || 0,
      sugar_per_serving: recipe?.sugar_per_serving || 0,
      allergens: recipe?.allergens || []
    };
  };

  const menuPlanSeeds = [];
  if (primarySite) {
    menuPlanSeeds.push(
      ['menuplan_demo_main_0', { site_id: primarySite.id, site_name: primarySite.name, plan_date: dateOnlyOffset(0), status: 'planned', meals: [buildMeal('recipe_scrambled_eggs_breakfast', 'breakfast', 80), buildMeal('recipe_chicken_kabsa', 'lunch', 120), buildMeal('recipe_chicken_shawarma_wrap', 'dinner', 90)] }],
      ['menuplan_demo_main_1', { site_id: primarySite.id, site_name: primarySite.name, plan_date: dateOnlyOffset(1), status: 'draft', meals: [buildMeal('recipe_hummus_platter', 'snack', 60), buildMeal('recipe_beef_kofta_rice_bowl', 'lunch', 110), buildMeal('recipe_lentil_soup', 'dinner', 100)] }],
      ['menuplan_demo_main_2', { site_id: primarySite.id, site_name: primarySite.name, plan_date: dateOnlyOffset(2), status: 'planned', meals: [buildMeal('recipe_scrambled_eggs_breakfast', 'breakfast', 75), buildMeal('recipe_pasta_bake', 'lunch', 95), buildMeal('recipe_salmon_tray_bake', 'dinner', 70)] }],
      ['menuplan_demo_main_3', { site_id: primarySite.id, site_name: primarySite.name, plan_date: dateOnlyOffset(3), status: 'planned', meals: [buildMeal('recipe_hummus_platter', 'snack', 55), buildMeal('recipe_chicken_kabsa', 'lunch', 115), buildMeal('recipe_lentil_soup', 'dinner', 95)] }]
    );
  }
  if (branchKitchen) {
    menuPlanSeeds.push(
      ['menuplan_demo_branch_0', { site_id: branchKitchen.id, site_name: branchKitchen.name, plan_date: dateOnlyOffset(0), status: 'planned', meals: [buildMeal('recipe_scrambled_eggs_breakfast', 'breakfast', 45), buildMeal('recipe_chicken_shawarma_wrap', 'lunch', 85), buildMeal('recipe_pasta_bake', 'dinner', 70)] }],
      ['menuplan_demo_branch_1', { site_id: branchKitchen.id, site_name: branchKitchen.name, plan_date: dateOnlyOffset(1), status: 'planned', meals: [buildMeal('recipe_hummus_platter', 'snack', 35), buildMeal('recipe_beef_kofta_rice_bowl', 'lunch', 80), buildMeal('recipe_lentil_soup', 'dinner', 60)] }]
    );
  }
  if (campKitchen) {
    menuPlanSeeds.push(
      ['menuplan_demo_camp_0', { site_id: campKitchen.id, site_name: campKitchen.name, plan_date: dateOnlyOffset(0), status: 'planned', meals: [buildMeal('recipe_scrambled_eggs_breakfast', 'breakfast', 140), buildMeal('recipe_chicken_kabsa', 'lunch', 220), buildMeal('recipe_lentil_soup', 'dinner', 180)] }],
      ['menuplan_demo_camp_1', { site_id: campKitchen.id, site_name: campKitchen.name, plan_date: dateOnlyOffset(1), status: 'draft', meals: [buildMeal('recipe_scrambled_eggs_breakfast', 'breakfast', 130), buildMeal('recipe_pasta_bake', 'lunch', 170), buildMeal('recipe_beef_kofta_rice_bowl', 'dinner', 160)] }]
    );
  }

  for (const [id, payload] of menuPlanSeeds) {
    const totalExpectedServings = payload.meals.reduce((sum, meal) => sum + (meal.expected_servings || 0), 0);
    const totalCalories = payload.meals.reduce((sum, meal) => sum + ((meal.expected_servings || 0) * (meal.calories_per_serving || 0)), 0);
    await ensureSeedDocument('MenuPlan', id, { ...payload, total_expected_servings: totalExpectedServings, total_calories: totalCalories });
  }

  const ingredientMap = new Map(availableIngredients.map((ingredient) => [ingredient.id, ingredient]));
  const ensureInventorySeed = async ({ site, ingredientId, quantity, minStock, maxStock, batchNumber, expiryDate }) => {
    if (!site) return;
    const ingredient = ingredientMap.get(ingredientId);
    if (!ingredient) return;
    const inventoryId = `inventory_${site.id}_${ingredientId}`;
    const existingInventory = await findDocument('Inventory', inventoryId);
    const timestamp = nowIso();
    const lotId = `lot_${site.id}_${ingredientId}`;
    const transactionId = `txn_${site.id}_${ingredientId}`;
    const totalCost = Number(quantity) * Number(ingredient.cost_per_unit || 0);
    const status = quantity <= minStock ? 'low_stock' : 'in_stock';

    if (existingInventory) {
      const nextQuantity = Math.max(Number(existingInventory.quantity || 0), Number(quantity || 0));
      await updateDocument('Inventory', inventoryId, {
        quantity: nextQuantity,
        min_stock_level: Math.max(Number(existingInventory.min_stock_level || 0), Number(minStock || 0)),
        max_stock_level: Math.max(Number(existingInventory.max_stock_level || 0), Number(maxStock || 0)),
        average_unit_cost: Number(ingredient.cost_per_unit || existingInventory.average_unit_cost || 0),
        total_value: nextQuantity * Number(ingredient.cost_per_unit || existingInventory.average_unit_cost || 0),
        next_expiry_date: existingInventory.next_expiry_date || expiryDate,
        batch_number: existingInventory.batch_number || batchNumber,
        expiry_alert_days: Math.max(Number(existingInventory.expiry_alert_days || 0), 5),
        status: nextQuantity <= Math.max(Number(existingInventory.min_stock_level || 0), Number(minStock || 0)) ? 'low_stock' : 'in_stock',
        valuation_method: existingInventory.valuation_method || 'fifo'
      });
      return;
    }

    await query(
      `INSERT INTO entity_records (id, entity_name, data, created_at, updated_at)
       VALUES
       ($1, 'Inventory', $2::jsonb, $3, $3),
       ($4, 'InventoryLot', $5::jsonb, $3, $3),
       ($6, 'InventoryTransaction', $7::jsonb, $3, $3)`,
      [
        inventoryId,
        JSON.stringify({
          id: inventoryId,
          site_id: site.id,
          site_name: site.name,
          ingredient_id: ingredient.id,
          ingredient_name: ingredient.name,
          quantity,
          unit: ingredient.unit || 'kg',
          min_stock_level: minStock,
          max_stock_level: maxStock,
          average_unit_cost: Number(ingredient.cost_per_unit || 0),
          total_value: totalCost,
          next_expiry_date: expiryDate,
          expiry_alert_days: 5,
          batch_number: batchNumber,
          status,
          valuation_method: 'fifo',
          created_date: timestamp,
          updated_date: timestamp
        }),
        timestamp,
        lotId,
        JSON.stringify({
          id: lotId,
          site_id: site.id,
          site_name: site.name,
          ingredient_id: ingredient.id,
          ingredient_name: ingredient.name,
          quantity_received: quantity,
          remaining_quantity: quantity,
          unit: ingredient.unit || 'kg',
          batch_number: batchNumber,
          lot_number: batchNumber,
          expiry_date: expiryDate,
          unit_cost: Number(ingredient.cost_per_unit || 0),
          total_cost: totalCost,
          status: 'active',
          created_date: timestamp,
          updated_date: timestamp
        }),
        transactionId,
        JSON.stringify({
          id: transactionId,
          site_id: site.id,
          site_name: site.name,
          ingredient_id: ingredient.id,
          ingredient_name: ingredient.name,
          transaction_type: 'receipt',
          quantity,
          unit: ingredient.unit || 'kg',
          unit_cost: Number(ingredient.cost_per_unit || 0),
          total_cost: totalCost,
          batch_number: batchNumber,
          expiry_date: expiryDate,
          notes: 'System demo opening stock',
          status: 'posted',
          created_date: timestamp,
          updated_date: timestamp
        })
      ]
    );
  };

  const inventorySeeds = [
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_chicken_breast', quantity: 120, minStock: 35, maxStock: 180, batchNumber: 'PO-1001-CHKN', expiryDate: dateOnlyOffset(18) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_basmati_rice', quantity: 420, minStock: 120, maxStock: 560, batchNumber: 'PO-1002-RICE', expiryDate: dateOnlyOffset(120) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_yogurt', quantity: 90, minStock: 24, maxStock: 140, batchNumber: 'PO-1003-YGRT', expiryDate: dateOnlyOffset(7) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_mixed_vegetables', quantity: 110, minStock: 30, maxStock: 160, batchNumber: 'PO-1004-VEG', expiryDate: dateOnlyOffset(5) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_flatbread', quantity: 900, minStock: 220, maxStock: 1200, batchNumber: 'PO-1005-BRD', expiryDate: dateOnlyOffset(3) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_hummus', quantity: 65, minStock: 18, maxStock: 90, batchNumber: 'PO-1006-HMMS', expiryDate: dateOnlyOffset(9) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_beef_mince', quantity: 85, minStock: 24, maxStock: 120, batchNumber: 'PO-1007-BEEF', expiryDate: dateOnlyOffset(6) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_potato', quantity: 220, minStock: 60, maxStock: 320, batchNumber: 'PO-1008-POTA', expiryDate: dateOnlyOffset(20) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_lentils', quantity: 150, minStock: 35, maxStock: 220, batchNumber: 'PO-1009-LENT', expiryDate: dateOnlyOffset(200) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_pasta_penne', quantity: 160, minStock: 45, maxStock: 220, batchNumber: 'PO-1010-PASTA', expiryDate: dateOnlyOffset(180) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_tomato_sauce', quantity: 120, minStock: 28, maxStock: 180, batchNumber: 'PO-1011-TOMA', expiryDate: dateOnlyOffset(90) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_salmon_fillet', quantity: 48, minStock: 15, maxStock: 70, batchNumber: 'PO-1012-SALM', expiryDate: dateOnlyOffset(4) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_eggs', quantity: 1200, minStock: 320, maxStock: 1800, batchNumber: 'PO-1013-EGGS', expiryDate: dateOnlyOffset(10) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_milk', quantity: 180, minStock: 45, maxStock: 260, batchNumber: 'PO-1014-MILK', expiryDate: dateOnlyOffset(8) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_chickpeas', quantity: 135, minStock: 30, maxStock: 200, batchNumber: 'PO-1015-CHKP', expiryDate: dateOnlyOffset(45) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_onion', quantity: 180, minStock: 40, maxStock: 260, batchNumber: 'PO-1016-ONON', expiryDate: dateOnlyOffset(20) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_tomato', quantity: 140, minStock: 35, maxStock: 220, batchNumber: 'PO-1017-TOMA', expiryDate: dateOnlyOffset(8) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_garlic', quantity: 40, minStock: 10, maxStock: 65, batchNumber: 'PO-1018-GRLC', expiryDate: dateOnlyOffset(25) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_olive_oil', quantity: 60, minStock: 15, maxStock: 90, batchNumber: 'PO-1019-OIL', expiryDate: dateOnlyOffset(160) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_flour', quantity: 120, minStock: 28, maxStock: 180, batchNumber: 'PO-1020-FLOR', expiryDate: dateOnlyOffset(180) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_sugar', quantity: 95, minStock: 24, maxStock: 140, batchNumber: 'PO-1021-SUGR', expiryDate: dateOnlyOffset(180) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_butter', quantity: 38, minStock: 10, maxStock: 55, batchNumber: 'PO-1022-BUTR', expiryDate: dateOnlyOffset(25) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_cheese', quantity: 42, minStock: 12, maxStock: 60, batchNumber: 'PO-1023-CHSE', expiryDate: dateOnlyOffset(18) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_lettuce', quantity: 55, minStock: 16, maxStock: 80, batchNumber: 'PO-1024-LTTC', expiryDate: dateOnlyOffset(6) },
    { site: coldStore || warehouseSite || primarySite, ingredientId: 'ingredient_cucumber', quantity: 60, minStock: 16, maxStock: 90, batchNumber: 'PO-1025-CUCM', expiryDate: dateOnlyOffset(7) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_eggs', quantity: 420, minStock: 120, maxStock: 640, batchNumber: 'PO-1026-EGGS-DRY', expiryDate: dateOnlyOffset(9) },
    { site: warehouseSite || primarySite, ingredientId: 'ingredient_milk', quantity: 70, minStock: 18, maxStock: 100, batchNumber: 'PO-1027-MILK-DRY', expiryDate: dateOnlyOffset(7) },
    { site: primarySite, ingredientId: 'ingredient_chicken_breast', quantity: 36, minStock: 14, maxStock: 60, batchNumber: 'KIT-1101-CHKN', expiryDate: dateOnlyOffset(3) },
    { site: primarySite, ingredientId: 'ingredient_basmati_rice', quantity: 110, minStock: 35, maxStock: 180, batchNumber: 'KIT-1102-RICE', expiryDate: dateOnlyOffset(80) },
    { site: primarySite, ingredientId: 'ingredient_mixed_vegetables', quantity: 42, minStock: 14, maxStock: 75, batchNumber: 'KIT-1103-VEG', expiryDate: dateOnlyOffset(4) },
    { site: primarySite, ingredientId: 'ingredient_flatbread', quantity: 180, minStock: 60, maxStock: 260, batchNumber: 'KIT-1104-BRD', expiryDate: dateOnlyOffset(2) },
    { site: primarySite, ingredientId: 'ingredient_yogurt', quantity: 22, minStock: 8, maxStock: 36, batchNumber: 'KIT-1105-YGRT', expiryDate: dateOnlyOffset(4) },
    { site: primarySite, ingredientId: 'ingredient_lentils', quantity: 32, minStock: 12, maxStock: 55, batchNumber: 'KIT-1106-LENT', expiryDate: dateOnlyOffset(120) },
    { site: primarySite, ingredientId: 'ingredient_pasta_penne', quantity: 30, minStock: 10, maxStock: 48, batchNumber: 'KIT-1107-PASTA', expiryDate: dateOnlyOffset(90) },
    { site: primarySite, ingredientId: 'ingredient_tomato_sauce', quantity: 20, minStock: 8, maxStock: 36, batchNumber: 'KIT-1108-TOMA', expiryDate: dateOnlyOffset(40) },
    { site: primarySite, ingredientId: 'ingredient_eggs', quantity: 260, minStock: 100, maxStock: 420, batchNumber: 'KIT-1109-EGGS', expiryDate: dateOnlyOffset(6) },
    { site: primarySite, ingredientId: 'ingredient_milk', quantity: 38, minStock: 12, maxStock: 60, batchNumber: 'KIT-1110-MILK', expiryDate: dateOnlyOffset(5) },
    { site: primarySite, ingredientId: 'ingredient_salmon_fillet', quantity: 18, minStock: 8, maxStock: 28, batchNumber: 'KIT-1111-SALM', expiryDate: dateOnlyOffset(3) },
    { site: primarySite, ingredientId: 'ingredient_beef_mince', quantity: 24, minStock: 10, maxStock: 40, batchNumber: 'KIT-1112-BEEF', expiryDate: dateOnlyOffset(4) },
    { site: primarySite, ingredientId: 'ingredient_onion', quantity: 35, minStock: 10, maxStock: 55, batchNumber: 'KIT-1113-ONON', expiryDate: dateOnlyOffset(14) },
    { site: primarySite, ingredientId: 'ingredient_tomato', quantity: 28, minStock: 8, maxStock: 45, batchNumber: 'KIT-1114-TOMA', expiryDate: dateOnlyOffset(5) },
    { site: primarySite, ingredientId: 'ingredient_garlic', quantity: 8, minStock: 2, maxStock: 14, batchNumber: 'KIT-1115-GRLC', expiryDate: dateOnlyOffset(20) },
    { site: primarySite, ingredientId: 'ingredient_olive_oil', quantity: 14, minStock: 4, maxStock: 24, batchNumber: 'KIT-1116-OIL', expiryDate: dateOnlyOffset(120) },
    { site: primarySite, ingredientId: 'ingredient_cheese', quantity: 12, minStock: 4, maxStock: 20, batchNumber: 'KIT-1117-CHSE', expiryDate: dateOnlyOffset(12) },
    { site: primarySite, ingredientId: 'ingredient_lettuce', quantity: 10, minStock: 3, maxStock: 18, batchNumber: 'KIT-1118-LTTC', expiryDate: dateOnlyOffset(4) },
    { site: primarySite, ingredientId: 'ingredient_cucumber', quantity: 12, minStock: 3, maxStock: 20, batchNumber: 'KIT-1119-CUCM', expiryDate: dateOnlyOffset(4) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_flatbread', quantity: 160, minStock: 40, maxStock: 240, batchNumber: 'TR-2001-BRD', expiryDate: dateOnlyOffset(2) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_chicken_breast', quantity: 34, minStock: 12, maxStock: 55, batchNumber: 'TR-2002-CHKN', expiryDate: dateOnlyOffset(3) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_yogurt', quantity: 20, minStock: 6, maxStock: 30, batchNumber: 'TR-2003-YGRT', expiryDate: dateOnlyOffset(4) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_pasta_penne', quantity: 34, minStock: 10, maxStock: 48, batchNumber: 'TR-2004-PASTA', expiryDate: dateOnlyOffset(90) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_tomato_sauce', quantity: 22, minStock: 6, maxStock: 30, batchNumber: 'TR-2005-TOMA', expiryDate: dateOnlyOffset(40) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_beef_mince', quantity: 24, minStock: 8, maxStock: 36, batchNumber: 'TR-2006-BEEF', expiryDate: dateOnlyOffset(4) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_lentils', quantity: 26, minStock: 8, maxStock: 40, batchNumber: 'TR-2007-LENT', expiryDate: dateOnlyOffset(140) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_eggs', quantity: 180, minStock: 70, maxStock: 260, batchNumber: 'TR-2008-EGGS', expiryDate: dateOnlyOffset(6) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_milk', quantity: 28, minStock: 10, maxStock: 42, batchNumber: 'TR-2009-MILK', expiryDate: dateOnlyOffset(5) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_onion', quantity: 20, minStock: 6, maxStock: 30, batchNumber: 'TR-2010-ONON', expiryDate: dateOnlyOffset(12) },
    { site: branchKitchen || primarySite, ingredientId: 'ingredient_tomato', quantity: 18, minStock: 5, maxStock: 28, batchNumber: 'TR-2011-TOMA', expiryDate: dateOnlyOffset(4) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_basmati_rice', quantity: 160, minStock: 50, maxStock: 240, batchNumber: 'TR-3001-RICE', expiryDate: dateOnlyOffset(70) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_lentils', quantity: 90, minStock: 28, maxStock: 140, batchNumber: 'TR-3002-LENT', expiryDate: dateOnlyOffset(160) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_eggs', quantity: 420, minStock: 140, maxStock: 620, batchNumber: 'TR-3003-EGGS', expiryDate: dateOnlyOffset(7) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_chicken_breast', quantity: 65, minStock: 24, maxStock: 100, batchNumber: 'TR-3004-CHKN', expiryDate: dateOnlyOffset(4) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_mixed_vegetables', quantity: 58, minStock: 20, maxStock: 90, batchNumber: 'TR-3005-VEG', expiryDate: dateOnlyOffset(4) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_pasta_penne', quantity: 72, minStock: 20, maxStock: 110, batchNumber: 'TR-3006-PASTA', expiryDate: dateOnlyOffset(120) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_tomato_sauce', quantity: 34, minStock: 10, maxStock: 48, batchNumber: 'TR-3007-TOMA', expiryDate: dateOnlyOffset(45) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_beef_mince', quantity: 52, minStock: 18, maxStock: 78, batchNumber: 'TR-3008-BEEF', expiryDate: dateOnlyOffset(4) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_flatbread', quantity: 260, minStock: 90, maxStock: 380, batchNumber: 'TR-3009-BRD', expiryDate: dateOnlyOffset(2) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_milk', quantity: 52, minStock: 16, maxStock: 80, batchNumber: 'TR-3010-MILK', expiryDate: dateOnlyOffset(5) },
    { site: campKitchen || primarySite, ingredientId: 'ingredient_onion', quantity: 34, minStock: 10, maxStock: 50, batchNumber: 'TR-3011-ONON', expiryDate: dateOnlyOffset(14) }
  ];

  const warehouseStockBlueprint = [
    ['ingredient_chicken_breast', 90, 28, 140, 'WH-CHKN', 10],
    ['ingredient_basmati_rice', 320, 90, 460, 'WH-RICE', 150],
    ['ingredient_yogurt', 70, 18, 110, 'WH-YGRT', 8],
    ['ingredient_mixed_vegetables', 85, 24, 130, 'WH-VEG', 6],
    ['ingredient_flatbread', 520, 150, 760, 'WH-BRD', 3],
    ['ingredient_hummus', 42, 12, 65, 'WH-HMMS', 9],
    ['ingredient_beef_mince', 60, 18, 92, 'WH-BEEF', 6],
    ['ingredient_potato', 170, 45, 260, 'WH-POTA', 30],
    ['ingredient_lentils', 110, 28, 160, 'WH-LENT', 220],
    ['ingredient_pasta_penne', 120, 32, 180, 'WH-PASTA', 180],
    ['ingredient_tomato_sauce', 84, 22, 130, 'WH-TOMA', 90],
    ['ingredient_salmon_fillet', 30, 10, 48, 'WH-SALM', 5],
    ['ingredient_eggs', 760, 220, 1100, 'WH-EGGS', 9],
    ['ingredient_milk', 120, 32, 180, 'WH-MILK', 7],
    ['ingredient_chickpeas', 95, 24, 140, 'WH-CHKP', 60],
    ['ingredient_onion', 120, 30, 180, 'WH-ONON', 18],
    ['ingredient_tomato', 110, 28, 170, 'WH-TOMT', 7],
    ['ingredient_garlic', 26, 8, 40, 'WH-GRLC', 30],
    ['ingredient_olive_oil', 42, 12, 64, 'WH-OIL', 180],
    ['ingredient_flour', 92, 24, 140, 'WH-FLOR', 220],
    ['ingredient_sugar', 74, 20, 110, 'WH-SUGR', 240],
    ['ingredient_butter', 30, 8, 44, 'WH-BUTR', 28],
    ['ingredient_cheese', 34, 10, 52, 'WH-CHSE', 20],
    ['ingredient_lettuce', 40, 12, 60, 'WH-LTTC', 6],
    ['ingredient_cucumber', 44, 12, 66, 'WH-CUCM', 7]
  ];

  for (const warehouse of warehouseLocations) {
    for (const [ingredientId, quantity, minStock, maxStock, batchPrefix, expiryDays] of warehouseStockBlueprint) {
      inventorySeeds.push({
        site: warehouse,
        ingredientId,
        quantity,
        minStock,
        maxStock,
        batchNumber: `${batchPrefix}-${String(warehouse.project_code || warehouse.id || 'SITE').slice(0, 12)}`,
        expiryDate: dateOnlyOffset(expiryDays)
      });
    }
  }

  for (const seed of inventorySeeds) {
    await ensureInventorySeed(seed);
  }

  const passwordHash = bcrypt.hashSync(adminPassword, 10);
  const existingUser = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [adminEmail]);
  if (existingUser.rowCount === 0) {
    const anyAdmin = await query(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    if (anyAdmin.rowCount > 0) {
      await query(
        `UPDATE users
         SET email = $2,
             full_name = $3,
             role = 'admin',
             status = 'active',
             password_hash = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [anyAdmin.rows[0].id, adminEmail, adminName, passwordHash]
      );
    } else {
      await query(
        `INSERT INTO users (id, email, full_name, role, status, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, 'admin', 'active', $4, NOW(), NOW())`,
        [randomId('user'), adminEmail, adminName, passwordHash]
      );
    }
  } else {
    await query(
      `UPDATE users
       SET full_name = $2,
           role = 'admin',
           status = 'active',
           password_hash = $3,
           updated_at = NOW()
       WHERE email = $1`,
      [adminEmail, adminName, passwordHash]
    );
  }
}

async function listUsers() {
  const result = await query('SELECT * FROM users ORDER BY updated_at DESC');
  return Promise.all(result.rows.map(async (row) => sanitizeUser(await hydrateUserRole(toUserRecord(row)))));
}

async function findUserById(id) {
  const result = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return result.rowCount ? hydrateUserRole(toUserRecord(result.rows[0])) : null;
}

async function findUserByEmail(email) {
  const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  return result.rowCount ? hydrateUserRole(toUserRecord(result.rows[0])) : null;
}

async function createUser(data) {
  const existing = await findUserByEmail(data.email);
  if (existing) {
    const error = new Error('User already exists');
    error.status = 409;
    throw error;
  }

  const id = data.id || randomId('user');
  const timestamp = nowIso();
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
    ]
  );

  return sanitizeUser(await findUserById(id));
}

async function updateUser(id, patch) {
  const existing = await findUserById(id);
  if (!existing) return null;

  if (patch.email && normalizeUniqueValue(patch.email) !== normalizeUniqueValue(existing.email)) {
    const duplicate = await findUserByEmail(patch.email);
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
    ]
  );

  return sanitizeUser(await findUserById(id));
}

async function listDocuments(entity, { filters = {}, sort, limit } = {}) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    const filtered = (await listUsers()).filter((record) => matchesFilter(record, filters));
    const sorted = sortRecords(filtered, sort);
    return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
  }

  const result = await query(
    'SELECT data FROM entity_records WHERE entity_name = $1 ORDER BY updated_at DESC',
    [entity]
  );
  const records = result.rows.map((row) => row.data).filter((record) => matchesFilter(record, filters));
  const sorted = sortRecords(records, sort);
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}

async function findDocument(entity, id) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    return sanitizeUser(await findUserById(id));
  }

  const result = await query(
    'SELECT data FROM entity_records WHERE entity_name = $1 AND id = $2 LIMIT 1',
    [entity, id]
  );
  return result.rowCount ? result.rows[0].data : null;
}

async function createDocument(entity, payload) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    return createUser(payload);
  }

  const validated = validateEntityPayload(entity, payload);
  const record = normalizeRecord(entity, validated);
  await ensureEntityUniqueness(entity, record);

  await query(
    `INSERT INTO entity_records (id, entity_name, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [record.id, entity, JSON.stringify(record), record.created_date, record.updated_date]
  );

  return record;
}

async function updateDocument(entity, id, patch) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    return updateUser(id, patch);
  }

  const existing = await findDocument(entity, id);
  if (!existing) return null;

  const validated = validateEntityPayload(entity, { ...existing, ...patch });
  const record = normalizeRecord(entity, validated, existing);
  await ensureEntityUniqueness(entity, record, id);

  await query(
    `UPDATE entity_records
     SET data = $3::jsonb, updated_at = $4
     WHERE entity_name = $1 AND id = $2`,
    [entity, id, JSON.stringify(record), record.updated_date]
  );

  return record;
}

async function deleteDocument(entity, id) {
  ensureKnownEntity(entity);
  if (entity === 'User') {
    const result = await query('DELETE FROM users WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  const result = await query('DELETE FROM entity_records WHERE entity_name = $1 AND id = $2', [entity, id]);
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
