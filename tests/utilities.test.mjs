import assert from 'node:assert/strict';
import {
  buildIngredientPayloadFromInventoryUpload,
  createTemplateCsv,
  groupBulkUploadRows,
  listUtilityModules,
  mapCsvRow,
  parseCsvLine,
  resolveBulkInventoryIngredient,
  resolveBulkInventoryStore,
  resolveBulkInventoryUnit,
  validateCsvHeaders
} from '../server/utilities.js';

assert.deepEqual(parseCsvLine('"Shrimp, frozen",43,"dairy|seafood"'), ['Shrimp, frozen', '43', 'dairy|seafood']);
const templateHeaders = (moduleKey) => createTemplateCsv(moduleKey).trim().split(',');

const recipeTemplateHeaders = templateHeaders('recipes');
assert.equal(recipeTemplateHeaders[0], 'recipe_code');
assert.equal(recipeTemplateHeaders.includes('ingredients'), false, 'recipe templates use relational ingredient line columns');
assert.equal(recipeTemplateHeaders.includes('sub_recipes'), false, 'recipe templates do not expose nested sub_recipe JSON');
assert.equal(recipeTemplateHeaders.includes('line_number'), true);
assert.equal(recipeTemplateHeaders.includes('ingredient_id'), true);
assert.equal(recipeTemplateHeaders.includes('line_quantity'), true);

const menuPlanTemplateHeaders = templateHeaders('menu-plans');
assert.equal(menuPlanTemplateHeaders.includes('meals'), false, 'menu plan templates use relational menu_plan line columns');
assert.equal(menuPlanTemplateHeaders.includes('line_number'), true);
assert.equal(menuPlanTemplateHeaders.includes('recipe_id'), true);
assert.equal(menuPlanTemplateHeaders.includes('expected_servings'), true);
assert.equal(menuPlanTemplateHeaders.includes('planned_quantity'), true);
assert.equal(menuPlanTemplateHeaders.includes('planned_quantity_unit'), true);
assert.equal(menuPlanTemplateHeaders.includes('planned_weight_kg'), true);

const productionTemplateHeaders = templateHeaders('production');
assert.equal(productionTemplateHeaders.includes('ingredients_used'), false, 'production templates use relational manifest line columns');
assert.equal(productionTemplateHeaders.includes('line_number'), true);
assert.equal(productionTemplateHeaders.includes('menu_plan_line_id'), true);
assert.equal(productionTemplateHeaders.includes('requested_weight_kg'), true);
assert.equal(productionTemplateHeaders.includes('produced_weight_kg'), true);

const materialRequestTemplateHeaders = templateHeaders('material-requests');
assert.equal(materialRequestTemplateHeaders.includes('items'), false, 'MR to Store templates use relational item line columns');
assert.equal(materialRequestTemplateHeaders.includes('line_number'), true);
assert.equal(materialRequestTemplateHeaders.includes('ingredient_id'), true);
assert.equal(materialRequestTemplateHeaders.includes('request_quantity'), true);

const foodWasteTemplateHeaders = templateHeaders('food-waste');
assert.equal(foodWasteTemplateHeaders.includes('output_allocations'), false, 'food waste templates use relational waste line columns');
assert.equal(foodWasteTemplateHeaders.includes('line_number'), true);
assert.equal(foodWasteTemplateHeaders.includes('menu_category'), true);
assert.equal(foodWasteTemplateHeaders.includes('waste_weight_grams'), true);
assert.equal(foodWasteTemplateHeaders.includes('evidence_image_urls'), true);

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
assert.deepEqual(
  mapCsvRow('ingredients', ['ingredient_name', 'allergens'], ['Malformed Allergen Item', '[""milk""]|fish|["mollusc"]']).allergens,
  ['milk', 'fish', 'mollusc']
);
assert.deepEqual(
  mapCsvRow('recipes', ['name', 'allergens'], ['Boiled Eggs', '[""egg""]']).allergens,
  ['egg']
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

const relationalRecipeLine = mapCsvRow(
  'recipes',
  ['recipe_code', 'name', 'menu_category', 'line_number', 'ingredient_id', 'ingredient_name', 'line_quantity', 'line_unit', 'line_yield_percent', 'line_raw_weight_grams', 'line_cost'],
  ['RCP-001', 'Boiled Eggs', 'junior', '2', 'ing-egg', 'Fresh Eggs', '12', 'EA', '100', '720', '14.5']
);
assert.equal(relationalRecipeLine.recipe_code, 'RCP-001');
assert.equal(relationalRecipeLine.category, 'junior');
assert.deepEqual(relationalRecipeLine.ingredients, [
  {
    line_number: 2,
    ingredient_id: 'ing-egg',
    ingredient_name: 'Fresh Eggs',
    name: 'Fresh Eggs',
    quantity: 12,
    unit: 'EA',
    yield_percent: 100,
    raw_weight_grams: 720,
    cost: 14.5
  }
]);

const relationalMenuPlanLine = mapCsvRow(
  'menu-plans',
  ['site_id', 'plan_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'line_type', 'recipe_code', 'recipe_name', 'expected_servings', 'planned_quantity', 'planned_quantity_unit', 'planned_weight_kg', 'estimated_cost'],
  ['store-1', '2026-09-01', 'Breakfast', 'General', 'Junior', '1', 'recipe', 'RCP-001', 'Boiled Eggs', '280', '40', 'pak', '39.159', '121.43']
);
assert.equal(relationalMenuPlanLine.cuisine_type, 'general');
assert.equal(relationalMenuPlanLine.menu_category, 'junior');
assert.deepEqual(relationalMenuPlanLine.menu_plan_lines, [
  {
    line_number: 1,
    line_type: 'recipe',
    recipe_code: 'RCP-001',
    recipe_name: 'Boiled Eggs',
    item_name: 'Boiled Eggs',
    meal_type: 'Breakfast',
    expected_servings: 280,
    planned_servings: 280,
    planned_quantity: 40,
    planned_quantity_unit: 'pak',
    planned_weight_grams: 39159,
    estimated_cost: 121.43
  }
]);
assert.deepEqual(relationalMenuPlanLine.meals, [
  {
    meal_type: 'Breakfast',
    recipe_code: 'RCP-001',
    recipe_name: 'Boiled Eggs',
    expected_servings: 280,
    planned_quantity: 40,
    planned_quantity_unit: 'pak',
    planned_weight_grams: 39159,
    total_cost: 121.43
  }
]);

const groupedMenuPlanRows = groupBulkUploadRows('menu-plans', [
  {
    rowNumber: 4,
    payload: mapCsvRow(
      'menu-plans',
      ['site_id', 'plan_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'recipe_code', 'recipe_name', 'expected_servings'],
      ['store-1', '2026-09-01', 'Breakfast', 'General', 'Labor', '1', 'RCP-LAB', 'Labor Breakfast', '120']
    )
  },
  {
    rowNumber: 5,
    payload: mapCsvRow(
      'menu-plans',
      ['site_id', 'plan_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'recipe_code', 'recipe_name', 'expected_servings'],
      ['store-1', '2026-09-01', 'Breakfast', 'General', 'Junior', '1', 'RCP-JUN', 'Junior Breakfast', '80']
    )
  }
]);
assert.equal(groupedMenuPlanRows.length, 2);
assert.deepEqual(
  groupedMenuPlanRows.map((row) => row.payload.menu_category).sort(),
  ['junior', 'labor']
);

const groupedDailyMenuPlanRows = groupBulkUploadRows('menu-plans', [
  {
    rowNumber: 10,
    payload: mapCsvRow(
      'menu-plans',
      ['site_id', 'plan_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'recipe_code', 'recipe_name', 'expected_servings'],
      ['384', '2026-09-01', 'Breakfast', 'General', 'Labor', '1', 'RCP-BF', 'Labor Breakfast', '120']
    )
  },
  {
    rowNumber: 11,
    payload: mapCsvRow(
      'menu-plans',
      ['site_id', 'plan_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'recipe_code', 'recipe_name', 'expected_servings'],
      ['384', '2026-09-01', 'Lunch', 'General', 'Labor', '2', 'RCP-LN', 'Labor Lunch', '120']
    )
  },
  {
    rowNumber: 12,
    payload: mapCsvRow(
      'menu-plans',
      ['site_id', 'plan_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'recipe_code', 'recipe_name', 'expected_servings'],
      ['384', '2026-09-01', 'Dinner', 'General', 'Labor', '3', 'RCP-DN', 'Labor Dinner', '120']
    )
  }
]);
assert.equal(groupedDailyMenuPlanRows.length, 1);
assert.deepEqual(
  groupedDailyMenuPlanRows[0].payload.meals.map((meal) => meal.meal_type),
  ['Breakfast', 'Lunch', 'Dinner']
);

const relationalProductionLine = mapCsvRow(
  'production',
  ['site_id', 'production_date', 'meal_type', 'menu_type', 'menu_category', 'line_number', 'menu_plan_line_id', 'recipe_code', 'recipe_name', 'requested_servings', 'requested_weight_kg', 'produced_weight_kg', 'estimated_cost'],
  ['store-1', '2026-09-01', 'Breakfast', 'General', 'Junior', '1', 'mpl-1', 'RCP-001', 'Boiled Eggs', '280', '40', '39.159', '121.43']
);
assert.equal(relationalProductionLine.menu_type, 'general');
assert.equal(relationalProductionLine.menu_category, 'junior');
assert.deepEqual(relationalProductionLine.manifest_lines, [
  {
    line_number: 1,
    menu_plan_line_id: 'mpl-1',
    recipe_code: 'RCP-001',
    recipe_name: 'Boiled Eggs',
    item_name: 'Boiled Eggs',
    requested_servings: 280,
    requested_weight_grams: 40000,
    produced_weight_grams: 39159,
    estimated_cost: 121.43
  }
]);

const relationalMaterialRequestLine = mapCsvRow(
  'material-requests',
  ['site_id', 'request_number', 'request_date', 'line_number', 'item_code', 'ingredient_name', 'required_quantity', 'current_stock', 'shortage_quantity', 'request_quantity', 'unit', 'estimated_cost'],
  ['store-1', 'MR-001', '2026-09-01', '1', 'ING-001', 'Rice', '20', '5', '15', '15', 'kg', '75']
);
assert.deepEqual(relationalMaterialRequestLine.items, [
  {
    line_number: 1,
    item_code: 'ING-001',
    ingredient_name: 'Rice',
    required_quantity: 20,
    current_stock: 5,
    shortage_quantity: 15,
    request_quantity: 15,
    unit: 'kg',
    estimated_cost: 75
  }
]);

const groupedMaterialRequestRows = groupBulkUploadRows('material-requests', [
  {
    rowNumber: 7,
    payload: mapCsvRow(
      'material-requests',
      ['site_id', 'request_number', 'line_number', 'item_code', 'ingredient_name', 'request_quantity', 'unit', 'estimated_cost'],
      ['store-1', 'MR-GROUP', '2', 'ING-SALT', 'Salt', '1', 'kg', '2']
    )
  },
  {
    rowNumber: 8,
    payload: mapCsvRow(
      'material-requests',
      ['site_id', 'request_number', 'line_number', 'item_code', 'ingredient_name', 'request_quantity', 'unit', 'estimated_cost'],
      ['store-1', 'MR-GROUP', '1', 'ING-RICE', 'Rice', '15', 'kg', '75']
    )
  }
]);
assert.equal(groupedMaterialRequestRows.length, 1);
assert.deepEqual(groupedMaterialRequestRows[0].payload.items.map((line) => line.ingredient_name), ['Rice', 'Salt']);
assert.equal(groupedMaterialRequestRows[0].payload.total_estimated_cost, 77);

const relationalFoodWasteLine = mapCsvRow(
  'food-waste',
  ['site_id', 'waste_date', 'meal_type', 'menu_type', 'menu_category', 'waste_category', 'waste_scope', 'source_type', 'line_number', 'recipe_id', 'recipe_name', 'waste_weight_grams', 'unit', 'estimated_cost', 'evidence_image_urls'],
  ['store-1', '2026-09-01', 'Breakfast', 'General', 'Junior', 'batch_overproduction', 'batch', 'batch_overproduction', '1', 'recipe-egg', 'Boiled Eggs', '950', 'g', '0.91', '/uploads/a.jpg|/uploads/b.jpg']
);
assert.equal(relationalFoodWasteLine.menu_category, 'Junior');
assert.equal(relationalFoodWasteLine.quantity, 950);
assert.equal(relationalFoodWasteLine.unit, 'g');
assert.deepEqual(relationalFoodWasteLine.evidence_image_urls, ['/uploads/a.jpg', '/uploads/b.jpg']);
assert.deepEqual(relationalFoodWasteLine.output_allocations, [
  {
    line_number: 1,
    recipe_id: 'recipe-egg',
    recipe_name: 'Boiled Eggs',
    item_name: 'Boiled Eggs',
    waste_weight_grams: 950,
    cost: 0.91
  }
]);

const groupedFoodWasteRows = groupBulkUploadRows('food-waste', [
  {
    rowNumber: 9,
    payload: mapCsvRow(
      'food-waste',
      ['site_id', 'waste_date', 'meal_type', 'menu_type', 'menu_category', 'waste_category', 'waste_scope', 'source_type', 'line_number', 'recipe_name', 'waste_weight_grams', 'unit'],
      ['store-1', '2026-09-01', 'Breakfast', 'General', 'Junior', 'batch_overproduction', 'batch', 'batch_overproduction', '2', 'Oatmeal', '500', 'g']
    )
  },
  {
    rowNumber: 10,
    payload: mapCsvRow(
      'food-waste',
      ['site_id', 'waste_date', 'meal_type', 'menu_type', 'menu_category', 'waste_category', 'waste_scope', 'source_type', 'line_number', 'recipe_name', 'waste_weight_grams', 'unit'],
      ['store-1', '2026-09-01', 'Breakfast', 'General', 'Junior', 'batch_overproduction', 'batch', 'batch_overproduction', '1', 'Boiled Eggs', '950', 'g']
    )
  }
]);
assert.equal(groupedFoodWasteRows.length, 1);
assert.deepEqual(groupedFoodWasteRows[0].payload.output_allocations.map((line) => line.recipe_name), ['Boiled Eggs', 'Oatmeal']);
assert.equal(groupedFoodWasteRows[0].payload.quantity, 1450);
assert.equal(groupedFoodWasteRows[0].payload.unit, 'g');

const groupedRecipeRows = groupBulkUploadRows('recipes', [
  {
    rowNumber: 2,
    payload: mapCsvRow(
      'recipes',
      ['recipe_code', 'name', 'line_number', 'ingredient_name', 'line_quantity', 'line_unit'],
      ['RCP-GROUP', 'Grouped Recipe', '2', 'Salt', '1', 'g']
    )
  },
  {
    rowNumber: 3,
    payload: mapCsvRow(
      'recipes',
      ['recipe_code', 'name', 'line_number', 'ingredient_name', 'line_quantity', 'line_unit'],
      ['RCP-GROUP', 'Grouped Recipe', '1', 'Water', '2', 'l']
    )
  }
]);
assert.equal(groupedRecipeRows.length, 1);
assert.deepEqual(groupedRecipeRows[0].rowNumbers, [2, 3]);
assert.equal(groupedRecipeRows[0].sourceRowCount, 2);
assert.deepEqual(groupedRecipeRows[0].payload.ingredients.map((line) => line.ingredient_name), ['Water', 'Salt']);

const encodedAllergenRecipe = mapCsvRow(
  'recipes',
  ['name', 'allergens'],
  ['Encoded Allergen Recipe', '"[\\"fish\\"]"']
);
assert.deepEqual(encodedAllergenRecipe.allergens, ['fish']);

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
