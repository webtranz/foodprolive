import assert from 'node:assert/strict';
import {
  createTemplateCsv,
  listUtilityModules,
  mapCsvRow,
  parseCsvLine,
  resolveBulkInventoryIngredient,
  resolveBulkInventoryStore,
  resolveBulkInventoryUnit,
  validateCsvHeaders
} from '../server/utilities.js';

assert.deepEqual(parseCsvLine('"Shrimp, frozen",43,"dairy|seafood"'), ['Shrimp, frozen', '43', 'dairy|seafood']);
assert.match(createTemplateCsv('recipes'), /^name,/);
assert.match(createTemplateCsv('ingredients'), /^item_code,name,/, 'ingredient templates put Item Code before Item Name');
assert.match(
  createTemplateCsv('inventory'),
  /^item_code,ingredient_name,site_id,site_name,ingredient_id,quantity,/,
  'inventory templates use Item Code as the first identifier while retaining ingredient_id'
);
assert.equal(listUtilityModules().some((module) => module.key === 'recipes'), true);
assert.deepEqual(validateCsvHeaders('recipes', ['recipe_code']), ['Missing required column: name']);
assert.deepEqual(validateCsvHeaders('inventory', ['item_code', 'quantity']), []);
assert.deepEqual(validateCsvHeaders('inventory', ['ingredient_id', 'quantity']), []);
assert.deepEqual(
  validateCsvHeaders('inventory', ['quantity']),
  ['Missing required column: item_code or ingredient_id']
);
assert.equal(
  mapCsvRow('inventory', ['item_code', 'quantity'], ['ITM-001', '12.5']).item_code,
  'ITM-001'
);
assert.throws(
  () => mapCsvRow('inventory', ['quantity'], ['12.5']),
  /item_code or ingredient_id is required/i
);

const recipe = mapCsvRow(
  'recipes',
  ['name', 'servings', 'image_url', 'allergens'],
  ['Secure Recipe', '4', 'https://cdn.example.com/recipes/secure.jpg', '["dairy"]']
);
assert.equal(recipe.name, 'Secure Recipe');
assert.equal(recipe.servings, 4);
assert.equal(recipe.image_url, 'https://cdn.example.com/recipes/secure.jpg');
assert.deepEqual(recipe.allergens, ['dairy']);
assert.throws(
  () => mapCsvRow('recipes', ['name', 'image_url'], ['Unsafe Recipe', 'http://example.com/image.jpg']),
  /HTTPS/
);

const inventorySites = [
  { id: 'area-1', name: 'West', type: 'area', is_active: true },
  { id: 'project-1', name: 'Jeddah Project', type: 'project', parent_site_id: 'area-1', is_active: true },
  { id: 'store-1', name: 'Jeddah Main Store', type: 'store', parent_site_id: 'project-1', is_active: true },
  { id: 'store-closed', name: 'Closed Store', type: 'store', parent_site_id: 'project-1', is_active: false }
];

const inventoryIngredients = [
  { id: 'ingredient-1', item_code: 'ITM-001', name: 'Corn Flour', unit: 'kg', is_active: true },
  { id: 'ingredient-2', ingredient_code: 'ITM-002', name: 'Corn Oil', unit: 'l', is_active: true },
  { id: 'ingredient-3', item_code: 'ITM-003', name: 'Inactive Corn', unit: 'kg', is_active: false }
];

assert.equal(resolveBulkInventoryIngredient({
  ingredients: inventoryIngredients,
  itemCode: ' itm-001 '
}).id, 'ingredient-1');
assert.equal(resolveBulkInventoryIngredient({
  ingredients: inventoryIngredients,
  ingredientId: 'ingredient-2'
}).id, 'ingredient-2');
assert.equal(resolveBulkInventoryIngredient({
  ingredients: inventoryIngredients,
  itemCode: 'ITM-001',
  ingredientId: 'ingredient-1'
}).id, 'ingredient-1');
assert.throws(
  () => resolveBulkInventoryIngredient({
    ingredients: inventoryIngredients,
    itemCode: 'ITM-002',
    ingredientId: 'ingredient-1'
  }),
  /does not match Ingredient ID/i
);
assert.throws(
  () => resolveBulkInventoryIngredient({
    ingredients: [...inventoryIngredients, { id: 'ingredient-4', sku: 'ITM-001', name: 'Duplicate' }],
    itemCode: 'ITM-001'
  }),
  /multiple ingredients/i
);
assert.throws(
  () => resolveBulkInventoryIngredient({ ingredients: inventoryIngredients, itemCode: 'ITM-999' }),
  /was not found/i
);
assert.throws(
  () => resolveBulkInventoryIngredient({ ingredients: inventoryIngredients, itemCode: 'ITM-003' }),
  /inactive/i
);

assert.equal(resolveBulkInventoryStore({
  sites: inventorySites,
  defaultSiteId: 'store-1'
}).id, 'store-1');
assert.equal(resolveBulkInventoryStore({
  sites: inventorySites,
  rowSiteName: 'Jeddah Main Store',
  defaultSiteId: 'store-closed'
}).id, 'store-1');
assert.throws(
  () => resolveBulkInventoryStore({
    sites: inventorySites,
    rowSiteId: 'missing-store',
    defaultSiteId: 'store-1'
  }),
  /uploaded row.*not found/i,
  'an invalid explicit row Store must never silently fall back to the default Store'
);
assert.throws(
  () => resolveBulkInventoryStore({ sites: inventorySites, defaultSiteId: 'project-1' }),
  /must be a Store/i
);
assert.throws(
  () => resolveBulkInventoryStore({ sites: inventorySites, defaultSiteId: 'store-closed' }),
  /inactive/i
);
assert.equal(resolveBulkInventoryUnit({ id: 'flour', name: 'Flour', unit: 'kg' }, 'kilograms'), 'kg');
assert.throws(
  () => resolveBulkInventoryUnit({ id: 'flour', name: 'Flour', unit: 'kg' }, 'l'),
  /canonical unit \(kg\)/i
);
assert.throws(
  () => resolveBulkInventoryUnit({ id: 'flour', name: 'Flour' }, ''),
  /no canonical inventory unit/i
);

console.log('Utilities template and CSV validation tests passed.');
