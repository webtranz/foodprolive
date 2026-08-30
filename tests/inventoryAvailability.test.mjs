import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  getAvailableInventoryQuantity,
  getInventoryQuantities,
  getProductionInventoryState
} from '../src/lib/inventoryAvailability.js';

assert.deepEqual(getInventoryQuantities({
  quantity: 7,
  on_hand_quantity: 10,
  reserved_quantity: 3,
  available_quantity: 7
}), {
  on_hand_quantity: 10,
  reserved_quantity: 3,
  available_quantity: 7
});

assert.deepEqual(getInventoryQuantities({ quantity: 12 }), {
  on_hand_quantity: 12,
  reserved_quantity: 0,
  available_quantity: 12
});

assert.deepEqual(getInventoryQuantities(null), {
  on_hand_quantity: 0,
  reserved_quantity: 0,
  available_quantity: 0
});
assert.equal(getAvailableInventoryQuantity(null), 0);

assert.deepEqual(getInventoryQuantities({
  remaining_quantity: 9,
  reserved_quantity: 4,
  available_quantity: 5
}), {
  on_hand_quantity: 9,
  reserved_quantity: 4,
  available_quantity: 5
});
assert.equal(getAvailableInventoryQuantity({ on_hand_quantity: 8, reserved_quantity: 2 }), 6);

const reserved = getProductionInventoryState({
  inventory_commitment_status: 'reserved',
  inventory_commitment_revision: 2,
  inventory_reserved_at: '2026-08-25T10:00:00.000Z',
  inventory_committed_lines: [{ ingredient_id: 'rice', reserved_quantity: 3 }]
});
assert.equal(reserved.label, 'Inventory reserved');
assert.equal(reserved.is_reserved, true);
assert.equal(reserved.is_consumed, false);
assert.equal(reserved.revision, 2);
assert.equal(reserved.lines[0].reserved_quantity, 3);

const consumed = getProductionInventoryState({
  inventory_commitment: { status: 'consumed', lines: [] },
  inventory_consumed_at: '2026-08-25T11:00:00.000Z'
});
assert.equal(consumed.label, 'Inventory consumed at start');
assert.equal(consumed.is_consumed, true);

const legacy = getProductionInventoryState({
  inventory_commitment_status: 'committed',
  inventory_committed_at: '2026-08-24T11:00:00.000Z'
});
assert.equal(legacy.label, 'Inventory consumed at approval (legacy)');
assert.equal(legacy.is_legacy_consumption, true);
assert.equal(legacy.consumed_at, '2026-08-24T11:00:00.000Z');

const productionSource = fs.readFileSync(new URL('../src/pages/Production.jsx', import.meta.url), 'utf8');
const inventorySource = fs.readFileSync(new URL('../src/pages/Inventory.jsx', import.meta.url), 'utf8');
const procurementSource = fs.readFileSync(new URL('../src/pages/ProcurementPlanning.jsx', import.meta.url), 'utf8');
const clientSource = fs.readFileSync(new URL('../src/api/base44Client.js', import.meta.url), 'utf8');

assert.match(productionSource, /Approve, Reserve Inventory & Mark Ready/);
assert.match(productionSource, /Start Production & Consume Reserved Stock/);
assert.match(productionSource, /Cancel & Release Reservation/);
assert.match(productionSource, /totalCapacity = stock\.available_quantity \+ ownReserved/);
assert.match(inventorySource, /<TableHead>On Hand<\/TableHead>[\s\S]*<TableHead>Reserved<\/TableHead>[\s\S]*<TableHead>Available<\/TableHead>/);
assert.match(procurementSource, /<TableHead>On Hand<\/TableHead>[\s\S]*<TableHead>Reserved<\/TableHead>[\s\S]*<TableHead>Available<\/TableHead>/);
assert.match(procurementSource, /grossWithBuffer - need\.production_reserved_quantity/);
assert.match(clientSource, /start\(id, data = \{\}\)[\s\S]*status: 'in_progress'/);

console.log('Inventory availability and production reservation UI tests passed.');
