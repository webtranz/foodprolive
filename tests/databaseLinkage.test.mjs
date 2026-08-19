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
        'idx_purchase_order_items_order',
        'idx_goods_receipt_items_receipt'
      ].forEach((requiredDefinition) => {
        assert.match(sql, new RegExp(requiredDefinition));
      });

      [
        'getPurchaseRequestById\\(id, client\\)',
        'getPurchaseOrderById\\(id, client\\)',
        'getGoodsReceiptById\\(receiptId, client\\)',
        'applyReceiptToInventory\\(lockedOrder, item, actor, client\\)'
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
