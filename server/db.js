import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client, Pool } from 'pg';
import { entityRegistry, ensureKnownEntity, validateEntityPayload } from './entities.js';

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

  const siteRecords = await listDocuments('Site', { sort: 'name', limit: 50 });
  const primarySite = siteRecords[0] || null;
  let warehouseSite = siteRecords.find((site) => ['warehouse', 'store'].includes(String(site.type || '').toLowerCase())) || null;

  if (!warehouseSite && primarySite) {
    warehouseSite = await createDocument('Site', {
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
    });
  }

  const existingIngredients = await listDocuments('Ingredient', { limit: 10 });
  if (existingIngredients.length === 0) {
    await Promise.all([
      createDocument('Ingredient', {
        id: 'ingredient_chicken_breast',
        name: 'Chicken Breast',
        unit: 'kg',
        category: 'protein',
        cuisine_type: 'universal',
        cost_per_unit: 24,
        calories_per_100g: 165,
        protein_per_100g: 31,
        carbs_per_100g: 0,
        fat_per_100g: 3.6,
        sodium_per_100g: 74,
        sugar_per_100g: 0,
        cooking_yield_percent: 78,
        shrinkage_percent: 22,
        raw_weight_per_unit: 1000,
        cooked_weight_per_unit: 780,
        allergens: []
      }),
      createDocument('Ingredient', {
        id: 'ingredient_basmati_rice',
        name: 'Basmati Rice',
        unit: 'kg',
        category: 'grain',
        cuisine_type: 'middle_eastern',
        cost_per_unit: 8.5,
        calories_per_100g: 365,
        protein_per_100g: 7.1,
        carbs_per_100g: 80,
        fat_per_100g: 0.7,
        sodium_per_100g: 5,
        sugar_per_100g: 0.1,
        cooking_yield_percent: 260,
        shrinkage_percent: 0,
        raw_weight_per_unit: 1000,
        cooked_weight_per_unit: 2600,
        allergens: []
      }),
      createDocument('Ingredient', {
        id: 'ingredient_yogurt',
        name: 'Plain Yogurt',
        unit: 'kg',
        category: 'dairy',
        cuisine_type: 'middle_eastern',
        cost_per_unit: 7,
        calories_per_100g: 61,
        protein_per_100g: 3.5,
        carbs_per_100g: 4.7,
        fat_per_100g: 3.3,
        sodium_per_100g: 46,
        sugar_per_100g: 4.7,
        cooking_yield_percent: 100,
        shrinkage_percent: 0,
        raw_weight_per_unit: 1000,
        cooked_weight_per_unit: 1000,
        allergens: ['dairy']
      }),
      createDocument('Ingredient', {
        id: 'ingredient_mixed_vegetables',
        name: 'Mixed Vegetables',
        unit: 'kg',
        category: 'vegetable',
        cuisine_type: 'universal',
        cost_per_unit: 9.75,
        calories_per_100g: 45,
        protein_per_100g: 2.2,
        carbs_per_100g: 8.8,
        fat_per_100g: 0.4,
        sodium_per_100g: 48,
        sugar_per_100g: 3.6,
        cooking_yield_percent: 92,
        shrinkage_percent: 8,
        raw_weight_per_unit: 1000,
        cooked_weight_per_unit: 920,
        allergens: []
      }),
      createDocument('Ingredient', {
        id: 'ingredient_flatbread',
        name: 'Arabic Flatbread',
        unit: 'pieces',
        category: 'bakery',
        cuisine_type: 'middle_eastern',
        cost_per_unit: 1.2,
        calories_per_100g: 275,
        protein_per_100g: 9,
        carbs_per_100g: 55,
        fat_per_100g: 1.2,
        sodium_per_100g: 510,
        sugar_per_100g: 2.5,
        cooking_yield_percent: 100,
        shrinkage_percent: 0,
        raw_weight_per_unit: 90,
        cooked_weight_per_unit: 90,
        allergens: ['gluten']
      }),
      createDocument('Ingredient', {
        id: 'ingredient_hummus',
        name: 'Hummus',
        unit: 'kg',
        category: 'dip',
        cuisine_type: 'middle_eastern',
        cost_per_unit: 12.5,
        calories_per_100g: 166,
        protein_per_100g: 7.9,
        carbs_per_100g: 14.3,
        fat_per_100g: 9.6,
        sodium_per_100g: 240,
        sugar_per_100g: 0.3,
        cooking_yield_percent: 100,
        shrinkage_percent: 0,
        raw_weight_per_unit: 1000,
        cooked_weight_per_unit: 1000,
        allergens: ['sesame']
      })
    ]);
  }

  const availableIngredients = await listDocuments('Ingredient', { sort: 'name', limit: 100 });

  const existingRecipes = await listDocuments('Recipe', { limit: 10 });
  if (existingRecipes.length === 0) {
    await Promise.all([
      createDocument('Recipe', {
        id: 'recipe_chicken_kabsa',
        name: 'Chicken Kabsa',
        recipe_code: 'RCP-001',
        recipe_type: 'full',
        category: 'lunch',
        cuisine_type: 'middle_eastern',
        description: 'Saudi-style spiced rice with roasted chicken and vegetables.',
        prep_time_minutes: 40,
        cook_time_minutes: 65,
        servings: 25,
        instructions: 'Marinate chicken, roast until tender, cook rice with stock and spices, and portion with vegetables.',
        ingredients: [
          { ingredient_id: 'ingredient_chicken_breast', ingredient_name: 'Chicken Breast', quantity: 6, unit: 'kg' },
          { ingredient_id: 'ingredient_basmati_rice', ingredient_name: 'Basmati Rice', quantity: 4.5, unit: 'kg' },
          { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 1.5, unit: 'kg' }
        ],
        site_scope: 'global',
        site_ids: primarySite ? [primarySite.id] : [],
        site_names: primarySite ? [primarySite.name] : []
      }),
      createDocument('Recipe', {
        id: 'recipe_chicken_shawarma_wrap',
        name: 'Chicken Shawarma Wrap',
        recipe_code: 'RCP-002',
        recipe_type: 'full',
        category: 'dinner',
        cuisine_type: 'middle_eastern',
        description: 'Grilled chicken wrapped in Arabic bread with yogurt sauce.',
        prep_time_minutes: 30,
        cook_time_minutes: 20,
        servings: 20,
        instructions: 'Season chicken, grill in batches, assemble wraps with sauce and garnish.',
        ingredients: [
          { ingredient_id: 'ingredient_chicken_breast', ingredient_name: 'Chicken Breast', quantity: 4, unit: 'kg' },
          { ingredient_id: 'ingredient_flatbread', ingredient_name: 'Arabic Flatbread', quantity: 20, unit: 'pieces' },
          { ingredient_id: 'ingredient_yogurt', ingredient_name: 'Plain Yogurt', quantity: 1.2, unit: 'kg' }
        ],
        site_scope: 'global',
        site_ids: primarySite ? [primarySite.id] : [],
        site_names: primarySite ? [primarySite.name] : []
      }),
      createDocument('Recipe', {
        id: 'recipe_hummus_platter',
        name: 'Hummus Mezze Platter',
        recipe_code: 'RCP-003',
        recipe_type: 'full',
        category: 'snack',
        cuisine_type: 'middle_eastern',
        description: 'Shared platter with hummus, flatbread, and fresh vegetables.',
        prep_time_minutes: 15,
        cook_time_minutes: 0,
        servings: 12,
        instructions: 'Plate hummus, cut flatbread, and garnish with vegetables.',
        ingredients: [
          { ingredient_id: 'ingredient_hummus', ingredient_name: 'Hummus', quantity: 1.5, unit: 'kg' },
          { ingredient_id: 'ingredient_flatbread', ingredient_name: 'Arabic Flatbread', quantity: 10, unit: 'pieces' },
          { ingredient_id: 'ingredient_mixed_vegetables', ingredient_name: 'Mixed Vegetables', quantity: 0.8, unit: 'kg' }
        ],
        site_scope: 'global',
        site_ids: primarySite ? [primarySite.id] : [],
        site_names: primarySite ? [primarySite.name] : []
      })
    ]);
  }

  const availableRecipes = await listDocuments('Recipe', { sort: 'name', limit: 100 });

  const existingMenuPlans = await listDocuments('MenuPlan', { limit: 10 });
  if (existingMenuPlans.length === 0 && primarySite && availableRecipes.length > 0) {
    const kabsa = availableRecipes.find((recipe) => recipe.id === 'recipe_chicken_kabsa');
    const shawarma = availableRecipes.find((recipe) => recipe.id === 'recipe_chicken_shawarma_wrap');
    const hummus = availableRecipes.find((recipe) => recipe.id === 'recipe_hummus_platter');

    await Promise.all([
      createDocument('MenuPlan', {
        site_id: primarySite.id,
        site_name: primarySite.name,
        plan_date: dateOnlyOffset(0),
        meals: [
          {
            meal_type: 'lunch',
            recipe_id: kabsa?.id || '',
            recipe_name: kabsa?.name || 'Chicken Kabsa',
            expected_servings: 120,
            calories_per_serving: kabsa?.calories_per_serving || 0,
            protein_per_serving: kabsa?.protein_per_serving || 0,
            carbs_per_serving: kabsa?.carbs_per_serving || 0,
            fat_per_serving: kabsa?.fat_per_serving || 0,
            sodium_per_serving: kabsa?.sodium_per_serving || 0,
            sugar_per_serving: kabsa?.sugar_per_serving || 0,
            allergens: kabsa?.allergens || []
          },
          {
            meal_type: 'dinner',
            recipe_id: shawarma?.id || '',
            recipe_name: shawarma?.name || 'Chicken Shawarma Wrap',
            expected_servings: 90,
            calories_per_serving: shawarma?.calories_per_serving || 0,
            protein_per_serving: shawarma?.protein_per_serving || 0,
            carbs_per_serving: shawarma?.carbs_per_serving || 0,
            fat_per_serving: shawarma?.fat_per_serving || 0,
            sodium_per_serving: shawarma?.sodium_per_serving || 0,
            sugar_per_serving: shawarma?.sugar_per_serving || 0,
            allergens: shawarma?.allergens || []
          }
        ],
        total_expected_servings: 210,
        status: 'planned'
      }),
      createDocument('MenuPlan', {
        site_id: primarySite.id,
        site_name: primarySite.name,
        plan_date: dateOnlyOffset(1),
        meals: [
          {
            meal_type: 'snack',
            recipe_id: hummus?.id || '',
            recipe_name: hummus?.name || 'Hummus Mezze Platter',
            expected_servings: 60,
            calories_per_serving: hummus?.calories_per_serving || 0,
            protein_per_serving: hummus?.protein_per_serving || 0,
            carbs_per_serving: hummus?.carbs_per_serving || 0,
            fat_per_serving: hummus?.fat_per_serving || 0,
            sodium_per_serving: hummus?.sodium_per_serving || 0,
            sugar_per_serving: hummus?.sugar_per_serving || 0,
            allergens: hummus?.allergens || []
          },
          {
            meal_type: 'lunch',
            recipe_id: kabsa?.id || '',
            recipe_name: kabsa?.name || 'Chicken Kabsa',
            expected_servings: 100,
            calories_per_serving: kabsa?.calories_per_serving || 0,
            protein_per_serving: kabsa?.protein_per_serving || 0,
            carbs_per_serving: kabsa?.carbs_per_serving || 0,
            fat_per_serving: kabsa?.fat_per_serving || 0,
            sodium_per_serving: kabsa?.sodium_per_serving || 0,
            sugar_per_serving: kabsa?.sugar_per_serving || 0,
            allergens: kabsa?.allergens || []
          }
        ],
        total_expected_servings: 160,
        status: 'draft'
      })
    ]);
  }

  const existingInventory = await listDocuments('Inventory', { limit: 10 });
  if (existingInventory.length === 0) {
    const stockSite = warehouseSite || primarySite;
    const ingredientMap = new Map(availableIngredients.map((ingredient) => [ingredient.id, ingredient]));
    if (stockSite) {
      const inventorySeed = [
        ['ingredient_chicken_breast', 42, 12, 75, 'PO-1001-CHKN', dateOnlyOffset(18)],
        ['ingredient_basmati_rice', 180, 40, 260, 'PO-1002-RICE', dateOnlyOffset(120)],
        ['ingredient_yogurt', 24, 8, 36, 'PO-1003-YGRT', dateOnlyOffset(7)],
        ['ingredient_mixed_vegetables', 30, 10, 45, 'PO-1004-VEG', dateOnlyOffset(5)],
        ['ingredient_flatbread', 220, 80, 320, 'PO-1005-BRD', dateOnlyOffset(3)],
        ['ingredient_hummus', 18, 6, 24, 'PO-1006-HMMS', dateOnlyOffset(9)]
      ];

      for (const [ingredientId, quantity, minStock, maxStock, batchNumber, expiryDate] of inventorySeed) {
        const ingredient = ingredientMap.get(ingredientId);
        if (!ingredient) continue;
        const timestamp = nowIso();
        const inventoryId = `inventory_${stockSite.id}_${ingredientId}`;
        const lotId = `lot_${stockSite.id}_${ingredientId}`;
        const transactionId = `txn_${stockSite.id}_${ingredientId}`;
        const totalCost = Number(quantity) * Number(ingredient.cost_per_unit || 0);
        const status = quantity <= minStock ? 'low_stock' : 'in_stock';

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
              site_id: stockSite.id,
              site_name: stockSite.name,
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
            lotId,
            JSON.stringify({
              id: lotId,
              site_id: stockSite.id,
              site_name: stockSite.name,
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
              site_id: stockSite.id,
              site_name: stockSite.name,
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
      }
    }
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
  return result.rows.map((row) => sanitizeUser(toUserRecord(row)));
}

async function findUserById(id) {
  const result = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return result.rowCount ? toUserRecord(result.rows[0]) : null;
}

async function findUserByEmail(email) {
  const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  return result.rowCount ? toUserRecord(result.rows[0]) : null;
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
  return result.rowCount ? sanitizeUser(toUserRecord(result.rows[0])) : null;
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
