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
  { item_cost: 12, normalized_quantity: 0.5, raw_quantity: 0.5, line_cost: 6 }
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
assert.equal(result.total_raw_recipe_weight_grams, 1450);
assert.equal(result.expected_yield_weight_grams, 1250);
assert.equal(result.quantity_semantics, 'raw_recipe_to_yielded_output_v2');
assert.equal(result.cost_per_100g, 0.72);
assert.equal(result.margin_per_serving, 2.75);
assert.equal(result.food_cost_percent, 45);
assert.equal(result.has_cost, true);

const soySauceCase = {
  id: 'soy-sauce',
  name: 'FILIPINO SOY SAUCE 12/1LTR',
  unit: 'EA',
  average_cost: 6,
  cooking_yield_percent: 100
};
const corianderBundle = {
  id: 'coriander',
  name: 'CORIANDER LEAVES',
  unit: 'BDL',
  average_cost: 2,
  cooking_yield_percent: 100
};
const eggEach = {
  id: 'egg',
  name: 'SHELL EGGS',
  unit: 'EA',
  conversion_unit: 'pieces',
  conversion_factor: 1,
  average_cost: 0.4,
  cooking_yield_percent: 100
};
const goodyPasta = {
  id: 'goody-pasta',
  name: 'GOODY PASTA #20 SPAGHETTI 24/450',
  unit: 'EA',
  average_cost: 4.31,
  cooking_yield_percent: 100
};
const filipinoRecipe = {
  servings: 10,
  costing_method: 'average_cost',
  ingredients: [
    { ingredient_id: 'soy-sauce', quantity: 250, unit: 'ml' },
    { ingredient_id: 'coriander', quantity: 40, unit: 'g' },
    { ingredient_id: 'egg', quantity: 2, unit: 'pieces' },
    { ingredient_id: 'goody-pasta', quantity: 60, unit: 'g' }
  ]
};
const filipinoResult = calculateRecipeCostingSnapshot(
  filipinoRecipe,
  [soySauceCase, corianderBundle, eggEach, goodyPasta],
  []
);
assert.equal(filipinoResult.has_cost, true);
assert.equal(filipinoResult.total_cost, 3.8747);
assert.equal(filipinoResult.cost_per_serving, 0.3875);
assert.deepEqual(
  filipinoResult.lines.map((line) => Number(line.normalized_quantity.toFixed(8))),
  [0.25, 0.5, 2, 0.13333333]
);

console.log('PASS recipe costing formulas, costing methods, conversion, and cooking yield');
