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

const uploadHeaders = [
  'site_id',
  'site_name',
  'plan_date',
  'meal_type',
  'menu_type',
  'menu_category',
  'status',
  'line_number',
  'line_type',
  'recipe_id',
  'recipe_code',
  'recipe_name',
  'ingredient_id',
  'ingredient_name',
  'item_name',
  'expected_servings',
  'planned_weight_kg',
  'planned_weight_grams',
  'planned_unit',
  'estimated_cost',
  'event_name',
  'event_date',
  'expected_participants',
  'budget_amount',
  'notes'
];

const menuFiles = fs.readdirSync(directory)
  .filter((fileName) => /^MENU-PLAN-KBR-384-.*\.csv$/i.test(fileName));
const summary = [];

for (const fileName of menuFiles) {
  const source = fs.readFileSync(path.join(directory, fileName), 'utf8');
  const lines = source.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  const mealsIndex = headers.indexOf('meals');
  const headerIndex = (name) => headers.indexOf(name);
  const unresolved = [];
  let resolved = 0;
  const outputRows = [];
  lines.forEach((line, index) => {
    const values = parseCsvLine(line);
    const read = (name) => {
      const position = headerIndex(name);
      return position >= 0 ? values[position] || '' : '';
    };
    const base = {
      site_id: read('site_id'),
      site_name: read('site_name'),
      plan_date: read('plan_date'),
      menu_type: read('menu_type') || read('cuisine_type') || 'general',
      menu_category: read('menu_category') || 'senior',
      status: read('status') || 'draft',
      event_name: read('event_name'),
      event_date: read('event_date'),
      expected_participants: read('expected_participants'),
      budget_amount: read('budget_amount'),
      notes: read('notes')
    };
    if (mealsIndex < 0) {
      outputRows.push(Object.fromEntries(uploadHeaders.map((header) => [header, read(header)])));
      return;
    }
    const meals = JSON.parse(values[mealsIndex]);
    meals.forEach((meal, mealIndex) => {
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
      outputRows.push({
        ...base,
        meal_type: meal.meal_type || read('meal_type'),
        menu_category: meal.menu_category || base.menu_category,
        line_number: meal.line_number || mealIndex + 1,
        line_type: 'recipe',
        recipe_id: recipe.recipe_code,
        recipe_code: recipe.recipe_code,
        recipe_name: recipe.name,
        ingredient_id: '',
        ingredient_name: '',
        item_name: recipe.name,
        expected_servings: meal.expected_servings || '',
        planned_weight_kg: '',
        planned_weight_grams: '',
        planned_unit: '',
        estimated_cost: meal.total_cost || ''
      });
    });
  });

  if (unresolved.length) {
    throw new Error(`${fileName} has unresolved recipes: ${unresolved.slice(0, 5).join('; ')}`);
  }

  const outputName = fileName.replace(/^MENU-PLAN-/, 'DIRECT-UPLOAD-MENU-PLAN-');
  fs.writeFileSync(
    path.join(directory, outputName),
    `${uploadHeaders.map(csvCell).join(',')}\r\n${outputRows.map((row) => uploadHeaders.map((header) => csvCell(row[header])).join(',')).join('\r\n')}\r\n`,
    'utf8'
  );
  summary.push({ fileName: outputName, rows: outputRows.length, recipes: resolved });
}

console.table(summary);
