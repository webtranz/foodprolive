import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEntityPayload } from '../server/entities.js';
import { prepareEntityPayload } from '../server/entityPreparation.js';
import { mapCsvRow, resolveBulkUploadSourceName } from '../server/utilities.js';
import { calculateRecipeNutrition } from '../shared/recipeNutrition.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';

const admin = { id: 'upload-admin', role: 'admin' };
const scope = {
  unrestricted: true, sites: [],
  accessibleSiteIds: new Set(), accessibleTreeIds: new Set()
};
const ingredientJob = (sourceName) => ({
  entity_name: 'Ingredient', import_mode: 'keep_existing', source_name: sourceName
});

function parsedIngredient(extraHeaders = [], extraValues = []) {
  return mapCsvRow('ingredients', ['item_code', 'name', ...extraHeaders], ['OIL-1', 'Cooking Oil', ...extraValues]);
}

// Mirror the worker's prepare call and updateDocument's existing-record merge;
// no database connection or stock operation is needed for ingredient patches.
async function applyIngredientPatch(existing, parsed, job = ingredientJob('Cash'), context = {}) {
  const staged = { ...parsed, source_name: resolveBulkUploadSourceName(job, parsed) };
  const prepared = await prepareEntityPayload(admin, 'Ingredient', staged, null, { scope, ...context });
  return validateEntityPayload('Ingredient', { ...existing, ...prepared });
}

test('an explicit ingredient row source overrides the selected upload source', () => {
  const parsed = parsedIngredient(['source_name'], [' cash ']);
  assert.equal(parsed.source_name, 'Cash');
  assert.equal(resolveBulkUploadSourceName(ingredientJob('D365'), parsed), 'Cash');
  const d365Row = parsedIngredient(['source_name'], ['d365']);
  assert.equal(resolveBulkUploadSourceName(ingredientJob('Cash'), d365Row), 'D365');
});

test('omitted or blank ingredient source uses the selected upload source', () => {
  for (const parsed of [parsedIngredient(), parsedIngredient(['source_name'], ['']), parsedIngredient(['source_name'], ['   '])]) {
    assert.equal(Object.hasOwn(parsed, 'source_name'), false, 'a parser default must not masquerade as an explicit row source');
    assert.equal(resolveBulkUploadSourceName(ingredientJob('Cash'), parsed), 'Cash');
  }
  assert.equal(resolveBulkUploadSourceName({ entity_name: 'Ingredient' }, {}), '');
});

test('unsupported ingredient row source is rejected instead of falling back silently', () => {
  assert.throws(
    () => parsedIngredient(['source_name'], ['manual']),
    /Invalid enum value|Expected 'D365' \| 'Cash'/
  );
});

test('Inventory uploads preserve their selected-source precedence', () => {
  const inventoryJob = { entity_name: 'Inventory', source_name: 'Cash' };
  assert.equal(resolveBulkUploadSourceName(inventoryJob, { source_name: 'D365' }), 'Cash');
  assert.equal(resolveBulkUploadSourceName({ ...inventoryJob, source_name: 'D365' }, { source_name: 'Cash' }), 'D365');
  assert.equal(resolveBulkUploadSourceName({ entity_name: 'Inventory' }, { source_name: ' cash ' }), 'Cash');
  assert.equal(resolveBulkUploadSourceName({ entity_name: 'Inventory' }, {}), '');
});

test('keep-existing import preserves ID, omitted values, attached stock and recipe references', async () => {
  const existing = {
    id: 'ingredient-oil', item_code: 'OIL-1', name: 'Cooking Oil', unit: 'l',
    source_name: 'D365', allergens: ['soy'], is_active: false,
    conversion_unit: 'g', conversion_factor: 920, cost_per_unit: 18,
    sugar_per_100g: 0, protein_per_100g: 0,
    stock_summary: { on_hand_quantity: 12, available_quantity: 10, reserved_quantity: 2, unit: 'l' },
    created_date: '2026-01-01T00:00:00.000Z'
  };
  const recipes = [{
    id: 'recipe-linked', servings: 2,
    ingredients: [{ ingredient_id: existing.id, ingredient_name: existing.name, quantity: 1, unit: 'l' }]
  }];
  const inventory = [{ id: 'stock-oil', ingredient_id: existing.id, site_id: 'warehouse-a', quantity: 12, unit: 'l' }];
  const before = structuredClone({ existing, recipes, inventory });
  const context = { ingredientCatalog: [existing], recipeCatalog: recipes, inventory };
  const candidates = [
    parsedIngredient(['cost_per_unit'], ['20']),
    parsedIngredient(['cost_per_unit', 'allergens', 'is_active', 'source_name'], ['20', '', ' ', ''])
  ];
  for (const parsed of candidates) {
    assert.equal(Object.hasOwn(parsed, 'allergens'), false);
    assert.equal(Object.hasOwn(parsed, 'is_active'), false);
    const updated = await applyIngredientPatch(existing, parsed, ingredientJob('Cash'), context);
    assert.equal(updated.id, existing.id);
    assert.equal(updated.created_date, existing.created_date);
    assert.equal(updated.cost_per_unit, 20);
    assert.equal(updated.source_name, 'Cash');
    assert.deepEqual(updated.allergens, ['soy']);
    assert.equal(updated.is_active, false);
    assert.equal(updated.conversion_unit, 'g');
    assert.equal(updated.conversion_factor, 920);
    assert.deepEqual(updated.stock_summary, existing.stock_summary);
    assert.equal(recipes[0].ingredients[0].ingredient_id, updated.id);
    assert.equal(inventory[0].ingredient_id, updated.id);
  }
  assert.deepEqual({ existing, recipes, inventory }, before, 'preparing an ingredient patch must not mutate its master or linked records');
});

test('explicit empty allergens and false active values remain intentional updates', async () => {
  const existing = { id: 'ingredient-oil', name: 'Cooking Oil', item_code: 'OIL-1', allergens: ['soy'], is_active: true };
  const parsed = parsedIngredient(['allergens', 'is_active', 'source_name'], ['[]', 'false', 'Cash']);
  const updated = await applyIngredientPatch(existing, parsed, ingredientJob('D365'));
  assert.equal(updated.id, existing.id);
  assert.deepEqual(updated.allergens, []);
  assert.equal(updated.is_active, false);
  assert.equal(updated.source_name, 'Cash');
});

test('omitted conversion fields preserve legacy unset factors without blocking other updates', async () => {
  for (const conversion_factor of [0, null]) {
    const existing = { id: 'ingredient-oil', name: 'Cooking Oil', item_code: 'OIL-1', conversion_factor };
    const updated = await applyIngredientPatch(existing, parsedIngredient(['cost_per_unit'], ['20']));
    assert.equal(updated.cost_per_unit, 20);
    assert.equal(updated.conversion_factor, conversion_factor);
  }
});

test('a factor-only update retains the existing conversion unit', async () => {
  const existing = { id: 'ingredient-oil', name: 'Cooking Oil', item_code: 'OIL-1', unit: 'l', conversion_unit: 'g', conversion_factor: 900 };
  const updated = await applyIngredientPatch(existing, parsedIngredient(['conversion_factor'], ['920']));
  assert.equal(updated.unit, 'l');
  assert.equal(updated.conversion_unit, 'g');
  assert.equal(updated.conversion_factor, 920);
});

test('an imported 1 litre to 920 gram conversion drives recipe weight and nutrition', async () => {
  const parsed = parsedIngredient([
    'unit', 'conversion_unit', 'conversion_factor', 'raw_weight_per_unit', 'cooked_weight_per_unit',
    'calories_per_100g', 'protein_per_100g', 'sugar_per_100g', 'allergens'
  ], ['l', 'g', '920', '1', '1', '100', '', '', '[]']);
  assert.equal(parsed.conversion_factor, 920);
  assert.equal(typeof parsed.conversion_factor, 'number');
  const existing = { id: 'ingredient-oil', name: 'Cooking Oil', item_code: 'OIL-1', is_active: true };
  const saved = await applyIngredientPatch(existing, parsed);
  const before = structuredClone(saved);
  for (const [quantity, unit, expectedGrams] of [[1, 'l', 920], [500, 'ml', 460]]) {
    const recipe = {
      id: 'recipe-oil', servings: 2,
      ingredients: [{ ingredient_id: saved.id, quantity, unit }]
    };
    const weight = calculateRecipeServingWeight(recipe, [], [saved]);
    const nutrition = calculateRecipeNutrition(recipe, [], [saved]);
    assert.equal(weight.raw_total_grams, expectedGrams);
    assert.equal(weight.raw_grams_per_serving, expectedGrams / 2);
    assert.equal(weight.is_complete, true);
    assert.equal(nutrition.total_calories, expectedGrams);
    assert.equal(nutrition.calories_per_serving, expectedGrams / 2);
    assert.equal(nutrition.protein_per_serving, 0);
    assert.equal(nutrition.sugar_per_serving, 0);
    assert.equal(nutrition.nutrition_complete, true);
  }
  assert.deepEqual(saved, before);
});
