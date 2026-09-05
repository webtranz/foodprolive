import { getInventoryQuantities } from './inventoryAvailability.js';
import {
  calculateIngredientCost,
  convertIngredientQuantity,
  isIngredientUnitCompatible,
  normalizeIngredientUnit
} from '../../shared/ingredientUnits.js';
import { calculateYieldOutputQuantity } from '../../shared/ingredientYield.js';
import { getItemCode } from '../../shared/itemCode.js';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';
import {
  getRecipeQuantityPrecision,
  roundStandardDecimal
} from '../../shared/recipeNumbers.js';

export const PRODUCTION_ISSUE_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];

export const PRODUCTION_ISSUE_MEAL_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner'
};

export function finiteProductionNumber(value, fallback = 0) {
  if (value === null || typeof value === 'undefined' || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeIssueMealType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return PRODUCTION_ISSUE_MEAL_TYPES.includes(normalized) ? normalized : '';
}

export function normalizeIssueMealView(value) {
  const normalized = normalizeIssueMealType(value);
  return normalized || 'all';
}

function sameId(left, right) {
  return String(left || '') === String(right || '');
}

function findIngredient(ingredients = [], ingredientId) {
  return ingredients.find((ingredient) => sameId(ingredient.id, ingredientId)) || null;
}

function findInventoryRow(inventory = [], siteId, ingredientId) {
  return inventory.find((row) => (
    sameId(row.site_id, siteId)
    && sameId(row.ingredient_id, ingredientId)
  )) || null;
}

function lineQuantity(line = {}) {
  return finiteProductionNumber(
    line.raw_quantity
      ?? line.required_quantity
      ?? line.planned_quantity
      ?? line.adjusted_quantity
      ?? line.quantity
      ?? line.cost_quantity
      ?? 0,
    0
  );
}

function getLineOriginalQuantity(line = {}, fallback = 0) {
  return finiteProductionNumber(
    line.original_raw_quantity
      ?? line.override_original_required_quantity
      ?? line.original_required_quantity
      ?? line.raw_quantity
      ?? line.required_quantity
      ?? line.planned_quantity
      ?? fallback,
    fallback
  );
}

function getLineOriginalIngredientId(line = {}) {
  return String(
    line.original_ingredient_id
      ?? line.override_original_ingredient_id
      ?? line.ingredient_id
      ?? ''
  );
}

function getLineOriginalIngredientName(line = {}) {
  return String(
    line.original_ingredient_name
      ?? line.override_original_ingredient_name
      ?? line.ingredient_name
      ?? ''
  );
}

function getLineOriginalUnit(line = {}) {
  return String(
    line.original_unit
      ?? line.override_original_unit
      ?? line.unit
      ?? line.inventory_unit
      ?? ''
  );
}

export function getProductionIngredientLineKey(line = {}, index = 0) {
  return String(line.line_id || line.id || `${line.ingredient_id || 'ingredient'}-${index}`);
}

export function deriveProductionLineOverrideAction(line = {}) {
  if (line.production_override_action === 'added') return 'added';
  const originalIngredientId = getLineOriginalIngredientId(line);
  const currentIngredientId = String(line.ingredient_id || '');
  const originalQuantity = getLineOriginalQuantity(line, lineQuantity(line));
  const currentQuantity = lineQuantity(line);
  const originalUnit = normalizeIngredientUnit(getLineOriginalUnit(line));
  const currentUnit = normalizeIngredientUnit(line.unit || line.inventory_unit || originalUnit);

  if (currentQuantity <= 0 && originalQuantity > 0) return 'zeroed';
  if (originalIngredientId && currentIngredientId && originalIngredientId !== currentIngredientId) return 'replaced';
  if (Math.abs(originalQuantity - currentQuantity) > 0.000001 || (originalUnit && currentUnit && originalUnit !== currentUnit)) {
    return 'quantity_changed';
  }
  return '';
}

export function buildMenuPlanIssueItems(plan, { mealView = 'all', recipes = [] } = {}) {
  const selectedMealView = normalizeIssueMealView(mealView);
  const meals = Array.isArray(plan?.meals) ? plan.meals : [];
  return meals.flatMap((meal, index) => {
    const mealType = normalizeIssueMealType(meal?.meal_type);
    const recipeId = String(meal?.recipe_id || '').trim();
    const expectedServings = finiteProductionNumber(meal?.expected_servings, 0);
    if (!mealType || !recipeId || expectedServings <= 0) {
      return [];
    }
    if (selectedMealView !== 'all' && selectedMealView !== mealType) {
      return [];
    }

    const recipe = recipes.find((entry) => sameId(entry.id, recipeId)) || {};
    return [{
      key: `${plan?.id || 'menu-plan'}::${mealType}::${recipeId}::${index}`,
      source_menu_plan_id: plan?.id || '',
      source_menu_plan_item_index: index,
      site_id: plan?.site_id || meal?.site_id || '',
      site_name: plan?.site_name || meal?.site_name || '',
      plan_date: plan?.plan_date || meal?.plan_date || '',
      meal_type: mealType,
      meal_label: PRODUCTION_ISSUE_MEAL_LABELS[mealType],
      menu_type: plan?.cuisine_type || plan?.menu_type || meal?.cuisine_type || meal?.menu_type || 'general',
      menu_category: plan?.menu_category || meal?.menu_category || 'senior',
      recipe_id: recipeId,
      recipe_name: meal?.recipe_name || recipe.name || 'Selected recipe',
      expected_servings: expectedServings,
      production_covers: expectedServings,
      planned_total_cost: finiteProductionNumber(meal?.total_cost, 0),
      cost_per_serving: finiteProductionNumber(meal?.cost_per_serving, 0),
      selected: true
    }];
  });
}

export function getMenuIssueMealGroupKey(item = {}) {
  return `${item.source_menu_plan_id || 'menu-plan'}::${item.meal_type || 'meal'}`;
}

export function buildProductionIngredientLine({
  sourceLine = {},
  ingredient = null,
  inventory = [],
  siteId = '',
  index = 0,
  override = {}
} = {}) {
  const ingredientId = sourceLine.ingredient_id || ingredient?.id || '';
  const ingredientData = ingredient || {};
  const rawQuantity = Math.max(0, lineQuantity(sourceLine));
  const unit = sourceLine.unit || ingredientData.unit || sourceLine.inventory_unit || 'unit';
  const inventoryRow = findInventoryRow(inventory, siteId, ingredientId);
  const inventoryUnit = inventoryRow?.unit || ingredientData.unit || sourceLine.inventory_unit || unit;
  const costUnit = ingredientData.unit || sourceLine.cost_unit || inventoryUnit;
  const requiredInventoryQty = convertIngredientQuantity(rawQuantity, unit, inventoryUnit, ingredientData);
  const costQuantity = convertIngredientQuantity(rawQuantity, unit, costUnit, ingredientData);
  const stockQuantities = getInventoryQuantities(inventoryRow);
  const availableStock = stockQuantities.available_quantity;
  const shortage = Math.max(0, requiredInventoryQty - availableStock);
  const yieldOutput = calculateYieldOutputQuantity(rawQuantity, ingredientData);
  const unitCost = finiteProductionNumber(
    sourceLine.unit_cost
      ?? ingredientData.cost_per_unit
      ?? ingredientData.average_cost
      ?? ingredientData.last_purchase_price
      ?? 0,
    0
  );
  const estimatedCost = calculateIngredientCost(rawQuantity, unit, ingredientData, unitCost);
  const isAddedOverride = sourceLine.production_override_action === 'added' || override.production_override_action === 'added';
  const originalQuantity = isAddedOverride ? 0 : getLineOriginalQuantity(sourceLine, rawQuantity);
  const originalIngredientId = isAddedOverride ? null : (getLineOriginalIngredientId(sourceLine) || ingredientId);
  const originalIngredientName = isAddedOverride ? '' : (getLineOriginalIngredientName(sourceLine) || sourceLine.ingredient_name || ingredientData.name || 'Ingredient');
  const originalUnit = isAddedOverride ? unit : (getLineOriginalUnit(sourceLine) || unit);
  const line = {
    ...sourceLine,
    ...override,
    line_id: sourceLine.line_id || `line-${ingredientId || 'ingredient'}-${index}`,
    item_code: getItemCode(ingredientData, getItemCode(sourceLine)),
    ingredient_id: ingredientId,
    ingredient_name: sourceLine.ingredient_name || ingredientData.name || 'Ingredient',
    source_recipe_names: Array.isArray(sourceLine.source_recipe_names) ? sourceLine.source_recipe_names : [],
    raw_quantity: roundStandardDecimal(rawQuantity, getRecipeQuantityPrecision(unit)),
    planned_quantity: roundStandardDecimal(rawQuantity, getRecipeQuantityPrecision(unit)),
    yielded_quantity: roundStandardDecimal(yieldOutput.yielded_quantity, getRecipeQuantityPrecision(unit)),
    adjusted_quantity: roundStandardDecimal(rawQuantity, getRecipeQuantityPrecision(unit)),
    on_hand_stock: roundStandardDecimal(stockQuantities.on_hand_quantity, getRecipeQuantityPrecision(inventoryUnit)),
    reserved_stock: roundStandardDecimal(stockQuantities.reserved_quantity, getRecipeQuantityPrecision(inventoryUnit)),
    available_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
    current_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
    shortage: roundStandardDecimal(shortage, getRecipeQuantityPrecision(inventoryUnit)),
    unit,
    inventory_unit: inventoryUnit,
    cost_quantity: Number(costQuantity.toFixed(4)),
    cost_unit: costUnit,
    yield_multiplier: Number(yieldOutput.yield_multiplier.toFixed(6)),
    yield_percent: Number(yieldOutput.yield_percent.toFixed(2)),
    yield_source: yieldOutput.yield_source,
    shrinkage_percent: finiteProductionNumber(ingredientData.shrinkage_percent, 0),
    sufficient: availableStock >= requiredInventoryQty,
    unit_cost: Number(unitCost.toFixed(2)),
    estimated_cost: Number(estimatedCost.toFixed(2)),
    original_ingredient_id: originalIngredientId || null,
    original_ingredient_name: originalIngredientName || null,
    original_raw_quantity: roundStandardDecimal(originalQuantity, getRecipeQuantityPrecision(originalUnit || unit)),
    original_unit: originalUnit || unit
  };

  const derivedAction = deriveProductionLineOverrideAction(line);
  return {
    ...line,
    production_override_action: line.production_override_action || derivedAction || ''
  };
}

export function aggregateProductionIngredientLines(lines = [], {
  ingredients = [],
  inventory = [],
  siteId = ''
} = {}) {
  const groupedLines = new Map();

  (Array.isArray(lines) ? lines : []).forEach((line, index) => {
    const ingredientId = String(line?.ingredient_id || '').trim();
    if (!ingredientId) return;
    const ingredient = findIngredient(ingredients, ingredientId) || {};
    const sourceUnit = line?.unit || line?.inventory_unit || ingredient.unit || 'unit';
    let targetUnit = ingredient.unit || line?.inventory_unit || sourceUnit || 'unit';
    let aggregateQuantity = lineQuantity(line);

    try {
      aggregateQuantity = convertIngredientQuantity(
        aggregateQuantity,
        sourceUnit,
        targetUnit,
        ingredient
      );
    } catch {
      targetUnit = sourceUnit;
    }

    const groupKey = `${ingredientId}::${targetUnit}`;
    const current = groupedLines.get(groupKey) || {
      line_id: `aggregate-${ingredientId}-${groupedLines.size}`,
      ingredient_id: ingredientId,
      ingredient_name: line?.ingredient_name || ingredient.name || 'Ingredient',
      raw_quantity: 0,
      unit: targetUnit,
      estimated_cost: 0,
      source_recipe_names: new Set(),
      source_menu_plan_item_keys: new Set(),
      source_line_ids: new Set(),
      aggregate_line_count: 0
    };

    current.raw_quantity += aggregateQuantity;
    current.estimated_cost += finiteProductionNumber(line?.estimated_cost, 0);
    current.aggregate_line_count += 1;
    current.source_line_ids.add(getProductionIngredientLineKey(line, index));

    (Array.isArray(line?.source_recipe_names) ? line.source_recipe_names : [])
      .filter(Boolean)
      .forEach((recipeName) => current.source_recipe_names.add(recipeName));
    if (line?.source_recipe_name) {
      current.source_recipe_names.add(line.source_recipe_name);
    }
    if (line?.recipe_name) {
      current.source_recipe_names.add(line.recipe_name);
    }
    if (line?.source_menu_plan_item_key) {
      current.source_menu_plan_item_keys.add(line.source_menu_plan_item_key);
    }
    (Array.isArray(line?.source_menu_plan_item_keys) ? line.source_menu_plan_item_keys : [])
      .filter(Boolean)
      .forEach((itemKey) => current.source_menu_plan_item_keys.add(itemKey));

    groupedLines.set(groupKey, current);
  });

  return [...groupedLines.values()].map((group, index) => {
    const ingredient = findIngredient(ingredients, group.ingredient_id);
    const aggregateLine = buildProductionIngredientLine({
      sourceLine: {
        ...group,
        raw_quantity: group.raw_quantity,
        planned_quantity: group.raw_quantity,
        required_quantity: group.raw_quantity,
        original_ingredient_id: group.ingredient_id,
        original_ingredient_name: group.ingredient_name,
        original_raw_quantity: group.raw_quantity,
        original_unit: group.unit,
        production_override_action: ''
      },
      ingredient,
      inventory,
      siteId,
      index
    });

    return {
      ...aggregateLine,
      estimated_cost: Number((group.estimated_cost || aggregateLine.estimated_cost || 0).toFixed(2)),
      source_recipe_names: [...group.source_recipe_names],
      source_menu_plan_item_keys: [...group.source_menu_plan_item_keys],
      source_line_ids: [...group.source_line_ids],
      aggregate_line_count: group.aggregate_line_count,
      production_override_action: ''
    };
  });
}

export function buildMenuIssueMealGroups(items = [], {
  snapshotsByItemKey = {},
  ingredients = [],
  inventory = [],
  siteId = ''
} = {}) {
  const groups = new Map();

  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item?.selected || finiteProductionNumber(item.production_covers, 0) <= 0) {
      return;
    }
    const mealType = normalizeIssueMealType(item.meal_type);
    if (!mealType) return;
    const key = getMenuIssueMealGroupKey(item);
    const current = groups.get(key) || {
      key,
      source_menu_plan_id: item.source_menu_plan_id || '',
      site_id: item.site_id || '',
      site_name: item.site_name || '',
      plan_date: item.plan_date || '',
      meal_type: mealType,
      meal_label: PRODUCTION_ISSUE_MEAL_LABELS[mealType],
      menu_type: item.menu_type || 'general',
      menu_category: item.menu_category || 'senior',
      items: [],
      production_covers: 0,
      expected_servings: 0,
      planned_total_cost: 0,
      snapshot_lines: [],
      estimatedBatchCost: 0,
      estimatedCostPerServing: 0,
      shortageCount: 0
    };
    current.items.push(item);
    current.production_covers += finiteProductionNumber(item.production_covers, 0);
    current.expected_servings += finiteProductionNumber(item.expected_servings, 0);
    current.planned_total_cost += finiteProductionNumber(item.planned_total_cost, 0);
    groups.set(key, current);
  });

  return [...groups.values()].map((group) => {
    const itemLines = group.items.flatMap((item) => (
      Array.isArray(snapshotsByItemKey[item.key])
        ? snapshotsByItemKey[item.key].map((line) => ({
          ...line,
          source_recipe_name: item.recipe_name,
          source_recipe_id: item.recipe_id,
          source_menu_plan_item_key: item.key
        }))
        : []
    ));
    const snapshotLines = aggregateProductionIngredientLines(itemLines, {
      ingredients,
      inventory,
      siteId
    });
    const estimatedBatchCost = snapshotLines.reduce(
      (sum, line) => sum + finiteProductionNumber(line.estimated_cost, 0),
      0
    );
    const servingCount = Math.max(1, finiteProductionNumber(group.production_covers, 0));

    return {
      ...group,
      snapshot_lines: snapshotLines,
      estimatedBatchCost: Number(estimatedBatchCost.toFixed(2)),
      estimatedCostPerServing: Number((estimatedBatchCost / servingCount).toFixed(2)),
      shortageCount: snapshotLines.filter((line) => !line.sufficient).length
    };
  });
}

export function buildProductionIngredientSnapshot({
  recipe,
  recipes = [],
  ingredients = [],
  inventory = [],
  siteId = '',
  targetServings = 0
} = {}) {
  const hasRecipeComponents = recipe
    && ((Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0)
      || (Array.isArray(recipe.sub_recipes) && recipe.sub_recipes.length > 0));

  if (!hasRecipeComponents) {
    return {
      lines: [],
      estimatedBatchCost: 0,
      estimatedCostPerServing: 0
    };
  }

  const servings = Math.max(0, finiteProductionNumber(targetServings, 0));
  const multiplier = recipe.servings > 0
    ? servings / recipe.servings
    : servings || 1;
  const expandedRecipe = expandRecipeIngredients(
    recipe,
    recipes,
    ingredients,
    { multiplier, aggregate: true }
  );

  const lines = expandedRecipe.ingredients.map((line, index) => buildProductionIngredientLine({
    sourceLine: {
      ...line,
      line_id: `recipe-${recipe.id || 'recipe'}-${line.ingredient_id || index}-${index}`,
      original_ingredient_id: line.ingredient_id,
      original_ingredient_name: line.ingredient_name,
      original_raw_quantity: line.quantity || 0,
      original_unit: line.unit
    },
    ingredient: findIngredient(ingredients, line.ingredient_id),
    inventory,
    siteId,
    index
  }));
  const estimatedBatchCost = lines.reduce((sum, line) => sum + finiteProductionNumber(line.estimated_cost, 0), 0);
  const safeServings = Math.max(1, servings);

  return {
    lines,
    estimatedBatchCost: Number(estimatedBatchCost.toFixed(2)),
    estimatedCostPerServing: Number((estimatedBatchCost / safeServings).toFixed(2))
  };
}

export function recalculateProductionIngredientSnapshot(lines = [], {
  ingredients = [],
  inventory = [],
  siteId = ''
} = {}) {
  const recalculatedLines = (Array.isArray(lines) ? lines : []).map((line, index) => buildProductionIngredientLine({
    sourceLine: line,
    ingredient: findIngredient(ingredients, line?.ingredient_id),
    inventory,
    siteId,
    index,
    override: {
      production_override_action: deriveProductionLineOverrideAction(line)
    }
  }));
  const estimatedBatchCost = recalculatedLines.reduce((sum, line) => sum + finiteProductionNumber(line.estimated_cost, 0), 0);

  return {
    lines: recalculatedLines,
    estimatedBatchCost: Number(estimatedBatchCost.toFixed(2))
  };
}

export function buildProductionOverrideAudit(lines = [], { recordedAt = new Date().toISOString() } = {}) {
  return (Array.isArray(lines) ? lines : [])
    .map((line, index) => {
      const action = deriveProductionLineOverrideAction(line);
      if (!action) return null;
      const isAdded = action === 'added';
      return {
        id: `override-${getProductionIngredientLineKey(line, index)}`,
        action,
        action_label: action.replace(/_/g, ' '),
        original_ingredient_id: isAdded ? null : (getLineOriginalIngredientId(line) || null),
        original_ingredient_name: isAdded ? null : (getLineOriginalIngredientName(line) || null),
        original_quantity: isAdded ? 0 : getLineOriginalQuantity(line, 0),
        original_unit: isAdded ? null : (getLineOriginalUnit(line) || line.unit || null),
        final_ingredient_id: line.ingredient_id || null,
        final_ingredient_name: line.ingredient_name || null,
        final_quantity: lineQuantity(line),
        final_unit: line.unit || null,
        source: line.production_override_source || 'chef',
        reason: line.production_override_reason || line.ai_suggestion_reason || line.override_reason || '',
        recorded_at: recordedAt
      };
    })
    .filter(Boolean);
}

export function buildProductionIngredientsForSubmit(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((line, index) => {
    const action = deriveProductionLineOverrideAction(line);
    const isAdded = action === 'added';
    return {
      item_code: line.item_code === '—' ? '' : line.item_code,
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      source_recipe_names: Array.isArray(line.source_recipe_names) ? line.source_recipe_names : [],
      line_id: getProductionIngredientLineKey(line, index),
      quantity_basis: 'production_snapshot_override_v1',
      raw_quantity: line.raw_quantity,
      net_quantity: line.yielded_quantity,
      yielded_quantity: line.yielded_quantity,
      planned_quantity: line.raw_quantity,
      required_quantity: line.raw_quantity,
      yield_adjusted_quantity: line.yielded_quantity,
      yield_multiplier: line.yield_multiplier,
      yield_percent: line.yield_percent,
      yield_source: line.yield_source,
      actual_quantity: null,
      unit: line.unit,
      cost_quantity: line.cost_quantity,
      cost_unit: line.cost_unit,
      unit_cost: line.unit_cost,
      estimated_cost: line.estimated_cost,
      production_override_action: action,
      production_override_source: line.production_override_source || '',
      production_override_reason: line.production_override_reason || line.ai_suggestion_reason || '',
      original_ingredient_id: isAdded ? null : (getLineOriginalIngredientId(line) || null),
      original_ingredient_name: isAdded ? null : (getLineOriginalIngredientName(line) || null),
      original_raw_quantity: isAdded ? 0 : getLineOriginalQuantity(line, 0),
      original_unit: isAdded ? null : (getLineOriginalUnit(line) || line.unit || null)
    };
  });
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function collectCategoryTokens(record = {}) {
  return tokenize([
    record.category,
    record.item_category,
    record.group_name,
    record.product_group,
    record.type,
    record.ingredient_type
  ].filter(Boolean).join(' '));
}

export function buildInventoryReplacementSuggestions({
  line,
  ingredients = [],
  inventory = [],
  siteId = '',
  limit = 3
} = {}) {
  if (!line) return [];
  const sourceIngredient = findIngredient(ingredients, line.ingredient_id) || {};
  const sourceNameTokens = new Set(tokenize(`${line.ingredient_name || ''} ${sourceIngredient.name || ''}`));
  const sourceCategoryTokens = new Set(collectCategoryTokens(sourceIngredient));
  const sourceUnit = line.inventory_unit || line.unit || sourceIngredient.unit || '';
  const neededQuantity = Math.max(
    finiteProductionNumber(line.shortage, 0),
    finiteProductionNumber(line.raw_quantity, 0)
  );

  return inventory
    .filter((row) => sameId(row.site_id, siteId))
    .map((row) => {
      const candidateIngredient = findIngredient(ingredients, row.ingredient_id) || {};
      const stock = getInventoryQuantities(row);
      const available = finiteProductionNumber(stock.available_quantity, 0);
      if (available <= 0 || sameId(row.ingredient_id, line.ingredient_id)) {
        return null;
      }

      const candidateTokens = new Set(tokenize(`${row.ingredient_name || ''} ${candidateIngredient.name || ''}`));
      const candidateCategoryTokens = new Set(collectCategoryTokens(candidateIngredient));
      const nameScore = [...sourceNameTokens].filter((token) => candidateTokens.has(token)).length * 8;
      const categoryScore = [...sourceCategoryTokens].filter((token) => candidateCategoryTokens.has(token)).length * 12;
      const unitCompatible = isIngredientUnitCompatible(
        sourceUnit,
        row.unit || candidateIngredient.unit || sourceUnit,
        candidateIngredient
      );
      const availabilityScore = available >= neededQuantity ? 12 : 4;
      const score = nameScore + categoryScore + availabilityScore + (unitCompatible ? 18 : -10);

      return {
        ingredient_id: row.ingredient_id,
        ingredient_name: row.ingredient_name || candidateIngredient.name || 'Inventory item',
        unit: row.unit || candidateIngredient.unit || sourceUnit || 'unit',
        available_quantity: available,
        suggested_quantity: Math.min(available, neededQuantity || available),
        confidence: Math.max(35, Math.min(95, 45 + score)),
        reason: unitCompatible
          ? 'Closest available inventory match by item category, name, and compatible unit.'
          : 'Available item with a different unit; chef review required before applying.',
        source: 'inventory_similarity',
        score
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.available_quantity - left.available_quantity)
    .slice(0, limit)
    .map(({ score, ...suggestion }) => suggestion);
}
