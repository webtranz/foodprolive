import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mapCsvRow, parseCsvLine } from '../server/utilities.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { calculateFrozenProductionLineWeight } from '../shared/productionReconciliation.js';
import { inferPackageFields } from '../shared/packageUnits.js';

const root = path.resolve('artifacts/menu-planning-kbr-384');
const sources = [
  ['general', path.join(root, 'DIRECT MENU/GENERAL-RECIPES-KBR-384-102-SOURCE-100PAX.csv')],
  ['philippines', path.join(root, 'DIRECT MENU/READY TO UPLOAD/FILIPINO-RECIPES-KBR-384-28-GLOBAL-STOCK-LINKED.csv')]
];
function read(file, module) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => mapCsvRow(module, headers, parseCsvLine(line)));
}
const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const ingredients = read(path.join(root, 'kbr-384ingredients-upload-nutrition-ready.csv'), 'ingredients')
  .map((ingredient) => ({ ...ingredient, ...inferPackageFields(ingredient), id: ingredient.item_code }));
const lookup = new Map();
for (const ingredient of ingredients) {
  for (const reference of [ingredient.id, ingredient.item_code, ingredient.name]) {
    if (key(reference)) lookup.set(key(reference), ingredient);
  }
}
const result = [];
for (const [cuisine, file] of sources) {
  for (const source of read(file, 'recipes')) {
    const missing = [];
    const recipe = {
      ...source,
      ingredients: source.ingredients.map((line, index) => {
        const match = [line.item_code, line.ingredient_id, line.ingredient_name].map((ref) => lookup.get(key(ref))).find(Boolean);
        if (!match) missing.push(line.ingredient_name || line.item_code);
        return { ...line, ingredient_id: match?.id || `missing-${index}` };
      })
    };
    const weight = calculateRecipeServingWeight(recipe, [], ingredients);
    const lines = recipe.ingredients.map((line) => ({
      item_code: line.item_code, name: line.ingredient_name, quantity: line.quantity, unit: line.unit,
      ...calculateFrozenProductionLineWeight({ planned_quantity: line.quantity, unit: line.unit }, lookup.get(key(line.ingredient_id)) || {})
    }));
    if (weight.is_complete) {
      const total = lines.reduce((sum, line) => sum + line.yielded_weight_grams, 0);
      assert.ok(Math.abs(weight.grams_per_serving - total / source.servings) <= 0.0051);
      assert.equal(source.ingredients.length, recipe.ingredients.length);
    }
    result.push({
      cuisine, recipe_code: source.recipe_code, name: source.name, servings: source.servings,
      saved_portion_size_grams: source.portion_size_grams ?? null,
      ...weight, missing_ingredient_masters: missing, lines
    });
  }
}
assert.equal(result.length, 130);
const summary = ['general', 'philippines'].map((cuisine) => {
  const rows = result.filter((row) => row.cuisine === cuisine);
  return {
    cuisine, recipes: rows.length,
    calculated: rows.filter((row) => row.is_complete).length,
    needs_weight_or_mapping: rows.filter((row) => !row.is_complete).length
  };
});
const report = {
  basis: 'Recipe units and package sizes converted to grams before applying ingredient yield and dividing by servings.',
  assumptions: ['Liquids use ingredient density when supplied, otherwise the existing 1 g/ml estimate.', 'BDL uses the existing user-approved 80 g bundle default when no package weight is supplied.', 'Saved portion targets are preserved; calculated cooked weights are estimates from supplied yield data.'],
  summary, recipes: result
};
const output = path.resolve('artifacts/recipe-serving-weight-qc.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const cell = (value) => String(value ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
const table = [
  '# Recipe Serving Weight Check',
  '',
  'Checked against the local 102 General recipes (100-pax source), 28 Philippine recipes, and 349-row ingredient upload. This is a file-based check, not a live database verification.',
  '',
  'Weight = raw recipe quantities converted to grams, multiplied by supplied ingredient yields, divided by recipe servings. Liquids use supplied density or the existing 1 g/ml estimate. Bundle weight defaults to 80 g. Saved portion targets are separate from calculated weights. No recipe ingredient quantities or serving counts were changed.',
  '',
  '| Cuisine | Recipes | Complete calculation | Missing mapping or weight |',
  '| --- | ---: | ---: | ---: |',
  ...summary.map((row) => `| ${row.cuisine} | ${row.recipes} | ${row.calculated} | ${row.needs_weight_or_mapping} |`),
  '',
  '| Recipe code | Recipe | Batch servings | Calculated cooked g/serving | Required data |',
  '| --- | --- | ---: | ---: | --- |',
  ...result.map((row) => `| ${cell(row.recipe_code)} | ${cell(row.name)} | ${row.servings} | ${row.grams_per_serving ?? 'Unavailable'} | ${cell(row.warnings.join(' '))} |`),
  ''
];
fs.writeFileSync(path.resolve('artifacts/recipe-serving-weight-qc.md'), table.join('\n'));
console.log(JSON.stringify({ summary, dal_chana: result.filter((row) => row.name.includes('Dal Chana Fry')).map((row) => ({ name: row.name, grams_per_serving: row.grams_per_serving })), output }, null, 2));
