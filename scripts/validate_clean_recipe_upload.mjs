import fs from 'node:fs';
import { mapCsvRow, parseCsvLine, validateCsvHeaders } from '../server/utilities.js';

const path = 'C:/Users/HP/Documents/ChatGPT/sbox food pro/artifacts/recipe-upload-one-go-v4-clean/UPLOAD-THIS-RECIPES-KBR-384-102-CLEAN-1SERVING.csv';
const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter(Boolean);
const headers = parseCsvLine(lines[0]);
const headerErrors = validateCsvHeaders('recipes', headers);
const errors = [];
let count = 0;

for (const line of lines.slice(1)) {
  count += 1;
  try {
    const row = mapCsvRow('recipes', headers, parseCsvLine(line));
    if (row.servings !== 1) errors.push(`row ${count}: servings is ${row.servings}`);
    if (!Array.isArray(row.ingredients) || row.ingredients.length === 0) errors.push(`row ${count}: no ingredients`);
    for (const ingredient of row.ingredients || []) {
      if (!ingredient.item_code || !ingredient.ingredient_name || !ingredient.quantity) {
        errors.push(`row ${count}: invalid ingredient ${JSON.stringify(ingredient)}`);
      }
    }
  } catch (error) {
    errors.push(`row ${count}: ${error.message}`);
  }
}

console.log(JSON.stringify({
  headerErrors,
  count,
  errorCount: errors.length,
  errors: errors.slice(0, 20),
}, null, 2));
