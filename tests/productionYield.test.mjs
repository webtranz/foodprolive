import assert from 'node:assert/strict';

import { prepareEntityPayload } from '../server/entityPreparation.js';

const scope = {
  accessibleSiteIds: new Set(['site-1']),
  accessibleTreeIds: new Set(['site-1'])
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
    status: 'planned'
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
assert.equal(prepared.ingredients_used[0].yield_percent, 80);
assert.equal(prepared.ingredients_used[0].item_code, 'ITEM-PROTEIN-001');
assert.equal(prepared.estimated_batch_cost, 12.5);
assert.equal(prepared.estimated_cost_per_serving, 1.25);

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
