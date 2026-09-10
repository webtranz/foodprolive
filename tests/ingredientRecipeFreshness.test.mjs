import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ingredientPage = readFileSync(new URL('../src/pages/Ingredients.jsx', import.meta.url), 'utf8');
const recipeForm = readFileSync(new URL('../src/components/recipes/RecipeForm.jsx', import.meta.url), 'utf8');

test('every ingredient mutation refreshes master data, search results, and recipe nutrition', () => {
  const source = ingredientPage.slice(
    ingredientPage.indexOf('  // Ingredient mutations'),
    ingredientPage.indexOf('  // Inventory mutations')
  );
  assert.ok(source.includes('const createIngMutation'));
  const invalidated = [];
  const changes = [];
  const mutations = new Function(
    'useMutation',
    'queryClient',
    'setFormOpen',
    'setEditingIngredient',
    'setDeleteDialogOpen',
    'setIngredientToDelete',
    'setIngredientDeleteImpact',
    'setIngredientDeleteError',
    'setIngredientDeleteLoading',
    `${source}\nreturn [createIngMutation, updateIngMutation, deleteIngMutation];`
  )(
    (options) => options,
    { invalidateQueries: ({ queryKey }) => { invalidated.push(queryKey); return Promise.resolve(); } },
    (value) => changes.push(['form', value]),
    (value) => changes.push(['editing', value]),
    (value) => changes.push(['delete', value]),
    (value) => changes.push(['deleting', value]),
    (value) => changes.push(['deleteImpact', value]),
    (value) => changes.push(['deleteError', value]),
    (value) => changes.push(['deleteLoading', value])
  );

  mutations.forEach((mutation, index) => {
    invalidated.length = 0;
    mutation.onSuccess();
    assert.deepEqual(
      invalidated,
      index === 2
        ? [['ingredients'], ['ingredient-search'], ['recipes'], ['inventory']]
        : [['ingredients'], ['ingredient-search'], ['recipes']]
    );
  });
  assert.deepEqual(changes, [
    ['form', false],
    ['form', false],
    ['editing', null],
    ['delete', false],
    ['deleting', null],
    ['deleteImpact', null],
    ['deleteError', ''],
    ['deleteLoading', false]
  ]);
});

const catalogBody = recipeForm.match(/const ingredientCatalog = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/)?.[1];
assert.ok(catalogBody, 'Recipe form must build its effective ingredient catalog');
const buildCatalog = new Function('formData', 'inventory', 'ingredients', 'inventoryLoaded', 'selectedIngredientsById', catalogBody);
const globalScope = { site_scope: 'global', site_ids: [] };

test('saved litre-to-gram conversion and nutrition replace stale selected search fields', () => {
  const saved = {
    id: 'oil', name: 'Saved oil', unit: 'l', conversion_unit: 'g', conversion_factor: 920,
    calories_per_100g: 884, protein_per_100g: null, fat_per_100g: 100, allergens: [],
    source_name: 'Master source', cost_per_unit: 12, standard_cost: 11, last_cost: 13
  };
  const selected = {
    ...saved, name: 'Old oil', unit: 'kg', conversion_factor: 1000,
    calories_per_100g: 0, protein_per_100g: 0, allergens: ['soy'],
    source_name: 'Old source', current_stock: 500, stock_unit: 'kg', average_cost: 1,
    standard_cost: 1, last_cost: 1
  };
  const before = JSON.stringify({ saved, selected });
  const [actual] = buildCatalog({ site_scope: 'specific', site_ids: ['selected-store'] }, [
    { ingredient_id: 'oil', site_id: 'selected-store', quantity: 4, unit_cost: 10 },
    { ingredient_id: 'oil', site_id: 'another-store', quantity: 100, unit_cost: 999 }
  ], [saved], true, { oil: selected });

  assert.equal(actual.unit, 'l');
  assert.equal(actual.conversion_unit, 'g');
  assert.equal(actual.conversion_factor, 920);
  assert.equal(actual.calories_per_100g, 884);
  assert.equal(actual.protein_per_100g, null);
  assert.deepEqual(actual.allergens, []);
  assert.equal(actual.source_name, 'Master source');
  assert.equal(actual.current_stock, 4);
  assert.equal(actual.average_cost, 10);
  assert.equal(actual.standard_cost, 11);
  assert.equal(actual.last_cost, 13);
  assert.equal(actual.stock_unit, undefined);
  assert.equal(JSON.stringify({ saved, selected }), before, 'Catalog merging must not edit either source record');
});

test('removed master fields and valid zeros cannot be resurrected from old search data', () => {
  const [actual] = buildCatalog(globalScope, [], [
    { id: 'food', unit: 'g', fat_per_100g: 0, cost_per_unit: 0 }
  ], true, {
    food: { id: 'food', conversion_unit: 'kg', conversion_factor: 1000, fat_per_100g: 8, current_stock: 20, average_cost: 5 }
  });
  assert.equal(actual.conversion_unit, undefined);
  assert.equal(actual.conversion_factor, undefined);
  assert.equal(actual.fat_per_100g, 0);
  assert.equal(actual.current_stock, 0);
  assert.equal(actual.average_cost, 0);
});

test('search-only selections remain usable with their existing stock unit and cost context', () => {
  const selection = {
    id: 'search-only', unit: 'l', conversion_unit: 'g', conversion_factor: 920,
    current_stock: 7, stock_unit: 'l', cost_per_unit: 12, last_cost: 13,
    average_cost: 11, source_name: 'Selected source'
  };
  const [actual] = buildCatalog(globalScope, [], [], false, { 'search-only': selection });
  assert.equal(actual.unit, 'l');
  assert.equal(actual.conversion_factor, 920);
  assert.equal(actual.current_stock, 7);
  assert.equal(actual.stock_unit, 'l');
  assert.equal(actual.cost_per_unit, 12);
  assert.equal(actual.last_cost, 13);
  assert.equal(actual.average_cost, 11);
  assert.equal(actual.source_name, 'Selected source');
});
