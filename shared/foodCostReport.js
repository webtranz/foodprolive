import { calculateProductionIngredientCost } from './ingredientUnits.js';

const EPSILON = 0.000001;

export function safeFoodCostNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function roundFoodCostNumber(value, decimals = 2) {
  return Number(safeFoodCostNumber(value).toFixed(decimals));
}

function normalizeText(value) {
  return String(value || '').trim();
}

export function titleCaseFoodCost(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function finiteValue(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFinite(values = [], fallback = null) {
  for (const value of values) {
    const numeric = finiteValue(value);
    if (numeric !== null) return numeric;
  }
  return fallback;
}

function firstPositive(values = [], fallback = 0) {
  for (const value of values) {
    const numeric = finiteValue(value);
    if (numeric !== null && numeric > EPSILON) return numeric;
  }
  return fallback;
}

function ingredientMapFromRecords(records = []) {
  return Object.fromEntries(
    (Array.isArray(records) ? records : [])
      .filter((record) => record?.id)
      .map((record) => [String(record.id), record])
  );
}

export function getProductionOutputWeightGrams(production = {}) {
  return firstPositive([
    production.produced_weight_grams,
    production.actual_finished_weight_grams,
    production.expected_finished_weight_grams,
    production.finished_weight_grams,
    production.yielded_weight_grams
  ]);
}

function calculateProductionLineCost(production = {}, ingredientMap = {}) {
  const completionLineCost = (Array.isArray(production.completion_lines) ? production.completion_lines : [])
    .reduce((sum, line) => sum + safeFoodCostNumber(line.posted_cost ?? line.total_cost ?? line.cost), 0);
  if (completionLineCost > EPSILON) return completionLineCost;

  return (Array.isArray(production.ingredients_used) ? production.ingredients_used : [])
    .reduce((sum, line) => sum + calculateProductionIngredientCost(
      line,
      ingredientMap[String(line?.ingredient_id || '')]
    ), 0);
}

export function getProductionOutputCost(production = {}, ingredientMap = {}) {
  return firstPositive([
    production.total_cost,
    production.production_cost_total,
    production.ingredient_cost_total,
    production.total_consumption_cost,
    production.actual_cost,
    calculateProductionLineCost(production, ingredientMap),
    production.estimated_batch_cost,
    production.estimated_total_cost,
    production.yield_total_cost,
    production.planned_total_cost,
    production.estimated_cost,
    production.production_cost
  ]);
}

export function buildFoodCostIndexes({
  productions = [],
  producedItemBatches = [],
  ingredients = []
} = {}) {
  const ingredientMap = ingredientMapFromRecords(ingredients);
  const productionMap = new Map(
    (Array.isArray(productions) ? productions : [])
      .filter((production) => production?.id)
      .map((production) => [String(production.id), production])
  );
  const batchMap = new Map(
    (Array.isArray(producedItemBatches) ? producedItemBatches : [])
      .filter((batch) => batch?.id)
      .map((batch) => [String(batch.id), batch])
  );
  const productionCostPerGram = new Map();
  productionMap.forEach((production, id) => {
    const cost = getProductionOutputCost(production, ingredientMap);
    const weight = getProductionOutputWeightGrams(production);
    if (cost > EPSILON && weight > EPSILON) {
      productionCostPerGram.set(id, cost / weight);
    }
  });

  const batchCostPerGram = new Map();
  batchMap.forEach((batch, id) => {
    const production = productionMap.get(String(batch.production_id || '')) || {};
    const cost = firstPositive([
      getProductionOutputCost(batch, ingredientMap),
      getProductionOutputCost(production, ingredientMap)
    ]);
    const weight = firstPositive([
      getProductionOutputWeightGrams(batch),
      getProductionOutputWeightGrams(production)
    ]);
    if (cost > EPSILON && weight > EPSILON) {
      batchCostPerGram.set(id, cost / weight);
    }
  });

  return {
    ingredientMap,
    productionMap,
    batchMap,
    productionCostPerGram,
    batchCostPerGram
  };
}

function getConsumptionAllocations(consumption = {}) {
  return Array.isArray(consumption.allocations) ? consumption.allocations : [];
}

function getMealServiceMovementType(consumption = {}) {
  return String(consumption.movement_type || 'consumption').trim().toLowerCase();
}

function getReversalSourceConsumptionId(consumption = {}) {
  return normalizeText(
    consumption.reverses_consumption_id
      || consumption.source_consumption_id
      || consumption.original_consumption_id
  );
}

function getReversedMealServiceConsumptionIds(consumptions = []) {
  const reversedIds = new Set();
  (Array.isArray(consumptions) ? consumptions : []).forEach((consumption) => {
    if (getMealServiceMovementType(consumption) !== 'reversal') return;
    const sourceId = getReversalSourceConsumptionId(consumption);
    if (sourceId) reversedIds.add(sourceId);
  });
  return reversedIds;
}

function isActiveConfirmedMealServiceConsumption(consumption = {}, reversedConsumptionIds = new Set()) {
  const movementType = getMealServiceMovementType(consumption);
  if (movementType === 'reversal') return false;
  const id = normalizeText(consumption.id);
  if (id && reversedConsumptionIds.has(id)) return false;
  const sourceId = getReversalSourceConsumptionId(consumption);
  if (sourceId && reversedConsumptionIds.has(sourceId)) return false;
  return true;
}

function getAllocationBatchId(allocation = {}) {
  return normalizeText(
    allocation.produced_item_batch_id
      || allocation.batch_id
      || allocation.produced_batch_id
  );
}

function getAllocationProductionId(allocation = {}, indexes = {}) {
  const productionId = normalizeText(allocation.production_id);
  if (productionId) return productionId;
  const batchId = getAllocationBatchId(allocation);
  return normalizeText(indexes.batchMap?.get(batchId)?.production_id);
}

function getSignedAllocationWeightGrams(allocation = {}) {
  return firstFinite([
    allocation.weight_grams,
    allocation.consumed_weight_grams,
    allocation.allocated_weight_grams,
    allocation.wasted_weight_grams
  ], 0);
}

function getExplicitCost(record = {}) {
  return firstFinite([
    record.consumed_cost,
    record.total_cost,
    record.estimated_cost,
    record.cost,
    record.estimated_cost_total
  ]);
}

function getAllocationCost(allocation = {}, indexes = {}) {
  const explicit = getExplicitCost(allocation);
  if (explicit !== null) return explicit;

  const weightGrams = getSignedAllocationWeightGrams(allocation);
  if (Math.abs(weightGrams) <= EPSILON) return 0;
  const batchId = getAllocationBatchId(allocation);
  const productionId = getAllocationProductionId(allocation, indexes);
  const costPerGram = firstPositive([
    allocation.estimated_cost_per_gram,
    allocation.cost_per_gram,
    batchId ? indexes.batchCostPerGram?.get(batchId) : 0,
    productionId ? indexes.productionCostPerGram?.get(productionId) : 0
  ]);
  return weightGrams * costPerGram;
}

export function calculateMealServiceConsumptionCost(consumption = {}, indexes = {}) {
  const explicit = getExplicitCost(consumption);
  if (explicit !== null) return roundFoodCostNumber(explicit);

  const allocations = getConsumptionAllocations(consumption);
  if (!allocations.length) return 0;
  return roundFoodCostNumber(
    allocations.reduce((sum, allocation) => sum + getAllocationCost(allocation, indexes), 0)
  );
}

export function getCommittedMealServiceServings(consumption = {}) {
  const movementType = String(consumption.movement_type || 'consumption').toLowerCase();
  if (movementType === 'plate_waste_adjustment') return 0;

  const covers = finiteValue(consumption.covers);
  if (covers !== null && covers > 0) {
    return movementType === 'reversal' ? -Math.abs(covers) : covers;
  }

  const servings = firstFinite([
    consumption.consumed_servings,
    consumption.served_servings,
    consumption.required_servings
  ], 0);
  return movementType === 'reversal' ? -Math.abs(servings) : servings;
}

export function getMealServiceNetWeightGrams(consumption = {}) {
  return firstFinite([
    consumption.consumed_weight_grams,
    consumption.served_weight_grams,
    consumption.required_weight_grams
  ], 0);
}

export function buildConfirmedFoodCostRows({
  consumptions = [],
  productions = [],
  producedItemBatches = [],
  recipes = [],
  ingredients = []
} = {}) {
  const indexes = buildFoodCostIndexes({ productions, producedItemBatches, ingredients });
  const recipeMap = new Map(
    (Array.isArray(recipes) ? recipes : [])
      .filter((recipe) => recipe?.id)
      .map((recipe) => [String(recipe.id), recipe])
  );
  const reversedConsumptionIds = getReversedMealServiceConsumptionIds(consumptions);

  return (Array.isArray(consumptions) ? consumptions : [])
    .filter((consumption) => isActiveConfirmedMealServiceConsumption(consumption, reversedConsumptionIds))
    .map((consumption) => {
      const servings = getCommittedMealServiceServings(consumption);
      const totalCost = calculateMealServiceConsumptionCost(consumption, indexes);
      const consumedWeightGrams = getMealServiceNetWeightGrams(consumption);
      const recipe = recipeMap.get(String(consumption.recipe_id || '')) || {};
      return {
        date: consumption.service_date,
        location: consumption.site_name,
        meal_type: titleCaseFoodCost(consumption.meal_type || 'unspecified'),
        menu_type: titleCaseFoodCost(consumption.menu_type || recipe.menu_type || recipe.cuisine_type || 'General'),
        recipe: consumption.recipe_name,
        category: consumption.menu_category || recipe.category || '-',
        servings: roundFoodCostNumber(servings, 3),
        portion_size_g: roundFoodCostNumber(consumption.portion_size_grams, 2),
        served_weight_kg: roundFoodCostNumber(consumedWeightGrams / 1000, 3),
        total_cost: totalCost,
        cost_per_serving: Number((servings > 0 ? totalCost / servings : 0).toFixed(2)),
        source: 'Meal Service confirmed'
      };
    })
    .filter((row) => (
      Math.abs(safeFoodCostNumber(row.servings)) > EPSILON
      || Math.abs(safeFoodCostNumber(row.served_weight_kg)) > EPSILON
      || Math.abs(safeFoodCostNumber(row.total_cost)) > EPSILON
    ));
}

function getProductionIdsFromMealServiceRows(consumptions = [], producedItemBatches = []) {
  const batchMap = new Map(
    (Array.isArray(producedItemBatches) ? producedItemBatches : [])
      .filter((batch) => batch?.id)
      .map((batch) => [String(batch.id), batch])
  );
  const netWeightByProductionId = new Map();
  (Array.isArray(consumptions) ? consumptions : []).forEach((consumption) => {
    getConsumptionAllocations(consumption).forEach((allocation) => {
      const batchId = getAllocationBatchId(allocation);
      const productionId = normalizeText(
        allocation.production_id
          || batchMap.get(batchId)?.production_id
      );
      if (!productionId) return;
      netWeightByProductionId.set(
        productionId,
        safeFoodCostNumber(netWeightByProductionId.get(productionId)) + getSignedAllocationWeightGrams(allocation)
      );
    });
  });
  return new Set(
    [...netWeightByProductionId.entries()]
      .filter(([, weight]) => Math.abs(weight) > EPSILON)
      .map(([productionId]) => productionId)
  );
}

export function buildPendingProductionRows({
  consumptions = [],
  productions = [],
  producedItemBatches = [],
  recipes = [],
  ingredients = []
} = {}) {
  const indexes = buildFoodCostIndexes({ productions, producedItemBatches, ingredients });
  const servedProductionIds = getProductionIdsFromMealServiceRows(consumptions, producedItemBatches);
  const recipeMap = new Map(
    (Array.isArray(recipes) ? recipes : [])
      .filter((recipe) => recipe?.id)
      .map((recipe) => [String(recipe.id), recipe])
  );

  return (Array.isArray(productions) ? productions : [])
    .filter((production) => String(production.status || '').toLowerCase() === 'completed')
    .filter((production) => !servedProductionIds.has(String(production.id || '')))
    .map((production) => {
      const recipe = recipeMap.get(String(production.recipe_id || '')) || {};
      const outputWeightGrams = getProductionOutputWeightGrams(production);
      const producedServings = firstPositive([
        production.produced_servings,
        production.actual_servings,
        production.expected_yield_servings,
        production.target_servings
      ]);
      return {
        date: production.production_date,
        location: production.site_name,
        meal_type: titleCaseFoodCost(production.meal_type || 'unspecified'),
        menu_type: titleCaseFoodCost(production.menu_type || production.cuisine_type || recipe.menu_type || recipe.cuisine_type || 'General'),
        production: production.recipe_name,
        category: production.menu_category || recipe.category || '-',
        produced_output_kg: roundFoodCostNumber(outputWeightGrams / 1000, 3),
        production_servings: roundFoodCostNumber(producedServings, 3),
        production_cost: roundFoodCostNumber(getProductionOutputCost(production, indexes.ingredientMap)),
        status: 'Pending Meal Service'
      };
    });
}

export function groupFoodCostRows(rows = [], view = 'detail') {
  if (view === 'detail') return rows;

  const grouped = {};
  rows.forEach((row) => {
    const key = view === 'daily'
      ? `${row.date}::${row.location}`
      : `${row.meal_type}::${row.location}::${row.menu_type}::${row.category}`;
    if (!grouped[key]) {
      grouped[key] = {
        date: view === 'daily' ? row.date : '',
        location: row.location,
        meal_type: view === 'meal_type' ? row.meal_type : 'All Meal Types',
        menu_type: view === 'meal_type' ? row.menu_type : 'All Menu Types',
        category: view === 'meal_type' ? row.category : 'All Categories',
        total_servings: 0,
        total_weight_kg: 0,
        total_cost: 0
      };
    }
    grouped[key].total_servings += safeFoodCostNumber(row.servings);
    grouped[key].total_weight_kg += safeFoodCostNumber(row.served_weight_kg);
    grouped[key].total_cost += safeFoodCostNumber(row.total_cost);
  });

  return Object.values(grouped).map((row) => ({
    ...row,
    total_servings: roundFoodCostNumber(row.total_servings, 3),
    total_weight_kg: roundFoodCostNumber(row.total_weight_kg, 3),
    total_cost: roundFoodCostNumber(row.total_cost),
    cost_per_serving: Number((row.total_servings > 0 ? row.total_cost / row.total_servings : 0).toFixed(2)),
    source: 'Meal Service confirmed'
  }));
}
