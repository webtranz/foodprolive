import assert from 'node:assert/strict';

import {
  buildFoodWasteMenuPlanSummary,
  decorateFoodWasteRecord,
  getMealServiceWindow,
  isApprovalOnlyWastePatch,
  normalizeMealType
} from '../server/foodWaste.js';

const cases = [
  {
    name: 'normalizes supported meal types only',
    run() {
      assert.equal(normalizeMealType(' Breakfast '), 'breakfast');
      assert.equal(normalizeMealType('snack'), '');
    }
  },
  {
    name: 'opens the recording window for two hours after meal service',
    run() {
      const window = getMealServiceWindow({
        wasteDate: '2026-05-12',
        mealType: 'lunch',
        now: '2026-05-12T13:15:00'
      });

      assert.equal(window.window_status, 'open');
      assert.equal(window.is_within_recording_window, true);
      assert.equal(window.can_edit, true);
    }
  },
  {
    name: 'closes the recording window after two hours',
    run() {
      const window = getMealServiceWindow({
        wasteDate: '2026-05-12',
        mealType: 'breakfast',
        now: '2026-05-12T09:30:01'
      });

      assert.equal(window.window_status, 'closed');
      assert.equal(window.is_within_recording_window, false);
      assert.equal(window.can_edit, false);
    }
  },
  {
    name: 'identifies before-service meal windows',
    run() {
      const window = getMealServiceWindow({
        wasteDate: '2026-05-12',
        mealType: 'dinner',
        now: '2026-05-12T16:00:00'
      });

      assert.equal(window.window_status, 'before_service');
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
    name: 'decorates food waste records with window metadata',
    run() {
      const record = decorateFoodWasteRecord({
        id: 'waste-1',
        waste_date: '2026-05-12',
        meal_type: 'lunch'
      }, '2026-05-12T12:45:00');

      assert.equal(record.window_status, 'open');
      assert.ok(record.recording_deadline_at);
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
