import assert from 'node:assert/strict';
import test from 'node:test';
import { convertIngredientQuantity, ingredientWeightConversion, isIngredientUnitCompatible } from '../shared/ingredientUnits.js';
import { ingredientForRecipeLine } from '../shared/recipeLineWeight.js';
import { calculateRecipeIngredientLineCost } from '../shared/recipeCosting.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { calculateRecipeNutrition } from '../shared/recipeNutrition.js';
import { calculateFrozenProductionLineWeight } from '../shared/productionReconciliation.js';
import { buildProductionIngredientSnapshot, buildProductionIngredientsForSubmit } from '../src/lib/productionIssue.js';

// Reproduce the reported setup without editing any live ingredient or stock.
const oil = {
  id: 'oil-221871', item_code: '221871', name: 'Cooking oil 1/18LTR',
  unit: 'l', conversion_unit: 'g', conversion_factor: 920, cost_per_unit: 12,
  raw_weight_per_unit: 1, cooked_weight_per_unit: 1,
  calories_per_100g: 884, fat_per_100g: 100, allergens: []
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

test('saved conversions compose with metric scales, aliases and inverse conversions', () => {
  for (const [quantity, from, to, expected] of [
    [1, 'l', 'g', 920], [500, 'ml', 'g', 460], [2, 'l', 'kg', 1.84],
    [460, 'g', 'l', 0.5], [460, 'g', 'ml', 500], [0.46, 'kg', 'l', 0.5],
    [1, 'LTR', 'grams', 920], [0.5, 'LT', 'g', 460], [1, 'ltrs', 'g', 920],
    [1, 'litres', 'ml', 1000], [0, 'ml', 'g', 0]
  ]) {
    assert.equal(isIngredientUnitCompatible(from, to, oil), true, `${from} -> ${to}`);
    close(convertIngredientQuantity(quantity, from, to, oil), expected);
  }
});

test('kilogram, inverse and millilitre ingredient definitions establish the same mass', () => {
  for (const definition of [
    { unit: 'l', conversion_unit: 'kg', conversion_factor: 0.92 },
    { unit: 'g', conversion_unit: 'l', conversion_factor: 1 / 920 },
    { unit: 'ml', conversion_unit: 'g', conversion_factor: 0.92 }
  ]) {
    const ingredient = { ...oil, ...definition };
    close(ingredientWeightConversion(500, 'ml', ingredient).grams, 460);
    close(convertIngredientQuantity(0.46, 'kg', 'ml', ingredient), 500);
  }
});

test('package conversion conflicts cannot change exact metric-to-metric scales', () => {
  const weightedPack = { unit: 'EA', package_base_quantity: 1, package_base_unit: 'kg', conversion_unit: 'g', conversion_factor: 920 };
  assert.equal(convertIngredientQuantity(1000, 'g', 'kg', weightedPack), 1);
  assert.equal(convertIngredientQuantity(1, 'kg', 'g', weightedPack), 1000);
  const volumePack = { unit: 'EA', package_base_quantity: 1, package_base_unit: 'l', conversion_unit: 'ml', conversion_factor: 900 };
  assert.equal(convertIngredientQuantity(1000, 'ml', 'l', volumePack), 1);
  assert.equal(convertIngredientQuantity(1, 'l', 'ml', volumePack), 1000);
});

test('nutrition, serving weights, costing and production agree on a saved liquid conversion', () => {
  const line = { ingredient_id: oil.id, quantity: 500, unit: 'ml' };
  const recipe = { id: 'oil-recipe', servings: 2, ingredients: [line], site_ids: ['warehouse-a'] };
  const before = structuredClone({ oil, recipe });
  assert.equal(calculateRecipeServingWeight(recipe, [], [oil]).raw_total_grams, 460);
  const costing = calculateRecipeIngredientLineCost(line, oil);
  close(costing.normalized_quantity, 0.5);
  close(costing.line_cost, 6);
  const nutrition = calculateRecipeNutrition(recipe, [], [oil]);
  assert.equal(nutrition.nutrition_complete, true);
  assert.equal(nutrition.total_calories, 4066);
  assert.equal(nutrition.protein_per_serving, 0);
  assert.equal(nutrition.sugar_per_serving, 0);
  const produced = calculateFrozenProductionLineWeight({ ...line, planned_quantity: 500 }, oil);
  assert.equal(produced.raw_weight_grams, 460);
  assert.match(produced.source, /^ingredient_conversion:/);
  const snapshot = buildProductionIngredientSnapshot({ recipe, ingredients: [oil], targetServings: 4 });
  const submitted = buildProductionIngredientsForSubmit(snapshot.lines);
  assert.equal(calculateFrozenProductionLineWeight(submitted[0], oil).raw_weight_grams, 920);
  assert.deepEqual({ oil, recipe }, before);
});

test('defined packages use saved weight without assuming every EA is one litre', () => {
  const container = { ...oil, unit: 'EA', conversion_unit: 'g', conversion_factor: 16560 };
  close(ingredientWeightConversion(1, 'EA', container).grams, 16560);
  close(ingredientWeightConversion(1, 'l', container).grams, 920);
  close(convertIngredientQuantity(460, 'g', 'EA', container), 0.5 / 18);
  const counted = { unit: 'PAK', name: 'Eggs 12/30 CT', conversion_unit: 'g', conversion_factor: 1500 };
  close(ingredientWeightConversion(2, 'pieces', counted).grams, 100);
});

test('explicit density works in both directions but does not replace a saved conversion', () => {
  const densityOnly = { unit: 'l', density_g_per_ml: 0.92 };
  close(convertIngredientQuantity(500, 'ml', 'g', densityOnly), 460);
  close(convertIngredientQuantity(460, 'g', 'ml', densityOnly), 500);
  assert.equal(isIngredientUnitCompatible('g', 'l', densityOnly), true);
  assert.equal(ingredientWeightConversion(1, 'l', { ...oil, density_g_per_ml: 1 }).grams, 920);
});

test('recipe-specific definitions and completed production snapshots retain precedence', () => {
  const line = {
    ingredient_id: oil.id, quantity: 1, planned_quantity: 1, unit: 'l',
    weight_unit: 'l', weight_ingredient_id: oil.id, weight_per_unit_grams: 850
  };
  assert.equal(calculateFrozenProductionLineWeight(line, oil).raw_weight_grams, 850);
  const scoped = ingredientForRecipeLine(line, oil);
  close(convertIngredientQuantity(500, 'ml', 'g', scoped), 425);
  close(convertIngredientQuantity(425, 'g', 'ml', scoped), 500);
  const frozen = { ...line, raw_weight_grams: 900, yielded_weight_grams: 810 };
  assert.equal(calculateFrozenProductionLineWeight(frozen, { ...oil, conversion_factor: 950 }).raw_weight_grams, 900);
});

test('missing and invalid conversion values do not establish liquid weight', () => {
  for (const conversion_factor of [null, undefined, '', ' ', 0, -1, false, {}, 'invalid', Infinity]) {
    const ingredient = { unit: 'l', conversion_unit: 'g', conversion_factor };
    assert.equal(ingredientWeightConversion(1, 'l', ingredient), null);
    assert.equal(isIngredientUnitCompatible('l', 'g', ingredient), false);
  }
  assert.equal(ingredientWeightConversion(1, 'BDL', { unit: 'BDL', name: 'Mint' }), null);
  assert.equal(ingredientWeightConversion(1, 'EA', { unit: 'EA', name: 'Oil 12/1', density_g_per_ml: 0.92 }), null);
  assert.equal(ingredientWeightConversion(1, 'pieces', { unit: 'pieces', raw_weight_per_unit: 1 }), null);
});
