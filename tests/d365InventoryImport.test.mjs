import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toBusinessDateOnly } from '../shared/businessDate.js';

import {
  buildD365RowIdempotencyKey,
  convertD365Quantity,
  convertD365UnitCost,
  generateD365BatchNumber,
  normalizeD365IngredientRow,
  normalizeD365InventoryRow,
  resolveD365Ingredient,
  resolveD365Store
} from '../shared/d365Inventory.js';
import {
  getD365ImportLogDetails,
  importD365Ingredients,
  importD365Inventory,
  previewD365InventoryImport,
  resolveAuthorizedD365PullStore,
  retryD365ImportLog
} from '../server/erpInventoryImport.js';
import { buildD365MovementExportRows, listErpLogs } from '../server/erpIntegration.js';
import {
  authorizeEntityAction,
  sanitizeErpIntegrationConfig
} from '../server/entities.js';
import { parseInventoryDate, toDateOnly as toInventoryDateOnly } from '../server/inventory.js';

function clone(value) {
  return structuredClone(value);
}

function createMemoryDependencies(seed = {}) {
  let sequence = 0;
  const tables = new Map(Object.entries(seed).map(([entity, rows]) => [entity, clone(rows)]));
  const calls = { receipts: [], deductions: [] };
  const rowsFor = (entity) => {
    if (!tables.has(entity)) tables.set(entity, []);
    return tables.get(entity);
  };
  const nextId = (prefix) => `${prefix.toLowerCase()}-${++sequence}`;

  const dependencies = {
    async withTransaction(handler) {
      const before = clone(Object.fromEntries(tables));
      try {
        return await handler({ transaction: true });
      } catch (error) {
        tables.clear();
        Object.entries(before).forEach(([entity, rows]) => tables.set(entity, rows));
        throw error;
      }
    },
    async createDocument(entity, payload) {
      const id = payload.id || nextId(entity);
      if ([...tables.values()].some((rows) => rows.some((row) => row.id === id))) {
        const error = new Error('duplicate key value violates unique constraint');
        error.code = '23505';
        throw error;
      }
      const record = { ...clone(payload), id };
      rowsFor(entity).push(record);
      return clone(record);
    },
    async findDocument(entity, id) {
      const record = rowsFor(entity).find((row) => row.id === id);
      return record ? clone(record) : null;
    },
    async listDocuments(entity, options = {}) {
      let rows = rowsFor(entity);
      if (options.filters) {
        rows = rows.filter((row) => Object.entries(options.filters).every(
          ([key, value]) => String(row?.[key] ?? '') === String(value ?? '')
        ));
      }
      if (options.limit) rows = rows.slice(0, options.limit);
      return clone(rows);
    },
    async updateDocument(entity, id, patch) {
      const index = rowsFor(entity).findIndex((row) => row.id === id);
      if (index < 0) return null;
      rowsFor(entity)[index] = { ...rowsFor(entity)[index], ...clone(patch) };
      return clone(rowsFor(entity)[index]);
    },
    async receiveStock(payload) {
      calls.receipts.push(clone(payload));
      let inventory = rowsFor('Inventory').find((row) => (
        row.site_id === payload.site_id && row.ingredient_id === payload.ingredient_id
      ));
      if (!inventory) {
        inventory = {
          id: nextId('inventory'),
          site_id: payload.site_id,
          site_name: payload.site_name,
          ingredient_id: payload.ingredient_id,
          ingredient_name: payload.ingredient_name,
          unit: payload.unit,
          quantity: 0,
          available_quantity: 0
        };
        rowsFor('Inventory').push(inventory);
      }
      const before = Number(inventory.available_quantity ?? inventory.quantity ?? 0);
      inventory.quantity = before + Number(payload.quantity);
      inventory.available_quantity = inventory.quantity;
      const lot = {
        id: nextId('lot'),
        site_id: payload.site_id,
        ingredient_id: payload.ingredient_id,
        quantity_received: payload.quantity,
        remaining_quantity: payload.quantity,
        unit: payload.unit,
        unit_cost: payload.unit_cost,
        batch_number: payload.batch_number,
        stock_date: payload.stock_date,
        received_date: payload.received_date,
        expiry_date: payload.expiry_date,
        source: payload.source,
        source_type: payload.source_type
      };
      rowsFor('InventoryLot').push(lot);
      const transaction = {
        id: nextId('transaction'),
        ...clone(payload),
        balance_before: before,
        balance_after: inventory.quantity,
        unit_cost: Number(payload.unit_cost || 0),
        total_cost: Number(payload.quantity) * Number(payload.unit_cost || 0),
        movement_layers: [{
          inventory_lot_id: lot.id,
          batch_number: lot.batch_number,
          stock_date: lot.stock_date,
          expiry_date: lot.expiry_date,
          quantity: payload.quantity,
          quantity_before: 0,
          quantity_after: payload.quantity,
          unit_cost: Number(payload.unit_cost || 0),
          total_cost: Number(payload.quantity) * Number(payload.unit_cost || 0),
          accounting_unit_cost: Number(payload.unit_cost || 0),
          accounting_total_cost: Number(payload.quantity) * Number(payload.unit_cost || 0)
        }]
      };
      rowsFor('InventoryTransaction').push(transaction);
      return { inventory: clone(inventory), lot: clone(lot), transaction: clone(transaction) };
    },
    async deductStock(payload) {
      calls.deductions.push(clone(payload));
      const inventory = rowsFor('Inventory').find((row) => (
        row.site_id === payload.site_id && row.ingredient_id === payload.ingredient_id
      ));
      if (!inventory || Number(inventory.available_quantity ?? inventory.quantity) < Number(payload.quantity)) {
        throw new Error('Insufficient stock');
      }
      const before = Number(inventory.available_quantity ?? inventory.quantity);
      const unitCost = Number(inventory.average_unit_cost ?? inventory.unit_cost ?? 0);
      const totalCost = Number(payload.quantity) * unitCost;
      const firstLot = rowsFor('InventoryLot').find((lot) => (
        lot.site_id === payload.site_id
        && lot.ingredient_id === payload.ingredient_id
        && Number(lot.remaining_quantity || 0) > 0
      ));
      const movementLayers = firstLot ? [{
        inventory_lot_id: firstLot.id,
        batch_number: firstLot.batch_number || null,
        stock_date: firstLot.stock_date || firstLot.received_date || null,
        expiry_date: firstLot.expiry_date || null,
        quantity: Number(payload.quantity),
        quantity_before: Number(firstLot.remaining_quantity),
        quantity_after: Number(firstLot.remaining_quantity) - Number(payload.quantity),
        unit_cost: Number(firstLot.unit_cost ?? unitCost),
        total_cost: Number(payload.quantity) * Number(firstLot.unit_cost ?? unitCost),
        accounting_unit_cost: Number(firstLot.accounting_unit_cost ?? firstLot.unit_cost ?? unitCost),
        accounting_total_cost: Number(payload.quantity)
          * Number(firstLot.accounting_unit_cost ?? firstLot.unit_cost ?? unitCost)
      }] : [];
      if (firstLot) firstLot.remaining_quantity -= Number(payload.quantity);
      inventory.quantity = before - Number(payload.quantity);
      inventory.available_quantity = inventory.quantity;
      const transaction = {
        id: nextId('transaction'),
        ...clone(payload),
        balance_before: before,
        balance_after: inventory.quantity,
        unit_cost: unitCost,
        total_cost: totalCost,
        movement_layers: clone(movementLayers)
      };
      rowsFor('InventoryTransaction').push(transaction);
      return {
        inventory: clone(inventory),
        transaction: clone(transaction),
        transaction_id: transaction.id,
        issued_quantity: Number(payload.quantity),
        total_cost: totalCost,
        movement_layers: clone(movementLayers)
      };
    }
  };

  return {
    dependencies,
    calls,
    rows(entity) {
      return clone(rowsFor(entity));
    }
  };
}

const ingredients = [
  { id: 'ingredient-corn', name: 'Corn Flour', d365_item_id: 'CORN-1', item_code: 'ING-001', unit: 'kg', cost_per_unit: 4 },
  { id: 'ingredient-oil', name: 'Corn Oil', item_code: 'ING-002', sku: 'OIL-SKU', unit: 'l' }
];
const sites = [
  { id: 'store-one', name: 'Main Store', type: 'store', d365_warehouse_id: 'WH-1' },
  { id: 'store-two', name: 'Second Store', type: 'warehouse', d365_warehouse_id: 'WH-2' },
  { id: 'project-one', name: 'Project', type: 'project', project_code: 'WH-PROJECT' }
];

const cases = [
  {
    name: 'normalizes D365 aliases, dates, generated batches, units, and authoritative event keys',
    run() {
      const normalized = normalizeD365InventoryRow({
        'Item ID': 'CORN-1',
        'Warehouse ID': 'WH-1',
        'Received Quantity': '1000',
        Unit: 'g',
        'Stock Date': '2026-08-20T08:30:00Z',
        'Expiry Date': '2026-09-20',
        'Unit Cost': '0.01',
        'External Event ID': 'receipt-88',
        'External Line ID': '1'
      }, { quantitySemantics: 'receipt', syncId: 'sync-one' });

      assert.equal(normalized.item_id, 'CORN-1');
      assert.equal(normalized.warehouse_id, 'WH-1');
      assert.equal(normalized.stock_date, '2026-08-20');
      assert.equal(normalized.expiry_date, '2026-09-20');
      assert.equal(normalizeD365InventoryRow({
        item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 1, unit: 'kg',
        stock_date: '2026-08-20T22:30:00Z'
      }).stock_date, '2026-08-21', 'timestamps use the Riyadh stock date');
      assert.equal(toBusinessDateOnly('2026-08-20T22:30:00Z'), '2026-08-21');
      assert.equal(toInventoryDateOnly('2026-08-20T22:30:00Z'), '2026-08-21');
      assert.equal(parseInventoryDate('2026-08-20T22:30:00Z', 'Stock date'), '2026-08-21');
      assert.match(normalized.batch_number, /^D365-20260820-WH-1-CORN-1-/);
      assert.equal(convertD365Quantity(1000, 'g', 'kg', ingredients[0]), 1);
      assert.equal(convertD365UnitCost(0.01, 1000, 1), 10);
      assert.equal(
        normalized.idempotency_key,
        normalizeD365InventoryRow({
          item_id: 'CORN-1', warehouse_id: 'WH-1', received_quantity: 999,
          unit: 'g', external_event_id: 'receipt-88', external_line_id: '1'
        }, { quantitySemantics: 'receipt', syncId: 'different-sync' }).idempotency_key,
        'external event and line IDs remain authoritative across sync runs'
      );
      assert.notEqual(
        normalizeD365InventoryRow({
          item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 10,
          unit: 'kg', external_event_id: 'snapshot-88', external_line_id: '1'
        }, { quantitySemantics: 'snapshot', syncId: 'sync-one' }).idempotency_key,
        normalizeD365InventoryRow({
          item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 11,
          unit: 'kg', external_event_id: 'snapshot-88', external_line_id: '1'
        }, { quantitySemantics: 'snapshot', syncId: 'sync-two' }).idempotency_key,
        'snapshot event IDs are versioned by the authoritative snapshot state'
      );
      assert.notEqual(
        normalizeD365InventoryRow({
          item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 10,
          unit: 'kg', external_event_id: 'snapshot-88', external_line_id: '1'
        }, { quantitySemantics: 'snapshot', syncId: 'sync-one' }).idempotency_key,
        normalizeD365InventoryRow({
          item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 10,
          unit: 'kg', external_event_id: 'snapshot-88', external_line_id: '1'
        }, { quantitySemantics: 'snapshot', syncId: 'sync-two' }).idempotency_key,
        'the same snapshot state is a new reconciliation instruction in a later sync run'
      );
      assert.throws(
        () => normalizeD365InventoryRow({ item_id: 'CORN-1', quantity: 1, unit: 'kg' }),
        /warehouse_id is required/
      );
      assert.throws(
        () => convertD365Quantity(1, 'pcs', 'kg', ingredients[0]),
        /Cannot convert/
      );
      assert.throws(
        () => normalizeD365InventoryRow({
          item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 1, unit: 'kg',
          stock_date: '2026-09-20', expiry_date: '2026-08-20'
        }),
        /expiry_date cannot be earlier/
      );
    }
  },
  {
    name: 'content idempotency prevents an identical receipt replay across sync runs',
    run() {
      const row = {
        item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 5, unit: 'kg',
        stock_date: '2026-08-25', unit_cost: 4
      };
      const first = buildD365RowIdempotencyKey(row, { quantitySemantics: 'receipt', syncId: 'sync-1' });
      const retry = buildD365RowIdempotencyKey(row, { quantitySemantics: 'receipt', syncId: 'sync-1' });
      const later = buildD365RowIdempotencyKey(row, { quantitySemantics: 'receipt', syncId: 'sync-2' });
      assert.equal(first, retry);
      assert.equal(first, later);
      assert.equal(generateD365BatchNumber(row, first), generateD365BatchNumber(row, retry));
      assert.equal(generateD365BatchNumber(row, first), generateD365BatchNumber(row, later));
    }
  },
  {
    name: 'resolves only mapped Ingredients and Store or Warehouse locations',
    run() {
      assert.equal(resolveD365Ingredient(ingredients, 'corn-1')?.id, 'ingredient-corn');
      assert.equal(resolveD365Ingredient(ingredients, 'OIL-SKU')?.id, 'ingredient-oil');
      assert.equal(resolveD365Store(sites, 'WH-1')?.id, 'store-one');
      assert.equal(resolveD365Store(sites, 'WH-2')?.id, 'store-two');
      assert.equal(resolveD365Store([
        { id: 'legacy', name: 'Legacy', type: 'store', warehouse_id: 'LEGACY' }
      ], 'LEGACY'), null, 'implicit warehouse aliases cannot bypass the explicit D365 mapping');
      assert.equal(resolveD365Store(sites, 'WH-PROJECT'), null);
      assert.equal(resolveD365Ingredient([
        { id: 'one', item_code: 'DUPLICATE' },
        { id: 'two', item_code: 'DUPLICATE' }
      ], 'DUPLICATE'), null);
      assert.equal(resolveD365Store([
        { id: 'one', type: 'store', project_code: 'DUPLICATE' },
        { id: 'two', type: 'store', project_code: 'DUPLICATE' }
      ], 'DUPLICATE'), null);
    }
  },
  {
    name: 'adds receipts without overwriting, preserves lot data, and skips an event retry exactly once',
    async run() {
      const memory = createMemoryDependencies({
        Ingredient: ingredients,
        Site: sites,
        Inventory: [{
          id: 'inventory-one', site_id: 'store-one', ingredient_id: 'ingredient-corn',
          unit: 'kg', quantity: 10, available_quantity: 10
        }]
      });
      const record = {
        item_id: 'CORN-1', warehouse_id: 'WH-1', received_quantity: 5, unit: 'kg',
        unit_cost: 4, stock_date: '2026-08-20', expiry_date: '2026-09-20',
        external_event_id: 'receipt-100', external_line_id: '1', api_token: 'must-not-be-logged'
      };
      const first = await importD365Inventory({
        sync_id: 'sync-100', quantity_semantics: 'receipt', records: [record]
      }, memory.dependencies);
      assert.deepEqual(first.summary, { total_rows: 1, applied_rows: 1, skipped_rows: 0, failed_rows: 0 });
      assert.equal(memory.rows('Inventory')[0].available_quantity, 15);
      const lot = memory.rows('InventoryLot')[0];
      assert.equal(lot.stock_date, '2026-08-20');
      assert.equal(lot.expiry_date, '2026-09-20');
      assert.equal(lot.source, 'd365');
      assert.match(lot.batch_number, /^D365-/);
      assert.equal(memory.rows('InventoryTransaction')[0].source_type, 'new_stock_upload');
      assert.equal(memory.rows('InventoryTransaction')[0].metadata.integration_log_id, first.log.id);
      assert.equal(first.log.request_payload.records[0].api_token, undefined);
      assert.equal(first.rows[0].input.api_token, undefined);
      assert.ok(first.rows[0].inventory_transaction_id);
      assert.equal(first.rows[0].action, 'received');
      assert.equal(first.rows[0].transaction_type, 'receipt');
      assert.equal(first.rows[0].affected_batches[0].inventory_lot_id, lot.id);

      const retry = await importD365Inventory({
        sync_id: 'sync-101', quantity_semantics: 'receipt', records: [record]
      }, memory.dependencies);
      assert.equal(retry.summary.skipped_rows, 1);
      assert.equal(memory.rows('Inventory')[0].available_quantity, 15);

      const laterReceipt = { ...record };
      delete laterReceipt.external_event_id;
      delete laterReceipt.external_line_id;
      const contentReplay = await importD365Inventory({
        sync_id: 'sync-102', quantity_semantics: 'receipt', records: [laterReceipt]
      }, memory.dependencies);
      assert.equal(contentReplay.summary.applied_rows, 1);
      assert.equal(memory.rows('Inventory')[0].available_quantity, 20);

      const repeatedContent = await importD365Inventory({
        sync_id: 'sync-103', quantity_semantics: 'receipt', records: [laterReceipt]
      }, memory.dependencies);
      assert.equal(repeatedContent.summary.skipped_rows, 1);
      assert.equal(memory.rows('Inventory')[0].available_quantity, 20);

      await importD365Inventory({
        sync_id: 'sync-104',
        quantity_semantics: 'receipt',
        records: [{
          ...laterReceipt,
          external_event_id: 'receipt-101',
          external_line_id: '1'
        }]
      }, memory.dependencies);
      assert.equal(memory.rows('Inventory')[0].available_quantity, 25);
    }
  },
  {
    name: 'rejects duplicate snapshot targets before preview or mutation',
    async run() {
      const memory = createMemoryDependencies({ Ingredient: ingredients, Site: sites });
      const payload = {
        sync_id: 'snapshot-duplicate',
        quantity_semantics: 'snapshot',
        records: [
          { item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 5, unit: 'kg' },
          { item_id: 'ING-001', warehouse_id: 'WH-1', available_quantity: 6, unit: 'kg' }
        ]
      };
      await assert.rejects(
        previewD365InventoryImport(payload, memory.dependencies),
        /one aggregate snapshot row per item\/warehouse/
      );
      await assert.rejects(
        importD365Inventory(payload, memory.dependencies),
        /one aggregate snapshot row per item\/warehouse/
      );
      assert.equal(memory.rows('Inventory').length, 0);
      assert.equal(memory.rows('ERPIntegrationLog').length, 0);
    }
  },
  {
    name: 'compares D365 physical snapshots with on-hand stock without undoing local reservations',
    async run() {
      const memory = createMemoryDependencies({
        Ingredient: ingredients,
        Site: sites,
        Inventory: [{
          id: 'inventory-reserved',
          site_id: 'store-one',
          site_name: 'Main Store',
          ingredient_id: 'ingredient-corn',
          ingredient_name: 'Corn Flour',
          unit: 'kg',
          on_hand_quantity: 10,
          usable_on_hand_quantity: 10,
          reserved_quantity: 4,
          available_quantity: 6,
          quantity: 6,
          average_unit_cost: 4
        }]
      });
      const payload = {
        sync_id: 'snapshot-reserved-preview',
        quantity_semantics: 'snapshot',
        records: [{
          item_id: 'CORN-1',
          warehouse_id: 'WH-1',
          available_quantity: 10,
          unit: 'kg',
          external_event_id: 'snapshot-reserved',
          external_line_id: '1'
        }]
      };

      const preview = await previewD365InventoryImport(payload, memory.dependencies);
      assert.equal(preview.rows[0].before_quantity, 10);
      assert.equal(preview.rows[0].adjustment_quantity, 0);
      assert.equal(memory.calls.receipts.length, 0);
      assert.equal(memory.calls.deductions.length, 0);

      const imported = await importD365Inventory({
        ...payload,
        sync_id: 'snapshot-reserved-apply'
      }, memory.dependencies);
      assert.equal(imported.summary.applied_rows, 1);
      assert.equal(imported.rows[0].adjustment_quantity, 0);
      assert.equal(memory.calls.receipts.length, 0, 'reserved stock must not look like a missing physical receipt');
      assert.equal(memory.calls.deductions.length, 0);
      const inventory = memory.rows('Inventory')[0];
      assert.equal(inventory.on_hand_quantity, 10);
      assert.equal(inventory.reserved_quantity, 4);
      assert.equal(inventory.available_quantity, 6);
    }
  },
  {
    name: 'preserves missing costs, falls back to known FoodPro cost, and rejects unknown valuation',
    async run() {
      const normalized = normalizeD365InventoryRow({
        item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 2, unit: 'kg'
      });
      assert.equal(normalized.unit_cost, null);

      const memory = createMemoryDependencies({ Ingredient: ingredients, Site: sites });
      const preview = await previewD365InventoryImport({
        sync_id: 'cost-fallback', quantity_semantics: 'receipt', records: [{
          item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 2, unit: 'kg'
        }]
      }, memory.dependencies);
      assert.equal(preview.rows[0].unit_cost, 4);

      const noCostMemory = createMemoryDependencies({
        Ingredient: [{ ...ingredients[0], cost_per_unit: null }],
        Site: sites
      });
      const failed = await previewD365InventoryImport({
        sync_id: 'cost-missing', quantity_semantics: 'receipt', records: [{
          item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 2, unit: 'kg'
        }]
      }, noCostMemory.dependencies);
      assert.equal(failed.summary.failed_rows, 1);
      assert.match(failed.rows[0].error, /no unit cost/);
    }
  },
  {
    name: 'ingredient imports patch only fields supplied by D365',
    async run() {
      assert.equal(normalizeD365IngredientRow({ item_id: 'CORN-1' }).item_code, undefined);
      assert.equal(normalizeD365IngredientRow({ item_id: 'CORN-1' }).is_active, undefined);
      assert.throws(
        () => normalizeD365IngredientRow({ item_id: 'CORN-1', cost_per_unit: -1 }),
        /0 or greater/
      );
      const memory = createMemoryDependencies({
        Ingredient: [{ ...ingredients[0], category: 'Flours', is_active: false }],
        Site: sites
      });
      const imported = await importD365Ingredients({
        sync_id: 'ingredient-patch',
        records: [{ item_id: 'CORN-1', item_name: 'Updated Corn Flour' }]
      }, memory.dependencies);
      assert.equal(imported.summary.applied_rows, 1);
      const saved = memory.rows('Ingredient')[0];
      assert.equal(saved.name, 'Updated Corn Flour');
      assert.equal(saved.item_code, 'ING-001');
      assert.equal(saved.category, 'Flours');
      assert.equal(saved.is_active, false);
    }
  },
  {
    name: 'reconciles ingredient reversions across runs while keeping same-run and version retries safe',
    async run() {
      const memory = createMemoryDependencies({
        Ingredient: [{ ...ingredients[0], name: 'Seed Name' }],
        Site: sites
      });
      const fallbackAlpha = {
        item_id: 'CORN-1', item_name: 'Alpha Name'
      };
      const first = await importD365Ingredients({
        sync_id: 'ingredient-run-1', records: [fallbackAlpha]
      }, memory.dependencies);
      assert.equal(first.summary.applied_rows, 1);
      const sameRun = await importD365Ingredients({
        sync_id: 'ingredient-run-1', records: [fallbackAlpha]
      }, memory.dependencies);
      assert.equal(sameRun.summary.skipped_rows, 1);

      await importD365Ingredients({
        sync_id: 'ingredient-run-2', records: [{ ...fallbackAlpha, item_name: 'Beta Name' }]
      }, memory.dependencies);
      const reverted = await importD365Ingredients({
        sync_id: 'ingredient-run-3', records: [fallbackAlpha]
      }, memory.dependencies);
      assert.equal(reverted.summary.applied_rows, 1);
      assert.equal(memory.rows('Ingredient')[0].name, 'Alpha Name');

      const versioned = {
        item_id: 'CORN-1', item_name: 'Versioned Name', external_event_id: 'item-master',
        external_line_id: 'CORN-1', external_version: '42'
      };
      const versionFirst = await importD365Ingredients({
        sync_id: 'ingredient-run-4', records: [versioned]
      }, memory.dependencies);
      assert.equal(versionFirst.summary.applied_rows, 1);
      const versionReplay = await importD365Ingredients({
        sync_id: 'ingredient-run-5', records: [versioned]
      }, memory.dependencies);
      assert.equal(versionReplay.summary.skipped_rows, 1, 'the same authoritative event version stays idempotent across envelopes');
      const nextVersion = await importD365Ingredients({
        sync_id: 'ingredient-run-6', records: [{ ...versioned, item_name: 'Alpha Name', external_version: '43' }]
      }, memory.dependencies);
      assert.equal(nextVersion.summary.applied_rows, 1);
      assert.equal(memory.rows('Ingredient')[0].name, 'Alpha Name');
    }
  },
  {
    name: 'applies snapshot deltas through FIFO deduction instead of replacing stock',
    async run() {
      const memory = createMemoryDependencies({
        Ingredient: ingredients,
        Site: sites,
        Inventory: [{
          id: 'inventory-one', site_id: 'store-one', ingredient_id: 'ingredient-corn',
          unit: 'kg', quantity: 10, available_quantity: 10, valuation_method: 'fifo'
        }]
      });
      const result = await importD365Inventory({
        sync_id: 'snapshot-1',
        quantity_semantics: 'snapshot',
        records: [{
          item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 6, unit: 'kg',
          stock_date: '2026-08-25', external_event_id: 'snapshot-1', external_line_id: '1'
        }]
      }, memory.dependencies);

      assert.equal(result.summary.applied_rows, 1);
      assert.equal(result.rows[0].adjustment_quantity, -4);
      assert.equal(result.rows[0].action, 'decreased');
      assert.equal(result.rows[0].transaction_type, 'adjustment');
      assert.equal(memory.calls.deductions[0].quantity, 4);
      assert.equal(memory.calls.deductions[0].allow_shortage, false);
      assert.equal(memory.calls.deductions[0].valuation_method, 'fifo');
      assert.equal(memory.calls.deductions[0].source_type, 'stock_correction');
      assert.equal(memory.rows('Inventory')[0].available_quantity, 6);
      assert.equal(memory.rows('InventoryLot').length, 0);
    }
  },
  {
    name: 'logs actual negative-snapshot valuation and complete affected batch costs',
    async run() {
      const memory = createMemoryDependencies({
        Ingredient: ingredients,
        Site: sites,
        Inventory: [{
          id: 'inventory-one', site_id: 'store-one', ingredient_id: 'ingredient-corn',
          unit: 'kg', quantity: 10, available_quantity: 10, valuation_method: 'fifo',
          average_unit_cost: 3
        }],
        InventoryLot: [{
          id: 'lot-one', site_id: 'store-one', ingredient_id: 'ingredient-corn',
          batch_number: 'FIFO-ONE', stock_date: '2026-08-01', expiry_date: '2026-09-01',
          remaining_quantity: 10, unit_cost: 3, accounting_unit_cost: 3
        }]
      });
      const result = await importD365Inventory({
        sync_id: 'snapshot-value-1', quantity_semantics: 'snapshot', records: [{
          item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 0, unit: 'kg',
          unit_cost: 99, stock_date: '2026-08-25'
        }]
      }, memory.dependencies);

      assert.equal(result.rows[0].unit_cost, 3);
      assert.equal(result.rows[0].total_cost, 30);
      assert.equal(result.rows[0].source_type, 'stock_correction');
      assert.equal(result.rows[0].affected_batches[0].unit_cost, 3);
      assert.equal(result.rows[0].affected_batches[0].total_cost, 30);
      assert.equal(result.rows[0].affected_batches[0].accounting_total_cost, 30);
    }
  },
  {
    name: 'replays snapshots once per sync run and re-reconciles the same state after later local drift',
    async run() {
      const memory = createMemoryDependencies({
        Ingredient: ingredients,
        Site: sites,
        Inventory: [{
          id: 'inventory-one', site_id: 'store-one', site_name: 'Main Store',
          ingredient_id: 'ingredient-corn', ingredient_name: 'Corn Flour',
          unit: 'kg', quantity: 10, available_quantity: 10, average_unit_cost: 4
        }]
      });
      const record = {
        item_id: 'CORN-1', warehouse_id: 'WH-1', available_quantity: 10, unit: 'kg',
        external_event_id: 'snapshot-current', external_line_id: '1'
      };

      const first = await importD365Inventory({
        sync_id: 'snapshot-run-1', quantity_semantics: 'snapshot', records: [record],
        received_at: '2026-08-25T20:30:00.000Z'
      }, memory.dependencies);
      assert.equal(first.summary.applied_rows, 1);
      assert.equal(first.log.request_payload.received_at, '2026-08-25T20:30:00.000Z');
      const replay = await importD365Inventory({
        sync_id: 'snapshot-run-1', quantity_semantics: 'snapshot', records: [record],
        received_at: '2026-08-25T20:30:00.000Z'
      }, memory.dependencies);
      assert.equal(replay.summary.skipped_rows, 1, 'an exact replay of one sync run remains safe');

      await memory.dependencies.deductStock({
        site_id: 'store-one', site_name: 'Main Store',
        ingredient_id: 'ingredient-corn', ingredient_name: 'Corn Flour',
        quantity: 2, unit: 'kg', transaction_type: 'issuance'
      });
      assert.equal(memory.rows('Inventory')[0].available_quantity, 8);

      const retriedRun = await retryD365ImportLog(
        first.log,
        null,
        {},
        memory.dependencies
      );
      assert.equal(retriedRun.summary.skipped_rows, 1, 'a later retry preserves the original inferred stock date and key');
      assert.equal(memory.rows('Inventory')[0].available_quantity, 8);

      const later = await importD365Inventory({
        sync_id: 'snapshot-run-2', quantity_semantics: 'snapshot', records: [record],
        received_at: '2026-08-26T20:30:00.000Z'
      }, memory.dependencies);
      assert.equal(later.summary.applied_rows, 1);
      assert.equal(later.rows[0].adjustment_quantity, 2);
      assert.equal(memory.rows('Inventory')[0].available_quantity, 10);
      assert.equal(memory.calls.receipts.length, 1);
    }
  },
  {
    name: 'previews without mutation and enforces Store scope on preview and import',
    async run() {
      const memory = createMemoryDependencies({ Ingredient: ingredients, Site: sites });
      const records = [
        { item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 3, unit: 'kg' },
        { item_id: 'CORN-1', warehouse_id: 'WH-2', quantity: 4, unit: 'kg' }
      ];
      const scope = { unrestricted: false, accessibleSiteIds: new Set(['store-one']) };
      const preview = await previewD365InventoryImport({
        sync_id: 'preview-1', quantity_semantics: 'receipt', records, scope,
        batch_number: 'PREVIEW-BATCH', stock_date: '2026-08-25', expiry_date: '2026-09-25', unit_cost: 7
      }, memory.dependencies);
      assert.equal(preview.summary.ready_rows, 1);
      assert.equal(preview.summary.failed_rows, 1);
      assert.equal(preview.rows[0].batch_number, 'PREVIEW-BATCH');
      assert.equal(preview.rows[0].stock_date, '2026-08-25');
      assert.equal(preview.rows[0].expiry_date, '2026-09-25');
      assert.match(preview.rows[1].error, /outside your accessible location scope/);
      assert.equal(memory.rows('Inventory').length, 0);
      assert.equal(memory.rows('ERPIntegrationLog').length, 0);

      const imported = await importD365Inventory({
        sync_id: 'scope-import-1', quantity_semantics: 'receipt', records, scope
      }, memory.dependencies);
      assert.equal(imported.summary.applied_rows, 1);
      assert.equal(imported.summary.failed_rows, 1);
      assert.deepEqual(memory.rows('Inventory').map((row) => row.site_id), ['store-one']);
    }
  },
  {
    name: 'records partial failures and returns detailed rows only for accessible Stores',
    async run() {
      const memory = createMemoryDependencies({ Ingredient: ingredients, Site: sites });
      const imported = await importD365Inventory({
        sync_id: 'partial-1',
        quantity_semantics: 'receipt',
        records: [
          { item_id: 'CORN-1', warehouse_id: 'WH-1', quantity: 1, unit: 'kg' },
          { item_id: 'CORN-1', warehouse_id: 'WH-2', quantity: 2, unit: 'kg' },
          { item_id: 'UNKNOWN', warehouse_id: 'WH-1', quantity: 1, unit: 'kg' }
        ]
      }, memory.dependencies);
      assert.equal(imported.log.status, 'partial_success');
      assert.deepEqual(imported.summary, { total_rows: 3, applied_rows: 2, skipped_rows: 0, failed_rows: 1 });

      const scoped = await getD365ImportLogDetails(imported.log.id, {
        scope: { unrestricted: false, accessibleSiteIds: new Set(['store-one']) },
        limit: 50
      }, memory.dependencies);
      assert.equal(scoped.total_count, 2);
      assert.deepEqual(scoped.rows.map((row) => row.site_id), ['store-one', 'store-one']);
      assert.equal(scoped.log.request_payload.records, undefined);
      assert.equal(scoped.log.response_payload.rows, undefined);
      assert.equal(scoped.log.records_count, 2);
      assert.deepEqual(scoped.log.site_ids, ['store-one']);

      await assert.rejects(
        getD365ImportLogDetails(imported.log.id, {
          scope: { unrestricted: false, accessibleSiteIds: new Set(['store-missing']) }
        }, memory.dependencies),
        /not found in your accessible location scope/
      );

      const unrestricted = await getD365ImportLogDetails(imported.log.id, {
        scope: { unrestricted: true }
      }, memory.dependencies);
      assert.equal(unrestricted.total_count, 3);

      const firstPage = await getD365ImportLogDetails(imported.log.id, {
        scope: { unrestricted: true }, page: 1, limit: 2
      }, memory.dependencies);
      assert.equal(firstPage.rows.length, 2);
      assert.equal(firstPage.page, 1);
      assert.equal(firstPage.total_pages, 2);
      assert.equal(firstPage.has_more, true);

      const secondPage = await getD365ImportLogDetails(imported.log.id, {
        scope: { unrestricted: true }, page: 2, limit: 2
      }, memory.dependencies);
      assert.equal(secondPage.rows.length, 1);
      assert.equal(secondPage.page, 2);
      assert.equal(secondPage.total_count, 3);
      assert.equal(secondPage.has_more, false);
    }
  },
  {
    name: 'exports POS and every supported inventory source with D365 IDs and monetary values',
    run() {
      const rows = buildD365MovementExportRows({
        movements: [{
          id: 'movement-one', site_id: 'store-one', ingredient_id: 'ingredient-corn',
          transaction_type: 'pos_sale', quantity: -2, unit: 'kg', unit_cost: 3.25,
          total_cost: 6.5, source: 'pos', source_type: 'pos_sale', reason_code: 'meal-sale',
          transaction_date: '2026-08-25', status: 'posted'
        }, {
          id: 'receipt-one', site_id: 'store-one', ingredient_id: 'ingredient-corn',
          transaction_type: 'receipt', quantity: 2, unit: 'kg', total_cost: 6.5
        }],
        ingredients,
        sites,
        scope: { unrestricted: true }
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0].item_id, 'CORN-1');
      assert.equal(rows[0].originating_warehouse, 'WH-1');
      assert.equal(rows[0].transaction_type, 'pos_sale');
      assert.equal(rows[0].source, 'pos');
      assert.equal(rows[0].source_type, 'pos_sale');
      assert.equal(rows[0].unit_cost, 3.25);
      assert.equal(rows[0].total_cost, 6.5);
      assert.equal(rows[0].movement_direction, 'issue');
    }
  },
  {
    name: 'loads integration logs in scoped pages before applying the 500-row cap',
    async run() {
      const allLogs = [
        ...Array.from({ length: 500 }, (_, index) => ({
          id: `other-${index}`,
          site_id: 'store-two',
          attempted_at: `2026-08-25T${String(23 - (index % 24)).padStart(2, '0')}:00:00.000Z`,
          direction: 'inbound',
          response_payload: { rows: [{ site_id: 'store-two', status: 'applied' }] }
        })),
        ...Array.from({ length: 205 }, (_, index) => ({
          id: `accessible-${index}`,
          site_id: 'store-one',
          attempted_at: `2026-08-20T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
          direction: 'inbound',
          response_payload: { rows: [{ site_id: 'store-one', status: 'applied' }] }
        }))
      ];
      const calls = [];
      const scope = { unrestricted: false, accessibleSiteIds: new Set(['store-one']) };
      const logs = await listErpLogs(scope, {
        async listDocumentsPage(entity, options) {
          calls.push({ entity, ...options });
          assert.deepEqual(options.location, {
            unrestricted: false,
            accessibleSiteIds: ['store-one']
          });
          const accessibleIds = new Set(options.location.accessibleSiteIds);
          const scoped = allLogs.filter((log) => accessibleIds.has(log.site_id));
          return {
            items: scoped.slice(options.offset, options.offset + options.limit),
            total_count: scoped.length
          };
        }
      });

      assert.equal(logs.length, 205);
      assert.ok(logs.every((log) => log.site_id === 'store-one'));
      assert.equal(logs[0].id, 'accessible-0');
      assert.deepEqual(calls.map((call) => call.offset), [0, 200]);
      assert.deepEqual(calls.map((call) => call.limit), [200, 200]);
    }
  },
  {
    name: 'authorizes one explicitly mapped accessible Store before a remote D365 pull',
    run() {
      const scoped = { unrestricted: false, accessibleSiteIds: new Set(['store-one']) };
      assert.equal(resolveAuthorizedD365PullStore(sites, {
        warehouse_id: 'wh-1', scope: scoped
      }).site.id, 'store-one');
      assert.equal(resolveAuthorizedD365PullStore(sites, {
        location_id: 'store-one', scope: scoped
      }).warehouse_id, 'WH-1');
      assert.throws(
        () => resolveAuthorizedD365PullStore(sites, { warehouse_id: 'WH-2', scope: scoped }),
        /not mapped to an accessible Store/
      );
      assert.throws(
        () => resolveAuthorizedD365PullStore(sites, {
          location_id: 'store-one', warehouse_id: 'WH-2', scope: scoped
        }),
        /does not match the requested D365 warehouse/
      );
      assert.throws(
        () => resolveAuthorizedD365PullStore(sites, { scope: scoped }),
        /Select an accessible Store/
      );
    }
  },
  {
    name: 'blocks generic integration-log reads so scoped detail endpoints cannot be bypassed',
    run() {
      const user = { role: 'manager', role_permissions: ['manage_erp'] };
      for (const action of ['list', 'filter', 'read']) {
        assert.throws(
          () => authorizeEntityAction(user, 'ERPIntegrationLog', action),
          (error) => {
            assert.match(error.message, /protected scoped ERP log endpoints/);
            assert.equal(error.status, 409);
            return true;
          }
        );
      }
      for (const action of ['list', 'filter', 'read']) {
        assert.throws(
          () => authorizeEntityAction(user, 'D365Master', action),
          /processing markers are internal/
        );
      }
    }
  },
  {
    name: 'keeps ERP secrets and configuration changes administrator-only',
    run() {
      const manager = { role: 'finance_controller', role_access_level: 'manager', role_permissions: ['manage_erp'] };
      const administrator = { role: 'admin', role_access_level: 'admin' };
      assert.equal(authorizeEntityAction(manager, 'ERPIntegrationConfig', 'list'), true);
      for (const action of ['create', 'update', 'delete']) {
        assert.throws(
          () => authorizeEntityAction(manager, 'ERPIntegrationConfig', action),
          /Only administrators/
        );
      }
      assert.equal(authorizeEntityAction(administrator, 'ERPIntegrationConfig', 'update'), true);

      const config = {
        id: 'config-one', provider_name: 'D365', api_endpoint: 'https://secret.example.test',
        api_key: 'super-secret', data_mapping: { inventory_sync_api: {} }, is_active: true
      };
      const sanitized = sanitizeErpIntegrationConfig(config, manager);
      assert.equal(sanitized.api_endpoint, undefined);
      assert.equal(sanitized.api_key, undefined);
      assert.equal(sanitized.api_endpoint_configured, true);
      assert.equal(sanitized.api_key_configured, true);
      assert.deepEqual(sanitizeErpIntegrationConfig(config, administrator), config);
    }
  },
  {
    name: 'publishes the inbound D365 contract and keeps list log details sanitized',
    run() {
      const source = fs.readFileSync(new URL('../server/erpIntegration.js', import.meta.url), 'utf8');
      const routeSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
      assert.match(source, /requiredFields: \['item_id', 'warehouse_id', 'quantity', 'unit'\]/);
      assert.match(source, /'Warehouse ID': 'warehouse_id'/);
      assert.match(source, /'Batch Number': 'batch_number'/);
      assert.match(source, /'Stock Date': 'stock_date'/);
      assert.match(source, /'Expiry Date': 'expiry_date'/);
      assert.match(source, /'Unit Cost': 'unit_cost'/);
      assert.match(source, /delete requestPayload\.records/);
      assert.match(source, /delete responsePayload\.rows/);
      assert.match(source, /pullD365InventoryRecords/);
      assert.match(source, /originalSiteIds\.length === 0/);
      assert.match(source, /'Unit Cost': 'unit_cost'/);
      assert.match(source, /'Total Cost': 'total_cost'/);
      assert.match(source, /'pos_sale'/);
      assert.match(source, /item\.d365_ordered_in_total \?\? item\.ordered_quantity/);
      assert.match(source, /item\.d365_on_order_reserved \?\? item\.on_order_reserved/);
      assert.doesNotMatch(source, /item\.reserved_quantity \|\| item\.on_order_reserved/);
      assert.match(routeSource, /preview_fingerprint/);
      assert.match(routeSource, /import_payload/);
      assert.match(routeSource, /does not match selected warehouse/);
      const requestBuilder = routeSource.slice(
        routeSource.indexOf('async function buildD365InventoryImportRequest'),
        routeSource.indexOf("'/api/erp/import/inventory/preview'")
      );
      assert.ok(
        requestBuilder.indexOf('resolveAuthorizedD365PullStore')
          < requestBuilder.indexOf('pullD365InventoryRecords'),
        'Store authorization must happen before any remote D365 pull'
      );
      assert.match(requestBuilder, /pulled && \(!rowWarehouseId/);
      assert.match(requestBuilder, /outside the selected Store; no rows were imported/);
      const trendSource = fs.readFileSync(new URL('../src/components/reports/InventoryTrendChart.jsx', import.meta.url), 'utf8');
      assert.match(trendSource, /'pos_sale'/);
      assert.match(trendSource, /additionValue/);
      assert.match(trendSource, /issuanceValue/);
    }
  }
];

let failed = false;
for (const testCase of cases) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`PASS ${cases.length} D365 inventory import tests`);
}
