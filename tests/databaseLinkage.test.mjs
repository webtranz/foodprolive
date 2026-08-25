import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  collectDocumentReferences,
  validateDocumentRelationships,
  validateSiteChildrenAfterStructureChange
} from '../server/db.js';
import {
  assertSufficientStock,
  getAvailableLotQuantity
} from '../server/inventory.js';
import { buildSiteHierarchy } from '../server/locationScope.js';

const cases = [
  {
    name: 'collects nested document relationship identifiers',
    run() {
      const references = collectDocumentReferences({
        site_id: 'site-1',
        meals: [
          { recipe_id: 'recipe-1' }
        ],
        ingredients: [
          { ingredient_id: 'ingredient-1' }
        ],
        site_ids: ['site-1', 'site-2'],
        source_event_id: 'event-1',
        production_plan_ids: ['production-1']
      });

      assert.deepEqual(
        references.map(({ targetEntity, id }) => `${targetEntity}:${id}`).sort(),
        [
          'Ingredient:ingredient-1',
          'MenuPlan:event-1',
          'Production:production-1',
          'Recipe:recipe-1',
          'Site:site-1',
          'Site:site-1',
          'Site:site-2'
        ]
      );
    }
  },
  {
    name: 'rejects missing logical document references',
    async run() {
      const records = new Map([
        ['Site:site-1', { id: 'site-1', name: 'Main site' }],
        ['Ingredient:ingredient-1', { id: 'ingredient-1', name: 'Rice' }]
      ]);
      const executor = {
        async query(sql, params) {
          if (sql.includes('pg_advisory_xact_lock_shared')) {
            return { rowCount: 1, rows: [{}] };
          }
          if (sql.includes('FROM entity_records')) {
            const record = records.get(`${params[0]}:${params[1]}`);
            return {
              rowCount: record ? 1 : 0,
              rows: record ? [{ data: record }] : []
            };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }
      };

      await validateDocumentRelationships(
        'Inventory',
        { site_id: 'site-1', ingredient_id: 'ingredient-1' },
        null,
        executor
      );

      await assert.rejects(
        validateDocumentRelationships(
          'Inventory',
          { site_id: 'site-1', ingredient_id: 'ingredient-missing' },
          null,
          executor
        ),
        /missing Ingredient/
      );
    }
  },
  {
    name: 'rejects missing and cyclic site parents',
    run() {
      const sites = [
        { id: 'site-root', name: 'Root', type: 'company', parent_site_id: null },
        { id: 'site-child', name: 'Child', type: 'location', parent_site_id: 'site-root' }
      ];

      assert.throws(
        () => buildSiteHierarchy(
          { name: 'Broken', parent_site_id: 'site-missing' },
          null,
          { sites }
        ),
        /does not exist/
      );

      assert.throws(
        () => buildSiteHierarchy(
          { name: 'Root', parent_site_id: 'site-child' },
          sites[0],
          { sites }
        ),
        /cycle/
      );
    }
  },
  {
    name: 'rejects site structure changes that would invalidate existing children',
    async run() {
      const executor = {
        async query(sql, params) {
          assert.match(sql, /data->>'parent_site_id'/);
          assert.deepEqual(params, ['area-west']);
          return {
            rowCount: 1,
            rows: [{ data: { id: 'project-jeddah', name: 'Jeddah Project', type: 'project', parent_site_id: 'area-west' } }]
          };
        }
      };

      await assert.rejects(
        validateSiteChildrenAfterStructureChange(
          { id: 'area-west', name: 'Western Area', type: 'area', parent_site_id: null },
          { id: 'area-west', name: 'Western Area', type: 'project', parent_site_id: 'area-central' },
          executor
        ),
        /Jeddah Project cannot remain/i
      );

      await assert.doesNotReject(
        validateSiteChildrenAfterStructureChange(
          { id: 'area-west', name: 'Western Area', type: 'area', parent_site_id: null },
          { id: 'area-west', name: 'Renamed Western Area', type: 'area', parent_site_id: null },
          { async query() { throw new Error('Unchanged structure must not query children'); } }
        )
      );
    }
  },
  {
    name: 'checks total stock before any deduction is allowed',
    run() {
      const lots = [
        { remaining_quantity: 3 },
        { remaining_quantity: 2 },
        { remaining_quantity: -1 }
      ];

      assert.equal(getAvailableLotQuantity(lots), 5);
      assert.equal(assertSufficientStock(lots, 5, false), 5);
      assert.throws(
        () => assertSufficientStock(lots, 6, false),
        /Insufficient stock/
      );
      assert.equal(assertSufficientStock(lots, 6, true), 5);
    }
  },
  {
    name: 'keeps D365 and inventory audit controls visible in the UI and exports',
    async run() {
      const [d365Source, inventorySource, workerSource] = await Promise.all([
        fs.readFile(new URL('../src/pages/D365Integration.jsx', import.meta.url), 'utf8'),
        fs.readFile(new URL('../src/pages/Inventory.jsx', import.meta.url), 'utf8'),
        fs.readFile(new URL('../server/bulkUploadWorker.js', import.meta.url), 'utf8')
      ]);

      assert.match(d365Source, /queryKey:\s*\['erpLogDetails', selectedLog\?\.id, logDetailPage\]/);
      assert.match(d365Source, /page:\s*logDetailPage/);
      assert.match(d365Source, /selectedLogDetails\?\.total_pages/);
      assert.match(d365Source, /setLogDetailPage\(\(page\) => Math\.min\(selectedLogTotalPages, page \+ 1\)\)/);

      assert.match(inventorySource, /stock_dates_by_batch:\s*describeMovementLayerDates\(movement, 'stock_date'\)/);
      assert.match(inventorySource, /expiry_dates_by_batch:\s*describeMovementLayerDates\(movement, 'expiry_date'\)/);
      assert.match(inventorySource, /<MovementLayerDates movement=\{movement\} field="stock_date" \/>/);
      assert.match(inventorySource, /<MovementLayerDates movement=\{movement\} field="expiry_date" \/>/);
      [
        'opening_value',
        'addition_value',
        'consumption_value',
        'return_value',
        'correction_value',
        'valuation_reallocation_value',
        'closing_value'
      ].forEach((field) => assert.match(inventorySource, new RegExp(field)));

      assert.match(workerSource, /resolveBulkInventoryIngredient\(\{/);
      assert.match(workerSource, /itemCode:\s*staged\.payload\.item_code/);
      assert.match(workerSource, /ingredientId:\s*staged\.payload\.ingredient_id/);
    }
  },
  {
    name: 'keeps database linkage constraints and indexes in the schema',
    async run() {
      const [sql, procurementSource] = await Promise.all([
        fs.readFile(new URL('../server/sql/init.sql', import.meta.url), 'utf8'),
        fs.readFile(new URL('../server/procurement.js', import.meta.url), 'utf8')
      ]);

      [
        'trg_validate_purchase_order_item_request_link',
        'trg_validate_goods_receipt_item_order_link',
        'trg_validate_supplier_invoice_chain',
        'chk_goods_receipt_items_order_item_required',
        'idx_entity_records_inventory_site_ingredient_unique',
        'idx_pos_sales_items_order',
        'idx_purchase_request_items_request',
        'idx_purchase_requests_special_event_source_unique',
        'idx_purchase_order_items_order',
        'idx_goods_receipt_items_receipt'
      ].forEach((requiredDefinition) => {
        assert.match(sql, new RegExp(requiredDefinition));
      });

      [
        'ambiguous_ingredient_mappings',
        'ambiguous_site_mappings',
        "'d365_mapping_status', 'needs_remap'",
        "'resolution', 'explicit_remap_required'",
        'conflicting_record_ids',
        'ranked_transaction_keys',
        'duplicate_transaction_keys',
        'canonical_transaction_id',
        "'status', 'legacy_duplicate_quarantined'",
        "record.data - 'idempotency_key'"
      ].forEach((preflightControl) => {
        assert.match(sql, new RegExp(preflightControl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      });
      assert.ok(
        sql.indexOf('WITH ambiguous_ingredient_mappings')
          < sql.indexOf('idx_entity_records_ingredient_d365_item_unique'),
        'ambiguous ingredient mappings must be quarantined before the unique index is created'
      );
      assert.ok(
        sql.indexOf('WITH ambiguous_site_mappings')
          < sql.indexOf('idx_entity_records_site_d365_warehouse_unique'),
        'ambiguous Store mappings must be quarantined before the unique index is created'
      );
      assert.ok(
        sql.indexOf('WITH ranked_transaction_keys')
          < sql.indexOf('idx_entity_records_inventory_transaction_idempotency'),
        'duplicate idempotency keys must be quarantined before the unique index is created'
      );

      [
        'getPurchaseRequestById\\(id, client\\)',
        'getPurchaseRequestBySourceEventId',
        'source_event_id, notes, total_estimated_cost',
        'executor \\? createWithExecutor\\(executor\\) : withTransaction\\(createWithExecutor\\)',
        'getPurchaseOrderById\\(id, client\\)',
        'getGoodsReceiptById\\(receiptId, client\\)',
        'applyReceiptToInventory\\([\\s\\S]*?lockedOrder,[\\s\\S]*?item,[\\s\\S]*?dateOnly\\(payload\\.receipt_date \\|\\| nowIso\\(\\)\\),[\\s\\S]*?actor,[\\s\\S]*?client[\\s\\S]*?\\)'
      ].forEach((transactionalCall) => {
        assert.match(procurementSource, new RegExp(transactionalCall));
      });
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
  console.log(`PASS ${cases.length} database linkage tests`);
}
