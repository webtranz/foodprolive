import assert from 'node:assert/strict';

import {
  calculateRecipeCostingSnapshot,
  calculateRecipeIngredientLineCost,
  resolveIngredientItemCost
} from '../shared/recipeCosting.js';

const corn = {
  id: 'corn',
  name: 'Corn Oil',
  unit: 'l',
  average_cost: 10,
  last_cost: 12,
  standard_cost: 8,
  density_g_per_ml: 0.9,
  cooking_yield_percent: 100
};
const flour = {
  id: 'flour',
  name: 'Corn Flour',
  unit: 'kg',
  average_cost: 4,
  last_cost: 5,
  standard_cost: 3,
  cooking_yield_percent: 80
};

assert.equal(resolveIngredientItemCost(corn, 'average_cost'), 10);
assert.equal(resolveIngredientItemCost(corn, 'last_cost'), 12);
assert.equal(resolveIngredientItemCost(corn, 'standard_cost'), 8);
assert.equal(resolveIngredientItemCost({ cost_per_unit: null }, 'average_cost'), null);
assert.deepEqual(
  calculateRecipeIngredientLineCost({ quantity: 500, unit: 'ml' }, corn, 'last_cost'),
  { item_cost: 12, normalized_quantity: 0.5, line_cost: 6 }
);

const recipe = {
  servings: 4,
  costing_method: 'average_cost',
  target_selling_price: 5,
  ingredients: [
    { ingredient_id: 'corn', quantity: 500, unit: 'ml' },
    { ingredient_id: 'flour', quantity: 1, unit: 'kg' }
  ]
};
const result = calculateRecipeCostingSnapshot(recipe, [corn, flour], []);
assert.equal(result.total_cost, 9);
assert.equal(result.cost_per_serving, 2.25);
assert.equal(result.total_recipe_weight_grams, 1250);
assert.equal(result.cost_per_100g, 0.72);
assert.equal(result.margin_per_serving, 2.75);
assert.equal(result.food_cost_percent, 45);
assert.equal(result.has_cost, true);

console.log('PASS recipe costing formulas, costing methods, conversion, and cooking yield');
