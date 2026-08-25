import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInventoryLotValueRows,
  listAllInventoryReportDocuments
} from '../server/inventoryValueReport.js';

test('lot value report reconstructs period opening, additions, consumption, returns, and closing value', () => {
  const rows = buildInventoryLotValueRows({
    dateFrom: '2026-08-02',
    dateTo: '2026-08-04',
    ingredients: [{ id: 'ingredient-1', name: 'Rice', item_code: 'ITM-001' }],
    lots: [{
      id: 'lot-1',
      site_id: 'store-1',
      site_name: 'Main Store',
      ingredient_id: 'ingredient-1',
      ingredient_name: 'Rice',
      batch_number: 'RICE-A',
      stock_date: '2026-08-01',
      expiry_date: '2027-01-01',
      remaining_quantity: 75,
      unit: 'kg',
      unit_cost: 2
    }],
    transactions: [
      {
        id: 'opening',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-01',
        transaction_type: 'receipt',
        quantity: 100,
        movement_layers: [{ inventory_lot_id: 'lot-1', quantity: 100, quantity_before: 0, quantity_after: 100 }]
      },
      {
        id: 'consume',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-03',
        transaction_type: 'production_commitment',
        quantity: -30,
        source_type: 'production_consumption',
        movement_layers: [{ inventory_lot_id: 'lot-1', quantity: 30, quantity_before: 100, quantity_after: 70 }]
      },
      {
        id: 'return',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-04',
        transaction_type: 'production_return',
        quantity: 10,
        source_type: 'return_or_cancellation',
        movement_layers: [{ inventory_lot_id: 'lot-1', quantity: 10, quantity_before: 70, quantity_after: 80 }]
      },
      {
        id: 'later',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-05',
        transaction_type: 'production_commitment',
        quantity: -5,
        movement_layers: [{ inventory_lot_id: 'lot-1', quantity: 5, quantity_before: 80, quantity_after: 75 }]
      }
    ]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_code, 'ITM-001');
  assert.equal(rows[0].opening_quantity, 100);
  assert.equal(rows[0].addition_quantity, 0);
  assert.equal(rows[0].consumption_quantity, 30);
  assert.equal(rows[0].return_quantity, 10);
  assert.equal(rows[0].closing_quantity, 80);
  assert.equal(rows[0].closing_value, 160);
});

test('snapshot corrections are separated from ordinary additions and consumption', () => {
  const [row] = buildInventoryLotValueRows({
    dateFrom: '2026-08-01',
    dateTo: '2026-08-31',
    lots: [{
      id: 'lot-2',
      site_id: 'store-1',
      ingredient_id: 'ingredient-2',
      remaining_quantity: 8,
      unit_cost: 5
    }],
    transactions: [{
      id: 'correction',
      site_id: 'store-1',
      ingredient_id: 'ingredient-2',
      transaction_date: '2026-08-10',
      transaction_type: 'adjustment',
      source_type: 'stock_correction',
      quantity: -2,
      movement_layers: [{ inventory_lot_id: 'lot-2', quantity: 2, quantity_before: 10, quantity_after: 8 }]
    }]
  });

  assert.equal(row.opening_quantity, 10);
  assert.equal(row.correction_quantity, -2);
  assert.equal(row.consumption_quantity, 0);
  assert.equal(row.closing_quantity, 8);
});

test('historical values use movement accounting costs instead of the currently repriced lot cost', () => {
  const [row] = buildInventoryLotValueRows({
    dateFrom: '2026-08-02',
    dateTo: '2026-08-04',
    lots: [{
      id: 'weighted-lot',
      site_id: 'store-1',
      ingredient_id: 'ingredient-1',
      stock_date: '2026-08-01',
      remaining_quantity: 90,
      unit_cost: 7,
      accounting_unit_cost: 99
    }],
    transactions: [
      {
        id: 'receipt-before-period',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-01',
        transaction_type: 'receipt',
        quantity: 100,
        total_cost: 200,
        movement_layers: [{
          inventory_lot_id: 'weighted-lot',
          quantity_before: 0,
          quantity_after: 100,
          quantity: 100,
          accounting_unit_cost: 2,
          accounting_total_cost: 200
        }]
      },
      {
        id: 'issue-in-period',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-03',
        transaction_type: 'production_commitment',
        quantity: -20,
        total_cost: 40,
        movement_layers: [{
          inventory_lot_id: 'weighted-lot',
          quantity_before: 100,
          quantity_after: 80,
          quantity: 20,
          accounting_unit_cost: 2,
          accounting_total_cost: 40
        }]
      },
      {
        id: 'future-receipt',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-10',
        transaction_type: 'receipt',
        quantity: 10,
        total_cost: 100,
        movement_layers: [{
          inventory_lot_id: 'weighted-lot',
          quantity_before: 80,
          quantity_after: 90,
          quantity: 10,
          accounting_unit_cost: 10,
          accounting_total_cost: 100
        }]
      }
    ]
  });

  assert.equal(row.opening_quantity, 100);
  assert.equal(row.opening_value, 200);
  assert.equal(row.consumption_quantity, 20);
  assert.equal(row.consumption_value, 40);
  assert.equal(row.closing_quantity, 80);
  assert.equal(row.closing_value, 160);
  assert.equal(row.unit_cost, 2);
  assert.notEqual(row.closing_value, row.closing_quantity * 99);
});

test('an in-period opening balance is an auditable addition and negative adjustment reconciles as correction', () => {
  const [row] = buildInventoryLotValueRows({
    dateFrom: '2026-08-01',
    dateTo: '2026-08-31',
    lots: [{
      id: 'opening-lot',
      site_id: 'store-1',
      ingredient_id: 'ingredient-3',
      stock_date: '2026-08-02',
      remaining_quantity: 88,
      accounting_unit_cost: 25
    }],
    transactions: [
      {
        id: 'period-opening',
        site_id: 'store-1',
        ingredient_id: 'ingredient-3',
        transaction_date: '2026-08-02',
        transaction_type: 'opening_balance',
        quantity: 100,
        movement_layers: [{
          inventory_lot_id: 'opening-lot',
          quantity_before: 0,
          quantity_after: 100,
          quantity: 100,
          accounting_unit_cost: 3,
          accounting_total_cost: 300
        }]
      },
      {
        id: 'manual-correction',
        site_id: 'store-1',
        ingredient_id: 'ingredient-3',
        transaction_date: '2026-08-05',
        transaction_type: 'adjustment',
        source_type: 'manual_adjustment',
        quantity: -12,
        movement_layers: [{
          inventory_lot_id: 'opening-lot',
          quantity_before: 100,
          quantity_after: 88,
          quantity: 12,
          accounting_unit_cost: 3,
          accounting_total_cost: 36
        }]
      }
    ]
  });

  assert.equal(row.opening_quantity, 0);
  assert.equal(row.opening_value, 0);
  assert.equal(row.opening_balance_quantity, 100);
  assert.equal(row.opening_balance_value, 300);
  assert.equal(row.addition_quantity, 100);
  assert.equal(row.addition_value, 300);
  assert.equal(row.consumption_quantity, 0);
  assert.equal(row.correction_quantity, -12);
  assert.equal(row.correction_value, -36);
  assert.equal(row.closing_quantity, 88);
  assert.equal(row.closing_value, 264);
  assert.equal(
    row.opening_quantity
      + row.addition_quantity
      - row.consumption_quantity
      + row.return_quantity
      + row.correction_quantity,
    row.closing_quantity
  );
  assert.equal(
    row.opening_value
      + row.addition_value
      - row.consumption_value
      + row.return_value
      + row.correction_value,
    row.closing_value
  );
});

test('date bounds are inclusive and exclude future and undated activity from a dated period', () => {
  const [row] = buildInventoryLotValueRows({
    dateFrom: '2026-08-03',
    dateTo: '2026-08-03',
    lots: [{
      id: 'date-lot',
      site_id: 'store-1',
      ingredient_id: 'ingredient-4',
      remaining_quantity: 72,
      accounting_unit_cost: 50
    }],
    transactions: [
      {
        id: 'dated-opening',
        site_id: 'store-1',
        ingredient_id: 'ingredient-4',
        transaction_date: '2026-08-01',
        transaction_type: 'receipt',
        quantity: 100,
        movement_layers: [{
          inventory_lot_id: 'date-lot',
          quantity_before: 0,
          quantity_after: 100,
          accounting_unit_cost: 4,
          accounting_total_cost: 400
        }]
      },
      {
        id: 'boundary-issue',
        site_id: 'store-1',
        ingredient_id: 'ingredient-4',
        transaction_date: '2026-08-03',
        transaction_type: 'issue',
        quantity: -20,
        movement_layers: [{
          inventory_lot_id: 'date-lot',
          quantity_before: 100,
          quantity_after: 80,
          accounting_unit_cost: 4,
          accounting_total_cost: 80
        }]
      },
      {
        id: 'future-issue',
        site_id: 'store-1',
        ingredient_id: 'ingredient-4',
        transaction_date: '2026-08-04',
        transaction_type: 'issue',
        quantity: -5,
        movement_layers: [{
          inventory_lot_id: 'date-lot',
          quantity_before: 80,
          quantity_after: 75,
          accounting_unit_cost: 4,
          accounting_total_cost: 20
        }]
      },
      {
        id: 'undated-issue',
        site_id: 'store-1',
        ingredient_id: 'ingredient-4',
        transaction_type: 'issue',
        quantity: -3,
        movement_layers: [{
          inventory_lot_id: 'date-lot',
          quantity_before: 75,
          quantity_after: 72,
          accounting_unit_cost: 4,
          accounting_total_cost: 12
        }]
      }
    ]
  });

  assert.equal(row.opening_quantity, 100);
  assert.equal(row.consumption_quantity, 20);
  assert.equal(row.movement_count, 1);
  assert.equal(row.closing_quantity, 80);
  assert.equal(row.closing_value, 320);
});

test('report document loading paginates until every record has been returned', async () => {
  const records = Array.from({ length: 455 }, (_, index) => ({ id: `row-${index + 1}` }));
  const calls = [];
  const rows = await listAllInventoryReportDocuments(
    'InventoryTransaction',
    {
      filters: { site_id: 'store-1' },
      sort: 'transaction_date',
      location: { unrestricted: false, accessibleSiteIds: ['store-1'] }
    },
    async (entity, options) => {
      calls.push({ entity, ...options });
      return {
        items: records.slice(options.offset, options.offset + options.limit),
        total_count: records.length
      };
    }
  );

  assert.equal(rows.length, 455);
  assert.deepEqual(calls.map((call) => call.offset), [0, 200, 400]);
  assert.ok(calls.every((call) => call.limit === 200));
  assert.ok(calls.every((call) => call.filters.site_id === 'store-1'));
  assert.ok(calls.every((call) => call.location.accessibleSiteIds[0] === 'store-1'));
});

test('untouched legacy aggregate inventory remains visible until its opening lot is migrated', () => {
  const [row] = buildInventoryLotValueRows({
    inventories: [{
      id: 'legacy-inventory-1',
      site_id: 'store-1',
      site_name: 'Main Store',
      ingredient_id: 'ingredient-legacy',
      ingredient_name: 'Legacy Rice',
      available_quantity: 12,
      unit: 'kg',
      average_unit_cost: 5
    }],
    ingredients: [{ id: 'ingredient-legacy', item_code: 'LEG-001', name: 'Legacy Rice' }]
  });

  assert.equal(row.item_code, 'LEG-001');
  assert.equal(row.opening_quantity, 12);
  assert.equal(row.closing_quantity, 12);
  assert.equal(row.closing_value, 60);
  assert.equal(row.source, 'legacy_aggregate_inventory');
});

test('manual stock issues are consumption rather than stock corrections', () => {
  const [row] = buildInventoryLotValueRows({
    lots: [{
      id: 'manual-issue-lot',
      site_id: 'store-1',
      ingredient_id: 'ingredient-1',
      remaining_quantity: 8,
      unit_cost: 5
    }],
    transactions: [{
      id: 'manual-issue',
      site_id: 'store-1',
      ingredient_id: 'ingredient-1',
      transaction_date: '2026-08-10',
      transaction_type: 'adjustment',
      reason_code: 'manual_issue',
      quantity: -2,
      movement_layers: [{
        inventory_lot_id: 'manual-issue-lot',
        quantity: 2,
        quantity_before: 10,
        quantity_after: 8,
        accounting_unit_cost: 5,
        accounting_total_cost: 10
      }]
    }]
  });

  assert.equal(row.consumption_quantity, 2);
  assert.equal(row.consumption_value, 10);
  assert.equal(row.correction_quantity, 0);
  assert.equal(row.correction_value, 0);
});

test('weighted-average valuation allocates one accounting cost across every active batch', () => {
  const rows = buildInventoryLotValueRows({
    inventories: [{
      id: 'inventory-weighted',
      site_id: 'store-1',
      ingredient_id: 'ingredient-1',
      valuation_method: 'weighted_average'
    }],
    lots: [
      { id: 'weighted-a', site_id: 'store-1', ingredient_id: 'ingredient-1', remaining_quantity: 100, unit_cost: 2 },
      { id: 'weighted-b', site_id: 'store-1', ingredient_id: 'ingredient-1', remaining_quantity: 100, unit_cost: 4 }
    ],
    transactions: [
      {
        id: 'receipt-a',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-01',
        transaction_type: 'receipt',
        quantity: 100,
        movement_layers: [{
          inventory_lot_id: 'weighted-a',
          quantity: 100,
          quantity_before: 0,
          quantity_after: 100,
          accounting_unit_cost: 2,
          accounting_total_cost: 200
        }]
      },
      {
        id: 'receipt-b',
        site_id: 'store-1',
        ingredient_id: 'ingredient-1',
        transaction_date: '2026-08-02',
        transaction_type: 'receipt',
        quantity: 100,
        movement_layers: [{
          inventory_lot_id: 'weighted-b',
          quantity: 100,
          quantity_before: 0,
          quantity_after: 100,
          accounting_unit_cost: 4,
          accounting_total_cost: 400
        }]
      }
    ]
  });

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.unit_cost === 3));
  assert.ok(rows.every((row) => row.closing_value === 300));
  assert.equal(rows.reduce((sum, row) => sum + row.closing_value, 0), 600);
  assert.deepEqual(rows.map((row) => row.valuation_reallocation_value).sort((a, b) => a - b), [-100, 100]);
});
