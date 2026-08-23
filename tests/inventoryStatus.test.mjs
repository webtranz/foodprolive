import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  deriveInventoryRecord,
  deriveInventoryStatus,
  hasLowStockAlert
} from '../shared/inventoryStatus.js';

assert.equal(deriveInventoryStatus(16, 10), 'in_stock');
assert.equal(deriveInventoryStatus(10, 10), 'low_stock');
assert.equal(deriveInventoryStatus(9.999, 10), 'low_stock');
assert.equal(deriveInventoryStatus(10.001, 10), 'in_stock');
assert.equal(deriveInventoryStatus(0, 10), 'out_of_stock');
assert.equal(deriveInventoryStatus(-1, 10), 'out_of_stock');
assert.equal(deriveInventoryStatus(1, 0), 'in_stock');
assert.equal(deriveInventoryStatus(undefined, undefined), 'out_of_stock');
assert.equal(deriveInventoryStatus(Number.POSITIVE_INFINITY, 10), 'out_of_stock');
assert.equal(deriveInventoryStatus('16', '10'), 'in_stock');

const staleRecord = {
  ingredient_name: 'Cheese Mozzarella',
  quantity: 16,
  min_stock_level: 10,
  status: 'low_stock',
  total_value: 1040
};
const repairedStaleRecord = deriveInventoryRecord(staleRecord);

assert.equal(repairedStaleRecord.status, 'in_stock');
assert.equal(repairedStaleRecord.total_value, 1040);
assert.equal(staleRecord.status, 'low_stock');
assert.notEqual(repairedStaleRecord, staleRecord);
assert.equal(hasLowStockAlert(repairedStaleRecord), false);
assert.equal(hasLowStockAlert({ quantity: 10, min_stock_level: 10 }), true);
assert.equal(hasLowStockAlert({ quantity: 0, min_stock_level: 0 }), true);

const beforeThresholdEdit = deriveInventoryRecord({
  quantity: 16,
  min_stock_level: 20,
  status: 'low_stock'
});
const afterThresholdEdit = deriveInventoryRecord({
  ...beforeThresholdEdit,
  min_stock_level: 10
});
assert.equal(beforeThresholdEdit.status, 'low_stock');
assert.equal(afterThresholdEdit.status, 'in_stock');

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const database = read('server/db.js');
const inventory = read('server/inventory.js');
const procurement = read('server/procurement.js');

assert.match(database, /hydrateDerivedFields\(entity, row\.data\)/);
assert.match(database, /entity === 'Inventory' \? deriveInventoryRecord\(record\) : record/);
assert.match(database, /result\.rowCount \? hydrateDerivedFields\(entity, result\.rows\[0\]\.data\) : null/);
assert.match(inventory, /low_stock_alert: hasLowStockAlert\(derivedItem\)/);
assert.match(procurement, /const status = deriveInventoryStatus\(quantity, minimum\)/);
assert.doesNotMatch(procurement, /lowByStatus \|\| lowByThreshold/);

console.log('Inventory status derivation tests passed.');
