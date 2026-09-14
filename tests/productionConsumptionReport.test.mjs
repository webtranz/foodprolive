import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  authorizeEntityAction,
  entityRegistry,
  validateEntityPayload
} from '../server/entities.js';

function source(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function assertHttpError(run, { status, message }) {
  assert.throws(run, (error) => {
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  });
}

function assertItemCodeBeforeItemName(contents, message) {
  const codeIndex = contents.indexOf('<TableHead>Item Code</TableHead>');
  const nameIndex = contents.indexOf('<TableHead>Item Name</TableHead>');
  assert.ok(codeIndex >= 0, `${message} should include Item Code`);
  assert.ok(nameIndex >= 0, `${message} should include Item Name`);
  assert.ok(codeIndex < nameIndex, `${message} should show Item Code before Item Name`);
}

const administrator = {
  id: 'admin-1',
  email: 'admin@example.test',
  role: 'admin',
  role_permissions: ['manage_production', 'complete_production']
};

test('production consumption report schema requires stable identity and applies immutable-report defaults', () => {
  assert.deepEqual(
    entityRegistry.ProductionConsumptionReport.unique.map((rule) => rule.fields),
    [['production_id'], ['report_number']]
  );

  const report = validateEntityPayload('ProductionConsumptionReport', {
    report_number: '  PCR-20260824-00000001  ',
    report_name: '  PCR-20260824-00000001 · Chicken Rice  ',
    production_id: '  production-1  ',
    target_servings: '250',
    total_consumption_cost: '1250.75'
  });

  assert.equal(report.report_number, 'PCR-20260824-00000001');
  assert.equal(report.report_name, 'PCR-20260824-00000001 · Chicken Rice');
  assert.equal(report.production_id, 'production-1');
  assert.equal(report.target_servings, 250);
  assert.equal(report.total_consumption_cost, 1250.75);
  assert.equal(report.status, 'posted');
  assert.deepEqual(report.ingredient_lines, []);
  assert.deepEqual(report.sections, []);

  assertHttpError(
    () => validateEntityPayload('ProductionConsumptionReport', {
      report_number: 'PCR-20260824-00000002',
      report_name: '   ',
      production_id: 'production-2'
    }),
    { status: 400, message: /Report name is required/ }
  );
});

test('consumption reports cannot be created, changed, or deleted through generic entity mutations', () => {
  for (const action of ['create', 'update', 'delete']) {
    assertHttpError(
      () => authorizeEntityAction(
        administrator,
        'ProductionConsumptionReport',
        action,
        { status: 'posted' },
        { id: 'report-1', status: 'posted' }
      ),
      {
        status: 409,
        message: /immutable and are generated only by completing production/
      }
    );
  }
});

test('generic production mutations cannot bypass completion posting or rewrite completed production', () => {
  assertHttpError(
    () => authorizeEntityAction(
      administrator,
      'Production',
      'create',
      { status: 'completed' }
    ),
    { status: 409, message: /must start as Production Created or Pending PM Approval/ }
  );

  assertHttpError(
    () => authorizeEntityAction(
      administrator,
      'Production',
      'update',
      { status: 'completed' },
      { id: 'production-1', status: 'in_progress' }
    ),
    { status: 409, message: /Use the production completion action/ }
  );

  assertHttpError(
    () => authorizeEntityAction(
      administrator,
      'Production',
      'update',
      { completion_lines: [] },
      { id: 'production-1', status: 'completed' }
    ),
    { status: 409, message: /Completed production and its consumption record are immutable/ }
  );
});

test('completion accepts only the server-owned automatic reconciliation plan', () => {
  const inventorySource = source('server/inventory.js');
  const completionStart = inventorySource.indexOf('async function completeProductionWithExecutor(');
  const completionEnd = inventorySource.indexOf('\nasync function completeProduction(', completionStart);
  const completionBlock = inventorySource.slice(completionStart, completionEnd);
  assert.ok(completionStart >= 0 && completionEnd > completionStart);
  assert.match(completionBlock, /buildAutomaticProductionCompletionPlan\(/);
  assert.match(completionBlock, /quantity_basis: plannedQuantityBasis/);
  assert.match(completionBlock, /reconciliation_mode: 'automatic_yield_plan'/);
  assert.doesNotMatch(completionBlock, /options\?\.ingredient_quantities/);
  assert.doesNotMatch(completionBlock, /options\?\.actual_finished_weight_grams/);
});

test('completion reporting preserves item-code-first reconciliation fields and named report sections', () => {
  const inventorySource = source('server/inventory.js');
  const summaryStart = inventorySource.indexOf('consumptionSummary.push({');
  const summaryEnd = inventorySource.indexOf('\n    });', summaryStart);
  const summaryBlock = inventorySource.slice(summaryStart, summaryEnd);

  assert.ok(summaryStart >= 0, 'completion should build an ingredient consumption summary');
  assert.ok(summaryEnd > summaryStart, 'ingredient consumption summary should have a complete object');
  assert.match(summaryBlock, /item_code:[\s\S]*ingredient_name:/);
  assert.match(
    summaryBlock,
    /planned_quantity:[\s\S]*actual_requested_quantity:[\s\S]*issued_quantity:[\s\S]*shortage_quantity:/
  );
  assert.match(summaryBlock, /quantity_basis:/);
  assert.match(summaryBlock, /recipe_quantity:/);
  assert.match(summaryBlock, /recipe_unit:/);
  assert.match(summaryBlock, /inventory_unit:/);
  assert.match(summaryBlock, /raw_weight_grams:/);
  assert.match(summaryBlock, /yielded_weight_grams:/);
  assert.match(summaryBlock, /conversion_note:/);
  assert.match(summaryBlock, /inventory_transaction_id:/);
  assert.match(summaryBlock, /movement_layers:/);

  const reportStart = inventorySource.indexOf("createDocument('ProductionConsumptionReport'");
  const reportEnd = inventorySource.indexOf("status: 'posted'", reportStart);
  const reportBlock = inventorySource.slice(reportStart, reportEnd);
  assert.ok(reportStart >= 0, 'completion should create a consumption report in its transaction');
  assert.ok(reportEnd > reportStart, 'consumption report should be finalized as posted');
  assert.match(reportBlock, /key: 'ingredient_consumption',[\s\S]*title: 'Ingredient Consumption'/);
  assert.match(reportBlock, /key: 'inventory_lot_usage',[\s\S]*title: 'Inventory Lots Consumed'/);
  assert.match(reportBlock, /key: 'shortages',[\s\S]*title: 'Shortages and Exceptions'/);
  assert.match(reportBlock, /production_issue_dish_count:/);
  assert.match(reportBlock, /menu_issue_items:/);
  assert.match(reportBlock, /total_raw_consumption_weight_grams:/);
  assert.match(reportBlock, /total_yielded_weight_grams:/);

  const productionPage = source('src/pages/Production.jsx');
  const ingredientSectionStart = productionPage.indexOf('>Ingredient Consumption</h3>');
  const ingredientSectionEnd = productionPage.indexOf('>Inventory Lots Consumed</h3>', ingredientSectionStart);
  const ingredientSection = productionPage.slice(ingredientSectionStart, ingredientSectionEnd);
  assert.ok(ingredientSectionStart >= 0, 'production UI should render the ingredient-consumption section');
  assert.ok(ingredientSectionEnd > ingredientSectionStart, 'production UI should keep report sections distinct');
  assertItemCodeBeforeItemName(ingredientSection, 'ingredient consumption');

  const lotSection = productionPage.slice(ingredientSectionEnd);
  assertItemCodeBeforeItemName(lotSection, 'inventory-lot consumption');
});
