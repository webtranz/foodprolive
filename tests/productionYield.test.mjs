import assert from 'node:assert/strict';

import {
  prepareEntityPayload,
  scaleApprovedProductionSnapshot
} from '../server/entityPreparation.js';

const scope = {
  accessibleSiteIds: new Set(['site-1']),
  accessibleTreeIds: new Set(['site-1']),
  sites: [{ id: 'site-1', name: 'Yield Test Project', type: 'project', is_active: true }],
  graph: {
    byId: new Map([
      ['site-1', { id: 'site-1', name: 'Yield Test Project', type: 'project', is_active: true }]
    ])
  }
};
const recipe = {
  id: 'recipe-1',
  name: 'Yield Test Recipe',
  servings: 10,
  ingredients: [
    { ingredient_id: 'ingredient-1', ingredient_name: 'Test Protein', quantity: 2, unit: 'kg' }
  ]
};
const ingredient = {
  id: 'ingredient-1',
  item_code: 'ITEM-PROTEIN-001',
  name: 'Test Protein',
  unit: 'kg',
  cost_per_unit: 5,
  cooking_yield_percent: 80
};

const prepared = await prepareEntityPayload(
  {},
  'Production',
  {
    site_id: 'site-1',
    recipe_id: recipe.id,
    target_servings: 10,
    production_date: '2026-08-24',
    kitchen_station: 'Yield Test Station',
    status: 'planned',
    ingredients_used: [{
      ingredient_id: ingredient.id,
      actual_quantity: 0,
      unit: 'kg'
    }]
  },
  null,
  {
    scope,
    recipeCatalog: [recipe],
    ingredientCatalog: [ingredient]
  }
);

assert.equal(prepared.yield_adjustment_applied, true);
assert.equal(prepared.ingredients_used.length, 1);
assert.equal(prepared.ingredients_used[0].net_quantity, 2);
assert.equal(prepared.ingredients_used[0].planned_quantity, 2.5);
assert.equal(prepared.ingredients_used[0].required_quantity, 2.5);
assert.equal(prepared.ingredients_used[0].actual_quantity, null);
assert.equal(prepared.ingredients_used[0].yield_percent, 80);
assert.equal(prepared.ingredients_used[0].item_code, 'ITEM-PROTEIN-001');
assert.equal(prepared.estimated_batch_cost, 12.5);
assert.equal(prepared.estimated_cost_per_serving, 1.25);

const scaledApprovedSnapshot = scaleApprovedProductionSnapshot({
  ...prepared,
  id: 'approved-production-1',
  status: 'approved'
}, 5);
assert.equal(scaledApprovedSnapshot.target_servings, 5);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].net_quantity, 1);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].planned_quantity, 1.25);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].required_quantity, 1.25);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].yield_adjusted_quantity, 1.25);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].yield_percent, 80);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].actual_quantity, null);
assert.equal(scaledApprovedSnapshot.estimated_batch_cost, 6.25);
assert.equal(scaledApprovedSnapshot.estimated_cost_per_serving, 1.25);
assert.equal(prepared.ingredients_used[0].planned_quantity, 2.5, 'the approved source snapshot remains immutable');

const preciseScaledSnapshot = scaleApprovedProductionSnapshot({
  target_servings: 10,
  estimated_batch_cost: 0.13,
  ingredients_used: [{
    ingredient_id: 'spice',
    ingredient_name: 'Spice',
    unit: 'kg',
    desired_quantity: 0.0013,
    net_quantity: 0.001,
    planned_quantity: 0.0013,
    required_quantity: 0.0013,
    yield_adjusted_quantity: 0.0013,
    yield_percent: 80,
    yield_multiplier: 1.25,
    estimated_cost: 0.13
  }],
  yield_adjustment_applied: true,
  yield_adjustment_version: 1,
  yield_snapshot_source: 'server_recipe_expansion'
}, 3);
assert.equal(preciseScaledSnapshot.ingredients_used[0].desired_quantity, 0.00039);
assert.equal(preciseScaledSnapshot.ingredients_used[0].planned_quantity, 0.00039);
assert.equal(preciseScaledSnapshot.ingredients_used[0].yield_percent, 80);
assert.equal(preciseScaledSnapshot.ingredients_used[0].yield_multiplier, 1.25);

const reducedBelowInventoryPrecision = scaleApprovedProductionSnapshot({
  target_servings: 10,
  estimated_batch_cost: 0.13,
  ingredients_used: [{
    ingredient_id: 'spice',
    ingredient_name: 'Spice',
    unit: 'kg',
    planned_quantity: 0.0013,
    required_quantity: 0.0013,
    yield_adjusted_quantity: 0.0013,
    estimated_cost: 0.13
  }],
  yield_adjustment_applied: true,
  yield_adjustment_version: 1,
  yield_snapshot_source: 'server_recipe_expansion'
}, 0.001);
assert.equal(reducedBelowInventoryPrecision.ingredients_used[0].planned_quantity, 0);
const restoredFromApprovedBaseline = scaleApprovedProductionSnapshot({
  ...reducedBelowInventoryPrecision,
  status: 'approved'
}, 10);
assert.equal(restoredFromApprovedBaseline.ingredients_used[0].planned_quantity, 0.0013);
assert.equal(restoredFromApprovedBaseline.ingredients_used[0].yield_adjusted_quantity, 0.0013);

const sharedRecipePrepared = await prepareEntityPayload(
  {},
  'Production',
  {
    site_id: 'site-1',
    recipe_id: recipe.id,
    target_servings: 10,
    production_date: '2026-08-24',
    kitchen_station: 'Yield Test Station',
    status: 'planned'
  },
  null,
  {
    scope,
    recipeCatalog: [{
      ...recipe,
      site_scope: 'specific',
      site_ids: ['site-1', 'site-outside-scope']
    }],
    ingredientCatalog: [ingredient]
  }
);
assert.equal(sharedRecipePrepared.recipe_id, recipe.id);

await assert.rejects(
  () => prepareEntityPayload(
    {},
    'Production',
    {
      site_id: 'site-1',
      recipe_id: recipe.id,
      target_servings: 10,
      production_date: '2026-08-24',
      kitchen_station: 'Yield Test Station',
      status: 'planned'
    },
    null,
    {
      scope,
      recipeCatalog: [{
        ...recipe,
        site_scope: 'specific',
        site_ids: ['site-outside-scope']
      }],
      ingredientCatalog: [ingredient]
    }
  ),
  /not available to this Production Project/
);

const statusOnlyUpdate = await prepareEntityPayload(
  {},
  'Production',
  { status: 'approved' },
  { ...prepared, id: 'production-1' },
  { scope }
);

assert.equal(statusOnlyUpdate.status, 'approved');
assert.deepEqual(statusOnlyUpdate.ingredients_used, prepared.ingredients_used);

const upgradedLegacyProduction = await prepareEntityPayload(
  {},
  'Production',
  { status: 'approved' },
  {
    id: 'legacy-production',
    site_id: 'site-1',
    recipe_id: recipe.id,
    recipe_name: recipe.name,
    target_servings: 10,
    production_date: '2026-08-24',
    kitchen_station: 'Yield Test Station',
    status: 'pending_approval',
    ingredients_used: [{
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      planned_quantity: 2.4,
      unit: 'kg'
    }]
  },
  {
    scope,
    recipeCatalog: [recipe],
    ingredientCatalog: [ingredient]
  }
);

assert.equal(upgradedLegacyProduction.yield_adjustment_applied, true);
assert.equal(upgradedLegacyProduction.ingredients_used[0].net_quantity, 2);
assert.equal(upgradedLegacyProduction.ingredients_used[0].planned_quantity, 2.5);

console.log('Production yield enforcement tests passed.');
