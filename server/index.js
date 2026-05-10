import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import nodemailer from 'nodemailer';
import {
  uploadsDir,
  listDocuments,
  findDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  initDatabase,
  getUserByToken,
  revokeToken,
  loginUser,
  inviteUser,
  createAppLog,
  createEmailLog
} from './db.js';
import { authorizeEntityAction, ensureKnownEntity } from './entities.js';
import { getUserEffectiveRole, hasPermission } from './entities.js';
import {
  getPosSources,
  createPosSource,
  updatePosSource,
  deletePosSource,
  getRecipeMappings,
  createRecipeMapping,
  updateRecipeMapping,
  deleteRecipeMapping,
  getSyncLogs,
  importPosOrders,
  syncPosSource,
  getDailySalesSummary,
  getSalesProductionVariance
} from './pos.js';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listPurchaseRequests,
  createPurchaseRequest,
  approvePurchaseRequest,
  autoGeneratePurchaseRequestFromLowStock,
  listPurchaseOrders,
  createPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  listGoodsReceipts,
  createGoodsReceipt,
  listSupplierInvoices,
  createSupplierInvoice,
  listSupplierPriceComparison,
  getSupplierPerformanceDashboard
} from './procurement.js';
import {
  receiveStock,
  adjustStock,
  transferStock,
  completeProduction,
  getStockOnHandReport,
  getStockMovementReport,
  getExpiryReport,
  getVelocityReports,
  getInventoryValuationReport,
  listInventoryLots
} from './inventory.js';
import {
  exportToErp,
  retryErpSync,
  listErpLogs
} from './erpIntegration.js';
import {
  buildForecastSummary,
  runForecastScenario
} from './forecasting.js';
import {
  getLocationScope,
  filterRecordsByLocation,
  assertPayloadLocationAccess,
  buildSiteHierarchy,
  normalizeUserLocationPayload,
  normalizeRecipeLocationPayload
} from './locationScope.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const rootDir = path.resolve(process.cwd());
const distDir = path.join(rootDir, 'dist');
const databaseInitAttempts = Number(process.env.DATABASE_INIT_ATTEMPTS || 30);
const databaseInitDelayMs = Number(process.env.DATABASE_INIT_DELAY_MS || 2000);

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '');
    const baseName = path.basename(file.originalname || 'upload', extension).replace(/[^a-zA-Z0-9-_]/g, '-');
    callback(null, `${Date.now()}-${baseName}${extension}`);
  }
});

const upload = multer({ storage });

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function initDatabaseWithRetry() {
  let lastError = null;

  for (let attempt = 1; attempt <= databaseInitAttempts; attempt += 1) {
    try {
      await initDatabase();
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Database initialization attempt ${attempt}/${databaseInitAttempts} failed: ${error.message}`);

      if (attempt < databaseInitAttempts) {
        await delay(databaseInitDelayMs);
      }
    }
  }

  throw lastError;
}

function getBearerToken(request) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireAuth(request, response, next) {
  const token = getBearerToken(request);
  const user = await getUserByToken(token);

  if (!user) {
    return response.status(401).json({ message: 'Authentication required' });
  }

  request.user = user;
  request.token = token;
  return next();
}

function requireRole(roles) {
  return (request, response, next) => {
    const effectiveRole = getUserEffectiveRole(request.user);
    if (!request.user || !roles.includes(effectiveRole)) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

function requirePermission(permission) {
  return (request, response, next) => {
    if (!request.user || !hasPermission(request.user, permission)) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

function requireAnyPermission(permissions) {
  return (request, response, next) => {
    if (!request.user || !permissions.some((permission) => hasPermission(request.user, permission))) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

async function prepareEntityPayload(user, entity, payload = {}, existing = null) {
  const scope = await getLocationScope(user);
  assertPayloadLocationAccess(user, entity, payload, scope);
  const merged = existing ? { ...existing, ...payload } : payload;

  if (entity === 'Site') {
    return {
      ...merged,
      ...buildSiteHierarchy(merged, existing, scope)
    };
  }

  if (entity === 'User') {
    return normalizeUserLocationPayload(merged, scope);
  }

  if (entity === 'Recipe') {
    return normalizeRecipeLocationPayload(merged, scope);
  }

  return merged;
}

async function scopeEntityRecords(user, entity, records = []) {
  const scope = await getLocationScope(user);
  return filterRecordsByLocation(user, entity, records, scope);
}

function filterRowsByAccessibleSites(rows = [], scope, fields = ['site_id']) {
  if (scope?.unrestricted) {
    return rows;
  }

  return rows.filter((row) => fields
    .map((field) => row?.[field])
    .filter(Boolean)
    .every((siteId) => scope.accessibleSiteIds.has(String(siteId))));
}

function numericMatch(input, fallback = 0) {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function buildInventoryShortages(production = {}, inventoryRows = [], ingredients = []) {
  return (Array.isArray(production.ingredients_used) ? production.ingredients_used : [])
    .map((ingredientLine) => {
      const requiredQuantity = numericMatch(
        ingredientLine.planned_quantity ?? ingredientLine.adjusted_quantity ?? ingredientLine.required_quantity,
        0
      );
      const inventoryItem = inventoryRows.find((item) => item.ingredient_id === ingredientLine.ingredient_id);
      const ingredientMaster = ingredients.find((item) => item.id === ingredientLine.ingredient_id);
      const currentStock = numericMatch(inventoryItem?.quantity, 0);
      const shortageQuantity = Math.max(0, requiredQuantity - currentStock);
      const unitCost = numericMatch(
        ingredientLine.unit_cost ?? inventoryItem?.average_cost ?? ingredientMaster?.cost_per_unit,
        0
      );

      return {
        ingredient_id: ingredientLine.ingredient_id,
        ingredient_name: ingredientLine.ingredient_name,
        unit: ingredientLine.unit || ingredientMaster?.unit || inventoryItem?.unit || 'unit',
        required_quantity: Number(requiredQuantity.toFixed(2)),
        current_stock: Number(currentStock.toFixed(2)),
        shortage_quantity: Number(shortageQuantity.toFixed(2)),
        estimated_unit_cost: Number(unitCost.toFixed(2)),
        estimated_cost: Number((shortageQuantity * unitCost).toFixed(2))
      };
    })
    .filter((item) => item.ingredient_id && item.shortage_quantity > 0);
}

async function syncMaterialRequestForProduction(user, production, mode = 'draft') {
  if (!production?.id) {
    return null;
  }

  const normalizedMode = String(mode || 'draft').toLowerCase();
  const isDraftMode = normalizedMode === 'draft';

  if (!isDraftMode && String(production.status || '') !== 'approved') {
    const error = new Error('Material requests can only be activated for approved production requests.');
    error.status = 400;
    throw error;
  }

  const existingRequests = await listDocuments('MaterialRequest', {
    filters: { source_production_id: production.id },
    sort: '-request_date',
    limit: 20
  });

  const [inventoryRows, ingredients] = await Promise.all([
    listDocuments('Inventory', {
      filters: { site_id: production.site_id },
      limit: 2000
    }),
    listDocuments('Ingredient', { limit: 2000 })
  ]);

  const productionItems = (Array.isArray(production.ingredients_used) ? production.ingredients_used : []).map((item) => {
    const inventoryItem = inventoryRows.find((inventoryRow) => inventoryRow.ingredient_id === item.ingredient_id);
    const ingredientMaster = ingredients.find((ingredient) => ingredient.id === item.ingredient_id);
    const requiredQuantity = numericMatch(
      item.planned_quantity ?? item.adjusted_quantity ?? item.required_quantity,
      0
    );
    const currentStock = numericMatch(inventoryItem?.quantity, 0);
    const unitCost = numericMatch(
      item.unit_cost ?? inventoryItem?.average_unit_cost ?? ingredientMaster?.cost_per_unit,
      0
    );

    return {
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      required_quantity: requiredQuantity,
      current_stock: currentStock,
      shortage_quantity: Math.max(0, requiredQuantity - currentStock),
      request_quantity: requiredQuantity,
      unit: item.unit,
      estimated_cost: Number((requiredQuantity * unitCost).toFixed(2))
    };
  });

  if (!productionItems.length) {
    return null;
  }

  const targetStatus = isDraftMode ? 'awaiting_production_approval' : 'pending_procurement_ack';
  const existingRequest = existingRequests.find((item) => !['cancelled', 'rejected'].includes(String(item.status || '').toLowerCase()));
  const payload = {
    site_id: production.site_id || null,
    site_name: production.site_name || null,
    request_date: new Date().toISOString().slice(0, 10),
    period_start: production.production_date || null,
    period_end: production.production_date || null,
    items: productionItems,
    total_estimated_cost: productionItems.reduce((sum, item) => sum + item.estimated_cost, 0),
    status: targetStatus,
    source_type: 'production',
    source_production_id: production.id,
    source_production_name: production.recipe_name || null,
    created_by: user?.email || production.created_by || null,
    created_by_name: user?.full_name || user?.email || production.created_by_name || production.created_by || null,
    notes: `Requested from production batch ${production.recipe_name || production.id}`
  };

  const materialRequest = existingRequest
    ? await updateDocument('MaterialRequest', existingRequest.id, {
        ...payload,
        request_number: existingRequest.request_number || `MR-PROD-${Date.now()}`,
        status: !isDraftMode && String(existingRequest.status || '') === 'acknowledged'
          ? 'acknowledged'
          : targetStatus
      })
    : await createDocument('MaterialRequest', {
        request_number: `MR-PROD-${Date.now()}`,
        ...payload
      });

  await updateDocument('Production', production.id, {
    linked_material_request_id: materialRequest.id,
    linked_material_request_number: materialRequest.request_number,
    material_request_status: materialRequest.status
  });

  return materialRequest;
}

const CORE_MENU_MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);

function isOperationalMenuPlan(plan) {
  return !String(plan?.event_name || '').trim();
}

function summarizeMenuPlanMeals(meals = []) {
  return meals.reduce((summary, meal) => {
    const servings = numericMatch(meal.expected_servings, 0);
    const calories = numericMatch(meal.calories_per_serving, 0);
    return {
      total_expected_servings: summary.total_expected_servings + servings,
      total_calories: summary.total_calories + (servings * calories)
    };
  }, {
    total_expected_servings: 0,
    total_calories: 0
  });
}

async function findScopedOperationalMenuPlan(user, siteId, planDate) {
  const records = await listDocuments('MenuPlan', {
    filters: { site_id: siteId, plan_date: planDate },
    limit: 50
  });
  const scopedRecords = await scopeEntityRecords(user, 'MenuPlan', records.filter(isOperationalMenuPlan));
  return scopedRecords[0] || null;
}

function buildMenuPlanWritePayload(body = {}, existing = null) {
  const meals = Array.isArray(body.meals)
    ? body.meals
      .filter((meal) => meal && meal.meal_type)
      .map((meal) => ({
        ...meal,
        expected_servings: numericMatch(meal.expected_servings, 0),
        calories_per_serving: numericMatch(meal.calories_per_serving, 0),
        protein_per_serving: numericMatch(meal.protein_per_serving, 0),
        carbs_per_serving: numericMatch(meal.carbs_per_serving, 0),
        fat_per_serving: numericMatch(meal.fat_per_serving, 0),
        sodium_per_serving: numericMatch(meal.sodium_per_serving, 0),
        sugar_per_serving: numericMatch(meal.sugar_per_serving, 0),
        allergens: Array.isArray(meal.allergens) ? meal.allergens : []
      }))
    : (Array.isArray(existing?.meals) ? existing.meals : []);

  const summary = summarizeMenuPlanMeals(meals);

  return {
    ...body,
    meals,
    status: body.status || existing?.status || 'draft',
    total_expected_servings: summary.total_expected_servings,
    total_calories: summary.total_calories
  };
}

async function getScopedProduction(request, productionId) {
  const scope = await getLocationScope(request.user);
  const production = await findDocument('Production', productionId);
  if (!production) {
    return { scope, production: null };
  }

  const scopedProduction = filterRowsByAccessibleSites([production], scope).length ? production : null;
  return { scope, production: scopedProduction };
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isPubliclyUsableBaseUrl(value) {
  return value && !/localhost|127\.0\.0\.1/i.test(value);
}

function resolvePublicBaseUrl(request) {
  const configured = normalizeBaseUrl(process.env.PUBLIC_APP_URL);
  if (isPubliclyUsableBaseUrl(configured)) {
    return configured;
  }

  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = String(request.headers.host || '').trim();
  const protocol = forwardedProto || request.protocol || 'http';
  const hostValue = forwardedHost || requestHost;

  if (hostValue) {
    return `${protocol}://${hostValue}`;
  }

  return configured || `http://localhost:${port}`;
}

function parseAvailableIngredients(prompt = '') {
  const section = prompt.split('Available Ingredients')[1] || '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .slice(0, 8)
    .map((line, index) => {
      const match = line.match(/-\s*(.+?)\s+\(([\d.]+)\s*(.*?)\)/);
      if (!match) {
        return { ingredient_name: line.replace(/^-/, '').trim(), quantity: index + 1, unit: 'unit' };
      }
      return {
        ingredient_name: match[1].trim(),
        quantity: Math.max(1, Math.round(numericMatch(match[2], index + 1) / 4)),
        unit: match[3] || 'unit'
      };
    });
}

function inferRecipeCategory(prompt = '') {
  const match = prompt.match(/Meal Category:\s*(.+)/i);
  return match?.[1]?.trim() || 'main_course';
}

function inferCuisine(prompt = '') {
  const match = prompt.match(/Cuisine Type:\s*(.+)/i);
  return match?.[1]?.trim() || 'continental';
}

function invokeFallbackLLM(prompt, schema) {
  const properties = schema?.properties || {};

  if (properties.name && properties.ingredients && properties.instructions) {
    const cuisine = inferCuisine(prompt);
    const category = inferRecipeCategory(prompt);
    const ingredients = parseAvailableIngredients(prompt);

    return {
      name: `${cuisine[0].toUpperCase()}${cuisine.slice(1)} ${category.replace(/_/g, ' ')}`.trim(),
      description: `A practical ${cuisine} ${category.replace(/_/g, ' ')} recipe generated from current inventory.`,
      ingredients,
      instructions: [
        'Prepare and portion all ingredients before starting production.',
        'Cook aromatics and core ingredients until fragrant and evenly combined.',
        'Add the remaining ingredients in stages and monitor texture carefully.',
        'Adjust seasoning, simmer until cooked through, and verify internal temperature.',
        'Portion for service and garnish before dispatch.'
      ].join('\n'),
      prep_time_minutes: 20,
      cook_time_minutes: 35,
      calories_per_serving: 420,
      protein_per_serving: 24,
      carbs_per_serving: 38,
      fat_per_serving: 16
    };
  }

  if (properties.substitutions && properties.quantity_adjustments) {
    return {
      substitutions: [
        {
          original_ingredient: 'Premium cream',
          substitute: 'Evaporated milk',
          cost_savings: 4.5,
          impact_on_quality: 'Slightly lighter texture with similar richness.',
          flavor_profile_notes: 'Keeps the savory profile balanced and clean.'
        },
        {
          original_ingredient: 'Imported herbs',
          substitute: 'Local fresh herbs',
          cost_savings: 2.25,
          impact_on_quality: 'Freshness remains strong with lower procurement cost.',
          flavor_profile_notes: 'Use the same finishing quantity for aroma.'
        }
      ],
      quantity_adjustments: [
        {
          ingredient: 'Oil',
          current_quantity: 1,
          suggested_quantity: 0.8,
          reasoning: 'A modest reduction controls cost without affecting cooking performance.'
        }
      ],
      price_fluctuation_forecast: {
        increase_10_percent: 55,
        increase_20_percent: 60,
        decrease_10_percent: 45,
        decrease_20_percent: 40
      },
      optimization_summary: 'Prioritize locally sourced substitutes, tighten high-cost fat usage, and review garnish standards.'
    };
  }

  if (properties.tomorrow_estimate && properties.suggestions) {
    return {
      tomorrow_estimate: {
        labor_kg: 72,
        junior_kg: 38,
        senior_kg: 24,
        total_kg: 134,
        expected_attendance: 340
      },
      adjustment_percent: -8,
      adjustment_direction: 'reduce',
      suggestions: [
        'Reduce production slightly for low-demand categories and keep a fast replenishment buffer.',
        'Shift surplus side dishes into next-meal reusable preparations where safe.',
        'Track no-show rates by weekday and pre-cut fewer garnishes on low-demand days.'
      ],
      pattern_observation: 'Mid-week demand remains strongest while weekend attendance softens, increasing overproduction risk late in the week.',
      category_insights: [
        'Labor meals show the most stable demand.',
        'Junior demand varies more and benefits from conservative prep.',
        'Senior meals justify a smaller premium buffer because counts are lower.'
      ],
      waste_risk: 'medium'
    };
  }

  if (properties.detected_food_types && properties.waste_percentage) {
    return {
      detected_food_types: ['rice', 'chicken', 'vegetables'],
      waste_percentage: 34,
      estimated_waste_grams: 180,
      waste_category: 'plate_waste',
      confidence_score: 72,
      suggestions: [
        'Reduce rice portioning by 10% during low-demand periods.',
        'Offer smaller default portions with optional top-ups.',
        'Review menu acceptance for the protein item served in this meal.'
      ],
      cost_estimate: 1.8,
      observation: 'The remaining food suggests moderate plate waste from oversized portions.'
    };
  }

  return Object.fromEntries(
    Object.keys(properties).map((key) => [key, null])
  );
}

async function invokeOpenAI(payload, publicBaseUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return invokeFallbackLLM(payload.prompt, payload.response_json_schema);
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: payload.prompt || 'Return a valid JSON object.' },
            ...((payload.file_urls || []).map((url) => ({
              type: 'input_image',
              image_url: url.startsWith('http') ? url : `${publicBaseUrl}${url}`
            })))
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'foodpro_response',
          schema: payload.response_json_schema || { type: 'object', properties: {} }
        }
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`LLM request failed: ${message}`);
  }

  const result = await response.json();
  const textChunk = result.output?.[0]?.content?.find((item) => item.type === 'output_text')?.text;
  return textChunk ? JSON.parse(textChunk) : invokeFallbackLLM(payload.prompt, payload.response_json_schema);
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',').map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((item) => item.trim());
    return Object.fromEntries(headers.map((header, index) => {
      const rawValue = values[index] ?? '';
      const numeric = Number(rawValue);
      return [header, Number.isFinite(numeric) && rawValue !== '' ? numeric : rawValue];
    }));
  });
}

function projectToSchema(rows, schema) {
  if (!schema?.properties?.data?.items?.properties) {
    return rows;
  }

  const targetShape = schema.properties.data.items.properties;
  return rows.map((row) => {
    const projected = {};
    for (const [key, rules] of Object.entries(targetShape)) {
      const sourceKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      const value = sourceKey ? row[sourceKey] : null;
      projected[key] = rules.type === 'number' ? numericMatch(value, 0) : value;
    }
    return projected;
  });
}

app.post('/api/auth/login', async (request, response) => {
  const { email, password } = request.body || {};
  const session = await loginUser(email || '', password || '');

  if (!session) {
    return response.status(401).json({ message: 'Invalid email or password' });
  }

  return response.json(session);
});

app.get('/api/auth/me', requireAuth, (request, response) => {
  response.json(request.user);
});

app.patch('/api/auth/me', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'User', 'update', request.body || {}, request.user);
    const updated = await updateDocument('User', request.user.id, request.body || {});
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (request, response) => {
  await revokeToken(request.token);
  response.status(204).send();
});

app.post('/api/users/invite', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'User', 'create');
    const invited = await inviteUser(request.body?.email, request.body?.role);
    response.json(invited);
  } catch (error) {
    next(error);
  }
});

app.get('/api/menu-plans/by-date', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const planDate = String(request.query.plan_date || '').trim();

    if (!siteId || !planDate) {
      return response.status(400).json({ message: 'site_id and plan_date are required' });
    }

    const plan = await findScopedOperationalMenuPlan(request.user, siteId, planDate);
    return response.json(plan || null);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/menu-plans', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const payload = buildMenuPlanWritePayload(request.body || {});
    if (!payload.site_id || !payload.plan_date) {
      return response.status(400).json({ message: 'Project and plan date are required' });
    }

    const existing = await findScopedOperationalMenuPlan(request.user, payload.site_id, payload.plan_date);
    if (existing) {
      return response.status(409).json({ message: 'A menu plan already exists for this project and date' });
    }

    authorizeEntityAction(request.user, 'MenuPlan', 'create', payload);
    const preparedPayload = await prepareEntityPayload(request.user, 'MenuPlan', payload);
    const created = await createDocument('MenuPlan', preparedPayload);
    return response.status(201).json(created);
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/menu-plans/:id', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const existing = await findDocument('MenuPlan', request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Menu plan not found' });
    }

    if (!isOperationalMenuPlan(existing)) {
      return response.status(400).json({ message: 'Event plans must be edited from the event planning module' });
    }

    const scopedExisting = (await scopeEntityRecords(request.user, 'MenuPlan', [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this menu plan' });
    }

    const payload = buildMenuPlanWritePayload(request.body || {}, existing);
    authorizeEntityAction(request.user, 'MenuPlan', 'update', payload, existing);
    const preparedPayload = await prepareEntityPayload(request.user, 'MenuPlan', payload, existing);
    const updated = await updateDocument('MenuPlan', request.params.id, preparedPayload);
    return response.json(updated);
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/menu-plans/:id', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const existing = await findDocument('MenuPlan', request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Menu plan not found' });
    }

    if (!isOperationalMenuPlan(existing)) {
      return response.status(400).json({ message: 'Event plans must be deleted from the event planning module' });
    }

    const scopedExisting = (await scopeEntityRecords(request.user, 'MenuPlan', [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this menu plan' });
    }

    authorizeEntityAction(request.user, 'MenuPlan', 'delete', null, existing);

    const remainingMeals = (Array.isArray(existing.meals) ? existing.meals : [])
      .filter((meal) => !CORE_MENU_MEAL_TYPES.has(String(meal.meal_type || '').toLowerCase()));

    if (remainingMeals.length > 0) {
      const summary = summarizeMenuPlanMeals(remainingMeals);
      const updated = await updateDocument('MenuPlan', request.params.id, {
        meals: remainingMeals,
        total_expected_servings: summary.total_expected_servings,
        total_calories: summary.total_calories,
        status: 'draft'
      });
      return response.json({ success: true, preserved_event_meals: true, plan: updated });
    }

    await deleteDocument('MenuPlan', request.params.id);
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/entities/:entity', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'list');
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    const records = await listDocuments(entity, {
      sort: request.query.sort,
      limit
    });
    response.json(await scopeEntityRecords(request.user, entity, records));
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity/filter', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'filter');
    const records = await listDocuments(entity, {
      filters: request.body?.filters || {},
      sort: request.body?.sort,
      limit: request.body?.limit
    });
    response.json(await scopeEntityRecords(request.user, entity, records));
  } catch (error) {
    next(error);
  }
});

app.get('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'read');
    const record = await findDocument(entity, request.params.id);
    if (!record) {
      return response.status(404).json({ message: 'Record not found' });
    }
    const scopedRecord = (await scopeEntityRecords(request.user, entity, [record]))[0];
    if (!scopedRecord) {
      return response.status(403).json({ message: 'You do not have access to this record' });
    }
    response.json(scopedRecord);
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'create', request.body || {});
    const preparedPayload = await prepareEntityPayload(request.user, entity, request.body || {});
    let record = await createDocument(entity, preparedPayload);

    if (entity === 'Production' && ['draft', 'pending_approval', 'changes_requested'].includes(String(record.status || ''))) {
      await syncMaterialRequestForProduction(request.user, record, 'draft');
      record = await findDocument(entity, record.id);
    }

    response.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    const existing = await findDocument(entity, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Record not found' });
    }
    const scopedExisting = (await scopeEntityRecords(request.user, entity, [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this record' });
    }
    authorizeEntityAction(request.user, entity, 'update', request.body || {}, existing);
    const preparedPayload = await prepareEntityPayload(request.user, entity, request.body || {}, existing);
    let updated = await updateDocument(entity, request.params.id, preparedPayload);

    if (entity === 'Production') {
      const status = String(updated?.status || '');
      if (['draft', 'pending_approval', 'changes_requested'].includes(status)) {
        await syncMaterialRequestForProduction(request.user, updated, 'draft');
        updated = await findDocument(entity, request.params.id);
      } else if (status === 'approved') {
        await syncMaterialRequestForProduction(request.user, updated, 'activate');
        updated = await findDocument(entity, request.params.id);
      }
    }

    return response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    const existing = await findDocument(entity, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Record not found' });
    }
    const scopedExisting = (await scopeEntityRecords(request.user, entity, [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this record' });
    }
    authorizeEntityAction(request.user, entity, 'delete', null, existing);
    const removed = await deleteDocument(entity, request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'Record not found' });
    }
    return response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/integrations/upload', requireAuth, upload.single('file'), (request, response) => {
  const fileUrl = `/uploads/${request.file.filename}`;
  response.json({
    file_url: fileUrl,
    public_file_url: `${resolvePublicBaseUrl(request)}${fileUrl}`
  });
});

app.post('/api/integrations/send-email', requireAuth, async (request, response) => {
  const payload = request.body || {};

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: payload.to,
      subject: payload.subject || 'FoodPro Notification',
      html: payload.html || payload.body || '<p>No content provided.</p>'
    });
  } else {
    await createEmailLog({
      ...payload,
      status: 'logged_only'
    });
  }

  response.json({ success: true });
});

app.post('/api/integrations/invoke-llm', requireAuth, async (request, response, next) => {
  try {
    const output = await invokeOpenAI(request.body || {}, resolvePublicBaseUrl(request));
    response.json(output);
  } catch (error) {
    next(error);
  }
});

app.post('/api/integrations/extract-file', requireAuth, async (request, response, next) => {
  try {
    const { file_url: fileUrl, json_schema: jsonSchema } = request.body || {};
    const localPath = fileUrl?.startsWith('/uploads/')
      ? path.join(uploadsDir, path.basename(fileUrl))
      : null;

    if (!localPath || !fs.existsSync(localPath)) {
      return response.status(404).json({ message: 'Uploaded file not found' });
    }

    const content = fs.readFileSync(localPath, 'utf8');
    const rows = projectToSchema(parseCsv(content), jsonSchema);
    response.json({
      status: 'success',
      output: { data: rows }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/app-logs', requireAuth, (request, response) => {
  createAppLog({
    page_name: request.body?.pageName,
    user_id: request.user.id,
    user_email: request.user.email,
    payload: request.body || {}
  }).then((log) => {
    response.status(201).json(log);
  }).catch((error) => {
    response.status(500).json({ message: error.message || 'Failed to create app log' });
  });
});

app.get('/api/pos/sources', requireAuth, requireRole(['admin']), async (_request, response, next) => {
  try {
    response.json(await getPosSources());
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/sources', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const created = await createPosSource(request.body || {});
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/pos/sources/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await updatePosSource(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'POS source not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pos/sources/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deletePosSource(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'POS source not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/mappings', requireAuth, requireRole(['admin', 'manager']), async (_request, response, next) => {
  try {
    response.json(await getRecipeMappings());
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/mappings', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const created = await createRecipeMapping(request.body || {});
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/pos/mappings/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await updateRecipeMapping(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'POS mapping not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pos/mappings/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deleteRecipeMapping(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'POS mapping not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/sync-logs', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    response.json(await getSyncLogs(limit));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/import/manual', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const result = await importPosOrders({
      sourceId: request.body?.source_id || null,
      syncType: 'manual_upload',
      actorEmail: request.user.email,
      orders: request.body?.orders || [],
      requestPayload: {
        source_id: request.body?.source_id || null,
        order_count: Array.isArray(request.body?.orders) ? request.body.orders.length : 0
      }
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/sources/:id/sync', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const result = await syncPosSource(request.params.id, request.user.email);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/sales-summary', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getDailySalesSummary({
      startDate: request.query.start_date,
      endDate: request.query.end_date,
      locationId: request.user.role === 'admin'
        ? request.query.location_id
        : (request.query.location_id || [...scope.accessibleSiteIds][0] || null)
    });
    response.json(filterRowsByAccessibleSites(report, scope, ['site_id']));
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/variance-report', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getSalesProductionVariance({
      startDate: request.query.start_date,
      endDate: request.query.end_date,
      locationId: request.user.role === 'admin'
        ? request.query.location_id
        : (request.query.location_id || [...scope.accessibleSiteIds][0] || null)
    });
    response.json(filterRowsByAccessibleSites(report, scope, ['site_id']));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/webhooks/:sourceId', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const payload = Array.isArray(request.body?.orders) ? request.body.orders : (Array.isArray(request.body) ? request.body : []);
    const result = await importPosOrders({
      sourceId: request.params.sourceId,
      syncType: 'webhook',
      actorEmail: request.user.email,
      orders: payload,
      requestPayload: { sourceId: request.params.sourceId, webhook: true }
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/material-requests', requireAuth, requireAnyPermission(['view_material_request', 'create_material_request', 'acknowledge_material_request', 'manage_procurement', 'approve_procurement']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const records = await listDocuments('MaterialRequest', {
      sort: '-request_date',
      limit: 200
    });
    response.json(filterRowsByAccessibleSites(records, scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/material-requests/from-production/:id', requireAuth, requirePermission('create_material_request'), async (request, response, next) => {
  try {
    const { production } = await getScopedProduction(request, request.params.id);
    if (!production) {
      return response.status(404).json({ message: 'Production record not found' });
    }
    const mode = String(request.body?.mode || 'activate').toLowerCase();
    const materialRequest = await syncMaterialRequestForProduction(request.user, production, mode);
    if (!materialRequest) {
      return response.status(400).json({ message: 'Production request has no ingredients to build a material request.' });
    }
    response.status(201).json(materialRequest);
  } catch (error) {
    next(error);
  }
});

app.post('/api/material-requests/:id/acknowledge', requireAuth, requireAnyPermission(['acknowledge_material_request', 'manage_procurement', 'approve_procurement']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const materialRequest = await findDocument('MaterialRequest', request.params.id);
    if (!materialRequest || !filterRowsByAccessibleSites([materialRequest], scope).length) {
      return response.status(404).json({ message: 'Material request not found' });
    }

    const updated = await updateDocument('MaterialRequest', request.params.id, {
      status: 'acknowledged',
      acknowledged_by: request.user.email,
      acknowledged_by_name: request.user.full_name || request.user.email,
      acknowledged_at: new Date().toISOString(),
      procurement_notes: request.body?.notes || materialRequest.procurement_notes || null
    });

    if (materialRequest.source_production_id) {
      await updateDocument('Production', materialRequest.source_production_id, {
        material_request_status: 'acknowledged'
      });
    }

    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/suppliers', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listSuppliers());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/suppliers', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.status(201).json(await createSupplier(request.body || {}));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/procurement/suppliers/:id', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await updateSupplier(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'Supplier not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/procurement/suppliers/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deleteSupplier(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'Supplier not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/requests', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listPurchaseRequests(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'MaterialRequest', request.body || {}, scope);
    response.status(201).json(await createPurchaseRequest(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/auto-generate', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'MaterialRequest', request.body || {}, scope);
    response.status(201).json(await autoGeneratePurchaseRequestFromLowStock(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/:id/approve', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await approvePurchaseRequest(request.params.id, { ...(request.body || {}), status: 'approved' }, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/:id/reject', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await approvePurchaseRequest(request.params.id, { ...(request.body || {}), status: 'rejected' }, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/orders', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listPurchaseOrders(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'PurchaseOrder', request.body || {}, scope);
    response.status(201).json(await createPurchaseOrder(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders/:id/approve', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const updated = await approvePurchaseOrder(request.params.id, request.body || {}, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders/:id/cancel', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await cancelPurchaseOrder(request.params.id, request.body || {}, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/receipts', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listGoodsReceipts(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/receipts', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'PurchaseOrder', request.body || {}, scope);
    response.status(201).json(await createGoodsReceipt(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/invoices', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listSupplierInvoices(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/invoices', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'PurchaseOrder', request.body || {}, scope);
    response.status(201).json(await createSupplierInvoice(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/price-comparison', requireAuth, async (request, response, next) => {
  try {
    response.json(await listSupplierPriceComparison({
      ingredientId: request.query.ingredient_id,
      supplierId: request.query.supplier_id
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/performance', requireAuth, requireRole(['admin', 'manager']), async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await getSupplierPerformanceDashboard(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/receive', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'Inventory', request.body || {}, scope);
    response.status(201).json(await receiveStock({
      ...(request.body || {}),
      performed_by: request.user.email
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/adjust', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const inventoryRecord = request.body?.inventory_id ? await findDocument('Inventory', request.body.inventory_id) : null;
    if (inventoryRecord) {
      assertPayloadLocationAccess(request.user, 'Inventory', inventoryRecord, scope);
    }
    response.json(await adjustStock({
      ...(request.body || {}),
      performed_by: request.user.email
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/transfer', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'ProductionTransfer', request.body || {}, scope);
    response.json(await transferStock({
      ...(request.body || {}),
      performed_by: request.user.email
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/production/:id/complete', requireAuth, requirePermission('complete_production'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const production = await findDocument('Production', request.params.id);
    if (!production || !filterRowsByAccessibleSites([production], scope).length) {
      return response.status(403).json({ message: 'You do not have access to this production record' });
    }
    response.json(await completeProduction(request.params.id, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/lots', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const lots = await listInventoryLots({
      siteId: request.query.site_id,
      ingredientId: request.query.ingredient_id,
      includeEmpty: request.query.include_empty === 'true'
    });
    response.json(filterRowsByAccessibleSites(lots, scope));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/stock-on-hand', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(filterRowsByAccessibleSites(await getStockOnHandReport(), scope));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/movements', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getStockMovementReport({
      siteId: request.query.site_id,
      ingredientId: request.query.ingredient_id,
      dateFrom: request.query.date_from,
      dateTo: request.query.date_to
    });
    response.json(filterRowsByAccessibleSites(report, scope));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/expiry', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getExpiryReport({
      thresholdDays: request.query.threshold_days ? Number(request.query.threshold_days) : 30
    });
    response.json(filterRowsByAccessibleSites(report, scope));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/velocity', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getVelocityReports({
      days: request.query.days ? Number(request.query.days) : 30
    });
    response.json({
      fast_moving: filterRowsByAccessibleSites(report.fast_moving || [], scope),
      slow_moving: filterRowsByAccessibleSites(report.slow_moving || [], scope)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/valuation', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(filterRowsByAccessibleSites(await getInventoryValuationReport(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/erp/export', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.json(await exportToErp({
      user: request.user,
      configId: request.body?.config_id || null,
      moduleKey: request.body?.module_key,
      transport: request.body?.transport || 'csv',
      startDate: request.body?.start_date || '',
      endDate: request.body?.end_date || '',
      locationId: request.body?.location_id || '',
      category: request.body?.category || ''
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/erp/logs', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(await listErpLogs(scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/erp/logs/:id/retry', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    response.json(await retryErpSync(request.params.id, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/forecasting/summary', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const requestedLocation = request.query.location_id || null;
    const locationId = request.user.role === 'admin'
      ? requestedLocation
      : (requestedLocation
        ? (scope.accessibleSiteIds.has(String(requestedLocation)) ? requestedLocation : ([...scope.accessibleSiteIds][0] || null))
        : null);

    response.json(await buildForecastSummary({
      startDate: request.query.start_date || '',
      endDate: request.query.end_date || '',
      locationId,
      accessibleSiteIds: request.user.role === 'admin' ? null : scope.accessibleSiteIds,
      category: request.query.category || 'all',
      status: request.query.status || 'all',
      horizonDays: request.query.horizon_days ? Number(request.query.horizon_days) : 7,
      safetyBufferPercent: request.query.safety_buffer_percent ? Number(request.query.safety_buffer_percent) : 10
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/forecasting/scenarios/:id/run', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(await runForecastScenario({
      scenarioId: request.params.id,
      user: request.user,
      locationScope: scope
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/') || request.path.startsWith('/uploads/')) {
      return next();
    }
    return response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: error.message || 'Internal server error' });
});

await initDatabaseWithRetry();

app.listen(port, host, () => {
  console.log(`FoodPro server listening on ${host}:${port}`);
});
