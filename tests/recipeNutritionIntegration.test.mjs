import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { calculateRecipeNutrition } from '../shared/recipeNutrition.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { calculateRecipeCostingSnapshot } from '../shared/recipeCosting.js';
import { roundStandardDecimal } from '../shared/recipeNumbers.js';
import { prepareEntityPayload } from '../server/entityPreparation.js';
import { filterRecordsByLocation } from '../server/locationScope.js';
import { mapCsvRow } from '../server/utilities.js';

const ingredients = [{
  id: 'cereal', name: 'Test cereal', unit: 'kg', cost_per_unit: 10,
  calories_per_100g: 350, protein_per_100g: 10, carbs_per_100g: 65,
  fat_per_100g: 2, sodium_per_100g: 5, sugar_per_100g: 0, allergens: ['gluten']
}];
const sites = [{ id: 'site-a', name: 'Warehouse A', type: 'store' }, { id: 'site-b', name: 'Warehouse B', type: 'store' }];
const legacyRecipe = {
  id: 'recipe-a', name: 'Warehouse A recipe', servings: 2,
  ingredients: [{ ingredient_id: 'cereal', quantity: 200, unit: 'g' }],
  site_scope: 'specific', site_ids: ['site-a'], site_names: ['Warehouse A'],
  allergens: [], calories_per_serving: 0, protein_per_serving: 0
};
const scope = { unrestricted: true, sites, accessibleSiteIds: new Set(['site-a', 'site-b']), accessibleTreeIds: new Set(['site-a', 'site-b']) };
const context = { scope, recipeCatalog: [legacyRecipe], ingredientCatalog: ingredients, ingredientCostSnapshots: {} };
const admin = { id: 'admin', role: 'admin' };
const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

// Exercise the real read decorator and its invalidation without starting a
// server or connecting to a database. Only the catalog loader is replaced.
function readHarness(catalog = ingredients) {
  const decorator = serverSource.slice(serverSource.indexOf('async function decorateRecipesWithServingWeights('), serverSource.indexOf('async function getCostingCatalogs('));
  const invalidator = serverSource.slice(serverSource.indexOf('function invalidateEntityDataCaches('), serverSource.indexOf('async function decorateEntityRecords('));
  const state = { ingredients: structuredClone(catalog) };
  const methods = vm.runInNewContext(`${decorator}\n${invalidator}\n({ decorate: decorateRecipesWithServingWeights, invalidate: invalidateEntityDataCaches })`, {
    getCostingCatalogs: async () => ({ recipeCatalog: [legacyRecipe], ingredients: state.ingredients }),
    calculateRecipeNutrition, calculateRecipeServingWeight, calculateRecipeCostingSnapshot, roundStandardDecimal,
    costingCatalogCacheTtlMs: 10000, costingCatalogGeneration: 1, recipeDecorationCache: new Map(),
    maximumRecipeDecorationCacheEntries: 10000, costingCatalogCache: null, costingCatalogPromise: null
  });
  return { ...methods, state };
}

test('opening an existing recipe fills nutrition and allergens without saving or moving its warehouse', async () => {
  const before = JSON.stringify(legacyRecipe);
  const { decorate } = readHarness();
  const [recipe] = await decorate([legacyRecipe]);
  assert.equal(recipe.calories_per_serving, 350);
  assert.equal(recipe.protein_per_serving, 10);
  assert.equal(recipe.sugar_per_serving, 0);
  assert.deepEqual(recipe.allergens, ['gluten']);
  assert.equal(recipe.nutrition_complete, true);
  assert.equal(recipe.site_scope, 'specific');
  assert.deepEqual(recipe.site_ids, ['site-a']);
  assert.deepEqual(recipe.site_names, ['Warehouse A']);
  assert.equal(JSON.stringify(legacyRecipe), before, 'reads must not modify stored recipes');
});

test('ingredient changes invalidate cached recipe nutrition and allergen details', async () => {
  const harness = readHarness();
  assert.equal((await harness.decorate([legacyRecipe]))[0].calories_per_serving, 350);
  harness.state.ingredients[0].calories_per_100g = 400;
  harness.state.ingredients[0].allergens = ['soy'];
  harness.invalidate('Ingredient');
  const [refreshed] = await harness.decorate([legacyRecipe]);
  assert.equal(refreshed.calories_per_serving, 400);
  assert.deepEqual(refreshed.allergens, ['soy']);
});

test('normal saves recalculate supplied stale totals and leave site assignments and master ingredients alone', async () => {
  const before = JSON.stringify(ingredients);
  const saved = await prepareEntityPayload(admin, 'Recipe', { ...legacyRecipe, calories_per_serving: 9999 }, null, context);
  assert.equal(saved.calories_per_serving, 350);
  assert.deepEqual(saved.allergens, ['gluten']);
  assert.equal(saved.nutrition_complete, true);
  assert.deepEqual(saved.site_ids, ['site-a']);
  assert.deepEqual(saved.site_names, ['Warehouse A']);
  assert.equal(saved.site_scope, 'specific');
  const renamed = await prepareEntityPayload(admin, 'Recipe', { name: 'Renamed warehouse recipe' }, saved, context);
  assert.equal(renamed.calories_per_serving, 350);
  assert.deepEqual(renamed.site_ids, saved.site_ids);
  assert.equal(JSON.stringify(ingredients), before);
});

test('reads and saves use zero for missing nutrient fields while preserving ingredient and warehouse data', async () => {
  const catalog = [{ ...ingredients[0], protein_per_100g: null, sugar_per_100g: '  ' }];
  const before = structuredClone(catalog);
  const { decorate } = readHarness(catalog);
  const [opened] = await decorate([legacyRecipe]);
  const saved = await prepareEntityPayload(admin, 'Recipe', legacyRecipe, null, { ...context, ingredientCatalog: catalog });
  for (const result of [opened, saved]) {
    assert.equal(result.calories_per_serving, 350);
    assert.equal(result.protein_per_serving, 0);
    assert.equal(result.sugar_per_serving, 0);
    assert.equal(result.nutrition_complete, true);
    assert.deepEqual(result.nutrition_warnings, []);
    assert.deepEqual(result.allergens, ['gluten']);
    assert.deepEqual(result.site_ids, ['site-a']);
    assert.deepEqual(result.site_names, ['Warehouse A']);
  }
  assert.deepEqual(catalog, before);
});

test('saved 1 litre to 920 gram conversion is used consistently on recipe reads and saves', async () => {
  const catalog = [{
    ...ingredients[0], unit: 'l', conversion_unit: 'g', conversion_factor: 920,
    raw_weight_per_unit: 1, calories_per_100g: 100, protein_per_100g: undefined, sugar_per_100g: ''
  }];
  const liquidRecipe = { ...legacyRecipe, ingredients: [{ ingredient_id: 'cereal', quantity: 1, unit: 'l' }] };
  const before = structuredClone(catalog);
  const { decorate } = readHarness(catalog);
  const [opened] = await decorate([liquidRecipe]);
  const saved = await prepareEntityPayload(admin, 'Recipe', liquidRecipe, null, { ...context, ingredientCatalog: catalog });
  for (const result of [opened, saved]) {
    assert.equal(result.total_calories, 920);
    assert.equal(result.calories_per_serving, 460);
    assert.equal(result.protein_per_serving, 0);
    assert.equal(result.sugar_per_serving, 0);
    assert.equal(result.nutrition_complete, true);
    assert.deepEqual(result.site_ids, ['site-a']);
  }
  assert.deepEqual(catalog, before);
});

test('CSV imports with empty allergens and no nutrition acquire both from linked ingredients', async () => {
  const imported = mapCsvRow('recipes', ['name', 'servings', 'ingredients', 'allergens', 'site_scope', 'site_ids'], [
    'Imported warehouse recipe', '2', JSON.stringify(legacyRecipe.ingredients), '[]', 'specific', '["site-a"]'
  ]);
  const saved = await prepareEntityPayload(admin, 'Recipe', imported, null, context);
  assert.equal(saved.calories_per_serving, 350);
  assert.equal(saved.total_calories, 700);
  assert.deepEqual(saved.allergens, ['gluten']);
  assert.deepEqual(saved.site_ids, ['site-a']);
  const worker = readFileSync(new URL('../server/bulkUploadWorker.js', import.meta.url), 'utf8');
  assert.match(worker, /await prepareEntityPayload\(/);
});

test('warehouse-restricted users still receive only their permitted recipes', async () => {
  const manager = { role: 'project_manager' };
  const restricted = { ...scope, unrestricted: false, accessibleSiteIds: new Set(['site-a']), accessibleTreeIds: new Set(['site-a']) };
  const other = { ...legacyRecipe, id: 'recipe-b', site_ids: ['site-b'], site_names: ['Warehouse B'] };
  const visible = filterRecordsByLocation(manager, 'Recipe', [legacyRecipe, other], restricted);
  assert.deepEqual(visible.map((recipe) => recipe.id), ['recipe-a']);
  const { decorate } = readHarness();
  const result = await decorate(visible);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'recipe-a');
  assert.deepEqual(result[0].site_ids, ['site-a']);
  assert.equal(result[0].calories_per_serving, 350);
});

test('an import updating an already calculated recipe keeps explicit allergen declarations', async () => {
  const existing = await prepareEntityPayload(admin, 'Recipe', legacyRecipe, null, context);
  const imported = mapCsvRow('recipes', ['name', 'ingredients', 'allergens'], [
    'Updated warehouse recipe', JSON.stringify(legacyRecipe.ingredients), '["sesame"]'
  ]);
  const updated = await prepareEntityPayload(admin, 'Recipe', imported, existing, context);
  assert.deepEqual(updated.allergens, ['gluten', 'sesame']);
  assert.deepEqual(updated.declared_allergens, ['sesame']);
  assert.equal(updated.allergens_complete, true);
  assert.deepEqual(updated.site_ids, ['site-a']);
});

test('missing weight returns unknown nutrition but still displays known allergens', async () => {
  const { decorate } = readHarness([{
    ...ingredients[0], unit: 'PAK', name: 'Test pack', raw_weight_per_unit: 1,
    protein_per_100g: null, sugar_per_100g: ''
  }]);
  const [recipe] = await decorate([{ ...legacyRecipe, ingredients: [{ ingredient_id: 'cereal', quantity: 1, unit: 'PAK' }] }]);
  assert.equal(recipe.calories_per_serving, null);
  assert.equal(recipe.protein_per_serving, null);
  assert.equal(recipe.sugar_per_serving, null);
  assert.equal(recipe.nutrition_complete, false);
  assert.ok(recipe.nutrition_warnings.length > 0);
  assert.deepEqual(recipe.allergens, ['gluten']);
});

test('editor, cards and nutrition labels distinguish missing values from legitimate zero', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const form = read('src/components/recipes/RecipeForm.jsx');
  const card = read('src/components/recipes/RecipeCard.jsx');
  const labels = read('src/pages/NutritionAllergen.jsx');
  assert.match(form, /calculateRecipeNutrition\(/);
  assert.doesNotMatch(form, /function quantityToGrams/);
  assert.match(form, /legacy_allergens: recipe\.legacy_allergens/);
  for (const source of [form, card]) {
    assert.match(source, /calories_per_serving \?\? '—'/);
    assert.match(source, /Nutrition incomplete/);
    assert.match(source, /Allergen information incomplete/);
    assert.match(source, /slice\(0, 3\)/);
  }
  assert.doesNotMatch(card, /recipe\.calories_per_serving > 0/);
  assert.match(labels, /row\.perPortion \?\? 'Unknown'/);
  assert.match(labels, /nutrition_status: formatNutritionStatus/);
});
