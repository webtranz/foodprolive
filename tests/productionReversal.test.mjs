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

test('production reversal uses saved completion evidence and reopens the same manifest', () => {
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
  assert.match(reversal, /status:\s*'in_progress'/);
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
  assert.match(productionPage, /base44\.inventory\.reverseCompletedProduction/);
});
