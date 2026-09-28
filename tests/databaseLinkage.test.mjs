import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  collectDocumentReferences,
  deleteSiteSubtree,
  validateDocumentRelationships,
  validateSiteChildrenAfterStructureChange
} from '../server/db.js';
import {
  assertSufficientStock,
  getAvailableLotQuantity
} from '../server/inventory.js';
import { buildSiteHierarchy } from '../server/locationScope.js';

function createSiteDeletionExecutor({ sites = [], users = [], normalizedDependencyCount = 0 } = {}) {
  const deleteCalls = [];

  return {
    deleteCalls,
    async query(sql, params = []) {
      const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();

      if (normalizedSql.includes('pg_advisory_xact_lock')) {
        return { rowCount: 1, rows: [{}] };
      }

      if (/^LOCK TABLE /i.test(normalizedSql)) {
        return { rowCount: 0, rows: [] };
      }

      if (/FROM areas/i.test(normalizedSql) && /UNION ALL/i.test(normalizedSql)) {
        const rows = sites.map((site) => {
          const type = String(site.type || 'area').toLowerCase();
          const timestamp = new Date().toISOString();
          if (type === 'project') {
            return {
              id: site.id,
              name: site.name,
              type: 'project',
              parent_site_id: site.parent_site_id || null,
              area_code: null,
              project_code: site.project_code || null,
              warehouse_code: null,
              d365_warehouse_id: null,
              status: site.status || 'active',
              source_name: site.source_name || null,
              payload: site,
              created_at: site.created_date || timestamp,
              updated_at: site.updated_date || timestamp
            };
          }
          if (type === 'store' || type === 'warehouse') {
            return {
              id: site.id,
              name: site.name,
              type: 'store',
              parent_site_id: site.parent_site_id || null,
              area_code: null,
              project_code: null,
              warehouse_code: site.project_code || null,
              d365_warehouse_id: site.d365_warehouse_id || null,
              status: site.status || 'active',
              source_name: site.source_name || null,
              payload: site,
              created_at: site.created_date || timestamp,
              updated_at: site.updated_date || timestamp
            };
          }
          return {
            id: site.id,
            name: site.name,
            type: 'area',
            parent_site_id: null,
            area_code: site.project_code || null,
            project_code: null,
            warehouse_code: null,
            d365_warehouse_id: null,
            status: site.status || 'active',
            source_name: site.source_name || null,
            payload: site,
            created_at: site.created_date || timestamp,
            updated_at: site.updated_date || timestamp
          };
        });
        return { rowCount: rows.length, rows };
      }

      if (/FROM users/i.test(normalizedSql)) {
        const targetIds = new Set((Array.isArray(params[0]) ? params[0] : params).flat().filter(Boolean).map(String));
        const match = users.find((user) => (
          targetIds.has(String(user.site_id || ''))
          || (user.allowed_site_ids || []).some((siteId) => targetIds.has(String(siteId)))
        ));
        return {
          rowCount: 1,
          rows: [{ dependency_count: match ? 1 : 0, sample_ids: match ? [match.id] : [] }]
        };
      }

      if (/FROM (pos_|purchase_|goods_|supplier_|warehouse_inventory|inventory_lots|inventory_transactions|menu_plans|production_events|produced_output_batches|meal_service_headers|food_waste_records)/i.test(normalizedSql)) {
        return {
          rowCount: 1,
          rows: [{
            dependency_count: normalizedDependencyCount,
            sample_ids: normalizedDependencyCount > 0 ? ['dependency-1'] : []
          }]
        };
      }

      if (/^DELETE FROM (warehouses|projects|areas)/i.test(normalizedSql)) {
        deleteCalls.push({ sql: normalizedSql, params });
        const ids = (Array.isArray(params[0]) ? params[0] : params).flat().filter((value) => (
          sites.some((site) => String(site.id) === String(value))
        ));
        return { rowCount: ids.length, rows: [] };
      }

      throw new Error(`Unexpected site deletion query: ${normalizedSql}`);
    }
  };
}

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
          if (sql.includes('FROM areas') && sql.includes('UNION ALL')) {
            const record = records.get(`Site:${params[0]}`);
            return {
              rowCount: record ? 1 : 0,
              rows: record ? [{
                id: record.id,
                name: record.name,
                type: record.type || 'area',
                parent_site_id: record.parent_site_id || null,
                area_code: record.project_code || null,
                project_code: null,
                warehouse_code: null,
                d365_warehouse_id: null,
                status: record.status || 'active',
                source_name: record.source_name || null,
                created_at: record.created_date || new Date().toISOString(),
                updated_at: record.updated_date || new Date().toISOString()
              }] : []
            };
          }
          if (sql.includes('FROM ingredients')) {
            const record = records.get(`Ingredient:${params[0]}`);
            return {
              rowCount: record ? 1 : 0,
              rows: record ? [{
                ingredient_id: record.id,
                name: record.name,
                item_code: record.item_code || record.id,
                ingredient_code: record.ingredient_code || null,
                sku: record.sku || null,
                d365_item_id: record.d365_item_id || null,
                base_unit: record.unit || 'EA',
                category_id: record.category || null,
                status: record.status || 'active',
                source_name: record.source_name || null,
                created_at: record.created_date || new Date().toISOString(),
                updated_at: record.updated_date || new Date().toISOString()
              }] : []
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
      const executor = createSiteDeletionExecutor({
        sites: [
          { id: 'project-jeddah', name: 'Jeddah Project', type: 'project', parent_site_id: 'area-west' }
        ]
      });

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
    name: 'deletes an unused Project subtree without treating its child links as external references',
    async run() {
      const project = { id: 'project-jeddah', name: 'Jeddah Project', type: 'project', parent_site_id: 'area-west' };
      const stores = [
        { id: 'store-main', name: 'Main Store', type: 'store', parent_site_id: project.id },
        { id: 'store-cold', name: 'Cold Store', type: 'store', parent_site_id: project.id }
      ];
      const executor = createSiteDeletionExecutor({ sites: [project, ...stores] });

      const result = await deleteSiteSubtree(project.id, executor);
      const deletedIds = new Set(
        executor.deleteCalls.flatMap((call) => call.params.flatMap((value) => Array.isArray(value) ? value : [value]))
      );

      assert.equal(executor.deleteCalls.length, 2, 'the unused subtree must be deleted from typed hierarchy tables');
      assert.deepEqual(
        [...deletedIds].filter((id) => [project.id, ...stores.map((store) => store.id)].includes(id)).sort(),
        [project.id, ...stores.map((store) => store.id)].sort()
      );
      assert.equal(result.deleted_count ?? result.deletedCount ?? result.count, 3);
    }
  },
  {
    name: 'rejects Site subtree deletion with structured blockers and performs no delete',
    async run() {
      const project = { id: 'project-jeddah', name: 'Jeddah Project', type: 'project', parent_site_id: 'area-west' };
      const store = { id: 'store-main', name: 'Main Store', type: 'store', parent_site_id: project.id };
      const scenarios = [
        {
          label: 'user assignment',
          users: [{ id: 'user-1', site_id: store.id, allowed_site_ids: [store.id] }],
          normalizedDependencyCount: 0
        },
        {
          label: 'operational dependency',
          users: [],
          normalizedDependencyCount: 1
        }
      ];

      for (const scenario of scenarios) {
        const executor = createSiteDeletionExecutor({
          sites: [project, store],
          users: scenario.users,
          normalizedDependencyCount: scenario.normalizedDependencyCount
        });
        let caught = null;
        try {
          await deleteSiteSubtree(project.id, executor);
        } catch (error) {
          caught = error;
        }

        assert.ok(caught, `${scenario.label} must block subtree deletion`);
        assert.equal(caught.code, 'SITE_IN_USE');
        assert.equal(caught.status, 409);
        assert.ok(
          Array.isArray(caught.details?.blockers || caught.blockers),
          `${scenario.label} must expose structured blockers`
        );
        assert.equal(executor.deleteCalls.length, 0, `${scenario.label} must leave the entire subtree intact`);
      }
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

      assert.match(inventorySource, /stock_date:\s*stockDate/);
      assert.match(inventorySource, /expiry_date:\s*expiryDate \|\| null/);
      assert.match(inventorySource, /Supported columns: item_code or ingredient_name, project_code or site_name, quantity, unit_cost, batch_number, stock_date, expiry_date/);
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
      const [sql, procurementSource, dbSource] = await Promise.all([
        fs.readFile(new URL('../server/sql/init.sql', import.meta.url), 'utf8'),
        fs.readFile(new URL('../server/procurement.js', import.meta.url), 'utf8'),
        fs.readFile(new URL('../server/db.js', import.meta.url), 'utf8')
      ]);

      [
        'trg_validate_purchase_order_item_request_link',
        'trg_validate_goods_receipt_item_order_link',
        'trg_validate_supplier_invoice_chain',
        'chk_goods_receipt_items_order_item_required',
        'CREATE TABLE IF NOT EXISTS areas',
        'CREATE TABLE IF NOT EXISTS projects',
        'CREATE TABLE IF NOT EXISTS warehouses',
        'CREATE TABLE IF NOT EXISTS ingredients',
        'CREATE TABLE IF NOT EXISTS warehouse_inventory',
        'CREATE TABLE IF NOT EXISTS inventory_lots',
        'CREATE TABLE IF NOT EXISTS recipes',
        'CREATE TABLE IF NOT EXISTS recipe_versions',
        'CREATE TABLE IF NOT EXISTS menu_plans',
        'CREATE TABLE IF NOT EXISTS production_events',
        'CREATE TABLE IF NOT EXISTS production_manifest_lines',
        'CREATE TABLE IF NOT EXISTS produced_output_batches',
        'CREATE TABLE IF NOT EXISTS meal_service_headers',
        'CREATE TABLE IF NOT EXISTS meal_service_consumptions',
        'CREATE TABLE IF NOT EXISTS food_waste_records',
        'idx_menu_plans_scope_unique',
        'idx_production_events_issue_group_unique',
        'idx_produced_output_batches_number_unique',
        'idx_meal_service_headers_scope',
        'idx_food_waste_records_scope',
        'idx_warehouse_inventory_ingredient',
        'idx_ingredients_d365_unique',
        'idx_warehouses_d365_unique',
        'idx_inventory_transactions_idempotency_unique',
        'idx_pos_sales_items_order',
        'idx_purchase_request_items_request',
        'idx_purchase_requests_special_event_source_unique',
        'idx_purchase_order_items_order',
        'idx_goods_receipt_items_receipt'
      ].forEach((requiredDefinition) => {
        assert.match(sql, new RegExp(requiredDefinition));
      });

      assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_d365_unique/);
      assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_d365_unique/);
      assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_transactions_idempotency_unique/);

      assert.match(dbSource, /DELETE FROM recipes recipe[\s\S]*NOT EXISTS \([\s\S]*FROM recipe_versions version[\s\S]*version\.recipe_id = recipe\.recipe_id/);

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
