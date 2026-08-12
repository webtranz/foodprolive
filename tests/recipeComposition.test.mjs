import assert from 'node:assert/strict';
import {
  expandRecipeIngredients,
  validateRecipeComposition,
  wouldCreateRecipeCycle
} from '../shared/recipeComposition.js';
import { calculateRecipeCostSnapshot } from '../src/lib/menuPlanning.js';

const ingredients = [
  { id: 'flour', name: 'Flour', unit: 'kg', cost_per_unit: 3 },
  { id: 'oil', name: 'Oil', unit: 'l', cost_per_unit: 4 },
  { id: 'salt', name: 'Salt', unit: 'kg', cost_per_unit: 2 }
];

const sauce = {
  id: 'sauce',
  name: 'Sauce',
  servings: 10,
  ingredients: [
    { ingredient_id: 'oil', ingredient_name: 'Oil', quantity: 500, unit: 'ml' },
    { ingredient_id: 'salt', ingredient_name: 'Salt', quantity: 100, unit: 'g' }
  ]
};
const dough = {
  id: 'dough',
  name: 'Dough',
  servings: 4,
  ingredients: [{ ingredient_id: 'flour', ingredient_name: 'Flour', quantity: 2, unit: 'kg' }]
};
const meal = {
  id: 'meal',
  name: 'Meal',
  servings: 4,
  ingredients: [{ ingredient_id: 'salt', ingredient_name: 'Salt', quantity: 20, unit: 'g' }],
  sub_recipes: [
    { recipe_id: 'dough', recipe_name: 'Dough', quantity: 1, unit: 'batch' },
    { recipe_id: 'sauce', recipe_name: 'Sauce', quantity: 5, unit: 'servings' }
  ]
};

const expansion = expandRecipeIngredients(meal, [meal, dough, sauce], ingredients);
assert.equal(expansion.has_errors, false);
assert.deepEqual(
  expansion.ingredients.map((line) => [line.ingredient_id, line.quantity, line.unit]),
  [
    ['salt', 0.07, 'kg'],
    ['flour', 2, 'kg'],
    ['oil', 0.25, 'l']
  ]
);
const costSnapshot = calculateRecipeCostSnapshot(meal, ingredients, [meal, dough, sauce]);
assert.equal(costSnapshot.has_cost, true);
assert.ok(Math.abs(costSnapshot.total_cost - 7.14) < 1e-9);
assert.ok(Math.abs(costSnapshot.cost_per_serving - 1.785) < 1e-9);

const scaled = expandRecipeIngredients(meal, [meal, dough, sauce], ingredients, { multiplier: 2 });
assert.deepEqual(
  scaled.ingredients.map((line) => [line.ingredient_id, line.quantity]),
  [['salt', 0.14], ['flour', 4], ['oil', 0.5]]
);

const cyclicSauce = { ...sauce, sub_recipes: [{ recipe_id: 'meal', recipe_name: 'Meal', quantity: 1, unit: 'batch' }] };
assert.equal(wouldCreateRecipeCycle('meal', 'sauce', [meal, dough, cyclicSauce]), true);
assert.ok(validateRecipeComposition(meal, [meal, dough, cyclicSauce]).some((error) => error.includes('Circular')));

console.log('Recipe composition tests passed.');
