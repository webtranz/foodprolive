import crypto from 'node:crypto';
import {
  listDocuments,
  createDocument,
  updateDocument,
  createAppLog
} from './db.js';
import { createPurchaseRequest } from './procurement.js';
import { filterRecordsByLocation, getLocationScope } from './locationScope.js';
import { expandRecipeIngredients } from '../shared/recipeComposition.js';
import { convertIngredientQuantity } from '../shared/ingredientUnits.js';
import { calculateYieldOutputQuantity } from '../shared/ingredientYield.js';
import { getItemCode } from '../shared/itemCode.js';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DEFAULT_CYCLE_DAYS = 7;
const DEFAULT_PREFERRED_WEEKDAY = 'thursday';

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function parseDateOnly(value) {
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getWeekdayIndex(preferredWeekday = DEFAULT_PREFERRED_WEEKDAY) {
  const normalized = String(preferredWeekday || DEFAULT_PREFERRED_WEEKDAY).trim().toLowerCase();
  const index = DAY_NAMES.indexOf(normalized);
  return index >= 0 ? index : 4;
}

function getNextOrSameWeekday(date, preferredWeekday = DEFAULT_PREFERRED_WEEKDAY) {
  const targetDay = getWeekdayIndex(preferredWeekday);
  const currentDay = date.getUTCDay();
  const offset = (targetDay - currentDay + 7) % 7;
  return addUtcDays(date, offset);
}

function buildCycleWindow(referenceDate, cycleDays = DEFAULT_CYCLE_DAYS, preferredWeekday = DEFAULT_PREFERRED_WEEKDAY) {
  const normalizedReference = normalizeDateOnly(referenceDate) || formatDateOnly(new Date());
  const parsedReference = parseDateOnly(normalizedReference) || parseDateOnly(formatDateOnly(new Date()));
  const safeCycleDays = Math.max(1, Math.round(toNumber(cycleDays, DEFAULT_CYCLE_DAYS)));
  const cycleStartDate = getNextOrSameWeekday(parsedReference, preferredWeekday);
  const cycleEndDate = addUtcDays(cycleStartDate, safeCycleDays - 1);
  const preferredRunDate = cycleStartDate;

  return {
    requested_run_date: formatDateOnly(parsedReference),
    preferred_run_date: formatDateOnly(preferredRunDate),
    cycle_start: formatDateOnly(cycleStartDate),
    cycle_end: formatDateOnly(cycleEndDate),
    cycle_days: safeCycleDays,
    preferred_weekday: DAY_NAMES[getWeekdayIndex(preferredWeekday)],
    is_preferred_day: parsedReference.getUTCDay() === getWeekdayIndex(preferredWeekday)
  };
}

function isOperationalMenuPlan(plan) {
  return !String(plan?.event_name || '').trim();
}

function normalizeMealRequirements(menuPlans = []) {
  return menuPlans.flatMap((plan) => {
    const planDate = normalizeDateOnly(plan.plan_date);
    return (Array.isArray(plan.meals) ? plan.meals : [])
      .filter((meal) => meal?.recipe_id && toNumber(meal.expected_servings, 0) > 0)
      .map((meal) => ({
        plan_date: planDate,
        meal_type: String(meal.meal_type || '').trim().toLowerCase(),
        recipe_id: meal.recipe_id,
        recipe_name: meal.recipe_name || '',
        expected_servings: toNumber(meal.expected_servings, 0)
      }));
  });
}

function aggregateMenuPlanRequirements(menuPlans = [], recipes = [], ingredients = []) {
  const recipeMap = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const ingredientMap = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const aggregation = new Map();
  const missingRecipes = [];
  const missingIngredients = [];

  normalizeMealRequirements(menuPlans).forEach((requirement) => {
    const recipe = recipeMap.get(requirement.recipe_id);
    if (!recipe) {
      missingRecipes.push(requirement.recipe_id);
      return;
    }

    const recipeServings = Math.max(1, toNumber(recipe.servings, 1));
    const multiplier = requirement.expected_servings / recipeServings;
    const recipeIngredients = expandRecipeIngredients(
      recipe,
      recipes,
      ingredients,
      { multiplier, aggregate: true }
    ).ingredients;

    recipeIngredients.forEach((recipeIngredient) => {
      if (!recipeIngredient?.ingredient_id) {
        return;
      }

      const ingredient = ingredientMap.get(recipeIngredient.ingredient_id);
      if (!ingredient) {
        missingIngredients.push(recipeIngredient.ingredient_id);
        return;
      }

      const inventoryUnit = ingredient.unit || recipeIngredient.unit || 'unit';
      const yieldOutput = calculateYieldOutputQuantity(recipeIngredient.quantity, ingredient);
      const normalizedRawQuantity = convertIngredientQuantity(
        toNumber(recipeIngredient.quantity, 0),
        recipeIngredient.unit || ingredient.unit,
        inventoryUnit,
        ingredient
      );
      const normalizedYieldedQuantity = convertIngredientQuantity(
        yieldOutput.yielded_quantity,
        recipeIngredient.unit || ingredient.unit,
        inventoryUnit,
        ingredient
      );

      const key = String(recipeIngredient.ingredient_id);
      const current = aggregation.get(key) || {
        ingredient_id: recipeIngredient.ingredient_id,
        item_code: getItemCode(ingredient, getItemCode(recipeIngredient, null)),
        ingredient_name: ingredient.name || recipeIngredient.ingredient_name || 'Unnamed ingredient',
        raw_requested_quantity: 0,
        net_requested_quantity: 0,
        requested_quantity: 0,
        unit: inventoryUnit,
        yield_multiplier: yieldOutput.yield_multiplier,
        yield_percent: yieldOutput.yield_percent,
        yield_source: yieldOutput.yield_source,
        estimated_unit_price: toNumber(ingredient.cost_per_unit, 0),
        linked_recipes: new Set(),
        linked_dates: new Set(),
        meal_types: new Set()
      };

      current.raw_requested_quantity += normalizedRawQuantity;
      current.net_requested_quantity += normalizedYieldedQuantity;
      current.requested_quantity += normalizedRawQuantity;
      current.linked_recipes.add(recipe.name || requirement.recipe_name || 'Unnamed recipe');
      current.linked_dates.add(requirement.plan_date);
      current.meal_types.add(requirement.meal_type);
      aggregation.set(key, current);
    });
  });

  const items = [...aggregation.values()]
    .map((item) => ({
      id: randomId('pri'),
      ingredient_id: item.ingredient_id,
      item_code: item.item_code,
      ingredient_name: item.ingredient_name,
      description: `Menu plan demand for ${[...item.linked_recipes].slice(0, 3).join(', ')}${item.linked_recipes.size > 3 ? ' and more' : ''}`,
      raw_requested_quantity: Number(item.raw_requested_quantity.toFixed(3)),
      net_requested_quantity: Number(item.net_requested_quantity.toFixed(3)),
      requested_quantity: Number(item.requested_quantity.toFixed(3)),
      unit: item.unit,
      yield_multiplier: Number(item.yield_multiplier.toFixed(6)),
      yield_percent: Number(item.yield_percent.toFixed(2)),
      yield_source: item.yield_source,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      estimated_unit_price: Number(item.estimated_unit_price.toFixed(2)),
      preferred_supplier_id: null,
      preferred_supplier_name: null,
      source_dates: [...item.linked_dates].sort(),
      meal_types: [...item.meal_types].sort()
    }))
    .filter((item) => item.ingredient_name && item.requested_quantity > 0)
    .sort((left, right) => left.ingredient_name.localeCompare(right.ingredient_name));

  return {
    items,
    missing_recipe_ids: [...new Set(missingRecipes)],
    missing_ingredient_ids: [...new Set(missingIngredients)]
  };
}

function buildRequestNumber(siteName, cycleStart) {
  const siteCode = String(siteName || 'SITE')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 8)
    .toUpperCase() || 'SITE';
  return `PR-MENU-${cycleStart.replace(/-/g, '')}-${siteCode}-${Date.now().toString().slice(-4)}`;
}

async function getMenuPlanPRScheduleConfig(user, siteId, referenceDate) {
  const scope = await getLocationScope(user);
  const configs = await listDocuments('MenuPlanPRSchedule', {
    filters: { site_id: siteId },
    limit: 20
  });
  const scopedConfigs = filterRecordsByLocation(user, 'MenuPlanPRSchedule', configs, scope);
  const config = scopedConfigs[0] || {
    site_id: siteId,
    cycle_days: DEFAULT_CYCLE_DAYS,
    preferred_weekday: DEFAULT_PREFERRED_WEEKDAY,
    is_active: true
  };

  return {
    ...config,
    ...buildCycleWindow(referenceDate, config.cycle_days, config.preferred_weekday)
  };
}

async function listMenuPlanPRRuns(user, siteId, limit = 20) {
  const scope = await getLocationScope(user);
  const runs = await listDocuments('MenuPlanPRRun', {
    filters: siteId ? { site_id: siteId } : {},
    sort: '-created_date',
    limit: Math.max(1, Math.min(200, Math.round(toNumber(limit, 20))))
  });
  return filterRecordsByLocation(user, 'MenuPlanPRRun', runs, scope);
}

function findExistingSuccessfulCycleRun(runs = [], cycleStart, cycleEnd) {
  return (Array.isArray(runs) ? runs : []).find((run) => (
    run?.cycle_start === cycleStart &&
    run?.cycle_end === cycleEnd &&
    ['generated', 'duplicate_prevented'].includes(String(run?.status || '').toLowerCase())
  )) || null;
}

async function getMenuPlanPRContext(user, siteId, referenceDate) {
  const scope = await getLocationScope(user);
  if (user?.role !== 'admin' && !scope.accessibleSiteIds.has(String(siteId || '').trim())) {
    const error = new Error('You do not have access to this project.');
    error.status = 403;
    throw error;
  }

  const schedule = await getMenuPlanPRScheduleConfig(user, siteId, referenceDate);
  const runs = await listMenuPlanPRRuns(user, siteId, 20);
  const cycleRun = runs.find((run) => run.cycle_start === schedule.cycle_start && run.cycle_end === schedule.cycle_end) || null;
  return {
    schedule,
    current_cycle_run: cycleRun,
    recent_runs: runs
  };
}

async function saveMenuPlanPRScheduleConfig(user, payload = {}) {
  const siteId = String(payload.site_id || '').trim();
  const siteName = String(payload.site_name || '').trim();

  if (!siteId || !siteName) {
    const error = new Error('Project is required for PR schedule configuration.');
    error.status = 400;
    throw error;
  }

  const scope = await getLocationScope(user);
  if (user?.role !== 'admin' && !scope.accessibleSiteIds.has(siteId)) {
    const error = new Error('You do not have access to this project.');
    error.status = 403;
    throw error;
  }

  const existingConfigs = await listDocuments('MenuPlanPRSchedule', {
    filters: { site_id: siteId },
    limit: 20
  });
  const existing = existingConfigs[0] || null;
  const record = {
    site_id: siteId,
    site_name: siteName,
    cycle_days: Math.max(1, Math.round(toNumber(payload.cycle_days, DEFAULT_CYCLE_DAYS))),
    preferred_weekday: String(payload.preferred_weekday || DEFAULT_PREFERRED_WEEKDAY).trim().toLowerCase(),
    is_active: payload.is_active !== false,
    notes: String(payload.notes || '').trim() || null
  };

  if (existing) {
    return updateDocument('MenuPlanPRSchedule', existing.id, record);
  }

  return createDocument('MenuPlanPRSchedule', record);
}

async function generatePurchaseRequestFromMenuPlans(user, payload = {}) {
  const siteId = String(payload.site_id || '').trim();
  const siteName = String(payload.site_name || '').trim();
  const referenceDate = normalizeDateOnly(payload.reference_date) || formatDateOnly(new Date());

  if (!siteId || !siteName) {
    const error = new Error('Project is required to generate a PR.');
    error.status = 400;
    throw error;
  }

  const scope = await getLocationScope(user);
  if (user?.role !== 'admin' && !scope.accessibleSiteIds.has(siteId)) {
    const error = new Error('You do not have access to this project.');
    error.status = 403;
    throw error;
  }

  const schedule = await getMenuPlanPRScheduleConfig(user, siteId, referenceDate);
  if (schedule.is_active === false) {
    const error = new Error('Menu plan PR generation is disabled for this project.');
    error.status = 400;
    throw error;
  }

  const existingRuns = await listMenuPlanPRRuns(user, siteId, 200);
  const existingSuccessfulRun = findExistingSuccessfulCycleRun(existingRuns, schedule.cycle_start, schedule.cycle_end);

  if (existingSuccessfulRun) {
    return {
      duplicate_prevented: true,
      run: existingSuccessfulRun,
      schedule
    };
  }

  const [menuPlans, recipes, ingredients] = await Promise.all([
    listDocuments('MenuPlan', { filters: { site_id: siteId }, limit: 2000 }),
    listDocuments('Recipe', { limit: 4000 }),
    listDocuments('Ingredient', { limit: 4000 })
  ]);

  const scopedPlans = filterRecordsByLocation(user, 'MenuPlan', menuPlans, scope)
    .filter(isOperationalMenuPlan)
    .filter((plan) => {
      const planDate = normalizeDateOnly(plan.plan_date);
      return planDate >= schedule.cycle_start && planDate <= schedule.cycle_end;
    });

  const { items, missing_recipe_ids, missing_ingredient_ids } = aggregateMenuPlanRequirements(scopedPlans, recipes, ingredients);

  if (!items.length) {
    const run = await createDocument('MenuPlanPRRun', {
      site_id: siteId,
      site_name: siteName,
      cycle_start: schedule.cycle_start,
      cycle_end: schedule.cycle_end,
      preferred_run_date: schedule.preferred_run_date,
      requested_run_date: schedule.requested_run_date,
      cycle_days: schedule.cycle_days,
      preferred_weekday: schedule.preferred_weekday,
      status: 'skipped',
      trigger_type: payload.trigger_type || 'manual',
      notes: 'No menu planning demand found for the selected cycle.',
      generated_item_count: 0,
      missing_recipe_ids,
      missing_ingredient_ids
    });

    await createAppLog({
      page_name: 'MenuPlanningPRGeneration',
      user_id: user?.id,
      user_email: user?.email,
      payload: {
        action: 'skip_generation',
        site_id: siteId,
        cycle_start: schedule.cycle_start,
        cycle_end: schedule.cycle_end
      }
    });

    return {
      duplicate_prevented: false,
      run,
      schedule
    };
  }

  const request = await createPurchaseRequest({
    request_number: buildRequestNumber(siteName, schedule.cycle_start),
    site_id: siteId,
    site_name: siteName,
    request_date: schedule.preferred_run_date,
    needed_by: schedule.cycle_start,
    priority: 'normal',
    status: 'pending',
    approval_role: 'manager',
    auto_generated: true,
    source_type: 'menu_plan_cycle',
    notes: `Auto-generated from menu planning cycle ${schedule.cycle_start} to ${schedule.cycle_end}`,
    items
  }, user);

  const run = await createDocument('MenuPlanPRRun', {
    site_id: siteId,
    site_name: siteName,
    cycle_start: schedule.cycle_start,
    cycle_end: schedule.cycle_end,
    preferred_run_date: schedule.preferred_run_date,
    requested_run_date: schedule.requested_run_date,
    cycle_days: schedule.cycle_days,
    preferred_weekday: schedule.preferred_weekday,
    status: 'generated',
    trigger_type: payload.trigger_type || 'manual',
    generated_pr_id: request.id,
    generated_pr_number: request.request_number,
    generated_request_id: request.id,
    generated_request_number: request.request_number,
    generated_item_count: items.length,
    total_estimated_cost: request.total_estimated_cost,
    notes: request.notes,
    missing_recipe_ids,
    missing_ingredient_ids
  });

  await createAppLog({
    page_name: 'MenuPlanningPRGeneration',
    user_id: user?.id,
    user_email: user?.email,
    payload: {
      action: 'generate_pr',
      site_id: siteId,
      generated_pr_id: request.id,
      cycle_start: schedule.cycle_start,
      cycle_end: schedule.cycle_end
    }
  });

  return {
    duplicate_prevented: false,
    run,
    purchase_request: request,
    schedule
  };
}

export {
  DAY_NAMES,
  DEFAULT_CYCLE_DAYS,
  DEFAULT_PREFERRED_WEEKDAY,
  buildCycleWindow,
  aggregateMenuPlanRequirements,
  findExistingSuccessfulCycleRun,
  getMenuPlanPRScheduleConfig,
  getMenuPlanPRContext,
  listMenuPlanPRRuns,
  saveMenuPlanPRScheduleConfig,
  generatePurchaseRequestFromMenuPlans
};
