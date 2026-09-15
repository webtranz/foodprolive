import crypto from 'node:crypto';

import {
  createDocument,
  acquireMealServiceScopeLock,
  findDocument,
  listDocuments,
  updateDocument,
  withTransaction
} from './db.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { buildAutomaticProductionYieldSummary } from '../shared/productionReconciliation.js';
import { toBusinessDateOnly } from '../shared/businessDate.js';
import {
  normalizeMenuCategory,
  normalizeMenuCuisine,
  normalizeProductionMenuScope
} from '../shared/menuCategories.js';
import {
  formatProductionEventTitle,
  getProductionEventItemCount
} from '../shared/productionLabels.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../shared/siteHierarchy.js';

const QUANTITY_EPSILON = 0.0000005;
const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);
const PRODUCTION_MEAL_TYPES = new Set([...MEAL_TYPES, 'snack']);
const AVAILABLE_BATCH_STATUSES = new Set(['available', 'partial']);
const SERVICEABLE_MENU_PLAN_STATUSES = new Set(['planned', 'active', 'approved']);
const PRODUCED_ITEM_CUTOVER_VERSION = 1;
const MEAL_SERVICE_REPORT_PAGE_SIZE = 1000;
const MAX_MANUAL_PORTION_SIZE_GRAMS = 100000;

function nowIso() {
  return new Date().toISOString();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundQuantity(value) {
  return Number(number(value, 0).toFixed(6));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeMealServiceDate(value, label = 'Service date') {
  const normalized = toBusinessDateOnly(value);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw httpError(`${label} must be a valid date`);
  }
  return normalized;
}

export function normalizeMealServiceType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!MEAL_TYPES.has(normalized)) {
    throw httpError('Meal type must be breakfast, lunch, or dinner');
  }
  return normalized;
}

export function normalizeMealServiceMenuType(value) {
  const normalized = normalizeMenuCuisine(value, '');
  if (!normalized) {
    throw httpError('Menu type must be General or Philippines');
  }
  return normalized;
}

export function normalizeMealServiceMenuCategory(value, menuType = 'general') {
  const normalizedMenuType = normalizeMealServiceMenuType(menuType);
  const normalized = normalizeMenuCategory(value, '');
  if (!normalized) {
    throw httpError('Menu category must be Senior, Junior, Labor, or Management Menu');
  }
  if (normalizedMenuType === 'philippines' && normalized === 'management_menu') {
    throw httpError('Management Menu is not available for the Philippines menu type');
  }
  return normalized;
}

export function normalizeProducedItemMealType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!PRODUCTION_MEAL_TYPES.has(normalized)) {
    throw httpError('Production meal type must be breakfast, lunch, dinner, or snack');
  }
  return normalized;
}

export function normalizeMealServiceAttendeeCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw httpError('Arrivals Count must be a whole number from 1 to 500');
  }
  return parsed;
}

function normalizeServingsPerAttendee(value) {
  const parsed = value === null || typeof value === 'undefined' || value === '' ? 1 : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 20) {
    throw httpError('Servings per attendee must be greater than zero and no more than 20');
  }
  return roundQuantity(parsed);
}

export function normalizeManualMealPortionSize(value) {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || parsed <= 0
    || parsed > MAX_MANUAL_PORTION_SIZE_GRAMS
  ) {
    throw httpError(`Prepared-meal portion size must be greater than zero and no more than ${MAX_MANUAL_PORTION_SIZE_GRAMS} grams`);
  }
  return roundQuantity(parsed);
}

function buildLedgerIdempotencyKey(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(stableJson(parts)).digest('hex');
  return `${prefix}_${digest}`;
}

export function buildMealServiceScopeKey({ site_id, service_date, meal_type, menu_type, menu_category } = {}) {
  const menuType = normalizeMealServiceMenuType(menu_type);
  return [
    normalizeText(site_id),
    normalizeMealServiceDate(service_date),
    normalizeMealServiceType(meal_type),
    menuType,
    normalizeMealServiceMenuCategory(menu_category, menuType)
  ].join('::');
}

export function buildMealServiceAvailabilitySnapshot(scope = {}, batches = []) {
  const scopeKey = buildMealServiceScopeKey(scope);
  const state = (Array.isArray(batches) ? batches : []).map((batch) => ({
    id: normalizeText(batch.id),
    recipe_id: normalizeText(batch.recipe_id),
    batch_number: normalizeText(batch.batch_number),
    completed_at: normalizeText(batch.completed_at),
    status: normalizeText(batch.status).toLowerCase(),
    produced_servings: roundQuantity(batch.produced_servings),
    produced_weight_grams: roundQuantity(batch.produced_weight_grams),
    served_servings: roundQuantity(batch.served_servings),
    served_weight_grams: roundQuantity(batch.served_weight_grams),
    wasted_servings: roundQuantity(batch.wasted_servings),
    wasted_weight_grams: roundQuantity(batch.wasted_weight_grams),
    remaining_servings: roundQuantity(batch.remaining_servings),
    remaining_weight_grams: roundQuantity(batch.remaining_weight_grams),
    service_portion_size_grams: getStoredServicePortionSize(batch)
  })).sort((left, right) => left.id.localeCompare(right.id));
  return crypto.createHash('sha256').update(stableJson({ scope_key: scopeKey, batches: state })).digest('hex');
}

export function normalizeMealServiceDishCovers(dishes = []) {
  if (!Array.isArray(dishes) || dishes.length === 0) throw httpError('Enter covers for every prepared dish');
  const byRecipe = new Map();
  for (const dish of dishes) {
    const recipeId = normalizeText(dish?.recipe_id);
    const covers = Number(dish?.covers);
    if (!recipeId) throw httpError('Every prepared dish must include its dish identifier');
    if (byRecipe.has(recipeId)) throw httpError('Each prepared dish may be entered only once');
    if (!Number.isInteger(covers) || covers < 0 || covers > 1000000) {
      throw httpError('Dish covers must be a whole number from 0 to 1,000,000');
    }
    byRecipe.set(recipeId, { recipe_id: recipeId, covers });
  }
  if (![...byRecipe.values()].some((dish) => dish.covers > 0)) {
    throw httpError('Enter at least one cover before saving Meal Service');
  }
  return [...byRecipe.values()];
}

function isRoutineMealServiceBatch(batch = {}) {
  const sourceType = normalizeText(batch.source_type).toLowerCase();
  return !normalizeText(batch.source_event_id)
    && !['special_event', 'event', 'auto_schedule_unlinked'].includes(sourceType);
}

function getStoredServicePortionSize(batch = {}) {
  const value = number(batch.service_portion_size_grams, 0);
  return value > 0 ? normalizeManualMealPortionSize(value) : null;
}

function normalizeProducedItemBatchIds(payload = {}) {
  const values = [
    ...(Array.isArray(payload.produced_item_batch_ids) ? payload.produced_item_batch_ids : []),
    payload.produced_item_batch_id,
    payload.production_batch_id,
    payload.prepared_meal_id
  ];
  return uniqueNormalizedTexts(values);
}

function canUpdateMealServicePortionSize(batch = {}) {
  return normalizeText(batch.status).toLowerCase() === 'available'
    && number(batch.served_weight_grams, 0) <= QUANTITY_EPSILON
    && number(batch.wasted_weight_grams, 0) <= QUANTITY_EPSILON;
}

export function selectMealServicePortionSizeUpdateBatches(batches = [], requestedBatchIds = []) {
  const routineBatches = (Array.isArray(batches) ? batches : []).filter((batch) => isRoutineMealServiceBatch(batch));
  const requestedIds = new Set(uniqueNormalizedTexts(requestedBatchIds));
  const selectedBatches = requestedIds.size
    ? routineBatches.filter((batch) => requestedIds.has(normalizeText(batch.id)))
    : routineBatches.filter(canUpdateMealServicePortionSize);

  if (requestedIds.size && selectedBatches.length !== requestedIds.size) {
    throw httpError('Prepared output changed after it was loaded. Refresh fully produced dishes before saving the portion size.', 409);
  }
  if (routineBatches.length === 0 || selectedBatches.length === 0) {
    throw httpError('No matching completed production output was found', 404);
  }
  if (selectedBatches.some((batch) => !canUpdateMealServicePortionSize(batch))) {
    throw httpError('Service portion size cannot be changed after any output has been served or wasted', 409);
  }
  return selectedBatches;
}

export function groupMealServiceProducedDishes(batches = []) {
  const grouped = new Map();
  batches.filter((batch) => (
    isRoutineMealServiceBatch(batch)
    && AVAILABLE_BATCH_STATUSES.has(normalizeText(batch.status).toLowerCase())
    && getBatchAvailableWeight(batch) > QUANTITY_EPSILON
    && number(batch.portion_size_grams, 0) > 0
  )).sort(compareBatchFifo).forEach((batch) => {
    const recipeId = normalizeText(batch.recipe_id);
    if (!recipeId) return;
    const productionName = formatProductionEventTitle(batch, {
      fallback: batch.production_name || batch.recipe_name || recipeId
    });
    if (!grouped.has(recipeId)) {
      grouped.set(recipeId, {
        recipe_id: recipeId,
        recipe_name: productionName,
        meal_type: batch.meal_type || null,
        menu_type: batch.menu_type || null,
        menu_category: batch.menu_category || null,
        service_portion_size_grams: getStoredServicePortionSize(batch),
        portion_configured: Boolean(getStoredServicePortionSize(batch)),
        produced_servings: 0,
        produced_weight_grams: 0,
        served_servings: 0,
        served_weight_grams: 0,
        wasted_servings: 0,
        wasted_weight_grams: 0,
        available_weight_grams: 0,
        available_covers: 0,
        batch_count: 0,
        production_names: new Set(),
        consumption_report_ids: new Set(),
        batches: []
      });
    }
    const row = grouped.get(recipeId);
    row.production_names.add(productionName);
    if (normalizeText(batch.consumption_report_id)) {
      row.consumption_report_ids.add(normalizeText(batch.consumption_report_id));
    }
    const explicitSize = getStoredServicePortionSize(batch);
    if (!explicitSize) row.portion_configured = false;
    if (explicitSize && row.service_portion_size_grams
      && Math.abs(explicitSize - row.service_portion_size_grams) > QUANTITY_EPSILON) {
      throw httpError(`Prepared dish ${row.recipe_name} has conflicting service portion sizes`, 409);
    }
    if (explicitSize && !row.service_portion_size_grams) row.service_portion_size_grams = explicitSize;
    row.produced_servings = roundQuantity(row.produced_servings + number(batch.produced_servings, 0));
    row.produced_weight_grams = roundQuantity(row.produced_weight_grams + number(batch.produced_weight_grams, 0));
    row.served_servings = roundQuantity(row.served_servings + number(batch.served_servings, 0));
    row.served_weight_grams = roundQuantity(row.served_weight_grams + number(batch.served_weight_grams, 0));
    row.wasted_servings = roundQuantity(row.wasted_servings + number(batch.wasted_servings, 0));
    row.wasted_weight_grams = roundQuantity(row.wasted_weight_grams + number(batch.wasted_weight_grams, 0));
    row.available_weight_grams = roundQuantity(row.available_weight_grams + getBatchAvailableWeight(batch));
    row.batch_count += 1;
    row.batches.push({
      id: batch.id,
      batch_number: batch.batch_number,
      production_id: batch.production_id,
      production_name: productionName,
      consumption_report_id: batch.consumption_report_id || null,
      consumption_report_number: batch.consumption_report_number || null,
      completed_at: batch.completed_at,
      remaining_weight_grams: batch.remaining_weight_grams
    });
  });
  return [...grouped.values()].map((row) => ({
    ...row,
    production_names: [...row.production_names],
    consumption_report_ids: [...row.consumption_report_ids],
    service_portion_size_grams: row.portion_configured ? row.service_portion_size_grams : null,
    available_covers: row.portion_configured
      ? Math.floor((row.available_weight_grams + QUANTITY_EPSILON) / row.service_portion_size_grams)
      : null
  })).sort((left, right) => left.recipe_name.localeCompare(right.recipe_name));
}

async function resolveProjectServiceSite(siteId, executor) {
  const normalizedSiteId = normalizeText(siteId);
  if (!normalizedSiteId) throw httpError('Select a Project for Meal Service');
  const site = await findDocument('Site', normalizedSiteId, executor || undefined);
  if (!site || site.is_active === false) {
    throw httpError('The selected Meal Service Project does not exist or is inactive', 404);
  }
  if (normalizeSiteType(site.type) !== SITE_HIERARCHY_TYPES.PROJECT) {
    throw httpError('Meal Service must be recorded against a Project in the Area -> Project -> Store hierarchy', 409);
  }
  return site;
}

function uniqueNormalizedTexts(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [...values || []])
    .map(normalizeText)
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function locationAccessibleSiteIds(location = null) {
  if (!location?.accessibleSiteIds) return [];
  if (Array.isArray(location.accessibleSiteIds)) return location.accessibleSiteIds;
  if (typeof location.accessibleSiteIds[Symbol.iterator] === 'function') {
    return [...location.accessibleSiteIds];
  }
  return [location.accessibleSiteIds];
}

function extendLocationWithMealServiceProductionSites(location = null, siteIds = []) {
  if (!location || location.unrestricted) return location;
  return {
    ...location,
    accessibleSiteIds: uniqueNormalizedTexts([
      ...locationAccessibleSiteIds(location),
      ...siteIds
    ])
  };
}

async function resolveMealServiceProductionScope(siteId, executor, location = null) {
  const serviceSite = await resolveProjectServiceSite(siteId, executor);
  // Meal Service is intentionally recorded at Project level, while production
  // output can be posted to the Project's Store. Once the Project is approved
  // for the user, include its direct active Stores for produced-item lookup.
  const childSites = await listDocuments('Site', {
    filters: { parent_site_id: serviceSite.id },
    sort: 'name',
    limit: 10000
  }, executor || undefined);
  const productionSiteIds = uniqueNormalizedTexts([
    serviceSite.id,
    ...childSites
      .filter((site) => (
        site?.is_active !== false
        && normalizeSiteType(site?.type) === SITE_HIERARCHY_TYPES.STORE
      ))
      .map((site) => site.id)
  ]);
  return {
    serviceSite,
    productionSiteIds,
    productionLocation: extendLocationWithMealServiceProductionSites(location, productionSiteIds)
  };
}

async function listMealServiceProducedItemBatchesForSites({
  siteIds = [],
  serviceDate,
  mealType,
  menuType = null,
  menuCategory = null,
  recipeId = '',
  sort = 'completed_at',
  limit = 10000,
  lock = false,
  location = null,
  executor = null
} = {}) {
  const rows = [];
  const seen = new Set();
  for (const productionSiteId of uniqueNormalizedTexts(siteIds)) {
    const page = await listDocuments('ProducedItemBatch', {
      filters: {
        site_id: productionSiteId,
        production_date: serviceDate,
        meal_type: mealType,
        ...(menuType ? { menu_type: menuType } : {}),
        ...(menuCategory ? { menu_category: menuCategory } : {}),
        ...(recipeId ? { recipe_id: recipeId } : {})
      },
      sort,
      limit,
      lock,
      location
    }, executor || undefined);
    for (const row of page) {
      const id = normalizeText(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  return rows.sort(compareBatchFifo);
}

async function listMealServiceCompletedProductionsForSites({
  siteIds = [],
  serviceDate,
  mealType,
  menuType = null,
  menuCategory = null,
  lock = false,
  location = null,
  executor = null
} = {}) {
  const rows = [];
  const seen = new Set();
  for (const productionSiteId of uniqueNormalizedTexts(siteIds)) {
    const page = await listDocuments('Production', {
      filters: {
        site_id: productionSiteId,
        production_date: serviceDate,
        meal_type: mealType,
        ...(menuType ? { menu_type: menuType } : {}),
        ...(menuCategory ? { menu_category: menuCategory } : {}),
        status: 'completed'
      },
      sort: 'completed_date',
      limit: 10000,
      lock,
      location
    }, executor || undefined);
    for (const row of page) {
      const id = normalizeText(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  return rows;
}

function compareBatchFifo(left, right) {
  const leftTime = normalizeText(left.completed_at || left.production_completed_at || left.created_date);
  const rightTime = normalizeText(right.completed_at || right.production_completed_at || right.created_date);
  const byTime = leftTime.localeCompare(rightTime);
  return byTime || normalizeText(left.id).localeCompare(normalizeText(right.id));
}

function isRecipeAvailableForSite(recipe, siteId, sites = []) {
  if (!recipe || recipe.is_active === false) return false;
  const scopedIds = [recipe.site_id, ...(Array.isArray(recipe.site_ids) ? recipe.site_ids : [])]
    .filter(Boolean)
    .map(String);
  if (
    scopedIds.length === 0
    && String(recipe.site_scope || 'global').toLowerCase() === 'global'
  ) {
    return true;
  }

  const byId = new Map(sites.map((site) => [String(site.id), site]));
  const ancestors = (rootId) => {
    const values = new Set();
    let cursor = byId.get(String(rootId));
    while (cursor && !values.has(String(cursor.id))) {
      values.add(String(cursor.id));
      cursor = cursor.parent_site_id ? byId.get(String(cursor.parent_site_id)) : null;
    }
    return values;
  };
  const serviceAncestors = ancestors(siteId);
  return scopedIds.some((recipeSiteId) => (
    serviceAncestors.has(recipeSiteId)
    || ancestors(recipeSiteId).has(String(siteId))
  ));
}

function getPreparedMealIdentifier(selection = {}) {
  return normalizeText(
    selection.produced_item_batch_id
      || selection.production_batch_id
      || selection.prepared_meal_id
  );
}

export function normalizePreparedMealSelections(selections = []) {
  if (!Array.isArray(selections)) {
    throw httpError('Prepared meals must be provided as a list');
  }
  const byPreparedMeal = new Map();
  for (const selection of selections) {
    if (normalizeText(selection?.recipe_id)) {
      throw httpError('Prepared meals must be selected by produced-item batch; recipe identifiers are resolved by the server');
    }
    const preparedMealId = getPreparedMealIdentifier(selection);
    if (!preparedMealId) {
      throw httpError('Every prepared meal must include its prepared meal identifier');
    }
    if (byPreparedMeal.has(preparedMealId)) {
      throw httpError('Each prepared meal may be entered only once for a customer meal service');
    }
    byPreparedMeal.set(preparedMealId, {
      produced_item_batch_id: preparedMealId,
      portion_size_grams: normalizeManualMealPortionSize(selection?.portion_size_grams),
      portions_per_attendee: normalizeServingsPerAttendee(
        selection?.portions_per_attendee ?? selection?.servings_per_attendee
      )
    });
  }
  if (byPreparedMeal.size === 0) {
    throw httpError('Enter a portion size for every prepared meal');
  }
  if (byPreparedMeal.size > 100) {
    throw httpError('A meal-service entry cannot contain more than 100 prepared meals');
  }
  return [...byPreparedMeal.values()];
}

function getMenuPlanMealLines(plan = {}, mealType) {
  const normalizedMealType = normalizeMealServiceType(mealType);
  const meals = Array.isArray(plan.meals) ? plan.meals : [];
  return meals.filter((meal) => (
    normalizeText(meal?.meal_type).toLowerCase() === normalizedMealType
    && normalizeText(meal?.recipe_id)
  ));
}

function getDistinctMenuPlanMealLines(plan = {}, mealType) {
  const byRecipe = new Map();
  for (const meal of getMenuPlanMealLines(plan, mealType)) {
    const recipeId = normalizeText(meal.recipe_id);
    // A menu may legitimately repeat a recipe line. Produced output is pooled
    // by recipe, so retain the first line deterministically for linkage/audit.
    if (!byRecipe.has(recipeId)) byRecipe.set(recipeId, meal);
  }
  return [...byRecipe.values()];
}

export function resolveLegacyProductionMenuClassification(production = {}, plan = {}) {
  const status = normalizeText(production.status).toLowerCase();
  const repairableStatuses = new Set([
    'pending_approval', 'pending_procurement', 'pending_production', 'approved', 'in_progress'
  ]);
  if (!repairableStatuses.has(status)) {
    throw httpError('Only legacy production already beyond editable planning can use menu-classification repair', 409);
  }
  if (normalizeText(production.menu_type) || normalizeText(production.menu_category)) {
    throw httpError('Production already has menu classification', 409);
  }
  if (normalizeText(production.source_event_id)
    || ['special_event', 'event', 'auto_schedule_unlinked'].includes(normalizeText(production.source_type).toLowerCase())) {
    throw httpError('Event or unlinked automated production cannot use legacy menu-classification repair', 409);
  }
  if (!normalizeText(plan.id)
    || normalizeText(plan.site_id) !== normalizeText(production.site_id)
    || normalizeMealServiceDate(plan.plan_date) !== normalizeMealServiceDate(production.production_date)) {
    throw httpError('The selected menu plan does not exactly match the production project and date', 409);
  }
  if (!SERVICEABLE_MENU_PLAN_STATUSES.has(normalizeText(plan.status || 'planned').toLowerCase())
    || !isOperationalMenuPlan(plan)) {
    throw httpError('The selected menu plan is not an active operational menu', 409);
  }
  const mealType = normalizeMealServiceType(production.meal_type);
  if (!getMenuPlanMealLines(plan, mealType).some((line) => (
    normalizeText(line.recipe_id) === normalizeText(production.recipe_id)
  ))) {
    throw httpError('The selected menu plan does not contain this production recipe in the same meal period', 409);
  }
  const rawMenuType = normalizeText(plan.cuisine_type || plan.menu_type);
  const rawMenuCategory = normalizeText(plan.menu_category);
  if (!rawMenuType || !rawMenuCategory) {
    throw httpError('The selected menu plan has no explicit menu type and category', 409);
  }
  const menuType = normalizeMealServiceMenuType(rawMenuType);
  return {
    menu_plan_id: normalizeText(plan.id),
    menu_type: menuType,
    menu_category: normalizeMealServiceMenuCategory(rawMenuCategory, menuType)
  };
}

export function resolveMenuPlanPreparedMealSelections(
  plan = {},
  mealType,
  preparedMeals = [],
  batches = []
) {
  const menuLines = getDistinctMenuPlanMealLines(plan, mealType);
  if (menuLines.length === 0) {
    throw httpError(`The selected menu category and type have no prepared meals for ${normalizeMealServiceType(mealType)}`, 409);
  }
  const menuLineByRecipe = new Map();
  for (const meal of menuLines) menuLineByRecipe.set(normalizeText(meal.recipe_id), meal);

  const batchById = new Map(batches.map((batch) => [String(batch.id), batch]));
  const preparedSelections = normalizePreparedMealSelections(preparedMeals);
  const resolvedByRecipe = new Map();
  for (const prepared of preparedSelections) {
    const batch = batchById.get(prepared.produced_item_batch_id);
    if (!batch) {
      throw httpError('A selected prepared-meal batch is no longer available for this menu', 409);
    }
    if (
      !AVAILABLE_BATCH_STATUSES.has(String(batch.status || '').toLowerCase())
      || getBatchAvailableWeight(batch) <= QUANTITY_EPSILON
      || getBatchAvailableServings(batch) <= QUANTITY_EPSILON
    ) {
      throw httpError('A selected prepared-meal batch is no longer available for service', 409);
    }
    const recipeId = normalizeText(batch.recipe_id);
    const menuLine = menuLineByRecipe.get(recipeId);
    if (!menuLine) {
      throw httpError('A prepared meal does not belong to the selected menu category, menu type, and meal period', 409);
    }
    if (resolvedByRecipe.has(recipeId)) {
      throw httpError('Enter each prepared meal only once, even when it has multiple production batches', 409);
    }
    resolvedByRecipe.set(recipeId, {
      ...prepared,
      recipe_id: recipeId,
      recipe_name: normalizeText(batch.recipe_name || menuLine.recipe_name) || recipeId,
      meal_plan_line_id: menuLine.id || menuLine.line_id || null,
      servings_per_attendee: prepared.portions_per_attendee,
      portion_size_source: 'meal_service_manual'
    });
  }

  return [...resolvedByRecipe.values()];
}

export function buildMealServiceRequestFingerprint(payload = {}) {
  const menuType = normalizeMealServiceMenuType(
    payload.menu_type || payload.cuisine_type || payload.menu_cuisine
  );
  const menuCategory = normalizeMealServiceMenuCategory(payload.menu_category, menuType);
  const dishes = normalizeMealServiceDishCovers(payload.dishes)
    .sort((left, right) => left.recipe_id.localeCompare(right.recipe_id));
  const canonical = {
    site_id: normalizeText(payload.site_id),
    service_date: normalizeMealServiceDate(payload.service_date || payload.plan_date),
    meal_type: normalizeMealServiceType(payload.meal_type),
    menu_type: menuType,
    menu_category: menuCategory,
    scope_key: buildMealServiceScopeKey({
      site_id: payload.site_id,
      service_date: payload.service_date || payload.plan_date,
      meal_type: payload.meal_type,
      menu_type: menuType,
      menu_category: menuCategory
    }),
    notes: normalizeText(payload.notes) || null,
    availability_snapshot: normalizeText(payload.availability_snapshot),
    dishes
  };
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

export function buildMealServiceReversalFingerprint(attendanceId, payload = {}) {
  return crypto.createHash('sha256').update(stableJson({
    attendance_id: normalizeText(attendanceId),
    reason: normalizeText(payload.reason)
  })).digest('hex');
}

export function assertMealServiceIdempotencyMatch(existing = {}, requestFingerprint) {
  if (!existing.request_fingerprint || existing.request_fingerprint !== requestFingerprint) {
    throw httpError('This idempotency key was already used for different Meal Service details', 409);
  }
  return true;
}

function getBatchAvailableServings(batch = {}) {
  const portionSize = number(batch.portion_size_grams, 0);
  return portionSize > 0
    ? roundQuantity(Math.max(0, number(batch.remaining_weight_grams, 0)) / portionSize)
    : 0;
}

function getBatchAvailableWeight(batch = {}) {
  return roundQuantity(Math.max(0, number(batch.remaining_weight_grams, 0)));
}

function productionFinishedWeight(production = {}, recipe = {}, recipes = [], ingredients = []) {
  const directWeight = number(
    production.actual_finished_weight_grams
      ?? production.produced_weight_grams
      ?? production.expected_finished_weight_grams,
    0
  );
  if (directWeight > 0) return roundQuantity(directWeight);

  const portionSize = number(
    production.portion_size_grams
      ?? recipe.portion_size_grams
      ?? calculateRecipeServingWeight(recipe, recipes, ingredients).grams_per_serving,
    0
  );
  const servings = number(
    production.produced_servings
      ?? production.actual_servings
      ?? production.target_servings,
    0
  );
  return portionSize > 0 && servings > 0 ? roundQuantity(portionSize * servings) : 0;
}

export async function backfillProducedItemBatchesForCompletedProductions({
  siteId,
  productionSiteIds = null,
  serviceDate,
  mealType,
  menuType = null,
  menuCategory = null,
  batches = [],
  executor = null,
  location = null,
  lock = false
} = {}) {
  const resolvedProductionSiteIds = uniqueNormalizedTexts(
    Array.isArray(productionSiteIds) && productionSiteIds.length
      ? productionSiteIds
      : [siteId]
  );
  const existingProductionIds = new Set(
    batches.map((batch) => normalizeText(batch.production_id)).filter(Boolean)
  );
  const completedProductions = await listMealServiceCompletedProductionsForSites({
    siteIds: resolvedProductionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    lock,
    location,
    executor
  });
  const missingProductions = completedProductions.filter((production) => (
    normalizeText(production.id)
    && normalizeText(production.recipe_id)
    && !existingProductionIds.has(normalizeText(production.id))
  ));
  if (missingProductions.length === 0) return batches;

  const [recipeCatalog, ingredientCatalog] = await Promise.all([
    listDocuments('Recipe', { limit: 10000, location }, executor || undefined),
    listDocuments('Ingredient', { limit: 10000, location }, executor || undefined)
  ]);
  const recipeMap = new Map(recipeCatalog.map((recipe) => [String(recipe.id), recipe]));

  for (const production of missingProductions) {
    const recipe = recipeMap.get(String(production.recipe_id));
    if (!recipe) continue;
    const actualFinishedWeightGrams = productionFinishedWeight(
      production,
      recipe,
      recipeCatalog,
      ingredientCatalog
    );
    if (actualFinishedWeightGrams <= 0) continue;
    try {
      const snapshot = buildProducedItemBatchSnapshot({
        production,
        recipe,
        recipes: recipeCatalog,
        ingredients: ingredientCatalog,
        actualFinishedWeightGrams,
        completedAt: production.completed_date || production.completed_at || nowIso(),
        actor: {
          email: production.completed_by,
          full_name: production.completed_by_name || production.completed_by
        }
      });
      await createDocument('ProducedItemBatch', snapshot, executor || undefined);
    } catch (error) {
      if (error?.code !== '23505') {
        // A single legacy production with incomplete yield data should not hide
        // other completed dishes that can be served from Staff Scheduling.
        continue;
      }
    }
  }

  return listMealServiceProducedItemBatchesForSites({
    siteIds: resolvedProductionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    lock,
    location,
    executor
  });
}

export function resolveMealServicePortionSize(recipe = {}, firstBatch = null) {
  const batchPortion = number(firstBatch?.portion_size_grams, 0);
  if (batchPortion > 0) return roundQuantity(batchPortion);
  const explicitPortion = number(recipe.portion_size_grams, 0);
  if (explicitPortion > 0) return roundQuantity(explicitPortion);
  const persistedPerServing = number(
    recipe.grams_per_serving ?? recipe.yielded_grams_per_serving,
    0
  );
  if (persistedPerServing > 0) return roundQuantity(persistedPerServing);
  const totalYieldedWeight = number(
    recipe.total_recipe_weight_grams
      ?? recipe.cooked_total_grams
      ?? recipe.expected_finished_weight_grams,
    0
  );
  const servings = number(recipe.servings, 0);
  return totalYieldedWeight > 0 && servings > 0
    ? roundQuantity(totalYieldedWeight / servings)
    : 0;
}

export function buildMealServiceDemand({
  attendeeCount,
  selections = [],
  recipes = [],
  batches = []
} = {}) {
  const count = normalizeMealServiceAttendeeCount(attendeeCount);
  if (!Array.isArray(selections) || selections.length === 0) {
    throw httpError('Select at least one prepared meal and enter its portion size');
  }
  const normalizedSelections = selections.map((selection) => ({
    ...selection,
    recipe_id: normalizeText(selection?.recipe_id),
    portion_size_grams: normalizeManualMealPortionSize(selection?.portion_size_grams),
    servings_per_attendee: normalizeServingsPerAttendee(
      selection?.portions_per_attendee ?? selection?.servings_per_attendee
    ),
    portion_size_source: 'meal_service_manual'
  }));
  if (normalizedSelections.some((selection) => !selection.recipe_id)) {
    throw httpError('Prepared meal production could not be resolved to its menu line', 409);
  }
  if (new Set(normalizedSelections.map((selection) => selection.recipe_id)).size !== normalizedSelections.length) {
    throw httpError('Each prepared meal may be entered only once for a customer meal service');
  }
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe.id), recipe]));
  const allBatchesByRecipe = new Map();
  [...batches].sort(compareBatchFifo).forEach((batch) => {
    const recipeId = String(batch.recipe_id || '');
    if (!allBatchesByRecipe.has(recipeId)) allBatchesByRecipe.set(recipeId, []);
    allBatchesByRecipe.get(recipeId).push(batch);
  });
  const batchesByRecipe = new Map();
  batches
    .filter((batch) => AVAILABLE_BATCH_STATUSES.has(String(batch.status || '').toLowerCase()))
    .sort(compareBatchFifo)
    .forEach((batch) => {
      const recipeId = String(batch.recipe_id || '');
      if (!batchesByRecipe.has(recipeId)) batchesByRecipe.set(recipeId, []);
      batchesByRecipe.get(recipeId).push(batch);
    });

  const demandItems = normalizedSelections.map((selection) => {
    const recipe = recipeMap.get(selection.recipe_id);
    if (!recipe) throw httpError(`Recipe ${selection.recipe_id} was not found`, 404);
    const recipeBatches = batchesByRecipe.get(selection.recipe_id) || [];
    const allRecipeBatches = allBatchesByRecipe.get(selection.recipe_id) || [];
    const firstBatch = recipeBatches[0] || allRecipeBatches[0] || null;
    const portionSize = selection.portion_size_grams;
    if (portionSize <= 0) {
      throw httpError(`Enter a valid portion size for ${recipe.name || selection.recipe_id}`, 409);
    }
    const requiredServings = roundQuantity(count * selection.servings_per_attendee);
    const availableWeight = roundQuantity(
      recipeBatches.reduce((sum, batch) => sum + getBatchAvailableWeight(batch), 0)
    );
    const availableServings = roundQuantity(availableWeight / portionSize);
    const requiredWeight = roundQuantity(requiredServings * portionSize);
    const allocatedWeight = roundQuantity(Math.min(requiredWeight, availableWeight));
    const allocatableServings = roundQuantity(Math.min(requiredServings, allocatedWeight / portionSize));
    const shortageServings = roundQuantity(Math.max(0, requiredServings - allocatableServings));
    const producedWeight = roundQuantity(
      allRecipeBatches.reduce((sum, batch) => sum + number(batch.produced_weight_grams, 0), 0)
    );
    const previouslyServedWeight = roundQuantity(
      allRecipeBatches.reduce((sum, batch) => sum + number(batch.served_weight_grams, 0), 0)
    );
    const producedServings = roundQuantity(producedWeight / portionSize);
    const previouslyServedServings = roundQuantity(previouslyServedWeight / portionSize);
    return {
      produced_item_batch_id: selection.produced_item_batch_id || firstBatch?.id || null,
      recipe_id: selection.recipe_id,
      recipe_name: recipe.name || firstBatch?.recipe_name || selection.recipe_id,
      meal_plan_line_id: selection.meal_plan_line_id,
      portion_size_grams: roundQuantity(portionSize),
      manual_portion_size_grams: roundQuantity(portionSize),
      portion_size_source: 'meal_service_manual',
      portions_per_attendee: selection.servings_per_attendee,
      servings_per_attendee: selection.servings_per_attendee,
      required_servings: requiredServings,
      required_weight_grams: requiredWeight,
      produced_servings: producedServings,
      produced_weight_grams: producedWeight,
      previously_served_servings: previouslyServedServings,
      previously_served_weight_grams: previouslyServedWeight,
      available_servings: availableServings,
      available_weight_grams: availableWeight,
      allocated_servings: allocatableServings,
      allocated_weight_grams: allocatedWeight,
      remaining_available_servings: roundQuantity(Math.max(0, availableServings - allocatableServings)),
      remaining_available_weight_grams: roundQuantity(Math.max(0, availableWeight - allocatedWeight)),
      shortage_servings: shortageServings,
      shortage_weight_grams: roundQuantity(shortageServings * portionSize),
      batch_count: recipeBatches.length,
      batch_allocations: []
    };
  });
  // Preview and posting must use the same frozen batch sizes and FIFO order. This
  // simulation is side-effect free because allocateMealServiceDemand clones batches.
  return allocateMealServiceDemand(demandItems, batches).items;
}

export function allocateMealServiceDemand(items = [], batches = []) {
  const mutableBatches = batches
    .filter((batch) => AVAILABLE_BATCH_STATUSES.has(String(batch.status || '').toLowerCase()))
    .map((batch) => ({ ...batch }))
    .sort(compareBatchFifo);

  const allocatedItems = items.map((item) => {
    const usesManualPortion = ['meal_service_manual', 'meal_service_configured'].includes(item.portion_size_source);
    const servicePortionSize = number(item.portion_size_grams, 0);
    let remainingDemand = usesManualPortion
      ? number(item.required_weight_grams, 0)
      : number(item.required_servings, 0);
    const allocations = [];

    for (const batch of mutableBatches) {
      if (remainingDemand <= QUANTITY_EPSILON) break;
      if (String(batch.recipe_id || '') !== String(item.recipe_id || '')) continue;
      const batchPortionSize = number(batch.portion_size_grams, 0);
      const availableWeight = getBatchAvailableWeight(batch);
      const availableServings = getBatchAvailableServings(batch);
      if (
        batchPortionSize <= 0
        || availableWeight <= QUANTITY_EPSILON
        || (!usesManualPortion && availableServings <= QUANTITY_EPSILON)
      ) continue;
      const allocatedWeight = usesManualPortion
        ? roundQuantity(Math.min(remainingDemand, availableWeight))
        : roundQuantity(Math.min(remainingDemand, availableServings) * batchPortionSize);
      const productionEquivalentServings = roundQuantity(allocatedWeight / batchPortionSize);
      const mealPortions = usesManualPortion
        ? roundQuantity(allocatedWeight / servicePortionSize)
        : productionEquivalentServings;
      const beforeWeight = number(batch.remaining_weight_grams, 0);
      batch.remaining_weight_grams = roundQuantity(Math.max(0, beforeWeight - allocatedWeight));
      batch.served_weight_grams = roundQuantity(number(batch.served_weight_grams, 0) + allocatedWeight);
      const beforeServings = getBatchAvailableServings({
        ...batch,
        remaining_weight_grams: beforeWeight
      });
      // Weight is authoritative. Re-derive frozen production-serving balances
      // so legacy rounding in remaining_servings cannot strand usable output.
      batch.remaining_servings = getBatchAvailableServings(batch);
      batch.served_servings = roundQuantity(
        Math.max(0, number(batch.produced_servings, 0) - batch.remaining_servings)
      );
      batch.status = batch.remaining_weight_grams <= QUANTITY_EPSILON
        ? 'consumed'
        : 'partial';
      allocations.push({
        produced_item_batch_id: batch.id,
        production_id: batch.production_id,
        batch_number: batch.batch_number,
        portion_size_grams: batchPortionSize,
        service_portion_size_grams: servicePortionSize,
        servings: productionEquivalentServings,
        production_equivalent_servings: productionEquivalentServings,
        meal_portions: mealPortions,
        weight_grams: allocatedWeight,
        remaining_servings_before: roundQuantity(beforeServings),
        remaining_servings_after: batch.remaining_servings,
        remaining_weight_grams_before: roundQuantity(beforeWeight),
        remaining_weight_grams_after: batch.remaining_weight_grams
      });
      remainingDemand = roundQuantity(Math.max(
        0,
        remainingDemand - (usesManualPortion ? allocatedWeight : productionEquivalentServings)
      ));
    }

    const allocatedServings = roundQuantity(
      allocations.reduce((sum, allocation) => (
        sum + number(usesManualPortion ? allocation.meal_portions : allocation.servings, 0)
      ), 0)
    );
    const allocatedWeight = roundQuantity(
      allocations.reduce((sum, allocation) => sum + number(allocation.weight_grams, 0), 0)
    );
    const allocatedProductionEquivalentServings = roundQuantity(
      allocations.reduce((sum, allocation) => (
        sum + number(allocation.production_equivalent_servings ?? allocation.servings, 0)
      ), 0)
    );
    const shortageWeight = usesManualPortion
      ? roundQuantity(Math.max(0, number(item.required_weight_grams, 0) - allocatedWeight))
      : roundQuantity(
        Math.max(0, number(item.required_servings, 0) - allocatedServings) * servicePortionSize
      );
    const shortageServings = usesManualPortion
      ? roundQuantity(shortageWeight / servicePortionSize)
      : roundQuantity(Math.max(0, number(item.required_servings, 0) - allocatedServings));
    return {
      ...item,
      required_weight_grams: usesManualPortion
        ? roundQuantity(number(item.required_weight_grams, allocatedWeight + shortageWeight))
        : roundQuantity(allocatedWeight + shortageWeight),
      allocated_servings: allocatedServings,
      allocated_production_equivalent_servings: allocatedProductionEquivalentServings,
      allocated_weight_grams: allocatedWeight,
      remaining_available_servings: roundQuantity(Math.max(
        0,
        number(item.available_servings, 0) - allocatedServings
      )),
      remaining_available_weight_grams: roundQuantity(Math.max(
        0,
        number(item.available_weight_grams, 0) - allocatedWeight
      )),
      shortage_servings: shortageServings,
      shortage_weight_grams: shortageWeight,
      batch_allocations: allocations
    };
  });

  return { items: allocatedItems, batches: mutableBatches };
}

export function convertMealServiceRemainderToWaste(batches = []) {
  const wasteByRecipe = new Map();
  const finalizedBatches = batches.map((source) => {
    const batch = { ...source };
    const wasteWeight = getBatchAvailableWeight(batch);
    if (wasteWeight <= QUANTITY_EPSILON) return batch;
    const nativePortion = number(batch.portion_size_grams, 0);
    if (nativePortion <= 0) throw httpError('Produced output has no valid frozen portion size', 409);
    const wasteEquivalentServings = roundQuantity(wasteWeight / nativePortion);
    batch.wasted_weight_grams = roundQuantity(number(batch.wasted_weight_grams, 0) + wasteWeight);
    batch.wasted_servings = roundQuantity(number(batch.wasted_servings, 0) + wasteEquivalentServings);
    batch.remaining_weight_grams = 0;
    batch.remaining_servings = 0;
    batch.status = 'consumed';
    const recipeId = normalizeText(batch.recipe_id);
    if (!wasteByRecipe.has(recipeId)) {
      wasteByRecipe.set(recipeId, {
        recipe_id: recipeId,
        recipe_name: batch.recipe_name || recipeId,
        wasted_weight_grams: 0,
        wasted_production_equivalent_servings: 0,
        allocations: []
      });
    }
    const waste = wasteByRecipe.get(recipeId);
    waste.wasted_weight_grams = roundQuantity(waste.wasted_weight_grams + wasteWeight);
    waste.wasted_production_equivalent_servings = roundQuantity(
      waste.wasted_production_equivalent_servings + wasteEquivalentServings
    );
    waste.allocations.push({
      produced_item_batch_id: batch.id,
      production_id: batch.production_id,
      batch_number: batch.batch_number,
      weight_grams: wasteWeight,
      production_equivalent_servings: wasteEquivalentServings
    });
    return batch;
  });
  return { batches: finalizedBatches, wasteItems: [...wasteByRecipe.values()] };
}

export function reconcileMealServiceItemsWithWaste(items = [], wasteItems = []) {
  const wasteByRecipe = new Map(wasteItems.map((item) => [normalizeText(item.recipe_id), item]));
  return items.map((item) => {
    const waste = wasteByRecipe.get(normalizeText(item.recipe_id));
    const hasWaste = Boolean(waste);
    return {
      ...item,
      wasted_weight_grams: number(waste?.wasted_weight_grams, 0),
      wasted_production_equivalent_servings: number(waste?.wasted_production_equivalent_servings, 0),
      remaining_available_servings: hasWaste ? 0 : item.remaining_available_servings,
      remaining_available_weight_grams: hasWaste ? 0 : item.remaining_available_weight_grams
    };
  });
}

export function reverseMealServiceAllocations(consumptions = [], batches = []) {
  const batchMap = new Map(batches.map((batch) => [String(batch.id), { ...batch }]));
  for (const consumption of consumptions) {
    for (const allocation of Array.isArray(consumption.allocations) ? consumption.allocations : []) {
      const batch = batchMap.get(String(allocation.produced_item_batch_id || ''));
      if (!batch) throw httpError('A produced-item batch needed for exact reversal no longer exists', 409);
      const servings = number(
        allocation.production_equivalent_servings ?? allocation.servings,
        0
      );
      const weight = number(allocation.weight_grams, 0);
      if (servings < 0 || weight < 0) throw httpError('A posted meal-service allocation is invalid', 409);
      if (
        number(batch.served_servings, 0) + QUANTITY_EPSILON < servings
        || number(batch.served_weight_grams, 0) + QUANTITY_EPSILON < weight
      ) {
        throw httpError('Produced-item usage has changed and cannot be reversed exactly', 409);
      }
      batch.served_servings = roundQuantity(Math.max(0, number(batch.served_servings, 0) - servings));
      batch.served_weight_grams = roundQuantity(Math.max(0, number(batch.served_weight_grams, 0) - weight));
      batch.remaining_servings = roundQuantity(number(batch.remaining_servings, 0) + servings);
      batch.remaining_weight_grams = roundQuantity(number(batch.remaining_weight_grams, 0) + weight);
      if (
        batch.remaining_servings - number(batch.produced_servings, 0) > QUANTITY_EPSILON
        || batch.remaining_weight_grams - number(batch.produced_weight_grams, 0) > QUANTITY_EPSILON
      ) {
        throw httpError('Reversal would exceed the original produced-item quantity', 409);
      }
      batch.status = batch.served_servings <= QUANTITY_EPSILON ? 'available' : 'partial';
    }
  }
  return [...batchMap.values()];
}

export function reverseMealServiceWasteAllocations(wasteRecords = [], batches = []) {
  const batchMap = new Map(batches.map((batch) => [String(batch.id), { ...batch }]));
  for (const waste of wasteRecords) {
    for (const allocation of Array.isArray(waste.output_allocations) ? waste.output_allocations : []) {
      const batch = batchMap.get(String(allocation.produced_item_batch_id || ''));
      if (!batch) throw httpError('A produced-item batch needed for waste reversal no longer exists', 409);
      const weight = number(allocation.weight_grams, 0);
      const servings = number(allocation.production_equivalent_servings, 0);
      if (number(batch.wasted_weight_grams, 0) + QUANTITY_EPSILON < weight
        || number(batch.wasted_servings, 0) + QUANTITY_EPSILON < servings) {
        throw httpError('Prepared-output waste has changed and cannot be reversed exactly', 409);
      }
      batch.wasted_weight_grams = roundQuantity(Math.max(0, number(batch.wasted_weight_grams, 0) - weight));
      batch.wasted_servings = roundQuantity(Math.max(0, number(batch.wasted_servings, 0) - servings));
      batch.remaining_weight_grams = roundQuantity(number(batch.remaining_weight_grams, 0) + weight);
      batch.remaining_servings = roundQuantity(number(batch.remaining_servings, 0) + servings);
      if (batch.remaining_weight_grams - number(batch.produced_weight_grams, 0) > QUANTITY_EPSILON
        || batch.remaining_servings - number(batch.produced_servings, 0) > QUANTITY_EPSILON) {
        throw httpError('Waste reversal would exceed the original produced output', 409);
      }
      batch.status = number(batch.served_weight_grams, 0) <= QUANTITY_EPSILON ? 'available' : 'partial';
    }
  }
  return [...batchMap.values()];
}

export function buildMealServiceReversalAllocationEntries(allocations = []) {
  return (Array.isArray(allocations) ? allocations : []).map((allocation) => ({
    ...allocation,
    servings: number(allocation.servings, 0) * -1,
    production_equivalent_servings: number(
      allocation.production_equivalent_servings ?? allocation.servings,
      0
    ) * -1,
    meal_portions: number(allocation.meal_portions, 0) * -1,
    weight_grams: number(allocation.weight_grams, 0) * -1
  }));
}

export function buildMealServiceReversalPortionMetadata(consumption = {}) {
  return {
    manual_portion_size_grams: consumption.manual_portion_size_grams ?? null,
    portion_size_source: consumption.portion_size_source ?? null
  };
}

function summarizeItems(items = [], attendeeCount = 0) {
  const producedMealPortions = roundQuantity(
    items.reduce((sum, item) => sum + number(item.produced_servings, 0), 0)
  );
  const requiredMealPortions = roundQuantity(
    items.reduce((sum, item) => sum + number(item.required_servings, 0), 0)
  );
  const servedMealPortions = roundQuantity(
    items.reduce((sum, item) => sum + number(item.allocated_servings, 0), 0)
  );
  const servedProductionEquivalentServings = roundQuantity(
    items.reduce((sum, item) => (
      sum + number(item.allocated_production_equivalent_servings, 0)
    ), 0)
  );
  const remainingMealPortions = roundQuantity(
    items.reduce((sum, item) => sum + number(item.remaining_available_servings, 0), 0)
  );
  const shortMealPortions = roundQuantity(
    items.reduce((sum, item) => sum + number(item.shortage_servings, 0), 0)
  );
  return {
    attendee_count: number(attendeeCount, 0),
    prepared_meal_count: items.length,
    recipe_count: items.length,
    measurement_basis: {
      authoritative: 'weight_grams',
      meal_portions: 'customer-entered portion size',
      production_equivalent_servings: 'frozen production serving size'
    },
    produced_meal_portions: producedMealPortions,
    required_meal_portions: requiredMealPortions,
    served_meal_portions: servedMealPortions,
    served_production_equivalent_servings: servedProductionEquivalentServings,
    remaining_meal_portions: remainingMealPortions,
    short_meal_portions: shortMealPortions,
    // Compatibility aliases retained for existing consumers. These count
    // customer meal portions in preview/attendance summaries, never grams.
    produced_servings: producedMealPortions,
    produced_weight_grams: roundQuantity(items.reduce((sum, item) => sum + number(item.produced_weight_grams, 0), 0)),
    required_servings: requiredMealPortions,
    required_weight_grams: roundQuantity(items.reduce((sum, item) => sum + number(item.required_weight_grams, 0), 0)),
    served_servings: servedMealPortions,
    served_weight_grams: roundQuantity(items.reduce((sum, item) => sum + number(item.allocated_weight_grams, 0), 0)),
    remaining_servings: remainingMealPortions,
    remaining_weight_grams: roundQuantity(items.reduce((sum, item) => sum + number(item.remaining_available_weight_grams, 0), 0)),
    short_servings: shortMealPortions,
    short_weight_grams: roundQuantity(items.reduce((sum, item) => sum + number(item.shortage_weight_grams, 0), 0))
  };
}

export function buildProducedItemBatchSnapshot({
  production = {},
  recipe = {},
  recipes = [],
  ingredients = [],
  completedAt = nowIso(),
  actor = {}
} = {}) {
  const productionMenuScope = normalizeProductionMenuScope(production, {
    required: true,
    errorStatus: 409
  });
  const automaticYield = buildAutomaticProductionYieldSummary({
    production,
    recipe,
    ingredients
  });
  const calculatedWeight = calculateRecipeServingWeight(recipe, recipes, ingredients);
  const portionSize = number(
    automaticYield.portion_size_grams
      ?? production.portion_size_grams
      ?? recipe.portion_size_grams
      ?? calculatedWeight.grams_per_serving,
    0
  );
  if (portionSize <= 0) {
    throw httpError('Production cannot be completed until the recipe has a valid yielded serving size in grams', 409);
  }
  const persistedExpectedServings = automaticYield.expected_yield_servings
    ?? production.expected_yield_servings;
  const expectedServings = Math.max(0, number(
    persistedExpectedServings === null
      || typeof persistedExpectedServings === 'undefined'
      || persistedExpectedServings === ''
      ? production.target_servings
      : persistedExpectedServings,
    0
  ));
  const persistedExpectedWeight = automaticYield.expected_finished_weight_grams
    ?? production.expected_finished_weight_grams;
  const frozenExpectedWeight = number(persistedExpectedWeight, 0);
  const recipeServings = Math.max(1, number(recipe.servings, 1));
  const targetServings = Math.max(0, number(production.target_servings, 0));
  const recipeYieldWeight = number(calculatedWeight.cooked_total_grams, 0);
  const scaledRecipeYieldWeight = recipeYieldWeight > 0 && targetServings > 0
    ? recipeYieldWeight * (targetServings / recipeServings)
    : 0;
  const expectedWeight = roundQuantity(
    frozenExpectedWeight > 0
      ? frozenExpectedWeight
      : expectedServings > 0
        ? expectedServings * portionSize
        : scaledRecipeYieldWeight > 0
          ? scaledRecipeYieldWeight
          : targetServings * portionSize
  );
  if (expectedWeight <= 0) {
    throw httpError('Production cannot be completed until its expected yielded weight can be calculated', 409);
  }
  // Completion is a deterministic posting of the approved yield plan. Neither
  // raw consumption nor finished output is accepted from the client: the
  // frozen expected yield becomes the posted finished-item balance.
  const producedServings = roundQuantity(expectedWeight / portionSize);
  const outputCalculationSource = normalizeText(
    automaticYield.expected_finished_weight_grams
      ? automaticYield.output_calculation_source
      : production.output_calculation_source
  )
    || (frozenExpectedWeight > 0
      ? 'frozen_expected_yield'
    : expectedServings > 0
      ? 'frozen_yield_servings'
      : scaledRecipeYieldWeight > 0
        ? 'recipe_yield_fallback'
        : 'target_portion_fallback');
  const completedDate = normalizeMealServiceDate(
    production.production_date || completedAt,
    'Production date'
  );
  const mealType = normalizeProducedItemMealType(production.meal_type);
  const rawMenuType = normalizeText(
    productionMenuScope.menu_type
      || productionMenuScope.cuisine_type
      || productionMenuScope.menu_cuisine
  );
  const rawMenuCategory = normalizeText(productionMenuScope.menu_category);
  if (Boolean(rawMenuType) !== Boolean(rawMenuCategory)) {
    throw httpError('Production must include both menu type and menu category, or leave both unclassified', 409);
  }
  const menuType = rawMenuType ? normalizeMealServiceMenuType(rawMenuType) : null;
  const menuCategory = rawMenuCategory
    ? normalizeMealServiceMenuCategory(rawMenuCategory, menuType)
    : null;
  const dateToken = completedDate.replace(/-/g, '');
  const productionToken = normalizeText(production.id)
    ? crypto.createHash('sha256').update(normalizeText(production.id)).digest('hex').slice(0, 10).toUpperCase()
    : crypto.randomBytes(5).toString('hex').toUpperCase();
  const productionEventTitle = formatProductionEventTitle(production, {
    fallback: production.recipe_name || recipe.name || production.id
  });
  const productionItemCount = getProductionEventItemCount(
    production,
    Array.isArray(production.menu_issue_items) ? production.menu_issue_items.length : 0
  );

  return {
    batch_number: `PIB-${dateToken}-${productionToken}`,
    production_id: normalizeText(production.id),
    production_name: productionEventTitle,
    production_date: completedDate,
    completed_at: completedAt,
    site_id: normalizeText(production.site_id),
    site_name: production.site_name || null,
    recipe_id: normalizeText(production.recipe_id || recipe.id),
    recipe_name: productionEventTitle || production.recipe_name || recipe.name || null,
    original_recipe_name: production.recipe_name || recipe.name || null,
    consumption_report_id: normalizeText(production.consumption_report_id) || null,
    consumption_report_number: normalizeText(production.consumption_report_number) || null,
    source_type: normalizeText(production.source_type) || null,
    source_event_id: normalizeText(production.source_event_id) || null,
    menu_plan_id: normalizeText(production.menu_plan_id) || null,
    meal_type: mealType,
    menu_type: menuType,
    menu_category: menuCategory,
    production_issue_grouped: Boolean(production.production_issue_grouped),
    production_issue_item_count: productionItemCount,
    production_issue_dish_count: number(production.production_issue_dish_count, productionItemCount),
    menu_issue_items: Array.isArray(production.menu_issue_items) ? production.menu_issue_items : [],
    portion_size_grams: roundQuantity(portionSize),
    service_portion_size_grams: null,
    expected_servings: roundQuantity(expectedServings),
    expected_finished_weight_grams: expectedWeight,
    actual_finished_weight_grams: expectedWeight,
    produced_servings: producedServings,
    produced_weight_grams: expectedWeight,
    served_servings: 0,
    served_weight_grams: 0,
    wasted_servings: 0,
    wasted_weight_grams: 0,
    remaining_servings: producedServings,
    remaining_weight_grams: expectedWeight,
    completed_by: actor.email || null,
    completed_by_name: actor.full_name || actor.email || null,
    status: 'available',
    cutover_version: PRODUCED_ITEM_CUTOVER_VERSION,
    reconciliation_mode: 'automatic_yield_plan',
    output_calculation_source: outputCalculationSource
  };
}

export async function createProducedItemBatchForCompletion({
  production,
  recipe,
  recipes = [],
  ingredients = [],
  actor = {},
  completedAt,
  executor
}) {
  if (!executor) throw new Error('Produced-item batch creation requires the production completion transaction');
  const snapshot = buildProducedItemBatchSnapshot({
    production,
    recipe,
    recipes,
    ingredients,
    completedAt,
    actor
  });
  let serviceScopeKey = null;
  if (
    MEAL_TYPES.has(snapshot.meal_type)
    && snapshot.menu_type
    && snapshot.menu_category
    && isRoutineMealServiceBatch(snapshot)
  ) {
    serviceScopeKey = buildMealServiceScopeKey({
      site_id: snapshot.site_id,
      service_date: snapshot.production_date,
      meal_type: snapshot.meal_type,
      menu_type: snapshot.menu_type,
      menu_category: snapshot.menu_category
    });
    await acquireMealServiceScopeLock(serviceScopeKey, executor);
  }
  const existing = (await listDocuments('ProducedItemBatch', {
    filters: { production_id: production.id },
    limit: 50,
    lock: true
  }, executor)).find((batch) => String(batch.status || '').toLowerCase() !== 'voided');
  if (existing) return { batch: existing, mutated: false };
  const batch = await createDocument('ProducedItemBatch', snapshot, executor);
  return { batch, mutated: true };
}

function isOperationalMenuPlan(plan = {}) {
  return !normalizeText(plan.event_name);
}

function getMenuPlanRecipeIds(plan = {}, mealType) {
  return new Set(getMenuPlanMealLines(plan, mealType).map((meal) => normalizeText(meal.recipe_id)));
}

function getPlanMenuType(plan = {}) {
  return normalizeMenuCuisine(plan.cuisine_type || plan.menu_type, 'general');
}

function getPlanMenuCategory(plan = {}) {
  return normalizeMenuCategory(plan.menu_category, 'senior');
}

export function batchMatchesMenuSelection(
  batch,
  menuType,
  menuCategory,
  menuRecipeIds,
  serviceablePlans = [],
  mealType = '',
  selectedMenuPlanId = ''
) {
  const sourceType = normalizeText(batch?.source_type).toLowerCase();
  if (
    normalizeText(batch?.source_event_id)
    || ['special_event', 'event', 'auto_schedule_unlinked'].includes(sourceType)
  ) {
    return false;
  }
  if (
    normalizeText(selectedMenuPlanId)
    && normalizeText(batch?.menu_plan_id)
    && normalizeText(batch.menu_plan_id) !== normalizeText(selectedMenuPlanId)
  ) return false;
  const batchMenuType = normalizeMenuCuisine(batch?.menu_type || batch?.cuisine_type, '');
  const batchMenuCategory = normalizeMenuCategory(batch?.menu_category, '');
  if (batchMenuType && batchMenuType !== menuType) return false;
  if (batchMenuCategory && batchMenuCategory !== menuCategory) return false;
  const recipeId = normalizeText(batch?.recipe_id);
  if (!menuRecipeIds.has(recipeId)) return false;
  if (batchMenuType && batchMenuCategory) return true;

  // Batches created before menu dimensions were frozen remain usable only when
  // their recipe maps to one unambiguous menu type/category for this service.
  const candidateKeys = new Set(
    serviceablePlans
      .filter((plan) => getMenuPlanRecipeIds(plan, mealType).has(recipeId))
      .filter((plan) => !batchMenuType || getPlanMenuType(plan) === batchMenuType)
      .filter((plan) => !batchMenuCategory || getPlanMenuCategory(plan) === batchMenuCategory)
      .map((plan) => `${getPlanMenuType(plan)}::${getPlanMenuCategory(plan)}`)
  );
  return candidateKeys.size === 1 && candidateKeys.has(`${menuType}::${menuCategory}`);
}

export function buildResolvedBatchClassificationPatch(batch = {}, context = {}) {
  return {
    menu_type: normalizeText(batch.menu_type) ? batch.menu_type : context.menuType,
    menu_category: normalizeText(batch.menu_category) ? batch.menu_category : context.menuCategory,
    menu_plan_id: normalizeText(batch.menu_plan_id) ? batch.menu_plan_id : context.menuPlanId
  };
}

export function selectMealServiceMenuPlan(plans = [], {
  siteId,
  serviceDate,
  mealType,
  menuType,
  menuCategory
} = {}) {
  const normalizedMealType = normalizeMealServiceType(mealType);
  const normalizedMenuType = normalizeMealServiceMenuType(menuType);
  const normalizedMenuCategory = normalizeMealServiceMenuCategory(menuCategory, normalizedMenuType);
  const normalizedSiteId = normalizeText(siteId);
  const normalizedServiceDate = normalizeMealServiceDate(serviceDate);
  const serviceablePlans = plans.filter((plan) => (
    String(plan.site_id || '') === normalizedSiteId
    && normalizeMealServiceDate(plan.plan_date) === normalizedServiceDate
    && isOperationalMenuPlan(plan)
    && SERVICEABLE_MENU_PLAN_STATUSES.has(String(plan.status || 'planned').toLowerCase())
    && getMenuPlanMealLines(plan, normalizedMealType).length > 0
  ));
  const matches = serviceablePlans.filter((plan) => (
    getPlanMenuType(plan) === normalizedMenuType
    && getPlanMenuCategory(plan) === normalizedMenuCategory
  ));
  if (matches.length === 0) {
    throw httpError('No planned menu matches this project, date, meal period, menu type, and menu category', 409);
  }
  if (matches.length > 1) {
    throw httpError('More than one active menu matches this service selection; resolve the duplicate menu plans first', 409);
  }
  return { plan: matches[0], serviceablePlans };
}

async function resolveMealServiceMenuPlan({
  siteId,
  serviceDate,
  mealType,
  menuType,
  menuCategory,
  executor,
  location,
  lock = false
}) {
  const plans = await listDocuments('MenuPlan', {
    filters: { site_id: siteId, plan_date: serviceDate },
    sort: '-updated_date',
    limit: 100,
    lock,
    location
  }, executor || undefined);
  return selectMealServiceMenuPlan(plans, {
    siteId,
    serviceDate,
    mealType,
    menuType,
    menuCategory
  });
}

async function getServiceContext(payload, executor, {
  lockBatches = false,
  location = null,
  requireAvailabilitySnapshot = false
} = {}) {
  const dbExecutor = executor || undefined;
  const siteId = normalizeText(payload.site_id);
  if (!siteId) throw httpError('Select a location for Meal Service');
  const serviceDate = normalizeMealServiceDate(payload.service_date || payload.plan_date);
  const mealType = normalizeMealServiceType(payload.meal_type);
  const menuType = normalizeMealServiceMenuType(
    payload.menu_type || payload.cuisine_type || payload.menu_cuisine
  );
  const menuCategory = normalizeMealServiceMenuCategory(payload.menu_category, menuType);
  const {
    serviceSite: site,
    productionSiteIds,
    productionLocation
  } = await resolveMealServiceProductionScope(siteId, dbExecutor, location);
  let batches = await listMealServiceProducedItemBatchesForSites({
    siteIds: productionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    lock: lockBatches,
    location: productionLocation,
    executor: dbExecutor
  });
  batches = await backfillProducedItemBatchesForCompletedProductions({
    siteId,
    productionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    batches,
    executor: dbExecutor,
    location: productionLocation,
    lock: lockBatches
  });
  const eligibleBatches = batches.filter((batch) => (
    isRoutineMealServiceBatch(batch)
    && AVAILABLE_BATCH_STATUSES.has(String(batch.status || '').toLowerCase())
    && getBatchAvailableWeight(batch) > QUANTITY_EPSILON
    && number(batch.portion_size_grams, 0) > 0
  ));
  const availableDishes = groupMealServiceProducedDishes(eligibleBatches);
  if (availableDishes.length === 0) {
    throw httpError('No completed production output matches this project, date, meal period, menu type, and menu category', 409);
  }
  const unconfiguredDish = availableDishes.find((dish) => !dish.portion_configured);
  if (unconfiguredDish) {
    throw httpError(`${unconfiguredDish.recipe_name} requires an administrator-configured service portion size before Meal Service can be saved`, 409);
  }
  const covers = normalizeMealServiceDishCovers(payload.dishes);
  const coversByRecipe = new Map(covers.map((dish) => [dish.recipe_id, dish.covers]));
  const availableIds = new Set(availableDishes.map((dish) => dish.recipe_id));
  if (
    covers.length !== availableDishes.length
    || covers.some((dish) => !availableIds.has(dish.recipe_id))
    || availableDishes.some((dish) => !coversByRecipe.has(dish.recipe_id))
  ) {
    throw httpError('Enter covers for every displayed prepared dish; the production selection has changed', 409);
  }
  const demand = availableDishes.map((dish) => {
    const requiredServings = coversByRecipe.get(dish.recipe_id);
    const requiredWeight = roundQuantity(requiredServings * dish.service_portion_size_grams);
    if (requiredWeight - dish.available_weight_grams > QUANTITY_EPSILON) {
      throw httpError(`${dish.recipe_name} requires ${requiredWeight} g but only ${dish.available_weight_grams} g is available`, 409);
    }
    return {
      ...dish,
      portion_size_grams: dish.service_portion_size_grams,
      manual_portion_size_grams: null,
      portion_size_source: 'meal_service_configured',
      portions_per_attendee: 1,
      servings_per_attendee: 1,
      covers: requiredServings,
      required_servings: requiredServings,
      required_weight_grams: requiredWeight,
      available_servings: dish.available_covers,
      allocated_servings: requiredServings,
      allocated_weight_grams: requiredWeight,
      remaining_available_servings: dish.available_covers - requiredServings,
      remaining_available_weight_grams: dish.available_weight_grams - requiredWeight,
      shortage_servings: 0,
      shortage_weight_grams: 0,
      batch_allocations: []
    };
  });
  const attendeeCount = Math.max(...covers.map((dish) => dish.covers));
  const scopeKey = buildMealServiceScopeKey({
    site_id: siteId,
    service_date: serviceDate,
    meal_type: mealType,
    menu_type: menuType,
    menu_category: menuCategory
  });
  const availabilitySnapshot = buildMealServiceAvailabilitySnapshot({
    site_id: siteId,
    service_date: serviceDate,
    meal_type: mealType,
    menu_type: menuType,
    menu_category: menuCategory
  }, eligibleBatches);
  if (requireAvailabilitySnapshot) {
    const suppliedSnapshot = normalizeText(payload.availability_snapshot);
    if (!suppliedSnapshot || suppliedSnapshot !== availabilitySnapshot) {
      throw httpError('Prepared output changed after it was loaded. Refresh availability before saving Meal Service', 409);
    }
  }

  return {
    site,
    siteId,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    productionSiteIds,
    attendeeCount,
    scopeKey,
    availabilitySnapshot,
    availableDishes,
    batches: eligibleBatches,
    demand
  };
}

export async function previewMealService(payload, { executor = null, location = null } = {}) {
  const context = await getServiceContext(payload, executor, { location });
  return {
    items: context.demand,
    dishes: context.demand,
    prepared_meals: context.demand,
    summary: summarizeItems(context.demand, context.attendeeCount),
    production_scope: {
      scope_key: context.scopeKey,
      availability_snapshot: context.availabilitySnapshot,
      menu_type: context.menuType,
      menu_category: context.menuCategory,
      meal_type: context.mealType
    },
    cutover: {
      version: PRODUCED_ITEM_CUTOVER_VERSION,
      policy: 'Configured service portion weight is deducted only from matching completed production output.',
      legacy_attendance_policy: 'Historical attendance remains reporting-only and is not backfilled.'
    }
  };
}

export function attendanceReplayResponse(attendance, consumptions = []) {
  return {
    attendance,
    consumptions,
    items: Array.isArray(attendance.items) ? attendance.items : [],
    summary: attendance.summary || summarizeItems(attendance.items || [], attendance.attendee_count),
    replayed: true
  };
}

async function recordMealServiceAttendanceWithExecutor(payload, actor, executor, { location = null } = {}) {
  const idempotencyKey = normalizeText(payload.idempotency_key);
  if (!idempotencyKey) throw httpError('An idempotency key is required for Meal Service');
  if (idempotencyKey.length > 200) throw httpError('The idempotency key is too long');
  const requestFingerprint = buildMealServiceRequestFingerprint(payload);

  const existing = (await listDocuments('MealServiceAttendance', {
    filters: { idempotency_key: idempotencyKey },
    limit: 1,
    lock: true,
    location
  }, executor))[0];
  if (existing) {
    assertMealServiceIdempotencyMatch(existing, requestFingerprint);
    const consumptions = await listDocuments('MealServiceConsumption', {
      filters: { meal_service_attendance_id: existing.id },
      sort: 'created_date',
      limit: 1000,
      location
    }, executor);
    return attendanceReplayResponse(existing, consumptions);
  }

  const scopeKey = buildMealServiceScopeKey({
    site_id: payload.site_id,
    service_date: payload.service_date || payload.plan_date,
    meal_type: payload.meal_type,
    menu_type: payload.menu_type || payload.cuisine_type || payload.menu_cuisine,
    menu_category: payload.menu_category
  });
  await acquireMealServiceScopeLock(scopeKey, executor);
  const concurrentReplay = (await listDocuments('MealServiceAttendance', {
    filters: { idempotency_key: idempotencyKey },
    limit: 1,
    lock: true,
    location
  }, executor))[0];
  if (concurrentReplay) {
    assertMealServiceIdempotencyMatch(concurrentReplay, requestFingerprint);
    const consumptions = await listDocuments('MealServiceConsumption', {
      filters: { meal_service_attendance_id: concurrentReplay.id },
      sort: 'created_date',
      limit: 1000,
      location
    }, executor);
    return attendanceReplayResponse(concurrentReplay, consumptions);
  }

  const context = await getServiceContext(payload, executor, {
    lockBatches: true,
    location,
    requireAvailabilitySnapshot: true
  });
  const allocation = allocateMealServiceDemand(context.demand, context.batches);
  if (allocation.items.some((item) => number(item.shortage_weight_grams, 0) > QUANTITY_EPSILON)) {
    throw httpError('Meal Service cannot be partially saved because produced output is insufficient', 409);
  }
  const reconciledItems = reconcileMealServiceItemsWithWaste(allocation.items, []);
  for (const batch of allocation.batches) {
    const original = context.batches.find((candidate) => candidate.id === batch.id);
    if (!original) continue;
    if (
      number(batch.remaining_servings, 0) < -QUANTITY_EPSILON
      || number(batch.remaining_weight_grams, 0) < -QUANTITY_EPSILON
    ) {
      throw httpError('Produced-item balance would become negative', 409);
    }
    if (
      number(batch.remaining_servings, 0) !== number(original.remaining_servings, 0)
      || number(batch.remaining_weight_grams, 0) !== number(original.remaining_weight_grams, 0)
    ) {
      await updateDocument('ProducedItemBatch', batch.id, {
        served_servings: batch.served_servings,
        served_weight_grams: batch.served_weight_grams,
        wasted_servings: batch.wasted_servings,
        wasted_weight_grams: batch.wasted_weight_grams,
        remaining_servings: batch.remaining_servings,
        remaining_weight_grams: batch.remaining_weight_grams,
        status: batch.status
      }, executor);
    }
  }

  const recordedAt = nowIso();
  const serviceReference = `MS-${context.serviceDate.replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const summary = summarizeItems(reconciledItems, context.attendeeCount);
  summary.wasted_weight_grams = 0;
  const attendance = await createDocument('MealServiceAttendance', {
    service_reference: serviceReference,
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
    scope_key: context.scopeKey,
    menu_plan_id: null,
    menu_plan_name: null,
    menu_type: context.menuType,
    menu_category: context.menuCategory,
    customer_meal_plan_id: null,
    customer_meal_plan_name: null,
    site_id: context.siteId,
    site_name: context.site.name || null,
    service_date: context.serviceDate,
    meal_type: context.mealType,
    customer_name: 'Meal Service',
    customer_id: null,
    category: 'meal_service',
    attendee_count: context.attendeeCount,
    scan_method: 'manual_supervisor',
    notes: normalizeText(payload.notes) || null,
    items: reconciledItems,
    summary,
    required_servings: summary.required_servings,
    required_weight_grams: summary.required_weight_grams,
    served_servings: summary.served_servings,
    served_weight_grams: summary.served_weight_grams,
    shortage_servings: summary.short_servings,
    shortage_weight_grams: summary.short_weight_grams,
    recorded_by: actor.email || null,
    recorded_by_name: actor.full_name || actor.email || null,
    recorded_at: recordedAt,
    status: 'posted',
    cutover_version: PRODUCED_ITEM_CUTOVER_VERSION
  }, executor);

  const consumptions = [];
  for (const item of reconciledItems) {
    consumptions.push(await createDocument('MealServiceConsumption', {
      idempotency_key: buildLedgerIdempotencyKey('msc', idempotencyKey, item.recipe_id),
      meal_service_attendance_id: attendance.id,
      service_reference: attendance.service_reference,
      menu_plan_id: attendance.menu_plan_id,
      menu_type: attendance.menu_type,
      menu_category: attendance.menu_category,
      customer_meal_plan_id: null,
      site_id: attendance.site_id,
      site_name: attendance.site_name,
      service_date: attendance.service_date,
      meal_type: attendance.meal_type,
      recipe_id: item.recipe_id,
      recipe_name: item.recipe_name,
      attendee_count: attendance.attendee_count,
      covers: item.covers,
      portions_per_attendee: item.portions_per_attendee,
      servings_per_attendee: item.servings_per_attendee,
      portion_size_grams: item.portion_size_grams,
      manual_portion_size_grams: item.manual_portion_size_grams,
      portion_size_source: item.portion_size_source,
      required_servings: item.required_servings,
      required_weight_grams: item.required_weight_grams,
      consumed_servings: item.allocated_servings,
      consumed_production_equivalent_servings: item.allocated_production_equivalent_servings,
      consumed_weight_grams: item.allocated_weight_grams,
      shortage_servings: item.shortage_servings,
      shortage_weight_grams: item.shortage_weight_grams,
      allocations: item.batch_allocations,
      movement_type: 'consumption',
      performed_by: actor.email || null,
      performed_by_name: actor.full_name || actor.email || null,
      performed_at: recordedAt,
      status: 'posted',
      cutover_version: PRODUCED_ITEM_CUTOVER_VERSION
    }, executor));
  }

  const wasteRecords = [];

  return {
    attendance,
    consumptions,
    waste_records: wasteRecords,
    items: reconciledItems,
    summary,
    replayed: false
  };
}

export async function recordMealServiceAttendance(payload, actor, options = {}) {
  if (options.executor) {
    return recordMealServiceAttendanceWithExecutor(payload, actor, options.executor, options);
  }
  try {
    return await withTransaction((client) => recordMealServiceAttendanceWithExecutor(
      payload,
      actor,
      client,
      options
    ));
  } catch (error) {
    if (error?.code !== '23505' || !normalizeText(payload.idempotency_key)) throw error;
    const existing = (await listDocuments('MealServiceAttendance', {
      filters: { idempotency_key: normalizeText(payload.idempotency_key) },
      limit: 1,
      location: options.location || null
    }))[0];
    if (!existing) throw httpError('This meal-service idempotency key conflicts with an existing record', 409);
    const requestFingerprint = buildMealServiceRequestFingerprint(payload);
    assertMealServiceIdempotencyMatch(existing, requestFingerprint);
    const consumptions = await listDocuments('MealServiceConsumption', {
      filters: { meal_service_attendance_id: existing.id },
      sort: 'created_date',
      limit: 1000,
      location: options.location || null
    });
    return attendanceReplayResponse(existing, consumptions);
  }
}

async function reverseMealServiceAttendanceWithExecutor(attendanceId, payload, actor, executor, { location = null } = {}) {
  const reason = normalizeText(payload.reason);
  const idempotencyKey = normalizeText(payload.idempotency_key);
  if (!reason) throw httpError('A reversal reason is required');
  if (!idempotencyKey) throw httpError('An idempotency key is required for a meal-service reversal');
  if (idempotencyKey.length > 200) throw httpError('The reversal idempotency key is too long');
  const requestFingerprint = buildMealServiceReversalFingerprint(attendanceId, payload);

  const attendance = await findDocument('MealServiceAttendance', attendanceId, executor, true);
  if (!attendance) throw httpError('Meal Service record not found', 404);
  if (attendance.status === 'reversed') {
    if (
      attendance.reversal_idempotency_key === idempotencyKey
      && attendance.reversal_request_fingerprint === requestFingerprint
    ) {
      const [reversals, wasteReversals] = await Promise.all([
        listDocuments('MealServiceConsumption', {
          filters: { meal_service_attendance_id: attendance.id, movement_type: 'reversal' },
          sort: 'created_date',
          limit: 1000,
          location
        }, executor),
        listDocuments('FoodWaste', {
          filters: { meal_service_attendance_id: attendance.id, auto_generated: true, status: 'reversed' },
          sort: 'created_date',
          limit: 1000,
          location
        }, executor)
      ]);
      return { attendance, reversals, waste_reversals: wasteReversals, replayed: true };
    }
    throw httpError('This Meal Service record has already been reversed', 409);
  }

  const consumptions = await listDocuments('MealServiceConsumption', {
    filters: { meal_service_attendance_id: attendance.id, movement_type: 'consumption' },
    sort: 'created_date',
    limit: 1000,
    lock: true,
    location
  }, executor);
  const wasteRecords = await listDocuments('FoodWaste', {
    filters: { meal_service_attendance_id: attendance.id, auto_generated: true },
    sort: 'created_date', limit: 1000, lock: true, location
  }, executor);
  const batchIds = [...new Set([
    ...consumptions.flatMap((entry) => (
    Array.isArray(entry.allocations)
      ? entry.allocations.map((allocation) => allocation.produced_item_batch_id)
      : []
    )),
    ...wasteRecords.flatMap((entry) => (
      Array.isArray(entry.output_allocations)
        ? entry.output_allocations.map((allocation) => allocation.produced_item_batch_id)
        : []
    ))
  ].filter(Boolean))];
  const batchMap = new Map();
  for (const batchId of batchIds.sort()) {
    const batch = await findDocument('ProducedItemBatch', batchId, executor, true);
    if (!batch) throw httpError('A produced-item batch needed for exact reversal no longer exists', 409);
    batchMap.set(batchId, batch);
  }

  const servedRestoredBatches = reverseMealServiceAllocations(consumptions, [...batchMap.values()]);
  const reversedBatches = reverseMealServiceWasteAllocations(wasteRecords, servedRestoredBatches);
  for (const batch of reversedBatches) {
    await updateDocument('ProducedItemBatch', batch.id, {
      served_servings: batch.served_servings,
      served_weight_grams: batch.served_weight_grams,
      wasted_servings: batch.wasted_servings,
      wasted_weight_grams: batch.wasted_weight_grams,
      remaining_servings: batch.remaining_servings,
      remaining_weight_grams: batch.remaining_weight_grams,
      status: batch.status
    }, executor);
  }

  const reversedAt = nowIso();
  const wasteReversals = [];
  for (const waste of wasteRecords) {
    wasteReversals.push(await updateDocument('FoodWaste', waste.id, {
      status: 'reversed',
      reversal_reason: reason,
      reversed_by: actor.email || null,
      reversed_by_name: actor.full_name || actor.email || null,
      reversed_at: reversedAt
    }, executor));
  }
  const reversals = [];
  for (const consumption of consumptions) {
    reversals.push(await createDocument('MealServiceConsumption', {
      idempotency_key: buildLedgerIdempotencyKey(
        'msr',
        idempotencyKey,
        attendance.id,
        consumption.id,
        consumption.recipe_id
      ),
      meal_service_attendance_id: attendance.id,
      service_reference: attendance.service_reference,
      reverses_consumption_id: consumption.id,
      menu_plan_id: attendance.menu_plan_id,
      menu_type: attendance.menu_type,
      menu_category: attendance.menu_category,
      customer_meal_plan_id: attendance.customer_meal_plan_id,
      site_id: attendance.site_id,
      site_name: attendance.site_name,
      service_date: attendance.service_date,
      meal_type: attendance.meal_type,
      recipe_id: consumption.recipe_id,
      recipe_name: consumption.recipe_name,
      attendee_count: attendance.attendee_count,
      portions_per_attendee: consumption.portions_per_attendee || consumption.servings_per_attendee,
      servings_per_attendee: consumption.servings_per_attendee,
      portion_size_grams: consumption.portion_size_grams,
      ...buildMealServiceReversalPortionMetadata(consumption),
      required_servings: consumption.required_servings,
      required_weight_grams: consumption.required_weight_grams,
      consumed_servings: number(consumption.consumed_servings, 0) * -1,
      consumed_production_equivalent_servings: number(
        consumption.consumed_production_equivalent_servings ?? consumption.consumed_servings,
        0
      ) * -1,
      consumed_weight_grams: number(consumption.consumed_weight_grams, 0) * -1,
      shortage_servings: number(consumption.shortage_servings, 0) * -1,
      shortage_weight_grams: number(consumption.shortage_weight_grams, 0) * -1,
      allocations: buildMealServiceReversalAllocationEntries(consumption.allocations),
      movement_type: 'reversal',
      reversal_reason: reason,
      performed_by: actor.email || null,
      performed_by_name: actor.full_name || actor.email || null,
      performed_at: reversedAt,
      status: 'posted',
      cutover_version: PRODUCED_ITEM_CUTOVER_VERSION
    }, executor));
  }

  const reversedAttendance = await updateDocument('MealServiceAttendance', attendance.id, {
    status: 'reversed',
    reversal_idempotency_key: idempotencyKey,
    reversal_request_fingerprint: requestFingerprint,
    reversal_reason: reason,
    reversed_by: actor.email || null,
    reversed_by_name: actor.full_name || actor.email || null,
    reversed_at: reversedAt
  }, executor);
  return { attendance: reversedAttendance, reversals, waste_reversals: wasteReversals, replayed: false };
}

export async function reverseMealServiceAttendance(attendanceId, payload, actor, options = {}) {
  if (options.executor) {
    return reverseMealServiceAttendanceWithExecutor(attendanceId, payload, actor, options.executor, options);
  }
  try {
    return await withTransaction((client) => reverseMealServiceAttendanceWithExecutor(
      attendanceId,
      payload,
      actor,
      client,
      options
    ));
  } catch (error) {
    if (error?.code !== '23505' || !normalizeText(payload.idempotency_key)) throw error;
    const existing = (await listDocuments('MealServiceAttendance', {
      filters: { reversal_idempotency_key: normalizeText(payload.idempotency_key) },
      limit: 1,
      location: options.location || null
    }))[0];
    const requestFingerprint = buildMealServiceReversalFingerprint(attendanceId, payload);
    if (
      !existing
      || String(existing.id) !== String(attendanceId)
      || existing.reversal_request_fingerprint !== requestFingerprint
    ) {
      throw httpError('This reversal idempotency key was already used for a different operation', 409);
    }
    const [reversals, wasteReversals] = await Promise.all([
      listDocuments('MealServiceConsumption', {
        filters: { meal_service_attendance_id: existing.id, movement_type: 'reversal' },
        sort: 'created_date',
        limit: 1000,
        location: options.location || null
      }),
      listDocuments('FoodWaste', {
        filters: { meal_service_attendance_id: existing.id, auto_generated: true, status: 'reversed' },
        sort: 'created_date',
        limit: 1000,
        location: options.location || null
      })
    ]);
    return { attendance: existing, reversals, waste_reversals: wasteReversals, replayed: true };
  }
}

export async function getProducedItemAvailability(filters = {}, { executor = null, location = null } = {}) {
  const siteId = normalizeText(filters.site_id);
  const serviceDate = normalizeMealServiceDate(filters.service_date || filters.production_date);
  const mealType = normalizeMealServiceType(filters.meal_type);
  const menuType = normalizeMealServiceMenuType(
    filters.menu_type || filters.cuisine_type || filters.menu_cuisine
  );
  const menuCategory = normalizeMealServiceMenuCategory(filters.menu_category, menuType);
  if (!siteId) throw httpError('Select a location for produced-item availability');
  const {
    productionSiteIds,
    productionLocation
  } = await resolveMealServiceProductionScope(siteId, executor, location);
  let batches = await listMealServiceProducedItemBatchesForSites({
    siteIds: productionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    location: productionLocation,
    executor
  });
  batches = await backfillProducedItemBatchesForCompletedProductions({
    siteId,
    productionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    batches,
    executor,
    location: productionLocation
  });
  const eligibleBatches = batches.filter((batch) => (
    isRoutineMealServiceBatch(batch)
    &&
    AVAILABLE_BATCH_STATUSES.has(String(batch.status || '').toLowerCase())
    && getBatchAvailableWeight(batch) > QUANTITY_EPSILON
    && number(batch.portion_size_grams, 0) > 0
  ));
  const items = groupMealServiceProducedDishes(eligibleBatches);
  const scopeKey = buildMealServiceScopeKey({
    site_id: siteId, service_date: serviceDate, meal_type: mealType,
    menu_type: menuType, menu_category: menuCategory
  });
  const availabilitySnapshot = buildMealServiceAvailabilitySnapshot({
    site_id: siteId,
    service_date: serviceDate,
    meal_type: mealType,
    menu_type: menuType,
    menu_category: menuCategory
  }, eligibleBatches);
  const confirmations = (await listDocuments('MealServiceAttendance', {
    filters: { scope_key: scopeKey }, sort: '-recorded_at', limit: 100, location
  }, executor || undefined)).filter((entry) => entry.status !== 'reversed');
  const confirmation = confirmations[0] || null;
  return {
    items,
    dishes: items,
    prepared_meals: items,
    available_recipes: items,
    production_scope: {
      scope_key: scopeKey,
      menu_type: menuType,
      menu_category: menuCategory,
      meal_type: mealType,
      production_site_ids: productionSiteIds
    },
    availability_snapshot: availabilitySnapshot,
    confirmed: Boolean(confirmation),
    confirmation,
    confirmations,
    summary: {
      prepared_meal_count: items.length,
      recipe_count: items.length,
      batch_count: items.reduce((sum, item) => sum + item.batch_count, 0),
      available_covers: roundQuantity(items.reduce((sum, item) => sum + item.available_covers, 0)),
      available_weight_grams: roundQuantity(items.reduce((sum, item) => sum + item.available_weight_grams, 0))
    },
    cutover: {
      version: PRODUCED_ITEM_CUTOVER_VERSION,
      legacy_outputs_included: false,
      portion_policy: 'Covers consume the configured service portion weight from completed production output.'
    }
  };
}

async function updateMealServicePortionSizeWithExecutor(payload, actor, executor, { location = null } = {}) {
  const siteId = normalizeText(payload.site_id);
  const serviceDate = normalizeMealServiceDate(payload.service_date || payload.production_date);
  const mealType = normalizeMealServiceType(payload.meal_type);
  const menuType = normalizeMealServiceMenuType(payload.menu_type);
  const menuCategory = normalizeMealServiceMenuCategory(payload.menu_category, menuType);
  const recipeId = normalizeText(payload.recipe_id);
  if (!siteId) throw httpError('Select a location');
  if (!recipeId) throw httpError('Select a prepared dish');
  const portionSize = normalizeManualMealPortionSize(payload.service_portion_size_grams);
  const {
    productionSiteIds,
    productionLocation
  } = await resolveMealServiceProductionScope(siteId, executor, location);
  const scopeKey = buildMealServiceScopeKey({
    site_id: siteId, service_date: serviceDate, meal_type: mealType,
    menu_type: menuType, menu_category: menuCategory
  });
  await acquireMealServiceScopeLock(scopeKey, executor);
  const matchedBatches = await listMealServiceProducedItemBatchesForSites({
    siteIds: productionSiteIds,
    serviceDate,
    mealType,
    menuType,
    menuCategory,
    recipeId,
    lock: true,
    location: productionLocation,
    executor
  });
  const requestedBatchIds = normalizeProducedItemBatchIds(payload);
  const batches = selectMealServicePortionSizeUpdateBatches(matchedBatches, requestedBatchIds);
  if (batches.length === 0) throw httpError('No matching completed production output was found', 404);
  const updatedAt = nowIso();
  const updated = [];
  for (const batch of batches) {
    updated.push(await updateDocument('ProducedItemBatch', batch.id, {
      service_portion_size_grams: portionSize,
      service_portion_updated_by: actor.email || null,
      service_portion_updated_by_name: actor.full_name || actor.email || null,
      service_portion_updated_at: updatedAt
    }, executor));
  }
  return {
    scope_key: scopeKey,
    dish: groupMealServiceProducedDishes(updated)[0] || null,
    updated_batch_ids: updated.map((batch) => batch.id),
    previous_portion_sizes_grams: [...new Set(batches.map(getStoredServicePortionSize))],
    service_portion_size_grams: portionSize,
    updated_at: updatedAt
  };
}

export async function updateMealServicePortionSize(payload, actor, options = {}) {
  if (options.executor) {
    return updateMealServicePortionSizeWithExecutor(payload, actor, options.executor, options);
  }
  return withTransaction((client) => updateMealServicePortionSizeWithExecutor(payload, actor, client, options));
}

function sumMealServiceItemFields(items, fields) {
  return roundQuantity(items.reduce((sum, item) => {
    const field = fields.find((candidate) => (
      item[candidate] !== null && typeof item[candidate] !== 'undefined'
    ));
    return sum + number(field ? item[field] : 0, 0);
  }, 0));
}

export function buildMealServiceReportData({
  records = [],
  consumptionRecords = [],
  producedBatches = [],
  startDate = null,
  endDate = null,
  recipeId = '',
  menuPlanId = '',
  menuType = '',
  menuCategory = ''
} = {}) {
  const normalizedRecipeId = normalizeText(recipeId);
  const normalizedMenuPlanId = normalizeText(menuPlanId);
  const consumptionRowsByAttendance = new Map();
  const consumptionIdsByAttendance = new Map();
  consumptionRecords.filter((entry) => (
    (!normalizedMenuPlanId || String(entry.menu_plan_id || '') === normalizedMenuPlanId)
    && (!normalizedRecipeId || String(entry.recipe_id || '') === normalizedRecipeId)
  )).forEach((entry) => {
    const attendanceId = String(entry.meal_service_attendance_id || '');
    if (!consumptionRowsByAttendance.has(attendanceId)) consumptionRowsByAttendance.set(attendanceId, []);
    consumptionRowsByAttendance.get(attendanceId).push(entry);
    if (!consumptionIdsByAttendance.has(attendanceId)) consumptionIdsByAttendance.set(attendanceId, []);
    consumptionIdsByAttendance.get(attendanceId).push(entry.id);
  });
  const rows = records.filter((record) => {
    if (normalizedMenuPlanId && String(record.menu_plan_id || '') !== normalizedMenuPlanId) return false;
    if (startDate && record.service_date < startDate) return false;
    if (endDate && record.service_date > endDate) return false;
    if (
      normalizedRecipeId
      && !(record.items || []).some((item) => String(item.recipe_id || '') === normalizedRecipeId)
    ) return false;
    return true;
  }).map((record) => {
    const allItems = Array.isArray(record.items) ? record.items : [];
    const reportItems = normalizedRecipeId
      ? allItems.filter((item) => String(item.recipe_id || '') === normalizedRecipeId)
      : allItems;
    const filteredTotal = (fields) => sumMealServiceItemFields(reportItems, fields);
    const useItemTotals = Boolean(normalizedRecipeId);
    const requiredMealPortions = useItemTotals
      ? filteredTotal(['required_servings'])
      : number(record.required_servings, 0);
    const shortMealPortions = useItemTotals
      ? filteredTotal(['shortage_servings', 'short_servings'])
      : number(record.shortage_servings, 0);
    const consumptionRows = consumptionRowsByAttendance.get(String(record.id)) || [];
    const hasLedgerRows = consumptionRows.some((entry) => (
      Number.isFinite(Number(entry.consumed_weight_grams))
      || Number.isFinite(Number(entry.consumed_servings))
      || Number.isFinite(Number(entry.consumed_production_equivalent_servings))
    ));
    const plateWasteRows = consumptionRows.filter((entry) => (
      normalizeText(entry.movement_type) === 'plate_waste_adjustment'
      || normalizeText(entry.source_type) === 'food_waste_plate_waste'
    ));
    const servedMealPortions = hasLedgerRows
      ? sumMealServiceItemFields(consumptionRows, ['consumed_servings'])
      : useItemTotals
        ? filteredTotal(['allocated_servings', 'served_servings'])
        : number(record.served_servings, 0);
    const servedProductionEquivalentServings = hasLedgerRows
      ? sumMealServiceItemFields(consumptionRows, [
        'consumed_production_equivalent_servings',
        'consumed_servings'
      ])
      : filteredTotal([
        'allocated_production_equivalent_servings',
        'consumed_production_equivalent_servings',
        'allocated_servings',
        'served_servings'
      ]);
    const servedWeightGrams = hasLedgerRows
      ? sumMealServiceItemFields(consumptionRows, ['consumed_weight_grams'])
      : useItemTotals
        ? filteredTotal(['allocated_weight_grams', 'served_weight_grams'])
        : number(record.served_weight_grams, 0);
    const plateWasteWeightGrams = Math.abs(sumMealServiceItemFields(plateWasteRows, ['consumed_weight_grams']));

    return {
      attendance_id: record.id,
      service_reference: record.service_reference,
      service_date: record.service_date,
      site_id: record.site_id,
      site_name: record.site_name,
      meal_type: record.meal_type,
      menu_plan_id: record.menu_plan_id,
      menu_plan_name: record.menu_plan_name,
      menu_type: record.menu_type,
      menu_category: record.menu_category,
      customer_meal_plan_id: record.customer_meal_plan_id,
      customer_name: record.customer_name,
      customer_id: record.customer_id,
      category: record.category,
      attendee_count: record.attendee_count,
      status: record.status,
      recorded_by: record.recorded_by,
      recorded_by_name: record.recorded_by_name,
      recorded_at: record.recorded_at,
      reversed_by: record.reversed_by,
      reversed_by_name: record.reversed_by_name,
      reversed_at: record.reversed_at,
      reversal_reason: record.reversal_reason,
      required_meal_portions: requiredMealPortions,
      served_meal_portions: servedMealPortions,
      served_production_equivalent_servings: servedProductionEquivalentServings,
      short_meal_portions: shortMealPortions,
      required_servings: requiredMealPortions,
      required_weight_grams: useItemTotals
        ? filteredTotal(['required_weight_grams'])
        : record.required_weight_grams,
      served_servings: servedMealPortions,
      served_weight_grams: servedWeightGrams,
      gross_served_weight_grams: useItemTotals
        ? filteredTotal(['allocated_weight_grams', 'served_weight_grams'])
        : number(record.served_weight_grams, servedWeightGrams),
      plate_waste_weight_grams: plateWasteWeightGrams,
      plate_waste_adjustment_count: plateWasteRows.length,
      short_servings: shortMealPortions,
      short_weight_grams: useItemTotals
        ? filteredTotal(['shortage_weight_grams', 'short_weight_grams'])
        : record.shortage_weight_grams,
      items: reportItems,
      consumption_ids: consumptionIdsByAttendance.get(String(record.id)) || []
    };
  });
  const activeRows = rows.filter((row) => row.status !== 'reversed');
  const reportBatches = producedBatches.filter((batch) => {
    const sourceType = normalizeText(batch.source_type).toLowerCase();
    if (
      normalizeText(batch.source_event_id)
      || ['special_event', 'event', 'auto_schedule_unlinked'].includes(sourceType)
    ) return false;
    if (!MEAL_TYPES.has(String(batch.meal_type || '').toLowerCase())) return false;
    if (startDate && batch.production_date < startDate) return false;
    if (endDate && batch.production_date > endDate) return false;
    if (normalizedRecipeId && String(batch.recipe_id || '') !== normalizedRecipeId) return false;
    if (normalizedMenuPlanId && String(batch.menu_plan_id || '') !== normalizedMenuPlanId) return false;
    if (menuType && normalizeMenuCuisine(batch.menu_type || batch.cuisine_type, '') !== menuType) return false;
    if (menuCategory && normalizeMenuCategory(batch.menu_category, '') !== menuCategory) return false;
    return true;
  });
  const producedProductionEquivalentServings = roundQuantity(
    reportBatches.reduce((sum, batch) => sum + number(batch.produced_servings, 0), 0)
  );
  const remainingProductionEquivalentServings = roundQuantity(
    reportBatches.reduce((sum, batch) => sum + number(batch.remaining_servings, 0), 0)
  );
  const requiredMealPortions = roundQuantity(
    activeRows.reduce((sum, row) => sum + number(row.required_meal_portions, 0), 0)
  );
  const servedMealPortions = roundQuantity(
    activeRows.reduce((sum, row) => sum + number(row.served_meal_portions, 0), 0)
  );
  const servedProductionEquivalentServings = roundQuantity(
    activeRows.reduce((sum, row) => sum + number(row.served_production_equivalent_servings, 0), 0)
  );
  const shortMealPortions = roundQuantity(
    activeRows.reduce((sum, row) => sum + number(row.short_meal_portions, 0), 0)
  );
  return {
    rows,
    summary: {
      attendance_records: rows.length,
      completed_records: activeRows.length,
      reversed_records: rows.length - activeRows.length,
      attendee_count: activeRows.reduce((sum, row) => sum + number(row.attendee_count, 0), 0),
      measurement_basis: {
        authoritative: 'weight_grams',
        meal_portions: 'customer-entered portion size',
        production_equivalent_servings: 'frozen production serving size'
      },
      produced_production_equivalent_servings: producedProductionEquivalentServings,
      remaining_production_equivalent_servings: remainingProductionEquivalentServings,
      required_meal_portions: requiredMealPortions,
      served_meal_portions: servedMealPortions,
      served_production_equivalent_servings: servedProductionEquivalentServings,
      short_meal_portions: shortMealPortions,
      // Compatibility aliases. Produced/remaining are production equivalents;
      // required/served/short are customer-entered meal portions.
      produced_servings: producedProductionEquivalentServings,
      produced_weight_grams: roundQuantity(reportBatches.reduce((sum, batch) => sum + number(batch.produced_weight_grams, 0), 0)),
      required_servings: requiredMealPortions,
      required_weight_grams: roundQuantity(activeRows.reduce((sum, row) => sum + number(row.required_weight_grams, 0), 0)),
      served_servings: servedMealPortions,
      served_weight_grams: roundQuantity(activeRows.reduce((sum, row) => sum + number(row.served_weight_grams, 0), 0)),
      remaining_servings: remainingProductionEquivalentServings,
      remaining_weight_grams: roundQuantity(reportBatches.reduce((sum, batch) => sum + number(batch.remaining_weight_grams, 0), 0)),
      short_servings: shortMealPortions,
      short_weight_grams: roundQuantity(activeRows.reduce((sum, row) => sum + number(row.short_weight_grams, 0), 0))
    }
  };
}

export async function listMealServiceReportPages(
  entity,
  queryOptions = {},
  {
    executor = null,
    listDocumentsFn = listDocuments,
    pageSize = MEAL_SERVICE_REPORT_PAGE_SIZE
  } = {}
) {
  const normalizedPageSize = Number(pageSize);
  if (!Number.isInteger(normalizedPageSize) || normalizedPageSize < 1 || normalizedPageSize > 10000) {
    throw new TypeError('Meal-service report page size must be an integer from 1 to 10000');
  }

  const rows = [];
  for (let offset = 0; ; offset += normalizedPageSize) {
    const page = await listDocumentsFn(entity, {
      ...queryOptions,
      limit: normalizedPageSize,
      offset
    }, executor || undefined);
    if (!Array.isArray(page) || page.length > normalizedPageSize) {
      throw new TypeError('Meal-service report page query returned an invalid result');
    }
    rows.push(...page);
    if (page.length < normalizedPageSize) break;
  }
  return rows;
}

export async function getMealServiceReport(filters = {}, {
  executor = null,
  location = null,
  listDocumentsFn = listDocuments,
  reportPageSize = MEAL_SERVICE_REPORT_PAGE_SIZE
} = {}) {
  const siteId = normalizeText(filters.site_id);
  const mealType = normalizeText(filters.meal_type).toLowerCase();
  const recipeId = normalizeText(filters.recipe_id);
  const menuPlanId = normalizeText(filters.menu_plan_id);
  const requestedMenuType = normalizeText(filters.menu_type || filters.cuisine_type || filters.menu_cuisine);
  const menuType = requestedMenuType ? normalizeMealServiceMenuType(requestedMenuType) : '';
  const requestedMenuCategory = normalizeText(filters.menu_category);
  const menuCategory = requestedMenuCategory
    ? normalizeMealServiceMenuCategory(requestedMenuCategory, menuType || 'general')
    : '';
  if (mealType && !MEAL_TYPES.has(mealType)) throw httpError('Invalid meal type');
  const startDate = filters.start_date ? normalizeMealServiceDate(filters.start_date, 'Start date') : null;
  const endDate = filters.end_date ? normalizeMealServiceDate(filters.end_date, 'End date') : null;
  if (startDate && endDate && startDate > endDate) throw httpError('Start date cannot be after end date');
  if (siteId) await resolveProjectServiceSite(siteId, executor);
  const dateRange = (field) => ({
    [field]: {
      ...(startDate ? { gte: startDate } : {}),
      ...(endDate ? { lte: endDate } : {})
    }
  });
  const pagingOptions = { executor, listDocumentsFn, pageSize: reportPageSize };
  const [records, consumptionRecords, producedBatches] = await Promise.all([
    listMealServiceReportPages('MealServiceAttendance', {
      filters: {
        ...(siteId ? { site_id: siteId } : {}),
        ...(mealType ? { meal_type: mealType } : {}),
        ...(menuType ? { menu_type: menuType } : {}),
        ...(menuCategory ? { menu_category: menuCategory } : {}),
        ...(menuPlanId ? { menu_plan_id: menuPlanId } : {}),
        ...(filters.customer_meal_plan_id ? { customer_meal_plan_id: filters.customer_meal_plan_id } : {})
      },
      rangeFilters: dateRange('service_date'),
      sort: '-service_date',
      location
    }, pagingOptions),
    listMealServiceReportPages('MealServiceConsumption', {
      filters: {
        ...(siteId ? { site_id: siteId } : {}),
        ...(mealType ? { meal_type: mealType } : {}),
        ...(menuType ? { menu_type: menuType } : {}),
        ...(menuCategory ? { menu_category: menuCategory } : {}),
        ...(menuPlanId ? { menu_plan_id: menuPlanId } : {}),
        ...(recipeId ? { recipe_id: recipeId } : {})
      },
      rangeFilters: dateRange('service_date'),
      sort: '-service_date',
      location
    }, pagingOptions),
    listMealServiceReportPages('ProducedItemBatch', {
      filters: {
        ...(siteId ? { site_id: siteId } : {}),
        ...(mealType ? { meal_type: mealType } : {}),
        ...(menuType ? { menu_type: menuType } : {}),
        ...(menuCategory ? { menu_category: menuCategory } : {}),
        ...(menuPlanId ? { menu_plan_id: menuPlanId } : {}),
        ...(recipeId ? { recipe_id: recipeId } : {})
      },
      rangeFilters: dateRange('production_date'),
      sort: '-production_date',
      location
    }, pagingOptions)
  ]);
  const report = buildMealServiceReportData({
    records,
    consumptionRecords,
    producedBatches,
    startDate,
    endDate,
    recipeId,
    menuPlanId,
    menuType,
    menuCategory
  });
  return {
    ...report,
    cutover: {
      version: PRODUCED_ITEM_CUTOVER_VERSION,
      legacy_attendance_included: false,
      message: 'Attendance recorded before the produced-item cutover remains in DinerScan and is reporting-only.'
    }
  };
}

export { PRODUCED_ITEM_CUTOVER_VERSION };
