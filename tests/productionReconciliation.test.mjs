import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildAutomaticProductionCompletionPlan,
  convertProductionQuantityToInventoryUnit
} from '../server/inventory.js';
import {
  buildAutomaticProductionYieldSummary,
  calculateFrozenProductionLineWeight
} from '../shared/productionReconciliation.js';

const chicken = {
  id: 'chicken',
  item_code: '205101',
  name: 'TANMIAH FRESH CHICKEN 1/900G',
  unit: 'EA',
  cooking_yield_percent: 25,
  cost_per_unit: 20
};
const zeroLineIngredient = {
  id: 'zero-line',
  name: 'ZERO TEST 1/1KG',
  unit: 'EA'
};
const recipe = {
  id: 'recipe-chicken',
  name: 'Chicken Test',
  servings: 10,
  // Reproduces the stale kg-as-g scale shown in the reported production.
  portion_size_grams: 0.36,
  ingredients: [{ ingredient_id: chicken.id, quantity: 5, unit: 'EA' }]
};

test('package-aware frozen production lines use the frozen yield instead of stale totals or live yield', () => {
  const lineWeight = calculateFrozenProductionLineWeight({
    ingredient_id: chicken.id,
    planned_quantity: 5,
    unit: 'EA',
    yield_percent: 80
  }, chicken);

  assert.equal(lineWeight.raw_weight_grams, 4500);
  assert.equal(lineWeight.yielded_weight_grams, 3600);
  assert.equal(lineWeight.yield_multiplier, 0.8);
  assert.match(lineWeight.source, /package_measure:frozen_yield_percent/);
  assert.equal(lineWeight.weight_snapshot_status, 'metadata_reconstruction');
});

test('automatic summary corrects a kg-as-g portion anomaly and ignores zero-quantity lines for completeness', () => {
  const summary = buildAutomaticProductionYieldSummary({
    production: {
      target_servings: 10,
      yield_adjustment_version: 2,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      expected_finished_weight_grams: 9.6,
      portion_size_grams: 0.36,
      portion_size_source: 'recipe_portion_size',
      ingredients_used: [
        {
          ingredient_id: chicken.id,
          planned_quantity: 5,
          unit: 'EA',
          yield_multiplier: 0.8
        },
        {
          ingredient_id: zeroLineIngredient.id,
          planned_quantity: 0,
          unit: 'EA',
          yield_multiplier: 0.8
        }
      ]
    },
    recipe,
    ingredients: [chicken, zeroLineIngredient]
  });

  assert.equal(summary.output_calculation_source, 'legacy_v2_metadata_repair');
  assert.equal(summary.recipe_raw_weight_grams, 4500);
  assert.equal(summary.expected_finished_weight_grams, 3600);
  assert.equal(summary.portion_size_grams, 360);
  assert.equal(summary.portion_size_source, 'yield_calculated_unit_correction');
  assert.equal(summary.expected_yield_servings, 10);
  assert.match(summary.warnings[0], /unit scale/);
});

test('processing aids remain consumed but are excluded from production finished weight', () => {
  const summary = buildAutomaticProductionYieldSummary({
    production: {
      target_servings: 10,
      yield_adjustment_version: 2,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      portion_size_source: 'yield_calculated',
      ingredients_used: [
        {
          ingredient_id: chicken.id,
          planned_quantity: 5,
          unit: 'EA',
          yield_multiplier: 0.8
        },
        {
          ingredient_id: 'water',
          planned_quantity: 0.4,
          unit: 'l',
          exempt_processing_aid: true
        }
      ]
    },
    recipe,
    ingredients: [chicken, { id: 'water', name: 'Water', unit: 'l' }]
  });

  const waterLine = summary.line_weights.find((line) => line.ingredient_id === 'water');
  assert.equal(waterLine.raw_weight_grams, 400);
  assert.equal(waterLine.yielded_weight_grams, 0);
  assert.equal(waterLine.yield_source, 'exempt_processing_aid');
  assert.equal(summary.recipe_raw_weight_grams, 4500);
  assert.equal(summary.expected_finished_weight_grams, 3600);
  assert.equal(summary.portion_size_grams, 360);
});

test('partial prep exemptions keep stock demand but reduce finished production weight', () => {
  const summary = buildAutomaticProductionYieldSummary({
    production: {
      target_servings: 10,
      yield_adjustment_version: 2,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      portion_size_source: 'yield_calculated',
      ingredients_used: [
        {
          ingredient_id: chicken.id,
          planned_quantity: 5,
          unit: 'EA',
          yield_multiplier: 0.8
        },
        {
          ingredient_id: 'water',
          planned_quantity: 1,
          unit: 'l',
          prep_exempt_percent: 70
        }
      ]
    },
    recipe,
    ingredients: [chicken, { id: 'water', name: 'Water', unit: 'l' }]
  });

  const waterLine = summary.line_weights.find((line) => line.ingredient_id === 'water');
  assert.equal(waterLine.raw_weight_grams, 1000);
  assert.equal(waterLine.yielded_weight_grams, 300);
  assert.equal(waterLine.prep_exempt_percent, 70);
  assert.equal(waterLine.retained_fraction, 0.3);
  assert.match(waterLine.yield_source, /prep_exempt_percent/);
  assert.equal(summary.recipe_raw_weight_grams, 4800);
  assert.equal(summary.expected_finished_weight_grams, 3900);
  assert.equal(summary.portion_size_grams, 390);
});

test('v2 completion reconciles frozen raw demand and calculates output without operator values', () => {
  const plan = buildAutomaticProductionCompletionPlan({
    production: {
      id: 'production-v2',
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      target_servings: 10,
      yield_adjustment_version: 2,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      expected_finished_weight_grams: 9.6,
      portion_size_grams: 0.36,
      portion_size_source: 'recipe_portion_size',
      ingredients_used: [{
        ingredient_id: chicken.id,
        ingredient_name: chicken.name,
        planned_quantity: 5,
        raw_quantity: 5,
        actual_quantity: 0.1,
        unit: 'EA',
        yield_multiplier: 0.8,
        yield_percent: 80
      }]
    },
    recipeCatalog: [recipe],
    ingredientCatalog: [chicken]
  });

  assert.equal(plan.quantity_basis, 'raw_recipe_plan');
  assert.equal(plan.ingredients_used[0].desired_quantity, 5);
  assert.equal(plan.ingredients_used[0].actual_quantity, null);
  assert.equal(plan.production_snapshot.expected_finished_weight_grams, 3600);
  assert.equal(plan.production_snapshot.portion_size_grams, 360);
  assert.equal(plan.production_snapshot.expected_yield_servings, 10);
  assert.equal(plan.production_snapshot.output_calculation_source, 'legacy_v2_metadata_repair');
  assert.equal(plan.ingredients_used[0].raw_weight_grams, 4500);
  assert.equal(plan.ingredients_used[0].yielded_weight_grams, 3600);
  assert.match(plan.ingredients_used[0].weight_calculation_source, /^legacy_v2_repair:/);
  assert.equal(plan.ingredients_used[0].weight_snapshot_version, 1);
});

test('frozen v2 line weights remain stable when ingredient package and yield metadata later change', () => {
  const summary = buildAutomaticProductionYieldSummary({
    production: {
      target_servings: 10,
      yield_adjustment_version: 2,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      portion_size_grams: 300,
      portion_size_source: 'recipe_portion_size',
      ingredients_used: [{
        ingredient_id: chicken.id,
        planned_quantity: 5,
        unit: 'EA',
        yield_multiplier: 0.8,
        raw_weight_grams: 4500,
        yielded_weight_grams: 3600,
        weight_calculation_source: 'package_measure:frozen_yield_multiplier',
        yield_calculation_source: 'cooking_yield_percent',
        weight_snapshot_version: 1
      }]
    },
    recipe: { ...recipe, portion_size_grams: 1 },
    ingredients: [{
      ...chicken,
      name: 'CHANGED CHICKEN 1/100G',
      cooking_yield_percent: 10
    }]
  });

  assert.equal(summary.output_calculation_source, 'frozen_raw_line_yields');
  assert.equal(summary.recipe_raw_weight_grams, 4500);
  assert.equal(summary.expected_finished_weight_grams, 3600);
  assert.equal(summary.portion_size_grams, 300);
  assert.equal(summary.expected_yield_servings, 12);
  assert.equal(summary.line_weights[0].weight_snapshot_status, 'frozen');
});

test('yield-calculated v2 portions are derived from frozen output and target, not current recipe data', () => {
  const summary = buildAutomaticProductionYieldSummary({
    production: {
      target_servings: 10,
      yield_adjustment_version: 2,
      quantity_semantics: 'raw_recipe_to_yielded_output_v2',
      portion_size_grams: 0.36,
      portion_size_source: 'yield_calculated',
      ingredients_used: [{
        ingredient_id: chicken.id,
        planned_quantity: 5,
        unit: 'EA',
        raw_weight_grams: 4500,
        yielded_weight_grams: 3600,
        yield_multiplier: 0.8
      }]
    },
    recipe: { ...recipe, portion_size_grams: 999 },
    ingredients: [{ ...chicken, name: 'CHANGED 1/1G' }]
  });

  assert.equal(summary.portion_size_grams, 360);
  assert.equal(summary.portion_size_source, 'yield_calculated');
  assert.equal(summary.expected_yield_servings, 10);
});

test('corrupt v2 snapshots reject missing weights, duplicate ingredients and incompatible units', () => {
  const baseProduction = {
    id: 'corrupt-v2',
    recipe_id: recipe.id,
    target_servings: 10,
    yield_adjustment_version: 2,
    quantity_semantics: 'raw_recipe_to_yielded_output_v2'
  };
  assert.throws(() => buildAutomaticProductionCompletionPlan({
    production: {
      ...baseProduction,
      ingredients_used: [{ ingredient_id: 'unknown', planned_quantity: 1, unit: 'EA' }]
    },
    recipeCatalog: [recipe],
    ingredientCatalog: [{ id: 'unknown', name: 'Unknown Each', unit: 'EA' }]
  }), (error) => error.status === 409 && /cannot calculate yield weight/.test(error.message));

  assert.throws(() => buildAutomaticProductionCompletionPlan({
    production: {
      ...baseProduction,
      ingredients_used: [
        { ingredient_id: chicken.id, planned_quantity: 5, unit: 'EA' },
        { ingredient_id: chicken.id, planned_quantity: 1, unit: 'EA' }
      ]
    },
    recipeCatalog: [recipe],
    ingredientCatalog: [chicken]
  }), (error) => error.status === 409 && /duplicate ingredient IDs/.test(error.message));

  assert.throws(() => buildAutomaticProductionCompletionPlan({
    production: {
      ...baseProduction,
      ingredients_used: [{
        ingredient_id: 'liquid',
        planned_quantity: 1,
        unit: 'kg',
        raw_weight_grams: 1000,
        yielded_weight_grams: 1000
      }]
    },
    recipeCatalog: [recipe],
    ingredientCatalog: [{ id: 'liquid', name: 'Liquid', unit: 'l' }]
  }), (error) => error.status === 409 && /cannot be converted/.test(error.message));

  assert.equal(convertProductionQuantityToInventoryUnit({
    quantity: 2,
    sourceUnit: 'kg',
    inventoryUnit: 'g',
    ingredient: { id: 'powder', name: 'Powder', unit: 'kg' }
  }), 2000);
  assert.throws(() => convertProductionQuantityToInventoryUnit({
    quantity: 2,
    sourceUnit: 'kg',
    inventoryUnit: 'l',
    ingredient: { id: 'liquid', name: 'Liquid', unit: 'l' }
  }), (error) => error.status === 409 && /cannot be converted from kg to inventory unit l/.test(error.message));
});

test('legacy in-progress production is rebuilt from recipe raw quantities, yield, target and package weight', () => {
  const plan = buildAutomaticProductionCompletionPlan({
    production: {
      id: 'production-v1',
      recipe_id: recipe.id,
      target_servings: 20,
      yield_adjustment_version: 1,
      ingredients_used: [{
        ingredient_id: chicken.id,
        planned_quantity: 999,
        actual_quantity: 0,
        unit: 'EA'
      }]
    },
    recipeCatalog: [recipe],
    ingredientCatalog: [chicken]
  });

  assert.equal(plan.upgraded_legacy_yield, true);
  assert.equal(plan.quantity_basis, 'legacy_recipe_raw_yield_fallback');
  assert.equal(plan.ingredients_used[0].planned_quantity, 10);
  assert.equal(plan.ingredients_used[0].yielded_quantity, 2.5);
  assert.equal(plan.production_snapshot.expected_finished_weight_grams, 2250);
  assert.equal(plan.production_snapshot.portion_size_grams, 112.5);
  assert.equal(plan.production_snapshot.expected_yield_servings, 20);
  assert.equal(plan.production_snapshot.yield_adjustment_version, 2);
});

test('completion implementation does not read client raw actuals or finished-yield inputs', () => {
  const source = fs.readFileSync(new URL('../server/inventory.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function completeProductionWithExecutor(');
  const end = source.indexOf('\nasync function completeProduction(', start);
  const completion = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(completion, /options\?\.ingredient_quantities/);
  assert.doesNotMatch(completion, /options\?\.actual_finished_weight_grams/);
  assert.match(completion, /buildAutomaticProductionCompletionPlan\(/);
  assert.match(completion, /production: completionProduction/);

  const indexSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const routeStart = indexSource.indexOf("app.post('/api/inventory/production/:id/complete'");
  const routeEnd = indexSource.indexOf('\napp.', routeStart + 1);
  const route = indexSource.slice(routeStart, routeEnd);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(route, /const productionInventorySite = resolveProductionFulfillmentStore\(/);
  assert.match(route, /fulfillment_store_id: productionInventorySite\.id/);
  assert.doesNotMatch(route, /completeProduction\([^;]*request\.body/);
});
