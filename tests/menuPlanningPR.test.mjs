import assert from 'node:assert/strict';

import {
  buildCycleWindow,
  aggregateMenuPlanRequirements,
  findExistingSuccessfulCycleRun
} from '../server/menuPlanningProcurement.js';

const sampleMenuPlans = [
  {
    id: 'plan-1',
    site_id: 'site-1',
    plan_date: '2026-05-14',
    meals: [
      { meal_type: 'breakfast', recipe_id: 'recipe-breakfast', recipe_name: 'Egg Tray', expected_servings: 20 },
      { meal_type: 'lunch', recipe_id: 'recipe-rice', recipe_name: 'Kabsa Rice', expected_servings: 30 }
    ]
  },
  {
    id: 'plan-2',
    site_id: 'site-1',
    plan_date: '2026-05-16',
    meals: [
      { meal_type: 'dinner', recipe_id: 'recipe-rice', recipe_name: 'Kabsa Rice', expected_servings: 15 }
    ]
  }
];

const sampleRecipes = [
  {
    id: 'recipe-breakfast',
    name: 'Egg Tray',
    servings: 10,
    sub_recipes: [
      { recipe_id: 'recipe-egg-base', recipe_name: 'Egg Base', quantity: 1, unit: 'batch' }
    ],
    ingredients: [
      { ingredient_id: 'ingredient-bread', quantity: 10, unit: 'pieces' }
    ]
  },
  {
    id: 'recipe-egg-base',
    name: 'Egg Base',
    servings: 10,
    ingredients: [
      { ingredient_id: 'ingredient-eggs', quantity: 20, unit: 'pieces' }
    ]
  },
  {
    id: 'recipe-rice',
    name: 'Kabsa Rice',
    servings: 15,
    ingredients: [
      { ingredient_id: 'ingredient-rice', quantity: 3, unit: 'kg' }
    ]
  }
];

const sampleIngredients = [
  { id: 'ingredient-eggs', name: 'Eggs', unit: 'pieces', cost_per_unit: 1.5 },
  { id: 'ingredient-bread', name: 'Bread', unit: 'pieces', cost_per_unit: 1 },
  { id: 'ingredient-rice', name: 'Rice', unit: 'kg', cost_per_unit: 8 }
];

const cases = [
  {
    name: 'builds a 7-day cycle from the next preferred Thursday',
    run() {
      const cycle = buildCycleWindow('2026-05-12', 7, 'thursday');
      assert.deepEqual(cycle, {
        requested_run_date: '2026-05-12',
        preferred_run_date: '2026-05-14',
        cycle_start: '2026-05-14',
        cycle_end: '2026-05-20',
        cycle_days: 7,
        preferred_weekday: 'thursday',
        is_preferred_day: false
      });
    }
  },
  {
    name: 'uses the same day when the reference date is already Thursday',
    run() {
      const cycle = buildCycleWindow('2026-05-14', 7, 'thursday');
      assert.equal(cycle.preferred_run_date, '2026-05-14');
      assert.equal(cycle.cycle_start, '2026-05-14');
      assert.equal(cycle.cycle_end, '2026-05-20');
      assert.equal(cycle.is_preferred_day, true);
    }
  },
  {
    name: 'prevents duplicate generation when a cycle already has a successful run',
    run() {
      const run = findExistingSuccessfulCycleRun([
        { id: 'run-1', cycle_start: '2026-05-14', cycle_end: '2026-05-20', status: 'generated' },
        { id: 'run-2', cycle_start: '2026-05-21', cycle_end: '2026-05-27', status: 'failed' }
      ], '2026-05-14', '2026-05-20');

      assert.deepEqual(run, { id: 'run-1', cycle_start: '2026-05-14', cycle_end: '2026-05-20', status: 'generated' });
    }
  },
  {
    name: 'aggregates purchase request quantities from planned menu recipes',
    run() {
      const result = aggregateMenuPlanRequirements(sampleMenuPlans, sampleRecipes, sampleIngredients);

      const eggs = result.items.find((item) => item.ingredient_id === 'ingredient-eggs');
      const bread = result.items.find((item) => item.ingredient_id === 'ingredient-bread');
      const rice = result.items.find((item) => item.ingredient_id === 'ingredient-rice');

      assert.equal(result.items.length, 3);
      assert.equal(eggs.requested_quantity, 40);
      assert.equal(bread.requested_quantity, 20);
      assert.equal(rice.requested_quantity, 9);
      assert.equal(rice.estimated_unit_price, 8);
      assert.deepEqual(result.missing_recipe_ids, []);
      assert.deepEqual(result.missing_ingredient_ids, []);
    }
  }
];

let failed = false;

for (const testCase of cases) {
  try {
    testCase.run();
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
  console.log(`PASS ${cases.length} menu planning PR tests`);
}
