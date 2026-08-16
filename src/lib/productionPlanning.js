import {
  calculateProductionIngredientCost,
  convertIngredientQuantity
} from '../../shared/ingredientUnits.js';
import { calculateRecipeServingWeight } from '../../shared/recipeWeight.js';
import { formatRecipeQuantity } from '../../shared/recipeNumbers.js';

export const PRODUCTION_MEAL_PERIODS = Object.freeze([
  { key: 'breakfast', label: 'Breakfast', time_range: '7:00 AM – 10:00 AM' },
  { key: 'lunch', label: 'Lunch', time_range: '11:00 AM – 2:00 PM' },
  { key: 'dinner', label: 'Dinner', time_range: '4:30 PM – 7:30 PM' }
]);

const NON_DEMAND_STATUSES = new Set(['cancelled', 'rejected']);

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, decimals = 2) {
  const multiplier = 10 ** decimals;
  return Math.round((numberValue(value, 0) + Number.EPSILON) * multiplier) / multiplier;
}

function textValue(value) {
  return String(value || '').trim();
}

export function normalizeProductionMealType(value) {
  const normalized = textValue(value).toLowerCase();
  return PRODUCTION_MEAL_PERIODS.some((period) => period.key === normalized)
    ? normalized
    : 'other';
}

function resolveProductionCost(production, ingredientMap) {
  if (String(production?.status || '').toLowerCase() === 'completed') {
    const postedCost = production?.production_cost_total ?? production?.ingredient_cost_total;
    if (postedCost !== null && postedCost !== undefined && postedCost !== '') {
      return round(postedCost);
    }
  }

  const calculated = (Array.isArray(production?.ingredients_used) ? production.ingredients_used : [])
    .reduce((sum, line) => (
      sum + calculateProductionIngredientCost(line, ingredientMap.get(String(line?.ingredient_id || '')))
    ), 0);

  return round(calculated || production?.estimated_batch_cost || 0);
}

function resolvePortionSize(production, recipe, recipes, ingredients) {
  const explicitLabel = textValue(
    production?.portion_size
      || recipe?.portion_size
      || recipe?.serving_size
  );
  if (explicitLabel) {
    return { label: explicitLabel, grams: null, is_complete: true, warnings: [] };
  }

  const explicitGrams = numberValue(
    production?.portion_size_grams
      ?? recipe?.portion_size_grams
      ?? recipe?.serving_weight_grams
      ?? recipe?.grams_per_serving,
    NaN
  );
  if (Number.isFinite(explicitGrams) && explicitGrams > 0) {
    return {
      label: `${formatRecipeQuantity(explicitGrams, 'g')} g`,
      grams: round(explicitGrams),
      is_complete: true,
      warnings: []
    };
  }

  const servingWeight = recipe
    ? calculateRecipeServingWeight(recipe, recipes, ingredients)
    : { is_complete: false, grams_per_serving: null, warnings: ['Recipe master data is unavailable.'] };
  return {
    label: servingWeight.is_complete
      ? `${formatRecipeQuantity(servingWeight.grams_per_serving, 'g')} g`
      : 'Not available',
    grams: servingWeight.is_complete ? round(servingWeight.grams_per_serving) : null,
    is_complete: servingWeight.is_complete,
    warnings: servingWeight.warnings || []
  };
}

function buildInventoryMap(inventory, ingredientMap) {
  const map = new Map();
  (Array.isArray(inventory) ? inventory : []).forEach((stock) => {
    const siteId = textValue(stock?.site_id);
    const ingredientId = textValue(stock?.ingredient_id);
    if (!siteId || !ingredientId) return;
    const ingredient = ingredientMap.get(ingredientId) || {};
    const targetUnit = ingredient.unit || stock.unit || 'unit';
    const key = `${siteId}::${ingredientId}`;
    const current = map.get(key) || {
      site_id: siteId,
      site_name: stock.site_name || '',
      ingredient_id: ingredientId,
      ingredient_name: stock.ingredient_name || ingredient.name || ingredientId,
      available_quantity: 0,
      unit: targetUnit
    };
    current.available_quantity += convertIngredientQuantity(
      stock.quantity,
      stock.unit || targetUnit,
      targetUnit,
      ingredient
    );
    map.set(key, current);
  });
  return map;
}

function buildShortages(productions, ingredientMap, inventoryMap) {
  const demandMap = new Map();

  productions.forEach((production) => {
    const workflowStatus = textValue(production?.status).toLowerCase();
    if (workflowStatus === 'completed' || NON_DEMAND_STATUSES.has(workflowStatus)) return;

    const siteId = textValue(production?.site_id);
    (Array.isArray(production?.ingredients_used) ? production.ingredients_used : []).forEach((line) => {
      const ingredientId = textValue(line?.ingredient_id);
      if (!siteId || !ingredientId) return;
      const ingredient = ingredientMap.get(ingredientId) || {};
      const inventoryRow = inventoryMap.get(`${siteId}::${ingredientId}`);
      const targetUnit = inventoryRow?.unit || ingredient.unit || line.unit || 'unit';
      const requiredQuantity = convertIngredientQuantity(
        line.actual_quantity ?? line.planned_quantity ?? line.adjusted_quantity ?? line.required_quantity ?? 0,
        line.unit || targetUnit,
        targetUnit,
        ingredient
      );
      const key = `${siteId}::${ingredientId}`;
      const demand = demandMap.get(key) || {
        site_id: siteId,
        site_name: production.site_name || inventoryRow?.site_name || '',
        ingredient_id: ingredientId,
        ingredient_name: line.ingredient_name || inventoryRow?.ingredient_name || ingredient.name || ingredientId,
        required_quantity: 0,
        available_quantity: numberValue(inventoryRow?.available_quantity, 0),
        unit: targetUnit,
        production_ids: new Set(),
        recipe_names: new Set()
      };
      demand.required_quantity += requiredQuantity;
      demand.production_ids.add(production.id);
      if (production.recipe_name) demand.recipe_names.add(production.recipe_name);
      demandMap.set(key, demand);
    });
  });

  return [...demandMap.values()]
    .map((demand) => ({
      ...demand,
      required_quantity: round(demand.required_quantity),
      available_quantity: round(demand.available_quantity),
      shortage_quantity: round(Math.max(0, demand.required_quantity - demand.available_quantity)),
      production_ids: [...demand.production_ids],
      recipe_names: [...demand.recipe_names]
    }))
    .filter((demand) => demand.shortage_quantity > 0)
    .sort((left, right) => right.shortage_quantity - left.shortage_quantity);
}

function resolvePrepStatus(production, hasShortage) {
  const status = textValue(production?.status).toLowerCase();
  if (status === 'completed') return { key: 'complete', label: 'Complete' };
  if (hasShortage || ['rejected', 'cancelled'].includes(status)) return { key: 'at_risk', label: 'At Risk' };
  if (status === 'in_progress') return { key: 'in_progress', label: 'In Progress' };
  return { key: 'pending', label: 'Pending' };
}

function buildLaborLoads(items) {
  const loads = Object.fromEntries(
    [...PRODUCTION_MEAL_PERIODS.map((period) => period.key), 'other']
      .map((mealType) => [mealType, { minutes: 0, hours: 0, share_percent: 0 }])
  );

  items.forEach((item) => {
    if (NON_DEMAND_STATUSES.has(item.workflow_status)) return;
    const recipeMinutes = Math.max(0, numberValue(item.recipe?.prep_time_minutes, 0))
      + Math.max(0, numberValue(item.recipe?.cook_time_minutes, 0));
    const minutesPerBatch = recipeMinutes > 0 ? recipeMinutes : 30;
    loads[item.meal_type].minutes += minutesPerBatch * item.batches_required;
  });

  const totalMinutes = Object.values(loads).reduce((sum, load) => sum + load.minutes, 0);
  Object.values(loads).forEach((load) => {
    load.minutes = Math.round(load.minutes);
    load.hours = round(load.minutes / 60, 1);
    load.share_percent = totalMinutes > 0 ? Math.round((load.minutes / totalMinutes) * 100) : 0;
  });
  return loads;
}

export function buildProductionPlanningDashboard({
  productions = [],
  recipes = [],
  ingredients = [],
  inventory = []
} = {}) {
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe?.id || ''), recipe]));
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient?.id || ''), ingredient]));
  const inventoryMap = buildInventoryMap(inventory, ingredientMap);
  const shortages = buildShortages(productions, ingredientMap, inventoryMap);

  const items = productions.map((production) => {
    const recipe = recipeMap.get(String(production?.recipe_id || '')) || null;
    const portions = Math.max(0, numberValue(production?.target_servings, 0));
    const batchYield = Math.max(1, numberValue(production?.batch_yield ?? recipe?.batch_yield ?? recipe?.servings, 1));
    const productionShortages = shortages.filter((shortage) => shortage.production_ids.includes(production.id));
    const workflowStatus = textValue(production?.status || 'planned').toLowerCase();
    const mealType = normalizeProductionMealType(production?.meal_type);
    return {
      id: production.id,
      production,
      recipe,
      recipe_name: production.recipe_name || recipe?.name || 'Unnamed dish',
      image_url: production.image_url || recipe?.image_url || '',
      meal_type: mealType,
      required_portions: portions,
      portion_size: resolvePortionSize(production, recipe, recipes, ingredients),
      batch_yield: batchYield,
      batches_required: portions > 0 ? Math.ceil(portions / batchYield) : 0,
      estimated_batch_cost: resolveProductionCost(production, ingredientMap),
      station: production.kitchen_station
        || production.assigned_station
        || production.station
        || recipe?.kitchen_station
        || recipe?.station
        || 'Unassigned',
      workflow_status: workflowStatus,
      prep_status: resolvePrepStatus(production, productionShortages.length > 0),
      shortages: productionShortages,
      notes: textValue(production.notes),
      counts_toward_plan: !NON_DEMAND_STATUSES.has(workflowStatus)
    };
  });

  const countedItems = items.filter((item) => item.counts_toward_plan);
  const sectionDefinitions = [
    ...PRODUCTION_MEAL_PERIODS,
    ...(countedItems.some((item) => item.meal_type === 'other')
      ? [{ key: 'other', label: 'Other Production', time_range: 'Outside core meal periods' }]
      : [])
  ];
  const sections = sectionDefinitions.map((period) => {
    const periodItems = countedItems.filter((item) => item.meal_type === period.key);
    return {
      ...period,
      items: periodItems,
      total_portions: periodItems.reduce((sum, item) => sum + item.required_portions, 0),
      total_recipes: periodItems.length
    };
  });
  const labor_loads = buildLaborLoads(items);

  return {
    items: countedItems,
    all_items: items,
    sections,
    shortages,
    labor_loads,
    summary: {
      total_portions: countedItems.reduce((sum, item) => sum + item.required_portions, 0),
      portions_by_meal: Object.fromEntries(sections.map((section) => [section.key, section.total_portions])),
      total_recipes: countedItems.length,
      total_batch_cost: round(countedItems.reduce((sum, item) => sum + item.estimated_batch_cost, 0)),
      shortage_count: shortages.length,
      at_risk_count: countedItems.filter((item) => item.prep_status.key === 'at_risk').length,
      plan_notes: countedItems
        .filter((item) => item.notes)
        .map((item) => ({ production_id: item.id, recipe_name: item.recipe_name, note: item.notes }))
    }
  };
}

export function buildProductionPlanExportRows(dashboard) {
  return (dashboard?.items || []).map((item) => ({
    production_date: item.production.production_date || '',
    site: item.production.site_name || '',
    meal_period: item.meal_type,
    dish_name: item.recipe_name,
    required_portions: item.required_portions,
    portion_size: item.portion_size.label,
    batch_yield: item.batch_yield,
    batches_required: item.batches_required,
    estimated_batch_cost: item.estimated_batch_cost,
    kitchen_station: item.station,
    prep_status: item.prep_status.label,
    workflow_status: item.workflow_status,
    shortages: item.shortages.map((shortage) => (
      `${shortage.ingredient_name}: ${formatRecipeQuantity(shortage.shortage_quantity, shortage.unit)} ${shortage.unit}`
    )).join('; '),
    ingredient_quantities: (item.recipe?.ingredients || []).map((line) => (
      `${line.ingredient_name || line.ingredient_id || 'Ingredient'}: ${formatRecipeQuantity(line.quantity, line.unit)} ${line.unit || ''}`.trim()
    )).join('; '),
    notes: item.notes
  }));
}
