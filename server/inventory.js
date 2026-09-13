import crypto from 'node:crypto';
import {
  withTransaction,
  listDocuments,
  listDocumentsPage,
  findDocument,
  createDocument,
  updateDocument
} from './db.js';
import {
  calculateIngredientCost,
  convertIngredientQuantity,
  isIngredientUnitCompatible,
  normalizeIngredientUnit
} from '../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../shared/recipeComposition.js';
import { calculateYieldOutputQuantity } from '../shared/ingredientYield.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { getRecipeLinePrepExemptPercent, isExemptProcessingAid, recipeLineWeightFields } from '../shared/recipeLineWeight.js';
import { buildAutomaticProductionYieldSummary } from '../shared/productionReconciliation.js';
import { getItemCodeFromRecords } from '../shared/itemCode.js';
import { normalizeProductionMenuScope } from '../shared/menuCategories.js';
import { resolveProductionFulfillmentStore } from '../shared/productionFulfillment.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../shared/siteHierarchy.js';
import { toBusinessDateOnly } from '../shared/businessDate.js';
import {
  deriveInventoryRecord,
  deriveInventoryStatus,
  hasLowStockAlert
} from '../shared/inventoryStatus.js';
import { DEFAULT_SOURCE_NAME, normalizeSourceName } from '../shared/sourceNames.js';
import { createProducedItemBatchForCompletion } from './mealService.js';

const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();
// Quantities are persisted to six decimals. Use half of the smallest persisted
// increment so an exact 0.000001 movement is never mistaken for zero.
const QUANTITY_EPSILON = 0.0000005;
const UNUSABLE_LOT_STATUSES = new Set([
  'blocked',
  'expired',
  'hold',
  'on_hold',
  'quarantine',
  'quarantined',
  'recalled'
]);
const ONE_TO_ONE_COUNT_UNITS = new Set(['ea', 'pieces']);

async function runInTransaction(executor, handler) {
  if (executor) {
    return handler(executor);
  }
  return withTransaction(handler);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function areInventoryUnitsEquivalent(left, right) {
  const leftUnit = normalizeIngredientUnit(left);
  const rightUnit = normalizeIngredientUnit(right);
  if (!leftUnit || !rightUnit) return false;
  if (leftUnit === rightUnit) return true;
  return ONE_TO_ONE_COUNT_UNITS.has(leftUnit) && ONE_TO_ONE_COUNT_UNITS.has(rightUnit);
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundQuantity(value) {
  return Number(toNumber(value, 0).toFixed(6));
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function isFrozenRawProductionSnapshot(production = {}) {
  return Number(production.yield_adjustment_version || 0) >= 2
    && String(production.quantity_semantics || '').toLowerCase().includes('raw');
}

function resolveFrozenRawQuantity(line = {}) {
  const value = line.planned_quantity ?? line.raw_quantity ?? line.required_quantity;
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    const error = new Error(
      `The frozen raw quantity for ${line.ingredient_name || line.ingredient_id || 'an ingredient'} is invalid`
    );
    error.status = 409;
    throw error;
  }
  return quantity;
}

export function convertProductionQuantityToInventoryUnit({
  quantity,
  sourceUnit,
  inventoryUnit,
  ingredient = {},
  ingredientName = ''
} = {}) {
  if (!isIngredientUnitCompatible(sourceUnit, inventoryUnit, ingredient)) {
    const error = new Error(
      `The production unit for ${ingredientName || ingredient.name || ingredient.id || 'ingredient'} cannot be converted from ${sourceUnit || 'unknown'} to inventory unit ${inventoryUnit || 'unknown'}`
    );
    error.status = 409;
    throw error;
  }
  const converted = convertIngredientQuantity(quantity, sourceUnit, inventoryUnit, ingredient);
  if (!Number.isFinite(converted) || converted < 0) {
    const error = new Error(
      `The production quantity for ${ingredientName || ingredient.name || ingredient.id || 'ingredient'} could not be converted to inventory units`
    );
    error.status = 409;
    throw error;
  }
  return converted;
}

/**
 * Build the only quantities completion is allowed to post.
 *
 * V2 productions use their frozen raw recipe snapshot. Legacy productions are
 * upgraded deterministically from the recipe, target and ingredient yields.
 * Client-reported actual quantities are intentionally not an input.
 */
export function buildAutomaticProductionCompletionPlan({
  production = {},
  recipeCatalog = [],
  ingredientCatalog = []
} = {}) {
  const recipe = (Array.isArray(recipeCatalog) ? recipeCatalog : []).find(
    (candidate) => String(candidate?.id || '') === String(production.recipe_id || '')
  );
  if (!recipe) {
    const error = new Error('Production cannot be completed because its recipe no longer exists');
    error.status = 409;
    throw error;
  }
  const targetServings = positiveNumber(production.target_servings);
  if (!targetServings) {
    const error = new Error('Production cannot be completed because its target servings are invalid');
    error.status = 409;
    throw error;
  }

  const ingredients = Array.isArray(ingredientCatalog) ? ingredientCatalog : [];
  const ingredientMap = new Map(
    ingredients.map((ingredient) => [String(ingredient?.id || ''), ingredient])
  );
  const frozenV2 = isFrozenRawProductionSnapshot(production);
  let productionIngredients;

  if (frozenV2) {
    if (!Array.isArray(production.ingredients_used) || production.ingredients_used.length === 0) {
      const error = new Error('The frozen production recipe snapshot has no raw ingredient quantities');
      error.status = 409;
      throw error;
    }
    const ingredientKeys = production.ingredients_used.map((line) => (
      `${normalizeText(line?.ingredient_id)}::${isExemptProcessingAid(line) ? 'processing_aid' : `prep_${getRecipeLinePrepExemptPercent(line)}`}`
    ));
    if (new Set(ingredientKeys).size !== ingredientKeys.length) {
      const error = new Error('The frozen production recipe snapshot contains duplicate ingredient IDs');
      error.status = 409;
      throw error;
    }
    productionIngredients = production.ingredients_used.map((line) => {
      const ingredientId = normalizeText(line?.ingredient_id);
      if (!ingredientId) {
        const error = new Error('Every frozen production ingredient must include an ingredient ID');
        error.status = 409;
        throw error;
      }
      const rawQuantity = resolveFrozenRawQuantity(line);
      const ingredient = ingredientMap.get(ingredientId) || {};
      const sourceUnit = line.unit || ingredient.unit || 'unit';
      const masterUnit = ingredient.unit || sourceUnit;
      if (!isIngredientUnitCompatible(sourceUnit, masterUnit, ingredient)) {
        const error = new Error(
          `The frozen production unit for ${line.ingredient_name || ingredient.name || ingredientId} cannot be converted to ingredient unit ${masterUnit}`
        );
        error.status = 409;
        throw error;
      }
      return {
        ...line,
        quantity_basis: 'raw_recipe_v2',
        raw_quantity: roundQuantity(rawQuantity),
        planned_quantity: roundQuantity(rawQuantity),
        required_quantity: roundQuantity(rawQuantity),
        actual_quantity: null,
        desired_quantity: roundQuantity(rawQuantity)
      };
    });
  } else {
    const recipeServings = Math.max(1, toNumber(recipe.servings, 1));
    const multiplier = targetServings / recipeServings;
    const expansion = expandRecipeIngredients(
      recipe,
      recipeCatalog,
      ingredients,
      { multiplier, aggregate: true }
    );
    if (!expansion.ingredients.length) {
      const error = new Error('The legacy production recipe has no ingredients to reconcile');
      error.status = 409;
      throw error;
    }
    productionIngredients = expansion.ingredients.map((line) => {
      const ingredient = ingredientMap.get(String(line.ingredient_id || '')) || {};
      const unit = ingredient.unit || line.unit || 'unit';
      if (!isIngredientUnitCompatible(line.unit || unit, unit, ingredient)) {
        const error = new Error(
          `The recipe unit for ${ingredient.name || line.ingredient_name || line.ingredient_id} cannot be converted to its inventory unit`
        );
        error.status = 409;
        throw error;
      }
      const rawQuantity = convertIngredientQuantity(
        line.quantity,
        line.unit || unit,
        unit,
        ingredient
      );
      const yieldOutput = calculateYieldOutputQuantity(line.quantity, ingredient);
      const yieldedQuantity = convertIngredientQuantity(
        yieldOutput.yielded_quantity,
        line.unit || unit,
        unit,
        ingredient
      );
      const unitCost = toNumber(
        ingredient.cost_per_unit ?? ingredient.last_cost ?? ingredient.average_cost,
        0
      );
      return {
        ...recipeLineWeightFields(line),
        ingredient_id: line.ingredient_id,
        item_code: getItemCodeFromRecords([ingredient, line], null),
        ingredient_name: ingredient.name || line.ingredient_name,
        source_recipe_names: line.source_recipe_names || [],
        quantity_basis: 'raw_recipe_v2',
        raw_quantity: roundQuantity(rawQuantity),
        net_quantity: roundQuantity(yieldedQuantity),
        yielded_quantity: roundQuantity(yieldedQuantity),
        planned_quantity: roundQuantity(rawQuantity),
        required_quantity: roundQuantity(rawQuantity),
        yield_adjusted_quantity: roundQuantity(yieldedQuantity),
        yield_multiplier: roundQuantity(yieldOutput.yield_multiplier),
        yield_percent: Number(yieldOutput.yield_percent.toFixed(2)),
        yield_source: yieldOutput.yield_source,
        actual_quantity: null,
        desired_quantity: roundQuantity(rawQuantity),
        unit,
        cost_quantity: roundQuantity(rawQuantity),
        cost_unit: unit,
        unit_cost: Number(unitCost.toFixed(2)),
        estimated_cost: Number(calculateIngredientCost(rawQuantity, unit, ingredient, unitCost).toFixed(2))
      };
    });
  }

  const lineYieldSummary = buildAutomaticProductionYieldSummary({
    production: { ...production, ingredients_used: productionIngredients },
    recipe,
    ingredients
  });
  if (frozenV2 && !positiveNumber(lineYieldSummary.expected_finished_weight_grams)) {
    const unavailable = lineYieldSummary.line_weights
      .filter((line) => line.raw_quantity > 0 && line.yielded_weight_grams === null)
      .map((line) => line.ingredient_id)
      .filter(Boolean);
    const error = new Error(
      `The frozen production recipe snapshot cannot calculate yield weight for every ingredient${unavailable.length ? `: ${unavailable.join(', ')}` : ''}`
    );
    error.status = 409;
    throw error;
  }
  productionIngredients = productionIngredients.map((line, index) => {
    const weight = lineYieldSummary.line_weights[index] || {};
    const repairedLegacyV2 = frozenV2 && weight.weight_snapshot_status === 'metadata_reconstruction';
    return {
      ...line,
      raw_weight_grams: weight.raw_weight_grams,
      yielded_weight_grams: weight.yielded_weight_grams,
      weight_calculation_source: repairedLegacyV2
        ? `legacy_v2_repair:${weight.source}`
        : line.weight_calculation_source || weight.source,
      yield_calculation_source: line.yield_calculation_source || weight.yield_source || line.yield_source,
      weight_snapshot_version: 1
    };
  });
  const recipeWeight = frozenV2
    ? null
    : calculateRecipeServingWeight(recipe, recipeCatalog, ingredients);
  const recipeServings = Math.max(1, toNumber(recipe.servings, 1));
  const scale = targetServings / recipeServings;
  const portionSize = positiveNumber(lineYieldSummary.portion_size_grams)
    ?? (recipeWeight ? positiveNumber(recipeWeight.grams_per_serving) : null);
  if (!portionSize) {
    const error = new Error('Production cannot be completed until the recipe has a valid yielded serving size in grams');
    error.status = 409;
    throw error;
  }

  const lineYieldWeight = positiveNumber(lineYieldSummary.expected_finished_weight_grams);
  const recipeYieldWeight = recipeWeight ? positiveNumber(recipeWeight.cooked_total_grams) : null;
  const expectedFinishedWeight = lineYieldWeight
    ?? (recipeYieldWeight ? recipeYieldWeight * scale : portionSize * targetServings);
  const expectedYieldServings = expectedFinishedWeight / portionSize;
  const rawRecipeWeight = positiveNumber(lineYieldSummary.recipe_raw_weight_grams)
    ?? (frozenV2
      ? null
      : (positiveNumber(recipeWeight?.raw_total_grams)
        ? Number(recipeWeight?.raw_total_grams) * scale
        : null));

  return {
    recipe,
    ingredients_used: productionIngredients,
    upgraded_legacy_yield: !frozenV2,
    quantity_basis: frozenV2 ? 'raw_recipe_plan' : 'legacy_recipe_raw_yield_fallback',
    output_calculation_source: lineYieldWeight
      ? lineYieldSummary.output_calculation_source
      : recipeYieldWeight
        ? 'recipe_yield_fallback'
        : 'target_portion_fallback',
    production_snapshot: {
      ...production,
      ingredients_used: productionIngredients,
      yield_adjustment_applied: true,
      yield_adjustment_version: 2,
      yield_adjustment_updated_at: nowIso(),
      yield_snapshot_source: frozenV2
        ? production.yield_snapshot_source || 'server_recipe_expansion'
        : 'legacy_completion_recipe_expansion',
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      recipe_raw_weight_grams: rawRecipeWeight === null ? null : roundQuantity(rawRecipeWeight),
      expected_finished_weight_grams: roundQuantity(expectedFinishedWeight),
      portion_size_grams: roundQuantity(portionSize),
      portion_size_source: lineYieldSummary.portion_size_source
        || (positiveNumber(recipe.portion_size_grams) ? 'recipe_portion_size' : 'yield_calculated'),
      expected_yield_servings: roundQuantity(expectedYieldServings),
      reconciliation_mode: 'automatic_yield_plan',
      output_calculation_source: lineYieldWeight
        ? lineYieldSummary.output_calculation_source
        : recipeYieldWeight
          ? 'recipe_yield_fallback'
          : 'target_portion_fallback',
      production_warnings: [...new Set([
        ...(Array.isArray(production.production_warnings) ? production.production_warnings : []),
        ...(Array.isArray(lineYieldSummary.warnings) ? lineYieldSummary.warnings : []),
        ...(!lineYieldWeight && Array.isArray(recipeWeight?.warnings) ? recipeWeight.warnings : [])
      ])]
    }
  };
}

export function buildStockDeductionQuantitySummary({
  remainingToDeduct = 0,
  requestedQuantity = 0,
  issuedQuantity = 0
} = {}) {
  return {
    shortage_quantity: roundQuantity(remainingToDeduct),
    requested_quantity: roundQuantity(requestedQuantity),
    issued_quantity: roundQuantity(issuedQuantity)
  };
}

function quantitiesEqual(left, right) {
  return Math.abs(toNumber(left, 0) - toNumber(right, 0)) <= QUANTITY_EPSILON;
}

function toDateOnly(value = new Date()) {
  return toBusinessDateOnly(value) || toBusinessDateOnly(new Date());
}

function stockReservationDateForProduction(production = {}) {
  const today = toDateOnly();
  const productionDate = production?.production_date ? toDateOnly(production.production_date) : today;
  return productionDate > today ? productionDate : today;
}

function parseInventoryDate(value, fieldName, { required = false } = {}) {
  if (value === null || typeof value === 'undefined' || value === '') {
    if (!required) return null;
    const error = new Error(`${fieldName} is required`);
    error.status = 400;
    throw error;
  }
  const raw = String(value).trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      parsed.getUTCFullYear() === Number(year)
      && parsed.getUTCMonth() === Number(month) - 1
      && parsed.getUTCDate() === Number(day)
    ) {
      return raw;
    }
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return toDateOnly(parsed);
  }
  const error = new Error(`${fieldName} must be a valid date`);
  error.status = 400;
  throw error;
}

function validateInventorySettings({ min_stock_level, max_stock_level, valuation_method } = {}) {
  const min = min_stock_level === null || typeof min_stock_level === 'undefined' || min_stock_level === ''
    ? null
    : Number(min_stock_level);
  const max = max_stock_level === null || typeof max_stock_level === 'undefined' || max_stock_level === ''
    ? null
    : Number(max_stock_level);
  if ((min !== null && (!Number.isFinite(min) || min < 0)) || (max !== null && (!Number.isFinite(max) || max < 0))) {
    const error = new Error('Inventory minimum and maximum levels must be zero or greater');
    error.status = 400;
    throw error;
  }
  if (min !== null && max !== null && max > 0 && min > max) {
    const error = new Error('Inventory minimum level cannot exceed the maximum level');
    error.status = 400;
    throw error;
  }
  const method = valuation_method === null || typeof valuation_method === 'undefined' || valuation_method === ''
    ? null
    : normalizeText(valuation_method).toLowerCase();
  if (method && !['fifo', 'weighted_average'].includes(method)) {
    const error = new Error('Inventory valuation method must be FIFO or weighted average');
    error.status = 400;
    throw error;
  }
  return { min, max, method };
}

async function validateInventoryIdentity({ site_id, ingredient_id, unit }, executor) {
  const siteId = normalizeText(site_id);
  const ingredientId = normalizeText(ingredient_id);
  if (!siteId || !ingredientId) {
    const error = new Error('Inventory movements require both a site/store ID and an ingredient ID');
    error.status = 400;
    throw error;
  }
  const [site, ingredient] = await Promise.all([
    findDocument('Site', siteId, executor || undefined),
    findDocument('Ingredient', ingredientId, executor || undefined)
  ]);
  if (!site || site.is_active === false) {
    const error = new Error('The selected inventory site/store does not exist or is inactive');
    error.status = 400;
    throw error;
  }
  if (normalizeSiteType(site.type) !== SITE_HIERARCHY_TYPES.STORE) {
    const error = new Error('Inventory movements must be posted to a Store in the Area → Project → Store hierarchy');
    error.status = 409;
    throw error;
  }
  if (!ingredient || ingredient.is_active === false) {
    const error = new Error('The selected ingredient does not exist or is inactive');
    error.status = 400;
    throw error;
  }
  const canonicalUnit = normalizeText(ingredient.unit || unit);
  const suppliedUnit = normalizeText(unit || canonicalUnit);
  if (!canonicalUnit || !suppliedUnit) {
    const error = new Error('A canonical inventory unit is required');
    error.status = 400;
    throw error;
  }
  if (!areInventoryUnitsEquivalent(canonicalUnit, suppliedUnit)) {
    const error = new Error(`Inventory quantity must use the ingredient's canonical unit (${canonicalUnit})`);
    error.status = 409;
    throw error;
  }
  return { site, ingredient, unit: canonicalUnit };
}

function daysUntil(dateValue) {
  if (!dateValue) return null;
  const today = new Date(`${toDateOnly()}T00:00:00Z`);
  const target = new Date(`${toDateOnly(dateValue)}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function isInventoryLotUsable(lot, { asOfDate = toDateOnly() } = {}) {
  if (!lot || toNumber(lot.remaining_quantity, 0) <= 0) return false;
  const status = normalizeText(lot.status || 'active').toLowerCase();
  if (UNUSABLE_LOT_STATUSES.has(status) || status === 'consumed') return false;
  const effectiveDate = toDateOnly(asOfDate);
  const stockDateValue = lot.stock_date || lot.received_date || lot.created_date || null;
  const stockDate = stockDateValue ? toDateOnly(stockDateValue) : null;
  if (stockDate && stockDate > effectiveDate) return false;
  const expiryDate = lot.expiry_date ? toDateOnly(lot.expiry_date) : null;
  return !expiryDate || expiryDate >= effectiveDate;
}

export function getInventoryLotReservedQuantity(lot = {}) {
  return roundQuantity(Math.min(
    Math.max(0, toNumber(lot?.remaining_quantity, 0)),
    Math.max(0, toNumber(lot?.reserved_quantity, 0))
  ));
}

export function getInventoryLotAvailableQuantity(lot = {}, options = {}) {
  if (!isInventoryLotUsable(lot, options)) return 0;
  return roundQuantity(Math.max(
    0,
    toNumber(lot?.remaining_quantity, 0) - getInventoryLotReservedQuantity(lot)
  ));
}

export function getInventoryLotReservationAvailableQuantity(lot = {}, { asOfDate = toDateOnly() } = {}) {
  return roundQuantity(Math.min(
    getInventoryLotAvailableQuantity(lot, { asOfDate: toDateOnly() }),
    getInventoryLotAvailableQuantity(lot, { asOfDate })
  ));
}

export function sortInventoryLotsForIssue(lots = [], { asOfDate = toDateOnly() } = {}) {
  return (Array.isArray(lots) ? lots : [])
    .filter((lot) => isInventoryLotUsable(lot, { asOfDate }))
    .sort((left, right) => {
      const expiryComparison = String(left.expiry_date || '9999-12-31')
        .localeCompare(String(right.expiry_date || '9999-12-31'));
      if (expiryComparison !== 0) return expiryComparison;
      const leftStockDate = left.stock_date || left.received_date || left.created_date || '';
      const rightStockDate = right.stock_date || right.received_date || right.created_date || '';
      const stockDateComparison = String(leftStockDate).localeCompare(String(rightStockDate));
      if (stockDateComparison !== 0) return stockDateComparison;
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
}

export function buildInventoryBatchNumber(prefix = 'LOT', stockDate = toDateOnly()) {
  const safePrefix = normalizeText(prefix).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'LOT';
  const dateToken = toDateOnly(stockDate).replace(/-/g, '');
  return `${safePrefix.toUpperCase()}-${dateToken}-${crypto.randomUUID()}`;
}

function getAvailableLotQuantity(lots = [], options = {}) {
  return lots.reduce(
    (sum, lot) => sum + getInventoryLotAvailableQuantity(lot, options),
    0
  );
}

function assertSufficientStock(lots, quantity, allowShortage = true, options = {}) {
  const requiredQuantity = toNumber(quantity, 0);
  const availableQuantity = getAvailableLotQuantity(lots, options);
  if (!allowShortage && availableQuantity < requiredQuantity) {
    const error = new Error('Insufficient stock available for this movement');
    error.status = 400;
    throw error;
  }
  return availableQuantity;
}

function formatInventoryQuantity(value, unit = '') {
  const numeric = roundQuantity(value);
  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 6 })}${unit ? ` ${unit}` : ''}`;
}

function buildInsufficientReservationStockError({
  lots = [],
  requestedQuantity = 0,
  asOfDate = toDateOnly(),
  unit = '',
  ingredientName = '',
  ingredientId = '',
  siteName = ''
} = {}) {
  const requiredQuantity = roundQuantity(requestedQuantity);
  const reservableQuantity = roundQuantity((Array.isArray(lots) ? lots : []).reduce(
    (sum, lot) => sum + getInventoryLotReservationAvailableQuantity(lot, { asOfDate }),
    0
  ));
  const onHandQuantity = roundQuantity((Array.isArray(lots) ? lots : []).reduce(
    (sum, lot) => sum + Math.max(0, toNumber(lot?.remaining_quantity, 0)),
    0
  ));
  const reservedQuantity = roundQuantity((Array.isArray(lots) ? lots : []).reduce(
    (sum, lot) => sum + getInventoryLotReservedQuantity(lot),
    0
  ));
  const itemLabel = ingredientName || ingredientId || 'this item';
  const storeLabel = siteName ? ` in ${siteName}` : '';
  const reasons = [];
  if (!Array.isArray(lots) || lots.length === 0) {
    reasons.push('no inventory lot/batch records exist for this item');
  }
  if (reservedQuantity > 0) {
    reasons.push(`${formatInventoryQuantity(reservedQuantity, unit)} is already reserved`);
  }
  const unusableCount = (Array.isArray(lots) ? lots : []).filter((lot) => (
    Math.max(0, toNumber(lot?.remaining_quantity, 0)) > QUANTITY_EPSILON
    && getInventoryLotReservationAvailableQuantity(lot, { asOfDate }) <= QUANTITY_EPSILON
  )).length;
  if (unusableCount > 0) {
    reasons.push(`${unusableCount} lot${unusableCount === 1 ? ' is' : 's are'} not usable for the reservation date`);
  }
  const reasonText = reasons.length ? ` (${reasons.join('; ')}).` : '.';
  const error = new Error(
    `Insufficient reservable stock for ${itemLabel}${storeLabel}: required ${formatInventoryQuantity(requiredQuantity, unit)}, reservable ${formatInventoryQuantity(reservableQuantity, unit)} as of ${toDateOnly(asOfDate)}${reasonText}`
  );
  error.status = 400;
  error.code = 'INSUFFICIENT_RESERVABLE_STOCK';
  error.details = {
    ingredient_id: ingredientId || null,
    ingredient_name: ingredientName || null,
    site_name: siteName || null,
    unit,
    required_quantity: requiredQuantity,
    reservable_quantity: reservableQuantity,
    on_hand_quantity: onHandQuantity,
    reserved_quantity: reservedQuantity,
    as_of_date: toDateOnly(asOfDate),
    reasons
  };
  return error;
}

async function listInventoryLots(
  { siteId, ingredientId, includeEmpty = false, lock = false, location = null } = {},
  executor = null
) {
  const filters = {};
  if (siteId) filters.site_id = siteId;
  if (ingredientId) filters.ingredient_id = ingredientId;
  let lots = [];
  if (lock) {
    // Transactional consumers must lock every matching lot; an arbitrary
    // limit can otherwise omit stock and break FEFO/FIFO allocations.
    lots = await listDocuments(
      'InventoryLot',
      { filters, sort: 'received_date', lock: true, location },
      executor || undefined
    );
  } else {
    const pageSize = 200;
    let offset = 0;
    while (true) {
      const page = await listDocumentsPage(
        'InventoryLot',
        { filters, sort: 'received_date', limit: pageSize, offset, location },
        executor || undefined
      );
      lots.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total_count) break;
    }
  }
  return lots
    .filter((lot) => includeEmpty || toNumber(lot.remaining_quantity, 0) > 0)
    .map((lot) => ({
      ...lot,
      reserved_quantity: getInventoryLotReservedQuantity(lot),
      available_quantity: getInventoryLotAvailableQuantity(lot)
    }));
}

async function ensureInventoryRecord({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  item_code,
  unit,
  min_stock_level,
  max_stock_level,
  valuation_method,
  source_name
}, executor = null) {
  const minLevelProvided = typeof min_stock_level !== 'undefined';
  const maxLevelProvided = typeof max_stock_level !== 'undefined';
  const valuationMethodProvided = typeof valuation_method !== 'undefined';
  const identity = await validateInventoryIdentity({ site_id, ingredient_id, unit }, executor);
  const resolvedItemCode = String(
    item_code
      || identity.ingredient.item_code
      || identity.ingredient.ingredient_code
      || identity.ingredient.sku
      || identity.ingredient.d365_item_id
      || ''
  ).trim();
  const settings = validateInventorySettings({ min_stock_level, max_stock_level, valuation_method });
  const canonicalUnit = identity.unit;
  if (executor) {
    await executor.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`inventory:${String(site_id || '')}:${String(ingredient_id || '')}`]
    );
  }

  const existing = (await listDocuments('Inventory', {
    filters: { site_id, ingredient_id },
    limit: 10,
    lock: Boolean(executor)
  }, executor || undefined))[0];
  const sourceName = normalizeSourceName(source_name || undefined, existing?.source_name || DEFAULT_SOURCE_NAME);

  if (existing) {
    const existingUnit = normalizeText(existing.unit || canonicalUnit);
    if (!areInventoryUnitsEquivalent(existingUnit, canonicalUnit)) {
      const error = new Error(`Existing inventory unit (${existingUnit}) does not match ingredient unit (${canonicalUnit})`);
      error.status = 409;
      throw error;
    }
    const settingsPatch = {
      site_name: identity.site.name || site_name || existing.site_name || null,
      ingredient_name: identity.ingredient.name || ingredient_name || existing.ingredient_name || null,
      item_code: resolvedItemCode || existing.item_code || null,
      unit: canonicalUnit,
      source_name: sourceName,
      ...(minLevelProvided ? { min_stock_level: settings.min ?? 0 } : {}),
      ...(maxLevelProvided ? { max_stock_level: settings.max } : {}),
      ...(valuationMethodProvided && settings.method ? { valuation_method: settings.method } : {})
    };
    const currentMin = settingsPatch.min_stock_level ?? toNumber(existing.min_stock_level, 0);
    const currentMax = settingsPatch.max_stock_level ?? (
      existing.max_stock_level === null || typeof existing.max_stock_level === 'undefined'
        ? null
        : toNumber(existing.max_stock_level, 0)
    );
    validateInventorySettings({
      min_stock_level: currentMin,
      max_stock_level: currentMax,
      valuation_method: settingsPatch.valuation_method || existing.valuation_method || 'fifo'
    });
    const normalizedExisting = await updateDocument('Inventory', existing.id, settingsPatch, executor || undefined);
    const legacyQuantity = Math.max(0, toNumber(
      normalizedExisting.on_hand_quantity ?? normalizedExisting.quantity ?? normalizedExisting.available_quantity,
      0
    ));
    if (legacyQuantity > 0) {
      const existingLots = await listInventoryLots({
        siteId: site_id,
        ingredientId: ingredient_id,
        includeEmpty: true,
        lock: Boolean(executor)
      }, executor);
      const representedLotQuantity = existingLots.reduce(
        (sum, lot) => sum + Math.max(0, toNumber(lot.remaining_quantity, 0)),
        0
      );
      const openingDifference = Math.max(0, legacyQuantity - representedLotQuantity);
      if (openingDifference > QUANTITY_EPSILON) {
        const stockDate = toDateOnly(
          normalizedExisting.stock_date || normalizedExisting.received_date || normalizedExisting.created_date || toDateOnly()
        );
        const openingLot = await createDocument('InventoryLot', {
          id: randomId('lot'),
          site_id,
          site_name: identity.site.name || site_name || normalizedExisting.site_name || null,
          ingredient_id,
          ingredient_name: identity.ingredient.name || ingredient_name || normalizedExisting.ingredient_name || null,
          quantity_received: openingDifference,
          remaining_quantity: openingDifference,
          unit: canonicalUnit,
          unit_cost: Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0)),
          accounting_unit_cost: Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0)),
          total_cost: Number((openingDifference * Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0))).toFixed(2)),
          batch_number: buildInventoryBatchNumber('OPENING', stockDate),
          lot_number: null,
          stock_date: stockDate,
          received_date: stockDate,
          expiry_date: normalizedExisting.expiry_date ? toDateOnly(normalizedExisting.expiry_date) : null,
          reference_id: normalizedExisting.id,
          reference_type: 'legacy_inventory_opening',
          status: normalizedExisting.expiry_date && daysUntil(normalizedExisting.expiry_date) < 0 ? 'expired' : 'active',
          source: 'legacy_aggregate_migration',
          source_type: 'legacy_aggregate_migration'
        }, executor || undefined);
        await postInventoryTransaction({
          site_id,
          site_name: identity.site.name || site_name || normalizedExisting.site_name || null,
          ingredient_id,
          ingredient_name: identity.ingredient.name || ingredient_name || normalizedExisting.ingredient_name || null,
          transaction_type: 'opening_balance',
          quantity: openingDifference,
          unit: canonicalUnit,
          transaction_date: stockDate,
          reference_id: normalizedExisting.id,
          reference_type: 'legacy_inventory_opening',
          notes: 'Opening lot generated from legacy aggregate inventory quantity',
          performed_by: 'system',
          batch_number: openingLot.batch_number,
          expiry_date: openingLot.expiry_date,
          stock_date: stockDate,
          received_date: stockDate,
          total_cost: openingDifference * Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0)),
          unit_cost: Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0)),
          reason_code: 'legacy_opening_balance',
          source: 'legacy_aggregate_migration',
          source_type: 'legacy_aggregate_migration',
          balance_before: representedLotQuantity,
          balance_after: legacyQuantity,
          opening_quantity: representedLotQuantity,
          addition_quantity: 0,
          consumption_quantity: 0,
          remaining_quantity: legacyQuantity,
          movement_layers: [{
            inventory_lot_id: openingLot.id,
            batch_number: openingLot.batch_number,
            stock_date: stockDate,
            received_date: stockDate,
            expiry_date: openingLot.expiry_date,
            quantity: openingDifference,
            unit_cost: Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0)),
            accounting_unit_cost: Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0)),
            total_cost: Number((openingDifference * Math.max(0, toNumber(normalizedExisting.average_unit_cost, 0))).toFixed(2))
          }]
        }, executor);
        return recalculateInventoryRecord(normalizedExisting, executor);
      }
    }
    // The lot ledger is authoritative. Recalculate on every locked access so
    // expired stock and any legacy aggregate/lot drift cannot leak into the
    // next transaction's opening balance.
    return recalculateInventoryRecord(normalizedExisting, executor);
  }

  return createDocument('Inventory', {
    site_id,
    site_name: identity.site.name || site_name,
    ingredient_id,
    ingredient_name: identity.ingredient.name || ingredient_name,
    item_code: resolvedItemCode || null,
    quantity: 0,
    available_quantity: 0,
    reserved_quantity: 0,
    on_hand_quantity: 0,
    unit: canonicalUnit,
    min_stock_level: settings.min ?? 0,
    max_stock_level: settings.max,
    total_value: 0,
    average_unit_cost: 0,
    valuation_method: settings.method || 'fifo',
    batch_count: 0,
    source_name: sourceName,
    status: 'out_of_stock'
  }, executor || undefined);
}

async function recalculateInventoryRecord(record, executor = null) {
  const lots = await listInventoryLots({
    siteId: record.site_id,
    ingredientId: record.ingredient_id,
    includeEmpty: true
  }, executor);

  const onHandLots = lots.filter((lot) => toNumber(lot.remaining_quantity, 0) > 0);
  const usableLots = sortInventoryLotsForIssue(onHandLots);
  const availableLots = usableLots.filter((lot) => getInventoryLotAvailableQuantity(lot) > QUANTITY_EPSILON);
  const onHandQuantity = onHandLots.reduce(
    (sum, lot) => sum + toNumber(lot.remaining_quantity, 0),
    0
  );
  const usableQuantity = usableLots.reduce(
    (sum, lot) => sum + toNumber(lot.remaining_quantity, 0),
    0
  );
  const reservedQuantity = onHandLots.reduce(
    (sum, lot) => sum + getInventoryLotReservedQuantity(lot),
    0
  );
  const unavailableQuantity = onHandLots
    .filter((lot) => !isInventoryLotUsable(lot))
    .reduce((sum, lot) => sum + Math.max(
      0,
      toNumber(lot.remaining_quantity, 0) - getInventoryLotReservedQuantity(lot)
    ), 0);
  const availableQuantity = availableLots.reduce(
    (sum, lot) => sum + getInventoryLotAvailableQuantity(lot),
    0
  );
  const fifoValue = usableLots.reduce(
    (sum, lot) => sum + (toNumber(lot.remaining_quantity, 0) * toNumber(lot.unit_cost, 0)),
    0
  );
  const valuationMethod = normalizeText(record.valuation_method || 'fifo') || 'fifo';
  const weightedValue = usableLots.reduce(
    (sum, lot) => sum + (
      toNumber(lot.remaining_quantity, 0)
      * toNumber(lot.accounting_unit_cost ?? lot.unit_cost, 0)
    ),
    0
  );
  const totalValue = valuationMethod === 'weighted_average' ? weightedValue : fifoValue;
  const totalOnHandValue = onHandLots.reduce(
    (sum, lot) => sum + (toNumber(lot.remaining_quantity, 0) * toNumber(lot.unit_cost, 0)),
    0
  );
  const averageUnitCost = usableQuantity > 0 ? totalValue / usableQuantity : 0;
  const earliestExpiry = availableLots
    .map((lot) => lot.expiry_date)
    .filter(Boolean)
    .sort()[0] || null;
  const nearExpiryCount = onHandLots.filter((lot) => {
    const remainingDays = daysUntil(lot.expiry_date);
    return remainingDays !== null && remainingDays >= 0 && remainingDays <= 7;
  }).length;
  const expiredCount = onHandLots.filter((lot) => {
    const remainingDays = daysUntil(lot.expiry_date);
    return remainingDays !== null && remainingDays < 0;
  }).length;

  return updateDocument('Inventory', record.id, {
    quantity: roundQuantity(availableQuantity),
    available_quantity: roundQuantity(availableQuantity),
    reserved_quantity: roundQuantity(reservedQuantity),
    usable_on_hand_quantity: roundQuantity(usableQuantity),
    on_hand_quantity: Number(onHandQuantity.toFixed(6)),
    unavailable_quantity: roundQuantity(unavailableQuantity),
    total_value: Number(totalValue.toFixed(2)),
    fifo_total_value: Number(fifoValue.toFixed(2)),
    weighted_average_value: Number(weightedValue.toFixed(2)),
    total_on_hand_value: Number(totalOnHandValue.toFixed(2)),
    average_unit_cost: Number(averageUnitCost.toFixed(4)),
    batch_count: onHandLots.length,
    available_batch_count: availableLots.length,
    next_expiry_date: earliestExpiry,
    near_expiry_count: nearExpiryCount,
    expired_lot_count: expiredCount,
    status: deriveInventoryStatus(availableQuantity, toNumber(record.min_stock_level, 0))
  }, executor || undefined);
}

async function revalueWeightedAverageLots(record, targetTotalValue, executor) {
  if (normalizeText(record?.valuation_method || 'fifo') !== 'weighted_average') return;
  const lots = await listInventoryLots({
    siteId: record.site_id,
    ingredientId: record.ingredient_id,
    includeEmpty: true,
    lock: Boolean(executor)
  }, executor);
  const availableLots = sortInventoryLotsForIssue(lots);
  const availableQuantity = availableLots.reduce(
    (sum, lot) => sum + toNumber(lot.remaining_quantity, 0),
    0
  );
  const nextAverage = availableQuantity > QUANTITY_EPSILON
    ? Math.max(0, toNumber(targetTotalValue, 0)) / availableQuantity
    : 0;
  for (const lot of availableLots) {
    const remaining = toNumber(lot.remaining_quantity, 0);
    await updateDocument('InventoryLot', lot.id, {
      accounting_unit_cost: Number(nextAverage.toFixed(6)),
      accounting_total_cost: Number((remaining * nextAverage).toFixed(2))
    }, executor);
  }
}

async function postInventoryTransaction({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  transaction_type,
  quantity,
  unit,
  transaction_date,
  reference_id,
  reference_type,
  notes,
  performed_by,
  batch_number = null,
  expiry_date = null,
  stock_date = null,
  received_date = null,
  total_cost = 0,
  unit_cost = 0,
  from_site_id = null,
  from_site_name = null,
  to_site_id = null,
  to_site_name = null,
  reason_code = null,
  movement_layers = [],
  source = null,
  source_name = null,
  source_type = null,
  balance_before = null,
  balance_after = null,
  opening_quantity = null,
  addition_quantity = null,
  consumption_quantity = null,
  remaining_quantity = null,
  operation = null,
  operation_id = null,
  idempotency_key = null,
  commitment_revision = null,
  metadata = null
}, executor = null) {
  return createDocument('InventoryTransaction', {
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    transaction_type,
    quantity,
    unit,
    transaction_date: transaction_date || toDateOnly(),
    reference_id: reference_id || null,
    reference_type: reference_type || null,
    notes: normalizeText(notes) || null,
    performed_by: performed_by || 'system',
    batch_number: normalizeText(batch_number) || null,
    expiry_date: expiry_date || null,
    stock_date: stock_date ? toDateOnly(stock_date) : null,
    received_date: received_date ? toDateOnly(received_date) : null,
    total_cost: Number(toNumber(total_cost, 0).toFixed(2)),
    unit_cost: Number(toNumber(unit_cost, 0).toFixed(4)),
    from_site_id,
    from_site_name,
    to_site_id,
    to_site_name,
    reason_code: normalizeText(reason_code) || null,
    movement_layers,
    source_name: normalizeSourceName(source_name || undefined, DEFAULT_SOURCE_NAME),
    source: normalizeText(source || source_type) || null,
    source_type: normalizeText(source_type || source) || null,
    balance_before: balance_before === null ? null : roundQuantity(balance_before),
    balance_after: balance_after === null ? null : roundQuantity(balance_after),
    opening_quantity: opening_quantity === null ? null : roundQuantity(opening_quantity),
    addition_quantity: addition_quantity === null ? null : roundQuantity(addition_quantity),
    consumption_quantity: consumption_quantity === null ? null : roundQuantity(consumption_quantity),
    remaining_quantity: remaining_quantity === null ? null : roundQuantity(remaining_quantity),
    operation: normalizeText(operation) || null,
    operation_id: normalizeText(operation_id) || null,
    idempotency_key: normalizeText(idempotency_key || operation_id) || null,
    commitment_revision: commitment_revision === null
      ? null
      : Math.max(0, Math.trunc(toNumber(commitment_revision, 0))),
    metadata: metadata && typeof metadata === 'object' ? metadata : null
  }, executor || undefined);
}

async function receiveStockWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  quantity,
  unit,
  unit_cost = 0,
  batch_number = null,
  lot_number = null,
  expiry_date = null,
  stock_date = null,
  received_date = null,
  transaction_date = null,
  min_stock_level,
  max_stock_level,
  valuation_method,
  reference_id = null,
  reference_type = null,
  notes = '',
  performed_by = 'system',
  reason_code = 'receipt',
  source = null,
  source_name = null,
  source_type = null,
  operation = null,
  operation_id = null,
  idempotency_key = null,
  commitment_revision = null,
  metadata = null
}, executor) {
  const qty = toNumber(quantity, 0);
  if (qty <= 0) {
    const error = new Error('Received quantity must be greater than zero');
    error.status = 400;
    throw error;
  }
  const cost = Number(unit_cost);
  if (!Number.isFinite(cost) || cost < 0) {
    const error = new Error('Inventory unit cost must be a non-negative number');
    error.status = 400;
    throw error;
  }
  const effectiveStockDate = parseInventoryDate(
    stock_date || received_date || transaction_date || toDateOnly(),
    'Stock date',
    { required: true }
  );
  const effectiveReceivedDate = parseInventoryDate(
    received_date || stock_date || transaction_date || effectiveStockDate,
    'Received date',
    { required: true }
  );
  const effectiveTransactionDate = parseInventoryDate(
    transaction_date || toDateOnly(),
    'Transaction date',
    { required: true }
  );
  const effectiveExpiryDate = parseInventoryDate(expiry_date, 'Expiry date');
  const sourceName = normalizeSourceName(source_name || undefined, DEFAULT_SOURCE_NAME);
  const currentDate = toDateOnly();
  if (effectiveStockDate > currentDate || effectiveReceivedDate > currentDate || effectiveTransactionDate > currentDate) {
    const error = new Error('Stock, received, and transaction dates cannot be in the future');
    error.status = 400;
    throw error;
  }
  if (effectiveExpiryDate && effectiveExpiryDate < effectiveStockDate) {
    const error = new Error('Expiry date cannot be earlier than the stock date');
    error.status = 400;
    throw error;
  }

  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit,
    min_stock_level,
    max_stock_level,
    valuation_method,
    source_name: sourceName
  }, executor);

  const inventoryUnit = inventory.unit;
  const balanceBefore = toNumber(inventory.available_quantity ?? inventory.quantity, 0);

  const lot = await createDocument('InventoryLot', {
    id: randomId('lot'),
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    quantity_received: qty,
    remaining_quantity: qty,
    unit: inventoryUnit,
    unit_cost: cost,
    accounting_unit_cost: cost,
    accounting_total_cost: Number((qty * cost).toFixed(2)),
    total_cost: Number((qty * cost).toFixed(2)),
    batch_number: normalizeText(batch_number || lot_number)
      || buildInventoryBatchNumber('LOT', effectiveStockDate),
    lot_number: normalizeText(lot_number || batch_number) || null,
    expiry_date: effectiveExpiryDate,
    stock_date: effectiveStockDate,
    received_date: effectiveReceivedDate,
    reference_id,
    reference_type,
    status: effectiveExpiryDate && daysUntil(effectiveExpiryDate) < 0 ? 'expired' : 'active',
    source_name: sourceName,
    source: normalizeText(source || source_type) || null,
    source_type: normalizeText(source_type || source) || null
  }, executor);

  if (normalizeText(inventory.valuation_method || valuation_method) === 'weighted_average') {
    const receiptAffectsAvailableValue = isInventoryLotUsable(lot);
    await revalueWeightedAverageLots(
      inventory,
      toNumber(inventory.total_value, 0) + (
        receiptAffectsAvailableValue ? qty * cost : 0
      ),
      executor
    );
  }

  const refreshed = await recalculateInventoryRecord(inventory, executor);
  const balanceAfter = toNumber(refreshed.available_quantity ?? refreshed.quantity, 0);

  const transaction = await postInventoryTransaction({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    transaction_type: reason_code === 'transfer_in' ? 'transfer_in' : 'receipt',
    quantity: qty,
    unit: inventoryUnit,
    transaction_date: effectiveTransactionDate,
    reference_id,
    reference_type,
    notes,
    performed_by,
    batch_number: lot.batch_number,
    expiry_date: lot.expiry_date,
    stock_date: lot.stock_date,
    received_date: lot.received_date,
    total_cost: qty * cost,
    unit_cost: cost,
    reason_code,
    source,
    source_name: sourceName,
    source_type,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    opening_quantity: balanceBefore,
    addition_quantity: qty,
    consumption_quantity: 0,
    remaining_quantity: balanceAfter,
    operation,
    operation_id,
    idempotency_key,
    commitment_revision,
    metadata,
    movement_layers: [{
      inventory_lot_id: lot.id,
      batch_number: lot.batch_number,
      stock_date: lot.stock_date,
      received_date: lot.received_date,
      expiry_date: lot.expiry_date,
      quantity: qty,
      quantity_before: 0,
      quantity_after: qty,
      unit_cost: cost,
      accounting_unit_cost: cost,
      accounting_total_cost: Number((qty * cost).toFixed(2)),
      total_cost: Number((qty * cost).toFixed(2))
    }]
  }, executor);

  return { inventory: refreshed, lot, transaction };
}

async function receiveStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => receiveStockWithExecutor(payload, client)
  );
}

async function deductStockWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  quantity,
  unit,
  transaction_type,
  transaction_date = null,
  reference_id = null,
  reference_type = null,
  notes = '',
  performed_by = 'system',
  valuation_method,
  reason_code = null,
  allow_shortage = true,
  as_of_date = null,
  source = null,
  source_name = null,
  source_type = null,
  operation = null,
  operation_id = null,
  idempotency_key = null,
  commitment_revision = null,
  metadata = null
}, executor) {
  const qty = toNumber(quantity, 0);
  if (qty <= 0) {
    const error = new Error('Deduction quantity must be greater than zero');
    error.status = 400;
    throw error;
  }

  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit,
    valuation_method,
    source_name
  }, executor);
  const inventoryUnit = inventory.unit;
  const balanceBefore = toNumber(inventory.available_quantity ?? inventory.quantity, 0);

  const lots = await listInventoryLots({
    siteId: site_id,
    ingredientId: ingredient_id,
    lock: true
  }, executor);
  const issueDate = parseInventoryDate(
    as_of_date || transaction_date || toDateOnly(),
    'Inventory issue date',
    { required: true }
  );
  const effectiveTransactionDate = parseInventoryDate(
    transaction_date || toDateOnly(),
    'Transaction date',
    { required: true }
  );
  const sortedLots = sortInventoryLotsForIssue(lots, { asOfDate: issueDate });

  assertSufficientStock(sortedLots, qty, allow_shortage, { asOfDate: issueDate });

  let remainingToDeduct = qty;
  let fifoCost = 0;
  const movementLayers = [];
  const valuationMethod = normalizeText(inventory.valuation_method || valuation_method || 'fifo') || 'fifo';
  const weightedAverageUnitCost = toNumber(inventory.average_unit_cost, 0);

  for (const lot of sortedLots) {
    if (remainingToDeduct <= 0) break;
    const remaining = toNumber(lot.remaining_quantity, 0);
    const reserved = getInventoryLotReservedQuantity(lot);
    const available = Math.max(0, remaining - reserved);
    if (available <= QUANTITY_EPSILON) continue;

    const layerQuantity = Math.min(available, remainingToDeduct);
    const nextRemaining = remaining - layerQuantity;
    await updateDocument('InventoryLot', lot.id, {
      remaining_quantity: nextRemaining,
      status: nextRemaining <= 0 ? 'consumed' : lot.status
    }, executor);

    const layerCost = layerQuantity * toNumber(lot.unit_cost, 0);
    const accountingUnitCost = valuationMethod === 'weighted_average'
      ? weightedAverageUnitCost
      : toNumber(lot.unit_cost, 0);
    fifoCost += layerCost;
    movementLayers.push({
      inventory_lot_id: lot.id,
      batch_number: lot.batch_number || null,
      stock_date: lot.stock_date || lot.received_date || null,
      received_date: lot.received_date || lot.stock_date || null,
      expiry_date: lot.expiry_date || null,
      quantity: layerQuantity,
      quantity_before: remaining,
      quantity_after: nextRemaining,
      reserved_quantity_before: reserved,
      reserved_quantity_after: reserved,
      available_quantity_before: available,
      available_quantity_after: Math.max(0, nextRemaining - reserved),
      unit_cost: toNumber(lot.unit_cost, 0),
      total_cost: Number(layerCost.toFixed(2)),
      accounting_unit_cost: accountingUnitCost,
      accounting_total_cost: Number((layerQuantity * accountingUnitCost).toFixed(2))
    });

    remainingToDeduct -= layerQuantity;
  }

  const issuedQuantity = Math.max(0, qty - remainingToDeduct);
  const weightedCost = issuedQuantity * weightedAverageUnitCost;
  const totalCost = valuationMethod === 'weighted_average' ? weightedCost : fifoCost;
  if (valuationMethod === 'weighted_average') {
    await revalueWeightedAverageLots(
      inventory,
      Math.max(0, toNumber(inventory.total_value, 0) - totalCost),
      executor
    );
  }
  const refreshed = await recalculateInventoryRecord(inventory, executor);
  const balanceAfter = toNumber(refreshed.available_quantity ?? refreshed.quantity, 0);

  const transaction = issuedQuantity > 0 ? await postInventoryTransaction({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    transaction_type,
    quantity: issuedQuantity * -1,
    unit: inventoryUnit,
    transaction_date: effectiveTransactionDate,
    reference_id,
    reference_type,
    notes: remainingToDeduct > 0 ? `${notes} (shortage ${remainingToDeduct.toFixed(2)} ${inventoryUnit})` : notes,
    performed_by,
    total_cost: totalCost,
    unit_cost: issuedQuantity > 0 ? totalCost / issuedQuantity : 0,
    reason_code,
    movement_layers: movementLayers,
    source,
    source_name,
    source_type,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    opening_quantity: balanceBefore,
    addition_quantity: 0,
    consumption_quantity: issuedQuantity,
    remaining_quantity: balanceAfter,
    operation,
    operation_id,
    idempotency_key,
    commitment_revision,
    metadata
  }, executor) : null;

  return {
    inventory: refreshed,
    ...buildStockDeductionQuantitySummary({
      remainingToDeduct,
      requestedQuantity: qty,
      issuedQuantity
    }),
    total_cost: Number(totalCost.toFixed(2)),
    transaction_id: transaction?.id || null,
    movement_layers: movementLayers
  };
}

async function deductStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => deductStockWithExecutor(payload, client)
  );
}

export function splitCommittedAllocationLayers(allocationLayers = [], quantityToReturn = 0) {
  let remainingToReturn = Math.max(0, toNumber(quantityToReturn, 0));
  const retainedLayers = (Array.isArray(allocationLayers) ? allocationLayers : [])
    .filter((layer) => toNumber(layer?.quantity, 0) > QUANTITY_EPSILON)
    .map((layer) => ({
      ...layer,
      quantity: roundQuantity(layer.quantity),
      total_cost: Number((toNumber(layer.quantity, 0) * toNumber(layer.unit_cost, 0)).toFixed(2)),
      accounting_total_cost: Number((
        toNumber(layer.quantity, 0)
        * toNumber(layer.accounting_unit_cost ?? layer.unit_cost, 0)
      ).toFixed(2))
    }));
  const returnedLayers = [];

  for (let index = retainedLayers.length - 1; index >= 0 && remainingToReturn > QUANTITY_EPSILON; index -= 1) {
    const layer = retainedLayers[index];
    const available = toNumber(layer.quantity, 0);
    const returnedQuantity = Math.min(available, remainingToReturn);
    const retainedQuantity = Math.max(0, available - returnedQuantity);
    returnedLayers.push({
      ...layer,
      quantity: roundQuantity(returnedQuantity),
      total_cost: Number((returnedQuantity * toNumber(layer.unit_cost, 0)).toFixed(2)),
      accounting_total_cost: Number((
        returnedQuantity * toNumber(layer.accounting_unit_cost ?? layer.unit_cost, 0)
      ).toFixed(2))
    });
    remainingToReturn -= returnedQuantity;
    if (retainedQuantity <= QUANTITY_EPSILON) {
      retainedLayers.splice(index, 1);
    } else {
      retainedLayers[index] = {
        ...layer,
        quantity: roundQuantity(retainedQuantity),
        total_cost: Number((retainedQuantity * toNumber(layer.unit_cost, 0)).toFixed(2)),
        accounting_total_cost: Number((
          retainedQuantity * toNumber(layer.accounting_unit_cost ?? layer.unit_cost, 0)
        ).toFixed(2))
      };
    }
  }

  if (remainingToReturn > QUANTITY_EPSILON) {
    const error = new Error('Committed stock cannot be returned because its exact inventory-lot allocation is incomplete');
    error.status = 409;
    throw error;
  }

  return {
    retained_layers: retainedLayers,
    returned_layers: returnedLayers,
    returned_quantity: roundQuantity(toNumber(quantityToReturn, 0) - remainingToReturn)
  };
}

export function calculateProductionCommitmentAdjustment(
  previousLine = null,
  desiredQuantity = 0,
  { retryShortage = false } = {}
) {
  const desired = Math.max(0, toNumber(desiredQuantity, 0));
  const previousDesired = Math.max(0, toNumber(previousLine?.desired_quantity, 0));
  const previousCommitted = Math.max(0, toNumber(previousLine?.committed_quantity, 0));
  const previousShortage = Math.max(
    0,
    toNumber(previousLine?.shortage_quantity, previousDesired - previousCommitted)
  );

  let issueQuantity = 0;
  let returnQuantity = 0;
  if (!previousLine) {
    issueQuantity = desired;
  } else if (retryShortage) {
    issueQuantity = Math.max(0, desired - previousCommitted);
    returnQuantity = Math.max(0, previousCommitted - desired);
  } else if (desired > previousDesired + QUANTITY_EPSILON) {
    issueQuantity = desired - previousDesired;
  } else if (desired < previousDesired - QUANTITY_EPSILON) {
    returnQuantity = Math.max(0, previousCommitted - desired);
  }

  return {
    previous_desired_quantity: roundQuantity(previousDesired),
    previous_committed_quantity: roundQuantity(previousCommitted),
    previous_shortage_quantity: roundQuantity(previousShortage),
    desired_quantity: roundQuantity(desired),
    issue_quantity: roundQuantity(issueQuantity),
    return_quantity: roundQuantity(returnQuantity)
  };
}

function getProductionCommitmentLineQuantity(line) {
  return toNumber(
    line?.desired_quantity
      ?? line?.actual_quantity
      ?? line?.planned_quantity
      ?? line?.yield_adjusted_quantity
      ?? line?.required_quantity
      ?? line?.adjusted_quantity
      ?? line?.cost_quantity
      ?? line?.quantity,
    0
  );
}

export function normalizeProductionCommitmentDemand(
  lines = [],
  { ingredientCatalog = [], inventoryCatalog = [] } = {}
) {
  const ingredientMap = new Map(
    (Array.isArray(ingredientCatalog) ? ingredientCatalog : [])
      .map((ingredient) => [String(ingredient?.id || ''), ingredient])
  );
  const inventoryMap = new Map(
    (Array.isArray(inventoryCatalog) ? inventoryCatalog : [])
      .map((inventory) => [String(inventory?.ingredient_id || ''), inventory])
  );
  const demandMap = new Map();

  for (const line of Array.isArray(lines) ? lines : []) {
    const ingredientId = normalizeText(line?.ingredient_id);
    if (!ingredientId) {
      const error = new Error('Every production commitment line must include an ingredient ID');
      error.status = 400;
      throw error;
    }
    const sourceQuantity = getProductionCommitmentLineQuantity(line);
    if (!Number.isFinite(sourceQuantity) || sourceQuantity < 0) {
      const error = new Error(`Production quantity for ${line?.ingredient_name || ingredientId} must be zero or greater`);
      error.status = 400;
      throw error;
    }

    const ingredient = ingredientMap.get(ingredientId) || {};
    const inventory = inventoryMap.get(ingredientId) || {};
    const sourceUnit = line?.unit || inventory.unit || ingredient.unit || 'unit';
    const inventoryUnit = ingredient.unit || inventory.unit || sourceUnit;
    const desiredQuantity = convertIngredientQuantity(
      sourceQuantity,
      sourceUnit,
      inventoryUnit,
      ingredient
    );
    if (!Number.isFinite(desiredQuantity) || desiredQuantity < 0) {
      const error = new Error(`Production quantity for ${line?.ingredient_name || ingredientId} could not be converted to inventory units`);
      error.status = 400;
      throw error;
    }

    const existing = demandMap.get(ingredientId);
    if (existing && existing.unit !== inventoryUnit) {
      const error = new Error(`Production lines for ${line?.ingredient_name || ingredientId} resolve to conflicting inventory units`);
      error.status = 409;
      throw error;
    }
    if (existing) {
      existing.desired_quantity = roundQuantity(existing.desired_quantity + desiredQuantity);
      existing.source_recipe_names = [...new Set([
        ...(existing.source_recipe_names || []),
        ...(Array.isArray(line?.source_recipe_names) ? line.source_recipe_names : [])
      ])];
      continue;
    }

    demandMap.set(ingredientId, {
      ingredient_id: ingredientId,
      item_code: getItemCodeFromRecords([ingredient, line], null),
      ingredient_name: line?.ingredient_name || ingredient.name || inventory.ingredient_name || ingredientId,
      unit: inventoryUnit,
      desired_quantity: roundQuantity(desiredQuantity),
      source_recipe_names: Array.isArray(line?.source_recipe_names) ? line.source_recipe_names : [],
      yield_percent: toNumber(line?.yield_percent, 100)
    });
  }

  return [...demandMap.values()].sort((left, right) => (
    String(left.ingredient_id).localeCompare(String(right.ingredient_id))
  ));
}

export function getProductionInventoryCommitment(production = {}) {
  const embedded = production?.inventory_commitment && typeof production.inventory_commitment === 'object'
    ? production.inventory_commitment
    : {};
  const lines = Array.isArray(embedded.lines)
    ? embedded.lines
    : Array.isArray(production?.inventory_committed_lines)
      ? production.inventory_committed_lines
      : [];
  return {
    ...embedded,
    revision: Math.max(0, Math.trunc(toNumber(
      embedded.revision ?? production?.inventory_commitment_revision,
      0
    ))),
    status: embedded.status || production?.inventory_commitment_status || null,
    target_servings: embedded.target_servings ?? production?.inventory_committed_servings ?? null,
    lines
  };
}

export function hasProductionInventoryCommitment(production = {}) {
  const commitment = getProductionInventoryCommitment(production);
  return commitment.revision > 0
    || Boolean(commitment.status)
    || Boolean(production?.inventory_committed_at);
}

function buildCommitmentDemandFingerprint(lines = []) {
  return JSON.stringify((Array.isArray(lines) ? lines : []).map((line) => ({
    ingredient_id: line.ingredient_id,
    unit: line.unit,
    desired_quantity: roundQuantity(line.desired_quantity)
  })));
}

function resolveCommitmentSite({ production, fulfillmentStore, siteCatalog }) {
  if (fulfillmentStore?.id) return fulfillmentStore;
  if (Array.isArray(siteCatalog) && siteCatalog.length > 0) {
    return resolveProductionFulfillmentStore(production, siteCatalog);
  }
  const fallbackId = production?.fulfillment_store_id || production?.site_id;
  if (!fallbackId) {
    const error = new Error('A fulfillment Store is required before production inventory can be committed');
    error.status = 409;
    throw error;
  }
  return {
    id: fallbackId,
    name: production?.fulfillment_store_name || production?.site_name || null
  };
}

async function returnStockToCommittedLotsWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  unit,
  returned_layers,
  transaction_date,
  reference_id,
  reference_type = 'production',
  notes,
  performed_by,
  reason_code,
  source,
  source_type,
  operation,
  operation_id,
  idempotency_key,
  commitment_revision,
  metadata
}, executor) {
  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit
  }, executor);
  const balanceBefore = toNumber(inventory.available_quantity ?? inventory.quantity, 0);
  const movementLayers = [];
  let totalCost = 0;
  let availableReturnedCost = 0;
  let returnedQuantity = 0;
  const effectiveTransactionDate = parseInventoryDate(
    transaction_date || toDateOnly(),
    'Transaction date',
    { required: true }
  );

  for (const allocation of Array.isArray(returned_layers) ? returned_layers : []) {
    const lotId = normalizeText(allocation?.inventory_lot_id);
    if (!lotId) {
      const error = new Error('Committed stock cannot be returned without its inventory-lot ID');
      error.status = 409;
      throw error;
    }
    const lot = await findDocument('InventoryLot', lotId, executor, true);
    if (
      !lot
      || String(lot.site_id || '') !== String(site_id || '')
      || String(lot.ingredient_id || '') !== String(ingredient_id || '')
    ) {
      const error = new Error('A committed inventory lot is missing or no longer belongs to this production location');
      error.status = 409;
      throw error;
    }

    const quantity = Math.max(0, toNumber(allocation.quantity, 0));
    if (quantity <= QUANTITY_EPSILON) continue;
    const quantityBefore = Math.max(0, toNumber(lot.remaining_quantity, 0));
    const quantityAfter = quantityBefore + quantity;
    const currentStatus = normalizeText(lot.status || 'active').toLowerCase();
    const preservedUnavailableStatus = UNUSABLE_LOT_STATUSES.has(currentStatus)
      && !['consumed', 'expired'].includes(currentStatus);
    const restoredStatus = preservedUnavailableStatus
      ? currentStatus
      : lot.expiry_date && toDateOnly(lot.expiry_date) < toDateOnly()
        ? 'expired'
        : 'active';
    await updateDocument('InventoryLot', lot.id, {
      remaining_quantity: roundQuantity(quantityAfter),
      status: restoredStatus
    }, executor);

    const unitCost = toNumber(allocation.unit_cost ?? lot.unit_cost, 0);
    const accountingUnitCost = toNumber(allocation.accounting_unit_cost ?? unitCost, 0);
    const layerCost = quantity * unitCost;
    const accountingLayerCost = quantity * accountingUnitCost;
    totalCost += accountingLayerCost;
    const restoredLotIsAvailable = isInventoryLotUsable({
      ...lot,
      remaining_quantity: quantityAfter,
      status: restoredStatus
    }, { asOfDate: effectiveTransactionDate });
    if (restoredLotIsAvailable) availableReturnedCost += accountingLayerCost;
    returnedQuantity += quantity;
    movementLayers.push({
      inventory_lot_id: lot.id,
      batch_number: lot.batch_number || allocation.batch_number || null,
      stock_date: lot.stock_date || lot.received_date || allocation.stock_date || null,
      received_date: lot.received_date || lot.stock_date || allocation.received_date || null,
      expiry_date: lot.expiry_date || allocation.expiry_date || null,
      quantity: roundQuantity(quantity),
      quantity_before: roundQuantity(quantityBefore),
      quantity_after: roundQuantity(quantityAfter),
      unit_cost: unitCost,
      total_cost: Number(layerCost.toFixed(2)),
      accounting_unit_cost: accountingUnitCost,
      accounting_total_cost: Number(accountingLayerCost.toFixed(2)),
      available_after_return: restoredLotIsAvailable,
      commitment_source_transaction_id: allocation.source_transaction_id
        || allocation.inventory_transaction_id
        || null
    });
  }

  if (normalizeText(inventory.valuation_method || 'fifo') === 'weighted_average') {
    await revalueWeightedAverageLots(
      inventory,
      toNumber(inventory.total_value, 0) + availableReturnedCost,
      executor
    );
  }
  const refreshed = await recalculateInventoryRecord(inventory, executor);
  const balanceAfter = toNumber(refreshed.available_quantity ?? refreshed.quantity, 0);
  const transaction = returnedQuantity > QUANTITY_EPSILON
    ? await postInventoryTransaction({
      site_id,
      site_name,
      ingredient_id,
      ingredient_name,
      transaction_type: operation === 'cancellation' ? 'production_release' : 'production_return',
      quantity: returnedQuantity,
      unit,
      transaction_date: effectiveTransactionDate,
      reference_id,
      reference_type,
      notes,
      performed_by,
      total_cost: totalCost,
      unit_cost: returnedQuantity > 0 ? totalCost / returnedQuantity : 0,
      reason_code,
      movement_layers: movementLayers,
      source,
      source_type,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      opening_quantity: balanceBefore,
      addition_quantity: returnedQuantity,
      consumption_quantity: 0,
      remaining_quantity: balanceAfter,
      operation,
      operation_id,
      idempotency_key,
      commitment_revision,
      metadata
    }, executor)
    : null;

  return {
    inventory: refreshed,
    returned_quantity: roundQuantity(returnedQuantity),
    total_cost: Number(totalCost.toFixed(2)),
    available_return_cost: Number(availableReturnedCost.toFixed(2)),
    transaction_id: transaction?.id || null,
    movement_layers: movementLayers
  };
}

const PRODUCTION_RESERVATION_MODEL = 'reserve_then_consume_v1';

function isCurrentProductionReservation(commitment = {}) {
  return commitment?.stock_model === PRODUCTION_RESERVATION_MODEL
    || commitment?.model_version === PRODUCTION_RESERVATION_MODEL;
}

export function hasLegacyPhysicalProductionCommitment(commitment = {}) {
  if (isCurrentProductionReservation(commitment)) return false;
  const status = normalizeText(commitment?.status).toLowerCase();
  if (!['committed', 'partially_committed'].includes(status)) return false;
  const positiveLines = (Array.isArray(commitment?.lines) ? commitment.lines : [])
    .filter((line) => toNumber(line?.committed_quantity, 0) > QUANTITY_EPSILON);
  if (positiveLines.length === 0) return false;
  return positiveLines.every((line) => {
    const committedQuantity = toNumber(line?.committed_quantity, 0);
    const allocations = Array.isArray(line?.allocation_layers) ? line.allocation_layers : [];
    const allocatedQuantity = allocations.reduce((sum, layer) => sum + toNumber(layer?.quantity, 0), 0);
    const transactionIds = Array.isArray(line?.inventory_transaction_ids)
      ? line.inventory_transaction_ids.filter(Boolean)
      : [];
    const hasTransactionEvidence = transactionIds.length > 0
      || allocations.some((layer) => layer?.source_transaction_id || layer?.inventory_transaction_id);
    return hasTransactionEvidence && quantitiesEqual(committedQuantity, allocatedQuantity);
  });
}

function sanitizeProductionAllocationLayers(layers = []) {
  return (Array.isArray(layers) ? layers : []).map((layer) => {
    const { production_id: _productionId, ...safeLayer } = layer || {};
    return safeLayer;
  });
}

function sanitizeProductionCommitmentLine(line = {}) {
  return {
    ...line,
    allocation_layers: sanitizeProductionAllocationLayers(line?.allocation_layers)
  };
}

async function reserveStockWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  quantity,
  unit,
  as_of_date = null,
  allow_shortage = false,
  production_id,
  commitment_revision,
  operation_id
}, executor) {
  const requestedQuantity = Math.max(0, toNumber(quantity, 0));
  if (requestedQuantity <= QUANTITY_EPSILON) {
    return {
      requested_quantity: 0,
      reserved_quantity: 0,
      shortage_quantity: 0,
      total_cost: 0,
      movement_layers: []
    };
  }

  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit
  }, executor);
  const lots = await listInventoryLots({
    siteId: site_id,
    ingredientId: ingredient_id,
    includeEmpty: true,
    lock: true
  }, executor);
  const reservationDate = parseInventoryDate(
    as_of_date || toDateOnly(),
    'Production reservation date',
    { required: true }
  );
  const sortedLots = sortInventoryLotsForIssue(
    lots.filter((lot) => getInventoryLotReservationAvailableQuantity(lot, { asOfDate: reservationDate }) > QUANTITY_EPSILON),
    { asOfDate: reservationDate }
  );
  const reservableQuantity = sortedLots.reduce(
    (sum, lot) => sum + getInventoryLotReservationAvailableQuantity(lot, { asOfDate: reservationDate }),
    0
  );
  if (!allow_shortage && reservableQuantity + QUANTITY_EPSILON < requestedQuantity) {
    throw buildInsufficientReservationStockError({
      lots,
      requestedQuantity,
      asOfDate: reservationDate,
      unit,
      ingredientName: ingredient_name,
      ingredientId: ingredient_id,
      siteName: site_name
    });
  }

  let remainingToReserve = requestedQuantity;
  const movementLayers = [];
  const valuationMethod = normalizeText(inventory.valuation_method || 'fifo') || 'fifo';
  const weightedAverageUnitCost = toNumber(inventory.average_unit_cost, 0);

  for (const lot of sortedLots) {
    if (remainingToReserve <= QUANTITY_EPSILON) break;
    const remaining = Math.max(0, toNumber(lot.remaining_quantity, 0));
    const reservedBefore = getInventoryLotReservedQuantity(lot);
    const availableBefore = Math.max(0, remaining - reservedBefore);
    if (availableBefore <= QUANTITY_EPSILON) continue;

    const layerQuantity = Math.min(availableBefore, remainingToReserve);
    const reservedAfter = roundQuantity(reservedBefore + layerQuantity);
    await updateDocument('InventoryLot', lot.id, {
      reserved_quantity: reservedAfter
    }, executor);
    const unitCost = toNumber(lot.unit_cost, 0);
    const accountingUnitCost = valuationMethod === 'weighted_average'
      ? weightedAverageUnitCost
      : unitCost;
    movementLayers.push({
      inventory_lot_id: lot.id,
      batch_number: lot.batch_number || null,
      stock_date: lot.stock_date || lot.received_date || null,
      received_date: lot.received_date || lot.stock_date || null,
      expiry_date: lot.expiry_date || null,
      quantity: roundQuantity(layerQuantity),
      quantity_before: remaining,
      quantity_after: remaining,
      reserved_quantity_before: reservedBefore,
      reserved_quantity_after: reservedAfter,
      available_quantity_before: roundQuantity(availableBefore),
      available_quantity_after: roundQuantity(availableBefore - layerQuantity),
      unit_cost: unitCost,
      total_cost: Number((layerQuantity * unitCost).toFixed(2)),
      accounting_unit_cost: accountingUnitCost,
      accounting_total_cost: Number((layerQuantity * accountingUnitCost).toFixed(2)),
      production_id,
      commitment_revision,
      operation_id
    });
    remainingToReserve -= layerQuantity;
  }

  const reservedQuantity = Math.max(0, requestedQuantity - remainingToReserve);
  await recalculateInventoryRecord(inventory, executor);
  return {
    requested_quantity: roundQuantity(requestedQuantity),
    reserved_quantity: roundQuantity(reservedQuantity),
    shortage_quantity: roundQuantity(remainingToReserve),
    total_cost: Number(movementLayers.reduce(
      (sum, layer) => sum + toNumber(layer.accounting_total_cost, 0),
      0
    ).toFixed(2)),
    movement_layers: movementLayers
  };
}

async function releaseReservedStockLayersWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  unit,
  released_layers
}, executor) {
  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit
  }, executor);
  const movementLayers = [];
  let releasedQuantity = 0;

  for (const allocation of Array.isArray(released_layers) ? released_layers : []) {
    const lotId = normalizeText(allocation?.inventory_lot_id);
    const quantity = Math.max(0, toNumber(allocation?.quantity, 0));
    if (!lotId || quantity <= QUANTITY_EPSILON) continue;
    const lot = await findDocument('InventoryLot', lotId, executor, true);
    if (
      !lot
      || String(lot.site_id || '') !== String(site_id || '')
      || String(lot.ingredient_id || '') !== String(ingredient_id || '')
    ) {
      const error = new Error('A reserved inventory lot is missing or no longer belongs to this production location');
      error.status = 409;
      throw error;
    }
    const reservedBefore = getInventoryLotReservedQuantity(lot);
    if (reservedBefore + QUANTITY_EPSILON < quantity) {
      const error = new Error('Reserved inventory cannot be released because its exact lot reservation is incomplete');
      error.status = 409;
      throw error;
    }
    const remaining = Math.max(0, toNumber(lot.remaining_quantity, 0));
    const reservedAfter = roundQuantity(Math.max(0, reservedBefore - quantity));
    await updateDocument('InventoryLot', lot.id, {
      reserved_quantity: reservedAfter
    }, executor);
    releasedQuantity += quantity;
    movementLayers.push({
      ...allocation,
      quantity: roundQuantity(quantity),
      quantity_before: remaining,
      quantity_after: remaining,
      reserved_quantity_before: reservedBefore,
      reserved_quantity_after: reservedAfter,
      available_quantity_before: roundQuantity(Math.max(0, remaining - reservedBefore)),
      available_quantity_after: roundQuantity(Math.max(0, remaining - reservedAfter))
    });
  }

  await recalculateInventoryRecord(inventory, executor);
  return {
    released_quantity: roundQuantity(releasedQuantity),
    movement_layers: movementLayers
  };
}

export async function consumeProductionInventoryReservation({
  production,
  actor = {},
  operationId = null,
  reason = ''
}, executor) {
  if (!production?.id || !executor) {
    const error = new Error('Production reservation consumption must run inside the production transaction');
    error.status = production?.id ? 500 : 400;
    throw error;
  }
  if (typeof executor.query === 'function') {
    await executor.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`production-inventory:${String(production.id)}`]
    );
  }

  const current = getProductionInventoryCommitment(production);
  const currentStatus = normalizeText(current.status).toLowerCase();
  const expectedStoreId = normalizeText(production.fulfillment_store_id);
  if (
    isCurrentProductionReservation(current)
    && expectedStoreId
    && normalizeText(current.site_id) !== expectedStoreId
  ) {
    const error = new Error('Production inventory reservation belongs to a different fulfillment Store');
    error.status = 409;
    throw error;
  }
  if (['consumed', 'partially_consumed'].includes(currentStatus)) {
    return { mutated: false, inventory_mutated: false, commitment: current, production_patch: {}, movements: [] };
  }

  const timestamp = nowIso();
  const performedBy = actor?.email || actor?.id || 'system';
  const effectiveOperationId = normalizeText(operationId)
    || `production:${production.id}:inventory:start:${current.revision}`;

  // Before this reservation model, "committed" meant stock was physically
  // deducted at Area Manager approval. Mark those records consumed at start,
  // but never issue their exact lot allocations a second time.
  if (!isCurrentProductionReservation(current)) {
    if (!hasLegacyPhysicalProductionCommitment(current)) {
      const error = new Error('Production inventory has not been reserved');
      error.status = 409;
      throw error;
    }
    const legacyStatus = currentStatus === 'partially_committed' ? 'partially_consumed' : 'consumed';
    const legacyCommitment = {
      ...current,
      status: legacyStatus,
      stock_model: 'legacy_approval_deduction_v0',
      model_version: 'legacy_approval_deduction_v0',
      operation: 'legacy_start_recognition',
      last_operation_id: effectiveOperationId,
      updated_at: timestamp,
      updated_by: performedBy,
      consumed_at: timestamp,
      consumed_by: performedBy,
      lines: (Array.isArray(current.lines) ? current.lines : []).map((line) => ({
        ...sanitizeProductionCommitmentLine(line),
        reserved_quantity: 0,
        consumed_quantity: roundQuantity(line?.committed_quantity),
        last_consumed_at: timestamp,
        last_consumed_by: performedBy
      }))
    };
    return {
      mutated: true,
      inventory_mutated: false,
      commitment: legacyCommitment,
      production_patch: {
        inventory_commitment: legacyCommitment,
        inventory_commitment_status: legacyStatus,
        inventory_commitment_operation_id: effectiveOperationId,
        inventory_commitment_idempotency_key: effectiveOperationId,
        inventory_commitment_updated_at: timestamp,
        inventory_commitment_updated_by: performedBy,
        inventory_committed_lines: legacyCommitment.lines,
        inventory_consumed_at: timestamp,
        inventory_consumed_by: performedBy,
        inventory_consumed_by_name: actor?.full_name || actor?.email || null,
        inventory_commitment_history: [
          ...(Array.isArray(production.inventory_commitment_history)
            ? production.inventory_commitment_history.slice(-99)
            : []),
          {
            revision: current.revision,
            operation: 'legacy_start_recognition',
            operation_id: effectiveOperationId,
            status: legacyStatus,
            actor_id: actor?.id || null,
            actor_email: actor?.email || null,
            actor_name: actor?.full_name || actor?.email || null,
            reason: normalizeText(reason) || 'Legacy Area Manager deduction recognized at production start.',
            timestamp,
            movements: []
          }
        ]
      },
      movements: []
    };
  }

  const emptyReleasedReservation = currentStatus === 'released'
    && toNumber(current.total_desired_quantity, 0) <= QUANTITY_EPSILON;
  if (!['reserved', 'partially_reserved'].includes(currentStatus) && !emptyReleasedReservation) {
    const error = new Error('Production inventory reservation is not ready to be consumed');
    error.status = 409;
    throw error;
  }
  if (currentStatus === 'partially_reserved' || toNumber(current.total_shortage_quantity, 0) > QUANTITY_EPSILON) {
    const error = new Error('Production cannot start while its inventory reservation has shortages');
    error.status = 409;
    throw error;
  }
  if (
    toNumber(current.total_desired_quantity, 0) > QUANTITY_EPSILON
    && (!Array.isArray(current.lines) || current.lines.length === 0)
  ) {
    const error = new Error('Production inventory reservation is missing its ingredient allocations');
    error.status = 409;
    throw error;
  }

  const movements = [];
  const nextLines = [];
  const plannedEligibilityDate = parseInventoryDate(
    stockReservationDateForProduction(production),
    'Production stock reservation date',
    { required: true }
  );
  for (const line of Array.isArray(current.lines) ? current.lines : []) {
    const allocationLayers = Array.isArray(line?.allocation_layers) ? line.allocation_layers : [];
    const expectedQuantity = Math.max(0, toNumber(line?.reserved_quantity ?? line?.committed_quantity, 0));
    const allocatedQuantity = allocationLayers.reduce((sum, layer) => sum + toNumber(layer?.quantity, 0), 0);
    if (!quantitiesEqual(expectedQuantity, allocatedQuantity)) {
      const error = new Error(`Reservation for ${line?.ingredient_name || line?.ingredient_id} has incomplete lot allocations`);
      error.status = 409;
      throw error;
    }

    const inventory = await ensureInventoryRecord({
      site_id: current.site_id,
      site_name: current.site_name,
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      unit: line.unit
    }, executor);
    const balanceBefore = toNumber(inventory.on_hand_quantity, 0);
    const availableBefore = toNumber(inventory.available_quantity ?? inventory.quantity, 0);
    const valuationMethod = normalizeText(inventory.valuation_method || 'fifo') || 'fifo';
    const weightedAverageUnitCost = toNumber(inventory.average_unit_cost, 0);
    const consumedLayers = [];
    let fifoCost = 0;

    for (const allocation of allocationLayers) {
      const lot = await findDocument('InventoryLot', allocation.inventory_lot_id, executor, true);
      const quantity = Math.max(0, toNumber(allocation.quantity, 0));
      if (
        !lot
        || String(lot.site_id || '') !== String(current.site_id || '')
        || String(lot.ingredient_id || '') !== String(line.ingredient_id || '')
      ) {
        const error = new Error('A reserved inventory lot is missing or belongs to another production location');
        error.status = 409;
        throw error;
      }
      if (
        !isInventoryLotUsable(lot, { asOfDate: toDateOnly() })
        || !isInventoryLotUsable(lot, { asOfDate: plannedEligibilityDate })
      ) {
        const error = new Error(`Reserved batch ${lot.batch_number || lot.id} is no longer eligible for production consumption`);
        error.status = 409;
        throw error;
      }
      const remainingBefore = Math.max(0, toNumber(lot.remaining_quantity, 0));
      const reservedBefore = getInventoryLotReservedQuantity(lot);
      if (remainingBefore + QUANTITY_EPSILON < quantity || reservedBefore + QUANTITY_EPSILON < quantity) {
        const error = new Error(`Reserved batch ${lot.batch_number || lot.id} no longer has the allocated quantity`);
        error.status = 409;
        throw error;
      }
      const remainingAfter = roundQuantity(Math.max(0, remainingBefore - quantity));
      const reservedAfter = roundQuantity(Math.max(0, reservedBefore - quantity));
      await updateDocument('InventoryLot', lot.id, {
        remaining_quantity: remainingAfter,
        reserved_quantity: reservedAfter,
        status: remainingAfter <= QUANTITY_EPSILON ? 'consumed' : lot.status
      }, executor);
      const unitCost = toNumber(lot.unit_cost, 0);
      const accountingUnitCost = valuationMethod === 'weighted_average'
        ? weightedAverageUnitCost
        : unitCost;
      fifoCost += quantity * unitCost;
      consumedLayers.push({
        inventory_lot_id: lot.id,
        batch_number: lot.batch_number || allocation.batch_number || null,
        stock_date: lot.stock_date || lot.received_date || allocation.stock_date || null,
        received_date: lot.received_date || lot.stock_date || allocation.received_date || null,
        expiry_date: lot.expiry_date || allocation.expiry_date || null,
        quantity: roundQuantity(quantity),
        quantity_before: remainingBefore,
        quantity_after: remainingAfter,
        reserved_quantity_before: reservedBefore,
        reserved_quantity_after: reservedAfter,
        available_quantity_before: roundQuantity(Math.max(0, remainingBefore - reservedBefore)),
        available_quantity_after: roundQuantity(Math.max(0, remainingAfter - reservedAfter)),
        unit_cost: unitCost,
        total_cost: Number((quantity * unitCost).toFixed(2)),
        accounting_unit_cost: accountingUnitCost,
        accounting_total_cost: Number((quantity * accountingUnitCost).toFixed(2)),
        reservation_revision: current.revision,
        reservation_operation_id: allocation.operation_id || null
      });
    }

    const consumedQuantity = consumedLayers.reduce((sum, layer) => sum + toNumber(layer.quantity, 0), 0);
    const totalCost = valuationMethod === 'weighted_average'
      ? consumedQuantity * weightedAverageUnitCost
      : fifoCost;
    if (valuationMethod === 'weighted_average') {
      await revalueWeightedAverageLots(
        inventory,
        Math.max(0, toNumber(inventory.total_value, 0) - totalCost),
        executor
      );
    }
    const refreshed = await recalculateInventoryRecord(inventory, executor);
    const balanceAfter = toNumber(refreshed.on_hand_quantity, 0);
    const transaction = consumedQuantity > QUANTITY_EPSILON
      ? await postInventoryTransaction({
        site_id: current.site_id,
        site_name: current.site_name,
        ingredient_id: line.ingredient_id,
        ingredient_name: line.ingredient_name,
        transaction_type: 'production_use',
        quantity: consumedQuantity * -1,
        unit: line.unit,
        transaction_date: toDateOnly(),
        reference_id: production.id,
        reference_type: 'production',
        notes: normalizeText(reason) || `Consumed reserved inventory when production started: ${production.recipe_name || production.id}`,
        performed_by: performedBy,
        total_cost: totalCost,
        unit_cost: consumedQuantity > 0 ? totalCost / consumedQuantity : 0,
        reason_code: 'production_start_consumption',
        movement_layers: consumedLayers,
        source: 'production_start',
        source_type: 'production_consumption',
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        opening_quantity: balanceBefore,
        addition_quantity: 0,
        consumption_quantity: consumedQuantity,
        remaining_quantity: balanceAfter,
        operation: 'production_start_consumption',
        operation_id: effectiveOperationId,
        idempotency_key: `${effectiveOperationId}:${line.ingredient_id}:consume`,
        commitment_revision: current.revision,
        metadata: {
          production_id: production.id,
          production_date: production.production_date || null,
          reservation_revision: current.revision,
          available_quantity_before: availableBefore,
          available_quantity_after: toNumber(refreshed.available_quantity ?? refreshed.quantity, 0)
        }
      }, executor)
      : null;
    const transactionIds = [
      ...(Array.isArray(line.inventory_transaction_ids) ? line.inventory_transaction_ids : []),
      transaction?.id
    ].filter(Boolean);
    nextLines.push({
      ...line,
      committed_quantity: roundQuantity(consumedQuantity),
      reserved_quantity: 0,
      consumed_quantity: roundQuantity(consumedQuantity),
      total_cost: Number(totalCost.toFixed(2)),
      allocation_layers: consumedLayers,
      inventory_transaction_ids: [...new Set(transactionIds)],
      last_consumed_at: timestamp,
      last_consumed_by: performedBy
    });
    movements.push({
      direction: 'deduction',
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      quantity: roundQuantity(consumedQuantity),
      unit: line.unit,
      transaction_id: transaction?.id || null,
      inventory_lot_changes: consumedLayers
    });
  }

  const totalConsumed = nextLines.reduce((sum, line) => sum + toNumber(line.consumed_quantity, 0), 0);
  const commitment = {
    ...current,
    status: 'consumed',
    stock_model: PRODUCTION_RESERVATION_MODEL,
    model_version: PRODUCTION_RESERVATION_MODEL,
    operation: 'production_start_consumption',
    last_operation_id: effectiveOperationId,
    updated_at: timestamp,
    updated_by: performedBy,
    consumed_at: timestamp,
    consumed_by: performedBy,
    total_reserved_quantity: 0,
    total_committed_quantity: roundQuantity(totalConsumed),
    total_consumed_quantity: roundQuantity(totalConsumed),
    lines: nextLines
  };
  return {
    mutated: true,
    inventory_mutated: movements.some((movement) => movement.quantity > QUANTITY_EPSILON),
    commitment,
    production_patch: {
      inventory_commitment: commitment,
      inventory_commitment_status: 'consumed',
      inventory_commitment_operation_id: effectiveOperationId,
      inventory_commitment_idempotency_key: effectiveOperationId,
      inventory_commitment_updated_at: timestamp,
      inventory_commitment_updated_by: performedBy,
      inventory_committed_lines: nextLines,
      inventory_consumed_at: timestamp,
      inventory_consumed_by: performedBy,
      inventory_consumed_by_name: actor?.full_name || actor?.email || null,
      inventory_commitment_history: [
        ...(Array.isArray(production.inventory_commitment_history)
          ? production.inventory_commitment_history.slice(-99)
          : []),
        {
          revision: current.revision,
          operation: 'production_start_consumption',
          operation_id: effectiveOperationId,
          status: 'consumed',
          actor_id: actor?.id || null,
          actor_email: actor?.email || null,
          actor_name: actor?.full_name || actor?.email || null,
          reason: normalizeText(reason) || null,
          timestamp,
          movements: movements.map((movement) => ({
            direction: movement.direction,
            ingredient_id: movement.ingredient_id,
            quantity: movement.quantity,
            unit: movement.unit,
            transaction_id: movement.transaction_id
          }))
        }
      ]
    },
    movements
  };
}

export async function reconcileProductionInventoryCommitment({
  production,
  actor = {},
  desiredIngredients = null,
  operation = 'approval',
  reason = '',
  allowShortage = false,
  retryShortages = false,
  expectedRevision = null,
  operationId = null,
  idempotencyKey = null,
  asOfDate = null,
  siteCatalog = [],
  ingredientCatalog = [],
  inventoryCatalog = [],
  fulfillmentStore = null,
  targetServings = null
}, executor) {
  if (!production?.id) {
    const error = new Error('A production record is required for inventory commitment');
    error.status = 400;
    throw error;
  }
  if (!executor) {
    const error = new Error('Production inventory commitment must run inside the production transaction');
    error.status = 500;
    throw error;
  }
  if (typeof executor.query === 'function') {
    await executor.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`production-inventory:${String(production.id)}`]
    );
  }

  const current = getProductionInventoryCommitment(production);
  const reservationAccounting = operation !== 'completion_reconciliation'
    && (
      isCurrentProductionReservation(current)
      || !hasProductionInventoryCommitment(production)
      || !hasLegacyPhysicalProductionCommitment(current)
    );
  const repairingUnprovenLegacyCommitment = reservationAccounting
    && hasProductionInventoryCommitment(production)
    && !isCurrentProductionReservation(current);
  if (
    expectedRevision !== null
    && Math.max(0, Math.trunc(toNumber(expectedRevision, -1))) !== current.revision
  ) {
    const error = new Error(
      `Production inventory commitment changed from revision ${expectedRevision} to ${current.revision}; reload and retry`
    );
    error.status = 409;
    throw error;
  }

  const stockSite = resolveCommitmentSite({ production, fulfillmentStore, siteCatalog });
  if (
    isCurrentProductionReservation(current)
    && current.site_id
    && String(current.site_id) !== String(stockSite.id)
  ) {
    const error = new Error('Production inventory reservation belongs to a different fulfillment Store');
    error.status = 409;
    throw error;
  }
  const demand = normalizeProductionCommitmentDemand(
    desiredIngredients ?? production.ingredients_used ?? [],
    { ingredientCatalog, inventoryCatalog }
  );
  const demandFingerprint = buildCommitmentDemandFingerprint(demand);
  const requestedOperationId = normalizeText(operationId || idempotencyKey);
  if (requestedOperationId && requestedOperationId === normalizeText(current.last_operation_id)) {
    if (current.demand_fingerprint && current.demand_fingerprint !== demandFingerprint) {
      const error = new Error('The production inventory idempotency key was already used with different quantities');
      error.status = 409;
      throw error;
    }
    return {
      mutated: false,
      commitment: current,
      production_patch: {},
      movements: []
    };
  }

  const previousLineMap = new Map(
    (repairingUnprovenLegacyCommitment ? [] : Array.isArray(current.lines) ? current.lines : [])
      .map((line) => [String(line?.ingredient_id || ''), line])
      .filter(([ingredientId]) => ingredientId)
  );
  const demandMap = new Map(demand.map((line) => [String(line.ingredient_id), line]));
  const ingredientIds = [...new Set([...previousLineMap.keys(), ...demandMap.keys()])].sort();
  const changes = ingredientIds.map((ingredientId) => {
    const previousLine = previousLineMap.get(ingredientId) || null;
    const desiredLine = demandMap.get(ingredientId) || {
      ingredient_id: ingredientId,
      item_code: previousLine?.item_code || null,
      ingredient_name: previousLine?.ingredient_name || ingredientId,
      unit: previousLine?.unit || 'unit',
      desired_quantity: 0,
      source_recipe_names: previousLine?.source_recipe_names || [],
      yield_percent: previousLine?.yield_percent ?? 100
    };
    if (previousLine?.unit && desiredLine.unit && !areInventoryUnitsEquivalent(previousLine.unit, desiredLine.unit)) {
      const error = new Error(
        `Inventory unit for ${desiredLine.ingredient_name} changed from ${previousLine.unit} to ${desiredLine.unit}; reconcile the inventory master first`
      );
      error.status = 409;
      throw error;
    }
    return {
      ingredient_id: ingredientId,
      previous_line: previousLine,
      desired_line: desiredLine,
      adjustment: calculateProductionCommitmentAdjustment(
        previousLine,
        desiredLine.desired_quantity,
        { retryShortage: retryShortages }
      )
    };
  });

  const isCompletionFinalization = operation === 'completion_reconciliation'
    && !['consumed', 'partially_consumed'].includes(String(current.status || '').toLowerCase());
  const hasApprovedTargetChange = operation === 'approved_quantity_adjustment'
    && targetServings !== null
    && (
      current.target_servings === null
      || typeof current.target_servings === 'undefined'
      || !quantitiesEqual(current.target_servings, targetServings)
    );
  const hasDemandChange = !hasProductionInventoryCommitment(production)
    || repairingUnprovenLegacyCommitment
    || isCompletionFinalization
    || hasApprovedTargetChange
    || changes.some(({ adjustment }) => (
      !quantitiesEqual(adjustment.previous_desired_quantity, adjustment.desired_quantity)
      || adjustment.issue_quantity > QUANTITY_EPSILON
      || adjustment.return_quantity > QUANTITY_EPSILON
    ));
  if (!hasDemandChange) {
    return {
      mutated: false,
      commitment: current,
      production_patch: {},
      movements: []
    };
  }

  const revision = current.revision + 1;
  const effectiveOperationId = requestedOperationId
    || `production:${production.id}:inventory:${revision}:${normalizeText(operation) || 'reconcile'}`;
  // Reservations are evaluated against the intended production date so a lot
  // that expires beforehand is never allocated. Physical movement timestamps
  // still reflect the action date when consumption/reconciliation is posted.
  const effectiveDate = toDateOnly(asOfDate || toDateOnly());
  const performedBy = actor?.email || actor?.id || 'system';
  const timestamp = nowIso();
  const nextLines = [];
  const movements = [];

  for (const change of changes) {
    const { previous_line: previousLine, desired_line: desiredLine, adjustment } = change;
    let allocationLayers = sanitizeProductionAllocationLayers(previousLine?.allocation_layers);
    let committedQuantity = Math.max(0, toNumber(
      reservationAccounting
        ? previousLine?.reserved_quantity ?? previousLine?.committed_quantity
        : previousLine?.consumed_quantity ?? previousLine?.committed_quantity,
      0
    ));
    const transactionIds = Array.isArray(previousLine?.inventory_transaction_ids)
      ? [...previousLine.inventory_transaction_ids]
      : [];

    if (adjustment.return_quantity > QUANTITY_EPSILON) {
      const allocationSplit = splitCommittedAllocationLayers(
        allocationLayers,
        adjustment.return_quantity
      );
      const returned = reservationAccounting
        ? await releaseReservedStockLayersWithExecutor({
          site_id: stockSite.id,
          site_name: stockSite.name || production.fulfillment_store_name || production.site_name,
          ingredient_id: desiredLine.ingredient_id,
          ingredient_name: desiredLine.ingredient_name,
          unit: desiredLine.unit,
          released_layers: allocationSplit.returned_layers
        }, executor)
        : await returnStockToCommittedLotsWithExecutor({
        site_id: stockSite.id,
        site_name: stockSite.name || production.fulfillment_store_name || production.site_name,
        ingredient_id: desiredLine.ingredient_id,
        ingredient_name: desiredLine.ingredient_name,
        unit: desiredLine.unit,
        returned_layers: allocationSplit.returned_layers,
        transaction_date: effectiveDate,
        reference_id: production.id,
        reference_type: 'production',
        notes: reason || `Inventory commitment reconciled for ${production.recipe_name || production.id}`,
        performed_by: performedBy,
        reason_code: operation === 'cancellation'
          ? 'production_cancellation_return'
          : operation === 'completion_reconciliation'
            ? 'production_completion_reconciliation_return'
            : 'production_commitment_reconciliation_return',
        source: operation === 'completion_reconciliation'
          ? 'production_completion'
          : 'production_inventory_commitment',
        source_type: 'return_or_cancellation',
        operation,
        operation_id: effectiveOperationId,
        idempotency_key: `${effectiveOperationId}:${desiredLine.ingredient_id}:return`,
        commitment_revision: revision,
        metadata: {
          production_id: production.id,
          production_date: production.production_date || null,
          target_servings: targetServings ?? production.target_servings ?? null,
          previous_desired_quantity: adjustment.previous_desired_quantity,
          desired_quantity: adjustment.desired_quantity
        }
      }, executor);
      allocationLayers = allocationSplit.retained_layers;
      const returnedQuantity = reservationAccounting
        ? returned.released_quantity
        : returned.returned_quantity;
      committedQuantity = Math.max(0, committedQuantity - returnedQuantity);
      if (returned.transaction_id) transactionIds.push(returned.transaction_id);
      movements.push({
        direction: reservationAccounting ? 'release' : 'return',
        ingredient_id: desiredLine.ingredient_id,
        ingredient_name: desiredLine.ingredient_name,
        quantity: returnedQuantity,
        unit: desiredLine.unit,
        transaction_id: returned.transaction_id,
        inventory_lot_changes: returned.movement_layers
      });
    }

    if (adjustment.issue_quantity > QUANTITY_EPSILON) {
      const issued = reservationAccounting
        ? await reserveStockWithExecutor({
          site_id: stockSite.id,
          site_name: stockSite.name || production.fulfillment_store_name || production.site_name,
          ingredient_id: desiredLine.ingredient_id,
          ingredient_name: desiredLine.ingredient_name,
          quantity: adjustment.issue_quantity,
          unit: desiredLine.unit,
          as_of_date: effectiveDate,
          allow_shortage: allowShortage,
          production_id: production.id,
          commitment_revision: revision,
          operation_id: effectiveOperationId
        }, executor)
        : await deductStockWithExecutor({
        site_id: stockSite.id,
        site_name: stockSite.name || production.fulfillment_store_name || production.site_name,
        ingredient_id: desiredLine.ingredient_id,
        ingredient_name: desiredLine.ingredient_name,
        quantity: adjustment.issue_quantity,
        unit: desiredLine.unit,
        transaction_type: operation === 'completion_reconciliation'
          ? 'production_use'
          : 'production_commitment',
        transaction_date: effectiveDate,
        reference_id: production.id,
        reference_type: 'production',
        notes: reason || `Committed for production: ${production.recipe_name || production.id}`,
        performed_by: performedBy,
        reason_code: operation === 'completion_reconciliation'
          ? 'production_completion_reconciliation'
          : 'production_approval_commitment',
        allow_shortage: allowShortage,
        as_of_date: effectiveDate,
        source: operation === 'completion_reconciliation'
          ? 'production_completion'
          : 'production_inventory_commitment',
        source_type: 'production_consumption',
        operation,
        operation_id: effectiveOperationId,
        idempotency_key: `${effectiveOperationId}:${desiredLine.ingredient_id}:issue`,
        commitment_revision: revision,
        metadata: {
          production_id: production.id,
          production_date: production.production_date || null,
          target_servings: targetServings ?? production.target_servings ?? null,
          previous_desired_quantity: adjustment.previous_desired_quantity,
          desired_quantity: adjustment.desired_quantity
        }
      }, executor);
      const issuedQuantity = reservationAccounting
        ? issued.reserved_quantity
        : issued.issued_quantity;
      const newLayers = sanitizeProductionAllocationLayers(issued.movement_layers).map((layer) => ({
        ...layer,
        source_transaction_id: issued.transaction_id || null,
        commitment_revision: revision,
        operation_id: effectiveOperationId
      }));
      allocationLayers.push(...newLayers);
      committedQuantity += issuedQuantity;
      if (issued.transaction_id) transactionIds.push(issued.transaction_id);
      movements.push({
        direction: reservationAccounting ? 'reserve' : 'deduction',
        ingredient_id: desiredLine.ingredient_id,
        ingredient_name: desiredLine.ingredient_name,
        quantity: issuedQuantity,
        shortage_quantity: issued.shortage_quantity,
        unit: desiredLine.unit,
        transaction_id: issued.transaction_id,
        inventory_lot_changes: issued.movement_layers
      });
    }

    committedQuantity = roundQuantity(committedQuantity);
    const desiredQuantity = roundQuantity(desiredLine.desired_quantity);
    const totalCost = allocationLayers.reduce(
      (sum, layer) => sum + (
        toNumber(layer.quantity, 0)
        * toNumber(layer.accounting_unit_cost ?? layer.unit_cost, 0)
      ),
      0
    );
    nextLines.push({
      ...desiredLine,
      desired_quantity: desiredQuantity,
      committed_quantity: committedQuantity,
      reserved_quantity: reservationAccounting ? committedQuantity : 0,
      consumed_quantity: reservationAccounting
        ? Math.max(0, toNumber(previousLine?.consumed_quantity, 0))
        : committedQuantity,
      shortage_quantity: roundQuantity(Math.max(0, desiredQuantity - committedQuantity)),
      total_cost: Number(totalCost.toFixed(2)),
      allocation_layers: allocationLayers,
      inventory_transaction_ids: [...new Set(transactionIds.filter(Boolean))],
      last_reconciled_at: timestamp,
      last_reconciled_by: performedBy,
      commitment_revision: revision
    });
  }

  const totalDesired = nextLines.reduce((sum, line) => sum + toNumber(line.desired_quantity, 0), 0);
  const totalCommitted = nextLines.reduce((sum, line) => sum + toNumber(line.committed_quantity, 0), 0);
  const totalShortage = nextLines.reduce((sum, line) => sum + toNumber(line.shortage_quantity, 0), 0);
  const status = operation === 'completion_reconciliation'
    ? totalShortage > QUANTITY_EPSILON
      ? 'partially_consumed'
      : 'consumed'
    : totalDesired <= QUANTITY_EPSILON && totalCommitted <= QUANTITY_EPSILON
      ? 'released'
      : totalShortage > QUANTITY_EPSILON
        ? reservationAccounting ? 'partially_reserved' : 'partially_committed'
        : reservationAccounting ? 'reserved' : 'committed';
  const commitment = {
    revision,
    status,
    stock_model: reservationAccounting ? PRODUCTION_RESERVATION_MODEL : current.stock_model || current.model_version || null,
    model_version: reservationAccounting ? PRODUCTION_RESERVATION_MODEL : current.model_version || current.stock_model || null,
    operation: normalizeText(operation) || 'reconcile',
    last_operation_id: effectiveOperationId,
    idempotency_key: effectiveOperationId,
    demand_fingerprint: demandFingerprint,
    site_id: stockSite.id,
    site_name: stockSite.name || production.fulfillment_store_name || production.site_name || null,
    target_servings: targetServings ?? production.target_servings ?? null,
    committed_at: current.committed_at || timestamp,
    committed_by: current.committed_by || performedBy,
    reserved_at: reservationAccounting ? current.reserved_at || timestamp : current.reserved_at || null,
    reserved_by: reservationAccounting ? current.reserved_by || performedBy : current.reserved_by || null,
    updated_at: timestamp,
    updated_by: performedBy,
    released_at: status === 'released' ? timestamp : null,
    released_by: status === 'released' ? performedBy : null,
    total_desired_quantity: roundQuantity(totalDesired),
    total_committed_quantity: roundQuantity(totalCommitted),
    total_reserved_quantity: reservationAccounting ? roundQuantity(totalCommitted) : 0,
    total_consumed_quantity: reservationAccounting
      ? roundQuantity(toNumber(current.total_consumed_quantity, 0))
      : roundQuantity(totalCommitted),
    total_shortage_quantity: roundQuantity(totalShortage),
    lines: nextLines
  };
  const historyEntry = {
    revision,
    operation: commitment.operation,
    operation_id: effectiveOperationId,
    status,
    actor_id: actor?.id || null,
    actor_email: actor?.email || null,
    actor_name: actor?.full_name || actor?.email || null,
    reason: normalizeText(reason) || null,
    timestamp,
    movements: movements.map((movement) => ({
      direction: movement.direction,
      ingredient_id: movement.ingredient_id,
      quantity: movement.quantity,
      unit: movement.unit,
      transaction_id: movement.transaction_id
    }))
  };
  const productionPatch = {
    inventory_commitment: commitment,
    inventory_commitment_revision: revision,
    inventory_commitment_status: status,
    inventory_commitment_operation_id: effectiveOperationId,
    inventory_commitment_idempotency_key: effectiveOperationId,
    inventory_commitment_updated_at: timestamp,
    inventory_commitment_updated_by: performedBy,
    inventory_committed_at: current.committed_at || timestamp,
    inventory_committed_by: current.committed_by || performedBy,
    inventory_committed_servings: targetServings ?? production.target_servings ?? null,
    inventory_committed_lines: nextLines,
    inventory_reserved_at: reservationAccounting
      ? production.inventory_reserved_at || current.reserved_at || timestamp
      : production.inventory_reserved_at || current.reserved_at || null,
    inventory_reserved_by: reservationAccounting
      ? production.inventory_reserved_by || current.reserved_by || performedBy
      : production.inventory_reserved_by || current.reserved_by || null,
    inventory_reserved_by_name: reservationAccounting
      ? production.inventory_reserved_by_name || actor?.full_name || actor?.email || null
      : production.inventory_reserved_by_name || null,
    inventory_released_at: status === 'released'
      ? timestamp
      : production.inventory_released_at || null,
    inventory_released_by: status === 'released'
      ? performedBy
      : production.inventory_released_by || null,
    inventory_commitment_history: [
      ...(Array.isArray(production.inventory_commitment_history)
        ? production.inventory_commitment_history.slice(-99)
        : []),
      historyEntry
    ]
  };

  return {
    mutated: true,
    commitment,
    production_patch: productionPatch,
    movements
  };
}

export async function releaseProductionInventoryCommitment({
  production,
  actor = {},
  reason = '',
  operation = 'cancellation',
  ...options
}, executor) {
  return reconcileProductionInventoryCommitment({
    ...options,
    production,
    actor,
    reason,
    operation,
    desiredIngredients: [],
    allowShortage: false
  }, executor);
}

async function adjustStockWithExecutor({
  inventory_id,
  quantity_change,
  reason_code,
  notes,
  transaction_date,
  performed_by
}, executor) {
  // Inventory identity fields are immutable. Read the identity first and let
  // receive/deduct acquire locks in the single canonical order:
  // advisory item lock -> Inventory row -> Inventory lots.
  const inventory = await findDocument('Inventory', inventory_id, executor);
  if (!inventory) {
    const error = new Error('Inventory record not found');
    error.status = 404;
    throw error;
  }

  const delta = toNumber(quantity_change, 0);
  if (delta === 0) {
    const error = new Error('Adjustment quantity cannot be zero');
    error.status = 400;
    throw error;
  }

  if (delta > 0) {
    return receiveStock({
      site_id: inventory.site_id,
      site_name: inventory.site_name,
      ingredient_id: inventory.ingredient_id,
      ingredient_name: inventory.ingredient_name,
      quantity: delta,
      unit: inventory.unit,
      unit_cost: toNumber(inventory.average_unit_cost, 0),
      batch_number: `ADJ-${Date.now()}`,
      stock_date: transaction_date || toDateOnly(),
      received_date: transaction_date || toDateOnly(),
      transaction_date: transaction_date || toDateOnly(),
      min_stock_level: inventory.min_stock_level,
      max_stock_level: inventory.max_stock_level,
      valuation_method: inventory.valuation_method || 'fifo',
      reference_id: inventory.id,
      reference_type: 'adjustment',
      notes,
      performed_by,
      reason_code: reason_code || 'adjustment_positive'
    }, executor);
  }

  return deductStock({
    site_id: inventory.site_id,
    site_name: inventory.site_name,
    ingredient_id: inventory.ingredient_id,
    ingredient_name: inventory.ingredient_name,
    quantity: Math.abs(delta),
    unit: inventory.unit,
    transaction_type: 'adjustment',
    transaction_date,
    reference_id: inventory.id,
    reference_type: 'adjustment',
    notes,
    performed_by,
    valuation_method: inventory.valuation_method || 'fifo',
    reason_code: reason_code || 'adjustment_negative',
    allow_shortage: false
  }, executor);
}

async function adjustStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => adjustStockWithExecutor(payload, client)
  );
}

async function transferStockWithExecutor({
  from_site_id,
  from_site_name,
  to_site_id,
  to_site_name,
  items = [],
  transfer_date,
  reference_id,
  notes,
  performed_by
}, executor) {
  const sourceSiteId = normalizeText(from_site_id);
  const destinationSiteId = normalizeText(to_site_id);
  if (!sourceSiteId || !destinationSiteId) {
    const error = new Error('Stock transfers require both source and destination stores');
    error.status = 400;
    throw error;
  }
  if (sourceSiteId === destinationSiteId) {
    const error = new Error('Source and destination stores must be different');
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('A stock transfer requires at least one inventory item');
    error.status = 400;
    throw error;
  }
  const effectiveTransferDate = parseInventoryDate(
    transfer_date || toDateOnly(),
    'Transfer date',
    { required: true }
  );
  const results = [];

  for (const item of items) {
    const sourceInventory = (await listDocuments('Inventory', {
      filters: { site_id: from_site_id, ingredient_id: item.ingredient_id },
      limit: 10,
      lock: false
    }, executor))[0];

    if (!sourceInventory) {
      const error = new Error(`Source inventory not found for ingredient ${item.ingredient_id}`);
      error.status = 404;
      throw error;
    }
    const destinationInventory = (await listDocuments('Inventory', {
      filters: { site_id: to_site_id, ingredient_id: item.ingredient_id },
      limit: 1,
      lock: false
    }, executor))[0] || null;

    const deduction = await deductStock({
      site_id: from_site_id,
      site_name: from_site_name,
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      quantity: item.quantity,
      unit: item.unit || sourceInventory.unit,
      transaction_type: 'transfer_out',
      transaction_date: effectiveTransferDate,
      reference_id,
      reference_type: 'transfer',
      notes: notes || `Transfer to ${to_site_name}`,
      performed_by,
      valuation_method: sourceInventory.valuation_method || 'fifo',
      reason_code: 'transfer_out',
      allow_shortage: false
    }, executor);

    for (const layer of deduction.movement_layers) {
      await receiveStock({
        site_id: to_site_id,
        site_name: to_site_name,
        ingredient_id: item.ingredient_id,
        ingredient_name: item.ingredient_name,
        quantity: layer.quantity,
        unit: item.unit || sourceInventory.unit,
        unit_cost: layer.accounting_unit_cost ?? layer.unit_cost,
        batch_number: layer.batch_number || `TR-${Date.now()}`,
        expiry_date: layer.expiry_date,
        stock_date: layer.stock_date || layer.received_date || effectiveTransferDate,
        received_date: effectiveTransferDate,
        transaction_date: effectiveTransferDate,
        valuation_method: destinationInventory?.valuation_method || sourceInventory.valuation_method || 'fifo',
        reference_id,
        reference_type: 'transfer',
        notes: notes || `Transfer from ${from_site_name}`,
        performed_by,
        reason_code: 'transfer_in'
      }, executor);
    }

    results.push(deduction);
  }

  return results;
}

async function transferStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => transferStockWithExecutor(payload, client)
  );
}

async function completeProductionWithExecutor(productionId, actor, options, executor) {
  const production = await findDocument('Production', productionId, executor, true);
  if (!production) {
    const error = new Error('Production record not found');
    error.status = 404;
    throw error;
  }

  if (production.status === 'completed') {
    const producedItemBatch = (await listDocuments('ProducedItemBatch', {
      filters: { production_id: production.id },
      limit: 1
    }, executor))[0] || null;
    return { record: production, produced_item_batch: producedItemBatch, mutated: false };
  }

  if (String(production.status || '') !== 'in_progress') {
    const error = new Error('Production can only be completed after it has been approved and started');
    error.status = 400;
    throw error;
  }

  normalizeProductionMenuScope(production, { required: true, errorStatus: 409 });

  const siteCatalog = await listDocuments('Site', { limit: 5000 }, executor);
  const requestedFulfillmentStoreId = String(options?.fulfillment_store_id || '').trim();
  if (
    production.fulfillment_store_id
    && requestedFulfillmentStoreId
    && String(production.fulfillment_store_id) !== requestedFulfillmentStoreId
  ) {
    const error = new Error('The fulfillment Store cannot be changed when completing production');
    error.status = 409;
    throw error;
  }
  const fulfillmentStore = resolveProductionFulfillmentStore({
    ...production,
    fulfillment_store_id: production.fulfillment_store_id || requestedFulfillmentStoreId
  }, siteCatalog);
  const stockSiteId = fulfillmentStore.id;
  const stockSiteName = fulfillmentStore.name || production.fulfillment_store_name || production.site_name;
  const [ingredientCatalog, inventoryCatalog, recipeCatalog] = await Promise.all([
    listDocuments('Ingredient', { limit: 10000 }, executor),
    listDocuments('Inventory', {
      filters: { site_id: stockSiteId },
      limit: 10000
    }, executor),
    listDocuments('Recipe', { limit: 5000 }, executor)
  ]);
  const ingredientMap = new Map(ingredientCatalog.map((ingredient) => [String(ingredient.id), ingredient]));
  const inventoryMap = new Map(inventoryCatalog.map((item) => [String(item.ingredient_id), item]));
  const automaticPlan = buildAutomaticProductionCompletionPlan({
    production,
    recipeCatalog,
    ingredientCatalog
  });
  const completionProduction = automaticPlan.production_snapshot;
  const productionIngredients = automaticPlan.ingredients_used;

  const consumptionSummary = [];
  let totalProductionCost = 0;
  let totalShortageQuantity = 0;
  let totalShortageCost = 0;
  const shortageTotalsByUnit = {};
  const completionDemandLines = productionIngredients.map((ingredient) => {
    const ingredientData = ingredientMap.get(String(ingredient.ingredient_id));
    const sourceQuantity = toNumber(ingredient.planned_quantity ?? ingredient.raw_quantity, 0);
    const inventoryItem = inventoryMap.get(String(ingredient.ingredient_id));
    const inventoryUnit = inventoryItem?.unit || ingredientData?.unit || ingredient.unit;
    const sourceUnit = ingredient.unit || inventoryUnit;
    const conversionContext = {
      sourceUnit,
      inventoryUnit,
      ingredient: ingredientData || ingredient,
      ingredientName: ingredient.ingredient_name || ingredient.ingredient_id
    };
    const inventoryQuantity = convertProductionQuantityToInventoryUnit({
      ...conversionContext,
      quantity: sourceQuantity
    });
    const plannedInventoryQuantity = convertProductionQuantityToInventoryUnit({
      ...conversionContext,
      quantity: toNumber(ingredient.planned_quantity ?? ingredient.adjusted_quantity, sourceQuantity)
    });
    return {
      ...ingredient,
      unit: inventoryUnit,
      desired_quantity: Number(inventoryQuantity.toFixed(6)),
      planned_inventory_quantity: Number(plannedInventoryQuantity.toFixed(6))
    };
  });

  let completionCommitmentPatch = {};
  let completionCommitment = null;
  if (hasProductionInventoryCommitment(production)) {
    const reconciliation = await reconcileProductionInventoryCommitment({
      production: completionProduction,
      actor,
      desiredIngredients: completionDemandLines,
      operation: 'completion_reconciliation',
      reason: `Production consumption automatically reconciled from the frozen raw plan for ${production.recipe_name || production.id}`,
      allowShortage: true,
      expectedRevision: production.inventory_commitment_revision
        ?? production.inventory_commitment?.revision
        ?? null,
      asOfDate: toDateOnly(),
      siteCatalog,
      ingredientCatalog,
      inventoryCatalog,
      fulfillmentStore,
      targetServings: production.target_servings
    }, executor);
    completionCommitmentPatch = reconciliation.production_patch;
    completionCommitment = reconciliation.commitment;
  }
  const completionCommitmentLineMap = new Map(
    (Array.isArray(completionCommitment?.lines) ? completionCommitment.lines : [])
      .map((line) => [String(line?.ingredient_id || ''), line])
  );
  const plannedQuantityBasis = automaticPlan.quantity_basis;

  for (const ingredient of completionDemandLines) {
    const ingredientData = ingredientMap.get(String(ingredient.ingredient_id));
    const inventoryUnit = ingredient.unit;
    const inventoryQuantity = toNumber(ingredient.desired_quantity, 0);
    const plannedInventoryQuantity = toNumber(ingredient.planned_inventory_quantity, inventoryQuantity);
    const committedLine = completionCommitmentLineMap.get(String(ingredient.ingredient_id));
    const committedTransactionIds = Array.isArray(committedLine?.inventory_transaction_ids)
      ? committedLine.inventory_transaction_ids
      : [];
    const movement = committedLine ? {
      shortage_quantity: toNumber(committedLine.shortage_quantity, 0),
      requested_quantity: inventoryQuantity,
      issued_quantity: toNumber(committedLine.committed_quantity, 0),
      total_cost: toNumber(committedLine.total_cost, 0),
      transaction_id: committedTransactionIds[committedTransactionIds.length - 1] || null,
      transaction_ids: committedTransactionIds,
      movement_layers: Array.isArray(committedLine.allocation_layers)
        ? committedLine.allocation_layers
        : []
    } : inventoryQuantity > 0 ? await deductStock({
      site_id: stockSiteId,
      site_name: stockSiteName,
      ingredient_id: ingredient.ingredient_id,
      ingredient_name: ingredient.ingredient_name,
      quantity: inventoryQuantity,
      unit: inventoryUnit,
      transaction_type: 'production_use',
      transaction_date: production.production_date,
      reference_id: production.id,
      reference_type: 'production',
      notes: `Used in production: ${production.recipe_name}`,
      performed_by: actor.email,
      reason_code: 'production_consumption',
      allow_shortage: true,
      as_of_date: production.production_date,
      source: 'production_completion',
      source_type: 'production_consumption',
      operation: 'legacy_completion',
      operation_id: `production:${production.id}:legacy-completion`,
      idempotency_key: `production:${production.id}:${ingredient.ingredient_id}:legacy-completion`,
      metadata: { production_id: production.id }
    }, executor) : {
      shortage_quantity: 0,
      requested_quantity: 0,
      issued_quantity: 0,
      total_cost: 0,
      transaction_id: null,
      transaction_ids: [],
      movement_layers: []
    };

    const fallbackUnitCost = toNumber(ingredientData?.cost_per_unit, 0);
    const fallbackShortageCost = calculateIngredientCost(
      movement.shortage_quantity,
      inventoryUnit,
      ingredientData,
      fallbackUnitCost
    );
    const movementCost = toNumber(movement.total_cost, 0);

    totalProductionCost += movementCost;
    totalShortageQuantity += toNumber(movement.shortage_quantity, 0);
    shortageTotalsByUnit[inventoryUnit] = Number((
      toNumber(shortageTotalsByUnit[inventoryUnit], 0)
      + toNumber(movement.shortage_quantity, 0)
    ).toFixed(4));
    totalShortageCost += fallbackShortageCost;
    consumptionSummary.push({
      ingredient_id: ingredient.ingredient_id,
      item_code: getItemCodeFromRecords([ingredientData, ingredient], null),
      ingredient_name: ingredient.ingredient_name,
      unit: inventoryUnit,
      planned_quantity: Number(plannedInventoryQuantity.toFixed(4)),
      actual_requested_quantity: Number(inventoryQuantity.toFixed(4)),
      issued_quantity: toNumber(movement.issued_quantity, 0),
      shortage_quantity: toNumber(movement.shortage_quantity, 0),
      posted_cost: Number(movementCost.toFixed(2)),
      estimated_shortage_cost: Number(fallbackShortageCost.toFixed(2)),
      quantity_basis: plannedQuantityBasis,
      source_recipe_names: Array.isArray(ingredient.source_recipe_names) ? ingredient.source_recipe_names : [],
      yield_percent: toNumber(ingredient.yield_percent, 100),
      inventory_transaction_id: movement.transaction_id || null,
      inventory_transaction_ids: movement.transaction_ids || (
        movement.transaction_id ? [movement.transaction_id] : []
      ),
      movement_layers: movement.movement_layers || []
    });
  }

  const servings = Math.max(1, toNumber(production.target_servings, 0));
  const completedAt = nowIso();
  const dateToken = String(production.production_date || completedAt.slice(0, 10)).replace(/[^0-9]/g, '').slice(0, 8);
  const reportNumber = `PCR-${dateToken}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const reportName = `${reportNumber} · ${production.recipe_name || 'Production Consumption'}`;
  const lotLines = consumptionSummary.flatMap((line) => line.movement_layers.map((layer) => ({
    item_code: line.item_code,
    ingredient_id: line.ingredient_id,
    ingredient_name: line.ingredient_name,
    unit: line.unit,
    ...layer
  })));
  const shortageLines = consumptionSummary.filter((line) => line.shortage_quantity > 0);
  const report = await createDocument('ProductionConsumptionReport', {
    report_number: reportNumber,
    report_name: reportName,
    production_id: production.id,
    production_name: production.recipe_name || production.id,
    production_date: production.production_date || null,
    site_id: stockSiteId || null,
    site_name: stockSiteName || null,
    requesting_site_id: production.site_id || null,
    requesting_site_name: production.site_name || null,
    fulfillment_store_id: fulfillmentStore.id,
    fulfillment_store_name: fulfillmentStore.name || null,
    recipe_id: production.recipe_id || null,
    recipe_name: production.recipe_name || null,
    meal_type: production.meal_type || null,
    kitchen_station: production.kitchen_station || production.assigned_station || production.station || null,
    target_servings: production.target_servings || 0,
    completed_by: actor.email,
    completed_by_name: actor.full_name || actor.email,
    completed_at: completedAt,
    quantity_basis: plannedQuantityBasis,
    reconciliation_mode: 'automatic_yield_plan',
    output_calculation_source: automaticPlan.output_calculation_source,
    recipe_raw_weight_grams: completionProduction.recipe_raw_weight_grams,
    expected_finished_weight_grams: completionProduction.expected_finished_weight_grams,
    portion_size_grams: completionProduction.portion_size_grams,
    expected_yield_servings: completionProduction.expected_yield_servings,
    total_consumption_cost: Number(totalProductionCost.toFixed(2)),
    total_shortage_cost: Number(totalShortageCost.toFixed(2)),
    shortage_line_count: shortageLines.length,
    shortage_totals_by_unit: shortageTotalsByUnit,
    ingredient_line_count: consumptionSummary.length,
    ingredient_lines: consumptionSummary,
    sections: [
      {
        key: 'ingredient_consumption',
        title: 'Ingredient Consumption',
        lines: consumptionSummary
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
    ],
    status: 'posted'
  }, executor);

  const producedItemResult = await createProducedItemBatchForCompletion({
    production: completionProduction,
    recipe: automaticPlan.recipe,
    recipes: recipeCatalog,
    ingredients: ingredientCatalog,
    actor,
    completedAt,
    executor
  });
  const producedItemBatch = producedItemResult.batch;

  const completed = await updateDocument('Production', productionId, {
    ...completionCommitmentPatch,
    status: 'completed',
    completed_date: completedAt,
    completed_by: actor.email,
    completed_by_name: actor.full_name || actor.email,
    ingredient_cost_total: Number(totalProductionCost.toFixed(2)),
    production_cost_total: Number(totalProductionCost.toFixed(2)),
    cost_per_serving: Number((totalProductionCost / servings).toFixed(2)),
    total_shortage_quantity: Number(totalShortageQuantity.toFixed(3)),
    shortage_totals_by_unit: shortageTotalsByUnit,
    completion_lines: consumptionSummary,
    consumption_report_id: report.id,
    consumption_report_number: report.report_number,
    consumption_report_name: report.report_name,
    consumption_report_generated_at: completedAt,
    portion_size_grams: producedItemBatch.portion_size_grams,
    expected_finished_weight_grams: producedItemBatch.expected_finished_weight_grams,
    actual_finished_weight_grams: producedItemBatch.actual_finished_weight_grams,
    produced_servings: producedItemBatch.produced_servings,
    produced_item_batch_id: producedItemBatch.id,
    produced_item_batch_number: producedItemBatch.batch_number,
    reconciliation_mode: 'automatic_yield_plan',
    output_calculation_source: automaticPlan.output_calculation_source,
    fulfillment_store_id: fulfillmentStore.id,
    fulfillment_store_name: fulfillmentStore.name || null,
    last_review_action: 'production_completed',
    approval_history: [
      ...(Array.isArray(production.approval_history) ? production.approval_history : []),
      {
        action: 'production_completed',
        stage: 'production',
        from_status: String(production.status || 'in_progress').toLowerCase(),
        to_status: 'completed',
        actor_id: actor.id || null,
        actor_email: actor.email || null,
        actor_name: actor.full_name || actor.email || null,
        reason: null,
        note: null,
        timestamp: completedAt
      }
    ],
    ingredients_used: productionIngredients,
    yield_adjustment_applied: completionProduction.yield_adjustment_applied,
    yield_adjustment_version: completionProduction.yield_adjustment_version,
    yield_adjustment_updated_at: completionProduction.yield_adjustment_updated_at,
    yield_snapshot_source: completionProduction.yield_snapshot_source,
    quantity_semantics: completionProduction.quantity_semantics,
    recipe_raw_weight_grams: completionProduction.recipe_raw_weight_grams,
    portion_size_source: completionProduction.portion_size_source,
    expected_yield_servings: completionProduction.expected_yield_servings,
    production_warnings: completionProduction.production_warnings
  }, executor);

  return {
    record: completed,
    produced_item_batch: producedItemBatch,
    produced_item_batch_mutated: producedItemResult.mutated,
    mutated: true
  };
}

async function completeProduction(productionId, actor, options = {}, executor = null) {
  return runInTransaction(
    executor,
    (client) => completeProductionWithExecutor(productionId, actor, options, client)
  );
}

async function getStockOnHandReport({ location = null } = {}) {
  const inventoryPromise = (async () => {
    const records = [];
    const pageSize = 200;
    let offset = 0;
    while (true) {
      const page = await listDocumentsPage('Inventory', {
        sort: 'ingredient_name',
        limit: pageSize,
        offset,
        location
      });
      records.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total_count) break;
    }
    return records;
  })();
  const [inventory, lots] = await Promise.all([
    inventoryPromise,
    listInventoryLots({ includeEmpty: true, location })
  ]);
  const lotsByInventoryKey = new Map();
  for (const lot of lots) {
    const key = `${lot.site_id || ''}::${lot.ingredient_id || ''}`;
    if (!lotsByInventoryKey.has(key)) lotsByInventoryKey.set(key, []);
    lotsByInventoryKey.get(key).push(lot);
  }
  const reportDate = toDateOnly();
  return inventory.map((item) => {
    const itemLots = lotsByInventoryKey.get(`${item.site_id || ''}::${item.ingredient_id || ''}`) || [];
    const hasLotLedger = itemLots.length > 0;
    const onHandLots = itemLots.filter((lot) => toNumber(lot.remaining_quantity, 0) > 0);
    const usableLots = sortInventoryLotsForIssue(onHandLots);
    const availableLots = usableLots.filter(
      (lot) => getInventoryLotAvailableQuantity(lot) > QUANTITY_EPSILON
    );
    // Untouched legacy aggregates do not yet have generated lots. Preserve
    // their stored balance in reports until the next protected movement
    // performs the auditable opening-lot migration.
    const onHandQuantity = hasLotLedger
      ? onHandLots.reduce((sum, lot) => sum + toNumber(lot.remaining_quantity, 0), 0)
      : Math.max(0, toNumber(item.on_hand_quantity ?? item.quantity ?? item.available_quantity, 0));
    const usableQuantity = hasLotLedger
      ? usableLots.reduce((sum, lot) => sum + toNumber(lot.remaining_quantity, 0), 0)
      : Math.max(0, toNumber(item.usable_on_hand_quantity ?? item.on_hand_quantity ?? item.quantity, 0));
    const reservedQuantity = hasLotLedger
      ? onHandLots.reduce((sum, lot) => sum + getInventoryLotReservedQuantity(lot), 0)
      : Math.max(0, toNumber(item.reserved_quantity, 0));
    const unavailableQuantity = hasLotLedger
      ? onHandLots
        .filter((lot) => !isInventoryLotUsable(lot))
        .reduce((sum, lot) => sum + Math.max(
          0,
          toNumber(lot.remaining_quantity, 0) - getInventoryLotReservedQuantity(lot)
        ), 0)
      : Math.max(0, toNumber(item.unavailable_quantity, 0));
    const availableQuantity = hasLotLedger
      ? availableLots.reduce((sum, lot) => sum + getInventoryLotAvailableQuantity(lot), 0)
      : Math.max(0, toNumber(item.available_quantity ?? item.quantity, 0));
    const fifoValue = hasLotLedger
      ? usableLots.reduce(
        (sum, lot) => sum + (toNumber(lot.remaining_quantity, 0) * toNumber(lot.unit_cost, 0)),
        0
      )
      : Math.max(0, toNumber(item.fifo_total_value ?? item.total_value, 0));
    const weightedValue = hasLotLedger
      ? usableLots.reduce(
        (sum, lot) => sum + (
          toNumber(lot.remaining_quantity, 0)
          * toNumber(lot.accounting_unit_cost ?? lot.unit_cost, 0)
        ),
        0
      )
      : Math.max(0, toNumber(item.weighted_average_value ?? item.total_value, 0));
    const totalValue = hasLotLedger
      ? (item.valuation_method === 'weighted_average' ? weightedValue : fifoValue)
      : Math.max(0, toNumber(item.total_value, (
        item.valuation_method === 'weighted_average' ? weightedValue : fifoValue
      )));
    const nearExpiryCount = hasLotLedger
      ? onHandLots.filter((lot) => {
        const remainingDays = daysUntil(lot.expiry_date);
        return remainingDays !== null && remainingDays >= 0 && remainingDays <= 7;
      }).length
      : Math.max(0, toNumber(item.near_expiry_count, 0));
    const derivedItem = deriveInventoryRecord({
      ...item,
      quantity: roundQuantity(availableQuantity),
      available_quantity: roundQuantity(availableQuantity),
      reserved_quantity: roundQuantity(reservedQuantity),
      usable_on_hand_quantity: roundQuantity(usableQuantity),
      on_hand_quantity: roundQuantity(onHandQuantity),
      unavailable_quantity: roundQuantity(unavailableQuantity),
      total_value: Number(totalValue.toFixed(2)),
      fifo_total_value: Number(fifoValue.toFixed(2)),
      weighted_average_value: Number(weightedValue.toFixed(2)),
      average_unit_cost: usableQuantity > 0
        ? Number((totalValue / usableQuantity).toFixed(4))
        : 0,
      batch_count: hasLotLedger ? onHandLots.length : Math.max(0, toNumber(item.batch_count, 0)),
      available_batch_count: hasLotLedger
        ? availableLots.length
        : Math.max(0, toNumber(item.available_batch_count ?? item.batch_count, 0)),
      next_expiry_date: hasLotLedger
        ? availableLots.map((lot) => lot.expiry_date).filter(Boolean).sort()[0] || null
        : item.next_expiry_date || item.expiry_date || null,
      near_expiry_count: nearExpiryCount,
      expired_lot_count: hasLotLedger
        ? onHandLots.filter((lot) => (
          lot.expiry_date && toDateOnly(lot.expiry_date) < reportDate
        )).length
        : Math.max(0, toNumber(item.expired_lot_count, 0)),
      lot_ledger_pending_migration: !hasLotLedger && onHandQuantity > QUANTITY_EPSILON
    });
    return {
      ...derivedItem,
      low_stock_alert: hasLowStockAlert(derivedItem),
      overstock_alert: toNumber(derivedItem.max_stock_level, 0) > 0
        && toNumber(derivedItem.quantity, 0) >= toNumber(derivedItem.max_stock_level, 0)
    };
  });
}

async function getStockMovementReport({
  siteId = '',
  ingredientId = '',
  dateFrom = '',
  dateTo = '',
  location = null
} = {}) {
  const filters = {};
  if (siteId) filters.site_id = siteId;
  if (ingredientId) filters.ingredient_id = ingredientId;
  const transactions = [];
  const pageSize = 200;
  let offset = 0;
  while (true) {
    const page = await listDocumentsPage('InventoryTransaction', {
      filters,
      sort: '-transaction_date',
      limit: pageSize,
      offset,
      location
    });
    transactions.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total_count) break;
  }
  let filtered = transactions;
  if (dateFrom) filtered = filtered.filter((entry) => String(entry.transaction_date || '') >= dateFrom);
  if (dateTo) filtered = filtered.filter((entry) => String(entry.transaction_date || '') <= dateTo);
  return filtered;
}

async function getExpiryReport({ thresholdDays = 30, location = null } = {}) {
  const lots = await listInventoryLots({ includeEmpty: false, location });
  return lots.map((lot) => {
    const remainingDays = daysUntil(lot.expiry_date);
    return {
      ...lot,
      days_until_expiry: remainingDays,
      expiry_status: remainingDays === null
        ? 'no_expiry'
        : remainingDays < 0
          ? 'expired'
          : remainingDays <= thresholdDays
            ? 'near_expiry'
            : 'fresh'
    };
  }).filter((lot) => lot.expiry_status !== 'fresh' || thresholdDays >= 365)
    .sort((left, right) => (left.days_until_expiry ?? 9999) - (right.days_until_expiry ?? 9999));
}

async function getVelocityReports({ days = 30, location = null } = {}) {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - Math.max(1, Number(days || 30)));
  const movements = await getStockMovementReport({ dateFrom: toDateOnly(dateFrom), location });
  const consumptionTypes = new Set([
    'production_use',
    'production_commitment',
    'pos_sale',
    'issuance',
    'transfer_out',
    'waste',
    'adjustment'
  ]);
  const returnTypes = new Set(['production_return', 'production_release']);
  const map = new Map();

  movements.forEach((movement) => {
    const quantity = toNumber(movement.quantity, 0);
    const isConsumption = consumptionTypes.has(movement.transaction_type) && quantity < 0;
    const isReturn = returnTypes.has(movement.transaction_type) && quantity > 0;
    if (!isConsumption && !isReturn) return;
    const key = `${movement.site_id || ''}::${movement.ingredient_id || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        site_id: movement.site_id || '',
        site_name: movement.site_name || '',
        ingredient_id: movement.ingredient_id || '',
        ingredient_name: movement.ingredient_name || '',
        total_moved: 0,
        movement_count: 0
      });
    }
    const item = map.get(key);
    item.total_moved += isReturn ? -Math.abs(quantity) : Math.abs(quantity);
    item.movement_count += 1;
  });

  const ranked = Array.from(map.values())
    .map((item) => ({ ...item, total_moved: Math.max(0, roundQuantity(item.total_moved)) }))
    .sort((left, right) => right.total_moved - left.total_moved);
  return {
    fast_moving: ranked.slice(0, 25),
    slow_moving: [...ranked].reverse().slice(0, 25)
  };
}

async function getInventoryValuationReport({ siteId = '', ingredientId = '', location = null } = {}) {
  const inventory = (await getStockOnHandReport({ location })).filter((item) => (
    (!siteId || String(item.site_id || '') === String(siteId))
    && (!ingredientId || String(item.ingredient_id || '') === String(ingredientId))
  ));
  return inventory.map((item) => {
    const valuationQuantity = toNumber(
      item.usable_on_hand_quantity ?? item.on_hand_quantity ?? item.quantity,
      0
    );
    const weightedValue = toNumber(
      item.weighted_average_value,
      valuationQuantity * toNumber(item.average_unit_cost, 0)
    );
    const fifoValue = toNumber(item.fifo_total_value, item.total_value ?? weightedValue);
    return {
      ...item,
      valuation_quantity: roundQuantity(valuationQuantity),
      fifo_value: Number(fifoValue.toFixed(2)),
      weighted_average_value: Number(weightedValue.toFixed(2))
    };
  });
}

export {
  toDateOnly,
  parseInventoryDate,
  validateInventorySettings,
  listInventoryLots,
  getAvailableLotQuantity,
  assertSufficientStock,
  ensureInventoryRecord,
  recalculateInventoryRecord,
  receiveStock,
  deductStock,
  adjustStock,
  transferStock,
  completeProduction,
  getStockOnHandReport,
  getStockMovementReport,
  getExpiryReport,
  getVelocityReports,
  getInventoryValuationReport
};
