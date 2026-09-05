import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  prepareEntityPayload,
  scaleApprovedProductionSnapshot
} from '../server/entityPreparation.js';
import { resolveAutoScheduleMenuLink } from '../shared/autoScheduleMenuLink.js';

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
    menu_type: 'general',
    menu_category: 'senior',
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
assert.equal(prepared.ingredients_used[0].raw_quantity, 2);
assert.equal(prepared.ingredients_used[0].net_quantity, 1.6);
assert.equal(prepared.ingredients_used[0].yielded_quantity, 1.6);
assert.equal(prepared.ingredients_used[0].planned_quantity, 2);
assert.equal(prepared.ingredients_used[0].required_quantity, 2);
assert.equal(prepared.ingredients_used[0].yield_adjusted_quantity, 1.6);
assert.equal(prepared.ingredients_used[0].actual_quantity, null);
assert.equal(prepared.ingredients_used[0].yield_percent, 80);
assert.equal(prepared.ingredients_used[0].item_code, 'ITEM-PROTEIN-001');
assert.equal(prepared.ingredients_used[0].raw_weight_grams, 2000);
assert.equal(prepared.ingredients_used[0].yielded_weight_grams, 1600);
assert.match(prepared.ingredients_used[0].weight_calculation_source, /weight_unit:frozen_yield_multiplier/);
assert.equal(prepared.ingredients_used[0].yield_calculation_source, 'cooking_yield_percent');
assert.equal(prepared.ingredients_used[0].weight_snapshot_version, 1);
assert.equal(prepared.estimated_batch_cost, 10);
assert.equal(prepared.estimated_cost_per_serving, 1);
assert.equal(prepared.yield_adjustment_version, 2);
assert.equal(prepared.quantity_semantics, 'raw_recipe_to_yielded_output_v2');
assert.equal(prepared.recipe_raw_weight_grams, 2000);
assert.equal(prepared.expected_finished_weight_grams, 1600);
assert.equal(prepared.portion_size_grams, 160);
assert.equal(prepared.output_calculation_source, 'frozen_raw_line_yields');

const scaledApprovedSnapshot = scaleApprovedProductionSnapshot({
  ...prepared,
  id: 'approved-production-1',
  status: 'approved'
}, 5);
assert.equal(scaledApprovedSnapshot.target_servings, 5);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].raw_quantity, 1);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].net_quantity, 0.8);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].planned_quantity, 1);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].required_quantity, 1);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].yield_adjusted_quantity, 0.8);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].yield_percent, 80);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].raw_weight_grams, 1000);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].yielded_weight_grams, 800);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].weight_calculation_source, prepared.ingredients_used[0].weight_calculation_source);
assert.equal(scaledApprovedSnapshot.ingredients_used[0].yield_calculation_source, 'cooking_yield_percent');
assert.equal(scaledApprovedSnapshot.ingredients_used[0].actual_quantity, null);
assert.equal(scaledApprovedSnapshot.estimated_batch_cost, 5);
assert.equal(scaledApprovedSnapshot.estimated_cost_per_serving, 1);
assert.equal(scaledApprovedSnapshot.expected_finished_weight_grams, 800);
assert.equal(scaledApprovedSnapshot.portion_size_grams, 160);
assert.equal(prepared.ingredients_used[0].planned_quantity, 2, 'the approved source snapshot remains immutable');

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
assert.equal(Object.prototype.hasOwnProperty.call(preciseScaledSnapshot, 'expected_finished_weight_grams'), false);
assert.equal(Object.prototype.hasOwnProperty.call(preciseScaledSnapshot, 'recipe_raw_weight_grams'), false);

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
    menu_type: 'general',
    menu_category: 'senior',
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
assert.equal(upgradedLegacyProduction.yield_adjustment_version, 2);
assert.equal(upgradedLegacyProduction.ingredients_used[0].net_quantity, 1.6);
assert.equal(upgradedLegacyProduction.ingredients_used[0].planned_quantity, 2);

const historicalInProgress = await prepareEntityPayload(
  {},
  'Production',
  { notes: 'Preserve issued production' },
  {
    id: 'historical-v1',
    site_id: 'site-1',
    recipe_id: recipe.id,
    target_servings: 10,
    production_date: '2026-08-24',
    kitchen_station: 'Yield Test Station',
    menu_type: 'general',
    menu_category: 'senior',
    status: 'in_progress',
    yield_adjustment_applied: true,
    yield_adjustment_version: 1,
    ingredients_used: [{ ingredient_id: ingredient.id, planned_quantity: 2.5, unit: 'kg' }]
  },
  { scope, recipeCatalog: [recipe], ingredientCatalog: [ingredient] }
);
assert.equal(historicalInProgress.yield_adjustment_version, 1);
assert.equal(historicalInProgress.ingredients_used[0].planned_quantity, 2.5);

const eachIngredient = {
  id: 'ingredient-each',
  item_code: 'ITEM-EACH-001',
  name: 'Unweighed Garnish',
  unit: 'each',
  cost_per_unit: 1
};
const explicitPortionRecipe = {
  id: 'recipe-explicit-portion',
  name: 'Explicit Portion Recipe',
  servings: 10,
  portion_size_grams: 250,
  ingredients: [{
    ingredient_id: eachIngredient.id,
    ingredient_name: eachIngredient.name,
    quantity: 10,
    unit: 'each'
  }]
};
const explicitPortionProduction = await prepareEntityPayload(
  {},
  'Production',
  {
    site_id: 'site-1',
    recipe_id: explicitPortionRecipe.id,
    target_servings: 10,
    production_date: '2026-08-24',
    kitchen_station: 'Yield Test Station',
    status: 'planned'
  },
  null,
  {
    scope,
    recipeCatalog: [explicitPortionRecipe],
    ingredientCatalog: [eachIngredient]
  }
);
assert.equal(explicitPortionProduction.recipe_raw_weight_grams, null);
assert.equal(explicitPortionProduction.portion_size_grams, 250);
assert.equal(explicitPortionProduction.portion_size_source, 'recipe_portion_size');
assert.equal(explicitPortionProduction.expected_finished_weight_grams, null);
assert.match(explicitPortionProduction.production_warnings[0], /Yield weight unavailable/);

const missingWeightRecipe = { ...explicitPortionRecipe, id: 'recipe-missing-weight', portion_size_grams: null };
const missingWeightProduction = await prepareEntityPayload(
  {},
  'Production',
  {
    site_id: 'site-1',
    recipe_id: missingWeightRecipe.id,
    target_servings: 10,
    production_date: '2026-08-24',
    kitchen_station: 'Yield Test Station',
    status: 'planned'
  },
  null,
  {
    scope,
    recipeCatalog: [missingWeightRecipe],
    ingredientCatalog: [eachIngredient]
  }
);
assert.equal(missingWeightProduction.recipe_raw_weight_grams, null);
assert.equal(missingWeightProduction.portion_size_grams, null);
assert.equal(missingWeightProduction.portion_size_source, 'unavailable');
assert.equal(missingWeightProduction.expected_finished_weight_grams, null);

const productionUiSource = readFileSync(new URL('../src/pages/Production.jsx', import.meta.url), 'utf8');
assert.match(productionUiSource, /Automatic Finished Production/);
assert.match(productionUiSource, /Set by the approved recipe yield/);
assert.match(productionUiSource, /Yield-adjusted weight ÷ portion size/);
assert.match(productionUiSource, /buildAutomaticProductionYieldSummary/);
assert.match(productionUiSource, /The server independently recalculates these values before posting completion/);
assert.match(productionUiSource, /Approved Raw Issue/);
assert.match(productionUiSource, /completionRawReconciliation/);
assert.match(productionUiSource, /Complete Automatically/);
assert.match(productionUiSource, /Menu Type \*/);
assert.match(productionUiSource, /Menu Category \*/);
assert.match(productionUiSource, /cuisine_type: formData\.menu_type/);
assert.doesNotMatch(productionUiSource, /actual_finished_weight_grams:/);
assert.doesNotMatch(productionUiSource, /ingredient_quantities:/);
assert.doesNotMatch(productionUiSource, /Actual Finished Yield \(g\)/);
assert.doesNotMatch(productionUiSource, /Actual Raw Consumed/);
assert.doesNotMatch(
  productionUiSource,
  /actualFinishedWeightGrams|completionFinishedWeightGrams|completionQuantities/
);

const autoScheduleSource = readFileSync(new URL('../src/pages/AutoSchedule.jsx', import.meta.url), 'utf8');
assert.match(autoScheduleSource, /yield_adjustment_version:\s*2/);
assert.match(autoScheduleSource, /planned_quantity:\s*Number\(rawQuantity\.toFixed\(4\)\)/);
assert.match(autoScheduleSource, /yielded_quantity:\s*Number\(yieldedQuantity\.toFixed\(4\)\)/);
assert.match(autoScheduleSource, /resolveAutoScheduleMenuLink/);

const linkedAutoSchedule = resolveAutoScheduleMenuLink({
  menuPlans: [{
    id: 'menu-plan-1',
    site_id: 'site-1',
    plan_date: '2026-09-02',
    cuisine_type: 'philippines',
    menu_category: 'labor',
    status: 'approved',
    meals: [{ recipe_id: 'recipe-1', meal_type: 'lunch' }]
  }],
  siteId: 'site-1',
  productionDate: '2026-09-02',
  mealType: 'lunch',
  recipeId: 'recipe-1'
});
assert.deepEqual(linkedAutoSchedule, {
  source_type: 'auto_schedule_menu_plan',
  menu_plan_id: 'menu-plan-1',
  cuisine_type: 'philippines',
  menu_type: 'philippines',
  menu_category: 'labor',
  menu_link_status: 'linked'
});

const unlinkedAutoSchedule = resolveAutoScheduleMenuLink({
  menuPlans: [],
  siteId: 'site-1',
  productionDate: '2026-09-02',
  mealType: 'lunch',
  recipeId: 'recipe-1'
});
assert.equal(unlinkedAutoSchedule.source_type, 'auto_schedule_unlinked');
assert.equal(unlinkedAutoSchedule.menu_plan_id, null);

const ambiguousAutoSchedule = resolveAutoScheduleMenuLink({
  menuPlans: [
    {
      id: 'menu-plan-a', site_id: 'site-1', plan_date: '2026-09-02',
      status: 'planned', meals: [{ recipe_id: 'recipe-1', meal_type: 'lunch' }]
    },
    {
      id: 'menu-plan-b', site_id: 'site-1', plan_date: '2026-09-02',
      status: 'approved', meals: [{ recipe_id: 'recipe-1', meal_type: 'lunch' }]
    }
  ],
  siteId: 'site-1',
  productionDate: '2026-09-02',
  mealType: 'lunch',
  recipeId: 'recipe-1'
});
assert.equal(ambiguousAutoSchedule.menu_link_status, 'ambiguous');
assert.equal(ambiguousAutoSchedule.menu_plan_id, null);

const eventOnlyAutoSchedule = resolveAutoScheduleMenuLink({
  menuPlans: [{
    id: 'event-plan',
    site_id: 'site-1',
    plan_date: '2026-09-02',
    event_name: 'Private event',
    status: 'approved',
    meals: [{ recipe_id: 'recipe-1', meal_type: 'lunch' }]
  }],
  siteId: 'site-1',
  productionDate: '2026-09-02',
  mealType: 'lunch',
  recipeId: 'recipe-1'
});
assert.equal(eventOnlyAutoSchedule.menu_link_status, 'not_found');

console.log('Production yield enforcement tests passed.');
