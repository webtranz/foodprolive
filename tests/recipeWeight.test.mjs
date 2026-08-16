import assert from 'node:assert/strict';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import {
  calculateYieldAdjustedQuantity,
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

const emptyRecipe = calculateRecipeServingWeight({ id: 'empty', servings: 1 }, [], []);
assert.equal(emptyRecipe.is_complete, false);
assert.equal(emptyRecipe.grams_per_serving, null);
assert.match(emptyRecipe.warnings[0], /no ingredients/i);

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

assert.deepEqual(resolveIngredientYield({ cooking_yield_percent: 0, shrinkage_percent: 100 }), {
  multiplier: 1,
  percent: 100,
  source: 'default'
});

console.log('Recipe serving weight tests passed.');
