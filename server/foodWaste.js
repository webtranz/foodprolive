import { normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';

const MEAL_SERVICE_SCHEDULE = {
  breakfast: '07:00',
  lunch: '12:00',
  dinner: '19:00'
};

const PRODUCTION_RECORDING_WINDOW_MS = 48 * 60 * 60 * 1000;
const QUANTITY_EPSILON = 0.0000005;
const CORE_MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);
const AVAILABLE_BATCH_STATUSES = new Set(['available', 'partial']);
const BATCH_OVERPRODUCTION_MENU_CATEGORY_ROWS = Object.freeze([
  {
    key: 'senior',
    label: 'Senior',
    waste_key: 'menu-category:senior',
    menu_type: 'general',
    menu_category: 'senior'
  },
  {
    key: 'junior',
    label: 'Junior',
    waste_key: 'menu-category:junior',
    menu_type: 'general',
    menu_category: 'junior'
  },
  {
    key: 'labor',
    label: 'Labor',
    waste_key: 'menu-category:labor',
    menu_type: 'general',
    menu_category: 'labor'
  },
  {
    key: 'philippines',
    label: 'Philippines',
    waste_key: 'menu-category:philippines',
    menu_type: 'philippines',
    menu_category: 'philippines'
  }
]);
const BATCH_OVERPRODUCTION_MENU_CATEGORY_BY_KEY = new Map(
  BATCH_OVERPRODUCTION_MENU_CATEGORY_ROWS.map((category) => [category.key, category])
);
const APPROVAL_ONLY_FIELDS = new Set([
  'approval_status',
  'approved_by',
  'approved_at',
  'status'
]);

export function normalizeMealType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CORE_MEAL_TYPES.has(normalized) ? normalized : '';
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundQuantity(value) {
  return Number(number(value, 0).toFixed(6));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizeText(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function toValidDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = normalizeText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnlyToken(date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate())
  ].join('-');
}

function endOfCalendarMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function isSameCalendarMonth(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth();
}

function isRoutineProducedItemBatch(batch = {}) {
  const sourceType = normalizeText(batch.source_type).toLowerCase();
  return !normalizeText(batch.source_event_id)
    && !['special_event', 'event', 'auto_schedule_unlinked'].includes(sourceType);
}

function getBatchAvailableWeight(batch = {}) {
  return roundQuantity(Math.max(0, number(batch.remaining_weight_grams, 0)));
}

function compareBatchFifo(left = {}, right = {}) {
  const leftTime = normalizeText(left.completed_at || left.production_completed_at || left.created_date);
  const rightTime = normalizeText(right.completed_at || right.production_completed_at || right.created_date);
  const byTime = leftTime.localeCompare(rightTime);
  return byTime || normalizeText(left.id).localeCompare(normalizeText(right.id));
}

function positiveQuantity(value) {
  const numeric = number(value, 0);
  return numeric > QUANTITY_EPSILON ? numeric : 0;
}

function firstPositiveQuantity(values = []) {
  for (const value of values) {
    const numeric = positiveQuantity(value);
    if (numeric > QUANTITY_EPSILON) return numeric;
  }
  return 0;
}

function getWasteAllocationBatchId(allocation = {}) {
  return normalizeText(
    allocation.produced_item_batch_id
      || allocation.batch_id
      || allocation.produced_batch_id
  );
}

export function normalizeRealRecipeId(value) {
  const recipeId = normalizeText(value);
  if (
    !recipeId
    || recipeId.startsWith('batch-overproduction:')
    || recipeId.startsWith('menu-category:')
  ) {
    return null;
  }
  return recipeId;
}

export function normalizeFoodWasteWeightGrams(quantity, unit = 'g') {
  const value = number(quantity, 0);
  const normalizedUnit = normalizeText(unit).toLowerCase();
  if (value <= QUANTITY_EPSILON) return 0;
  if (normalizedUnit === 'kg') return roundQuantity(value * 1000);
  if (['g', 'gram', 'grams'].includes(normalizedUnit)) return roundQuantity(value);
  const error = new Error('Batch overproduction waste must be recorded in grams.');
  error.status = 400;
  throw error;
}

function normalizeBatchOverproductionKeyPart(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildBatchOverproductionRowKey(parts = []) {
  return parts
    .map(normalizeBatchOverproductionKeyPart)
    .filter(Boolean)
    .join(':');
}

function getBatchOverproductionCategory(batch = {}, production = {}) {
  const menuType = normalizeMenuCuisine(
    batch.menu_type
      || batch.cuisine_type
      || batch.menu_cuisine
      || production?.menu_type
      || production?.cuisine_type
      || production?.menu_cuisine,
    ''
  );
  if (menuType === 'philippines') {
    return BATCH_OVERPRODUCTION_MENU_CATEGORY_BY_KEY.get('philippines');
  }

  const menuCategory = normalizeMenuCategory(
    batch.menu_category || production?.menu_category,
    ''
  );
  if (['senior', 'junior', 'labor'].includes(menuCategory)) {
    return BATCH_OVERPRODUCTION_MENU_CATEGORY_BY_KEY.get(menuCategory);
  }
  return null;
}

function getBatchManifestItems(batch = {}, production = {}) {
  const candidateLists = [
    batch.menu_issue_items,
    batch.manifest_lines,
    production?.menu_issue_items,
    production?.manifest_lines
  ];
  const sourceItems = candidateLists.find((items) => Array.isArray(items) && items.length > 0);
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    return [{
      key: batch.production_line_id
        || batch.manifest_item_key
        || batch.source_menu_plan_item_key
        || batch.recipe_id
        || batch.id,
      recipe_id: batch.ingredient_id && batch.recipe_id === batch.ingredient_id ? null : batch.recipe_id,
      ingredient_id: batch.ingredient_id || null,
      recipe_name: batch.item_name
        || batch.recipe_name
        || batch.production_name
        || production?.recipe_name
        || 'Produced item',
      produced_servings: batch.produced_servings,
      produced_weight_grams: batch.produced_weight_grams,
      yielded_weight_grams: batch.produced_weight_grams,
      raw_weight_grams: getBatchRawWeight(batch, production),
      estimated_batch_cost: getBatchProductionCost(batch, production)
    }];
  }

  return sourceItems;
}

function getBatchManifestItemKey(item = {}, index = 0) {
  return normalizeText(
    item.production_line_id
      || item.key
      || item.original_source_menu_plan_item_key
      || item.source_menu_plan_item_key
      || item.menu_plan_item_key
      || item.menu_plan_line_id
      || (normalizeText(item.recipe_id || item.recipe_version_id) ? `recipe:${item.recipe_id || item.recipe_version_id}` : '')
      || (normalizeText(item.ingredient_id) ? `ingredient:${item.ingredient_id}` : '')
      || (normalizeText(item.recipe_name || item.item_name || item.name) ? `name:${item.recipe_name || item.item_name || item.name}` : '')
      || `manifest-item-${index + 1}`
  );
}

function getBatchManifestItemName(item = {}, batch = {}, production = {}) {
  return normalizeText(
    item.recipe_name
      || item.item_name
      || item.ingredient_name
      || item.name
      || batch.item_name
      || batch.recipe_name
      || production?.recipe_name
      || batch.production_name
  ) || 'Produced item';
}

function getBatchManifestItemRecipeId(item = {}) {
  const recipeId = normalizeText(item.recipe_id || item.recipe_version_id);
  const ingredientId = normalizeText(item.ingredient_id);
  if (ingredientId && recipeId === ingredientId) return null;
  return normalizeRealRecipeId(recipeId);
}

function getBatchManifestItemIngredientId(item = {}) {
  return normalizeText(item.ingredient_id) || null;
}

function getBatchManifestItemProducedServings(item = {}, batch = {}) {
  return roundQuantity(firstPositiveQuantity([
    item.produced_servings,
    item.production_covers,
    item.expected_yield_servings,
    item.expected_servings,
    item.requested_servings,
    item.planned_servings,
    batch.produced_servings
  ]));
}

function getBatchManifestItemProducedWeight(item = {}, batch = {}) {
  const directWeight = firstPositiveQuantity([
    item.produced_weight_grams,
    item.yielded_weight_grams,
    item.expected_finished_weight_grams,
    item.actual_finished_weight_grams,
    item.finished_weight_grams,
    item.requested_weight_grams,
    item.planned_weight_grams,
    item.production_size_grams
  ]);
  if (directWeight > QUANTITY_EPSILON) return roundQuantity(directWeight);

  const servings = getBatchManifestItemProducedServings(item, {});
  const portionSize = firstPositiveQuantity([
    item.portion_size_grams,
    item.service_portion_size_grams,
    batch.portion_size_grams
  ]);
  if (servings > QUANTITY_EPSILON && portionSize > QUANTITY_EPSILON) {
    return roundQuantity(servings * portionSize);
  }
  return 0;
}

function isFilledBatchManifestItem(item = {}, batch = {}) {
  return getBatchManifestItemProducedWeight(item, batch) > QUANTITY_EPSILON
    || getBatchManifestItemProducedServings(item, batch) > QUANTITY_EPSILON;
}

function getExistingBatchOverproductionWasteByItem(existingWasteRows = []) {
  const byBatchAndItem = new Map();

  (Array.isArray(existingWasteRows) ? existingWasteRows : [])
    .filter((record) => {
      const status = normalizeText(record.status || record.approval_status).toLowerCase();
      return normalizeText(record.source_type).toLowerCase() === 'batch_overproduction'
        && !['reversed', 'voided', 'cancelled', 'canceled'].includes(status);
    })
    .forEach((record) => {
      const allocations = Array.isArray(record.output_allocations) ? record.output_allocations : [];
      allocations.forEach((allocation) => {
        const batchId = normalizeText(getWasteAllocationBatchId(allocation));
        const itemKeys = [
          allocation.batch_overproduction_item_key
            || record.batch_overproduction_item_key,
          allocation.manifest_item_key || record.manifest_item_key,
          allocation.source_menu_plan_item_key || record.source_menu_plan_item_key
        ].map(normalizeText).filter(Boolean);
        const wastedWeight = roundQuantity(number(allocation.wasted_weight_grams ?? allocation.waste_weight_grams, 0));
        if (!itemKeys.length || wastedWeight <= QUANTITY_EPSILON) return;
        if (batchId) itemKeys.forEach((itemKey) => {
          const key = `${batchId}::${itemKey}`;
          byBatchAndItem.set(key, roundQuantity((byBatchAndItem.get(key) || 0) + wastedWeight));
        });
      });
    });

  return { byBatchAndItem };
}

function getBatchProductionCost(batch = {}, production = {}) {
  return roundQuantity(firstPositiveQuantity([
    batch.total_cost,
    batch.production_cost_total,
    batch.estimated_total_cost,
    production?.total_cost,
    production?.estimated_total_cost,
    production?.yield_total_cost
  ]));
}

function getBatchRawWeight(batch = {}, production = {}) {
  return roundQuantity(firstPositiveQuantity([
    batch.raw_weight_grams,
    batch.recipe_raw_weight_grams,
    batch.total_raw_weight_grams,
    batch.total_raw_consumption_weight_grams,
    production?.raw_weight_grams,
    production?.recipe_raw_weight_grams,
    production?.total_raw_weight_grams,
    production?.total_raw_consumption_weight_grams
  ]));
}

export function buildBatchOverproductionDishSummary(batches = [], productionRows = [], existingWasteRows = []) {
  const productionMap = new Map(
    (Array.isArray(productionRows) ? productionRows : [])
      .filter((production) => production?.id)
      .map((production) => [String(production.id), production])
  );
  const grouped = new Map();
  const existingWaste = getExistingBatchOverproductionWasteByItem(existingWasteRows);

  (Array.isArray(batches) ? batches : [])
    .filter((batch) => (
      isRoutineProducedItemBatch(batch)
      && AVAILABLE_BATCH_STATUSES.has(normalizeText(batch.status).toLowerCase())
      && getBatchAvailableWeight(batch) > QUANTITY_EPSILON
      && number(batch.produced_weight_grams, 0) > QUANTITY_EPSILON
    ))
    .sort(compareBatchFifo)
    .forEach((batch) => {
      const production = productionMap.get(String(batch.production_id || ''));
      const category = getBatchOverproductionCategory(batch, production);
      if (!category) return;
      const candidateItems = getBatchManifestItems(batch, production)
        .map((item, index) => ({ item, index }));
      const manifestItems = candidateItems
        .filter(({ item }) => isFilledBatchManifestItem(item, batch));
      const fallbackItems = manifestItems.length > 0
        ? manifestItems
        : [{
          item: {
            key: batch.production_line_id
              || batch.manifest_item_key
              || batch.source_menu_plan_item_key
              || batch.recipe_id
              || batch.id,
            recipe_id: batch.ingredient_id && batch.recipe_id === batch.ingredient_id ? null : batch.recipe_id,
            ingredient_id: batch.ingredient_id || null,
            recipe_name: batch.item_name
              || batch.recipe_name
              || batch.production_name
              || production?.recipe_name
              || 'Produced item',
            produced_servings: batch.produced_servings,
            produced_weight_grams: batch.produced_weight_grams,
            yielded_weight_grams: batch.produced_weight_grams,
            raw_weight_grams: getBatchRawWeight(batch, production),
            estimated_batch_cost: getBatchProductionCost(batch, production)
          },
          index: 0
        }];

      const rawItemDetails = fallbackItems
        .map(({ item, index }) => {
          const producedWeight = getBatchManifestItemProducedWeight(item, batch);
          return {
            item,
            index,
            producedWeight,
            producedServings: getBatchManifestItemProducedServings(item, batch),
            rawWeight: roundQuantity(firstPositiveQuantity([
              item.raw_weight_grams,
              item.recipe_raw_weight_grams,
              item.total_raw_weight_grams
            ]))
          };
        });
      const directManifestWeight = roundQuantity(
        rawItemDetails.reduce((sum, detail) => sum + Math.max(0, detail.producedWeight), 0)
      );
      const fallbackBatchWeight = roundQuantity(number(batch.produced_weight_grams, 0));
      const missingWeightPool = roundQuantity(Math.max(0, fallbackBatchWeight - directManifestWeight));
      const servingOnlyTotal = roundQuantity(
        rawItemDetails.reduce((sum, detail) => (
          detail.producedWeight > QUANTITY_EPSILON ? sum : sum + detail.producedServings
        ), 0)
      );
      const itemDetails = rawItemDetails
        .map((detail) => {
          if (
            detail.producedWeight > QUANTITY_EPSILON
            || missingWeightPool <= QUANTITY_EPSILON
            || servingOnlyTotal <= QUANTITY_EPSILON
            || detail.producedServings <= QUANTITY_EPSILON
          ) {
            return detail;
          }
          return {
            ...detail,
            producedWeight: roundQuantity(missingWeightPool * (detail.producedServings / servingOnlyTotal))
          };
        })
        .filter((detail) => detail.producedWeight > QUANTITY_EPSILON);
      if (!itemDetails.length) return;

      const manifestWeightTotal = roundQuantity(itemDetails.reduce((sum, detail) => sum + detail.producedWeight, 0));
      const batchServedWeight = roundQuantity(number(batch.served_weight_grams, 0));
      const batchWastedWeight = roundQuantity(number(batch.wasted_weight_grams, 0));
      const batchAvailableWeight = getBatchAvailableWeight(batch);
      const totalKnownItemWaste = roundQuantity(
        itemDetails.reduce((sum, detail) => {
          const itemKey = getBatchManifestItemKey(detail.item, detail.index);
          return sum + number(existingWaste.byBatchAndItem.get(`${normalizeText(batch.id)}::${itemKey}`), 0);
        }, 0)
      );
      const unassignedWasteWeight = roundQuantity(Math.max(0, batchWastedWeight - totalKnownItemWaste));

      itemDetails.forEach((detail) => {
        const item = detail.item;
        const manifestItemKey = getBatchManifestItemKey(item, detail.index);
        const recipeId = getBatchManifestItemRecipeId(item);
        const ingredientId = getBatchManifestItemIngredientId(item);
        const itemName = getBatchManifestItemName(item, batch, production);
        const rowKey = buildBatchOverproductionRowKey([
          'manifest-item',
          category.key,
          recipeId ? `recipe-${recipeId}` : '',
          ingredientId ? `ingredient-${ingredientId}` : '',
          manifestItemKey || itemName
        ]);
        if (!rowKey) return;

        const producedWeight = detail.producedWeight;
        const ratio = manifestWeightTotal > QUANTITY_EPSILON
          ? producedWeight / manifestWeightTotal
          : 1 / itemDetails.length;
        const batchId = normalizeText(batch.id);
        const itemSpecificWaste = roundQuantity(Math.max(
          number(existingWaste.byBatchAndItem.get(`${batchId}::${rowKey}`), 0),
          number(existingWaste.byBatchAndItem.get(`${batchId}::${manifestItemKey}`), 0)
        ));
        const servedWeight = roundQuantity(batchServedWeight * ratio);
        const unassignedWasteForItem = roundQuantity(unassignedWasteWeight * ratio);
        const availableWeight = roundQuantity(Math.max(
          0,
          Math.min(
            producedWeight,
            producedWeight - servedWeight - unassignedWasteForItem - itemSpecificWaste
          )
        ));
        const batchAvailableCap = roundQuantity(Math.max(0, batchAvailableWeight));
        const cappedAvailableWeight = Math.min(availableWeight, batchAvailableCap);

        if (!grouped.has(rowKey)) {
          grouped.set(rowKey, {
            waste_key: rowKey,
            batch_overproduction_item_key: rowKey,
            manifest_item_key: manifestItemKey || null,
            source_menu_plan_item_key: normalizeText(
              item.original_source_menu_plan_item_key
                || item.source_menu_plan_item_key
                || item.menu_plan_item_key
                || item.menu_plan_line_id
            ) || manifestItemKey || null,
            recipe_id: recipeId,
            recipe_name: itemName,
            ingredient_id: ingredientId,
            ingredient_name: normalizeText(item.ingredient_name) || null,
            production_id: null,
            production_name: itemName,
            batch_recipe_id: recipeId,
            batch_recipe_name: itemName,
            menu_category_key: category.key,
            menu_category_label: category.label,
            menu_type: category.menu_type,
            menu_category: category.menu_category,
            produced_servings: 0,
            produced_weight_grams: 0,
            raw_weight_grams: 0,
            served_weight_grams: 0,
            wasted_weight_grams: 0,
            available_weight_grams: 0,
            estimated_total_cost: 0,
            batch_count: 0,
            batches: []
          });
        }

        const row = grouped.get(rowKey);
        const cost = roundQuantity(firstPositiveQuantity([
          item.estimated_batch_cost,
          item.estimated_cost,
          item.actual_cost,
          item.total_cost,
          getBatchProductionCost(batch, production) * ratio
        ]));
        row.produced_servings = roundQuantity(row.produced_servings + detail.producedServings);
        row.produced_weight_grams = roundQuantity(row.produced_weight_grams + producedWeight);
        row.raw_weight_grams = roundQuantity(row.raw_weight_grams + detail.rawWeight);
        row.served_weight_grams = roundQuantity(row.served_weight_grams + servedWeight);
        row.wasted_weight_grams = roundQuantity(row.wasted_weight_grams + itemSpecificWaste + unassignedWasteForItem);
        row.available_weight_grams = roundQuantity(row.available_weight_grams + cappedAvailableWeight);
        row.estimated_total_cost = roundQuantity(row.estimated_total_cost + cost);
        row.batch_count += 1;
        if (!row.production_id) row.production_id = batch.production_id || null;
        if (row.production_id && normalizeText(row.production_id) !== normalizeText(batch.production_id)) {
          row.production_id = null;
        }
        row.batches.push({
          id: batch.id,
          batch_number: batch.batch_number,
          production_id: batch.production_id,
          production_name: batch.production_name || production?.recipe_name || batch.recipe_name || null,
          completed_at: batch.completed_at,
          recipe_id: recipeId,
          recipe_name: itemName,
          ingredient_id: ingredientId,
          ingredient_name: normalizeText(item.ingredient_name) || null,
          batch_recipe_id: batch.recipe_id || null,
          batch_recipe_name: batch.recipe_name || batch.item_name || null,
          menu_category_key: category.key,
          menu_category_label: category.label,
          batch_overproduction_item_key: rowKey,
          manifest_item_key: manifestItemKey || null,
          source_menu_plan_item_key: row.source_menu_plan_item_key,
          produced_weight_grams: producedWeight,
          remaining_weight_grams: cappedAvailableWeight
        });
      });
    });

  return [...grouped.values()]
    .filter((row) => row.produced_weight_grams > QUANTITY_EPSILON)
    .map((row) => ({
      ...row,
      estimated_cost_per_gram: row.produced_weight_grams > QUANTITY_EPSILON
        ? roundQuantity(row.estimated_total_cost / row.produced_weight_grams)
        : 0
    }))
    .sort((left, right) => (
      normalizeText(left.menu_category_label).localeCompare(normalizeText(right.menu_category_label))
      || normalizeText(left.recipe_name).localeCompare(normalizeText(right.recipe_name))
      || normalizeText(left.waste_key).localeCompare(normalizeText(right.waste_key))
    ));
}

export function allocateBatchOverproductionWaste({
  recipeId,
  wasteWeightGrams,
  batches = [],
  productionId = '',
  manifestItemKey = '',
  summaryRow = null,
  sourceAllocations = []
} = {}) {
  const normalizedRecipeId = normalizeText(recipeId);
  const normalizedProductionId = normalizeText(productionId);
  const normalizedManifestItemKey = normalizeText(manifestItemKey);
  const requiredWeight = roundQuantity(wasteWeightGrams);
  const summaryBatches = Array.isArray(summaryRow?.batches) ? summaryRow.batches : [];
  if (!normalizedRecipeId && !normalizedManifestItemKey && summaryBatches.length === 0) {
    const error = new Error('Select a produced menu item before recording batch overproduction waste.');
    error.status = 400;
    throw error;
  }
  if (requiredWeight <= QUANTITY_EPSILON) {
    const error = new Error('Enter recorded food waste in grams for at least one produced menu item.');
    error.status = 400;
    throw error;
  }

  const summaryBatchById = new Map(
    summaryBatches
      .filter((batch) => normalizeText(batch.id))
      .map((batch) => [normalizeText(batch.id), batch])
  );
  const sourceBatchIds = new Set(
    (Array.isArray(sourceAllocations) ? sourceAllocations : [])
      .map((allocation) => getWasteAllocationBatchId(allocation))
      .filter(Boolean)
  );

  const mutableBatches = (Array.isArray(batches) ? batches : [])
    .filter((batch) => (
      isRoutineProducedItemBatch(batch)
      && AVAILABLE_BATCH_STATUSES.has(normalizeText(batch.status).toLowerCase())
      && getBatchAvailableWeight(batch) > QUANTITY_EPSILON
    ))
    .filter((batch) => {
      const batchId = normalizeText(batch.id);
      if (summaryBatchById.size > 0) return summaryBatchById.has(batchId);
      if (sourceBatchIds.size > 0) return sourceBatchIds.has(batchId);
      if (normalizedProductionId) {
        return normalizeText(batch.production_id) === normalizedProductionId;
      }
      return normalizeText(batch.recipe_id) === normalizedRecipeId;
    })
    .map((batch) => ({ ...batch }))
    .sort(compareBatchFifo);
  const getAllocatableWeight = (batch = {}) => {
    const actualAvailable = getBatchAvailableWeight(batch);
    const rowBatch = summaryBatchById.get(normalizeText(batch.id));
    const rowAvailable = positiveQuantity(rowBatch?.remaining_weight_grams);
    return rowAvailable > QUANTITY_EPSILON
      ? roundQuantity(Math.min(actualAvailable, rowAvailable))
      : actualAvailable;
  };
  const availableWeight = roundQuantity(
    mutableBatches.reduce((sum, batch) => sum + getAllocatableWeight(batch), 0)
  );
  if (availableWeight + QUANTITY_EPSILON < requiredWeight) {
    const error = new Error(`Recorded waste exceeds available produced quantity for this menu item. Available: ${availableWeight} g.`);
    error.status = 409;
    throw error;
  }

  let remainingDemand = requiredWeight;
  const allocations = [];
  for (const batch of mutableBatches) {
    if (remainingDemand <= QUANTITY_EPSILON) break;
    const actualBeforeWeight = getBatchAvailableWeight(batch);
    const beforeWeight = getAllocatableWeight(batch);
    const allocatedWeight = roundQuantity(Math.min(remainingDemand, beforeWeight));
    const portionSize = number(batch.portion_size_grams, 0);
    const wastedServings = portionSize > QUANTITY_EPSILON
      ? roundQuantity(allocatedWeight / portionSize)
      : 0;
    const rowBatch = summaryBatchById.get(normalizeText(batch.id)) || {};
    const rowItemKey = normalizeText(
      normalizedManifestItemKey
        || summaryRow?.batch_overproduction_item_key
        || summaryRow?.waste_key
        || rowBatch.batch_overproduction_item_key
    );
    const rowManifestKey = normalizeText(
      summaryRow?.manifest_item_key
        || rowBatch.manifest_item_key
        || normalizedManifestItemKey
    );
    const rowSourceMenuPlanItemKey = normalizeText(
      summaryRow?.source_menu_plan_item_key
        || rowBatch.source_menu_plan_item_key
        || rowManifestKey
    );

    batch.remaining_weight_grams = roundQuantity(Math.max(0, actualBeforeWeight - allocatedWeight));
    batch.wasted_weight_grams = roundQuantity(number(batch.wasted_weight_grams, 0) + allocatedWeight);
    batch.remaining_servings = portionSize > QUANTITY_EPSILON
      ? roundQuantity(batch.remaining_weight_grams / portionSize)
      : roundQuantity(Math.max(0, number(batch.remaining_servings, 0) - wastedServings));
    batch.wasted_servings = roundQuantity(number(batch.wasted_servings, 0) + wastedServings);
    batch.status = batch.remaining_weight_grams <= QUANTITY_EPSILON ? 'consumed' : 'partial';

    allocations.push({
      produced_item_batch_id: batch.id,
      production_id: batch.production_id || null,
      batch_number: batch.batch_number || null,
      portion_size_grams: portionSize,
      wasted_weight_grams: allocatedWeight,
      wasted_production_equivalent_servings: wastedServings,
      remaining_weight_grams_before: actualBeforeWeight,
      remaining_weight_grams_after: batch.remaining_weight_grams,
      row_remaining_weight_grams_before: beforeWeight,
      recipe_id: normalizeRealRecipeId(summaryRow?.recipe_id) || normalizeRealRecipeId(normalizedRecipeId),
      recipe_name: summaryRow?.recipe_name || rowBatch.recipe_name || batch.recipe_name || null,
      ingredient_id: summaryRow?.ingredient_id || rowBatch.ingredient_id || batch.ingredient_id || null,
      ingredient_name: summaryRow?.ingredient_name || rowBatch.ingredient_name || batch.ingredient_name || null,
      batch_overproduction_item_key: rowItemKey || null,
      manifest_item_key: rowManifestKey || null,
      source_menu_plan_item_key: rowSourceMenuPlanItemKey || null,
      batch_recipe_id: batch.recipe_id || null,
      batch_recipe_name: batch.recipe_name || null,
      estimated_cost_per_gram: positiveQuantity(summaryRow?.estimated_cost_per_gram)
    });
    remainingDemand = roundQuantity(Math.max(0, remainingDemand - allocatedWeight));
  }

  return {
    batches: mutableBatches.filter((batch) => (
      allocations.some((allocation) => allocation.produced_item_batch_id === batch.id)
    )),
    allocations,
    wasted_weight_grams: requiredWeight,
    wasted_production_equivalent_servings: roundQuantity(
      allocations.reduce((sum, allocation) => sum + number(allocation.wasted_production_equivalent_servings, 0), 0)
    )
  };
}

export function getMealServiceSchedule(mealType) {
  const normalized = normalizeMealType(mealType);
  return normalized ? MEAL_SERVICE_SCHEDULE[normalized] : null;
}

export function getLatestSuccessfulProductionCompletedAt({
  productions = [],
  producedItemBatches = [],
  mealType = ''
} = {}) {
  const normalizedMealType = normalizeMealType(mealType);
  const candidates = [];

  (Array.isArray(producedItemBatches) ? producedItemBatches : []).forEach((batch) => {
    if (normalizedMealType && normalizeMealType(batch.meal_type) !== normalizedMealType) return;
    const completedAt = toValidDate(batch.completed_at || batch.production_completed_at);
    if (completedAt) candidates.push(completedAt);
  });

  (Array.isArray(productions) ? productions : []).forEach((production) => {
    if (normalizedMealType && normalizeMealType(production.meal_type) !== normalizedMealType) return;
    if (normalizeText(production.status).toLowerCase() !== 'completed') return;
    const completedAt = toValidDate(production.completed_date || production.completed_at);
    if (completedAt) candidates.push(completedAt);
  });

  const latest = candidates.sort((left, right) => right.getTime() - left.getTime())[0];
  return latest ? latest.toISOString() : null;
}

export function getFoodWasteRecordingWindow({
  wasteDate,
  mealType,
  now = new Date(),
  isAdmin = false,
  productionCompletedAt = null,
  successfulProductionCompletedAt = null
} = {}) {
  const normalizedDate = String(wasteDate || '').trim();
  const normalizedMealType = normalizeMealType(mealType);
  const currentDate = toValidDate(now);
  const wasteDateOnly = parseDateOnly(normalizedDate);

  if (!normalizedDate || !normalizedMealType) {
    return {
      meal_type: normalizedMealType,
      served_at: null,
      production_completed_at: null,
      recording_window_basis: isAdmin ? 'admin_month' : 'production_48_hours',
      recording_window_open_at: null,
      recording_deadline_at: null,
      window_status: 'unknown',
      is_within_recording_window: false,
      can_edit: false,
      message: 'Meal date and meal type are required to determine the recording window.'
    };
  }

  if (!wasteDateOnly || !currentDate) {
    return {
      meal_type: normalizedMealType,
      served_at: null,
      production_completed_at: null,
      recording_window_basis: isAdmin ? 'admin_month' : 'production_48_hours',
      recording_window_open_at: null,
      recording_deadline_at: null,
      window_status: 'unknown',
      is_within_recording_window: false,
      can_edit: false,
      message: 'The food waste recording window could not be calculated.'
    };
  }

  if (isAdmin) {
    const todayToken = dateOnlyToken(currentDate);
    const wasteToken = dateOnlyToken(wasteDateOnly);
    const monthDeadline = endOfCalendarMonth(currentDate);
    let windowStatus = 'closed';
    let message = 'Administrators can record waste only for dates in the current month.';

    if (wasteToken > todayToken) {
      windowStatus = 'future_date';
      message = 'Waste cannot be recorded for a future date.';
    } else if (isSameCalendarMonth(wasteDateOnly, currentDate)) {
      windowStatus = 'open';
      message = 'Administrator waste recording is open for dates in the current month.';
    }

    return {
      meal_type: normalizedMealType,
      served_at: null,
      production_completed_at: null,
      recording_window_basis: 'admin_month',
      recording_window_open_at: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).toISOString(),
      recording_deadline_at: monthDeadline.toISOString(),
      window_status: windowStatus,
      is_within_recording_window: windowStatus === 'open',
      can_edit: windowStatus === 'open',
      message
    };
  }

  const completedAt = toValidDate(successfulProductionCompletedAt || productionCompletedAt);
  if (!completedAt) {
    return {
      meal_type: normalizedMealType,
      served_at: null,
      production_completed_at: null,
      recording_window_basis: 'production_48_hours',
      recording_window_open_at: null,
      recording_deadline_at: null,
      window_status: 'before_production',
      is_within_recording_window: false,
      can_edit: false,
      message: 'Food waste can be recorded after production is completed successfully.'
    };
  }

  const deadlineDate = new Date(completedAt.getTime() + PRODUCTION_RECORDING_WINDOW_MS);
  let windowStatus = 'closed';
  let message = 'Food waste recording is closed because more than 48 hours have passed since successful production.';

  if (currentDate < completedAt) {
    windowStatus = 'before_production';
    message = 'Food waste can be recorded after production is completed successfully.';
  } else if (currentDate <= deadlineDate) {
    windowStatus = 'open';
    message = 'Food waste recording is open for 48 hours after successful production.';
  }

  return {
    meal_type: normalizedMealType,
    served_at: null,
    production_completed_at: completedAt.toISOString(),
    recording_window_basis: 'production_48_hours',
    recording_window_open_at: completedAt.toISOString(),
    recording_deadline_at: deadlineDate.toISOString(),
    window_status: windowStatus,
    is_within_recording_window: windowStatus === 'open',
    can_edit: windowStatus === 'open',
    message
  };
}

export function getMealServiceWindow(options = {}) {
  return getFoodWasteRecordingWindow(options);
}

export function isApprovalOnlyWastePatch(patch = {}) {
  const keys = Object.keys(patch || {});
  return keys.length > 0 && keys.every((key) => APPROVAL_ONLY_FIELDS.has(key));
}

export function decorateFoodWasteRecord(record, now = new Date(), options = {}) {
  if (!record) return null;
  return {
    ...record,
    ...getFoodWasteRecordingWindow({
      wasteDate: record.waste_date,
      mealType: record.meal_type,
      productionCompletedAt: record.production_completed_at
        || record.recording_window_open_at
        || record.served_at,
      now,
      isAdmin: Boolean(options.isAdmin)
    })
  };
}

export function buildFoodWasteMenuPlanSummary(menuPlan, mealType) {
  const normalizedMealType = normalizeMealType(mealType);
  const meals = Array.isArray(menuPlan?.meals)
    ? menuPlan.meals.filter((entry) => normalizeMealType(entry.meal_type) === normalizedMealType)
    : [];

  return {
    id: menuPlan?.id || null,
    plan_date: menuPlan?.plan_date || null,
    site_id: menuPlan?.site_id || null,
    site_name: menuPlan?.site_name || null,
    meal_type: normalizedMealType,
    recipes: meals.map((entry, index) => ({
      id: `${menuPlan?.id || 'menu-plan'}-${normalizedMealType}-${index}`,
      recipe_id: entry.recipe_id || null,
      recipe_name: entry.recipe_name || 'Unnamed recipe',
      expected_servings: Number(entry.expected_servings || 0),
      total_cost: Number(entry.total_cost || 0)
    }))
  };
}
