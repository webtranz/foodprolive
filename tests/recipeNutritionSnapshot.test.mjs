import assert from 'node:assert/strict';
import { calculateRecipeNutritionSnapshot } from '../shared/recipeNutrition.js';

const ingredient = {
  id: 'ingredient-pepper',
  name: 'Yellow pepper',
  unit: 'g',
  calories_per_100g: 35,
  carbs_per_100g: 7,
  fat_per_100g: 0.2,
  sodium_per_100g: 15,
  sugar_per_100g: 3,
  allergens: []
};

const recipe = {
  id: 'recipe-stale',
  name: 'Stale saved recipe',
  servings: 1,
  calories_per_serving: 999,
  protein_per_serving: 999,
  ingredients: [
    {
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: 100,
      unit: 'g'
    }
  ],
  allergens: ['milk']
};

const liveSnapshot = calculateRecipeNutritionSnapshot(recipe, [recipe], [ingredient]);
assert.equal(liveSnapshot.calories_per_serving, 35);
assert.equal(liveSnapshot.protein_per_serving, 0);
assert.equal(liveSnapshot.carbs_per_serving, 7);
assert.deepEqual(liveSnapshot.allergens, ['milk']);
assert.equal(liveSnapshot.nutrition_complete, true);

const manualRecipe = {
  id: 'manual-recipe',
  servings: 1,
  calories_per_serving: 120,
  protein_per_serving: 8,
  carbs_per_serving: 10,
  fat_per_serving: 4,
  sodium_per_serving: 30,
  sugar_per_serving: 2,
  allergens: ['egg']
};

const manualSnapshot = calculateRecipeNutritionSnapshot(manualRecipe, [manualRecipe], []);
assert.equal(manualSnapshot.calories_per_serving, 120);
assert.deepEqual(manualSnapshot.allergens, ['egg']);
assert.equal(manualSnapshot.nutrition_complete, true);

console.log('recipe nutrition snapshot tests passed');
