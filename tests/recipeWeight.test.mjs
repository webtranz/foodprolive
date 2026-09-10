import assert from 'node:assert/strict';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import {
  calculateYieldAdjustedQuantity,
  calculateYieldOutputQuantity,
  resolveIngredientYield
} from '../shared/ingredientYield.js';

const ingredients = [
  {
    id: 'rice',
    name: 'Rice',
    unit: 'kg',
    raw_weight_per_unit: 1000,
    cooked_weight_per_unit: 2600,
    cooking_yield_percent: 260
  },
  {
    id: 'chicken',
    name: 'Chicken',
    unit: 'kg',
    conversion_unit: 'g',
    conversion_factor: 1000,
    cooking_yield_percent: 80
  },
  {
    id: 'bread',
    name: 'Bread',
    unit: 'pieces',
    raw_weight_per_unit: 90,
    cooked_weight_per_unit: 85
  },
  {
    id: 'stock',
    name: 'Stock',
    unit: 'l',
    cooking_yield_percent: 90
  }
];

const baseRecipe = {
  id: 'base',
  name: 'Rice Base',
  servings: 4,
  ingredients: [
    { ingredient_id: 'rice', ingredient_name: 'Rice', quantity: 1, unit: 'kg' },
    { ingredient_id: 'stock', ingredient_name: 'Stock', quantity: 500, unit: 'ml' }
  ]
};

const mealRecipe = {
  id: 'meal',
  name: 'Meal',
  servings: 2,
  ingredients: [
    { ingredient_id: 'chicken', ingredient_name: 'Chicken', quantity: 500, unit: 'g' },
    { ingredient_id: 'bread', ingredient_name: 'Bread', quantity: 2, unit: 'pieces' }
  ],
  sub_recipes: [
    { recipe_id: 'base', recipe_name: 'Rice Base', quantity: 2, unit: 'servings' }
  ]
};

const weight = calculateRecipeServingWeight(mealRecipe, [mealRecipe, baseRecipe], ingredients);
assert.equal(weight.is_complete, true);
assert.equal(weight.raw_total_grams, 1430);
assert.equal(weight.cooked_total_grams, 2095);
assert.equal(weight.raw_grams_per_serving, 715);
assert.equal(weight.grams_per_serving, 1047.5);
assert.equal(weight.yielded_total_grams, 2095);
assert.equal(weight.yielded_grams_per_serving, 1047.5);
assert.equal(weight.quantity_semantics, 'raw_recipe_to_yielded_output_v2');

const missingWeight = calculateRecipeServingWeight({
  id: 'unknown',
  servings: 1,
  ingredients: [{ ingredient_id: 'spoon', ingredient_name: 'Spoon', quantity: 1, unit: 'scoop' }]
}, [], [{ id: 'spoon', name: 'Spoon', unit: 'scoop' }]);
assert.equal(missingWeight.is_complete, false);
assert.equal(missingWeight.grams_per_serving, null);
assert.match(missingWeight.warnings[0], /Weight unavailable/);

const defaultYield = calculateRecipeServingWeight({
  id: 'water',
  servings: 2,
  ingredients: [{ ingredient_id: 'water', ingredient_name: 'Water', quantity: 1, unit: 'l' }]
}, [], [{ id: 'water', name: 'Water', unit: 'l' }]);
assert.equal(defaultYield.is_complete, true);
assert.equal(defaultYield.grams_per_serving, 500);

const boiledEggsWithWaterAid = calculateRecipeServingWeight({
  id: 'boiled-eggs',
  servings: 1,
  ingredients: [
    { ingredient_id: 'egg', ingredient_name: 'Egg', quantity: 1, unit: 'pieces' },
    { ingredient_id: 'water', ingredient_name: 'Water', quantity: 0.4, unit: 'l', exempt_processing_aid: true }
  ]
}, [], [
  { id: 'egg', name: 'Egg', unit: 'pieces', raw_weight_per_unit: 50, cooked_weight_per_unit: 50 },
  { id: 'water', name: 'Water', unit: 'l' }
]);
assert.equal(boiledEggsWithWaterAid.is_complete, true);
assert.equal(boiledEggsWithWaterAid.raw_total_grams, 50);
assert.equal(boiledEggsWithWaterAid.cooked_total_grams, 50);

const pastaWithRetainedWater = calculateRecipeServingWeight({
  id: 'pasta',
  servings: 1,
  ingredients: [
    { ingredient_id: 'pasta', ingredient_name: 'Pasta', quantity: 100, unit: 'g' },
    { ingredient_id: 'water', ingredient_name: 'Water', quantity: 1, unit: 'l', prep_exempt_percent: 70 }
  ]
}, [], [
  { id: 'pasta', name: 'Pasta', unit: 'g', cooking_yield_percent: 100 },
  { id: 'water', name: 'Water', unit: 'l' }
]);
assert.equal(pastaWithRetainedWater.is_complete, true);
assert.equal(pastaWithRetainedWater.raw_total_grams, 400);
assert.equal(pastaWithRetainedWater.cooked_total_grams, 400);
assert.equal(pastaWithRetainedWater.grams_per_serving, 400);

const emptyRecipe = calculateRecipeServingWeight({ id: 'empty', servings: 1 }, [], []);
assert.equal(emptyRecipe.is_complete, false);
assert.equal(emptyRecipe.grams_per_serving, null);
assert.match(emptyRecipe.warnings[0], /no non-exempt ingredients/i);

const shrinkageAdjusted = calculateYieldAdjustedQuantity(10, { shrinkage_percent: 20 });
assert.equal(shrinkageAdjusted.required_raw_quantity, 12.5);
assert.equal(shrinkageAdjusted.yield_percent, 80);
assert.equal(shrinkageAdjusted.yield_source, 'shrinkage_percent');

const explicitYieldAdjusted = calculateYieldAdjustedQuantity(10, {
  cooking_yield_percent: 80,
  shrinkage_percent: 30
});
assert.equal(explicitYieldAdjusted.required_raw_quantity, 12.5);
assert.equal(explicitYieldAdjusted.yield_source, 'cooking_yield_percent');

const gainingYield = calculateYieldAdjustedQuantity(26, {
  raw_weight_per_unit: 1000,
  cooked_weight_per_unit: 2600,
  cooking_yield_percent: 200
});
assert.equal(gainingYield.required_raw_quantity, 10);
assert.equal(gainingYield.yield_percent, 260);
assert.equal(gainingYield.yield_source, 'weight_ratio');

const yieldedOutput = calculateYieldOutputQuantity(10, { cooking_yield_percent: 80 });
assert.deepEqual(yieldedOutput, {
  raw_quantity: 10,
  yielded_quantity: 8,
  yield_multiplier: 0.8,
  yield_percent: 80,
  yield_source: 'cooking_yield_percent'
});

assert.deepEqual(resolveIngredientYield({ cooking_yield_percent: 0, shrinkage_percent: 100 }), {
  multiplier: 1,
  percent: 100,
  source: 'default'
});

console.log('Recipe serving weight tests passed.');

const weigh = (quantity, unit, ingredient) => calculateRecipeServingWeight({
  servings: 1, ingredients: [{ ingredient_id: 'test', quantity, unit }]
}, [], [{ ...ingredient, id: 'test' }]);
assert.equal(weigh(2500, 'g', { unit: 'KG', raw_weight_per_unit: 1, cooked_weight_per_unit: 0.89 }).grams_per_serving, 2225);
assert.equal(weigh(2.5, 'kg', { unit: 'KG', raw_weight_per_unit: 1000, cooked_weight_per_unit: 890 }).grams_per_serving, 2225);
assert.equal(weigh(300, 'ml', { unit: 'EA', name: 'Sauce 12/600ML', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 }).grams_per_serving, 300);
assert.equal(weigh(0.3, 'l', { unit: 'EA', name: 'Sauce 12/600ML', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 }).grams_per_serving, 300);
assert.equal(weigh(1, 'EA', { unit: 'EA', name: 'Sauce 12/600ML', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 }).grams_per_serving, 600);
assert.equal(weigh(1, 'CS', { unit: 'CS', name: 'Pasta 24/450G', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 }).grams_per_serving, 10800);
assert.equal(weigh(1, 'PAK', { unit: 'PAK', name: 'Tea 12/50/1.3G', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 }).grams_per_serving, 65);
assert.equal(weigh(1, 'BDL', { unit: 'BDL', name: 'Mint', raw_weight_per_unit: 1, cooked_weight_per_unit: 0.85 }).grams_per_serving, 68);
assert.equal(weigh(1, 'l', { unit: 'l', density_g_per_ml: 0.92 }).grams_per_serving, 920);
assert.equal(weigh(12, 'pieces', { unit: 'PAK', name: 'Eggs 12/30 CT', package_base_quantity: 30, package_base_unit: 'pieces', raw_weight_per_unit: 1500, cooked_weight_per_unit: 1500 }).grams_per_serving, 600);
assert.equal(weigh(12, 'pieces', { unit: 'PAK', name: 'Eggs 12/30 CT', package_base_quantity: 30, package_base_unit: 'pieces', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 }).grams_per_serving, null);
console.log('Legacy yield ratios, package staging, liquids, bundles, and count-weight tests passed.');
