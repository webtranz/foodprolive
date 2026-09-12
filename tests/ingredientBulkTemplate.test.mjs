import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTemplateCsv, mapCsvRow, parseCsvLine, validateCsvHeaders } from '../server/utilities.js';
import { ingredientWeightConversion } from '../shared/ingredientUnits.js';

const headers = [
  'item_code', 'name', 'source_name', 'ingredient_code', 'sku', 'alias', 'aliases', 'supplier_item_name',
  'unit', 'conversion_unit', 'conversion_factor', 'category', 'cuisine_type', 'cost_per_unit', 'supplier',
  'package_base_quantity', 'package_base_unit', 'calories_per_100g', 'protein_per_100g', 'carbs_per_100g',
  'fat_per_100g', 'fiber_per_100g', 'sodium_per_100g', 'sugar_per_100g', 'cooking_yield_percent',
  'shrinkage_percent', 'raw_weight_per_unit', 'cooked_weight_per_unit', 'allergens', 'is_active'
];
const legacyHeaders = [
  'item_code', 'name', 'ingredient_code', 'sku', 'alias', 'supplier_item_name', 'unit', 'category',
  'cuisine_type', 'cost_per_unit', 'package_base_quantity', 'package_base_unit', 'calories_per_100g',
  'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'sodium_per_100g', 'sugar_per_100g',
  'cooking_yield_percent', 'shrinkage_percent', 'raw_weight_per_unit', 'cooked_weight_per_unit',
  'allergens', 'is_active'
];
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const mapIngredient = (row, fieldNames = headers) => mapCsvRow(
  'ingredients', fieldNames, parseCsvLine(fieldNames.map((field) => csvCell(row[field])).join(','))
);

test('ingredient CSV contains every form field and retains legacy column order', () => {
  assert.equal(createTemplateCsv('ingredients'), `${headers.join(',')}\n`);
  assert.equal(headers.length, 30);
  assert.deepEqual(headers.filter((header) => legacyHeaders.includes(header)), legacyHeaders);
  const form = readFileSync(new URL('../src/components/ingredients/IngredientForm.jsx', import.meta.url), 'utf8');
  const state = form.match(/const \[formData, setFormData\] = useState\(\{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(state, 'Ingredient form initial state should be found');
  const fields = [...state.matchAll(/^\s+([a-z_0-9]+):/gm)].map((match) => match[1]);
  assert.ok(fields.length >= 20, 'Coverage check must inspect the full ingredient form state');
  for (const field of fields) assert.ok(headers.includes(field), `Missing ingredient form field: ${field}`);
});

test('full template accepts form data, source, supplier, numeric conversion, fiber and quoted lists', () => {
  const row = {
    item_code: 'OIL-001', name: 'Oil, refined', source_name: 'Cash', ingredient_code: 'ING-001',
    sku: 'SKU-001', alias: 'Legacy oil', aliases: JSON.stringify([' Refined oil ', 'Oil, cooking']),
    supplier_item_name: 'Supplier oil', unit: 'Liters (l)', conversion_unit: 'Grams (g)', conversion_factor: '920',
    category: 'oils', cuisine_type: 'general', cost_per_unit: '12.5', supplier: 'Supplier, One',
    package_base_quantity: '1', package_base_unit: 'Liters (l)', calories_per_100g: '884',
    protein_per_100g: '0', carbs_per_100g: '0', fat_per_100g: '100', fiber_per_100g: '0',
    sodium_per_100g: '0', sugar_per_100g: '0', cooking_yield_percent: '100', shrinkage_percent: '0',
    raw_weight_per_unit: '920', cooked_weight_per_unit: '920', allergens: 'soy, sesame', is_active: 'true'
  };
  const payload = mapIngredient(row);
  assert.equal(payload.name, 'Oil, refined');
  assert.equal(payload.source_name, 'Cash');
  assert.equal(payload.supplier, 'Supplier, One');
  assert.equal(payload.alias, 'Legacy oil');
  assert.deepEqual(payload.aliases, ['Refined oil', 'Oil, cooking']);
  assert.deepEqual(payload.allergens, ['soy', 'sesame']);
  assert.equal(payload.unit, 'l');
  assert.equal(payload.conversion_unit, 'g');
  assert.equal(payload.conversion_factor, 920);
  assert.equal(payload.fiber_per_100g, 0);
  assert.deepEqual(ingredientWeightConversion(1, payload.unit, payload), { grams: 920, source: 'ingredient_conversion' });
  assert.equal(payload.package_base_unit, 'l');
  for (const key of ['protein', 'carbs', 'fiber', 'sodium', 'sugar']) assert.equal(payload[`${key}_per_100g`], 0);
});

test('form labels work as headers and aliases remain distinct from legacy alias', () => {
  const fieldNames = ['Item Name', 'SKU Code', 'Base Unit', 'Conversion Unit', 'Conversion Units per Base Unit', 'Aliases / Alternative Names', 'Fiber', 'alias'];
  assert.deepEqual(validateCsvHeaders('ingredients', fieldNames), []);
  const payload = mapCsvRow('ingredients', fieldNames, ['Oil', 'OIL-SKU', 'litres', 'grams', '920', 'cooking oil | vegetable oil, refined oil', '1.25', 'older alias']);
  assert.equal(payload.name, 'Oil');
  assert.equal(payload.sku, 'OIL-SKU');
  assert.equal(payload.item_code, 'OIL-SKU');
  assert.equal(payload.unit, 'l');
  assert.equal(payload.conversion_unit, 'g');
  assert.equal(payload.conversion_factor, 920);
  assert.equal(payload.fiber_per_100g, 1.25);
  assert.deepEqual(payload.aliases, ['cooking oil', 'vegetable oil', 'refined oil']);
  assert.equal(payload.alias, 'older alias');
});

test('aliases accept empty JSON arrays and reject objects, non-string entries and malformed JSON arrays', () => {
  assert.deepEqual(mapIngredient({ name: 'No aliases', aliases: '[]' }).aliases, []);
  for (const aliases of ['{"name":"wrong"}', '[{"name":"wrong"}]', '[1]', '[null]', '["unfinished"']) {
    assert.throws(() => mapIngredient({ name: 'Invalid aliases', aliases }), /aliases must be/);
  }
});

test('zero nutrition is retained, blank nutrition stays unspecified, and invalid factors are rejected', () => {
  const zero = mapIngredient({ name: 'Zero', calories_per_100g: '0', fat_per_100g: '0', fiber_per_100g: '0' });
  assert.equal(zero.calories_per_100g, 0);
  assert.equal(zero.fat_per_100g, 0);
  assert.equal(zero.fiber_per_100g, 0);
  assert.equal(zero.protein_per_100g, undefined);
  assert.equal(zero.conversion_factor, undefined);
  for (const conversion_factor of ['bad', '920g', 'Infinity', 'NaN', '-1', '0']) {
    assert.throws(() => mapIngredient({ name: 'Invalid conversion', unit: 'l', conversion_unit: 'g', conversion_factor }), /conversion_factor/);
  }
});

test('legacy ingredient headers and direct package/custom unit spellings remain supported', () => {
  const payload = mapIngredient({ name: 'Legacy item', ingredient_code: 'LEG-001', alias: 'Old name', unit: 'EA', cooking_yield_percent: '80', allergens: 'dairy|nuts' }, legacyHeaders);
  assert.equal(payload.item_code, 'LEG-001');
  assert.equal(payload.alias, 'Old name');
  assert.equal(payload.aliases, undefined);
  assert.equal(payload.unit, 'EA');
  assert.equal(payload.cooking_yield_percent, 80);
  assert.deepEqual(payload.allergens, ['dairy', 'nuts']);
  for (const unit of ['EA', 'PAK', 'BDL', 'CS', 'Scoop-Large']) {
    assert.equal(mapIngredient({ name: 'Unit preservation', unit }).unit, unit);
  }
  for (const [unit, expected] of [
    ['Kilograms (kg)', 'kg'],
    ['Grams (g)', 'g'],
    ['Pounds (lb)', 'lb'],
    ['Ounces (oz)', 'oz'],
    ['Liters (l)', 'l'],
    ['Milliliters (ml)', 'ml'],
    ['Cubic Meter (m3)', 'm3'],
    ['CT (Count)', 'ct'],
    ['EA (Each)', 'ea'],
    ['PAK (Pack)', 'pak'],
    ['CT (Each)', 'ea'],
    ['Pieces', 'pieces'],
    ['gms', 'g'],
    ['ltr', 'l'],
    ['cubic mtr', 'm3'],
    ['pounds', 'lb'],
    ['ounces', 'oz']
  ]) {
    assert.equal(mapIngredient({ name: 'Unit alias', unit }).unit, expected);
  }
});

test('ingredient unit normalization does not change inventory CSV behavior', () => {
  const inventory = mapCsvRow('inventory', ['item_code', 'quantity', 'unit'], ['ITEM-1', '2', 'Kilograms (kg)']);
  assert.equal(inventory.unit, 'Kilograms (kg)');
  assert.equal(inventory.quantity, 2);
});

test('blank or omitted fields do not inject defaults into ingredient updates', () => {
  const blank = mapIngredient({ name: 'Minimal upload', source_name: ' ', allergens: '', is_active: '' });
  const omitted = mapCsvRow('ingredients', ['name'], ['Minimal upload']);
  for (const payload of [blank, omitted]) {
    for (const field of ['source_name', 'allergens', 'is_active', 'aliases', 'supplier', 'conversion_factor', 'fiber_per_100g']) {
      assert.equal(Object.hasOwn(payload, field), false, `${field} should remain absent`);
    }
  }
  const explicit = mapIngredient({ name: 'Explicit fields', source_name: 'D365', aliases: '[]', allergens: '[]', is_active: 'false' });
  assert.equal(explicit.source_name, 'D365');
  assert.deepEqual(explicit.aliases, []);
  assert.deepEqual(explicit.allergens, []);
  assert.equal(explicit.is_active, false);
});

test('supplied weights fill omitted cooking fields while explicit legacy values are preserved', () => {
  const derived = mapIngredient({ name: 'Weight ratio', raw_weight_per_unit: '3', cooked_weight_per_unit: '2' });
  assert.equal(derived.cooking_yield_percent, 66.7);
  assert.equal(derived.shrinkage_percent, 33.3);
  const explicitYield = mapIngredient({ name: 'Legacy yield', raw_weight_per_unit: '1', cooked_weight_per_unit: '1', cooking_yield_percent: '80' });
  assert.equal(explicitYield.cooking_yield_percent, 80);
  assert.equal(explicitYield.shrinkage_percent, 20);
  const explicitBoth = mapIngredient({ name: 'Legacy fields', raw_weight_per_unit: '1', cooked_weight_per_unit: '1', cooking_yield_percent: '80', shrinkage_percent: '15' });
  assert.equal(explicitBoth.cooking_yield_percent, 80);
  assert.equal(explicitBoth.shrinkage_percent, 15);
  for (const row of [{ raw_weight_per_unit: '1000' }, { raw_weight_per_unit: '0', cooked_weight_per_unit: '1000' }]) {
    const incomplete = mapIngredient({ name: 'No ratio', ...row });
    assert.equal(incomplete.cooking_yield_percent, undefined);
    assert.equal(incomplete.shrinkage_percent, undefined);
  }
});
