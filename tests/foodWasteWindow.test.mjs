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
  normalizeMealType,
  normalizeRealRecipeId
} from '../server/foodWaste.js';
import { validateEntityPayload } from '../server/entities.js';

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
    name: 'allows administrators to record waste during the configured default 30 day window',
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
      assert.equal(window.recording_window_basis, 'admin_custom_days');
      assert.equal(window.admin_historical_window_days, 30);
    }
  },
  {
    name: 'blocks administrators outside the configured day window and on future dates',
    run() {
      const outsideWindow = getFoodWasteRecordingWindow({
        wasteDate: '2026-07-31',
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

      assert.equal(outsideWindow.window_status, 'closed');
      assert.equal(outsideWindow.is_within_recording_window, false);
      assert.equal(futureDate.window_status, 'future_date');
      assert.equal(futureDate.is_within_recording_window, false);
    }
  },
  {
    name: 'allows administrators to extend food waste recording by configured days',
    run() {
      const window = getFoodWasteRecordingWindow({
        wasteDate: '2026-08-31',
        mealType: 'breakfast',
        now: '2026-09-04T09:30:01',
        isAdmin: true,
        adminHistoricalWindowDays: 90
      });

      assert.equal(window.window_status, 'open');
      assert.equal(window.is_within_recording_window, true);
      assert.equal(window.admin_historical_window_days, 90);
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
    name: 'builds per-manifest batch overproduction rows from produced batches',
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
          menu_type: 'general',
          menu_category: 'senior',
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
          menu_type: 'general',
          menu_category: 'senior',
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
          menu_type: 'general',
          menu_category: 'junior',
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
      const stew = summary.find((row) => row.recipe_id === 'stew');
      assert.equal(summary.length, 2);
      assert.deepEqual(summary.map((row) => row.recipe_name), ['Stew', 'Rice']);
      assert.equal(rice.menu_category_label, 'Senior');
      assert.equal(rice.batch_count, 2);
      assert.equal(rice.produced_weight_grams, 1500);
      assert.equal(rice.available_weight_grams, 1050);
      assert.equal(rice.wasted_weight_grams, 150);
      assert.equal(rice.estimated_cost_per_gram, 0.08);
      assert.equal(stew.menu_category_label, 'Junior');
      assert.equal(stew.produced_weight_grams, 800);
      assert.equal(stew.available_weight_grams, 800);
    }
  },
  {
    name: 'splits menu production output into manifest item rows',
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
          menu_type: 'general',
          menu_category: 'junior',
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
              batch_overproduction_item_key: 'manifest-item:junior:recipe-eggs:line-eggs',
              manifest_item_key: 'line-eggs',
              wasted_weight_grams: 200
            }
          ]
        }
      ]);

      const eggs = summary.find((row) => row.recipe_id === 'eggs');
      const bread = summary.find((row) => row.recipe_id === 'bread');
      assert.equal(summary.length, 2);
      assert.equal(eggs.waste_key, 'manifest-item:junior:recipe-eggs:line-eggs');
      assert.equal(eggs.recipe_name, 'Boiled Eggs');
      assert.equal(eggs.batch_count, 1);
      assert.equal(eggs.produced_weight_grams, 1000);
      assert.equal(eggs.served_weight_grams, 100);
      assert.equal(eggs.wasted_weight_grams, 200);
      assert.equal(eggs.available_weight_grams, 700);
      assert.equal(bread.produced_weight_grams, 2000);
      assert.equal(bread.served_weight_grams, 200);
      assert.equal(bread.available_weight_grams, 1800);
    }
  },
  {
    name: 'exposes only filled manifest rows for the selected meal category',
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
          menu_type: 'philippines',
          menu_category: 'junior',
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
      assert.deepEqual(summary.map((row) => row.menu_category_label), ['Philippines', 'Philippines']);
      assert.deepEqual(summary.map((row) => row.waste_key), [
        'manifest-item:philippines:recipe-chana:line-chana',
        'manifest-item:philippines:recipe-coffee:line-coffee'
      ]);
      assert.equal(summary.reduce((sum, row) => sum + row.produced_weight_grams, 0), 6000);
    }
  },
  {
    name: 'prefers the full normalized production manifest over short legacy snapshots',
    run() {
      const summary = buildBatchOverproductionDishSummary([
        {
          id: 'batch-menu-full',
          batch_number: 'PIB-003',
          production_id: 'production-full',
          production_date: '2026-09-05',
          meal_type: 'breakfast',
          status: 'available',
          recipe_id: 'breakfast-menu',
          recipe_name: 'Breakfast / General / Junior',
          menu_type: 'general',
          menu_category: 'junior',
          produced_weight_grams: 7000,
          served_weight_grams: 0,
          wasted_weight_grams: 0,
          remaining_weight_grams: 7000,
          menu_issue_items: [
            {
              key: 'line-eggs',
              recipe_id: 'eggs',
              recipe_name: 'Boiled Eggs',
              produced_weight_grams: 4000,
              estimated_batch_cost: 40
            }
          ]
        }
      ], [
        {
          id: 'production-full',
          manifest_lines: [
            {
              production_line_id: 'line-eggs',
              recipe_id: 'eggs',
              recipe_name: 'Boiled Eggs',
              produced_weight_grams: 4000,
              estimated_batch_cost: 40
            },
            {
              production_line_id: 'line-bread',
              ingredient_id: 'arabic-bread',
              item_name: 'Arabic Bread',
              produced_weight_grams: 2000,
              estimated_batch_cost: 10
            },
            {
              production_line_id: 'line-tea',
              ingredient_id: 'tea',
              item_name: 'Tea',
              produced_weight_grams: 1000,
              estimated_batch_cost: 5
            }
          ]
        }
      ]);

      assert.deepEqual(summary.map((row) => row.recipe_name), ['Arabic Bread', 'Boiled Eggs', 'Tea']);
      assert.equal(summary.reduce((sum, row) => sum + row.produced_weight_grams, 0), 7000);
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
    name: 'keeps produced item serving balances reconciled for gram-based waste',
    run() {
      const allocation = allocateBatchOverproductionWaste({
        recipeId: 'egg-curry',
        wasteWeightGrams: 200,
        batches: [
          {
            id: 'batch-mixed-basis',
            batch_number: 'B-003',
            production_id: 'production-3',
            production_date: '2026-09-02',
            completed_at: '2026-09-02T08:00:00.000Z',
            site_id: '384',
            status: 'available',
            recipe_id: 'egg-curry',
            meal_type: 'breakfast',
            portion_size_grams: 100,
            expected_servings: 1,
            expected_finished_weight_grams: 1000,
            actual_finished_weight_grams: 1000,
            produced_servings: 1,
            produced_weight_grams: 1000,
            served_servings: 0,
            served_weight_grams: 0,
            wasted_servings: 0,
            wasted_weight_grams: 0,
            remaining_servings: 1,
            remaining_weight_grams: 1000,
            cutover_version: 1
          }
        ]
      });

      const [batch] = allocation.batches;
      assert.equal(allocation.wasted_weight_grams, 200);
      assert.equal(allocation.wasted_production_equivalent_servings, 0.2);
      assert.equal(batch.wasted_weight_grams, 200);
      assert.equal(batch.remaining_weight_grams, 800);
      assert.equal(batch.wasted_servings, 0.2);
      assert.equal(batch.remaining_servings, 0.8);
      assert.equal(
        Number((batch.served_servings + batch.wasted_servings + batch.remaining_servings).toFixed(6)),
        batch.produced_servings
      );
      assert.doesNotThrow(() => validateEntityPayload('ProducedItemBatch', batch));
    }
  },
  {
    name: 'allocates menu-category waste against its matching production batches',
    run() {
      assert.equal(normalizeRealRecipeId('batch-overproduction:junior'), null);
      assert.equal(normalizeRealRecipeId('menu-category:junior'), null);
      assert.equal(normalizeRealRecipeId('recipe-1'), 'recipe-1');

      const allocation = allocateBatchOverproductionWaste({
        recipeId: 'batch-overproduction:junior',
        productionId: 'production-menu',
        manifestItemKey: 'menu-category:junior',
        wasteWeightGrams: 300,
        summaryRow: {
          recipe_id: 'batch-overproduction:junior',
          recipe_name: 'Junior',
          estimated_cost_per_gram: 0.03,
          batch_overproduction_item_key: 'menu-category:junior',
          menu_category_key: 'junior',
          menu_category_label: 'Junior',
          batches: [
            {
              id: 'batch-menu',
              batch_overproduction_item_key: 'menu-category:junior',
              recipe_name: 'Junior',
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
      assert.equal(allocation.allocations[0].recipe_id, null);
      assert.equal(allocation.allocations[0].recipe_name, 'Junior');
      assert.equal(allocation.allocations[0].batch_recipe_id, 'menu-event');
      assert.equal(allocation.allocations[0].batch_overproduction_item_key, 'menu-category:junior');
      assert.equal(allocation.allocations[0].manifest_item_key, 'menu-category:junior');
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
      assert.match(server, /Add at least one waste picture before saving this record/);
      assert.match(server, /Select the location and ingredient to remove from inventory/);
      assert.match(server, /!context\.is_within_recording_window/);
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
      assert.match(page, /Waste Pictures/);
      assert.match(page, /UploadWasteImage/);
      assert.match(page, /Add required waste pictures/);
      assert.match(page, /MAX_WASTE_PICTURES/);
      assert.match(page, /compressWasteImageFile/);
      assert.match(page, /!hasWasteEvidenceImages/);
      assert.match(api, /UploadWasteImage\(\{ file, \.\.\.context \}\)/);
      assert.match(api, /\/api\/integrations\/waste-image/);
      const server = read('server/index.js');
      assert.match(server, /persistWasteEvidenceFile/);
      assert.match(server, /persistDatabaseUploadedFile\(file, 'waste-images'/);
      assert.match(server, /FOOD_WASTE_EVIDENCE_IMAGE_LIMITS/);
    }
  },
  {
    name: 'shows waste records as location summaries with category details and gallery',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      assert.match(page, /const \[wastePictureGallery, setWastePictureGallery\]/);
      assert.match(page, /function getWasteMealCategoryLabel/);
      assert.match(page, /wasteRecordLocationSummaries/);
      assert.match(page, /selectedWasteDetailDateGroups/);
      assert.match(page, /One summary card per location/);
      assert.match(page, /Date-specific detail/);
      assert.match(page, /Breakfast · Lunch · Dinner/);
      assert.match(page, /handleOpenWastePictureGallery\(representative\)/);
      assert.match(page, /Waste Pictures/);
      assert.match(page, /wastePictureGallery\.images\.map/);
      assert.match(page, /Open selected picture/);
      assert.doesNotMatch(page, /href=\{evidenceUrl\}[\s\S]*target="_blank"[\s\S]*View/);
    }
  },
  {
    name: 'shows food waste save errors inside the dialog instead of silently disabling save',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      assert.match(page, /Waste recording window is still loading\. Wait a moment and try again\./);
      assert.match(page, /wasteContextError\.message \|\| 'Unable to verify the waste recording window/);
      assert.match(page, /wasteContext\?\.message \|\| 'Waste recording is closed/);
      assert.match(page, /createWasteMutation\.mutateAsync/);
      assert.match(page, /updateWasteMutation\.mutateAsync/);
      assert.match(page, /border-red-200 bg-red-50/);
      assert.doesNotMatch(page, /\|\| !formData\.quantity/);
      assert.doesNotMatch(page, /\|\| !hasWasteEvidenceImages/);
      assert.doesNotMatch(page, /\|\| !wasteContextAllowsSave/);
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
      assert.match(page, /wasteContextAllowsSave/);
      assert.match(page, /adminWasteWindowEditorOpen/);
      assert.match(page, /admin-food-waste-window-toggle/);
      assert.match(page, /Admin food waste recording allowance/);
      assert.match(page, /admin-food-waste-window-days/);
      assert.doesNotMatch(page, /admin-food-waste-window-toggle-dialog/);
      assert.match(api, /updateAdminWindowSettings/);
      assert.match(page, /editingBatchOverproductionWaste/);
      assert.match(page, /isBatchOverproductionEntryMode/);
      assert.match(page, /disabled=\{String\(representative\.status \|\| ''\)\.toLowerCase\(\) === 'reversed'\}/);
      assert.match(api, /emitEntityChange\('FoodWaste', \{ action: 'update'/);
      assert.match(api, /emitEntityChange\('ProducedItemBatch', \{ action: 'food-waste-update'/);
      assert.match(server, /Only administrators can edit food waste requests\./);
      assert.match(server, /!updateContext\.can_edit/);
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
    name: 'preserves ingredient links when editing batch overproduction waste',
    run() {
      const server = read('server/index.js');
      const editStart = server.indexOf('async function updateBatchOverproductionFoodWasteRecord');
      const editEnd = server.indexOf('function buildPlateWasteAdjustmentReversalRow', editStart);
      assert.ok(editStart >= 0 && editEnd > editStart, 'batch overproduction edit helper should exist');
      const helper = server.slice(editStart, editEnd);

      assert.match(helper, /resolveExistingDocumentId\(\s*'Ingredient'/);
      assert.match(helper, /existing\.ingredient_id \|\| payload\.ingredient_id \|\| firstAllocation\?\.ingredient_id/);
      assert.match(helper, /ingredient_id:\s*linkedIngredientId/);
    }
  },
  {
    name: 'removes manual scope and recipe controls while keeping quantity',
    run() {
      const page = read('src/pages/FoodWaste.jsx');
      const api = read('src/api/base44Client.js');
      const db = read('server/db.js');
      const server = read('server/index.js');
      const mealService = read('server/mealService.js');
      const foodWasteServer = read('server/foodWaste.js');
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
      assert.match(page, /Batch Overproduction by Menu Manifest/);
      assert.match(page, /each produced recipe\/menu item/);
      assert.match(page, /Recorded waste \(g\)/);
      assert.match(foodWasteServer, /menu-category:senior/);
      assert.match(foodWasteServer, /menu-category:junior/);
      assert.match(foodWasteServer, /menu-category:labor/);
      assert.match(foodWasteServer, /menu-category:philippines/);
      assert.match(page, /getBatchWasteRowKey/);
      assert.match(page, /batch_overproduction_item_key/);
      assert.match(page, /Production completed:/);
      assert.match(page, /Admin window:/);
      assert.match(page, /setDishWasteGramsByRecipe/);
      assert.doesNotMatch(server, /Promise\.all\(batchWasteAllocation\.batches\.map/);
      assert.match(server, /batch_overproduction_dishes: batchOverproductionDishes/);
      assert.match(server, /getLatestSuccessfulProductionCompletedAt/);
      assert.match(server, /getFoodWasteAdminWindowSettings/);
      assert.match(server, /adminHistoricalWindowDays: adminWindowSettings\.days/);
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
      assert.match(db, /async function replaceFoodWasteLines/);
      assert.match(db, /DELETE FROM food_waste_lines WHERE food_waste_id = \$1/);
      assert.match(db, /INSERT INTO food_waste_lines/);
      assert.match(db, /await replaceFoodWasteLines\(record, executor\)/);
      assert.match(db, /'output_allocations'/);
      assert.match(db, /FROM production_manifest_lines line/);
      assert.match(db, /AS manifest_lines/);
      assert.match(db, /menu_issue_items: manifestLines/);
      assert.match(db, /'manifest_item_key', COALESCE\(line\.item_key, line\.source_menu_plan_item_key, line\.production_line_id\)/);
      assert.match(mealService, /manifest_lines: manifestLines/);
      assert.match(server, /resolveFoodWasteProductionSiteIds\(siteIdValue\)/);
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
