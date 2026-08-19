import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function assertVisibleCodeThenName(relativePath) {
  const contents = source(relativePath);
  const codeIndex = contents.indexOf('Item Code');
  const nameIndex = contents.indexOf('Item Name');
  assert.ok(codeIndex >= 0, `${relativePath} should display Item Code`);
  assert.ok(nameIndex > codeIndex, `${relativePath} should display Item Name after Item Code`);
}

test('ingredient-centric workspaces show item code before item name', () => {
  [
    'src/components/recipes/RecipeForm.jsx',
    'src/pages/Production.jsx',
    'src/pages/ProductionCalculator.jsx',
    'src/pages/ProductionTransfer.jsx',
    'src/pages/CostControl.jsx',
    'src/pages/Reports.jsx',
    'src/pages/YieldCost.jsx',
    'src/pages/EventPlanning.jsx',
    'src/pages/FoodWaste.jsx',
    'src/pages/MenuBuilder.jsx'
  ].forEach(assertVisibleCodeThenName);
});

test('ingredient-centric exports put item_code and item_name first', () => {
  [
    'src/components/yield/CostReport.jsx',
    'src/pages/AdvancedReports.jsx',
    'src/pages/CostControl.jsx',
    'src/pages/FoodWaste.jsx',
    'src/pages/MenuBuilder.jsx'
  ].forEach((relativePath) => {
    const contents = source(relativePath);
    assert.match(
      contents,
      /item_code:[\s\S]{0,500}?item_name:/,
      `${relativePath} should export item_name after item_code`
    );
  });

  const yieldTemplate = source('src/components/yield/YieldTemplateDownload.jsx');
  assert.match(yieldTemplate, /headers:\s*\['item_code',\s*'name'/);
});

test('event item-code lookup is permission-safe and production export keeps legacy labels clean', () => {
  const eventPlanning = source('src/pages/EventPlanning.jsx');
  assert.match(eventPlanning, /enabled:\s*can\('manage_ingredients'\)/);
  assert.doesNotMatch(eventPlanning, /ingredientsQuery\.error\s*\|\|\s*eventDetailQuery\.error/);

  const productionPlanning = source('src/lib/productionPlanning.js');
  assert.match(productionPlanning, /itemCode\s*&&\s*itemCode\s*!==\s*'—'/);
});

console.log('Item-code presentation tests passed.');
