import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateEntityPayload } from '../server/entities.js';

function source(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('admins can directly reverse completed production without creating a separate workflow', () => {
  const server = source('server/index.js');
  const routeStart = server.indexOf("app.post('/api/inventory/production/:id/reverse-completion'");
  const routeEnd = server.indexOf("app.get('/api/inventory/lots'", routeStart);
  assert.ok(routeStart >= 0, 'production reversal route should exist');
  assert.ok(routeEnd > routeStart, 'production reversal route should be near inventory production routes');
  const route = server.slice(routeStart, routeEnd);

  assert.match(route, /requireAuth,\s*requireRole\(\['admin'\]\)/);
  assert.match(route, /reverseCompletedProduction\(request\.params\.id,\s*request\.user/);
  assert.match(route, /PRODUCTION_COMPLETION_REVERSED/);
  assert.doesNotMatch(route, /pending_reversal|submit.*reversal|approve.*reversal/i);
});

test('admins can diagnose and repair stale produced-output balances before reversal', () => {
  const server = source('server/index.js');
  const inventory = source('server/inventory.js');
  const api = source('src/api/base44Client.js');
  const productionPage = source('src/pages/Production.jsx');

  assert.match(server, /app\.get\('\/api\/inventory\/production\/:id\/reversal-blockers',\s*requireAuth,\s*requireRole\(\['admin'\]\)/);
  assert.match(server, /app\.post\('\/api\/inventory\/production\/:id\/repair-reversal-balance',\s*requireAuth,\s*requireRole\(\['admin'\]\)/);
  assert.match(server, /getProductionReversalBlockers\(request\.params\.id,\s*\{\s*location\s*\}\)/);
  assert.match(server, /repairProductionReversalBalance\(request\.params\.id,\s*request\.user/);
  assert.match(server, /PRODUCTION_REVERSAL_BALANCE_REPAIRED/);

  assert.match(inventory, /async function getProductionReversalBlockers\(/);
  assert.match(inventory, /async function repairProductionReversalBalance/);
  assert.match(inventory, /active_meal_service_rows/);
  assert.match(inventory, /active_food_waste_rows/);
  assert.match(inventory, /can_repair_stale_balance/);

  assert.match(api, /getProductionReversalBlockers\(id\)/);
  assert.match(api, /repairProductionReversalBalance\(id,\s*data = \{\}\)/);
  assert.match(productionPage, /Blocking records/);
  assert.match(productionPage, /Repair stale batch balance/);
  assert.match(inventory, /No active produced-output usage blockers detected/);
  assert.match(productionPage, /base44\.inventory\.getProductionReversalBlockers/);
  assert.match(productionPage, /base44\.inventory\.repairProductionReversalBalance/);
});

test('production reversal uses saved completion evidence and freezes the old attempt as audit only', () => {
  const inventory = source('server/inventory.js');
  const start = inventory.indexOf('async function reverseCompletedProductionWithExecutor(');
  const end = inventory.indexOf('\nasync function completeProduction(', start);
  assert.ok(start >= 0 && end > start, 'reverseCompletedProductionWithExecutor should be defined before export wrapper');
  const reversal = inventory.slice(start, end);

  assert.match(reversal, /String\(production\.status \|\| ''\)\.toLowerCase\(\) !== 'completed'/);
  assert.match(reversal, /getProductionReversalLines\(production,\s*report\)/);
  assert.match(reversal, /returnStockToCommittedLotsWithExecutor\(/);
  assert.match(reversal, /Cannot reverse \$\{ingredientName\} because the exact consumed inventory lots are missing/);
  assert.match(reversal, /status:\s*'voided'/);
  assert.match(reversal, /status:\s*'reversed'/);
  assert.doesNotMatch(reversal, /status:\s*'in_progress'/);
  assert.match(reversal, /reversal_locked:\s*true/);
  assert.match(reversal, /reversal_summary/);
  assert.match(reversal, /ingredients_used/);
  assert.doesNotMatch(reversal, /buildAutomaticProductionCompletionPlan\(/);
});

test('voided and reversed records do not block clean re-completion', () => {
  const database = source('server/db.js');
  const mealService = source('server/mealService.js');
  const inventory = source('server/inventory.js');
  const sql = source('server/sql/init.sql');

  assert.match(database, /entity === 'ProducedItemBatch'[\s\S]*fields\.includes\('production_id'\) \|\| fields\.includes\('batch_number'\)[\s\S]*status \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'voided'[\s\S]*return false/);
  assert.match(database, /entity === 'ProductionConsumptionReport'[\s\S]*status \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'reversed'[\s\S]*return false/);
  assert.match(mealService, /find\(\(batch\) => String\(batch\.status \|\| ''\)\.toLowerCase\(\) !== 'voided'\)/);
  assert.match(inventory, /find\(\(batch\) => String\(batch\.status \|\| ''\)\.toLowerCase\(\) !== 'voided'\) \|\| null/);
  assert.match(sql, /DROP INDEX IF EXISTS idx_entity_records_produced_item_production_unique;/);
  assert.match(sql, /idx_entity_records_produced_item_production_unique[\s\S]*COALESCE\(data->>'status', ''\) <> 'voided'/);
  assert.match(sql, /DROP INDEX IF EXISTS idx_entity_records_produced_item_batch_number_unique;/);
  assert.match(sql, /idx_entity_records_produced_item_batch_number_unique[\s\S]*COALESCE\(data->>'status', ''\) <> 'voided'/);
});

test('voided produced-item batches keep audit identity but cannot keep active balances', () => {
  const batch = validateEntityPayload('ProducedItemBatch', {
    batch_number: 'PIB-20260914-001',
    production_id: 'production-1',
    production_name: 'Breakfast Menu Junior / General',
    production_date: '2026-09-01',
    completed_at: '2026-09-14T08:00:00.000Z',
    site_id: 'store-384',
    site_name: 'STORE 384',
    recipe_id: 'recipe-1',
    recipe_name: 'Breakfast Menu Junior / General',
    meal_type: 'breakfast',
    menu_type: 'general',
    menu_category: 'junior',
    portion_size_grams: 80,
    expected_servings: 100,
    expected_finished_weight_grams: 8000,
    actual_finished_weight_grams: 8000,
    produced_servings: 100,
    produced_weight_grams: 8000,
    served_servings: 0,
    served_weight_grams: 0,
    wasted_servings: 0,
    wasted_weight_grams: 0,
    remaining_servings: 0,
    remaining_weight_grams: 0,
    status: 'voided',
    cutover_version: 1
  });
  assert.equal(batch.status, 'voided');

  assert.throws(
    () => validateEntityPayload('ProducedItemBatch', {
      ...batch,
      remaining_servings: 1
    }),
    /Voided produced-item batches cannot keep served, wasted, or remaining balances/
  );
});

test('front end exposes an admin-only direct reversal action', () => {
  const api = source('src/api/base44Client.js');
  const productionPage = source('src/pages/Production.jsx');

  assert.match(api, /reverseCompletedProduction\(id,\s*data = \{\}\)/);
  assert.match(api, /\/api\/inventory\/production\/\$\{id\}\/reverse-completion/);
  assert.match(productionPage, /production\.status === 'completed' && isAdmin/);
  assert.match(productionPage, /Reverse Completion/);
  assert.match(productionPage, /Admin-only direct reversal — no approval workflow will be created/);
  assert.match(productionPage, /What was reversed/);
  assert.match(productionPage, /The old card is now audit-only/);
  assert.match(productionPage, /base44\.inventory\.reverseCompletedProduction/);
});

test('admins can partially reverse selected production manifest rows without changing full reversal', () => {
  const server = source('server/index.js');
  const inventory = source('server/inventory.js');
  const api = source('src/api/base44Client.js');
  const productionPage = source('src/pages/Production.jsx');

  const fullRouteStart = server.indexOf("app.post('/api/inventory/production/:id/reverse-completion'");
  const fullRouteEnd = server.indexOf("app.get('/api/inventory/lots'", fullRouteStart);
  const fullRoute = server.slice(fullRouteStart, fullRouteEnd);
  assert.match(fullRoute, /reverseCompletedProduction\(request\.params\.id,\s*request\.user/);
  assert.doesNotMatch(fullRoute, /partialReverseCompletedProduction/);

  assert.match(server, /app\.post\('\/api\/inventory\/production\/:id\/partial-reverse-completion',\s*requireAuth,\s*requireRole\(\['admin'\]\)/);
  assert.match(server, /partialReverseCompletedProduction\(request\.params\.id,\s*request\.user/);
  assert.match(server, /PRODUCTION_COMPLETION_PARTIALLY_REVERSED/);

  assert.match(inventory, /async function reverseCompletedProductionManifestPartWithExecutor/);
  assert.match(inventory, /function getProductionPartialReversalManifestItems/);
  assert.match(inventory, /operation:\s*'production_partial_reversal'/);
  assert.match(inventory, /Use the full Reverse Completion action when reversing the entire remaining production/);
  assert.match(inventory, /assertProducedOutputUnused\(producedItemBatch\)/);
  assert.match(inventory, /returnStockToCommittedLotsWithExecutor\(/);

  assert.match(api, /partialReverseCompletedProduction\(id,\s*data = \{\}\)/);
  assert.match(api, /\/api\/inventory\/production\/\$\{id\}\/partial-reverse-completion/);
  assert.match(productionPage, /Partial Reverse/);
  assert.match(productionPage, /Partial Production Reversal/);
  assert.match(productionPage, /The full Reverse Completion button and full reversal handling remain unchanged/);
  assert.match(productionPage, /base44\.inventory\.partialReverseCompletedProduction/);
});
