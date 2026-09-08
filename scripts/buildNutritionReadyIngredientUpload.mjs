import fs from 'node:fs';
import path from 'node:path';
import { parseCsvLine } from '../server/utilities.js';

const sourcePath = path.resolve('artifacts/menu-planning-kbr-384/kbr-384ingredients-upload.csv');
const nutritionPath = path.resolve('artifacts/inventory-ingredients-only/kbr-384-ingredients-upload-sfda-enriched.csv');
const outputPath = path.resolve('artifacts/menu-planning-kbr-384/kbr-384ingredients-upload-nutrition-ready.csv');

const headers = [
  'item_code', 'name', 'ingredient_code', 'sku', 'alias', 'supplier_item_name', 'unit',
  'category', 'cuisine_type', 'cost_per_unit', 'package_base_quantity', 'package_base_unit',
  'calories_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g',
  'sodium_per_100g', 'sugar_per_100g', 'cooking_yield_percent', 'shrinkage_percent',
  'raw_weight_per_unit', 'cooked_weight_per_unit', 'allergens', 'is_active'
];

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const sourceHeaders = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(sourceHeaders.map((header, index) => [header, values[index] || '']));
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const sourceIngredients = readCsv(sourcePath);
const nutritionByCode = new Map(readCsv(nutritionPath).map((ingredient) => [
  String(ingredient.ingredient_code || ingredient.item_code || ingredient.sku).trim(),
  ingredient
]));

const rows = sourceIngredients.map((source) => {
  const itemCode = String(source.ingredient_code || source.sku).trim();
  const nutrition = nutritionByCode.get(itemCode);
  if (!nutrition) throw new Error(`Missing nutrition data for item code ${itemCode}`);

  return {
    item_code: itemCode,
    name: source.ingredient_name,
    ingredient_code: itemCode,
    sku: source.sku || itemCode,
    alias: nutrition.alias,
    supplier_item_name: nutrition.supplier_item_name || source.ingredient_name,
    unit: source.unit,
    category: source.item_group,
    cuisine_type: nutrition.cuisine_type,
    cost_per_unit: source.unit_price,
    package_base_quantity: source.package_base_quantity,
    package_base_unit: source.package_base_unit,
    calories_per_100g: nutrition.calories_per_100g,
    protein_per_100g: nutrition.protein_per_100g,
    carbs_per_100g: nutrition.carbs_per_100g,
    fat_per_100g: nutrition.fat_per_100g,
    sodium_per_100g: nutrition.sodium_per_100g,
    sugar_per_100g: nutrition.sugar_per_100g,
    cooking_yield_percent: nutrition.cooking_yield_percent || source.cooking_yield_percent,
    shrinkage_percent: nutrition.shrinkage_percent,
    raw_weight_per_unit: nutrition.raw_weight_per_unit,
    cooked_weight_per_unit: nutrition.cooked_weight_per_unit,
    allergens: nutrition.allergens || source.allergens,
    is_active: nutrition.is_active || 'TRUE'
  };
});

fs.writeFileSync(
  outputPath,
  `${headers.join(',')}\r\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')).join('\r\n')}\r\n`,
  'utf8'
);

console.log(`Created ${outputPath} with ${rows.length} ingredients and complete available nutrition fields.`);
