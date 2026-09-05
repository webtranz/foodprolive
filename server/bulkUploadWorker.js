import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import readline from 'node:readline';
import { once } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import {
  pool,
  withTransaction,
  createDocument,
  updateDocument,
  listDocuments,
  getBulkUploadJob,
  updateBulkUploadJob,
  clearDocumentsForBulk
} from './db.js';
import { authorizeEntityAction } from './entities.js';
import { createSiteGraph, getLocationScope, assertPayloadLocationAccess } from './locationScope.js';
import {
  getUtilityModule,
  buildIngredientPayloadFromInventoryUpload,
  mapCsvRow,
  parseCsvLine,
  resolveBulkInventoryIngredient,
  resolveBulkInventoryStore,
  resolveBulkInventoryUnit,
  validateCsvHeaders
} from './utilities.js';
import { auditAction } from './audit.js';
import { prepareEntityPayload } from './entityPreparation.js';
import { resolveProductionFulfillmentStore } from '../shared/productionFulfillment.js';
import { assertBulkUploadAdministrator } from '../shared/bulkUploadAccess.js';
import { materializeStoredReference, removeStoredReference } from './objectStorage.js';
import { deductStock, ensureInventoryRecord, receiveStock } from './inventory.js';
import { normalizeSourceName } from '../shared/sourceNames.js';
import { convertIngredientQuantity } from '../shared/ingredientUnits.js';
import { normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';

const MAX_RECORDED_ERRORS = 100;
let materializedUpload = null;
let stagedPathToCleanup = null;

function isDuplicateError(error) {
  const message = String(error?.message || '');
  return error?.code === '23505'
    || /already exists/i.test(message)
    || /duplicate key/i.test(message);
}

function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase();
}

function getIngredientMatchCodes(ingredient = {}) {
  return [
    ingredient.item_code,
    ingredient.ingredient_code,
    ingredient.sku,
    ingredient.d365_item_id
  ].map(normalizeLookup).filter(Boolean);
}

function chooseBestIngredientMatch(matches = [], codeCandidates = [], nameCandidate = '', options = {}) {
  const uniqueMatches = [...new Map(matches.map((ingredient) => [ingredient.id, ingredient])).values()];
  if (uniqueMatches.length <= 1) return uniqueMatches[0] || null;

  const activeMatches = uniqueMatches.filter((ingredient) => ingredient.is_active !== false);
  const pool = activeMatches.length ? activeMatches : uniqueMatches;
  const exactCodeMatches = pool.filter((ingredient) => getIngredientMatchCodes(ingredient)
    .some((code) => codeCandidates.includes(code)));
  if (exactCodeMatches.length === 1) return exactCodeMatches[0];

  const exactNameMatches = pool.filter((ingredient) => nameCandidate && normalizeLookup(ingredient.name) === nameCandidate);
  if (exactNameMatches.length === 1) return exactNameMatches[0];
  if (options.allowAmbiguousCodeMatch && exactCodeMatches.length > 0) return exactCodeMatches[0];

  return null;
}

function findBulkIngredientMatch(ingredients = [], payload = {}) {
  const codeCandidates = [
    payload.item_code,
    payload.ingredient_code,
    payload.sku,
    payload.d365_item_id
  ].map(normalizeLookup).filter(Boolean);
  const nameCandidate = normalizeLookup(payload.name);
  const matches = ingredients.filter((ingredient) => {
    const ingredientCodes = getIngredientMatchCodes(ingredient);
    return codeCandidates.some((code) => ingredientCodes.includes(code))
      || (nameCandidate && normalizeLookup(ingredient.name) === nameCandidate);
  });
  const match = chooseBestIngredientMatch(matches, codeCandidates, nameCandidate);
  if (match) return match;
  if (matches.length > 1) {
    const error = new Error(`Ingredient "${payload.item_code || payload.name}" matches multiple existing ingredients.`);
    error.status = 409;
    throw error;
  }
  return matches[0] || null;
}

function findRecipeLineIngredientMatch(ingredients = [], line = {}) {
  const codeCandidates = [
    line.item_code,
    line.ingredient_code,
    line.sku,
    line.d365_item_id,
    line.ingredient_id
  ].map(normalizeLookup).filter(Boolean);
  const nameCandidate = normalizeLookup(line.ingredient_name || line.name);
  const codeMatches = ingredients.filter((ingredient) => {
    const ingredientCodes = getIngredientMatchCodes(ingredient);
    return codeCandidates.some((code) => ingredientCodes.includes(code));
  });
  const matches = codeMatches.length
    ? codeMatches
    : ingredients.filter((ingredient) => nameCandidate && normalizeLookup(ingredient.name) === nameCandidate);
  return chooseBestIngredientMatch(matches, codeCandidates, nameCandidate, { allowAmbiguousCodeMatch: true });
}

function findBulkRecipeMatch(recipes = [], payload = {}) {
  const codeCandidate = normalizeLookup(payload.recipe_code);
  const nameCandidate = normalizeLookup(payload.name);
  const matches = recipes.filter((recipe) => (
    (codeCandidate && normalizeLookup(recipe.recipe_code) === codeCandidate)
    || (nameCandidate && normalizeLookup(recipe.name) === nameCandidate)
  ));
  const uniqueMatches = [...new Map(matches.map((recipe) => [recipe.id, recipe])).values()];
  if (uniqueMatches.length > 1) {
    const error = new Error(`Recipe "${payload.recipe_code || payload.name}" matches multiple existing recipes.`);
    error.status = 409;
    throw error;
  }
  return uniqueMatches[0] || null;
}

function findBulkMenuPlanMatch(menuPlans = [], payload = {}) {
  const siteCandidate = normalizeLookup(payload.site_id);
  const dateCandidate = normalizeLookup(payload.plan_date);
  const cuisineCandidate = normalizeMenuCuisine(payload.cuisine_type, 'general');
  const categoryCandidate = normalizeMenuCategory(payload.menu_category, 'senior');
  if (!siteCandidate || !dateCandidate) return null;
  const matches = menuPlans.filter((plan) => (
    normalizeLookup(plan.site_id) === siteCandidate
    && normalizeLookup(plan.plan_date) === dateCandidate
    && normalizeMenuCuisine(plan.cuisine_type, 'general') === cuisineCandidate
    && normalizeMenuCategory(plan.menu_category, 'senior') === categoryCandidate
    && !normalizeLookup(plan.event_name)
  ));
  const uniqueMatches = [...new Map(matches.map((plan) => [plan.id, plan])).values()];
  if (uniqueMatches.length > 1) {
    const error = new Error(`Menu plan for ${payload.site_name || payload.site_id} on ${payload.plan_date} matches multiple existing records.`);
    error.status = 409;
    throw error;
  }
  return uniqueMatches[0] || null;
}

async function findBulkRecipeMatchInDatabase(client, payload = {}) {
  const codeCandidate = normalizeLookup(payload.recipe_code);
  const nameCandidate = normalizeLookup(payload.name);
  if (!codeCandidate && !nameCandidate) return null;
  const result = await client.query(
    `SELECT data
     FROM entity_records
     WHERE entity_name = 'Recipe'
       AND (
         ($1 <> '' AND LOWER(COALESCE(data->>'recipe_code', '')) = $1)
         OR ($2 <> '' AND LOWER(COALESCE(data->>'name', '')) = $2)
       )
     LIMIT 2`,
    [codeCandidate, nameCandidate]
  );
  const matches = result.rows.map((row) => row.data);
  const uniqueMatches = [...new Map(matches.map((recipe) => [recipe.id, recipe])).values()];
  if (uniqueMatches.length > 1) {
    const error = new Error(`Recipe "${payload.recipe_code || payload.name}" matches multiple existing recipes.`);
    error.status = 409;
    throw error;
  }
  return uniqueMatches[0] || null;
}

function buildIngredientPayloadFromRecipeLine(line = {}) {
  const itemCode = String(line.item_code || line.ingredient_code || line.sku || '').trim();
  const name = String(line.ingredient_name || line.name || '').trim();
  if (!itemCode || !name) return null;
  return {
    item_code: itemCode,
    ingredient_code: itemCode,
    sku: itemCode,
    name,
    supplier_item_name: name,
    unit: line.unit || 'kg',
    category: line.category || 'Recipe Ingredients',
    cost_per_unit: line.cost_per_unit ?? 0,
    cooking_yield_percent: line.cooking_yield_percent ?? 100,
    shrinkage_percent: line.shrinkage_percent ?? 0,
    allergens: Array.isArray(line.allergens) ? line.allergens : [],
    is_active: true
  };
}

function getJobSourceName(job = {}) {
  return normalizeSourceName(job.source_name, '');
}

function getJobRecipeType(job = {}) {
  const recipeType = String(job.actor_snapshot?.bulk_options?.recipe_type || '').trim().toLowerCase();
  if (recipeType === 'filipino') return 'Filipino';
  if (recipeType === 'general') return 'General';
  return '';
}

function getJobMenuCuisine(job = {}) {
  return normalizeMenuCuisine(job.actor_snapshot?.bulk_options?.menu_cuisine, 'general');
}

function getJobMenuCategory(job = {}) {
  return normalizeMenuCategory(job.actor_snapshot?.bulk_options?.menu_category, 'senior');
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundQuantity(value) {
  return Number(toNumber(value, 0).toFixed(6));
}

function inventoryPhysicalQuantity(record = {}) {
  const numeric = Number(
    record?.on_hand_quantity
      ?? record?.usable_on_hand_quantity
      ?? record?.available_quantity
      ?? record?.quantity
      ?? 0
  );
  return Number.isFinite(numeric) ? numeric : 0;
}

function resolveBulkCanonicalQuantity(payload = {}, ingredient = {}, canonicalUnit = '') {
  return roundQuantity(convertIngredientQuantity(
    payload.quantity,
    payload.unit || canonicalUnit,
    canonicalUnit,
    ingredient
  ));
}

function resolveBulkCanonicalUnitCost(payload = {}, ingredient = {}, canonicalQuantity = 0) {
  const uploadedUnitCost = payload.unit_cost ?? payload.cost_per_unit;
  if (uploadedUnitCost !== undefined && uploadedUnitCost !== null && uploadedUnitCost !== '') {
    const sourceQuantity = toNumber(payload.quantity, 0);
    const sourceUnitCost = toNumber(uploadedUnitCost, 0);
    return canonicalQuantity > 0
      ? Number(((sourceQuantity * sourceUnitCost) / canonicalQuantity).toFixed(6))
      : sourceUnitCost;
  }
  return toNumber(
    ingredient.cost_per_unit
      ?? ingredient.average_cost
      ?? ingredient.current_cost
      ?? ingredient.last_cost,
    0
  );
}

async function applyStockSnapshotUploadRow({ job, staged, user, context, client }) {
  if (staged.payload.quantity === undefined || staged.payload.quantity === null || staged.payload.quantity === '') {
    const error = new Error('quantity is required for stock updates');
    error.status = 400;
    throw error;
  }
  const ingredient = job.entity_name === 'Inventory' && job.import_mode !== 'update_stock_only'
    ? await getOrCreateBulkInventoryIngredient({
        staged,
        user,
        context,
        client
      })
    : resolveBulkInventoryIngredient({
        ingredients: context.ingredientCatalog,
        itemCode: staged.payload.item_code || staged.payload.ingredient_code || staged.payload.sku,
        ingredientId: staged.payload.ingredient_id
      });
  const site = resolveBulkInventoryStore({
    sites: context.scope.sites,
    rowSiteId: staged.payload.site_id,
    rowSiteName: staged.payload.site_name || staged.payload.source_site || staged.payload.source_warehouse,
    defaultSiteId: job.site_id,
    defaultSiteName: job.site_name
  });
  const canonicalUnit = resolveBulkInventoryUnit(ingredient, staged.payload.unit);
  const canonicalQuantity = resolveBulkCanonicalQuantity(staged.payload, ingredient, canonicalUnit);
  const sourceName = getJobSourceName(job) || staged.payload.source_name || undefined;
  const metadata = {
    ...(staged.payload.metadata && typeof staged.payload.metadata === 'object'
      ? staged.payload.metadata
      : {}),
    source_file_name: job.file_name || null,
    source_item_group: staged.payload.source_item_group || staged.payload.category || null,
    source_item_duplicate: staged.payload.source_item_duplicate || staged.payload.ingredient_code || null,
    source_site: staged.payload.source_site || staged.payload.site_name || null,
    source_warehouse: staged.payload.source_warehouse || null,
    source_quantity: staged.payload.source_quantity ?? staged.payload.quantity ?? null,
    source_amount: staged.payload.source_amount ?? null,
    uploaded_quantity: staged.payload.quantity,
    uploaded_unit: staged.payload.unit || canonicalUnit,
    canonical_quantity: canonicalQuantity,
    quantity_semantics: job.import_mode === 'replace_existing' ? 'reload' : 'snapshot',
    stock_update_only: job.import_mode === 'update_stock_only'
  };
  const inventory = await ensureInventoryRecord({
    site_id: site.id,
    site_name: site.name || null,
    ingredient_id: ingredient.id,
    ingredient_name: ingredient.name,
    unit: canonicalUnit,
    min_stock_level: staged.payload.min_stock_level,
    max_stock_level: staged.payload.max_stock_level,
    valuation_method: staged.payload.valuation_method,
    source_name: sourceName
  }, client);
  const baseMovementPayload = {
    site_id: site.id,
    site_name: site.name || null,
    ingredient_id: ingredient.id,
    ingredient_name: ingredient.name,
    unit: canonicalUnit,
    stock_date: staged.payload.stock_date || null,
    received_date: staged.payload.stock_date || null,
    transaction_date: staged.payload.stock_date || null,
    reference_id: staged.payload.reference_id || job.id,
    reference_type: 'bulk_inventory_upload',
    source_name: sourceName,
    source: 'bulk_upload',
    source_type: job.import_mode === 'update_stock_only' ? 'stock_only_snapshot_upload' : 'stock_snapshot_upload',
    performed_by: user?.email || 'bulk-upload',
    metadata
  };
  assertPayloadLocationAccess(user, 'Inventory', baseMovementPayload, context.scope);
  const beforeQuantity = inventoryPhysicalQuantity(inventory);
  const deltaQuantity = roundQuantity(canonicalQuantity - beforeQuantity);
  if (deltaQuantity > 0) {
    await receiveStock({
      ...baseMovementPayload,
      quantity: deltaQuantity,
      unit_cost: resolveBulkCanonicalUnitCost(staged.payload, ingredient, canonicalQuantity),
      batch_number: staged.payload.batch_number,
      expiry_date: staged.payload.expiry_date || null,
      min_stock_level: staged.payload.min_stock_level,
      max_stock_level: staged.payload.max_stock_level,
      valuation_method: staged.payload.valuation_method,
      source_type: baseMovementPayload.source_type,
      reason_code: job.import_mode === 'update_stock_only'
        ? 'bulk_stock_only_snapshot_increase'
        : 'bulk_inventory_snapshot_increase',
      notes: staged.payload.notes || `Inventory refreshed from bulk upload ${job.file_name || job.id}`
    }, client);
  } else if (deltaQuantity < 0) {
    await deductStock({
      ...baseMovementPayload,
      quantity: Math.abs(deltaQuantity),
      transaction_type: 'adjustment',
      valuation_method: inventory.valuation_method || staged.payload.valuation_method || 'fifo',
      reason_code: job.import_mode === 'update_stock_only'
        ? 'bulk_stock_only_snapshot_decrease'
        : 'bulk_inventory_snapshot_decrease',
      allow_shortage: false,
      notes: staged.payload.notes || `Inventory reduced to uploaded stock snapshot from ${job.file_name || job.id}`
    }, client);
  } else {
    await updateDocument('Inventory', inventory.id, {
      source_name: sourceName,
      last_bulk_upload_id: job.id,
      last_bulk_upload_file_name: job.file_name || null,
      last_bulk_upload_quantity: canonicalQuantity,
      last_bulk_uploaded_at: new Date().toISOString()
    }, client);
  }
}

async function ensureRecipeIngredientsExist({ payload, user, context, client }) {
  if (!Array.isArray(payload.ingredients)) return payload;
  if (!Array.isArray(context.ingredientCatalog)) context.ingredientCatalog = [];
  const nextIngredients = [];
  for (const line of payload.ingredients) {
    const existingIngredient = findRecipeLineIngredientMatch(context.ingredientCatalog, line);
    if (existingIngredient) {
      nextIngredients.push({
        ...line,
        item_code: existingIngredient.item_code || line.item_code,
        ingredient_id: existingIngredient.id,
        ingredient_name: existingIngredient.name || line.ingredient_name,
        unit: line.unit || existingIngredient.unit
      });
      continue;
    }

    const ingredientPayload = buildIngredientPayloadFromRecipeLine(line);
    if (!ingredientPayload) {
      nextIngredients.push(line);
      continue;
    }
    authorizeEntityAction(user, 'Ingredient', 'create', ingredientPayload);
    const preparedIngredient = await prepareEntityPayload(
      user,
      'Ingredient',
      ingredientPayload,
      null,
      context
    );
    let createdIngredient = null;
    let createdDuringUpload = false;
    try {
      createdIngredient = await createDocument('Ingredient', preparedIngredient, client);
      createdDuringUpload = true;
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      context.ingredientCatalog = await listDocuments('Ingredient', { limit: 10000 }, client);
      createdIngredient = findRecipeLineIngredientMatch(context.ingredientCatalog, ingredientPayload);
      if (!createdIngredient) throw error;
    }
    if (createdDuringUpload) context.ingredientCatalog.push(createdIngredient);
    nextIngredients.push({
      ...line,
      item_code: createdIngredient.item_code || ingredientPayload.item_code,
      ingredient_id: createdIngredient.id,
      ingredient_name: createdIngredient.name || ingredientPayload.name,
      unit: line.unit || createdIngredient.unit
    });
  }
  return { ...payload, ingredients: nextIngredients };
}

async function getOrCreateBulkInventoryIngredient({ staged, user, context, client }) {
  try {
    return resolveBulkInventoryIngredient({
      ingredients: context.ingredientCatalog,
      itemCode: staged.payload.item_code,
      ingredientId: staged.payload.ingredient_id
    });
  } catch (error) {
    const canCreateFromInventoryRow = error?.status === 404
      && !staged.payload.ingredient_id
      && staged.payload.item_code
      && staged.payload.ingredient_name
      && staged.payload.unit;
    if (!canCreateFromInventoryRow) throw error;

    const ingredientPayload = buildIngredientPayloadFromInventoryUpload(staged.payload);
    if (!ingredientPayload) throw error;
    ingredientPayload.source_name = getJobSourceName(context.job) || staged.payload.source_name || undefined;
    authorizeEntityAction(user, 'Ingredient', 'create', ingredientPayload);
    const preparedIngredient = await prepareEntityPayload(
      user,
      'Ingredient',
      ingredientPayload,
      null,
      context
    );
    const createdIngredient = await createDocument('Ingredient', preparedIngredient, client);
    context.ingredientCatalog.push(createdIngredient);
    return createdIngredient;
  }
}

async function clearInventoryForBulkUpload(job, context, client) {
  const filters = job.site_id ? { site_id: job.site_id } : {};
  const inventoryRows = await listDocuments('Inventory', { filters, limit: 10000, lock: true }, client);
  const scopedRows = context.scope.unrestricted
    ? inventoryRows
    : inventoryRows.filter((row) => context.scope.accessibleSiteIds.has(String(row.site_id || '')));
  let deletedRows = 0;
  for (const inventory of scopedRows) {
    await client.query(
      `DELETE FROM entity_records
       WHERE entity_name = $1
         AND data->>'site_id' = $2
         AND data->>'ingredient_id' = $3`,
      ['InventoryLot', String(inventory.site_id || ''), String(inventory.ingredient_id || '')]
    );
    const result = await client.query(
      `DELETE FROM entity_records
       WHERE entity_name = $1 AND id = $2`,
      ['Inventory', inventory.id]
    );
    deletedRows += result.rowCount || 0;
  }
  return deletedRows;
}

async function clearRecipeMatchesForBulkUpload(stagedPath, client) {
  const recipeCodes = new Set();
  const recipeNames = new Set();
  const input = fs.createReadStream(stagedPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const staged = JSON.parse(line);
    const recipeCode = normalizeLookup(staged.payload?.recipe_code);
    const recipeName = normalizeLookup(staged.payload?.name);
    if (recipeCode) recipeCodes.add(recipeCode);
    if (recipeName) recipeNames.add(recipeName);
  }

  if (recipeCodes.size === 0 && recipeNames.size === 0) return 0;
  const result = await client.query(
    `DELETE FROM entity_records
     WHERE entity_name = 'Recipe'
       AND (
         LOWER(COALESCE(data->>'recipe_code', '')) = ANY($1::text[])
         OR LOWER(COALESCE(data->>'name', '')) = ANY($2::text[])
       )`,
    [[...recipeCodes], [...recipeNames]]
  );
  return result.rowCount || 0;
}

async function clearRecipesForBulkDelete(job, siteIds = null, client) {
  const recipeType = getJobRecipeType(job);
  if (!recipeType) {
    const error = new Error('Select Recipe Type before deleting recipes.');
    error.status = 400;
    throw error;
  }
  const recipeTypeLookup = normalizeLookup(recipeType);
  if (Array.isArray(siteIds)) {
    if (!siteIds.length) return 0;
    const result = await client.query(
      `DELETE FROM entity_records
       WHERE entity_name = 'Recipe'
         AND (
           LOWER(COALESCE(data->>'cuisine_type', '')) = $1
           OR LOWER(COALESCE(data->>'recipe_type', '')) = $1
         )
         AND (
           data->>'site_id' = ANY($2::text[])
           OR COALESCE(data->'site_ids', '[]'::jsonb) ?| $2::text[]
         )`,
      [recipeTypeLookup, siteIds]
    );
    return result.rowCount || 0;
  }
  const result = await client.query(
    `DELETE FROM entity_records
     WHERE entity_name = 'Recipe'
       AND (
         LOWER(COALESCE(data->>'cuisine_type', '')) = $1
         OR LOWER(COALESCE(data->>'recipe_type', '')) = $1
       )`,
    [recipeTypeLookup]
  );
  return result.rowCount || 0;
}

async function readCsv(filePath, onHeaders, onRow) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  let rowNumber = 0;
  for await (const line of lines) {
    if (!headers) {
      if (!line.trim()) continue;
      headers = parseCsvLine(line);
      await onHeaders(headers);
      continue;
    }
    if (!line.trim()) continue;
    rowNumber += 1;
    await onRow(headers, parseCsvLine(line), rowNumber);
  }
  return rowNumber;
}

async function validateToJsonLines(job, definition, stagedPath) {
  const output = fs.createWriteStream(stagedPath, { encoding: 'utf8' });
  const errors = [];
  let validRows = 0;
  let totalRows = 0;
  try {
    await readCsv(
      job.file_path,
      async (headers) => {
        const headerErrors = validateCsvHeaders(job.module_key, headers);
        if (headerErrors.length) throw new Error(headerErrors.join(' '));
      },
      async (headers, values, rowNumber) => {
        totalRows += 1;
        try {
          const payload = mapCsvRow(job.module_key, headers, values);
          if (
            job.site_id
            && definition.headers.includes('site_id')
            && !payload.site_id
            && !payload.site_name
          ) {
            payload.site_id = job.site_id;
            payload.site_name = payload.site_name || job.site_name || undefined;
          }
          if (!output.write(`${JSON.stringify({ rowNumber, payload })}\n`)) {
            await once(output, 'drain');
          }
          validRows += 1;
        } catch (error) {
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({ row: rowNumber, message: error.message || 'Invalid row' });
          }
        }
        if (totalRows % job.batch_size === 0) {
          await updateBulkUploadJob(job.id, {
            total_rows: totalRows,
            failed_rows: totalRows - validRows,
            errors,
            message: `Validated ${totalRows} rows in background batches.`
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    );
  } finally {
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on('error', reject);
    });
  }
  return { errors, validRows, invalidRows: totalRows - validRows, totalRows, definition };
}

async function processBatch({ job, batch, user, context, counters, errors, executor = null, failFast = false }) {
  const applyBatch = async (client) => {
    for (const staged of batch) {
      await client.query('SAVEPOINT bulk_upload_row');
      let recipePayloadForDuplicateRecovery = null;
      try {
        if (
          job.entity_name === 'Inventory'
          || (job.entity_name === 'Ingredient' && job.import_mode === 'update_stock_only')
        ) {
          if (job.entity_name === 'Inventory' && !['keep_existing', 'update_stock_only', 'replace_existing'].includes(job.import_mode)) {
            const error = new Error('Inventory uploads support keep-existing stock refresh, update-stock-only refresh, or replace-existing reload mode.');
            error.status = 409;
            throw error;
          }
          if (job.entity_name === 'Ingredient' && job.import_mode !== 'update_stock_only') {
            const error = new Error('Ingredient stock updates must use update-stock-only mode.');
            error.status = 409;
            throw error;
          }
          await applyStockSnapshotUploadRow({
            job,
            staged,
            user,
            context,
            client
          });
          counters.applied += 1;
          await client.query('RELEASE SAVEPOINT bulk_upload_row');
          counters.processed += 1;
          continue;
        }
        authorizeEntityAction(user, job.entity_name, 'create', staged.payload);
        const recipeType = job.entity_name === 'Recipe' ? getJobRecipeType(job) : '';
        const stagedPayload = job.entity_name === 'Recipe'
          ? await ensureRecipeIngredientsExist({
            payload: {
              ...staged.payload,
              ...(recipeType ? { cuisine_type: recipeType } : {})
            },
            user,
            context,
            client
          })
          : (job.entity_name === 'Ingredient'
            ? {
                ...staged.payload,
                source_name: getJobSourceName(job) || staged.payload.source_name || undefined
              }
            : (job.entity_name === 'MenuPlan'
              ? {
                  ...staged.payload,
                  cuisine_type: getJobMenuCuisine(job),
                  menu_category: getJobMenuCategory(job)
                }
              : staged.payload));
        let preparedPayload = await prepareEntityPayload(
          user,
          job.entity_name,
          stagedPayload,
          null,
          context
        );
        if (job.entity_name === 'Recipe') {
          recipePayloadForDuplicateRecovery = {
            ...staged.payload,
            ...(recipeType ? { cuisine_type: recipeType } : {})
          };
        }
        if (job.entity_name === 'Production') {
          const requestedStatus = String(preparedPayload.status || 'planned').toLowerCase();
          if (!['draft', 'planned'].includes(requestedStatus)) {
            const error = new Error('Bulk-uploaded Production rows must start as Production Created.');
            error.status = 409;
            throw error;
          }
          const fulfillmentStore = resolveProductionFulfillmentStore(preparedPayload, context.scope.sites);
          preparedPayload = {
            ...preparedPayload,
            status: 'planned',
            fulfillment_store_id: fulfillmentStore.id,
            fulfillment_store_name: fulfillmentStore.name || null
          };
        }
        assertPayloadLocationAccess(user, job.entity_name, preparedPayload, context.scope);
        if (job.entity_name === 'MenuPlan' && job.import_mode === 'keep_existing') {
          const existingMenuPlan = findBulkMenuPlanMatch(context.menuPlanCatalog, preparedPayload);
          if (existingMenuPlan) {
            authorizeEntityAction(user, job.entity_name, 'update', preparedPayload, existingMenuPlan);
            const updated = await updateDocument(job.entity_name, existingMenuPlan.id, preparedPayload, client);
            const existingIndex = context.menuPlanCatalog.findIndex((item) => item.id === existingMenuPlan.id);
            if (existingIndex >= 0) context.menuPlanCatalog[existingIndex] = updated;
            counters.applied += 1;
            await client.query('RELEASE SAVEPOINT bulk_upload_row');
            counters.processed += 1;
            continue;
          }
        }
        if (job.entity_name === 'Ingredient' && job.import_mode === 'keep_existing') {
          const existingIngredient = findBulkIngredientMatch(context.ingredientCatalog, preparedPayload);
          if (existingIngredient) {
            authorizeEntityAction(user, job.entity_name, 'update', preparedPayload);
            const updated = await updateDocument(job.entity_name, existingIngredient.id, preparedPayload, client);
            const existingIndex = context.ingredientCatalog.findIndex((item) => item.id === existingIngredient.id);
            if (existingIndex >= 0) context.ingredientCatalog[existingIndex] = updated;
            counters.applied += 1;
            await client.query('RELEASE SAVEPOINT bulk_upload_row');
            counters.processed += 1;
            continue;
          }
        }
        if (job.entity_name === 'Recipe' && job.import_mode === 'keep_existing') {
          const existingRecipe = findBulkRecipeMatch(context.recipeCatalog, preparedPayload);
          if (existingRecipe) {
            authorizeEntityAction(user, job.entity_name, 'update', preparedPayload);
            const updated = await updateDocument(job.entity_name, existingRecipe.id, preparedPayload, client);
            const existingIndex = context.recipeCatalog.findIndex((item) => item.id === existingRecipe.id);
            if (existingIndex >= 0) context.recipeCatalog[existingIndex] = updated;
            counters.applied += 1;
            await client.query('RELEASE SAVEPOINT bulk_upload_row');
            counters.processed += 1;
            continue;
          }
        }
        const created = await createDocument(job.entity_name, preparedPayload, client);
        if (job.entity_name === 'Ingredient' && Array.isArray(context.ingredientCatalog)) {
          context.ingredientCatalog.push(created);
        }
        if (job.entity_name === 'Recipe' && Array.isArray(context.recipeCatalog)) {
          context.recipeCatalog.push(created);
        }
        if (job.entity_name === 'Site') {
          context.scope.sites = [...(context.scope.sites || []), created];
          context.scope.graph = createSiteGraph(context.scope.sites);
        }
        counters.applied += 1;
        await client.query('RELEASE SAVEPOINT bulk_upload_row');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT bulk_upload_row');
        await client.query('RELEASE SAVEPOINT bulk_upload_row');
        if (
          isDuplicateError(error)
          && job.entity_name === 'Recipe'
          && job.import_mode === 'keep_existing'
          && recipePayloadForDuplicateRecovery
        ) {
          try {
            await client.query('SAVEPOINT bulk_upload_row_recover');
            context.ingredientCatalog = await listDocuments('Ingredient', { limit: 10000 }, client);
            const recoveredStagedPayload = await ensureRecipeIngredientsExist({
              payload: recipePayloadForDuplicateRecovery,
              user,
              context,
              client
            });
            const recoveredPreparedPayload = await prepareEntityPayload(
              user,
              job.entity_name,
              recoveredStagedPayload,
              null,
              context
            );
            const existingRecipe = await findBulkRecipeMatchInDatabase(
              client,
              recoveredPreparedPayload
            );
            if (!existingRecipe) throw error;
            authorizeEntityAction(user, job.entity_name, 'update', recoveredPreparedPayload);
            const updated = await updateDocument(
              job.entity_name,
              existingRecipe.id,
              recoveredPreparedPayload,
              client
            );
            if (Array.isArray(context.recipeCatalog)) {
              const existingIndex = context.recipeCatalog.findIndex((item) => item.id === existingRecipe.id);
              if (existingIndex >= 0) context.recipeCatalog[existingIndex] = updated;
            }
            counters.applied += 1;
            await client.query('RELEASE SAVEPOINT bulk_upload_row_recover');
            counters.processed += 1;
            continue;
          } catch (recoveryError) {
            await client.query('ROLLBACK TO SAVEPOINT bulk_upload_row_recover');
            await client.query('RELEASE SAVEPOINT bulk_upload_row_recover');
            counters.failed += 1;
            if (errors.length < MAX_RECORDED_ERRORS) {
              errors.push({
                row: staged.rowNumber,
                message: recoveryError.message || error.message || 'Import failed'
              });
            }
            if (failFast) throw recoveryError;
            counters.processed += 1;
            continue;
          }
        }
        if (isDuplicateError(error) && job.import_mode === 'keep_existing') {
          counters.skipped += 1;
        } else {
          counters.failed += 1;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({ row: staged.rowNumber, message: error.message || 'Import failed' });
          }
          if (failFast) throw error;
        }
      }
      counters.processed += 1;
    }
  };
  return executor ? applyBatch(executor) : withTransaction(applyBatch);
}

async function applyStagedRows(job, stagedPath, user, context, validationErrors, invalidRows, options = {}) {
  const input = fs.createReadStream(stagedPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const counters = { processed: 0, applied: 0, skipped: 0, failed: invalidRows };
  const errors = [...validationErrors];
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    await processBatch({
      job,
      batch,
      user,
      context,
      counters,
      errors,
      executor: options.executor || null,
      failFast: Boolean(options.failFast)
    });
    batch = [];
    await updateBulkUploadJob(job.id, {
      processed_rows: counters.processed + invalidRows,
      applied_rows: counters.applied,
      skipped_rows: counters.skipped,
      failed_rows: counters.failed,
      errors,
      message: `Processed ${counters.processed + invalidRows} of ${job.total_rows} rows in batches of ${job.batch_size}.`
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    batch.push(JSON.parse(line));
    const effectiveBatchSize = job.entity_name === 'Site' ? 1 : job.batch_size;
    if (batch.length >= effectiveBatchSize) await flush();
  }
  await flush();
  return { counters, errors };
}

async function run() {
  const job = await getBulkUploadJob(workerData.jobId);
  if (!job) throw new Error('Bulk upload job was not found.');
  const definition = getUtilityModule(job.module_key);
  if (!definition) throw new Error('Bulk upload module is not supported.');
  const user = job.actor_snapshot || null;
  assertBulkUploadAdministrator(user);
  const scope = await getLocationScope(user);
  const context = {
    job,
    scope,
    ingredientCatalog: ['Inventory', 'Ingredient', 'Recipe'].includes(job.entity_name)
      ? await listDocuments('Ingredient', { limit: 10000 })
      : null,
    recipeCatalog: ['Recipe', 'MenuPlan'].includes(job.entity_name)
      ? await listDocuments('Recipe', { limit: 5000 })
      : null,
    menuPlanCatalog: job.entity_name === 'MenuPlan'
      ? await listDocuments('MenuPlan', { limit: 5000 })
      : null
  };
  const scopedSiteIds = scope.unrestricted ? null : [...scope.accessibleSiteIds];
  const destructiveSiteIds = job.site_id ? [String(job.site_id)] : scopedSiteIds;
  if (
    scopedSiteIds !== null
    && ['replace_existing', 'delete_existing'].includes(job.import_mode)
    && !definition.headers.includes('site_id')
  ) {
    throw new Error('Replace and delete modes for global modules require administrator access.');
  }
  const startedAt = new Date().toISOString();
  await updateBulkUploadJob(job.id, {
    status: 'PROCESSING',
    started_at: startedAt,
    message: 'Preparing background batch upload.'
  });

  if (job.import_mode === 'delete_existing') {
    authorizeEntityAction(
      user,
      job.entity_name,
      job.entity_name === 'Inventory' ? 'update' : 'delete',
      {}
    );
    const deleted = job.entity_name === 'Inventory'
      ? await withTransaction((client) => clearInventoryForBulkUpload(job, context, client))
      : job.entity_name === 'Recipe'
        ? await withTransaction((client) => clearRecipesForBulkDelete(job, destructiveSiteIds, client))
        : await withTransaction((client) => clearDocumentsForBulk(job.entity_name, destructiveSiteIds, client));
    const recipeType = job.entity_name === 'Recipe' ? getJobRecipeType(job) : '';
    const completedAt = new Date().toISOString();
    await updateBulkUploadJob(job.id, {
      status: 'COMPLETED',
      applied_rows: deleted,
      completed_at: completedAt,
      message: job.entity_name === 'Inventory'
        ? `Deleted ${deleted} inventory records and their open lot balances.`
        : job.entity_name === 'Recipe'
          ? `Deleted ${deleted} ${recipeType} recipe records.`
        : `Deleted ${deleted} existing ${definition.label} records.`
    });
    await auditAction({
      user,
      action: 'BULK_DELETE_COMPLETED',
      entity: job.entity_name,
      entityId: job.id,
      siteId: job.site_id,
      siteName: job.site_name,
      details: {
        module: job.module_key,
        deleted_rows: deleted,
        recipe_type: recipeType || null
      }
    });
    return;
  }

  materializedUpload = await materializeStoredReference(job.file_path);
  const processingJob = { ...job, file_path: materializedUpload.path };
  const stagedPath = `${processingJob.file_path}.validated.jsonl`;
  stagedPathToCleanup = stagedPath;
  const validation = await validateToJsonLines(processingJob, definition, stagedPath);
  await updateBulkUploadJob(job.id, {
    total_rows: validation.totalRows,
    failed_rows: validation.invalidRows,
    errors: validation.errors,
    message: `Validation complete. ${validation.validRows} valid rows are ready.`
  });
  if (validation.validRows === 0) {
    throw new Error(validation.errors[0]?.message || 'The upload does not contain any valid data rows.');
  }
  if (job.import_mode === 'replace_existing' && validation.errors.length) {
    throw new Error('Replace mode was cancelled because one or more rows failed validation. Existing data was not changed.');
  }
  if (job.import_mode === 'replace_existing') {
    authorizeEntityAction(
      user,
      job.entity_name,
      job.entity_name === 'Inventory' ? 'update' : 'delete',
      {}
    );
    if (job.entity_name === 'Recipe') context.recipeCatalog = [];
    if (job.entity_name === 'Site') {
      context.scope.sites = [];
      context.scope.graph = createSiteGraph([]);
    }
  }

  const refreshedJob = await getBulkUploadJob(job.id);
  const applyRows = (options = {}) => applyStagedRows(
    refreshedJob,
    stagedPath,
    user,
    context,
    validation.errors,
    validation.invalidRows,
    options
  );
  const { counters, errors } = job.import_mode === 'replace_existing'
    ? await withTransaction(async (client) => {
      if (job.entity_name === 'Inventory') {
        await clearInventoryForBulkUpload(job, context, client);
      } else {
        await clearDocumentsForBulk(job.entity_name, destructiveSiteIds, client);
        if (job.entity_name === 'Recipe') {
          await clearRecipeMatchesForBulkUpload(stagedPath, client);
        }
      }
      return applyRows({ executor: client, failFast: true });
    })
    : await applyRows();
  const status = counters.applied > 0 || counters.skipped > 0 ? 'COMPLETED' : 'FAILED';
  const completedAt = new Date().toISOString();
  await updateBulkUploadJob(job.id, {
    status,
    processed_rows: validation.totalRows,
    applied_rows: counters.applied,
    skipped_rows: counters.skipped,
    failed_rows: counters.failed,
    errors,
    completed_at: completedAt,
    message: `${counters.applied} rows applied, ${counters.skipped} skipped, ${counters.failed} failed.`
  });
  await auditAction({
    user,
    action: `BULK_UPLOAD_${status}`,
    entity: job.entity_name,
    entityId: job.id,
    siteId: job.site_id,
    siteName: job.site_name,
    details: {
      module: job.module_key,
      file_name: job.file_name,
      import_mode: job.import_mode,
      total_rows: validation.totalRows,
      applied_rows: counters.applied,
      skipped_rows: counters.skipped,
      failed_rows: counters.failed
    }
  });
  await fsPromises.unlink(stagedPath).catch(() => {});
}

run()
  .then(() => parentPort?.postMessage({ ok: true }))
  .catch(async (error) => {
    const failedJob = await getBulkUploadJob(workerData.jobId).catch(() => null);
    const rolledBack = failedJob?.import_mode === 'replace_existing';
    const existingErrors = Array.isArray(failedJob?.errors) ? failedJob.errors : [];
    await updateBulkUploadJob(workerData.jobId, {
      status: 'FAILED',
      ...(rolledBack ? { applied_rows: 0, skipped_rows: 0 } : {}),
      errors: existingErrors.length < MAX_RECORDED_ERRORS
        ? [...existingErrors, { row: null, message: error.message || 'Bulk upload failed.' }]
        : existingErrors,
      completed_at: new Date().toISOString(),
      message: rolledBack
        ? `Replace upload was rolled back. Existing data was preserved. ${error.message || ''}`.trim()
        : (error.message || 'Bulk upload failed.')
    }).catch(() => {});
    parentPort?.postMessage({ ok: false, message: error.message || 'Bulk upload failed.' });
  })
  .finally(async () => {
    const job = await getBulkUploadJob(workerData.jobId).catch(() => null);
    if (stagedPathToCleanup) await fsPromises.unlink(stagedPathToCleanup).catch(() => {});
    await materializedUpload?.cleanup?.().catch(() => {});
    if (job?.file_path) await removeStoredReference(job.file_path).catch(() => {});
    await pool.end().catch(() => {});
  });
