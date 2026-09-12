import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecipeIngredientUnitSync,
  buildRecipeIngredientUnitSyncPreview
} from '../shared/recipeUnitSync.js';

test('recipe unit sync converts counted recipe lines into the current package unit', () => {
  const ingredient = {
    id: 'egg',
    item_code: '142110',
    name: 'SAEDCO FRESH EGGS MEDIUM 12/30 CT',
    unit: 'pak',
    conversion_unit: 'g',
    conversion_factor: 1500,
    supplier_item_name: 'SAEDCO FRESH EGGS MEDIUM 12/30 CT'
  };
  const recipe = {
    id: 'boiled-eggs',
    name: 'Boiled Eggs',
    ingredients: [{
      ingredient_id: 'egg',
      ingredient_name: 'SAEDCO FRESH EGGS MEDIUM 12/30 CT',
      quantity: 30,
      unit: 'ct',
      weight_per_unit_grams: 50,
      weight_unit: 'ct',
      weight_ingredient_id: 'egg'
    }]
  };

  const preview = buildRecipeIngredientUnitSyncPreview({ recipes: [recipe], ingredients: [ingredient] });
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].current_unit, 'ct');
  assert.equal(preview.changes[0].proposed_unit, 'pak');
  assert.equal(preview.changes[0].proposed_quantity, 1);

  const applied = applyRecipeIngredientUnitSync(recipe, [ingredient], preview.changes);
  assert.equal(applied.changes.length, 1);
  assert.equal(applied.recipe.ingredients[0].quantity, 1);
  assert.equal(applied.recipe.ingredients[0].unit, 'pak');
  assert.equal(applied.recipe.ingredients[0].weight_per_unit_grams, undefined);
  assert.equal(applied.recipe.ingredients[0].weight_unit, undefined);
});

test('recipe unit sync refreshes display aliases without changing equivalent quantities', () => {
  const ingredient = {
    id: 'bread',
    item_code: 'BK000001',
    name: 'SLICED BREAD WHITE',
    unit: 'ct',
    conversion_unit: 'g',
    conversion_factor: 25
  };
  const recipe = {
    id: 'sandwich',
    name: 'Sandwich',
    ingredients: [{
      ingredient_id: 'bread',
      ingredient_name: 'SLICED BREAD WHITE',
      quantity: 2,
      unit: 'pieces'
    }]
  };

  const preview = buildRecipeIngredientUnitSyncPreview({ recipes: [recipe], ingredients: [ingredient] });
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].proposed_quantity, 2);
  assert.equal(preview.changes[0].proposed_unit, 'ct');

  const applied = applyRecipeIngredientUnitSync(recipe, [ingredient], preview.changes);
  assert.equal(applied.recipe.ingredients[0].quantity, 2);
  assert.equal(applied.recipe.ingredients[0].unit, 'ct');
});
