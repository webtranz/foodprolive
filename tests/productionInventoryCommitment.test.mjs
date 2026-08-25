import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildStockDeductionQuantitySummary,
  calculateProductionCommitmentAdjustment,
  getProductionInventoryCommitment,
  hasProductionInventoryCommitment,
  isInventoryLotUsable,
  parseInventoryDate,
  sortInventoryLotsForIssue,
  splitCommittedAllocationLayers,
  validateInventorySettings
} from '../server/inventory.js';
import {
  canCancelProduction,
  getProductionTransitionPermission,
  isAllowedProductionTransition
} from '../shared/productionWorkflow.js';

test('strict lot eligibility excludes expired, blocked, and quarantined stock', () => {
  const asOfDate = '2026-08-25';
  assert.equal(isInventoryLotUsable({
    remaining_quantity: 5,
    status: 'active',
    expiry_date: '2026-08-25'
  }, { asOfDate }), true, 'stock remains usable through its expiry date');
  assert.equal(isInventoryLotUsable({
    remaining_quantity: 5,
    status: 'active',
    expiry_date: '2026-08-24'
  }, { asOfDate }), false);
  assert.equal(isInventoryLotUsable({
    remaining_quantity: 5,
    status: 'active',
    stock_date: '2026-08-26'
  }, { asOfDate }), false, 'future-dated stock is not yet available');
  for (const status of ['blocked', 'quarantined', 'quarantine', 'on_hold', 'expired']) {
    assert.equal(isInventoryLotUsable({ remaining_quantity: 5, status }, { asOfDate }), false);
  }
});

test('issue ordering is deterministic FEFO followed by FIFO and stable ID order', () => {
  const lots = [
    { id: 'no-expiry', remaining_quantity: 1, status: 'active', stock_date: '2026-01-01' },
    { id: 'later', remaining_quantity: 1, status: 'active', expiry_date: '2026-09-15', stock_date: '2026-01-01' },
    { id: 'earlier-b', remaining_quantity: 1, status: 'active', expiry_date: '2026-09-01', stock_date: '2026-08-02' },
    { id: 'earlier-a', remaining_quantity: 1, status: 'active', expiry_date: '2026-09-01', stock_date: '2026-08-01' },
    { id: 'blocked', remaining_quantity: 100, status: 'blocked', expiry_date: '2026-08-26' }
  ];

  assert.deepEqual(
    sortInventoryLotsForIssue(lots, { asOfDate: '2026-08-25' }).map((lot) => lot.id),
    ['earlier-a', 'earlier-b', 'later', 'no-expiry']
  );
});

test('commitment deltas are idempotent and reconcile increase, shortage, decrease, and cancellation', () => {
  assert.deepEqual(calculateProductionCommitmentAdjustment(null, 10), {
    previous_desired_quantity: 0,
    previous_committed_quantity: 0,
    previous_shortage_quantity: 0,
    desired_quantity: 10,
    issue_quantity: 10,
    return_quantity: 0
  });
  const full = { desired_quantity: 10, committed_quantity: 10, shortage_quantity: 0 };
  assert.equal(calculateProductionCommitmentAdjustment(full, 10).issue_quantity, 0);
  assert.equal(calculateProductionCommitmentAdjustment(full, 10).return_quantity, 0);
  assert.equal(calculateProductionCommitmentAdjustment(full, 13).issue_quantity, 3);
  assert.equal(calculateProductionCommitmentAdjustment(full, 7).return_quantity, 3);
  assert.equal(calculateProductionCommitmentAdjustment(full, 0).return_quantity, 10);

  const partial = { desired_quantity: 10, committed_quantity: 8, shortage_quantity: 2 };
  assert.equal(
    calculateProductionCommitmentAdjustment(partial, 9).return_quantity,
    0,
    'reducing an unfilled requirement first reduces its shortage without returning stock'
  );
  assert.equal(calculateProductionCommitmentAdjustment(partial, 7).return_quantity, 1);
});

test('deduction summaries preserve six-decimal quantities used by commitment returns', () => {
  const subGramIssue = buildStockDeductionQuantitySummary({
    remainingToDeduct: 0,
    requestedQuantity: 0.0004,
    issuedQuantity: 0.0004
  });
  assert.deepEqual(subGramIssue, {
    shortage_quantity: 0,
    requested_quantity: 0.0004,
    issued_quantity: 0.0004
  });

  const returnAdjustment = calculateProductionCommitmentAdjustment({
    desired_quantity: 0.0004,
    committed_quantity: subGramIssue.issued_quantity,
    shortage_quantity: subGramIssue.shortage_quantity
  }, 0);
  assert.equal(returnAdjustment.return_quantity, 0.0004);
  assert.equal(
    splitCommittedAllocationLayers([
      { inventory_lot_id: 'spice-lot', quantity: 0.0004, unit_cost: 100 }
    ], returnAdjustment.return_quantity).returned_quantity,
    0.0004
  );

  assert.equal(buildStockDeductionQuantitySummary({
    remainingToDeduct: 0,
    requestedQuantity: 1.234567,
    issuedQuantity: 1.234567
  }).issued_quantity, 1.234567);

  const smallestPersistedIssue = calculateProductionCommitmentAdjustment(null, 0.000001);
  assert.equal(smallestPersistedIssue.issue_quantity, 0.000001);
  assert.equal(
    splitCommittedAllocationLayers([
      { inventory_lot_id: 'micro-lot', quantity: 0.000001, unit_cost: 100 }
    ], 0.000001).returned_quantity,
    0.000001
  );
  const source = fs.readFileSync(new URL('../server/inventory.js', import.meta.url), 'utf8');
  assert.match(source, /const QUANTITY_EPSILON = 0\.0000005/);
});

test('decrease and cancellation return the exact most-recent committed lot layers', () => {
  const split = splitCommittedAllocationLayers([
    { inventory_lot_id: 'lot-a', quantity: 6, unit_cost: 2, accounting_unit_cost: 2.4 },
    { inventory_lot_id: 'lot-b', quantity: 4, unit_cost: 3, accounting_unit_cost: 2.4 }
  ], 5);

  assert.deepEqual(split.returned_layers.map((layer) => [layer.inventory_lot_id, layer.quantity]), [
    ['lot-b', 4],
    ['lot-a', 1]
  ]);
  assert.deepEqual(split.retained_layers.map((layer) => [layer.inventory_lot_id, layer.quantity]), [
    ['lot-a', 5]
  ]);
  assert.equal(split.returned_layers[0].accounting_unit_cost, 2.4);
  assert.equal(split.retained_layers[0].accounting_unit_cost, 2.4);
  assert.throws(
    () => splitCommittedAllocationLayers([{ inventory_lot_id: 'lot-a', quantity: 1 }], 2),
    /exact inventory-lot allocation is incomplete/
  );
});

test('inventory settings and dates are strictly normalized before posting', () => {
  assert.deepEqual(validateInventorySettings({
    min_stock_level: '10',
    max_stock_level: '60',
    valuation_method: 'weighted_average'
  }), { min: 10, max: 60, method: 'weighted_average' });
  assert.throws(
    () => validateInventorySettings({ min_stock_level: 11, max_stock_level: 10 }),
    /cannot exceed/
  );
  assert.throws(
    () => validateInventorySettings({ valuation_method: 'lifo' }),
    /FIFO or weighted average/
  );
  assert.equal(parseInventoryDate('2026-08-25', 'Stock date', { required: true }), '2026-08-25');
  assert.throws(() => parseInventoryDate('2026-02-30', 'Stock date'), /valid date/);
});

test('commitment state exposes an explicit revision, status, and preserved lines', () => {
  const production = {
    inventory_commitment_revision: 4,
    inventory_commitment_status: 'committed',
    inventory_committed_servings: 25,
    inventory_committed_lines: [{ ingredient_id: 'rice', committed_quantity: 20 }]
  };
  assert.equal(hasProductionInventoryCommitment(production), true);
  assert.equal(getProductionInventoryCommitment(production).revision, 4);
  assert.equal(getProductionInventoryCommitment(production).status, 'committed');
  assert.equal(getProductionInventoryCommitment(production).target_servings, 25);
  assert.equal(getProductionInventoryCommitment(production).lines[0].ingredient_id, 'rice');
});

test('workflow permits safe pre-start cancellation but not cancellation after production starts', () => {
  for (const status of [
    'draft',
    'planned',
    'changes_requested',
    'pending_approval',
    'pending_procurement',
    'pending_production',
    'approved'
  ]) {
    assert.equal(canCancelProduction(status), true);
    assert.equal(isAllowedProductionTransition(status, 'cancelled'), true);
    assert.equal(getProductionTransitionPermission(status, 'cancelled'), 'cancel_production');
  }
  assert.equal(canCancelProduction('in_progress'), false);
  assert.equal(isAllowedProductionTransition('in_progress', 'cancelled'), false);
});

test('completion preserves legacy behavior only for uncommitted productions and persists reconciliation patch', () => {
  const source = fs.readFileSync(new URL('../server/inventory.js', import.meta.url), 'utf8');
  assert.match(source, /if \(hasProductionInventoryCommitment\(production\)\)[\s\S]*operation: 'completion_reconciliation'/);
  assert.match(source, /const committedLine = completionCommitmentLineMap\.get/);
  assert.match(source, /const movement = committedLine \? \{/);
  assert.match(source, /const completed = await updateDocument\('Production', productionId, \{\s*\.\.\.completionCommitmentPatch,/);
  assert.match(source, /idempotency_key: `\$\{effectiveOperationId\}:\$\{desiredLine\.ingredient_id\}:issue`/);
  assert.match(source, /idempotency_key: `\$\{effectiveOperationId\}:\$\{desiredLine\.ingredient_id\}:return`/);
  assert.match(source, /const openingDifference = Math\.max\(0, legacyQuantity - representedLotQuantity\)/);
});

test('approved quantity route scales the frozen approval snapshot instead of re-expanding live recipe masters', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const adjustmentStart = source.indexOf("app.patch('/api/productions/:id/approved-quantity'");
  const cancellationStart = source.indexOf("app.post('/api/productions/:id/cancel'", adjustmentStart);
  assert.ok(adjustmentStart >= 0 && cancellationStart > adjustmentStart);
  const adjustmentBlock = source.slice(adjustmentStart, cancellationStart);
  assert.match(adjustmentBlock, /scaleApprovedProductionSnapshot\(lockedProduction, targetServings\)/);
  assert.match(adjustmentBlock, /desiredIngredients: approvedSnapshot\.ingredients_used/);
  assert.match(adjustmentBlock, /inventory_approved_snapshot: approvedSnapshot\.inventory_approved_snapshot/);
  assert.doesNotMatch(adjustmentBlock, /prepareEntityPayload\(/);

  const inventorySource = fs.readFileSync(new URL('../server/inventory.js', import.meta.url), 'utf8');
  assert.match(
    inventorySource,
    /const hasApprovedTargetChange = operation === 'approved_quantity_adjustment'[\s\S]*\|\| hasApprovedTargetChange/
  );
});
