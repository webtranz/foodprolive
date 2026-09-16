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
import { calculateFrozenProductionLineWeight } from '../../shared/productionReconciliation.js';
import {
  clearRecipeLineWeight,
  getRecipeLinePrepExemptPercent,
  ingredientForRecipeLine,
  isExemptProcessingAid,
  recipeLineProcessingAidField,
  recipeLineRetainedFraction,
  recipeLineWeightFields
} from '../../shared/recipeLineWeight.js';
import { accumulateRecipeLineWeight, finishRecipeLineWeight } from '../../shared/recipeWeightAggregation.js';
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

export function getMenuIssueInventoryCheckState({
  siteId = '',
  snapshotSiteId = '',
  isLoading = false,
  error = '',
  items = [],
  snapshotsByItemKey = {}
} = {}) {
  if (error) return { ready: false, message: error };
  if (isLoading) return { ready: false, message: 'Loading production inventory and ingredients...' };
  if (!siteId) return { ready: false, message: 'Inventory cannot be checked until the production site is available.' };
  if (items.length === 0) return { ready: false, message: 'Select a planned production item to check inventory.' };
  if (String(siteId) !== String(snapshotSiteId)
    || items.some((item) => !Array.isArray(snapshotsByItemKey[item.key]))) {
    return { ready: false, message: 'Calculating ingredient requirements for this production site...' };
  }
  if (items.some((item) => snapshotsByItemKey[item.key].length === 0)) {
    return { ready: false, message: 'A selected production item has no ingredient details. Check its recipe before issuing production.' };
  }
  return { ready: true, message: '' };
}

export function finiteProductionNumber(value, fallback = 0) {
  if (value === null || typeof value === 'undefined' || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function firstFiniteProductionNumber(candidates = [], fallback = 0) {
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate === 'undefined' || candidate === '') continue;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function resolveProductionLineUnitCost({ sourceLine = {}, ingredientData = {}, inventoryRow = null, preferSelectedIngredientCost = false } = {}) {
  const selectedIngredientCosts = [
    inventoryRow?.average_unit_cost,
    inventoryRow?.last_unit_cost,
    inventoryRow?.unit_cost,
    inventoryRow?.cost_per_unit,
    inventoryRow?.last_cost,
    ingredientData.cost_per_unit,
    ingredientData.last_cost,
    ingredientData.average_cost,
    ingredientData.last_purchase_price,
    ingredientData.standard_cost
  ];
  const savedLineCosts = [
    sourceLine.unit_cost,
    sourceLine.actual_unit_cost,
    sourceLine.cost_per_unit,
    sourceLine.average_cost,
    sourceLine.last_cost
  ];
  return firstFiniteProductionNumber(
    preferSelectedIngredientCost
      ? [...selectedIngredientCosts, ...savedLineCosts]
      : [...savedLineCosts, ...selectedIngredientCosts],
    0
  );
}

export function buildProductionInventoryConversionSummary({
  ingredient = {},
  rawQuantity = 0,
  unit = '',
  inventoryUnit = '',
  requiredInventoryQty = 0,
  availableStock = 0,
  shortage = 0
} = {}) {
  const productionUnit = unit || ingredient.unit || '';
  const stockUnit = inventoryUnit || ingredient.unit || productionUnit;
  const normalizedProductionUnit = normalizeIngredientUnit(productionUnit);
  const normalizedStockUnit = normalizeIngredientUnit(stockUnit);
  const productionQuantity = finiteProductionNumber(rawQuantity, 0);
  const inventoryRequiredQuantity = finiteProductionNumber(requiredInventoryQty, 0);

  if (!productionQuantity || !normalizedProductionUnit || !normalizedStockUnit || normalizedProductionUnit === normalizedStockUnit) {
    return null;
  }
  if (!Number.isFinite(inventoryRequiredQuantity) || inventoryRequiredQuantity <= 0) {
    return null;
  }
  if (!isIngredientUnitCompatible(productionUnit, stockUnit, ingredient)) {
    return null;
  }

  const packageQuantity = convertIngredientQuantity(1, stockUnit, productionUnit, ingredient);
  const hasPackageSize = Number.isFinite(packageQuantity)
    && packageQuantity > 0
    && Math.abs(packageQuantity - 1) > 0.000001;
  const productionPrecision = getRecipeQuantityPrecision(productionUnit);
  const stockPrecision = getRecipeQuantityPrecision(stockUnit);

  return {
    production_quantity: roundStandardDecimal(productionQuantity, productionPrecision),
    production_unit: productionUnit,
    inventory_required_quantity: roundStandardDecimal(inventoryRequiredQuantity, stockPrecision),
    inventory_unit: stockUnit,
    package_quantity: hasPackageSize ? roundStandardDecimal(packageQuantity, productionPrecision) : null,
    package_unit: hasPackageSize ? productionUnit : '',
    available_quantity: roundStandardDecimal(availableStock, stockPrecision),
    shortage_quantity: roundStandardDecimal(shortage, stockPrecision)
  };
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
    const recipe = recipes.find((entry) => sameId(entry.id, recipeId)) || null;
    const recipeLinkStatus = meal.recipe_link_status || (recipe ? 'linked' : recipeId ? 'missing' : '');
    const recipeName = String(meal?.recipe_name || recipe?.name || meal?.item_name || meal?.name || '').trim();
    const hasPlannedProductionLine = Boolean(recipeId || recipeName);
    if (!mealType || !hasPlannedProductionLine) {
      return [];
    }
    if (selectedMealView !== 'all' && selectedMealView !== mealType) {
      return [];
    }

    return [{
      key: `${plan?.id || 'menu-plan'}::${mealType}::${recipeId || recipeName || 'planned-item'}::${index}`,
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
      recipe_code: meal?.recipe_code || recipe?.recipe_code || '',
      recipe_link_status: recipeLinkStatus,
      recipe_name: recipeName || 'Planned item',
      expected_servings: expectedServings,
      production_covers: 0,
      planned_total_cost: finiteProductionNumber(meal?.total_cost, 0),
      cost_per_serving: finiteProductionNumber(meal?.cost_per_serving, 0),
      production_blocked_reason: recipe && expectedServings > 0
        ? ''
        : !recipe
          ? 'This menu-planning row is visible for manifest completeness, but it cannot be issued until it is linked to a recipe.'
          : 'Enter production covers or Production Size (Kg) before issuing this menu-planning row.',
      selected: true
    }];
  });
}

export function getMenuIssueMealGroupKey(item = {}) {
  return `${item.source_menu_plan_id || 'menu-plan'}::${item.meal_type || 'meal'}`;
}

const NON_BLOCKING_MENU_ISSUE_STATUSES = new Set(['cancelled', 'rejected', 'reversed', 'voided']);

function normalizeKey(value) {
  return String(value || '').trim();
}

function uniqueKeys(values = []) {
  return [...new Set(
    values
      .map(normalizeKey)
      .filter(Boolean)
  )];
}

export function isMenuPlanIssueProductionBlocking(production = {}, {
  planId = '',
  editingProductionId = ''
} = {}) {
  const normalizedPlanId = String(planId || '').trim();
  if (!normalizedPlanId || !production?.source_menu_plan_id) return false;
  if (String(production.source_menu_plan_id) !== normalizedPlanId) return false;
  if (editingProductionId && String(production.id || '') === String(editingProductionId)) return false;

  const status = String(production.status || '').trim().toLowerCase();
  return !NON_BLOCKING_MENU_ISSUE_STATUSES.has(status);
}

export function buildMenuPlanIssueLockState(productions = [], {
  planId = '',
  editingProductionId = ''
} = {}) {
  const itemKeys = new Set();
  const legacyGroupKeys = new Set();
  const normalizedPlanId = normalizeKey(planId);

  (Array.isArray(productions) ? productions : [])
    .filter((production) => isMenuPlanIssueProductionBlocking(production, {
      planId: normalizedPlanId,
      editingProductionId
    }))
    .forEach((production) => {
      const mealType = normalizeIssueMealType(production.source_menu_plan_meal_type || production.meal_type);
      const derivedGroupKey = normalizedPlanId && mealType ? `${normalizedPlanId}::${mealType}` : '';
      const productionGroupKeys = uniqueKeys([
        production.production_issue_group_key,
        derivedGroupKey
      ]);
      const productionGroupKeySet = new Set(productionGroupKeys);
      const savedItemKeys = uniqueKeys([
        ...(Array.isArray(production.source_menu_plan_item_keys) ? production.source_menu_plan_item_keys : []),
        ...(Array.isArray(production.menu_issue_items)
          ? production.menu_issue_items.map((item) => item?.key)
          : [])
      ]);
      const singleSourceKey = normalizeKey(production.source_menu_plan_item_key);
      if (singleSourceKey && !productionGroupKeySet.has(singleSourceKey)) {
        savedItemKeys.push(singleSourceKey);
      }

      const preciseItemKeys = uniqueKeys(savedItemKeys);
      if (preciseItemKeys.length > 0) {
        preciseItemKeys.forEach((key) => itemKeys.add(key));
        return;
      }

      productionGroupKeys.forEach((key) => legacyGroupKeys.add(key));
    });

  return { itemKeys, legacyGroupKeys };
}

export function isMenuPlanIssueItemAlreadyIssued(item = {}, lockState = {}) {
  const itemKeys = lockState.itemKeys instanceof Set ? lockState.itemKeys : new Set(lockState.itemKeys || []);
  const legacyGroupKeys = lockState.legacyGroupKeys instanceof Set
    ? lockState.legacyGroupKeys
    : new Set(lockState.legacyGroupKeys || []);
  return itemKeys.has(normalizeKey(item.key))
    || legacyGroupKeys.has(getMenuIssueMealGroupKey(item));
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
  const ingredientData = ingredientForRecipeLine(sourceLine, ingredient || {});
  const processingAid = isExemptProcessingAid(sourceLine);
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
  const retainedFraction = recipeLineRetainedFraction(sourceLine);
  const prepExemptPercent = getRecipeLinePrepExemptPercent(sourceLine);
  const isAddedOverride = sourceLine.production_override_action === 'added' || override.production_override_action === 'added';
  const originalQuantity = isAddedOverride ? 0 : getLineOriginalQuantity(sourceLine, rawQuantity);
  const originalIngredientId = isAddedOverride ? null : (getLineOriginalIngredientId(sourceLine) || ingredientId);
  const originalIngredientName = isAddedOverride ? '' : (getLineOriginalIngredientName(sourceLine) || sourceLine.ingredient_name || ingredientData.name || 'Ingredient');
  const originalUnit = isAddedOverride ? unit : (getLineOriginalUnit(sourceLine) || unit);
  const isReplacementOverride = !isAddedOverride
    && originalIngredientId
    && ingredientId
    && !sameId(originalIngredientId, ingredientId);
  const yieldOutput = processingAid
    ? {
        yielded_quantity: 0,
        yield_multiplier: 0,
        yield_percent: 0,
        yield_source: 'exempt_processing_aid'
      }
    : (() => {
        const output = calculateYieldOutputQuantity(rawQuantity, ingredientData);
        return {
          ...output,
          yielded_quantity: output.yielded_quantity * retainedFraction,
          yield_multiplier: output.yield_multiplier,
          yield_percent: output.yield_percent,
          yield_source: output.yield_source
        };
      })();
  const unitCost = resolveProductionLineUnitCost({
    sourceLine,
    ingredientData,
    inventoryRow,
    preferSelectedIngredientCost: isReplacementOverride || isAddedOverride
  });
  const estimatedCost = calculateIngredientCost(rawQuantity, unit, ingredientData, unitCost);
  const line = {
    ...clearRecipeLineWeight(sourceLine),
    ...override,
    ...recipeLineProcessingAidField(sourceLine),
    ...recipeLineWeightFields(sourceLine),
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
    inventory_required_quantity: roundStandardDecimal(requiredInventoryQty, getRecipeQuantityPrecision(inventoryUnit)),
    inventory_conversion_summary: buildProductionInventoryConversionSummary({
      ingredient: ingredientData,
      rawQuantity,
      unit,
      inventoryUnit,
      requiredInventoryQty,
      availableStock,
      shortage
    }),
    unit,
    inventory_unit: inventoryUnit,
    cost_quantity: Number(costQuantity.toFixed(4)),
    cost_unit: costUnit,
    yield_multiplier: Number(yieldOutput.yield_multiplier.toFixed(6)),
    yield_percent: Number(yieldOutput.yield_percent.toFixed(2)),
    yield_source: yieldOutput.yield_source,
    shrinkage_percent: finiteProductionNumber(ingredientData.shrinkage_percent, 0),
    prep_exempt_percent: prepExemptPercent,
    retained_fraction: roundStandardDecimal(retainedFraction, 4),
    sufficient: availableStock >= requiredInventoryQty,
    unit_cost: Number(unitCost.toFixed(2)),
    estimated_cost: Number(estimatedCost.toFixed(2)),
    cost_ingredient_id: ingredientId || null,
    original_ingredient_id: originalIngredientId || null,
    original_ingredient_name: originalIngredientName || null,
    original_raw_quantity: roundStandardDecimal(originalQuantity, getRecipeQuantityPrecision(originalUnit || unit)),
    original_unit: originalUnit || unit
  };

  const derivedAction = deriveProductionLineOverrideAction(line);
  const weightSnapshot = calculateFrozenProductionLineWeight({
    ...line,
    raw_quantity: rawQuantity,
    planned_quantity: rawQuantity,
    required_quantity: rawQuantity,
    unit
  }, ingredientData);
  const snapshotLine = { ...line };
  delete snapshotLine.aggregate_shortage;
  delete snapshotLine.aggregate_required_quantity;
  delete snapshotLine.aggregate_source_recipe_names;

  return {
    ...snapshotLine,
    raw_weight_grams: weightSnapshot.raw_weight_grams,
    yielded_weight_grams: weightSnapshot.yielded_weight_grams,
    weight_calculation_source: weightSnapshot.source || snapshotLine.weight_calculation_source || null,
    yield_calculation_source: weightSnapshot.yield_source || snapshotLine.yield_calculation_source || snapshotLine.yield_source || null,
    weight_snapshot_version: 1,
    production_override_action: snapshotLine.production_override_action || derivedAction || ''
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
    const ingredient = ingredientForRecipeLine(line, findIngredient(ingredients, ingredientId) || {});
    const processingAid = isExemptProcessingAid(line);
    const prepExemptPercent = getRecipeLinePrepExemptPercent(line);
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
    if (aggregateQuantity <= 0) return;

    const groupKey = `${ingredientId}::${targetUnit}::${processingAid ? 'processing_aid' : `prep_${prepExemptPercent}`}`;
    const current = groupedLines.get(groupKey) || {
      line_id: `aggregate-${ingredientId}-${groupedLines.size}`,
      ingredient_id: ingredientId,
      ingredient_name: line?.ingredient_name || ingredient.name || 'Ingredient',
      raw_quantity: 0,
      unit: targetUnit,
      ...recipeLineProcessingAidField(line),
      estimated_cost: 0,
      source_recipe_names: new Set(),
      source_menu_plan_item_keys: new Set(),
      source_line_ids: new Set(),
      aggregate_line_count: 0
    };

    current.raw_quantity += aggregateQuantity;
    accumulateRecipeLineWeight(current, line, ingredient, lineQuantity(line));
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
        ...finishRecipeLineWeight(group, group.raw_quantity),
        ...recipeLineProcessingAidField(group),
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
      ...recipeLineWeightFields(line),
      item_code: line.item_code === '—' ? '' : line.item_code,
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      source_recipe_names: Array.isArray(line.source_recipe_names) ? line.source_recipe_names : [],
      ...recipeLineProcessingAidField(line),
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
      cost_ingredient_id: line.cost_ingredient_id || line.ingredient_id || null,
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

function normalizeSimilarityName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeSimilarityName(value) {
  return normalizeSimilarityName(value)
    .split(' ')
    .filter((token) => token.length >= 2);
}

function buildBigrams(value) {
  const normalized = normalizeSimilarityName(value);
  if (normalized.length < 2) return [];
  return Array.from(
    { length: normalized.length - 1 },
    (_, index) => normalized.slice(index, index + 2)
  );
}

function diceCoefficient(left, right) {
  const leftBigrams = buildBigrams(left);
  const rightBigrams = buildBigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;
  const rightCounts = new Map();
  rightBigrams.forEach((bigram) => {
    rightCounts.set(bigram, (rightCounts.get(bigram) || 0) + 1);
  });
  const intersection = leftBigrams.reduce((sum, bigram) => {
    const count = rightCounts.get(bigram) || 0;
    if (count <= 0) return sum;
    rightCounts.set(bigram, count - 1);
    return sum + 1;
  }, 0);
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function longestCommonTokenRun(leftTokens, rightTokens) {
  let longest = 0;
  leftTokens.forEach((leftToken, leftIndex) => {
    rightTokens.forEach((rightToken, rightIndex) => {
      if (leftToken !== rightToken) return;
      let length = 0;
      while (
        leftTokens[leftIndex + length]
        && rightTokens[rightIndex + length]
        && leftTokens[leftIndex + length] === rightTokens[rightIndex + length]
      ) {
        length += 1;
      }
      longest = Math.max(longest, length);
    });
  });
  return longest;
}

function fullNameSimilarityScore(sourceName, candidateName) {
  const sourceTokens = tokenizeSimilarityName(sourceName);
  const candidateTokens = tokenizeSimilarityName(candidateName);
  if (sourceTokens.length === 0 || candidateTokens.length === 0) return 0;
  const uniqueSourceTokens = new Set(sourceTokens);
  const uniqueCandidateTokens = new Set(candidateTokens);
  const overlapCount = [...uniqueSourceTokens].filter((token) => uniqueCandidateTokens.has(token)).length;
  const sourceCoverage = overlapCount / uniqueSourceTokens.size;
  const candidateCoverage = overlapCount / uniqueCandidateTokens.size;
  const orderedCoverage = longestCommonTokenRun(sourceTokens, candidateTokens)
    / Math.max(sourceTokens.length, candidateTokens.length);
  const characterSimilarity = diceCoefficient(sourceName, candidateName);
  const normalizedSource = normalizeSimilarityName(sourceName);
  const normalizedCandidate = normalizeSimilarityName(candidateName);
  const phraseBonus = normalizedSource.includes(normalizedCandidate)
    || normalizedCandidate.includes(normalizedSource)
    ? 10
    : 0;
  const leadingOnlyPenalty = sourceTokens[0] === candidateTokens[0] && sourceCoverage < 0.35 ? -12 : 0;
  return Math.max(0, Math.round(
    (sourceCoverage * 45)
    + (candidateCoverage * 20)
    + (orderedCoverage * 20)
    + (characterSimilarity * 15)
    + phraseBonus
    + leadingOnlyPenalty
  ));
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
  const sourceFullName = `${line.ingredient_name || ''} ${sourceIngredient.name || ''}`;
  const sourceCategoryTokens = new Set(collectCategoryTokens(sourceIngredient));
  const sourceUnit = line.inventory_unit || line.unit || sourceIngredient.unit || '';
  const requiredLineQuantity = finiteProductionNumber(line.raw_quantity, 0);
  const neededQuantity = Math.max(
    line.aggregate_shortage ? 0 : finiteProductionNumber(line.shortage, 0),
    requiredLineQuantity
  );

  return inventory
    .filter((row) => sameId(row.site_id, siteId))
    .map((row) => {
      const candidateIngredient = findIngredient(ingredients, row.ingredient_id);
      if (!candidateIngredient?.id) {
        return null;
      }
      const stock = getInventoryQuantities(row);
      const available = finiteProductionNumber(stock.available_quantity, 0);
      if (available <= 0 || sameId(row.ingredient_id, line.ingredient_id)) {
        return null;
      }

      const candidateFullName = `${row.ingredient_name || ''} ${candidateIngredient.name || ''}`;
      const candidateCategoryTokens = new Set(collectCategoryTokens(candidateIngredient));
      const nameScore = fullNameSimilarityScore(sourceFullName, candidateFullName);
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
