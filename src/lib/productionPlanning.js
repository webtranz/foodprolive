import {
  calculateProductionIngredientCost,
  convertIngredientQuantity
} from '../../shared/ingredientUnits.js';
import { calculateRecipeServingWeight } from '../../shared/recipeWeight.js';
import { formatRecipeQuantity } from '../../shared/recipeNumbers.js';
import { getItemCodeFromRecords } from '../../shared/itemCode.js';
import { formatProductionEventTitle } from '../../shared/productionLabels.js';
import { resolveProductionFulfillmentStore } from '../../shared/productionFulfillment.js';
import {
  getInventoryQuantities,
  getProductionInventoryState
} from './inventoryAvailability.js';

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

function titleCase(value) {
  return textValue(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function itemIdentityLabel(item = {}, fallbackName = 'Ingredient') {
  const itemCode = getItemCodeFromRecords([item], '');
  const itemName = item.ingredient_name || item.ingredient_id || fallbackName;
  return itemCode && itemCode !== '—' ? `${itemCode} ${itemName}` : itemName;
}

function getMenuIssueItems(production = {}) {
  return Array.isArray(production.menu_issue_items) ? production.menu_issue_items : [];
}

function getProductionDishCount(production = {}) {
  const explicitCount = numberValue(production.production_issue_dish_count, 0);
  if (explicitCount > 0) return explicitCount;
  const menuIssueItems = getMenuIssueItems(production);
  return menuIssueItems.length > 0 ? menuIssueItems.length : 1;
}

function isLegacyMenuPlanReviewCandidate(item = {}) {
  const production = item.production || {};
  return item.workflow_status === 'pending_approval'
    && String(production.source_type || '').toLowerCase() === 'menu_plan'
    && production.production_issue_grouped !== true
    && textValue(production.source_menu_plan_id)
    && ['breakfast', 'lunch', 'dinner'].includes(item.meal_type);
}

function aggregateDashboardIngredientLines(lines = [], ingredientMap = new Map()) {
  const groups = new Map();
  lines.forEach((line) => {
    const ingredientId = textValue(line?.ingredient_id);
    if (!ingredientId) return;
    const ingredient = ingredientMap.get(ingredientId) || {};
    const unit = ingredient.unit || line.unit || 'unit';
    const sourceUnit = line.unit || unit;
    let quantity = numberValue(
      line.planned_quantity
        ?? line.required_quantity
        ?? line.raw_quantity
        ?? line.adjusted_quantity,
      0
    );
    try {
      quantity = convertIngredientQuantity(quantity, sourceUnit, unit, ingredient);
    } catch {
      // Keep the submitted unit if this item has custom packaging that cannot
      // be safely normalized client-side.
    }
    const key = `${ingredientId}::${unit}`;
    const current = groups.get(key) || {
      ...line,
      ingredient_id: ingredientId,
      ingredient_name: line.ingredient_name || ingredient.name || ingredientId,
      unit,
      planned_quantity: 0,
      required_quantity: 0,
      raw_quantity: 0,
      yielded_quantity: 0,
      yield_adjusted_quantity: 0,
      estimated_cost: 0,
      source_recipe_names: new Set()
    };
    current.planned_quantity += quantity;
    current.required_quantity += quantity;
    current.raw_quantity += quantity;
    current.yielded_quantity += numberValue(line.yielded_quantity ?? line.yield_adjusted_quantity ?? quantity, 0);
    current.yield_adjusted_quantity = current.yielded_quantity;
    current.estimated_cost += numberValue(line.estimated_cost, 0);
    (Array.isArray(line.source_recipe_names) ? line.source_recipe_names : [])
      .filter(Boolean)
      .forEach((recipeName) => current.source_recipe_names.add(recipeName));
    groups.set(key, current);
  });

  return [...groups.values()].map((line, index) => ({
    ...line,
    line_id: line.line_id || `menu-review-aggregate-${line.ingredient_id}-${index}`,
    planned_quantity: round(line.planned_quantity, 4),
    required_quantity: round(line.required_quantity, 4),
    raw_quantity: round(line.raw_quantity, 4),
    yielded_quantity: round(line.yielded_quantity, 4),
    yield_adjusted_quantity: round(line.yield_adjusted_quantity, 4),
    estimated_cost: round(line.estimated_cost),
    source_recipe_names: [...line.source_recipe_names]
  }));
}

function groupLegacyMenuPlanReviewItems(items, shortages, ingredientMap) {
  const groups = new Map();
  const consumedItemIds = new Set();

  items.forEach((item) => {
    if (!isLegacyMenuPlanReviewCandidate(item)) return;
    const production = item.production || {};
    const key = [
      'legacy-menu-review',
      production.source_menu_plan_id,
      production.site_id,
      production.production_date,
      item.meal_type
    ].join('::');
    const current = groups.get(key) || [];
    current.push(item);
    groups.set(key, current);
  });

  const groupedItems = [...groups.entries()].map(([key, groupItems]) => {
    groupItems.forEach((item) => consumedItemIds.add(item.id));
    const base = groupItems[0];
    const style = PRODUCTION_MEAL_PERIODS.find((period) => period.key === base.meal_type);
    const dishCount = groupItems.reduce((sum, item) => sum + item.dish_count, 0);
    const productionIds = groupItems.map((item) => item.production.id);
    const groupShortages = shortages.filter((shortage) => (
      productionIds.some((productionId) => shortage.production_ids.includes(productionId))
    ));
    const menuIssueItems = groupItems.map((item) => ({
      key: item.production.source_menu_plan_item_key || item.id,
      production_id: item.production.id,
      recipe_id: item.production.recipe_id,
      recipe_name: item.recipe_name,
      production_covers: item.required_portions,
      expected_servings: item.production.source_menu_plan_expected_servings ?? item.required_portions,
      estimated_batch_cost: item.estimated_batch_cost
    }));
    const ingredientLines = aggregateDashboardIngredientLines(
      groupItems.flatMap((item) => item.ingredient_lines.map((line) => ({
        ...line,
        source_recipe_names: [
          ...new Set([
            ...(Array.isArray(line.source_recipe_names) ? line.source_recipe_names : []),
            item.recipe_name
          ].filter(Boolean))
        ]
      }))),
      ingredientMap
    );
    const approvalHistory = groupItems.flatMap((item) => (
      Array.isArray(item.production.approval_history) ? item.production.approval_history : []
    ));
    const production = {
      ...base.production,
      id: key,
      is_menu_review_group: true,
      grouped_productions: groupItems.map((item) => item.production),
      grouped_production_ids: productionIds,
      recipe_id: base.production.recipe_id,
      recipe_name: formatProductionEventTitle({
        ...base.production,
        meal_type: base.meal_type,
        production_issue_grouped: true,
        production_issue_dish_count: dishCount
      }, {
        fallback: `${style?.label || titleCase(base.meal_type)} Menu (${dishCount} dish${dishCount === 1 ? '' : 'es'})`
      }),
      target_servings: groupItems.reduce((sum, item) => sum + item.required_portions, 0),
      estimated_batch_cost: round(groupItems.reduce((sum, item) => sum + item.estimated_batch_cost, 0)),
      status: 'pending_approval',
      production_issue_grouped: true,
      production_issue_dish_count: dishCount,
      menu_issue_items: menuIssueItems,
      ingredients_used: ingredientLines,
      approval_history: approvalHistory,
      linked_material_request_id: null,
      linked_material_request_number: null,
      material_request_status: ''
    };

    return {
      ...base,
      id: key,
      production,
      recipe_name: production.recipe_name,
      recipe: null,
      image_url: '',
      required_portions: production.target_servings,
      batch_yield: 1,
      batches_required: 1,
      estimated_batch_cost: production.estimated_batch_cost,
      menu_issue_items: menuIssueItems,
      dish_count: dishCount,
      station: 'Multiple stations',
      shortages: groupShortages,
      prep_status: resolvePrepStatus(production, groupShortages.length > 0),
      notes: groupItems.map((item) => item.notes).filter(Boolean).join('\n')
    };
  });

  return [
    ...items.filter((item) => !consumedItemIds.has(item.id)),
    ...groupedItems
  ];
}

export function normalizeProductionMealType(value) {
  const normalized = textValue(value).toLowerCase();
  return PRODUCTION_MEAL_PERIODS.some((period) => period.key === normalized)
    ? normalized
    : 'other';
}

function resolveProductionCost(production, ingredientMap) {
  const isCompleted = String(production?.status || '').toLowerCase() === 'completed';
  if (isCompleted) {
    const postedCost = production?.production_cost_total ?? production?.ingredient_cost_total;
    if (postedCost !== null && postedCost !== undefined && postedCost !== '') {
      return round(postedCost);
    }
  }

  const calculated = (Array.isArray(production?.ingredients_used) ? production.ingredients_used : [])
    .reduce((sum, line) => (
      sum + calculateProductionIngredientCost(
        isCompleted ? line : { ...line, actual_quantity: null },
        ingredientMap.get(String(line?.ingredient_id || ''))
      )
    ), 0);

  return round(calculated || production?.estimated_batch_cost || 0);
}

function resolvePortionSize(production, recipe, recipes, ingredients) {
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

  const explicitLabel = textValue(
    production?.portion_size
      || recipe?.portion_size
      || recipe?.serving_size
  );
  if (explicitLabel) {
    return { label: explicitLabel, grams: null, is_complete: true, warnings: [] };
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
      item_code: getItemCodeFromRecords([ingredient, stock]),
      ingredient_name: stock.ingredient_name || ingredient.name || ingredientId,
      on_hand_quantity: 0,
      reserved_quantity: 0,
      available_quantity: 0,
      unit: targetUnit
    };
    const stockQuantities = getInventoryQuantities(stock);
    current.on_hand_quantity += convertIngredientQuantity(
      stockQuantities.on_hand_quantity,
      stock.unit || targetUnit,
      targetUnit,
      ingredient
    );
    current.reserved_quantity += convertIngredientQuantity(
      stockQuantities.reserved_quantity,
      stock.unit || targetUnit,
      targetUnit,
      ingredient
    );
    current.available_quantity += convertIngredientQuantity(
      stockQuantities.available_quantity,
      stock.unit || targetUnit,
      targetUnit,
      ingredient
    );
    map.set(key, current);
  });
  return map;
}

function resolvePlanningInventorySite(production, sites = []) {
  if (production?.fulfillment_store_id) {
    return {
      id: textValue(production.fulfillment_store_id),
      name: production.fulfillment_store_name || production.site_name || ''
    };
  }
  if (!sites.length) {
    return { id: textValue(production?.site_id), name: production?.site_name || '' };
  }
  try {
    const store = resolveProductionFulfillmentStore(production, sites);
    return { id: textValue(store.id), name: store.name || production?.site_name || '' };
  } catch {
    return {
      id: `unrouted:${production?.id || 'production'}`,
      name: 'Fulfillment Store Required'
    };
  }
}

function buildShortages(productions, ingredientMap, inventoryMap, sites) {
  const demandMap = new Map();

  productions.forEach((production) => {
    const workflowStatus = textValue(production?.status).toLowerCase();
    if (['completed', 'in_progress'].includes(workflowStatus) || NON_DEMAND_STATUSES.has(workflowStatus)) return;

    const inventorySite = resolvePlanningInventorySite(production, sites);
    const siteId = inventorySite.id;
    const inventoryState = getProductionInventoryState(production);
    if (inventoryState.is_consumed) return;
    (Array.isArray(production?.ingredients_used) ? production.ingredients_used : []).forEach((line) => {
      const ingredientId = textValue(line?.ingredient_id);
      if (!siteId || !ingredientId) return;
      const ingredient = ingredientMap.get(ingredientId) || {};
      const inventoryRow = inventoryMap.get(`${siteId}::${ingredientId}`);
      const targetUnit = inventoryRow?.unit || ingredient.unit || line.unit || 'unit';
      const requiredQuantity = convertIngredientQuantity(
        line.planned_quantity
          ?? line.yield_adjusted_quantity
          ?? line.required_quantity
          ?? line.adjusted_quantity
          ?? 0,
        line.unit || targetUnit,
        targetUnit,
        ingredient
      );
      const reservationLine = inventoryState.lines.find(
        (reservedLine) => textValue(reservedLine?.ingredient_id) === ingredientId
      );
      const reservedQuantity = inventoryState.is_reserved
        ? convertIngredientQuantity(
          reservationLine?.reserved_quantity
            ?? reservationLine?.committed_quantity
            ?? 0,
          reservationLine?.unit || targetUnit,
          targetUnit,
          ingredient
        )
        : 0;
      const unreservedRequiredQuantity = Math.max(0, requiredQuantity - reservedQuantity);
      if (unreservedRequiredQuantity <= 0) return;
      const key = `${siteId}::${ingredientId}`;
      const demand = demandMap.get(key) || {
        site_id: siteId,
        site_name: inventorySite.name || inventoryRow?.site_name || '',
        ingredient_id: ingredientId,
        item_code: getItemCodeFromRecords([ingredient, line, inventoryRow]),
        ingredient_name: line.ingredient_name || inventoryRow?.ingredient_name || ingredient.name || ingredientId,
        required_quantity: 0,
        on_hand_quantity: numberValue(inventoryRow?.on_hand_quantity, 0),
        reserved_quantity: numberValue(inventoryRow?.reserved_quantity, 0),
        available_quantity: numberValue(inventoryRow?.available_quantity, 0),
        unit: targetUnit,
        production_ids: new Set(),
        recipe_names: new Set()
      };
      demand.required_quantity += unreservedRequiredQuantity;
      demand.production_ids.add(production.id);
      const sourceRecipeNames = Array.isArray(line.source_recipe_names)
        ? line.source_recipe_names.filter(Boolean)
        : [];
      if (sourceRecipeNames.length > 0) {
        sourceRecipeNames.forEach((recipeName) => demand.recipe_names.add(recipeName));
      } else if (production.recipe_name) {
        demand.recipe_names.add(production.recipe_name);
      }
      demandMap.set(key, demand);
    });
  });

  return [...demandMap.values()]
    .map((demand) => ({
      ...demand,
      required_quantity: round(demand.required_quantity),
      on_hand_quantity: round(demand.on_hand_quantity),
      reserved_quantity: round(demand.reserved_quantity),
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
  inventory = [],
  sites = []
} = {}) {
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe?.id || ''), recipe]));
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient?.id || ''), ingredient]));
  const inventoryMap = buildInventoryMap(inventory, ingredientMap);
  const shortages = buildShortages(productions, ingredientMap, inventoryMap, sites);

  const items = productions.map((production) => {
    const recipe = recipeMap.get(String(production?.recipe_id || '')) || null;
    const portions = Math.max(0, numberValue(production?.target_servings, 0));
    const menuIssueItems = getMenuIssueItems(production);
    const dishCount = getProductionDishCount(production);
    const batchYield = Math.max(1, numberValue(production?.batch_yield ?? recipe?.batch_yield ?? recipe?.servings, 1));
    const productionShortages = shortages.filter((shortage) => shortage.production_ids.includes(production.id));
    const workflowStatus = textValue(production?.status || 'planned').toLowerCase();
    const mealType = normalizeProductionMealType(production?.meal_type);
    const productionEventTitle = formatProductionEventTitle(production, {
      fallback: production.recipe_name || recipe?.name || 'Unnamed dish'
    });

    return {
      id: production.id,
      production,
      recipe,
      recipe_name: productionEventTitle,
      menu_issue_items: menuIssueItems,
      dish_count: dishCount,
      ingredient_lines: (Array.isArray(production?.ingredients_used) ? production.ingredients_used : []).map((line) => ({
        ...line,
        item_code: getItemCodeFromRecords([
          ingredientMap.get(String(line?.ingredient_id || '')),
          line
        ])
      })),
      image_url: production.image_url || '',
      meal_type: mealType,
      required_portions: portions,
      portion_size: resolvePortionSize(production, recipe, recipes, ingredients),
      expected_finished_weight_grams: numberValue(production?.expected_finished_weight_grams, null),
      actual_finished_weight_grams: numberValue(production?.actual_finished_weight_grams, null),
      produced_servings: numberValue(production?.produced_servings, null),
      quantity_semantics: production?.quantity_semantics || (Number(production?.yield_adjustment_version) >= 2
        ? 'raw_recipe_to_yielded_output_v2'
        : 'legacy_v1'),
      batch_yield: batchYield,
      batches_required: menuIssueItems.length > 0 ? dishCount : (portions > 0 ? Math.ceil(portions / batchYield) : 0),
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

  const displayItems = groupLegacyMenuPlanReviewItems(items, shortages, ingredientMap);
  const countedItems = displayItems.filter((item) => item.counts_toward_plan);
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
      total_recipes: periodItems.reduce((sum, item) => sum + item.dish_count, 0)
    };
  });
  const labor_loads = buildLaborLoads(displayItems);

  return {
    items: countedItems,
    all_items: displayItems,
    sections,
    shortages,
    labor_loads,
    summary: {
      total_portions: countedItems.reduce((sum, item) => sum + item.required_portions, 0),
      portions_by_meal: Object.fromEntries(sections.map((section) => [section.key, section.total_portions])),
      total_recipes: countedItems.reduce((sum, item) => sum + item.dish_count, 0),
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
  return (dashboard?.items || []).map((item) => {
    const productionIngredients = Array.isArray(item.ingredient_lines)
      ? item.ingredient_lines
      : [];
    const useActualQuantities = item.workflow_status === 'completed';
    return {
      production_date: item.production.production_date || '',
      project_id: item.production.site_id || '',
      project_name: item.production.site_name || '',
      site: item.production.site_name || '',
      fulfillment_store_id: item.production.fulfillment_store_id || '',
      fulfillment_store_name: item.production.fulfillment_store_name || '',
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
      quantity_semantics: item.quantity_semantics,
      expected_finished_weight_grams: item.expected_finished_weight_grams,
      actual_finished_weight_grams: item.actual_finished_weight_grams,
      produced_servings: item.produced_servings,
      shortages: item.shortages.map((shortage) => (
        `${itemIdentityLabel(shortage)}: ${formatRecipeQuantity(shortage.shortage_quantity, shortage.unit)} ${shortage.unit}`
      )).join('; '),
      net_recipe_quantities: productionIngredients
        .filter((line) => line.net_quantity !== null && line.net_quantity !== undefined)
        .map((line) => (
        `${itemIdentityLabel(line)}: ${formatRecipeQuantity(line.net_quantity ?? 0, line.unit)} ${line.unit || ''}`.trim()
        )).join('; '),
      raw_recipe_quantities: productionIngredients.map((line) => (
        `${itemIdentityLabel(line)}: ${formatRecipeQuantity(
          line.raw_quantity
            ?? line.planned_quantity
            ?? line.required_quantity
            ?? 0,
          line.unit
        )} ${line.unit || ''}`.trim()
      )).join('; '),
      expected_yielded_quantities: productionIngredients
        .filter((line) => (
          line.yielded_quantity !== null && line.yielded_quantity !== undefined
        ) || (
          Number(item.production?.yield_adjustment_version) >= 2
          && line.net_quantity !== null
          && line.net_quantity !== undefined
        ))
        .map((line) => (
          `${itemIdentityLabel(line)}: ${formatRecipeQuantity(
            line.yielded_quantity ?? line.net_quantity ?? 0,
            line.unit
          )} ${line.unit || ''}`.trim()
        )).join('; '),
      ingredient_quantities: productionIngredients.map((line) => (
        `${itemIdentityLabel(line)}: ${formatRecipeQuantity(
          (useActualQuantities ? line.actual_quantity : null)
            ?? line.planned_quantity
            ?? line.yield_adjusted_quantity
            ?? line.required_quantity
            ?? 0,
          line.unit
        )} ${line.unit || ''}`.trim()
      )).join('; '),
      yield_details: productionIngredients
        .filter((line) => line.yield_percent !== null && line.yield_percent !== undefined)
        .map((line) => (
          `${itemIdentityLabel(line)}: ${formatRecipeQuantity(line.yield_percent, 'percent')}%`
        )).join('; '),
      notes: item.notes
    };
  });
}
