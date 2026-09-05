import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { prepareEntityPayload } from '../server/entityPreparation.js';
import { buildProducedItemBatchSnapshot } from '../server/mealService.js';
import {
  normalizeProductionMenuScope,
  requiresRoutineProductionMenuScope
} from '../shared/menuCategories.js';
import {
  createTemplateCsv,
  mapCsvRow,
  validateCsvHeaders
} from '../server/utilities.js';

const classified = normalizeProductionMenuScope({
  menu_type: ' Filipino ',
  menu_category: ' Labour '
}, { required: true });
assert.equal(classified.menu_type, 'philippines');
assert.equal(classified.cuisine_type, 'philippines');
assert.equal(classified.menu_category, 'labor');

assert.throws(
  () => normalizeProductionMenuScope({}, { required: true }),
  (error) => error.status === 400 && /both Menu Type and Menu Category/.test(error.message)
);
assert.throws(
  () => normalizeProductionMenuScope({ menu_type: 'general' }),
  /both Menu Type and Menu Category/
);
assert.throws(
  () => normalizeProductionMenuScope({
    menu_type: 'philippines',
    menu_category: 'management_menu'
  }, { required: true }),
  /not available for philippines/
);

for (const exemptProduction of [
  { source_type: 'special_event' },
  { source_type: 'event' },
  { source_type: 'auto_schedule_unlinked' },
  { source_event_id: 'event-1' }
]) {
  assert.equal(requiresRoutineProductionMenuScope(exemptProduction), false);
  assert.doesNotThrow(() => normalizeProductionMenuScope(exemptProduction, { required: true }));
}
assert.equal(requiresRoutineProductionMenuScope({ source_type: 'auto_schedule_menu_plan' }), true);

const productionTemplate = createTemplateCsv('production');
assert.match(productionTemplate, /meal_type,menu_type,menu_category,target_servings/);
assert.deepEqual(
  validateCsvHeaders('production', ['production_date']),
  ['Missing required column: menu_type', 'Missing required column: menu_category']
);
assert.deepEqual(
  validateCsvHeaders('production', ['production_date', 'cuisine_type', 'menu_category']),
  []
);
const importedProduction = mapCsvRow(
  'production',
  ['production_date', 'cuisine_type', 'menu_category'],
  ['2026-09-03', 'Filipino', 'Labour']
);
assert.equal(importedProduction.menu_type, 'philippines');
assert.equal(importedProduction.cuisine_type, 'philippines');
assert.equal(importedProduction.menu_category, 'labor');

const scope = {
  unrestricted: true,
  accessibleSiteIds: new Set(['project-1']),
  sites: [{ id: 'project-1', name: 'Project One', type: 'project', is_active: true }],
  graph: {
    byId: new Map([
      ['project-1', { id: 'project-1', name: 'Project One', type: 'project', is_active: true }]
    ])
  }
};
await assert.rejects(
  () => prepareEntityPayload(
    {},
    'Production',
    {
      site_id: 'project-1',
      recipe_id: 'recipe-1',
      target_servings: 10,
      production_date: '2026-09-03',
      meal_type: 'lunch',
      kitchen_station: 'Hot Kitchen',
      status: 'pending_approval'
    },
    null,
    { scope }
  ),
  (error) => error.status === 400 && /both Menu Type and Menu Category/.test(error.message)
);

const recipe = {
  id: 'recipe-1',
  name: 'Rice',
  servings: 4,
  portion_size_grams: 250,
  ingredients: []
};

const productionWithoutKitchenStation = await prepareEntityPayload(
  {},
  'Production',
  {
    site_id: 'project-1',
    recipe_id: recipe.id,
    target_servings: 4,
    production_date: '2026-09-03',
    meal_type: 'lunch',
    menu_type: 'general',
    menu_category: 'senior',
    status: 'pending_approval'
  },
  null,
  {
    scope,
    recipeCatalog: [recipe],
    ingredientCatalog: []
  }
);
assert.equal(productionWithoutKitchenStation.recipe_id, recipe.id);
assert.equal(productionWithoutKitchenStation.kitchen_station, undefined);

const lockedSnapshotProduction = await prepareEntityPayload(
  {},
  'Production',
  {
    site_id: 'project-1',
    recipe_id: recipe.id,
    recipe_name: 'Lunch Menu Production (1 dish)',
    target_servings: 4,
    production_date: '2026-09-03',
    meal_type: 'lunch',
    menu_type: 'general',
    menu_category: 'senior',
    recipe_snapshot_mode: 'production_only_override',
    recipe_snapshot_locked: true,
    ingredients_used: [{
      ingredient_id: 'lentils',
      ingredient_name: 'Lentils',
      raw_quantity: 2,
      planned_quantity: 2,
      required_quantity: 2,
      yielded_quantity: 2,
      unit: 'kg',
      quantity_basis: 'production_snapshot_override_v1'
    }],
    status: 'pending_approval'
  },
  null,
  {
    scope,
    recipeCatalog: [recipe],
    ingredientCatalog: [{ id: 'lentils', name: 'Lentils', unit: 'kg', cost_per_unit: 3 }]
  }
);
assert.equal(lockedSnapshotProduction.yield_snapshot_source, 'production_snapshot_override');
assert.equal(lockedSnapshotProduction.ingredients_used.length, 1);
assert.equal(lockedSnapshotProduction.ingredients_used[0].ingredient_id, 'lentils');
assert.equal(lockedSnapshotProduction.ingredients_used[0].quantity_basis, 'production_snapshot_override_v1');
assert.equal(lockedSnapshotProduction.estimated_batch_cost, 6);

const routineCompletion = {
  id: 'production-1',
  recipe_id: recipe.id,
  recipe_name: recipe.name,
  site_id: 'project-1',
  production_date: '2026-09-03',
  meal_type: 'lunch',
  target_servings: 4,
  expected_yield_servings: 4,
  expected_finished_weight_grams: 1000,
  portion_size_grams: 250
};
assert.throws(
  () => buildProducedItemBatchSnapshot({ production: routineCompletion, recipe }),
  (error) => error.status === 409 && /both Menu Type and Menu Category/.test(error.message)
);
const routineBatch = buildProducedItemBatchSnapshot({
  production: {
    ...routineCompletion,
    menu_type: 'Filipino',
    menu_category: 'Labour'
  },
  recipe
});
assert.equal(routineBatch.menu_type, 'philippines');
assert.equal(routineBatch.menu_category, 'labor');

for (const source of [
  { source_type: 'special_event', source_event_id: 'event-1' },
  { source_type: 'auto_schedule_unlinked' }
]) {
  const exemptBatch = buildProducedItemBatchSnapshot({
    production: { ...routineCompletion, id: `production-${source.source_type}`, ...source },
    recipe
  });
  assert.equal(exemptBatch.menu_type, null);
  assert.equal(exemptBatch.menu_category, null);
}

const inventorySource = readFileSync(new URL('../server/inventory.js', import.meta.url), 'utf8');
const completionStart = inventorySource.indexOf('async function completeProductionWithExecutor(');
const completionEnd = inventorySource.indexOf('\nasync function completeProduction(', completionStart);
const completionBlock = inventorySource.slice(completionStart, completionEnd);
assert.match(
  completionBlock,
  /normalizeProductionMenuScope\(production, \{ required: true, errorStatus: 409 \}\)/
);
assert.ok(
  completionBlock.indexOf('normalizeProductionMenuScope') < completionBlock.indexOf("listDocuments('Ingredient'"),
  'routine production classification must be rejected before inventory completion work starts'
);

console.log('PASS routine production menu classification and bulk import guards');
