import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getItemCode,
  getItemCodeFromRecords,
  putItemCodeAndNameFirst
} from '../shared/itemCode.js';
import { entityRegistry } from '../server/entities.js';
import {
  enrichIngredientItemCodes,
  enrichRecordsWithIngredientItemCodes
} from '../server/itemCodes.js';

assert.equal(getItemCode({ item_code: ' ITEM-01 ', ingredient_code: 'ING-01', sku: 'SKU-01' }), 'ITEM-01');
assert.equal(getItemCode({ item_code: ' ', ingredient_code: ' ING-01 ', sku: 'SKU-01' }), 'ING-01');
assert.equal(getItemCode({ sku: ' SKU-01 ' }), 'SKU-01');
assert.equal(getItemCode({ d365_item_id: ' D365-ITEM-01 ' }), 'D365-ITEM-01');
assert.equal(getItemCode({ ingredient_code: 'ING-01', data: { item_code: 'ITEM-NESTED' } }), 'ITEM-NESTED');
assert.equal(getItemCode({ data: { sku: 'SKU-NESTED' } }), 'SKU-NESTED');
assert.equal(getItemCode({}), '—');
assert.equal(getItemCode(null, '-'), '-');

assert.equal(
  getItemCodeFromRecords([{ ingredient_name: 'Rice' }, { ingredient_code: 'ING-RICE' }]),
  'ING-RICE'
);
assert.equal(getItemCodeFromRecords([], '-'), '-');

const exportRow = putItemCodeAndNameFirst(
  { id: 'ing-1', name: 'Corn Flour', sku: 'SKU-22', category: 'Flour' },
  { outputNameKey: 'item_name' }
);
assert.deepEqual(Object.keys(exportRow).slice(0, 2), ['item_code', 'item_name']);
assert.equal(exportRow.item_code, 'SKU-22');
assert.equal(exportRow.item_name, 'Corn Flour');
assert.equal(exportRow.category, 'Flour');
assert.equal(putItemCodeAndNameFirst({ name: 'No Code' }, { fallback: '' }).item_code, '');
assert.equal(
  entityRegistry.Ingredient.unique.some((rule) => rule.fields.length === 1 && rule.fields[0] === 'item_code'),
  true,
  'Item Code is unique across ingredient master records'
);

const ingredientsSource = fs.readFileSync(new URL('../src/pages/Ingredients.jsx', import.meta.url), 'utf8');
const inventorySource = fs.readFileSync(new URL('../src/pages/Inventory.jsx', import.meta.url), 'utf8');
const pickerSource = fs.readFileSync(new URL('../src/components/ingredients/IngredientSearchCombobox.jsx', import.meta.url), 'utf8');
const caloriesSource = fs.readFileSync(new URL('../src/pages/CaloriesCalculator.jsx', import.meta.url), 'utf8');
const dashboardSource = fs.readFileSync(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
const autoScheduleSource = fs.readFileSync(new URL('../src/pages/AutoSchedule.jsx', import.meta.url), 'utf8');

assert.match(
  ingredientsSource,
  /<TableHead>Item Code<\/TableHead>\s*<TableHead>Item Name<\/TableHead>/,
  'ingredient and embedded inventory tables put Item Code immediately before Item Name'
);
assert.match(
  inventorySource,
  /<TableHead>Item Code<\/TableHead>\s*<TableHead>Item Name<\/TableHead>/,
  'inventory reports put Item Code immediately before Item Name'
);
assert.match(
  pickerSource,
  /<span>Item Code<\/span><span>Item Name<\/span>/,
  'ingredient search results put Item Code immediately before Item Name'
);
assert.match(ingredientsSource, /putItemCodeAndNameFirst/, 'ingredient CSV exports use code-first projection');
assert.match(inventorySource, /putItemCodeAndNameFirst/, 'inventory CSV exports use code-first projection');
assert.match(
  caloriesSource,
  /<TableHead>Item Code<\/TableHead>\s*<TableHead>Item Name<\/TableHead>/,
  'calorie calculator puts Item Code immediately before Item Name'
);
assert.match(caloriesSource, /recipe_code/, 'calorie calculator supports recipe code fallback');
assert.match(dashboardSource, /item_code: getItemCodeFromRecords/, 'dashboard low-stock cards resolve item codes');
assert.match(autoScheduleSource, /\$\{item\.item_code\} · \$\{item\.ingredient_name\}/, 'auto-schedule alerts show code before name');

const fakeExecutor = {
  async query(_sql, params) {
    assert.deepEqual(params, [['ingredient-rice']]);
    return {
      rows: [{ id: 'ingredient-rice', data: { item_code: 'ITEM-RICE-001', name: 'Rice' } }]
    };
  }
};
const enrichedItems = await enrichIngredientItemCodes([
  { ingredient_id: 'ingredient-rice', ingredient_name: 'Rice' }
], fakeExecutor);
assert.equal(enrichedItems[0].item_code, 'ITEM-RICE-001');

const enrichedRecords = await enrichRecordsWithIngredientItemCodes([
  { id: 'request-1', items: [{ ingredient_id: 'ingredient-rice', ingredient_name: 'Rice' }] }
], fakeExecutor);
assert.equal(enrichedRecords[0].items[0].item_code, 'ITEM-RICE-001');

console.log('item code tests passed');
