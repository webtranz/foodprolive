import assert from 'node:assert/strict';

import {
  assertInventoryLedgerDeleteAllowed,
  sanitizeInventoryLedgerPayload
} from '../server/entityPreparation.js';

const sanitizedCreate = sanitizeInventoryLedgerPayload('Inventory', {
  site_id: 'store-1',
  ingredient_id: 'ingredient-1',
  unit: 'kg',
  min_stock_level: 10,
  max_stock_level: 50,
  valuation_method: 'fifo',
  quantity: 999,
  available_quantity: 999,
  reserved_quantity: 999,
  on_hand_quantity: 999,
  total_value: 999,
  status: 'in_stock'
});
assert.deepEqual(sanitizedCreate, {
  site_id: 'store-1',
  ingredient_id: 'ingredient-1',
  unit: 'kg',
  min_stock_level: 10,
  max_stock_level: 50,
  valuation_method: 'fifo'
});

const sanitizedUpdate = sanitizeInventoryLedgerPayload('Inventory', {
  site_id: 'another-store',
  ingredient_id: 'another-ingredient',
  unit: 'L',
  min_stock_level: 12,
  max_stock_level: 60,
  reorder_level: 18,
  valuation_method: 'weighted_average',
  quantity: 0,
  available_quantity: 0,
  reserved_quantity: 0,
  on_hand_quantity: 0,
  average_unit_cost: 0
}, { id: 'inventory-1' });
assert.deepEqual(sanitizedUpdate, {
  min_stock_level: 12,
  max_stock_level: 60,
  reorder_level: 18,
  valuation_method: 'weighted_average'
});

assert.throws(
  () => sanitizeInventoryLedgerPayload('InventoryLot', { remaining_quantity: 0 }),
  /protected inventory movement endpoints/
);
assert.throws(
  () => sanitizeInventoryLedgerPayload('InventoryTransaction', { quantity: -1 }),
  /protected inventory movement endpoints/
);

assert.throws(
  () => assertInventoryLedgerDeleteAllowed('InventoryTransaction', { status: 'posted' }),
  /immutable/
);
assert.throws(
  () => assertInventoryLedgerDeleteAllowed('InventoryLot', {
    remaining_quantity: 5,
    reserved_quantity: 0
  }),
  /immutable batch-history/
);
assert.throws(
  () => assertInventoryLedgerDeleteAllowed('InventoryLot', {
    remaining_quantity: 0,
    reserved_quantity: 0
  }),
  /immutable batch-history/
);
assert.throws(
  () => assertInventoryLedgerDeleteAllowed('Inventory', {
    on_hand_quantity: 0,
    reserved_quantity: 0
  }, [{ remaining_quantity: 4, reserved_quantity: 4 }]),
  /batch history/
);
assert.throws(
  () => assertInventoryLedgerDeleteAllowed('Inventory', {
    on_hand_quantity: 0,
    reserved_quantity: 0
  }, [], [{ id: 'posted-transaction' }]),
  /posted transactions/
);
assert.doesNotThrow(() => assertInventoryLedgerDeleteAllowed('Inventory', {
  on_hand_quantity: 0,
  reserved_quantity: 0,
  available_quantity: 0
}, []));

console.log('inventory ledger integrity tests passed');
