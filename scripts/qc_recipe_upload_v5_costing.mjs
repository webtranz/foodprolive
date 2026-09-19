import fs from 'node:fs';
import { parseCsvLine } from '../server/utilities.js';
import { calculateRecipeCostingSnapshot } from '../shared/recipeCosting.js';
import { isIngredientUnitCompatible } from '../shared/ingredientUnits.js';
import { inferPackageFields } from '../shared/packageUnits.js';

const inputPath = 'artifacts/recipe-upload-one-go-v5-source-exact/UPLOAD-THIS-RECIPES-KBR-384-102-SOURCE-EXACT-1SERVING-V5.csv';
const inventoryPath = 'artifacts/inventory-ingredients-only/kbr-384-inventory-upload-corrected.csv';
const outputPath = 'artifacts/recipe-upload-one-go-v5-source-exact/recipe-costing-v5-qc.csv';

function readCsv(path) {
  const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const inventoryRows = readCsv(inventoryPath);
const ingredients = inventoryRows.map((row) => ({
  id: row.item_code,
  item_code: row.item_code,
  ingredient_code: row.item_code,
  sku: row.item_code,
  name: row.ingredient_name,
  ingredient_name: row.ingredient_name,
  unit: row.unit,
  cost_per_unit: Number(row.unit_cost || 0),
  average_cost: Number(row.unit_cost || 0),
  category: row.item_group,
  ...inferPackageFields({ name: row.ingredient_name, unit: row.unit })
}));
const byCode = new Map(ingredients.map((ingredient) => [String(ingredient.item_code).toLowerCase(), ingredient]));

const recipeRows = readCsv(inputPath);
const recipesByCode = new Map();
recipeRows.forEach((row) => {
  const key = row.recipe_code || row.name;
  if (!recipesByCode.has(key)) {
    recipesByCode.set(key, {
      name: row.name,
      recipe_code: row.recipe_code,
      servings: Number(row.servings || 1),
      ingredients: []
    });
  }
  if (row.item_code || row.ingredient_id || row.ingredient_name || row.line_quantity) {
    recipesByCode.get(key).ingredients.push({
      line_number: Number(row.line_number || recipesByCode.get(key).ingredients.length + 1),
      ingredient_id: row.ingredient_id || row.item_code || '',
      item_code: row.item_code || row.ingredient_code || row.sku || '',
      ingredient_name: row.ingredient_name,
      quantity: row.line_quantity,
      unit: row.line_unit,
      yield_percent: row.line_yield_percent || 100,
      raw_weight_grams: row.line_raw_weight_grams,
      yielded_weight_grams: row.line_yielded_weight_grams,
      cost: row.line_cost
    });
  }
});
const outputRows = [...recipesByCode.values()].map((recipe) => {
  const lineIngredients = recipe.ingredients
    .map((line) => byCode.get(String(line.item_code || '').toLowerCase()))
    .filter(Boolean)
    .map((ingredient) => ({ ...ingredient, id: ingredient.item_code }));
  const snapshot = calculateRecipeCostingSnapshot(recipe, lineIngredients, []);
  const missingMasterLines = recipe.ingredients.filter((line) => !byCode.has(String(line.item_code || '').toLowerCase()));
  const incompatibleLines = recipe.ingredients.filter((line) => {
    const ingredient = byCode.get(String(line.item_code || '').toLowerCase());
    return ingredient && !isIngredientUnitCompatible(line.unit, ingredient.unit, ingredient);
  });
  return {
    recipe_code: recipe.recipe_code,
    recipe_name: recipe.name,
    servings: recipe.servings,
    ingredient_lines: recipe.ingredients.length,
    mapped_master_lines: recipe.ingredients.length - missingMasterLines.length,
    missing_master_lines: missingMasterLines.length,
    incompatible_unit_lines: incompatibleLines.length,
    has_full_cost: missingMasterLines.length === 0 && incompatibleLines.length === 0 && snapshot.has_cost ? 'YES' : 'NO',
    cost_per_serving: snapshot.cost_per_serving ?? '',
    total_cost: snapshot.total_cost ?? '',
    missing_items: missingMasterLines.map((line) => `${line.item_code}:${line.ingredient_name}`).join(' | '),
    incompatible_units: incompatibleLines.map((line) => {
      const ingredient = byCode.get(String(line.item_code || '').toLowerCase());
      return `${line.item_code}:${line.ingredient_name} ${line.quantity}${line.unit}->${ingredient.unit}`;
    }).join(' | ')
  };
});

const headers = [
  'recipe_code',
  'recipe_name',
  'servings',
  'ingredient_lines',
  'mapped_master_lines',
  'missing_master_lines',
  'incompatible_unit_lines',
  'has_full_cost',
  'cost_per_serving',
  'total_cost',
  'missing_items',
  'incompatible_units'
];
fs.writeFileSync(
  outputPath,
  `${headers.join(',')}\n${outputRows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')).join('\n')}\n`,
  'utf8'
);

console.log(JSON.stringify({
  recipes: outputRows.length,
  fullCostRecipes: outputRows.filter((row) => row.has_full_cost === 'YES').length,
  recipesMissingMaster: outputRows.filter((row) => row.missing_master_lines > 0).length,
  output: outputPath
}, null, 2));
