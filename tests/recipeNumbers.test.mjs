import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  formatRecipeQuantity,
  normalizeQuantityFieldsForExport,
  normalizeRecipeNumericFields,
  parseStandardDecimal
} from '../shared/recipeNumbers.js';

const cases = [
  ['normalizes leading zero quantities without storing text', () => {
    const result = parseStandardDecimal('04.5', { unit: 'kg', mode: 'final' });
    assert.equal(result.valid, true);
    assert.equal(result.value, 4.5);
    assert.equal(typeof result.value, 'number');
    assert.equal(result.display, '4.5');
    assert.equal(result.normalized, true);
  }],
  ['preserves an incomplete decimal while typing', () => {
    assert.deepEqual(
      parseStandardDecimal('0.', { unit: 'kg', mode: 'input' }),
      { valid: true, value: 0, display: '0.', normalized: false, error: '' }
    );
  }],
  ['rejects alphabetic, negative, symbolic, and multiple-decimal values', () => {
    ['abc', '-1', '1kg', '1.2.3', '$4'].forEach((value) => {
      assert.equal(parseStandardDecimal(value, { unit: 'kg' }).valid, false, value);
    });
  }],
  ['enforces unit-specific precision', () => {
    assert.equal(parseStandardDecimal('1.234', { unit: 'kg' }).valid, true);
    assert.equal(parseStandardDecimal('1.2345', { unit: 'kg' }).valid, false);
    assert.equal(parseStandardDecimal('1.23', { unit: 'g' }).valid, true);
    assert.equal(parseStandardDecimal('1.234', { unit: 'g' }).valid, false);
  }],
  ['normalizes all persisted recipe quantities to numbers', () => {
    const result = normalizeRecipeNumericFields({
      servings: '050',
      portion_size_grams: '0250.00',
      batch_yield: '05.500',
      target_selling_price: '035.20',
      ingredients: [{ ingredient_id: 'i1', ingredient_name: 'Corn Oil', quantity: '04.500', unit: 'kg' }],
      sub_recipes: [{ recipe_id: 'r1', recipe_name: 'Stock', quantity: '01.250', unit: 'batch' }]
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.recipe.servings, 50);
    assert.equal(result.recipe.portion_size_grams, 250);
    assert.equal(result.recipe.batch_yield, 5.5);
    assert.equal(result.recipe.target_selling_price, 35.2);
    assert.equal(result.recipe.ingredients[0].quantity, 4.5);
    assert.equal(result.recipe.sub_recipes[0].quantity, 1.25);
  }],
  ['standardizes legacy values in views and exports', () => {
    assert.equal(formatRecipeQuantity('004.500', 'kg'), '4.5');
    assert.deepEqual(
      normalizeQuantityFieldsForExport({ ingredients: [{ quantity: '004.500', unit: 'kg' }], servings: '005' }),
      { ingredients: [{ quantity: 4.5, unit: 'kg' }], servings: 5 }
    );
  }],
  ['wires canonical decimals through editor, server, production, reports, and exports', () => {
    const recipeForm = fs.readFileSync(new URL('../src/components/recipes/RecipeForm.jsx', import.meta.url), 'utf8');
    const serverPreparation = fs.readFileSync(new URL('../server/entityPreparation.js', import.meta.url), 'utf8');
    const productionSheet = fs.readFileSync(new URL('../src/components/production/ProductionPlanningDashboard.jsx', import.meta.url), 'utf8');
    const reports = fs.readFileSync(new URL('../src/pages/Reports.jsx', import.meta.url), 'utf8');
    const exports = fs.readFileSync(new URL('../src/components/utils/exportData.jsx', import.meta.url), 'utf8');
    assert.match(recipeForm, /StandardDecimalInput/);
    assert.match(recipeForm, /Item Cost/);
    assert.match(recipeForm, /Line Cost/);
    assert.match(recipeForm, /Cost per 100 g/);
    assert.match(serverPreparation, /normalizeRecipeNumericFields/);
    assert.match(serverPreparation, /calculateRecipeCostingSnapshot/);
    assert.match(productionSheet, /formatRecipeQuantity\(ingredient\.quantity/);
    assert.match(reports, /formatRecipeQuantity\(ing\.totalUsed/);
    assert.match(exports, /normalizeQuantityFieldsForExport/);
  }]
];

let failed = false;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
if (failed) process.exitCode = 1;
else console.log(`PASS ${cases.length} recipe number tests`);
