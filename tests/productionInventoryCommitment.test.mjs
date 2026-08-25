import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildStockDeductionQuantitySummary,
  calculateProductionCommitmentAdjustment,
  getInventoryLotAvailableQuantity,
  getInventoryLotReservedQuantity,
  getProductionInventoryCommitment,
  hasLegacyPhysicalProductionCommitment,
  hasProductionInventoryCommitment,
  isInventoryLotUsable,
  parseInventoryDate,
  sortInventoryLotsForIssue,
  splitCommittedAllocationLayers,
  validateInventorySettings
} from '../server/inventory.js';
import {
  canCancelProduction,
  canStartApprovedProduction,
  getProductionTransitionPermission,
  hasStartableProductionInventory,
  isAllowedProductionTransition
} from '../shared/productionWorkflow.js';

function source(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function sourceBlock(contents, startNeedle, endNeedle) {
  const start = contents.indexOf(startNeedle);
  const end = contents.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `Expected source block start: ${startNeedle}`);
  assert.ok(end > start, `Expected source block end after ${startNeedle}: ${endNeedle}`);
  return contents.slice(start, end);
}

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

test('lot availability subtracts reservations without changing physical on-hand quantity', () => {
  const lot = {
    id: 'lot-reserved',
    remaining_quantity: 10,
    reserved_quantity: 4,
    status: 'active',
    stock_date: '2026-08-01',
    expiry_date: '2026-09-01'
  };

  assert.equal(getInventoryLotReservedQuantity(lot), 4);
  assert.equal(
    getInventoryLotAvailableQuantity(lot, { asOfDate: '2026-08-25' }),
    6
  );
  assert.equal(lot.remaining_quantity, 10, 'reserving stock must not change physical on-hand');
  assert.equal(getInventoryLotReservedQuantity({ ...lot, reserved_quantity: 12 }), 10);
  assert.equal(
    getInventoryLotAvailableQuantity({ ...lot, reserved_quantity: 12 }, { asOfDate: '2026-08-25' }),
    0,
    'free stock can never become negative'
  );
  assert.equal(
    getInventoryLotAvailableQuantity({ ...lot, status: 'blocked' }, { asOfDate: '2026-08-25' }),
    0,
    'unusable stock is not allocatable even when it has physical balance'
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

test('legacy commitments require exact physical transaction evidence before start recognition', () => {
  const evidencedLegacy = {
    status: 'committed',
    lines: [{
      ingredient_id: 'rice',
      committed_quantity: 5,
      inventory_transaction_ids: ['transaction-1'],
      allocation_layers: [{
        inventory_lot_id: 'lot-1',
        quantity: 5,
        source_transaction_id: 'transaction-1'
      }]
    }]
  };

  assert.equal(hasLegacyPhysicalProductionCommitment(evidencedLegacy), true);
  assert.equal(hasLegacyPhysicalProductionCommitment({
    ...evidencedLegacy,
    lines: evidencedLegacy.lines.map((line) => ({
      ...line,
      inventory_transaction_ids: [],
      allocation_layers: line.allocation_layers.map(({ source_transaction_id: _ignored, ...layer }) => layer)
    }))
  }), false, 'metadata-only commitments must not be mistaken for already deducted stock');
  assert.equal(hasLegacyPhysicalProductionCommitment({
    ...evidencedLegacy,
    lines: [{ ...evidencedLegacy.lines[0], committed_quantity: 6 }]
  }), false, 'transaction evidence must reconcile to the committed quantity');
  assert.equal(hasLegacyPhysicalProductionCommitment({
    ...evidencedLegacy,
    stock_model: 'reserve_then_consume_v1'
  }), false, 'current reservations always use the physical start-consumption path');
  assert.equal(hasLegacyPhysicalProductionCommitment({
    status: 'committed',
    committed_at: '2026-08-25T08:00:00.000Z',
    lines: []
  }), false, 'a timestamp alone is not proof that inventory was deducted');

  const inventorySource = source('server/inventory.js');
  assert.match(
    inventorySource,
    /const repairingUnprovenLegacyCommitment = reservationAccounting[\s\S]*!isCurrentProductionReservation\(current\)/
  );
  assert.match(
    inventorySource,
    /repairingUnprovenLegacyCommitment \? \[\] : Array\.isArray\(current\.lines\)/,
    'unproven legacy lines must be rebuilt as reservations rather than trusted as physical deductions'
  );
});

test('start gate requires a complete current reservation and rejects shortages or consumed state', () => {
  const reservation = {
    revision: 2,
    status: 'reserved',
    stock_model: 'reserve_then_consume_v1',
    site_id: 'store-one',
    total_desired_quantity: 5,
    total_shortage_quantity: 0,
    lines: [{
      ingredient_id: 'rice',
      desired_quantity: 5,
      reserved_quantity: 5,
      committed_quantity: 5,
      allocation_layers: [{ inventory_lot_id: 'lot-one', quantity: 5 }]
    }]
  };
  const production = {
    status: 'approved',
    area_approval_status: 'approved',
    area_approved_at: '2026-08-25T08:00:00.000Z',
    material_request_status: 'acknowledged',
    fulfillment_store_id: 'store-one',
    ingredients_used: [{ ingredient_id: 'rice', required_quantity: 5, unit: 'kg' }],
    inventory_commitment: reservation
  };

  assert.equal(hasStartableProductionInventory(production), true);
  assert.equal(canStartApprovedProduction(production), true);
  assert.equal(canStartApprovedProduction({
    ...production,
    inventory_commitment: { ...reservation, status: 'partially_reserved' }
  }), false);
  assert.equal(canStartApprovedProduction({
    ...production,
    inventory_commitment: { ...reservation, total_shortage_quantity: 0.25 }
  }), false);
  assert.equal(canStartApprovedProduction({
    ...production,
    inventory_commitment: {
      ...reservation,
      lines: [{ ...reservation.lines[0], reserved_quantity: 4.5, committed_quantity: 4.5 }]
    }
  }), false);
  assert.equal(canStartApprovedProduction({
    ...production,
    inventory_commitment: { ...reservation, status: 'consumed' }
  }), false, 'an already consumed reservation cannot authorize another start');
  assert.equal(canStartApprovedProduction({
    ...production,
    inventory_commitment: { ...reservation, lines: [] }
  }), false, 'a reservation with material demand must include ingredient allocations');
});

test('approval reserves without a physical transaction and start consumes exactly once', () => {
  const inventorySource = source('server/inventory.js');
  const reserveBlock = sourceBlock(
    inventorySource,
    'async function reserveStockWithExecutor({',
    'async function releaseReservedStockLayersWithExecutor({'
  );
  const releaseBlock = sourceBlock(
    inventorySource,
    'async function releaseReservedStockLayersWithExecutor({',
    'export async function consumeProductionInventoryReservation({'
  );
  const consumeBlock = sourceBlock(
    inventorySource,
    'export async function consumeProductionInventoryReservation({',
    'export async function reconcileProductionInventoryCommitment({'
  );

  assert.match(reserveBlock, /reserved_quantity: reservedAfter/);
  assert.match(reserveBlock, /quantity_before: remaining,[\s\S]*quantity_after: remaining/);
  assert.doesNotMatch(reserveBlock, /postInventoryTransaction|deductStockWithExecutor/);
  assert.doesNotMatch(releaseBlock, /postInventoryTransaction|returnStockToCommittedLotsWithExecutor/);

  assert.match(consumeBlock, /if \(\['consumed', 'partially_consumed'\]\.includes\(currentStatus\)\)[\s\S]*mutated: false/);
  assert.match(consumeBlock, /remaining_quantity: remainingAfter,[\s\S]*reserved_quantity: reservedAfter/);
  assert.match(consumeBlock, /transaction_type: 'production_use'/);
  assert.match(consumeBlock, /source: 'production_start'/);
  assert.match(consumeBlock, /idempotency_key: `\$\{effectiveOperationId\}:\$\{line\.ingredient_id\}:consume`/);
  assert.doesNotMatch(consumeBlock, /transaction_type: 'production_commitment'/);
});

test('server start transition reserves or validates first, then consumes in the same transaction', () => {
  const serverSource = source('server/index.js');
  assert.match(serverSource, /consumeProductionInventoryReservation,/);
  const startBlock = sourceBlock(
    serverSource,
    "normalizeProductionStatus(request.body?.status) === 'in_progress'",
    'let saved = await updateDocument(entity, request.params.id, transactionPayload, client);'
  );
  const reconcileIndex = startBlock.indexOf('reconcileProductionInventoryForWorkflow({');
  const consumeIndex = startBlock.indexOf('consumeProductionInventoryReservation({');
  assert.ok(reconcileIndex >= 0, 'start must establish or validate a reservation');
  assert.ok(consumeIndex > reconcileIndex, 'physical consumption must follow reservation validation');
  assert.match(startBlock, /production: reservationReadyProduction/);
  assert.match(startBlock, /consumptionResult\.inventory_mutated/);
  assert.match(startBlock, /\.\.\.commitmentResult\.production_patch,[\s\S]*\.\.\.consumptionResult\.production_patch/);

  const inventorySource = source('server/inventory.js');
  assert.match(
    inventorySource,
    /isCurrentProductionReservation\(current\)[\s\S]*String\(current\.site_id\) !== String\(stockSite\.id\)[\s\S]*different fulfillment Store/
  );
});

test('reservation and consumption audit fields remain server-owned', () => {
  const preparationSource = source('server/entityPreparation.js');
  const productionBlock = sourceBlock(
    preparationSource,
    "if (entity === 'Production') {",
    '\n  return merged;'
  );
  for (const field of [
    'inventory_commitment',
    'inventory_reserved_at',
    'inventory_reserved_by',
    'inventory_consumed_at',
    'inventory_consumed_by'
  ]) {
    assert.match(productionBlock, new RegExp(`['\"]${field}['\"]`));
  }
  assert.match(productionBlock, /workflowManagedFields\.forEach\(\(field\) => delete userPayload\[field\]\)/);
});

test('stock reports expose free, reserved, and physical quantities while valuing physical usable stock', () => {
  const inventorySource = source('server/inventory.js');
  const reportBlock = sourceBlock(
    inventorySource,
    'async function getStockOnHandReport({',
    'async function getStockMovementReport({'
  );

  assert.match(reportBlock, /reservedQuantity[\s\S]*getInventoryLotReservedQuantity/);
  assert.match(reportBlock, /availableQuantity[\s\S]*getInventoryLotAvailableQuantity/);
  assert.match(reportBlock, /fifoValue[\s\S]*usableLots\.reduce/);
  assert.match(reportBlock, /weightedValue[\s\S]*usableLots\.reduce/);
  assert.match(reportBlock, /average_unit_cost: usableQuantity > 0/);
  assert.match(reportBlock, /available_quantity: roundQuantity\(availableQuantity\)/);
  assert.match(reportBlock, /reserved_quantity: roundQuantity\(reservedQuantity\)/);
  assert.match(reportBlock, /on_hand_quantity: roundQuantity\(onHandQuantity\)/);

  const valuationBlock = sourceBlock(
    inventorySource,
    'async function getInventoryValuationReport({',
    '\nexport {'
  );
  assert.match(
    valuationBlock,
    /item\.usable_on_hand_quantity \?\? item\.on_hand_quantity \?\? item\.quantity/,
    'valuation quantity must remain physical when approval reduces free stock'
  );
  assert.match(valuationBlock, /item\.weighted_average_value/);
  assert.doesNotMatch(valuationBlock, /const quantity = toNumber\(item\.quantity/);
});

test('completion reconciles current physical movements while preserving exact consumed layers', () => {
  const inventorySource = source('server/inventory.js');
  const completionBlock = sourceBlock(
    inventorySource,
    'async function completeProductionWithExecutor(',
    'async function completeProduction('
  );

  assert.match(completionBlock, /operation: 'completion_reconciliation'/);
  assert.match(completionBlock, /asOfDate: toDateOnly\(\)/);
  assert.doesNotMatch(
    completionBlock,
    /operation: 'completion_reconciliation'[\s\S]{0,800}asOfDate: production\.production_date/
  );
  assert.match(completionBlock, /movement_layers: Array\.isArray\(committedLine\.allocation_layers\)/);
  assert.match(completionBlock, /inventory_transaction_ids: movement\.transaction_ids/);
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
