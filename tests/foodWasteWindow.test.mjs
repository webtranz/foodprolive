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
      assert.match(page, /readOnly=\{isBatchOverproduction\}/);
      assert.doesNotMatch(page, /IngredientSearchCombobox/);
      assert.doesNotMatch(page, /formData\.waste_scope === 'ingredient' && formData\.ingredient_id === 'none'/);
      assert.match(page, /function getWasteWeightGrams/);
      assert.match(page, /getWasteQuantityKg\(item\)/);
      assert.match(page, /This weight will be deducted from the consumed amount under Meal Service Menu\./);
      assert.match(page, /Batch Overproduction Production Summary/);
      assert.match(page, /<TableHead>Dish Name<\/TableHead>/);
      assert.match(page, /<TableHead>Produced Quantity<\/TableHead>/);
      assert.match(page, /<TableHead>Recorded Food Waste \(g\)<\/TableHead>/);
      assert.match(page, /Production completed:/);
      assert.match(page, /Admin window:/);
      assert.match(page, /setDishWasteGramsByRecipe/);
      assert.match(server, /batch_overproduction_dishes: batchOverproductionDishes/);
      assert.match(server, /getLatestSuccessfulProductionCompletedAt/);
      assert.match(server, /isAdmin: hasAdminAccess\(user\)/);
      assert.match(server, /production_completed_at: context\.production_completed_at/);
      assert.match(server, /allocateBatchOverproductionWaste/);
      assert.match(server, /updateDocument\('ProducedItemBatch'/);
      assert.match(server, /buildPlateWasteMealServiceAdjustments/);
      assert.match(server, /movement_type: 'plate_waste_adjustment'/);
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
