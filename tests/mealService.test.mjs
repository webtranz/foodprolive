import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  allocateMealServiceDemand,
  assertMealServiceIdempotencyMatch,
  attendanceReplayResponse,
  batchMatchesMenuSelection,
  buildResolvedBatchClassificationPatch,
  buildMealServiceDemand,
  buildMealServiceReportData,
  buildMealServiceReversalAllocationEntries,
  buildMealServiceReversalPortionMetadata,
  buildMealServiceRequestFingerprint,
  buildMealServiceAvailabilitySnapshot,
  buildMealServiceScopeKey,
  buildProducedItemBatchSnapshot,
  convertMealServiceRemainderToWaste,
  groupMealServiceProducedDishes,
  getMealServiceReport,
  normalizeManualMealPortionSize,
  normalizeMealServiceAttendeeCount,
  normalizeMealServiceMenuCategory,
  normalizeMealServiceMenuType,
  normalizeMealServiceDishCovers,
  normalizePreparedMealSelections,
  normalizeProducedItemMealType,
  reconcileMealServiceItemsWithWaste,
  resolveLegacyProductionMenuClassification,
  resolveMealServicePortionSize,
  resolveMenuPlanPreparedMealSelections,
  reverseMealServiceAllocations,
  reverseMealServiceWasteAllocations,
  selectMealServiceMenuPlan
} from '../server/mealService.js';
import {
  authorizeEntityAction,
  validateEntityPayload
} from '../server/entities.js';

function source(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function assertHttpError(run, status, pattern) {
  assert.throws(run, (error) => {
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

const recipe = {
  id: 'recipe-rice',
  name: 'Steamed Rice',
  servings: 10,
  portion_size_grams: 250,
  ingredients: []
};

function batch(overrides = {}) {
  return {
    id: 'batch-default',
    batch_number: 'PIB-DEFAULT',
    production_id: 'production-default',
    production_date: '2026-09-02',
    completed_at: '2026-09-02T08:00:00.000Z',
    site_id: 'project-1',
    recipe_id: recipe.id,
    recipe_name: recipe.name,
    meal_type: 'lunch',
    portion_size_grams: 250,
    produced_servings: 4,
    produced_weight_grams: 1000,
    served_servings: 0,
    served_weight_grams: 0,
    remaining_servings: 4,
    remaining_weight_grams: 1000,
    status: 'available',
    ...overrides
  };
}

function preparedMealSelection(overrides = {}) {
  return {
    produced_item_batch_id: 'batch-default',
    recipe_id: recipe.id,
    portion_size_grams: 250,
    portions_per_attendee: 1,
    portion_size_source: 'meal_service_manual',
    ...overrides
  };
}

test('production completion freezes yielded serving weight and creates a reconciled output balance', () => {
  const snapshot = buildProducedItemBatchSnapshot({
    production: {
      id: 'production-1',
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      site_id: 'project-1',
      site_name: 'Project One',
      production_date: '2026-09-02',
      meal_type: 'lunch',
      menu_type: 'philippines',
      menu_category: 'labor',
      target_servings: 10,
      expected_yield_servings: 8,
      expected_finished_weight_grams: 2000,
      portion_size_grams: 250
    },
    recipe,
    recipes: [recipe],
    completedAt: '2026-09-02T08:00:00.000Z',
    actor: { email: 'chef@example.test', full_name: 'Chef' }
  });

  assert.equal(snapshot.portion_size_grams, 250);
  assert.equal(snapshot.service_portion_size_grams, null);
  assert.equal(snapshot.expected_servings, 8);
  assert.equal(snapshot.expected_finished_weight_grams, 2000);
  assert.equal(snapshot.actual_finished_weight_grams, 2000);
  assert.equal(snapshot.produced_servings, 8);
  assert.equal(snapshot.remaining_servings, 8);
  assert.equal(snapshot.remaining_weight_grams, 2000);
  assert.equal(snapshot.served_servings, 0);
  assert.equal(snapshot.menu_type, 'philippines');
  assert.equal(snapshot.menu_category, 'labor');
  assert.equal(snapshot.reconciliation_mode, 'automatic_yield_plan');
  assert.equal(validateEntityPayload('ProducedItemBatch', snapshot).production_id, 'production-1');

  const withoutOperatorActuals = buildProducedItemBatchSnapshot({
    production: {
      id: 'production-2',
      recipe_id: recipe.id,
      site_id: 'project-1',
      production_date: '2026-09-02',
      meal_type: 'lunch',
      menu_type: 'general',
      menu_category: 'senior',
      target_servings: 4,
      portion_size_grams: 250
    },
    recipe
  });
  assert.equal(withoutOperatorActuals.produced_weight_grams, 1000);
  assert.equal(withoutOperatorActuals.produced_servings, 4);
  assert.equal(withoutOperatorActuals.menu_type, 'general');
  assert.equal(withoutOperatorActuals.menu_category, 'senior');
  assert.equal(validateEntityPayload('ProducedItemBatch', withoutOperatorActuals).menu_type, 'general');
});

test('production output supports snack while manual customer meal service remains limited to core meals', () => {
  assert.equal(normalizeProducedItemMealType('Snack'), 'snack');
  const snapshot = buildProducedItemBatchSnapshot({
    production: {
      id: 'production-snack',
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      site_id: 'project-1',
      production_date: '2026-09-02',
      meal_type: 'snack',
      menu_type: 'general',
      menu_category: 'senior',
      expected_yield_servings: 2,
      expected_finished_weight_grams: 500,
      portion_size_grams: 250
    },
    recipe
  });
  assert.equal(snapshot.meal_type, 'snack');
  assert.equal(validateEntityPayload('ProducedItemBatch', snapshot).meal_type, 'snack');
});

test('admin legacy repair requires an exact operational menu and never weakens new production classification', () => {
  const legacy = {
    id: 'production-legacy', status: 'in_progress', site_id: 'project-1',
    production_date: '2026-09-02', meal_type: 'lunch', recipe_id: 'recipe-rice'
  };
  const plan = {
    id: 'menu-1', site_id: 'project-1', plan_date: '2026-09-02', status: 'approved',
    menu_type: 'general', menu_category: 'senior',
    meals: [{ meal_type: 'lunch', recipe_id: 'recipe-rice' }]
  };
  assert.deepEqual(resolveLegacyProductionMenuClassification(legacy, plan), {
    menu_plan_id: 'menu-1', menu_type: 'general', menu_category: 'senior'
  });
  assertHttpError(
    () => resolveLegacyProductionMenuClassification({ ...legacy, status: 'draft' }, plan),
    409,
    /beyond editable planning/
  );
  assertHttpError(
    () => resolveLegacyProductionMenuClassification(legacy, { ...plan, menu_type: null }),
    409,
    /explicit menu type and category/
  );
  assertHttpError(
    () => resolveLegacyProductionMenuClassification({ ...legacy, source_type: 'special_event' }, plan),
    409,
    /cannot use legacy/
  );
  assertHttpError(
    () => buildProducedItemBatchSnapshot({
      production: { ...legacy, target_servings: 1 }, recipe, recipes: [recipe]
    }),
    409,
    /Menu Type and Menu Category/
  );
  const server = source('server/index.js');
  assert.match(server, /repair-menu-classification[\s\S]*Only administrators can repair legacy/);
  assert.match(server, /LEGACY_PRODUCTION_MENU_CLASSIFICATION_REPAIRED/);
});

test('produced output preserves source linkage and special-event batches stay outside routine meal service', () => {
  const snapshot = buildProducedItemBatchSnapshot({
    production: {
      id: 'event-production',
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      site_id: 'project-1',
      production_date: '2026-09-02',
      meal_type: 'lunch',
      expected_yield_servings: 2,
      expected_finished_weight_grams: 500,
      portion_size_grams: 250,
      source_type: 'special_event',
      source_event_id: 'event-1',
      menu_plan_id: 'event-menu-plan'
    },
    recipe
  });
  const validated = validateEntityPayload('ProducedItemBatch', snapshot);
  assert.equal(validated.source_type, 'special_event');
  assert.equal(validated.source_event_id, 'event-1');
  assert.equal(validated.menu_plan_id, 'event-menu-plan');
  assert.equal(batchMatchesMenuSelection(
    { ...snapshot, id: 'event-batch' },
    'general',
    'labor',
    new Set([recipe.id]),
    [{
      site_id: 'project-1',
      plan_date: '2026-09-02',
      cuisine_type: 'general',
      menu_category: 'labor',
      meals: [{ recipe_id: recipe.id, meal_type: 'lunch' }]
    }],
    'lunch'
  ), false);
});

test('meal-service serving size falls back only to persisted recipe yield weight divided by servings', () => {
  assert.equal(resolveMealServicePortionSize({ portion_size_grams: 250 }, { portion_size_grams: 300 }), 300);
  assert.equal(resolveMealServicePortionSize({ grams_per_serving: 225 }), 225);
  assert.equal(resolveMealServicePortionSize({ total_recipe_weight_grams: 1800, servings: 8 }), 225);
  assert.equal(resolveMealServicePortionSize({ servings: 8 }), 0);
  assert.doesNotMatch(source('server/mealService.js'), /\b550\b/);
});

test('server validates aggregate arrivals as an integer from one through 500', () => {
  assert.equal(normalizeMealServiceAttendeeCount('1'), 1);
  assert.equal(normalizeMealServiceAttendeeCount(500), 500);
  for (const invalid of [0, 501, 4.5, 'five', null]) {
    assertHttpError(() => normalizeMealServiceAttendeeCount(invalid), 400, /whole number from 1 to 500/);
  }
});

test('menu dimensions and customer-entered prepared-meal portions are normalized and validated', () => {
  assert.equal(normalizeMealServiceMenuType('Filipino'), 'philippines');
  assert.equal(normalizeMealServiceMenuCategory('Labour', 'philippines'), 'labor');
  assert.equal(normalizeManualMealPortionSize('0200.500'), 200.5);
  assert.deepEqual(normalizePreparedMealSelections([{
    produced_item_batch_id: 'batch-rice',
    portion_size_grams: '0200',
    portions_per_attendee: '1.5'
  }]), [{
    produced_item_batch_id: 'batch-rice',
    portion_size_grams: 200,
    portions_per_attendee: 1.5
  }]);
  assertHttpError(
    () => normalizeMealServiceMenuCategory('management_menu', 'philippines'),
    400,
    /not available/
  );
  assertHttpError(() => normalizeManualMealPortionSize(0), 400, /greater than zero/);
  assertHttpError(
    () => normalizePreparedMealSelections([{
      produced_item_batch_id: 'batch-rice',
      recipe_id: 'injected-recipe',
      portion_size_grams: 200
    }]),
    400,
    /resolved by the server/
  );
  assertHttpError(
    () => normalizePreparedMealSelections([
      { produced_item_batch_id: 'batch-rice', portion_size_grams: 200 },
      { production_batch_id: 'batch-rice', portion_size_grams: 250 }
    ]),
    400,
    /only once/
  );
});

test('prepared meals are selected by production batch and must belong to the chosen menu line', () => {
  const plan = {
    meals: [
      { id: 'line-rice', recipe_id: 'recipe-rice', recipe_name: 'Steamed Rice', meal_type: 'lunch' },
      { id: 'line-stew', recipe_id: 'recipe-stew', recipe_name: 'Beef Stew', meal_type: 'lunch' }
    ]
  };
  const batches = [
    batch({ id: 'batch-rice' }),
    batch({ id: 'batch-stew', recipe_id: 'recipe-stew', recipe_name: 'Beef Stew' }),
    batch({ id: 'batch-unlinked', recipe_id: 'recipe-dessert', recipe_name: 'Dessert' })
  ];
  const selected = resolveMenuPlanPreparedMealSelections(plan, 'lunch', [{
    produced_item_batch_id: 'batch-rice',
    portion_size_grams: 200,
    portions_per_attendee: 1
  }], batches);
  assert.deepEqual(selected, [{
    produced_item_batch_id: 'batch-rice',
    portion_size_grams: 200,
    portions_per_attendee: 1,
    recipe_id: 'recipe-rice',
    recipe_name: 'Steamed Rice',
    meal_plan_line_id: 'line-rice',
    servings_per_attendee: 1,
    portion_size_source: 'meal_service_manual'
  }]);
  assertHttpError(
    () => resolveMenuPlanPreparedMealSelections(plan, 'lunch', [{
      produced_item_batch_id: 'batch-unlinked',
      portion_size_grams: 200
    }], batches),
    409,
    /does not belong/
  );
});

test('duplicate menu recipe lines collapse deterministically while a non-empty subset remains valid', () => {
  const plan = {
    meals: [
      { id: 'first-rice-line', recipe_id: 'recipe-rice', recipe_name: 'Rice First', meal_type: 'lunch' },
      { id: 'second-rice-line', recipe_id: 'recipe-rice', recipe_name: 'Rice Second', meal_type: 'lunch' },
      { id: 'stew-line', recipe_id: 'recipe-stew', recipe_name: 'Stew', meal_type: 'lunch' }
    ]
  };
  const selected = resolveMenuPlanPreparedMealSelections(plan, 'lunch', [{
    produced_item_batch_id: 'batch-rice',
    portion_size_grams: 200
  }], [batch({ id: 'batch-rice', recipe_name: '' })]);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].meal_plan_line_id, 'first-rice-line');
  assert.equal(selected[0].recipe_name, 'Rice First');
});

test('menu resolution enforces exact project, date, meal, classification, status, and non-event linkage', () => {
  const basePlan = {
    id: 'target-plan',
    site_id: 'project-1',
    plan_date: '2026-09-02',
    status: 'approved',
    cuisine_type: 'general',
    menu_category: 'labor',
    meals: [{ recipe_id: 'recipe-rice', meal_type: 'lunch' }]
  };
  const noise = [
    { ...basePlan, id: 'wrong-site', site_id: 'project-2' },
    { ...basePlan, id: 'wrong-date', plan_date: '2026-09-03' },
    { ...basePlan, id: 'wrong-meal', meals: [{ recipe_id: 'recipe-rice', meal_type: 'dinner' }] },
    { ...basePlan, id: 'wrong-type', cuisine_type: 'philippines' },
    { ...basePlan, id: 'wrong-category', menu_category: 'senior' },
    { ...basePlan, id: 'draft-menu', status: 'draft' },
    { ...basePlan, id: 'event-menu', event_name: 'Private event' }
  ];
  const result = selectMealServiceMenuPlan([basePlan, ...noise], {
    siteId: 'project-1',
    serviceDate: '2026-09-02',
    mealType: 'lunch',
    menuType: 'general',
    menuCategory: 'labor'
  });
  assert.equal(result.plan.id, 'target-plan');
  assertHttpError(
    () => selectMealServiceMenuPlan([basePlan, { ...basePlan, id: 'duplicate' }], {
      siteId: 'project-1', serviceDate: '2026-09-02', mealType: 'lunch', menuType: 'general', menuCategory: 'labor'
    }),
    409,
    /More than one active menu/
  );
});

test('legacy untagged output is eligible only when its menu classification is unambiguous', () => {
  const legacyBatch = batch({ menu_type: null, menu_category: null });
  const generalLabor = {
    site_id: 'project-1',
    plan_date: '2026-09-02',
    cuisine_type: 'general',
    menu_category: 'labor',
    meals: [{ recipe_id: recipe.id, meal_type: 'lunch' }]
  };
  const menuRecipeIds = new Set([recipe.id]);
  assert.equal(batchMatchesMenuSelection(
    legacyBatch, 'general', 'labor', menuRecipeIds, [generalLabor], 'lunch'
  ), true);
  assert.equal(batchMatchesMenuSelection(
    legacyBatch,
    'general',
    'labor',
    menuRecipeIds,
    [generalLabor, { ...generalLabor, cuisine_type: 'philippines' }],
    'lunch'
  ), false);
  assert.deepEqual(buildResolvedBatchClassificationPatch(legacyBatch, {
    menuType: 'general',
    menuCategory: 'labor',
    menuPlanId: 'menu-plan-1'
  }), {
    menu_type: 'general',
    menu_category: 'labor',
    menu_plan_id: 'menu-plan-1'
  });
});

test('menu-plan report defense excludes attendance and produced output from another plan', () => {
  const report = buildMealServiceReportData({
    menuPlanId: 'menu-plan-a',
    records: [
      { id: 'a', menu_plan_id: 'menu-plan-a', status: 'posted', attendee_count: 2 },
      { id: 'b', menu_plan_id: 'menu-plan-b', status: 'posted', attendee_count: 9 }
    ],
    producedBatches: [
      { menu_plan_id: 'menu-plan-a', meal_type: 'lunch', produced_servings: 4, produced_weight_grams: 1000, remaining_servings: 2, remaining_weight_grams: 500 },
      { menu_plan_id: 'menu-plan-b', meal_type: 'lunch', produced_servings: 40, produced_weight_grams: 10000, remaining_servings: 20, remaining_weight_grams: 5000 }
    ]
  });
  assert.deepEqual(report.rows.map((row) => row.attendance_id), ['a']);
  assert.equal(report.summary.attendee_count, 2);
  assert.equal(report.summary.produced_weight_grams, 1000);
  assert.equal(report.summary.remaining_weight_grams, 500);
});

test('demand reports produced, available, and shortage balances from frozen output batches', () => {
  const batches = [
    batch({
      id: 'consumed',
      batch_number: 'PIB-CONSUMED',
      production_id: 'production-consumed',
      completed_at: '2026-09-02T07:00:00.000Z',
      produced_servings: 1,
      produced_weight_grams: 250,
      served_servings: 1,
      served_weight_grams: 250,
      remaining_servings: 0,
      remaining_weight_grams: 0,
      status: 'consumed'
    }),
    batch({
      id: 'old',
      batch_number: 'PIB-OLD',
      production_id: 'production-old',
      produced_servings: 4,
      produced_weight_grams: 1000,
      served_servings: 2,
      served_weight_grams: 500,
      remaining_servings: 2,
      remaining_weight_grams: 500
    }),
    batch({
      id: 'new',
      batch_number: 'PIB-NEW',
      production_id: 'production-new',
      completed_at: '2026-09-02T09:00:00.000Z',
      produced_servings: 3,
      produced_weight_grams: 750,
      remaining_servings: 3,
      remaining_weight_grams: 750
    })
  ];
  const [item] = buildMealServiceDemand({
    attendeeCount: 6,
    selections: [preparedMealSelection()],
    recipes: [recipe],
    batches
  });

  assert.equal(item.required_servings, 6);
  assert.equal(item.required_weight_grams, 1500);
  assert.equal(item.produced_servings, 8);
  assert.equal(item.previously_served_servings, 3);
  assert.equal(item.available_servings, 5);
  assert.equal(item.shortage_servings, 1);
  assert.equal(item.shortage_weight_grams, 250);
});

test('finished servings allocate FIFO, persist partial shortages, and never become negative', () => {
  const oldBatch = batch({
    id: 'old',
    batch_number: 'PIB-OLD',
    production_id: 'production-old',
    produced_servings: 2,
    produced_weight_grams: 500,
    remaining_servings: 2,
    remaining_weight_grams: 500
  });
  const newBatch = batch({
    id: 'new',
    batch_number: 'PIB-NEW',
    production_id: 'production-new',
    completed_at: '2026-09-02T09:00:00.000Z',
    produced_servings: 3,
    produced_weight_grams: 750,
    remaining_servings: 3,
    remaining_weight_grams: 750
  });
  const demand = buildMealServiceDemand({
    attendeeCount: 6,
    selections: [preparedMealSelection()],
    recipes: [recipe],
    batches: [newBatch, oldBatch]
  });
  const allocation = allocateMealServiceDemand(demand, [newBatch, oldBatch]);
  const item = allocation.items[0];

  assert.deepEqual(item.batch_allocations.map((entry) => [entry.produced_item_batch_id, entry.servings]), [
    ['old', 2],
    ['new', 3]
  ]);
  assert.equal(item.allocated_servings, 5);
  assert.equal(item.shortage_servings, 1);
  assert.equal(item.remaining_available_servings, 0);
  assert.ok(allocation.batches.every((entry) => entry.remaining_servings >= 0));
  assert.equal(oldBatch.remaining_servings, 2, 'allocation planning must not mutate locked source snapshots');
});

test('mixed production batch sizes consume exact manual portion weight across FIFO batches', () => {
  const demand = buildMealServiceDemand({
    attendeeCount: 3,
    selections: [preparedMealSelection()],
    recipes: [recipe],
    batches: [
      batch({ id: 'old-250', batch_number: 'PIB-250', produced_servings: 1, produced_weight_grams: 250, remaining_servings: 1, remaining_weight_grams: 250 }),
      batch({ id: 'new-300', batch_number: 'PIB-300', completed_at: '2026-09-02T09:00:00.000Z', portion_size_grams: 300, produced_servings: 1, produced_weight_grams: 300, remaining_servings: 1, remaining_weight_grams: 300 })
    ]
  });

  assert.equal(demand[0].allocated_servings, 2.2);
  assert.equal(demand[0].allocated_weight_grams, 550);
  assert.equal(demand[0].shortage_servings, 0.8);
  assert.equal(demand[0].shortage_weight_grams, 200);
  assert.equal(demand[0].required_weight_grams, 750);
  assert.equal(
    demand[0].required_weight_grams,
    demand[0].allocated_weight_grams + demand[0].shortage_weight_grams
  );
  assert.deepEqual(
    demand[0].batch_allocations.map((entry) => [entry.produced_item_batch_id, entry.weight_grams]),
    [['old-250', 250], ['new-300', 300]]
  );
});

test('manual customer portion weight drives FIFO usage while production-equivalent servings stay reconciled', () => {
  const producedBatch = batch({
    id: 'batch-2500',
    produced_servings: 10,
    produced_weight_grams: 2500,
    remaining_servings: 10,
    remaining_weight_grams: 2500,
    portion_size_grams: 250
  });
  const demand = buildMealServiceDemand({
    attendeeCount: 13,
    selections: [{
      produced_item_batch_id: producedBatch.id,
      recipe_id: recipe.id,
      portion_size_grams: 200,
      portions_per_attendee: 1,
      portion_size_source: 'meal_service_manual'
    }],
    recipes: [recipe],
    batches: [producedBatch]
  });
  const item = demand[0];

  assert.equal(item.portion_size_grams, 200);
  assert.equal(item.required_servings, 13);
  assert.equal(item.required_weight_grams, 2600);
  assert.equal(item.allocated_servings, 12.5);
  assert.equal(item.allocated_weight_grams, 2500);
  assert.equal(item.shortage_servings, 0.5);
  assert.equal(item.shortage_weight_grams, 100);
  assert.equal(item.batch_allocations[0].meal_portions, 12.5);
  assert.equal(item.batch_allocations[0].production_equivalent_servings, 10);

  const allocation = allocateMealServiceDemand(demand, [producedBatch]);
  assert.equal(allocation.batches[0].served_servings, 10);
  assert.equal(allocation.batches[0].served_weight_grams, 2500);
  assert.equal(allocation.batches[0].remaining_servings, 0);
  assert.equal(allocation.batches[0].remaining_weight_grams, 0);
  const [restored] = reverseMealServiceAllocations(
    [{ allocations: allocation.items[0].batch_allocations }],
    allocation.batches
  );
  assert.equal(restored.served_servings, 0);
  assert.equal(restored.served_weight_grams, 0);
  assert.equal(restored.remaining_servings, 10);
  assert.equal(restored.remaining_weight_grams, 2500);

  const reversalEntries = buildMealServiceReversalAllocationEntries(
    allocation.items[0].batch_allocations
  );
  for (const field of ['servings', 'production_equivalent_servings', 'meal_portions', 'weight_grams']) {
    const posted = allocation.items[0].batch_allocations.reduce((sum, entry) => sum + Number(entry[field] || 0), 0);
    const reversed = reversalEntries.reduce((sum, entry) => sum + Number(entry[field] || 0), 0);
    assert.equal(Number((posted + reversed).toFixed(6)), 0, `${field} must net to zero after reversal`);
  }
});

test('manual service consumes all remaining grams despite stale legacy serving counters', () => {
  const legacyBatch = batch({
    id: 'legacy-rounded',
    portion_size_grams: 250,
    produced_servings: 10,
    produced_weight_grams: 2500,
    served_servings: 1,
    served_weight_grams: 0,
    remaining_servings: 9,
    remaining_weight_grams: 2500
  });
  let current = legacyBatch;
  let consumedWeight = 0;
  for (let index = 0; index < 10; index += 1) {
    const allocation = allocateMealServiceDemand([{
      recipe_id: recipe.id,
      portion_size_grams: 125,
      portion_size_source: 'meal_service_manual',
      required_servings: 2,
      required_weight_grams: 250,
      available_servings: current.remaining_weight_grams / 125,
      available_weight_grams: current.remaining_weight_grams
    }], [current]);
    consumedWeight += allocation.items[0].allocated_weight_grams;
    [current] = allocation.batches;
  }

  assert.equal(consumedWeight, 2500);
  assert.equal(current.remaining_weight_grams, 0);
  assert.equal(current.remaining_servings, 0);
  assert.equal(current.served_weight_grams, 2500);
  assert.equal(current.served_servings, 10);
});

test('reversal restores the exact output allocations and rejects unreconciled/tampered balances', () => {
  const sourceBatches = [
    batch({ id: 'old', batch_number: 'PIB-OLD', production_id: 'production-old', produced_servings: 2, produced_weight_grams: 500, remaining_servings: 2, remaining_weight_grams: 500 }),
    batch({ id: 'new', batch_number: 'PIB-NEW', production_id: 'production-new', completed_at: '2026-09-02T09:00:00.000Z', produced_servings: 3, produced_weight_grams: 750, remaining_servings: 3, remaining_weight_grams: 750 })
  ];
  const demand = buildMealServiceDemand({
    attendeeCount: 4,
    selections: [preparedMealSelection()],
    recipes: [recipe],
    batches: sourceBatches
  });
  const allocated = allocateMealServiceDemand(demand, sourceBatches);
  const consumptions = [{ allocations: allocated.items[0].batch_allocations }];
  const restored = reverseMealServiceAllocations(consumptions, allocated.batches);

  assert.deepEqual(
    restored.map((entry) => [entry.id, entry.served_servings, entry.remaining_servings]),
    [['old', 0, 2], ['new', 0, 3]]
  );
  assertHttpError(
    () => reverseMealServiceAllocations(consumptions, allocated.batches.map((entry) => ({
      ...entry,
      served_servings: 0,
      served_weight_grams: 0
    }))),
    409,
    /cannot be reversed exactly/
  );
});

test('legacy reversal retains its original recipe-derived portion provenance', () => {
  assert.deepEqual(buildMealServiceReversalPortionMetadata({ portion_size_grams: 250 }), {
    manual_portion_size_grams: null,
    portion_size_source: null
  });
  assert.deepEqual(buildMealServiceReversalPortionMetadata({
    portion_size_grams: 250,
    manual_portion_size_grams: 200,
    portion_size_source: 'meal_service_manual'
  }), {
    manual_portion_size_grams: 200,
    portion_size_source: 'meal_service_manual'
  });
});

test('idempotency fingerprint is stable for equivalent requests and rejects key reuse with different input', () => {
  const base = {
    site_id: 'project-1',
    service_date: '2026-09-02',
    meal_type: 'lunch',
    menu_type: 'general',
    menu_category: 'labor',
    availability_snapshot: 'snapshot-a',
    dishes: [
      { recipe_id: 'recipe-b', covers: 10 },
      { recipe_id: 'recipe-a', covers: 20 }
    ]
  };
  const fingerprint = buildMealServiceRequestFingerprint(base);
  assert.equal(fingerprint.length, 64);
  assert.equal(
    fingerprint,
    buildMealServiceRequestFingerprint({ ...base, dishes: [...base.dishes].reverse() })
  );
  assert.notEqual(fingerprint, buildMealServiceRequestFingerprint({
    ...base,
    dishes: [{ ...base.dishes[0], covers: 11 }, base.dishes[1]]
  }));
  assert.notEqual(fingerprint, buildMealServiceRequestFingerprint({
    ...base,
    availability_snapshot: 'snapshot-b'
  }));
  assert.equal(assertMealServiceIdempotencyMatch({ request_fingerprint: fingerprint }, fingerprint), true);
  assertHttpError(
    () => buildMealServiceRequestFingerprint({ ...base, dishes: [] }),
    400,
    /covers/
  );
  const replay = attendanceReplayResponse({
    id: 'attendance-1',
    attendee_count: 10,
    items: [{ recipe_id: 'recipe-a', allocated_servings: 10 }],
    summary: { served_servings: 10 }
  }, [{ id: 'consumption-1' }]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attendance.id, 'attendance-1');
  assert.equal(replay.consumptions[0].id, 'consumption-1');
  assert.equal(replay.summary.served_servings, 10);
  assertHttpError(
    () => assertMealServiceIdempotencyMatch({ request_fingerprint: fingerprint }, 'different'),
    409,
    /already used for different/
  );
});

test('production-only meal service groups exact output by dish and validates whole-number covers', () => {
  const batches = [{
    id: 'batch-1', recipe_id: 'recipe-1', recipe_name: 'Rice', status: 'available',
    portion_size_grams: 250, service_portion_size_grams: 200,
    produced_servings: 10, produced_weight_grams: 2500,
    served_servings: 0, served_weight_grams: 0,
    wasted_servings: 0, wasted_weight_grams: 0,
    remaining_servings: 10, remaining_weight_grams: 2500,
    completed_at: '2026-09-03T08:00:00.000Z'
  }];
  const [dish] = groupMealServiceProducedDishes(batches);
  assert.equal(dish.service_portion_size_grams, 200);
  assert.equal(dish.available_covers, 12);
  assert.deepEqual(normalizeMealServiceDishCovers([{ recipe_id: 'recipe-1', covers: 12 }]), [
    { recipe_id: 'recipe-1', covers: 12 }
  ]);
  assertHttpError(() => normalizeMealServiceDishCovers([{ recipe_id: 'recipe-1', covers: 1.5 }]), 400, /whole number/);
  assert.equal(buildMealServiceScopeKey({
    site_id: 'site-1', service_date: '2026-09-03', meal_type: 'lunch',
    menu_type: 'general', menu_category: 'senior'
  }), 'site-1::2026-09-03::lunch::general::senior');
});

test('availability snapshot changes for new output, balances, and service portion edits', () => {
  const scope = {
    site_id: 'project-1', service_date: '2026-09-02', meal_type: 'lunch',
    menu_type: 'general', menu_category: 'senior'
  };
  const first = batch({ id: 'batch-1', service_portion_size_grams: 200 });
  const snapshot = buildMealServiceAvailabilitySnapshot(scope, [first]);
  assert.equal(snapshot.length, 64);
  assert.equal(snapshot, buildMealServiceAvailabilitySnapshot(scope, [{ ...first }]));
  assert.notEqual(snapshot, buildMealServiceAvailabilitySnapshot(scope, [
    first,
    batch({ id: 'batch-2', batch_number: 'PIB-2', service_portion_size_grams: 200 })
  ]));
  assert.notEqual(snapshot, buildMealServiceAvailabilitySnapshot(scope, [{
    ...first, remaining_weight_grams: 800, remaining_servings: 3.2
  }]));
  assert.notEqual(snapshot, buildMealServiceAvailabilitySnapshot(scope, [{
    ...first, service_portion_size_grams: 225
  }]));
  const service = source('server/mealService.js');
  assert.match(service, /Prepared output changed after it was loaded\. Refresh availability before saving Meal Service/);
  assert.match(service, /requireAvailabilitySnapshot: true/);
  assert.match(service, /acquireMealServiceScopeLock\(scopeKey, executor\)/);
  assert.match(
    service,
    /acquireMealServiceScopeLock\(scopeKey, executor\);[\s\S]*?filters: \{ idempotency_key: idempotencyKey \}[\s\S]*?attendanceReplayResponse\(concurrentReplay, consumptions\)[\s\S]*?getServiceContext/
  );
  assert.doesNotMatch(service, /Production output cannot be completed after this staff meal-service scope was confirmed/);
  assert.doesNotMatch(service, /filters: \{ scope_key: serviceScopeKey \}/);
});

test('service portion is never inferred from the production or recipe portion', () => {
  const [dish] = groupMealServiceProducedDishes([batch({ service_portion_size_grams: null })]);
  assert.equal(dish.portion_configured, false);
  assert.equal(dish.service_portion_size_grams, null);
  assert.equal(dish.available_covers, null);
  const service = source('server/mealService.js');
  assert.match(service, /requires an administrator-configured service portion size before Meal Service can be saved/);
  assert.doesNotMatch(service, /batch\.service_portion_size_grams \?\? batch\.portion_size_grams/);
});

test('confirmation moves every unserved gram to waste and reversal restores served and wasted output', () => {
  const source = [{
    id: 'batch-1', recipe_id: 'recipe-1', recipe_name: 'Rice', production_id: 'prod-1',
    status: 'partial', portion_size_grams: 250, produced_servings: 10, produced_weight_grams: 2500,
    served_servings: 4, served_weight_grams: 1000,
    wasted_servings: 0, wasted_weight_grams: 0,
    remaining_servings: 6, remaining_weight_grams: 1500
  }];
  const finalized = convertMealServiceRemainderToWaste(source);
  assert.equal(finalized.batches[0].remaining_weight_grams, 0);
  assert.equal(finalized.batches[0].wasted_weight_grams, 1500);
  const [reconciledItem] = reconcileMealServiceItemsWithWaste([{
    recipe_id: 'recipe-1', remaining_available_weight_grams: 1500,
    remaining_available_servings: 6
  }], finalized.wasteItems);
  assert.equal(reconciledItem.remaining_available_weight_grams, 0);
  assert.equal(reconciledItem.remaining_available_servings, 0);
  assert.equal(reconciledItem.wasted_weight_grams, 1500);
  const servedRestored = reverseMealServiceAllocations([{
    allocations: [{ produced_item_batch_id: 'batch-1', production_equivalent_servings: 4, weight_grams: 1000 }]
  }], finalized.batches);
  const allRestored = reverseMealServiceWasteAllocations([{
    output_allocations: finalized.wasteItems[0].allocations
  }], servedRestored);
  assert.equal(allRestored[0].served_weight_grams, 0);
  assert.equal(allRestored[0].wasted_weight_grams, 0);
  assert.equal(allRestored[0].remaining_weight_grams, 2500);
  assert.equal(allRestored[0].remaining_servings, 10);
});

test('scope index permits multiple Meal Service requests for the same production scope', () => {
  const sql = source('server/sql/init.sql');
  assert.match(sql, /DROP INDEX IF EXISTS idx_entity_records_meal_attendance_scope_unique/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_scope/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX idx_entity_records_meal_attendance_scope_unique/);
  const service = source('server/mealService.js');
  assert.doesNotMatch(service, /existingScopeConfirmation/);
  assert.match(service, /const wasteRecords = \[\]/);
  assert.match(service, /Service portion size cannot be changed after any output has been served or wasted/);
});

test('recipe-filtered reports return and sum only the matching recipe item and batches', () => {
  const report = buildMealServiceReportData({
    recipeId: 'recipe-rice',
    records: [
      {
        id: 'attendance-mixed',
        service_date: '2026-09-02',
        attendee_count: 5,
        status: 'completed',
        required_servings: 9,
        required_weight_grams: 2450,
        served_servings: 8,
        served_weight_grams: 2200,
        shortage_servings: 1,
        shortage_weight_grams: 250,
        items: [
          {
            recipe_id: 'recipe-rice',
            required_servings: 5,
            required_weight_grams: 1250,
            allocated_servings: 4,
            allocated_weight_grams: 1000,
            shortage_servings: 1,
            shortage_weight_grams: 250
          },
          {
            recipe_id: 'recipe-stew',
            required_servings: 4,
            required_weight_grams: 1200,
            allocated_servings: 4,
            allocated_weight_grams: 1200,
            shortage_servings: 0,
            shortage_weight_grams: 0
          }
        ]
      },
      {
        id: 'attendance-stew-only',
        service_date: '2026-09-02',
        attendee_count: 3,
        status: 'completed',
        items: [{ recipe_id: 'recipe-stew', required_servings: 3 }]
      }
    ],
    consumptionRecords: [
      { id: 'consumption-rice', meal_service_attendance_id: 'attendance-mixed', recipe_id: 'recipe-rice' },
      { id: 'consumption-stew', meal_service_attendance_id: 'attendance-mixed', recipe_id: 'recipe-stew' }
    ],
    producedBatches: [
      { recipe_id: 'recipe-rice', meal_type: 'lunch', production_date: '2026-09-02', produced_servings: 10, produced_weight_grams: 2500, remaining_servings: 6, remaining_weight_grams: 1500 },
      { recipe_id: 'recipe-stew', meal_type: 'lunch', production_date: '2026-09-02', produced_servings: 20, produced_weight_grams: 6000, remaining_servings: 16, remaining_weight_grams: 4800 },
      { recipe_id: 'recipe-rice', meal_type: 'snack', production_date: '2026-09-02', produced_servings: 99, produced_weight_grams: 24750, remaining_servings: 99, remaining_weight_grams: 24750 }
    ]
  });

  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.rows[0].items.map((item) => item.recipe_id), ['recipe-rice']);
  assert.deepEqual(report.rows[0].consumption_ids, ['consumption-rice']);
  assert.equal(report.rows[0].required_servings, 5);
  assert.equal(report.rows[0].served_servings, 4);
  assert.equal(report.rows[0].short_servings, 1);
  assert.equal(report.summary.attendee_count, 5);
  assert.equal(report.summary.produced_servings, 10);
  assert.equal(report.summary.produced_production_equivalent_servings, 10);
  assert.equal(report.summary.remaining_servings, 6);
  assert.equal(report.summary.remaining_production_equivalent_servings, 6);
  assert.equal(report.summary.required_servings, 5);
  assert.equal(report.summary.required_meal_portions, 5);
  assert.equal(report.summary.required_weight_grams, 1250);
  assert.equal(report.summary.served_servings, 4);
  assert.equal(report.summary.served_meal_portions, 4);
  assert.equal(report.summary.served_weight_grams, 1000);
  assert.equal(report.summary.short_servings, 1);
  assert.equal(report.summary.short_meal_portions, 1);
  assert.equal(report.summary.short_weight_grams, 250);
  assert.equal(report.summary.measurement_basis.authoritative, 'weight_grams');
});

test('report retrieval applies indexed server-side date ranges and pages every entity', async () => {
  const serviceRows = [1, 2, 3, 4].map((value) => ({
    id: `attendance-${value}`,
    service_date: `2026-08-0${value}`,
    meal_type: 'lunch',
    menu_plan_id: 'menu-plan-1',
    attendee_count: value,
    status: 'posted',
    required_servings: value,
    required_weight_grams: value * 250,
    served_servings: value,
    served_weight_grams: value * 250,
    shortage_servings: 0,
    shortage_weight_grams: 0,
    items: [{ recipe_id: 'recipe-rice', allocated_servings: value }]
  }));
  const fixtures = {
    MealServiceAttendance: serviceRows,
    MealServiceConsumption: serviceRows.map((row) => ({
      id: `consumption-${row.id}`,
      meal_service_attendance_id: row.id,
      service_date: row.service_date,
      meal_type: 'lunch',
      menu_plan_id: 'menu-plan-1',
      recipe_id: 'recipe-rice'
    })),
    ProducedItemBatch: serviceRows.map((row) => ({
      id: `batch-${row.id}`,
      production_date: row.service_date,
      meal_type: 'lunch',
      menu_plan_id: 'menu-plan-1',
      recipe_id: 'recipe-rice',
      produced_servings: 2,
      produced_weight_grams: 500,
      remaining_servings: 1,
      remaining_weight_grams: 250
    }))
  };
  const calls = [];
  const location = { unrestricted: false, accessibleSiteIds: ['project-1'] };
  const listDocumentsFn = async (entity, options) => {
    calls.push({ entity, options });
    return fixtures[entity].slice(options.offset, options.offset + options.limit);
  };

  const report = await getMealServiceReport({
    start_date: '2026-08-01',
    end_date: '2026-08-31',
    meal_type: 'lunch',
    menu_plan_id: 'menu-plan-1'
  }, { listDocumentsFn, reportPageSize: 2, location });

  assert.equal(report.rows.length, 4);
  assert.equal(report.summary.attendee_count, 10);
  assert.equal(report.summary.produced_servings, 8);
  assert.equal(report.summary.remaining_servings, 4);
  for (const [entity, field, sort] of [
    ['MealServiceAttendance', 'service_date', '-service_date'],
    ['MealServiceConsumption', 'service_date', '-service_date'],
    ['ProducedItemBatch', 'production_date', '-production_date']
  ]) {
    const entityCalls = calls.filter((call) => call.entity === entity);
    assert.deepEqual(entityCalls.map((call) => call.options.offset), [0, 2, 4]);
    assert.ok(entityCalls.every((call) => call.options.limit === 2));
    assert.ok(entityCalls.every((call) => (
      call.options.sort === sort
      && call.options.filters.meal_type === 'lunch'
      && call.options.filters.menu_plan_id === 'menu-plan-1'
      && call.options.location === location
      && JSON.stringify(call.options.rangeFilters) === JSON.stringify({
        [field]: { gte: '2026-08-01', lte: '2026-08-31' }
      })
    )));
  }

  const sqlSource = source('server/sql/init.sql');
  assert.match(sqlSource, /idx_entity_records_meal_attendance_report_date/);
  assert.match(sqlSource, /idx_entity_records_meal_consumption_report_date/);
  assert.match(sqlSource, /idx_entity_records_produced_item_report_date/);
  assert.match(sqlSource, /idx_entity_records_produced_item_menu_plan_report/);
});

test('meal-service entities are scoped/read-permission protected and cannot bypass service mutations', () => {
  const viewer = {
    role: 'viewer',
    is_custom_role: true,
    role_permissions: ['view_customer_meal_service']
  };
  for (const entity of ['ProducedItemBatch', 'MealServiceAttendance', 'MealServiceConsumption']) {
    assert.equal(authorizeEntityAction(viewer, entity, 'list'), true);
    for (const action of ['create', 'update', 'delete']) {
      assertHttpError(
        () => authorizeEntityAction(viewer, entity, action, {}, { id: 'protected-record' }),
        409,
        /protected meal-service records/
      );
    }
  }
  const database = source('server/db.js');
  assert.match(
    database,
    /clearDocumentsForBulk[\s\S]*ProducedItemBatch[\s\S]*MealServiceAttendance[\s\S]*MealServiceConsumption[\s\S]*MEAL_SERVICE_BULK_MUTATION_FORBIDDEN/
  );
});

test('automatic meal-service leftover waste is server-owned and immutable through entity APIs', () => {
  const manager = {
    role: 'manager',
    role_permissions: ['manage_waste']
  };
  assertHttpError(
    () => authorizeEntityAction(manager, 'FoodWaste', 'create', {
      auto_generated: true,
      source_type: 'meal_service_leftover',
      meal_service_attendance_id: 'attendance-1',
      output_allocations: []
    }),
    409,
    /server-managed/
  );
  const protectedWaste = {
    id: 'waste-1',
    auto_generated: true,
    source_type: 'meal_service_leftover',
    meal_service_attendance_id: 'attendance-1'
  };
  assertHttpError(
    () => authorizeEntityAction(manager, 'FoodWaste', 'update', { notes: 'tamper' }, protectedWaste),
    409,
    /protected meal-service reversal/
  );
  assertHttpError(
    () => authorizeEntityAction(manager, 'FoodWaste', 'delete', null, protectedWaste),
    409,
    /protected meal-service reversal/
  );
  const server = source('server/index.js');
  const database = source('server/db.js');
  assert.match(server, /authorizeEntityAction\(request\.user, 'FoodWaste', 'create'/);
  assert.match(server, /authorizeEntityAction\(request\.user, 'FoodWaste', 'update'/);
  assert.match(database, /clearDocumentsForBulk[\s\S]*preserveServerMealServiceWaste/);
  assert.match(database, /data->>'auto_generated'[\s\S]*meal_service_leftover[\s\S]*meal_service_attendance_id/);
});

test('staff meal service is transactional, admin-correctable, and cannot mutate raw inventory entities', () => {
  const serviceSource = source('server/mealService.js');
  const serverSource = source('server/index.js');
  const sqlSource = source('server/sql/init.sql');
  const scopeSource = source('server/locationScope.js');

  assert.doesNotMatch(serviceSource, /deductStock|receiveStock|adjustStock|InventoryLot|InventoryTransaction/);
  assert.doesNotMatch(serviceSource, /updateDocument\(['"]Inventory['"]/);
  assert.match(serviceSource, /withTransaction\(\(client\) => recordMealServiceAttendanceWithExecutor/);
  assert.match(serviceSource, /lock: true/);
  assert.match(serviceSource, /normalizeSiteType\(site\.type\) !== SITE_HIERARCHY_TYPES\.PROJECT/);
  assert.match(serverSource, /\/api\/meal-service\/attendance/);
  assert.match(serverSource, /record_customer_meal_service/);
  assert.match(
    serverSource,
    /\/api\/meal-service\/report'[\s\S]*?requireAnyPermission\(\[[\s\S]*?'view_customer_meal_service'[\s\S]*?'record_customer_meal_service'/
  );
  assert.match(
    serverSource,
    /attendance\/:id\/reverse[\s\S]*?if \(!hasAdminAccess\(request\.user\)\)[\s\S]*?Only administrators can reverse/
  );
  assert.match(
    serviceSource,
    /status: 'reversed'[\s\S]*?waste_reversals: wasteReversals, replayed: true/
  );
  assert.match(sqlSource, /idx_entity_records_meal_attendance_idempotency_unique/);
  assert.match(sqlSource, /idx_entity_records_produced_item_fifo/);
  assert.match(sqlSource, /idx_entity_records_meal_consumption_history/);
  for (const entity of ['ProducedItemBatch', 'MealServiceAttendance', 'MealServiceConsumption']) {
    assert.match(scopeSource, new RegExp(`'${entity}'`));
  }
});

test('meal-service availability backfills missing produced batches from completed production', () => {
  const serviceSource = source('server/mealService.js');

  assert.match(serviceSource, /backfillProducedItemBatchesForCompletedProductions/);
  assert.match(serviceSource, /listDocuments\('Production'/);
  assert.match(serviceSource, /status: 'completed'/);
  assert.match(serviceSource, /production_date: serviceDate/);
  assert.match(serviceSource, /meal_type: mealType/);
  assert.match(serviceSource, /createDocument\('ProducedItemBatch'/);
  assert.match(serviceSource, /getProducedItemAvailability[\s\S]*backfillProducedItemBatchesForCompletedProductions/);
  assert.match(serviceSource, /getServiceContext[\s\S]*backfillProducedItemBatchesForCompletedProductions/);
});

test('meal-service project scope includes active child store production output', () => {
  const serviceSource = source('server/mealService.js');

  assert.match(serviceSource, /resolveMealServiceProductionScope/);
  assert.match(serviceSource, /parent_site_id: serviceSite\.id/);
  assert.match(serviceSource, /normalizeSiteType\(site\?\.type\) === SITE_HIERARCHY_TYPES\.STORE/);
  assert.match(serviceSource, /extendLocationWithMealServiceProductionSites\(location, productionSiteIds\)/);
  assert.match(serviceSource, /getProducedItemAvailability[\s\S]*productionSiteIds[\s\S]*listMealServiceProducedItemBatchesForSites/);
  assert.match(serviceSource, /getServiceContext[\s\S]*productionSiteIds[\s\S]*listMealServiceProducedItemBatchesForSites/);
  assert.match(serviceSource, /updateMealServicePortionSizeWithExecutor[\s\S]*productionSiteIds[\s\S]*listMealServiceProducedItemBatchesForSites/);
});
