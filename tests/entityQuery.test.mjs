import assert from 'node:assert/strict';

import { listDocuments, listDocumentsPage } from '../server/db.js';

function createCapturingExecutor(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, parameters) {
      calls.push({ text, parameters });
      return {
        rows,
        rowCount: rows.length
      };
    }
  };
}

const pagedExecutor = createCapturingExecutor([]);
const paged = await listDocumentsPage('Production', {
  filters: {
    production_date: '2026-08-16',
    status: 'approved'
  },
  rangeFilters: {
    production_date: { gte: '2026-08-01', lte: '2026-08-31' }
  },
  sort: '-production_date',
  limit: 50,
  offset: 100,
  location: { unrestricted: false, accessibleSiteIds: ['site-1', 'site-2'] }
}, pagedExecutor);

assert.equal(paged.total_count, 0);
assert.equal(paged.limit, 50);
assert.equal(paged.offset, 100);
assert.ok(pagedExecutor.calls.length >= 1);
const pagedQuery = pagedExecutor.calls[0];
assert.match(pagedQuery.text, /COUNT\(\*\) OVER\(\) AS total_count/);
assert.match(pagedQuery.text, /FROM production_events event\) normalized_record/);
assert.match(pagedQuery.text, /normalized_record\.production_date >= \$\d+/);
assert.match(pagedQuery.text, /normalized_record\.production_date <= \$\d+/);
assert.match(pagedQuery.text, /normalized_record\.warehouse_id = ANY\(\$\d+::text\[\]\)/);
assert.match(pagedQuery.text, /ORDER BY normalized_record\.production_date DESC/);
assert.match(pagedQuery.text, /LIMIT \$\d+::integer/);
assert.match(pagedQuery.text, /OFFSET \$\d+::integer/);
assert.doesNotMatch(pagedQuery.text, /entity_records|record\.data|jsonb_array_elements_text/);
assert.ok(pagedQuery.parameters.includes('2026-08-16'));
assert.ok(pagedQuery.parameters.includes('approved'));
assert.ok(pagedQuery.parameters.includes('2026-08-01'));
assert.ok(pagedQuery.parameters.includes('2026-08-31'));
assert.deepEqual(pagedQuery.parameters.find(Array.isArray), ['site-1', 'site-2']);
assert.equal(pagedQuery.parameters.at(-2), 50);
assert.equal(pagedQuery.parameters.at(-1), 100);

const inventoryExecutor = createCapturingExecutor([{
  inventory_id: 'inventory-1',
  warehouse_id: 'site-384',
  ingredient_id: 'ing-1',
  ingredient_name: 'Rice',
  stock_unit: 'kg',
  available_quantity: 10,
  reserved_quantity: 0,
  on_hand_quantity: 10,
  status: 'active'
}]);
await listDocuments('Inventory', {
  filters: { ingredient_id: 'ing-1', site_id: 'site-384' },
  sort: 'ingredient_id',
  limit: 25,
  lock: true
}, inventoryExecutor);
assert.match(inventoryExecutor.calls[0].text, /FROM \(SELECT inventory\.\*/);
assert.match(inventoryExecutor.calls[0].text, /LEFT JOIN warehouses warehouse/);
assert.match(inventoryExecutor.calls[0].text, /LEFT JOIN ingredients ingredient/);
assert.match(inventoryExecutor.calls[0].text, /ingredient\.name AS ingredient_name/);
assert.match(inventoryExecutor.calls[0].text, /normalized_record\.ingredient_id/);
assert.match(inventoryExecutor.calls[0].text, /normalized_record\.warehouse_id/);
assert.doesNotMatch(inventoryExecutor.calls[0].text, /FOR UPDATE/);
assert.doesNotMatch(inventoryExecutor.calls[0].text, /entity_records|record\.data/);
assert.deepEqual(inventoryExecutor.calls[0].parameters.slice(0, 2), ['ing-1', 'site-384']);
assert.match(inventoryExecutor.calls[1].text, /SELECT inventory_id FROM warehouse_inventory WHERE inventory_id = ANY\(\$1::text\[\]\) FOR UPDATE/);
assert.deepEqual(inventoryExecutor.calls[1].parameters, [['inventory-1']]);

const recipeExecutor = createCapturingExecutor([{
  recipe_version_id: 'recipe-v1',
  recipe_id: 'recipe-master',
  canonical_name: 'Chicken dish',
  description: 'Test recipe',
  display_name: 'Chicken dish',
  recipe_code: 'RCP-CHICKEN',
  recipe_type: 'full',
  cuisine_type: 'General',
  menu_category: 'Main Course',
  costing_method: 'last_cost',
  servings: '12',
  prep_time_minutes: 15,
  cook_time_minutes: 45,
  instructions: 'Cook until done.',
  image_url: '/files/recipe-images/chicken.webp',
  serving_size_grams: 150,
  batch_yield: '2',
  total_recipe_weight_grams: '300',
  total_cost: '10',
  cost_per_serving: '5',
  calories_per_serving: '120',
  declared_allergens: ['egg'],
  warehouse_id: 'site-384',
  project_id: null,
  area_id: null,
  status: 'active',
  source_name: 'D365',
  created_at: '2026-09-28T00:00:00.000Z',
  updated_at: '2026-09-28T00:00:00.000Z',
  ingredients: [{
    recipe_line_id: 'recipe-v1:line:1',
    ingredient_id: 'ingredient-189015',
    item_code: '189015',
    ingredient_code: '189015',
    sku: '189015',
    ingredient_name: 'TAFGA LOCAL TANMIAH CHICKEN 10/900G',
    line_number: 1,
    quantity: '150',
    unit: 'g',
    yield_percent: '100',
    cost: '1.97'
  }]
}]);
const recipes = await listDocuments('Recipe', { sort: 'name', limit: 10 }, recipeExecutor);
assert.match(recipeExecutor.calls[0].text, /FROM recipe_ingredient_lines line/);
assert.match(recipeExecutor.calls[0].text, /LEFT JOIN ingredients ingredient/);
assert.equal(recipes[0].site_scope, 'specific');
assert.deepEqual(recipes[0].site_ids, ['site-384']);
assert.equal(recipes[0].servings, 12);
assert.equal(recipes[0].batch_yield, 2);
assert.equal(recipes[0].costing_method, 'last_cost');
assert.equal(recipes[0].prep_time_minutes, 15);
assert.equal(recipes[0].cook_time_minutes, 45);
assert.equal(recipes[0].instructions, 'Cook until done.');
assert.equal(recipes[0].image_url, '/files/recipe-images/chicken.webp');
assert.equal(recipes[0].calories_per_serving, 120);
assert.deepEqual(recipes[0].declared_allergens, ['egg']);
assert.equal(recipes[0].ingredients.length, 1);
assert.equal(recipes[0].ingredients[0].ingredient_id, 'ingredient-189015');
assert.equal(recipes[0].ingredients[0].item_code, '189015');
assert.equal(recipes[0].ingredients[0].ingredient_name, 'TAFGA LOCAL TANMIAH CHICKEN 10/900G');
assert.equal(recipes[0].ingredients[0].quantity, 150);
assert.equal(recipes[0].ingredients[0].unit, 'g');

await assert.rejects(
  () => listDocuments('EmailLog', {}, createCapturingExecutor()),
  /EmailLog is not backed by normalized relational storage/
);

console.log('Normalized entity SQL query tests passed.');
