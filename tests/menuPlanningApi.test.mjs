import assert from 'node:assert/strict';
import './menuRecipeLinks.test.mjs';

import {
  buildApiObjectResponse,
  buildMenuPlanWeekRange,
  filterMenuPlansForWeek,
  summarizeMenuPlanCostPreview,
  validateSiteAndDateInput,
  validateMenuPlanPayload,
  validatePRGenerationPayload,
  validateFoodWasteContextInput
} from '../server/menuPlanningApi.js';

const sampleRecipes = [
  {
    id: 'recipe-breakfast',
    name: 'Egg Tray',
    servings: 10,
    ingredients: [
      { ingredient_id: 'ingredient-eggs', quantity: 20, unit: 'pieces' }
    ]
  },
  {
    id: 'recipe-lunch',
    name: 'Kabsa',
    servings: 5,
    sub_recipes: [
      { recipe_id: 'recipe-rice-base', recipe_name: 'Rice Base', quantity: 1, unit: 'batch' }
    ],
    ingredients: []
  },
  {
    id: 'recipe-rice-base',
    name: 'Rice Base',
    servings: 5,
    ingredients: [
      { ingredient_id: 'ingredient-rice', quantity: 2, unit: 'kg' }
    ]
  }
];

const sampleIngredients = [
  { id: 'ingredient-eggs', cost_per_unit: 1.5, unit: 'pieces' },
  { id: 'ingredient-rice', cost_per_unit: 8, unit: 'kg' }
];

const cases = [
  {
    name: 'builds a compatible object response envelope',
    run() {
      const response = buildApiObjectResponse({ plan: { id: 'plan-1' } }, { site_id: 'site-1' });
      assert.equal(response.ok, true);
      assert.equal(response.plan.id, 'plan-1');
      assert.equal(response.data.plan.id, 'plan-1');
      assert.equal(response.meta.site_id, 'site-1');
    }
  },
  {
    name: 'validates site/date lookup inputs clearly',
    run() {
      assert.deepEqual(
        validateSiteAndDateInput({ siteId: '', planDate: '2026-05-13' }),
        ['site_id is required']
      );
      assert.deepEqual(
        validateSiteAndDateInput({ siteId: 'site-1', planDate: '13/05/2026' }),
        ['plan_date must be provided in YYYY-MM-DD format']
      );
    }
  },
  {
    name: 'builds a seven day menu planning range without timezone drift',
    run() {
      assert.deepEqual(buildMenuPlanWeekRange('2026-08-10'), {
        start_date: '2026-08-10',
        end_date: '2026-08-16'
      });
      assert.deepEqual(buildMenuPlanWeekRange('2026-12-28'), {
        start_date: '2026-12-28',
        end_date: '2027-01-03'
      });
      assert.equal(buildMenuPlanWeekRange('16/08/2026'), null);
      assert.equal(buildMenuPlanWeekRange('2026-02-30'), null);
    }
  },
  {
    name: 'keeps the weekly calendar isolated to its project and operational dates',
    run() {
      const records = [
        { id: 'before', site_id: 'site-1', plan_date: '2026-08-09', meals: [] },
        { id: 'monday', site_id: 'site-1', plan_date: '2026-08-10', meals: [] },
        { id: 'friday', site_id: 'site-1', plan_date: '2026-08-14', meals: [] },
        { id: 'event', site_id: 'site-1', plan_date: '2026-08-14', event_name: 'VIP Dinner', meals: [] },
        { id: 'other-site', site_id: 'site-2', plan_date: '2026-08-14', meals: [] },
        { id: 'sunday', site_id: 'site-1', plan_date: '2026-08-16', meals: [] },
        { id: 'after', site_id: 'site-1', plan_date: '2026-08-17', meals: [] }
      ];

      assert.deepEqual(
        filterMenuPlansForWeek(records, 'site-1', '2026-08-10').map((record) => record.id),
        ['monday', 'friday', 'sunday']
      );
      assert.deepEqual(filterMenuPlansForWeek(records, '', '2026-08-10'), []);
    }
  },
  {
    name: 'keeps menu plans isolated by cuisine and category',
    run() {
      const records = [
        { id: 'general-senior', site_id: 'site-1', plan_date: '2026-08-10', cuisine_type: 'general', menu_category: 'senior', meals: [] },
        { id: 'general-junior', site_id: 'site-1', plan_date: '2026-08-10', cuisine_type: 'general', menu_category: 'junior', meals: [] },
        { id: 'philippines-labor', site_id: 'site-1', plan_date: '2026-08-10', cuisine_type: 'philippines', menu_category: 'labor', meals: [] }
      ];

      assert.deepEqual(
        filterMenuPlansForWeek(records, 'site-1', '2026-08-10', { cuisine_type: 'general', menu_category: 'junior' }).map((record) => record.id),
        ['general-junior']
      );
      assert.deepEqual(
        filterMenuPlansForWeek(records, 'site-1', '2026-08-10', { cuisine_type: 'philippines', menu_category: 'labor' }).map((record) => record.id),
        ['philippines-labor']
      );
    }
  },
  {
    name: 'validates operational menu plan payloads',
    run() {
      const errors = validateMenuPlanPayload({
        site_id: 'site-1',
        plan_date: '2026-05-13',
        meals: [
          { meal_type: 'breakfast', recipe_id: '', expected_servings: 0 }
        ]
      });

      assert.equal(errors.length, 2);
      assert.match(errors[0], /recipe_id/i);
    }
  },
  {
    name: 'validates PR generation payload requirements',
    run() {
      const errors = validatePRGenerationPayload({
        site_id: 'site-1',
        site_name: '',
        reference_date: '2026/05/13'
      });

      assert.deepEqual(errors, [
        'site_name is required',
        'reference_date must be provided in YYYY-MM-DD format'
      ]);
    }
  },
  {
    name: 'validates food waste context request values',
    run() {
      const errors = validateFoodWasteContextInput({
        siteId: '',
        wasteDate: '2026/05/13',
        mealType: 'snack'
      });

      assert.deepEqual(errors, [
        'site_id is required',
        'waste_date must be provided in YYYY-MM-DD format',
        'meal_type must be breakfast, lunch, or dinner'
      ]);
    }
  },
  {
    name: 'summarizes backend meal-wise food cost safely',
    run() {
      const summary = summarizeMenuPlanCostPreview([
        { meal_type: 'breakfast', recipe_id: 'recipe-breakfast', expected_servings: 10 },
        { meal_type: 'lunch', recipe_id: 'recipe-lunch', expected_servings: 5 },
        { meal_type: 'dinner', recipe_id: 'missing-recipe', expected_servings: 3 }
      ], sampleRecipes, sampleIngredients);

      assert.equal(summary.breakfast.total_cost, 30);
      assert.equal(summary.lunch.total_cost, 16);
      assert.equal(summary.dinner.missing_cost_count, 1);
      assert.equal(summary.total_cost, 46);
      assert.equal(summary.missing_cost_count, 1);
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
  console.log(`PASS ${cases.length} menu planning API tests`);
}
