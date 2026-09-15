import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  allocateBatchOverproductionWaste,
  buildBatchOverproductionDishSummary,
  buildFoodWasteMenuPlanSummary,
  decorateFoodWasteRecord,
  getFoodWasteRecordingWindow,
  getLatestSuccessfulProductionCompletedAt,
  isApprovalOnlyWastePatch,
  normalizeFoodWasteWeightGrams,
  normalizeMealType
} from '../server/foodWaste.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const cases = [
  {
    name: 'normalizes supported meal types only',
    run() {
      assert.equal(normalizeMealType(' Breakfast '), 'breakfast');
      assert.equal(normalizeMealType('snack'), '');
    }
  },
  {
    name: 'allows administrators to record waste during the current month',
    run() {
      const window = getFoodWasteRecordingWindow({
        wasteDate: '2026-09-04',
        mealType: 'lunch',
        now: '2026-09-20T13:15:00',
        isAdmin: true
      });

      assert.equal(window.window_status, 'open');
      assert.equal(window.is_within_recording_window, true);
      assert.equal(window.can_edit, true);
      assert.equal(window.recording_window_basis, 'admin_month');
    }
  },
  {
    name: 'blocks administrators outside the current month and on future dates',
    run() {
      const previousMonth = getFoodWasteRecordingWindow({
        wasteDate: '2026-08-31',
        mealType: 'breakfast',
        now: '2026-09-04T09:30:01',
        isAdmin: true
      });
      const futureDate = getFoodWasteRecordingWindow({
        wasteDate: '2026-09-05',
        mealType: 'breakfast',
        now: '2026-09-04T09:30:01',
        isAdmin: true
      });

      assert.equal(previousMonth.window_status, 'closed');
      assert.equal(previousMonth.is_within_recording_window, false);
      assert.equal(futureDate.window_status, 'future_date');
      assert.equal(futureDate.is_within_recording_window, false);
    }
  },
  {
    name: 'allows authorized non-admin users for 48 hours after successful production',
    run() {
      const window = getFoodWasteRecordingWindow({
        wasteDate: '2026-05-12',
        mealType: 'dinner',
        now: '2026-05-14T07:59:59.000Z',
        productionCompletedAt: '2026-05-12T08:00:00.000Z'
      });

      assert.equal(window.window_status, 'open');
      assert.equal(window.is_within_recording_window, true);
      assert.equal(window.can_edit, true);
      assert.equal(window.recording_window_basis, 'production_48_hours');
      assert.equal(window.production_completed_at, '2026-05-12T08:00:00.000Z');
    }
  },
  {
    name: 'closes authorized non-admin recording after 48 hours from production',
    run() {
      const window = getFoodWasteRecordingWindow({
        wasteDate: '2026-05-12',
        mealType: 'dinner',
        now: '2026-05-14T08:00:01.000Z',
        productionCompletedAt: '2026-05-12T08:00:00.000Z'
      });

      assert.equal(window.window_status, 'closed');
      assert.equal(window.is_within_recording_window, false);
      assert.equal(window.can_edit, false);
    }
  },
  {
    name: 'waits for successful production before non-admin waste recording',
    run() {
      const window = getFoodWasteRecordingWindow({
        wasteDate: '2026-05-12',
        mealType: 'dinner',
        now: '2026-05-12T16:00:00'
      });

      assert.equal(window.window_status, 'before_production');
      assert.equal(window.is_within_recording_window, false);
    }
  },
  {
    name: 'treats approval-only patches separately',
    run() {
      assert.equal(isApprovalOnlyWastePatch({ approval_status: 'approved', status: 'logged' }), true);
      assert.equal(isApprovalOnlyWastePatch({ approval_status: 'approved', quantity: 10 }), false);
    }
  },
  {
    name: 'builds meal-specific menu plan summaries',
    run() {
      const summary = buildFoodWasteMenuPlanSummary({
        id: 'menu-plan-1',
        plan_date: '2026-05-12',
        site_id: 'site-1',
        site_name: 'ABQAIQ CAMP',
        meals: [
          { meal_type: 'breakfast', recipe_id: 'recipe-1', recipe_name: 'Egg Tray', expected_servings: 40, total_cost: 50 },
          { meal_type: 'lunch', recipe_id: 'recipe-2', recipe_name: 'Kabsa', expected_servings: 60, total_cost: 120 }
        ]
      }, 'breakfast');

      assert.equal(summary.recipes.length, 1);
      assert.equal(summary.recipes[0].recipe_name, 'Egg Tray');
    }
  },
  {
    name: 'resolves the latest successful production completion for waste windows',
    run() {
      const completedAt = getLatestSuccessfulProductionCompletedAt({
        mealType: 'lunch',
        productions: [
          { id: 'planned', meal_type: 'lunch', status: 'planned', completed_date: '2026-05-12T13:00:00.000Z' },
          { id: 'breakfast', meal_type: 'breakfast', status: 'completed', completed_date: '2026-05-12T12:00:00.000Z' },
          { id: 'older', meal_type: 'lunch', status: 'completed', completed_date: '2026-05-12T10:00:00.000Z' }
        ],
        producedItemBatches: [
          { id: 'batch-1', meal_type: 'lunch', completed_at: '2026-05-12T11:30:00.000Z' },
          { id: 'batch-2', meal_type: 'dinner', completed_at: '2026-05-12T14:00:00.000Z' }
        ]
      });

      assert.equal(completedAt, '2026-05-12T11:30:00.000Z');
    }
  },
  {
    name: 'builds dish-wise batch overproduction summaries from produced batches',
    run() {
      const summary = buildBatchOverproductionDishSummary([
        {
          id: 'batch-1',
          batch_number: 'B-001',
          production_id: 'production-1',
          production_date: '2026-05-12',
          meal_type: 'lunch',
          status: 'partial',
          recipe_id: 'rice',
          recipe_name: 'Rice',
          produced_servings: 10,
          produced_weight_grams: 1000,
          served_weight_grams: 300,
          wasted_weight_grams: 100,
          remaining_weight_grams: 600
        },
        {
          id: 'batch-2',
          batch_number: 'B-002',
          production_id: 'production-2',
          production_date: '2026-05-12',
          meal_type: 'lunch',
          status: 'available',
          recipe_id: 'rice',
          recipe_name: 'Rice',
          produced_servings: 5,
          produced_weight_grams: 500,
          served_weight_grams: 0,
          wasted_weight_grams: 50,
          remaining_weight_grams: 450
        },
        {
          id: 'batch-3',
          batch_number: 'B-003',
          production_id: 'production-3',
          production_date: '2026-05-12',
          meal_type: 'lunch',
          status: 'available',
          recipe_id: 'stew',
          recipe_name: 'Stew',
          produced_servings: 4,
          produced_weight_grams: 800,
          served_weight_grams: 0,
          wasted_weight_grams: 0,
          remaining_weight_grams: 800
        }
      ], [
        { id: 'production-1', total_cost: 80 },
        { id: 'production-2', total_cost: 40 },
        { id: 'production-3', total_cost: 96 }
      ]);

      const rice = summary.find((row) => row.recipe_id === 'rice');
      assert.equal(summary.length, 2);
      assert.equal(rice.recipe_name, 'Rice');
      assert.equal(rice.batch_count, 2);
      assert.equal(rice.produced_weight_grams, 1500);
      assert.equal(rice.available_weight_grams, 1050);
      assert.equal(rice.wasted_weight_grams, 150);
      assert.equal(rice.estimated_cost_per_gram, 0.08);
    }
  },
  {
    name: 'explodes menu production batches into filled manifest item waste rows',
    run() {
      const summary = buildBatchOverproductionDishSummary([
        {
          id: 'batch-menu',
          batch_number: 'PIB-001',
          production_id: 'production-menu',
          production_date: '2026-05-12',
          meal_type: 'breakfast',
          status: 'partial',
          recipe_id: 'menu-event',
          recipe_name: 'Breakfast Menu Junior / General (3 Items)',
          produced_weight_grams: 3000,
          served_weight_grams: 300,
          wasted_weight_grams: 200,
          remaining_weight_grams: 2500,
          menu_issue_items: [
            {
              key: 'line-eggs',
              recipe_id: 'eggs',
              recipe_name: 'Boiled Eggs',
              production_covers: 10,
              yielded_weight_grams: 1000,
              estimated_batch_cost: 30
            },
            {
              key: 'line-bread',
              recipe_id: 'bread',
              recipe_name: 'Arabic Bread',
              production_covers: 10,
              yielded_weight_grams: 2000,
              estimated_batch_cost: 20
            },
            {
              key: 'line-blank',
              recipe_id: 'blank',
              recipe_name: 'Blank Planned Line',
              production_covers: 0,
              yielded_weight_grams: 0,
              estimated_batch_cost: 99
            }
          ]
        }
      ], [], [
        {
          id: 'waste-eggs',
          site_id: 'store-1',
          waste_date: '2026-05-12',
          meal_type: 'breakfast',
          source_type: 'batch_overproduction',
          status: 'logged',
          recipe_id: 'eggs',
          batch_overproduction_item_key: 'batch-menu::line-eggs',
          output_allocations: [
            {
              produced_item_batch_id: 'batch-menu',
              batch_overproduction_item_key: 'batch-menu::line-eggs',
              wasted_weight_grams: 200
            }
          ]
        }
      ]);

      assert.equal(summary.length, 2);
      const eggs = summary.find((row) => row.recipe_id === 'eggs');
      const bread = summary.find((row) => row.recipe_id === 'bread');
      assert.equal(eggs.waste_key, 'batch-menu::line-eggs');
      assert.equal(eggs.recipe_name, 'Boiled Eggs');
      assert.equal(eggs.produced_weight_grams, 1000);
      assert.equal(eggs.served_weight_grams, 100);
      assert.equal(eggs.wasted_weight_grams, 200);
      assert.equal(eggs.available_weight_grams, 700);
      assert.equal(bread.produced_weight_grams, 2000);
      assert.equal(bread.available_weight_grams, 1800);
      assert.equal(summary.some((row) => row.recipe_id === 'blank'), false);
    }
  },
  {
    name: 'loads filled menu batch rows when per-item yielded weights are missing',
    run() {
      const summary = buildBatchOverproductionDishSummary([
        {
          id: 'batch-menu',
          batch_number: 'PIB-002',
          production_id: 'production-menu',
          production_date: '2026-09-05',
          meal_type: 'breakfast',
          status: 'available',
          recipe_id: 'breakfast-menu',
          recipe_name: 'Breakfast Menu Senior / General (3 Items)',
          produced_weight_grams: 6000,
          served_weight_grams: 0,
          wasted_weight_grams: 0,
          remaining_weight_grams: 6000,
          menu_issue_items: [
            {
              key: 'line-chana',
              recipe_id: 'chana',
              recipe_name: 'Chana Masala',
              production_covers: 1,
              estimated_batch_cost: 30
            },
            {
              key: 'line-coffee',
              recipe_id: 'coffee',
              recipe_name: 'Classic Coffee',
              production_covers: 1,
              estimated_batch_cost: 20
            },
            {
              key: 'line-blank',
              recipe_id: 'blank',
              recipe_name: 'Blank Planned Line',
              production_covers: 0,
              estimated_batch_cost: 99
            }
          ]
        }
      ]);

      assert.equal(summary.length, 2);
      assert.deepEqual(summary.map((row) => row.recipe_name), ['Chana Masala', 'Classic Coffee']);
      assert.equal(summary.reduce((sum, row) => sum + row.produced_weight_grams, 0), 6000);
      assert.equal(summary.find((row) => row.recipe_id === 'chana').produced_weight_grams, 3600);
      assert.equal(summary.find((row) => row.recipe_id === 'coffee').produced_weight_grams, 2400);
    }
  },
  {
    name: 'allocates batch overproduction waste against produced item balances',
    run() {
      const allocation = allocateBatchOverproductionWaste({
        recipeId: 'rice',
        wasteWeightGrams: 900,
        batches: [
          {
            id: 'batch-1',
            batch_number: 'B-001',
            production_id: 'production-1',
            status: 'available',
            recipe_id: 'rice',
            portion_size_grams: 100,
            served_servings: 0,
            served_weight_grams: 0,
            wasted_servings: 0,
            wasted_weight_grams: 0,
            remaining_servings: 6,
            remaining_weight_grams: 600
          },
          {
            id: 'batch-2',
            batch_number: 'B-002',
            production_id: 'production-2',
            status: 'available',
            recipe_id: 'rice',
            portion_size_grams: 100,
            served_servings: 0,
            served_weight_grams: 0,
            wasted_servings: 0,
            wasted_weight_grams: 0,
            remaining_servings: 7,
            remaining_weight_grams: 700
          }
        ]
      });

      assert.equal(allocation.wasted_weight_grams, 900);
      assert.equal(allocation.wasted_production_equivalent_servings, 9);
      assert.deepEqual(allocation.allocations.map((item) => item.wasted_weight_grams), [600, 300]);
      assert.equal(allocation.batches[0].remaining_weight_grams, 0);
      assert.equal(allocation.batches[0].status, 'consumed');
      assert.equal(allocation.batches[1].remaining_weight_grams, 400);
      assert.equal(allocation.batches[1].status, 'partial');
    }
  },
  {
    name: 'allocates manifest item waste against its parent menu production batch',
    run() {
      const allocation = allocateBatchOverproductionWaste({
        recipeId: 'eggs',
        productionId: 'production-menu',
        manifestItemKey: 'batch-menu::line-eggs',
        wasteWeightGrams: 300,
        summaryRow: {
          recipe_id: 'eggs',
          recipe_name: 'Boiled Eggs',
          estimated_cost_per_gram: 0.03,
          batch_overproduction_item_key: 'batch-menu::line-eggs',
          manifest_item_key: 'line-eggs',
          source_menu_plan_item_key: 'line-eggs',
          batches: [
            {
              id: 'batch-menu',
              batch_overproduction_item_key: 'batch-menu::line-eggs',
              manifest_item_key: 'line-eggs',
              source_menu_plan_item_key: 'line-eggs',
              recipe_name: 'Boiled Eggs',
              remaining_weight_grams: 500
            }
          ]
        },
        batches: [
          {
            id: 'batch-menu',
            batch_number: 'PIB-001',
            production_id: 'production-menu',
            status: 'available',
            recipe_id: 'menu-event',
            recipe_name: 'Breakfast Menu Junior / General (3 Items)',
            portion_size_grams: 100,
            served_servings: 0,
            served_weight_grams: 0,
            wasted_servings: 0,
            wasted_weight_grams: 0,
            remaining_servings: 10,
            remaining_weight_grams: 1000
          }
        ]
      });

      assert.equal(allocation.wasted_weight_grams, 300);
      assert.equal(allocation.allocations[0].recipe_id, 'eggs');
      assert.equal(allocation.allocations[0].recipe_name, 'Boiled Eggs');
      assert.equal(allocation.allocations[0].batch_recipe_id, 'menu-event');
      assert.equal(allocation.allocations[0].batch_overproduction_item_key, 'batch-menu::line-eggs');
      assert.equal(allocation.allocations[0].manifest_item_key, 'line-eggs');
      assert.equal(allocation.batches[0].remaining_weight_grams, 700);
    }
  },
  {
    name: 'normalizes batch overproduction waste quantities to grams',
    run() {
      assert.equal(normalizeFoodWasteWeightGrams(1.25, 'kg'), 1250);
      assert.equal(normalizeFoodWasteWeightGrams(325, 'g'), 325);
      assert.throws(() => normalizeFoodWasteWeightGrams(2, 'servings'), /grams/);
    }
  },
  {
    name: 'decorates food waste records with window metadata',
    run() {
      const record = decorateFoodWasteRecord({
        id: 'waste-1',
        waste_date: '2026-05-12',
        meal_type: 'lunch',
        production_completed_at: '2026-05-12T12:00:00.000Z'
      }, '2026-05-12T12:45:00.000Z');

      assert.equal(record.window_status, 'open');
      assert.ok(record.recording_deadline_at);
      assert.equal(record.recording_window_basis, 'production_48_hours');
    }
  },
  {
    name: 'requires photo evidence and deducts ingredient stock on waste create',
    run() {
      const server = read('server/index.js');
      assert.match(server, /Add a waste picture before saving this record/);
      assert.match(server, /Select the location and ingredient to remove from inventory/);
      assert.match(server, /adminHistoricalCreateAllowed/);
      assert.match(server, /deductStock\(\{/);
      assert.match(server, /transaction_type: 'waste'/);
      assert.match(server, /source_type: 'food_waste'/);
      assert.match(server, /idempotency_key: `\$\{wasteRecord\.id\}:food-waste-deduction`/);
    }
  },
  {
    name: 'shows mandatory waste picture upload in the form',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      const api = read('src/api/base44Client.js');
      assert.match(page, /Waste Picture/);
      assert.match(page, /UploadWasteImage/);
      assert.match(page, /Add required waste picture/);
      assert.match(page, /!wasteImageFile && !formData\.evidence_image_url/);
      assert.match(api, /UploadWasteImage\(\{ file \}\)/);
      assert.match(api, /\/api\/integrations\/waste-image/);
    }
  },
  {
    name: 'limits food waste edit controls to administrators',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      const api = read('src/api/base44Client.js');
      const server = read('server/index.js');
      const entities = read('server/entities.js');
      assert.match(page, /const \{ can, isAdmin \} = usePermissions\(\)/);
      assert.match(page, /Only administrators can edit waste requests\./);
      assert.match(page, /isAdmin \? \(/);
      assert.match(page, /adminWasteWindowOverride/);
      assert.match(page, /adminEditingExistingWaste/);
      assert.match(page, /wasteContextAllowsSave/);
      assert.match(page, /editingBatchOverproductionWaste/);
      assert.match(page, /isBatchOverproductionEntryMode/);
      assert.match(page, /disabled=\{String\(item\.status \|\| ''\)\.toLowerCase\(\) === 'reversed'\}/);
      assert.match(api, /emitEntityChange\('FoodWaste', \{ action: 'update'/);
      assert.match(api, /emitEntityChange\('ProducedItemBatch', \{ action: 'food-waste-update'/);
      assert.match(server, /Only administrators can edit food waste requests\./);
      assert.match(server, /adminHistoricalEditAllowed/);
      assert.match(server, /updateBatchOverproductionFoodWasteRecord/);
      assert.match(server, /reverseBatchOverproductionWasteAllocations/);
      assert.match(entities, /Only administrators can edit food waste requests/);
      assert.match(entities, /approvalOnlyUpdate[\s\S]*return true/);
    }
  },
  {
    name: 'adds admin-only food waste reversal controls and API',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      const api = read('src/api/base44Client.js');
      const server = read('server/index.js');
      assert.match(page, /Only administrators can reverse waste requests\./);
      assert.match(page, /handleOpenReverseDialog/);
      assert.match(page, /Reverse Food Waste Record/);
      assert.match(page, /base44\.foodWaste\.reverse/);
      assert.match(api, /reverse\(id, data = \{\}\)/);
      assert.match(api, /\/api\/food-waste\/\$\{encodeURIComponent\(id\)\}\/reverse/);
      assert.match(api, /action: 'reverse'/);
      assert.match(api, /action: 'food-waste-reversal'/);
      assert.match(server, /app\.post\('\/api\/food-waste\/:id\/reverse'/);
      assert.match(server, /Only administrators can reverse food waste records\./);
      assert.match(server, /reverseFoodWasteRecord/);
      assert.match(server, /FOOD_WASTE_REVERSED/);
      assert.match(server, /food-waste-reversal/);
    }
  },
  {
    name: 'removes manual scope and recipe controls while keeping quantity',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      const api = read('src/api/base44Client.js');
      const db = read('server/db.js');
      const server = read('server/index.js');
      assert.doesNotMatch(page, /<SelectItem value="ingredient">Ingredient<\/SelectItem>/);
      assert.doesNotMatch(page, /<SelectItem value="location">Location<\/SelectItem>/);
      assert.doesNotMatch(page, /value=\{formData\.waste_scope\}/);
      assert.doesNotMatch(page, /value=\{formData\.recipe_id\}/);
      assert.match(page, /<Label>Quantity<\/Label>/);
      assert.match(page, /readOnly=\{isBatchOverproductionEntryMode\}/);
      assert.doesNotMatch(page, /IngredientSearchCombobox/);
      assert.doesNotMatch(page, /formData\.waste_scope === 'ingredient' && formData\.ingredient_id === 'none'/);
      assert.match(page, /function getWasteWeightGrams/);
      assert.match(page, /getWasteQuantityKg\(item\)/);
      assert.match(page, /function getWasteCost\(item = \{\}, productionMap = new Map\(\)\)/);
      assert.match(page, /getWasteCost\(item, productionMap\)/);
      assert.match(page, /record\.production_cost_total/);
      assert.match(page, /record\.ingredient_cost_total/);
      assert.match(page, /This weight will be deducted from the consumed amount under Meal Service Menu\./);
      assert.match(page, /Batch Overproduction Production Summary/);
      assert.match(page, /<TableHead>Produced Item<\/TableHead>/);
      assert.match(page, /<TableHead>Produced Quantity<\/TableHead>/);
      assert.match(page, /<TableHead>Recorded Food Waste \(g\)<\/TableHead>/);
      assert.match(page, /getBatchWasteRowKey/);
      assert.match(page, /batch_overproduction_item_key/);
      assert.match(page, /Production completed:/);
      assert.match(page, /Admin window:/);
      assert.match(page, /setDishWasteGramsByRecipe/);
      assert.match(server, /batch_overproduction_dishes: batchOverproductionDishes/);
      assert.match(server, /getLatestSuccessfulProductionCompletedAt/);
      assert.match(server, /isAdmin: hasAdminAccess\(user\)/);
      assert.match(server, /production_completed_at: context\.production_completed_at/);
      assert.match(server, /allocateBatchOverproductionWaste/);
      assert.match(server, /calculateProducedOutputWasteCost/);
      assert.match(server, /withFoodWasteCostAndApproval/);
      assert.match(server, /enrichFoodWasteDisplayCosts/);
      assert.match(server, /calculatePlateWasteDisplayCost/);
      assert.match(server, /record\.production_cost_total/);
      assert.match(server, /record\.ingredient_cost_total/);
      assert.match(server, /updateDocument\('ProducedItemBatch'/);
      assert.match(server, /buildPlateWasteMealServiceAdjustments/);
      assert.match(server, /buildConsumptionCostPerGramById/);
      assert.match(server, /movement_type: 'plate_waste_adjustment'/);
      assert.match(server, /meal_service_adjustment_cost: plateWasteAdjustment\.estimatedCost/);
      assert.match(api, /emitEntityChange\('ProducedItemBatch', \{ action: 'food-waste'/);
      assert.match(api, /emitEntityChange\('MealServiceConsumption', \{ action: 'plate-waste-adjustment'/);
      assert.match(db, /'batch_overproduction'/);
    }
  }
];

let failures = 0;
for (const testCase of cases) {
  try {
    testCase.run();
    process.stdout.write(`ok - ${testCase.name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${testCase.name}\n${error.stack}\n`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
