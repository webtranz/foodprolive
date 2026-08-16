import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  moveIngredientPickerIndex,
  rankIngredientSearchMatch,
  resolveIngredientPickerKey,
  searchIngredientCatalog,
  splitHighlightedIngredientText
} from '../shared/ingredientSearch.js';

function test(name, callback) {
  try {
    callback();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const cornCatalog = [
  { id: 'sweet', name: 'Sweet Corn Frozen', sku: 'ING-567', category: 'Vegetables', is_active: true },
  { id: 'oil', name: 'Corn Oil', sku: 'ING-312', category: 'Oils & Fats', is_active: true },
  { id: 'exact', name: 'Corn', sku: 'ING-001', category: 'Vegetables', is_active: true },
  { id: 'baby', name: 'Baby Corn Fresh', sku: 'ING-891', category: 'Vegetables', is_active: true },
  { id: 'flour', name: 'Corn Flour', sku: 'ING-245', category: 'Flours & Meals', is_active: true },
  { id: 'inactive', name: 'Corn Starch Retired', sku: 'ING-999', is_active: false }
];

test('orders exact, starts-with and contains matches, alphabetically within each group', () => {
  const result = searchIngredientCatalog(cornCatalog, { query: '  CORN ', limit: 20 });
  assert.deepEqual(result.items.map((item) => item.id), ['exact', 'flour', 'oil', 'baby', 'sweet']);
  assert.deepEqual(result.items.map((item) => item.relevance), [0, 1, 1, 2, 2]);
  assert.equal(result.indexed_count, 5);
});

test('searches SKU, category, alias, alternative name and supplier item name', () => {
  const record = {
    id: 'multi',
    name: 'Maize Meal',
    sku: 'SKU-4410',
    category: 'Dry Goods',
    aliases: ['Corn Meal'],
    alternative_names: ['Polenta Base'],
    supplier_item_name: 'Golden Grain Fine',
    is_active: true
  };
  assert.equal(rankIngredientSearchMatch(record, 'sku-4410'), 0);
  assert.equal(rankIngredientSearchMatch(record, 'dry'), 1);
  assert.equal(rankIngredientSearchMatch(record, 'corn meal'), 0);
  assert.equal(rankIngredientSearchMatch(record, 'polenta'), 1);
  assert.equal(rankIngredientSearchMatch(record, 'grain fine'), 2);
});

test('returns a stable empty and paginated state', () => {
  const noResult = searchIngredientCatalog(cornCatalog, { query: 'pineapple', page: 1, limit: 2 });
  assert.equal(noResult.total_count, 0);
  assert.deepEqual(noResult.items, []);
  assert.equal(noResult.total_pages, 1);

  const page = searchIngredientCatalog(cornCatalog, { query: 'corn', page: 2, limit: 2 });
  assert.deepEqual(page.items.map((item) => item.id), ['oil', 'baby']);
  assert.equal(page.total_count, 5);
  assert.equal(page.has_more, true);
});

test('searches more than 5,000 SKUs without a blocking client operation', () => {
  const catalog = Array.from({ length: 5000 }, (_, index) => ({
    id: `bulk-${index}`,
    name: `Ingredient ${String(index).padStart(4, '0')}`,
    sku: `SKU-${String(index).padStart(5, '0')}`,
    category: 'General',
    is_active: true
  }));
  catalog.push(...cornCatalog.filter((item) => item.is_active));
  const startedAt = performance.now();
  const result = searchIngredientCatalog(catalog, { query: 'corn', limit: 20 });
  const elapsed = performance.now() - startedAt;
  assert.equal(result.indexed_count, 5005);
  assert.equal(result.total_count, 5);
  assert.ok(elapsed < 500, `Expected in-memory reference search below 500 ms, received ${elapsed.toFixed(1)} ms`);
});

test('supports highlight segments and keyboard selection', () => {
  assert.deepEqual(splitHighlightedIngredientText('Sweet Corn Frozen', 'corn'), [
    { text: 'Sweet ', match: false },
    { text: 'Corn', match: true },
    { text: ' Frozen', match: false }
  ]);
  assert.equal(moveIngredientPickerIndex(-1, 'ArrowDown', 3), 0);
  assert.equal(moveIngredientPickerIndex(0, 'ArrowUp', 3), 2);
  assert.deepEqual(resolveIngredientPickerKey('Enter', 1, cornCatalog), {
    action: 'select',
    activeIndex: 1,
    item: cornCatalog[1]
  });
  assert.equal(resolveIngredientPickerKey('Escape', 1, cornCatalog).action, 'close');
});

test('uses a debounced backend endpoint and PostgreSQL search indexes', () => {
  const componentSource = fs.readFileSync(new URL('../src/components/ingredients/IngredientSearchCombobox.jsx', import.meta.url), 'utf8');
  const apiSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const sqlSource = fs.readFileSync(new URL('../server/sql/init.sql', import.meta.url), 'utf8');
  assert.match(componentSource, /useDebouncedValue\(search, 250\)/);
  assert.match(componentSource, /base44\.ingredients\.search/);
  assert.match(componentSource, /shouldFilter=\{false\}/);
  assert.match(apiSource, /\/api\/ingredients\/search/);
  assert.match(sqlSource, /pg_trgm/);
  assert.match(sqlSource, /idx_entity_records_ingredient_search_document/);
});

test('uses the indexed picker in every ingredient-selection workflow', () => {
  const pickerConsumers = [
    '../src/components/recipes/RecipeForm.jsx',
    '../src/pages/FoodWaste.jsx',
    '../src/pages/Ingredients.jsx',
    '../src/pages/Inventory.jsx',
    '../src/pages/ProcurementModule.jsx',
    '../src/pages/ProductionTransfer.jsx',
    '../src/pages/CaloriesCalculator.jsx'
  ];
  pickerConsumers.forEach((relativePath) => {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /IngredientSearchCombobox/, `${relativePath} should use the indexed ingredient picker`);
  });
});

console.log('Ingredient search tests passed.');
