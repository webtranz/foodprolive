import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { pool, initDatabase } from '../server/db.js';

const nowIso = () => new Date().toISOString();
const today = new Date().toISOString().slice(0, 10);
const id = (prefix, key) => `${prefix}_${key}`;

const RESET_ENTITIES = [
  'Site',
  'Ingredient',
  'Recipe',
  'Inventory',
  'InventoryLot',
  'InventoryTransaction',
  'Production',
  'ProductionBatch',
  'ProductionTransfer',
  'MaterialRequest',
  'FoodWaste',
  'BranchOrder',
  'QualityControl',
  'PurchaseOrder',
  'ERPIntegrationLog',
  'ForecastSnapshot'
];

const camps = [
  {
    key: 'abqaiq',
    name: 'ABQAIQ CAMP',
    project_code: 'ABQ',
    city: 'Abqaiq',
    warehouse: 'ABQAIQ CAMP WAREHOUSE'
  },
  {
    key: 'modon',
    name: 'MODON CAMP',
    project_code: 'MOD',
    city: 'Dammam',
    warehouse: 'MODON CAMP WAREHOUSE'
  }
];

const ingredients = [
  ['ing_basmati_rice', 'Basmati Rice', 'kg', 'Grains', 5.6, 365, 7.1, 80, 0.7, 5, 0.1, 2, []],
  ['ing_chicken_boneless', 'Boneless Chicken', 'kg', 'Protein', 18.5, 165, 31, 0, 3.6, 74, 0, 6, []],
  ['ing_mutton', 'Mutton Cubes', 'kg', 'Protein', 42, 294, 25, 0, 21, 72, 0, 8, []],
  ['ing_beef_mince', 'Beef Mince', 'kg', 'Protein', 31, 250, 26, 0, 15, 72, 0, 7, []],
  ['ing_penne_pasta', 'Penne Pasta', 'kg', 'Grains', 7.4, 371, 13, 75, 1.5, 6, 2.7, 1, ['gluten']],
  ['ing_spaghetti', 'Spaghetti', 'kg', 'Grains', 7.2, 371, 13, 75, 1.5, 6, 2.7, 1, ['gluten']],
  ['ing_tomato_puree', 'Tomato Puree', 'kg', 'Vegetables', 6.2, 38, 1.6, 8.8, 0.2, 28, 4.8, 4, []],
  ['ing_onion', 'Onion', 'kg', 'Vegetables', 2.4, 40, 1.1, 9.3, 0.1, 4, 4.2, 5, []],
  ['ing_potato', 'Potato', 'kg', 'Vegetables', 3.1, 77, 2, 17, 0.1, 6, 0.8, 6, []],
  ['ing_mixed_veg', 'Mixed Vegetables', 'kg', 'Vegetables', 4.8, 65, 3, 11, 0.5, 45, 4, 5, []],
  ['ing_capsicum', 'Capsicum', 'kg', 'Vegetables', 6.8, 31, 1, 6, 0.3, 4, 4.2, 4, []],
  ['ing_lettuce', 'Lettuce', 'kg', 'Vegetables', 9.5, 15, 1.4, 2.9, 0.2, 28, 0.8, 3, []],
  ['ing_carrot', 'Carrot', 'kg', 'Vegetables', 3.6, 41, 0.9, 10, 0.2, 69, 4.7, 4, []],
  ['ing_cucumber', 'Cucumber', 'kg', 'Vegetables', 3.2, 15, 0.7, 3.6, 0.1, 2, 1.7, 3, []],
  ['ing_yogurt', 'Yogurt', 'kg', 'Dairy', 7.9, 61, 3.5, 4.7, 3.3, 46, 4.7, 2, ['dairy']],
  ['ing_cream', 'Cooking Cream', 'l', 'Dairy', 18, 340, 2, 3, 36, 38, 3, 1, ['dairy']],
  ['ing_mozzarella', 'Mozzarella Cheese', 'kg', 'Dairy', 24, 280, 28, 3, 17, 627, 1, 1, ['dairy']],
  ['ing_parmesan', 'Parmesan Cheese', 'kg', 'Dairy', 48, 431, 38, 4, 29, 1529, 1, 1, ['dairy']],
  ['ing_flour', 'All Purpose Flour', 'kg', 'Bakery', 4, 364, 10, 76, 1, 2, 0.3, 1, ['gluten']],
  ['ing_egg', 'Eggs', 'pieces', 'Protein', 0.78, 155, 13, 1.1, 11, 124, 1.1, 0, ['eggs']],
  ['ing_bread_crumbs', 'Bread Crumbs', 'kg', 'Bakery', 8.5, 395, 13, 72, 5, 732, 6, 1, ['gluten']],
  ['ing_olive_oil', 'Olive Oil', 'l', 'Oil', 22, 884, 0, 0, 100, 2, 0, 0, []],
  ['ing_ghee', 'Ghee', 'kg', 'Oil', 29, 900, 0, 0, 100, 2, 0, 0, ['dairy']],
  ['ing_butter', 'Butter', 'kg', 'Dairy', 26, 717, 0.9, 0.1, 81, 11, 0.1, 0, ['dairy']],
  ['ing_ginger_garlic', 'Ginger Garlic Paste', 'kg', 'Spices', 9.5, 160, 4, 30, 1, 45, 2, 1, []],
  ['ing_biryani_masala', 'Biryani Masala', 'kg', 'Spices', 18, 320, 10, 55, 9, 2500, 3, 0, []],
  ['ing_garam_masala', 'Garam Masala', 'kg', 'Spices', 20, 325, 12, 58, 8, 120, 2, 0, []],
  ['ing_italian_herbs', 'Italian Herbs', 'kg', 'Spices', 35, 270, 9, 60, 5, 180, 2, 0, []],
  ['ing_white_sauce_mix', 'White Sauce Mix', 'kg', 'Dry Mix', 16, 420, 9, 72, 9, 900, 8, 1, ['dairy', 'gluten']],
  ['ing_chicken_stock', 'Chicken Stock', 'l', 'Condiments', 6.5, 15, 1, 1, 0.5, 410, 0, 0, []],
  ['ing_salt', 'Salt', 'kg', 'Spices', 1.1, 0, 0, 0, 0, 38758, 0, 0, []],
  ['ing_black_pepper', 'Black Pepper', 'kg', 'Spices', 34, 251, 10, 64, 3.3, 20, 0.6, 0, []]
].map(([idValue, name, unit, category, cost, calories, protein, carbs, fat, sodium, sugar, shrinkage, allergens]) => ({
  id: idValue,
  name,
  unit,
  category,
  cuisine_type: '',
  cost_per_unit: cost,
  calories_per_100g: calories,
  protein_per_100g: protein,
  carbs_per_100g: carbs,
  fat_per_100g: fat,
  sodium_per_100g: sodium,
  sugar_per_100g: sugar,
  cooking_yield_percent: Math.max(80, 100 - shrinkage),
  shrinkage_percent: shrinkage,
  raw_weight_per_unit: unit === 'pieces' ? 0.06 : 1,
  cooked_weight_per_unit: unit === 'pieces' ? 0.05 : Math.max(0.8, 1 - shrinkage / 100),
  allergens,
  is_active: true
}));

const recipesByCamp = {
  abqaiq: [
    recipe('abq_desi_1', 'ABQAIQ Chicken Biryani', 'Desi', 'lunch', 100, [
      ['ing_basmati_rice', 12, 'kg'], ['ing_chicken_boneless', 18, 'kg'], ['ing_onion', 6, 'kg'], ['ing_yogurt', 5, 'kg'], ['ing_ghee', 3, 'kg'], ['ing_biryani_masala', 1.2, 'kg'], ['ing_ginger_garlic', 1.4, 'kg'], ['ing_salt', 0.45, 'kg']
    ]),
    recipe('abq_desi_2', 'ABQAIQ Mutton Karahi', 'Desi', 'dinner', 100, [
      ['ing_mutton', 22, 'kg'], ['ing_tomato_puree', 9, 'kg'], ['ing_onion', 7, 'kg'], ['ing_ghee', 2.5, 'kg'], ['ing_ginger_garlic', 1.5, 'kg'], ['ing_garam_masala', 0.9, 'kg'], ['ing_salt', 0.35, 'kg']
    ]),
    recipe('abq_italian_1', 'ABQAIQ Penne Arrabbiata', 'Italian', 'lunch', 100, [
      ['ing_penne_pasta', 13, 'kg'], ['ing_tomato_puree', 10, 'kg'], ['ing_olive_oil', 2, 'l'], ['ing_onion', 4, 'kg'], ['ing_capsicum', 5, 'kg'], ['ing_italian_herbs', 0.55, 'kg'], ['ing_parmesan', 1.5, 'kg'], ['ing_salt', 0.25, 'kg']
    ]),
    recipe('abq_italian_2', 'ABQAIQ Chicken Alfredo Pasta', 'Italian', 'dinner', 100, [
      ['ing_spaghetti', 12, 'kg'], ['ing_chicken_boneless', 14, 'kg'], ['ing_cream', 8, 'l'], ['ing_white_sauce_mix', 3, 'kg'], ['ing_mozzarella', 4, 'kg'], ['ing_butter', 1.8, 'kg'], ['ing_italian_herbs', 0.35, 'kg'], ['ing_salt', 0.22, 'kg']
    ]),
    recipe('abq_cont_1', 'ABQAIQ Grilled Chicken with Vegetables', 'Continental', 'dinner', 100, [
      ['ing_chicken_boneless', 20, 'kg'], ['ing_mixed_veg', 15, 'kg'], ['ing_potato', 12, 'kg'], ['ing_olive_oil', 2.5, 'l'], ['ing_black_pepper', 0.35, 'kg'], ['ing_chicken_stock', 4, 'l'], ['ing_salt', 0.28, 'kg']
    ])
  ],
  modon: [
    recipe('mod_desi_1', 'MODON Beef Keema Masala', 'Desi', 'lunch', 100, [
      ['ing_beef_mince', 20, 'kg'], ['ing_onion', 7, 'kg'], ['ing_tomato_puree', 8, 'kg'], ['ing_potato', 8, 'kg'], ['ing_ghee', 2.2, 'kg'], ['ing_garam_masala', 0.8, 'kg'], ['ing_ginger_garlic', 1.3, 'kg'], ['ing_salt', 0.35, 'kg']
    ]),
    recipe('mod_desi_2', 'MODON Chicken Pulao', 'Desi', 'dinner', 100, [
      ['ing_basmati_rice', 13, 'kg'], ['ing_chicken_boneless', 16, 'kg'], ['ing_onion', 5, 'kg'], ['ing_yogurt', 3, 'kg'], ['ing_ghee', 2.8, 'kg'], ['ing_garam_masala', 0.7, 'kg'], ['ing_chicken_stock', 5, 'l'], ['ing_salt', 0.4, 'kg']
    ]),
    recipe('mod_italian_1', 'MODON Spaghetti Bolognese', 'Italian', 'lunch', 100, [
      ['ing_spaghetti', 12, 'kg'], ['ing_beef_mince', 14, 'kg'], ['ing_tomato_puree', 10, 'kg'], ['ing_onion', 4, 'kg'], ['ing_carrot', 4, 'kg'], ['ing_olive_oil', 1.8, 'l'], ['ing_italian_herbs', 0.45, 'kg'], ['ing_parmesan', 1.2, 'kg']
    ]),
    recipe('mod_italian_2', 'MODON Chicken Parmesan Bake', 'Italian', 'dinner', 100, [
      ['ing_chicken_boneless', 18, 'kg'], ['ing_bread_crumbs', 4, 'kg'], ['ing_egg', 120, 'pieces'], ['ing_tomato_puree', 8, 'kg'], ['ing_mozzarella', 5, 'kg'], ['ing_parmesan', 1.5, 'kg'], ['ing_italian_herbs', 0.4, 'kg'], ['ing_salt', 0.25, 'kg']
    ]),
    recipe('mod_cont_1', 'MODON Roast Beef with Garden Salad', 'Continental', 'dinner', 100, [
      ['ing_mutton', 10, 'kg'], ['ing_beef_mince', 10, 'kg'], ['ing_potato', 12, 'kg'], ['ing_lettuce', 6, 'kg'], ['ing_cucumber', 5, 'kg'], ['ing_carrot', 4, 'kg'], ['ing_olive_oil', 2.5, 'l'], ['ing_black_pepper', 0.35, 'kg'], ['ing_salt', 0.28, 'kg']
    ])
  ]
};

function recipe(key, name, cuisine, category, servings, lines) {
  const recipeIngredients = lines.map(([ingredient_id, quantity, unit]) => ({
    ingredient_id,
    ingredient_name: ingredients.find((item) => item.id === ingredient_id)?.name || ingredient_id,
    quantity,
    unit
  }));
  const nutrition = calculateRecipeNutrition(recipeIngredients, servings);
  return {
    id: id('recipe', key),
    name,
    recipe_code: key.toUpperCase(),
    recipe_type: 'full',
    category,
    cuisine_type: cuisine,
    description: `${cuisine} production recipe for catering test runs.`,
    prep_time_minutes: 35,
    cook_time_minutes: cuisine === 'Continental' ? 65 : 75,
    servings,
    instructions: 'Prepare mise en place, cook according to standard catering batch process, verify temperature, portion, and dispatch.',
    ingredients: recipeIngredients,
    ...nutrition,
    is_active: true,
    site_scope: 'specific',
    site_ids: [],
    site_names: []
  };
}

function quantityToGrams(quantity, unit) {
  const numeric = Number(quantity) || 0;
  if (unit === 'kg') return numeric * 1000;
  if (unit === 'g') return numeric;
  if (unit === 'l') return numeric * 1000;
  if (unit === 'ml') return numeric;
  if (unit === 'pieces') return numeric * 60;
  return numeric;
}

function calculateRecipeNutrition(recipeIngredients, servings) {
  const totals = {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    sodium: 0,
    sugar: 0
  };
  const allergenSet = new Set();
  recipeIngredients.forEach((line) => {
    const ingredient = ingredients.find((item) => item.id === line.ingredient_id);
    if (!ingredient) return;
    const factor = quantityToGrams(line.quantity, line.unit) / 100;
    totals.calories += (ingredient.calories_per_100g || 0) * factor;
    totals.protein += (ingredient.protein_per_100g || 0) * factor;
    totals.carbs += (ingredient.carbs_per_100g || 0) * factor;
    totals.fat += (ingredient.fat_per_100g || 0) * factor;
    totals.sodium += (ingredient.sodium_per_100g || 0) * factor;
    totals.sugar += (ingredient.sugar_per_100g || 0) * factor;
    ingredient.allergens.forEach((allergen) => allergenSet.add(allergen));
  });

  const divisor = Math.max(1, Number(servings) || 1);
  const round = (value) => Math.round(value * 10) / 10;
  return {
    total_calories: Math.round(totals.calories),
    total_protein: round(totals.protein),
    total_carbs: round(totals.carbs),
    total_fat: round(totals.fat),
    total_sodium: round(totals.sodium),
    total_sugar: round(totals.sugar),
    calories_per_serving: Math.round(totals.calories / divisor),
    protein_per_serving: round(totals.protein / divisor),
    carbs_per_serving: round(totals.carbs / divisor),
    fat_per_serving: round(totals.fat / divisor),
    sodium_per_serving: round(totals.sodium / divisor),
    sugar_per_serving: round(totals.sugar / divisor),
    allergens: Array.from(allergenSet).sort()
  };
}

function record(entity, data) {
  const timestamp = nowIso();
  return {
    id: data.id || `${entity.toLowerCase()}_${crypto.randomUUID()}`,
    entity_name: entity,
    data: {
      created_date: timestamp,
      updated_date: timestamp,
      ...data
    },
    created_at: timestamp,
    updated_at: timestamp
  };
}

function siteRecords() {
  const rows = [];
  camps.forEach((camp) => {
    const campId = id('site', camp.key);
    const warehouseId = id('site', `${camp.key}_warehouse`);
    rows.push(record('Site', {
      id: campId,
      name: camp.name,
      project_code: camp.project_code,
      type: 'camp',
      hierarchy_level: 'camp',
      parent_site_id: null,
      parent_site_name: null,
      hierarchy_path: camp.name,
      location_name: camp.name,
      city: camp.city,
      country: 'Saudi Arabia',
      capacity: 1200,
      contact_person: `${camp.name} Admin`,
      contact_phone: '+966500000000',
      is_active: true
    }));
    rows.push(record('Site', {
      id: warehouseId,
      name: camp.warehouse,
      project_code: `${camp.project_code}-WH`,
      type: 'warehouse',
      hierarchy_level: 'warehouse',
      parent_site_id: campId,
      parent_site_name: camp.name,
      hierarchy_path: `${camp.name} / ${camp.warehouse}`,
      location_name: camp.name,
      storage_name: camp.warehouse,
      city: camp.city,
      country: 'Saudi Arabia',
      capacity: 500,
      contact_person: `${camp.name} Storekeeper`,
      contact_phone: '+966500000001',
      is_active: true
    }));
  });
  return rows;
}

function recipeRecords() {
  return camps.flatMap((camp) => {
    const campId = id('site', camp.key);
    const warehouseId = id('site', `${camp.key}_warehouse`);
    return recipesByCamp[camp.key].map((item) => record('Recipe', {
      ...item,
      site_ids: [campId, warehouseId],
      site_names: [camp.name, camp.warehouse]
    }));
  });
}

function ingredientRecords() {
  return ingredients.map((item) => record('Ingredient', item));
}

function inventoryRecords() {
  const rows = [];
  const stockSites = camps.flatMap((camp) => [
    { id: id('site', camp.key), name: camp.name, multiplier: 1 },
    { id: id('site', `${camp.key}_warehouse`), name: camp.warehouse, multiplier: 1.75 }
  ]);

  stockSites.forEach((site) => {
    ingredients.forEach((ingredient) => {
      const baseQuantity = ingredient.category === 'Spices'
        ? 45
        : ingredient.category === 'Dairy'
          ? 160
          : ingredient.category === 'Protein'
            ? 420
            : ingredient.category === 'Oil'
              ? 120
              : 650;
      const quantity = Number((baseQuantity * site.multiplier).toFixed(3));
      const totalValue = Number((quantity * ingredient.cost_per_unit).toFixed(2));
      const inventoryId = id('inventory', `${site.id}_${ingredient.id}`);
      const lotId = id('lot', `${site.id}_${ingredient.id}`);

      rows.push(record('Inventory', {
        id: inventoryId,
        site_id: site.id,
        site_name: site.name,
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name,
        d365_item_id: ingredient.id.replace('ing_', 'D365-').toUpperCase(),
        quantity,
        available_quantity: quantity,
        unit: ingredient.unit,
        min_stock_level: Number((quantity * 0.2).toFixed(3)),
        max_stock_level: Number((quantity * 1.5).toFixed(3)),
        total_value: totalValue,
        average_unit_cost: ingredient.cost_per_unit,
        valuation_method: 'fifo',
        batch_count: 1,
        next_expiry_date: '2026-07-31',
        near_expiry_count: 0,
        expired_lot_count: 0,
        status: 'in_stock'
      }));

      rows.push(record('InventoryLot', {
        id: lotId,
        site_id: site.id,
        site_name: site.name,
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name,
        quantity_received: quantity,
        remaining_quantity: quantity,
        unit: ingredient.unit,
        unit_cost: ingredient.cost_per_unit,
        total_cost: totalValue,
        batch_number: `TEST-${site.id.slice(5, 8).toUpperCase()}-${ingredient.id.slice(4, 10).toUpperCase()}`,
        lot_number: `LOT-${site.id.slice(5, 8).toUpperCase()}-${ingredient.id.slice(4, 10).toUpperCase()}`,
        expiry_date: '2026-07-31',
        received_date: today,
        reference_id: inventoryId,
        reference_type: 'seed',
        status: 'active'
      }));
    });
  });

  return rows;
}

function productionRecords() {
  return camps.flatMap((camp) => {
    const campId = id('site', camp.key);
    return recipesByCamp[camp.key].slice(0, 3).map((item, index) => record('Production', {
      id: id('production', `${camp.key}_${index + 1}`),
      site_id: campId,
      site_name: camp.name,
      production_date: today,
      meal_type: item.category,
      recipe_id: item.id,
      recipe_name: item.name,
      target_servings: 100,
      actual_servings: null,
      ingredients_used: item.ingredients.map((line) => ({
        ingredient_id: line.ingredient_id,
        ingredient_name: line.ingredient_name,
        planned_quantity: line.quantity,
        actual_quantity: null,
        unit: line.unit
      })),
      total_calories: Number(item.calories_per_serving || 0) * 100,
      status: index === 0 ? 'approved' : 'planned',
      notes: 'Seeded production test batch'
    }));
  });
}

async function clearOldData() {
  await pool.query('DELETE FROM entity_records WHERE entity_name = ANY($1)', [RESET_ENTITIES]);
}

async function insertRecords(records) {
  for (const item of records) {
    await pool.query(
      `INSERT INTO entity_records (id, entity_name, data, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [item.id, item.entity_name, JSON.stringify(item.data), item.created_at, item.updated_at]
    );
  }
}

function exportWorkbook(outputPath) {
  const workbook = XLSX.utils.book_new();
  const ingredientRows = ingredients.map((item) => ({
    id: item.id,
    name: item.name,
    unit: item.unit,
    category: item.category,
    cost_per_unit: item.cost_per_unit,
    calories_per_100g: item.calories_per_100g,
    protein_per_100g: item.protein_per_100g,
    carbs_per_100g: item.carbs_per_100g,
    fat_per_100g: item.fat_per_100g,
    sodium_per_100g: item.sodium_per_100g,
    sugar_per_100g: item.sugar_per_100g,
    cooking_yield_percent: item.cooking_yield_percent,
    shrinkage_percent: item.shrinkage_percent,
    allergens: item.allergens.join(',')
  }));
  const inventoryRows = inventoryRecords()
    .filter((item) => item.entity_name === 'Inventory')
    .map((item) => item.data);
  const recipeRows = recipeRecords().map((item) => ({
    id: item.data.id,
    name: item.data.name,
    site_names: item.data.site_names.join(', '),
    cuisine_type: item.data.cuisine_type,
    category: item.data.category,
    servings: item.data.servings,
    ingredient_count: item.data.ingredients.length
  }));
  const siteRows = siteRecords().map((item) => item.data);

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(siteRows), 'Sites');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(ingredientRows), 'Ingredients');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(inventoryRows), 'Inventory');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(recipeRows), 'Recipes');
  XLSX.writeFile(workbook, outputPath);
}

async function exportJson(outputPath) {
  const records = [
    ...siteRecords(),
    ...ingredientRecords(),
    ...recipeRecords(),
    ...inventoryRecords(),
    ...productionRecords()
  ];
  const fs = await import('node:fs/promises');
  await fs.writeFile(outputPath, JSON.stringify({
    generated_at: nowIso(),
    reset_entities: RESET_ENTITIES,
    records: records.map((item) => ({
      id: item.id,
      entity_name: item.entity_name,
      data: item.data
    }))
  }, null, 2));
}

async function main() {
  const outputPath = process.argv[2] || 'outputs/test-data/foodpro-camps-ingredient-inventory.xlsx';
  const workbookOnly = process.argv.includes('--workbook-only');
  if (workbookOnly) {
    exportWorkbook(outputPath);
    await exportJson(outputPath.replace(/\.xlsx$/i, '.json'));
    console.log(JSON.stringify({
      message: 'FoodPro camp test workbook exported',
      outputPath,
      jsonPath: outputPath.replace(/\.xlsx$/i, '.json'),
      counts: {
        Site: siteRecords().length,
        Ingredient: ingredientRecords().length,
        Recipe: recipeRecords().length,
        Inventory: inventoryRecords().filter((item) => item.entity_name === 'Inventory').length,
        InventoryLot: inventoryRecords().filter((item) => item.entity_name === 'InventoryLot').length,
        Production: productionRecords().length
      }
    }, null, 2));
    return;
  }

  await initDatabase();
  await clearOldData();
  const records = [
    ...siteRecords(),
    ...ingredientRecords(),
    ...recipeRecords(),
    ...inventoryRecords(),
    ...productionRecords()
  ];
  await insertRecords(records);
  exportWorkbook(outputPath);
  await exportJson(outputPath.replace(/\.xlsx$/i, '.json'));

  console.log(JSON.stringify({
    message: 'FoodPro camp test data seeded',
    outputPath,
    jsonPath: outputPath.replace(/\.xlsx$/i, '.json'),
    counts: records.reduce((accumulator, item) => {
      accumulator[item.entity_name] = (accumulator[item.entity_name] || 0) + 1;
      return accumulator;
    }, {})
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
