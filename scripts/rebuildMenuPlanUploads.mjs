import fs from 'node:fs';
import path from 'node:path';
import { parseCsvLine } from '../server/utilities.js';

const directory = path.resolve('artifacts/menu-planning-kbr-384');
const recipeFiles = [
  'GENERAL RECIPES-KBR-384-102-SOURCE.csv',
  'FILIPINO-RECIPES-KBR-384-28-.csv'
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/onego/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function readCsv(fileName) {
  const lines = fs.readFileSync(path.join(directory, fileName), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const recipes = recipeFiles.flatMap(readCsv);
const recipeByReference = new Map();
recipes.forEach((recipe) => {
  [recipe.recipe_code, recipe.name].forEach((reference) => {
    const key = normalize(reference);
    if (key && !recipeByReference.has(key)) recipeByReference.set(key, recipe);
  });
});

const menuFiles = fs.readdirSync(directory)
  .filter((fileName) => /^MENU-PLAN-KBR-384-.*\.csv$/i.test(fileName));
const summary = [];

for (const fileName of menuFiles) {
  const source = fs.readFileSync(path.join(directory, fileName), 'utf8');
  const lines = source.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  const mealsIndex = headers.indexOf('meals');
  const unresolved = [];
  let resolved = 0;
  const outputRows = lines.map((line, index) => {
    const values = parseCsvLine(line);
    const meals = JSON.parse(values[mealsIndex]);
    meals.forEach((meal) => {
      const recipe = [meal.recipe_id, meal.recipe_code, meal.recipe_name]
        .map((reference) => recipeByReference.get(normalize(reference)))
        .find(Boolean);
      if (!recipe) {
        unresolved.push(`row ${index + 2}: ${meal.recipe_code || meal.recipe_name || 'missing recipe'}`);
        return;
      }
      meal.recipe_id = recipe.recipe_code;
      meal.recipe_code = recipe.recipe_code;
      meal.recipe_name = recipe.name;
      resolved += 1;
    });
    values[mealsIndex] = JSON.stringify(meals);
    return values.map(csvCell).join(',');
  });

  if (unresolved.length) {
    throw new Error(`${fileName} has unresolved recipes: ${unresolved.slice(0, 5).join('; ')}`);
  }

  const outputName = fileName.replace(/^MENU-PLAN-/, 'DIRECT-UPLOAD-MENU-PLAN-');
  fs.writeFileSync(path.join(directory, outputName), `${headers.map(csvCell).join(',')}\r\n${outputRows.join('\r\n')}\r\n`, 'utf8');
  summary.push({ fileName: outputName, rows: outputRows.length, recipes: resolved });
}

console.table(summary);
