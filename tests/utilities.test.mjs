import assert from 'node:assert/strict';
import {
  buildIngredientPayloadFromInventoryUpload,
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
assert.deepEqual(validateCsvHeaders('ingredients', [
  'item_group',
  'ingredient_code',
  'sku',
  'ingredient_name',
  'unit',
  'unit_price',
  'cooking_yield_percent',
  'calories_per_100g',
  'allergens'
]), []);
assert.deepEqual(validateCsvHeaders('inventory', [
  'item_group',
  'item',
  'item_duplicate',
  'product_name',
  'unit',
  'site',
  'warehouse',
  'unit_price',
  'qty',
  'qty_duplicate',
  'amount'
]), []);
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

const suppliedIngredient = mapCsvRow(
  'ingredients',
  [
    'item_group',
    'ingredient_code',
    'sku',
    'ingredient_name',
    'unit',
    'unit_price',
    'cooking_yield_percent',
    'calories_per_100g',
    'allergens'
  ],
  ['GROCERY', '100749', '100749', 'KIKKOMAN SOY SAUCE LITE 12/10Z', 'EA', '14.5895826086957', '100', '90', 'soybeans']
);
assert.equal(suppliedIngredient.name, 'KIKKOMAN SOY SAUCE LITE 12/10Z');
assert.equal(suppliedIngredient.item_code, '100749');
assert.equal(suppliedIngredient.ingredient_code, '100749');
assert.equal(suppliedIngredient.sku, '100749');
assert.equal(suppliedIngredient.category, 'GROCERY');
assert.equal(suppliedIngredient.cost_per_unit, 14.5895826086957);
assert.equal(suppliedIngredient.cooking_yield_percent, 100);
assert.equal(suppliedIngredient.calories_per_100g, 90);
assert.deepEqual(suppliedIngredient.allergens, ['soybeans']);
const packedIngredient = mapCsvRow(
  'ingredients',
  ['item_code', 'name', 'unit', 'cost_per_unit'],
  ['GR000042', 'SHAN RED CHILLI POWDER 10/1KG', 'EA', '19.002124']
);
assert.equal(packedIngredient.package_base_quantity, 1);
assert.equal(packedIngredient.package_base_unit, 'kg');
assert.equal(packedIngredient.package_pack_count, 10);
assert.deepEqual(
  mapCsvRow('ingredients', ['ingredient_name', 'allergens'], ['No Allergen Item', 'none']).allergens,
  []
);
const compactNutritionIngredient = mapCsvRow(
  'ingredients',
  ['item', 'product_name', 'unit', 'unit_price', 'CAL.', 'PROTIEN', 'CAR', 'YIELD', 'allergens'],
  ['NUT-001', 'Mapped Nutrition Item', 'kg', '7.5', '210', '12.4', '33.1', '88', 'gluten,dairy']
);
assert.equal(compactNutritionIngredient.item_code, 'NUT-001');
assert.equal(compactNutritionIngredient.name, 'Mapped Nutrition Item');
assert.equal(compactNutritionIngredient.cost_per_unit, 7.5);
assert.equal(compactNutritionIngredient.calories_per_100g, 210);
assert.equal(compactNutritionIngredient.protein_per_100g, 12.4);
assert.equal(compactNutritionIngredient.carbs_per_100g, 33.1);
assert.equal(compactNutritionIngredient.cooking_yield_percent, 88);
assert.deepEqual(compactNutritionIngredient.allergens, ['gluten', 'dairy']);

const suppliedInventory = mapCsvRow(
  'inventory',
  [
    'item_group',
    'item',
    'item_duplicate',
    'product_name',
    'unit',
    'site',
    'warehouse',
    'unit_price',
    'qty',
    'qty_duplicate',
    'amount'
  ],
  ['GROCERY', '100749', '100749', 'KIKKOMAN SOY SAUCE LITE 12/10Z', 'EA', 'KBR', 'KBR-384', '14.5895826086957', '23', '23', '335.5604']
);
assert.equal(suppliedInventory.item_code, '100749');
assert.equal(suppliedInventory.ingredient_name, 'KIKKOMAN SOY SAUCE LITE 12/10Z');
assert.equal(suppliedInventory.site_name, undefined);
assert.equal(suppliedInventory.site_id, undefined);
assert.equal(suppliedInventory.unit_cost, 14.5895826086957);
assert.equal(suppliedInventory.quantity, 23);
assert.equal(suppliedInventory.source_quantity, 23);
assert.equal(suppliedInventory.source_amount, 335.5604);
assert.equal(suppliedInventory.source_item_duplicate, '100749');
assert.equal(suppliedInventory.source_item_group, 'GROCERY');
assert.equal(suppliedInventory.source_site, 'KBR');
assert.equal(suppliedInventory.source_warehouse, 'KBR-384');
assert.deepEqual(
  buildIngredientPayloadFromInventoryUpload(suppliedInventory),
  {
    item_code: '100749',
    ingredient_code: '100749',
    sku: '100749',
    name: 'KIKKOMAN SOY SAUCE LITE 12/10Z',
    unit: 'EA',
    category: 'GROCERY',
    cost_per_unit: 14.5895826086957,
    package_pack_count: 12,
    package_inner_count: 1,
    package_size_quantity: 10,
    package_size_unit: 'oz',
    package_base_quantity: 0.28349523,
    package_base_unit: 'kg',
    package_parse_source: 'item_name_package',
    source_name: 'D365',
    is_active: true,
    allergens: []
  }
);
const packedInventoryIngredient = buildIngredientPayloadFromInventoryUpload(mapCsvRow(
  'inventory',
  ['item_code', 'ingredient_name', 'quantity', 'unit', 'unit_cost'],
  ['166780', 'TAFGA REHAN SALT IODIZED 24/700G', '12', 'EA', '0.79']
));
assert.equal(packedInventoryIngredient.package_base_quantity, 0.7);
assert.equal(packedInventoryIngredient.package_base_unit, 'kg');
assert.equal(packedInventoryIngredient.package_pack_count, 24);

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
