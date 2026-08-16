import assert from 'node:assert/strict';

import {
  buildDailyMenuState,
  buildMenuPlanMeals,
  calculateRecipeCostSnapshot,
  computeBudgetComparison,
  computeMealBudgetStatus,
  createEmptyMealEntry,
  createMealEntryFromRecipe,
  createEmptyDailyMenuState,
  hasMenuCalendarChanges,
  moveMealEntry,
  reorderMealEntries,
  summarizeDailyMenuCosts,
  summarizeMenuCalendarDay,
  summarizeMenuPlanMeals,
  validateDailyMenuState
} from '../src/lib/menuPlanning.js';

const sampleRecipes = [
  {
    id: 'recipe-breakfast',
    name: 'Eggs',
    servings: 18,
    calories_per_serving: 220,
    protein_per_serving: 12,
    carbs_per_serving: 4,
    fat_per_serving: 8,
    sodium_per_serving: 120,
    sugar_per_serving: 2,
    allergens: ['eggs'],
    ingredients: [
      { ingredient_id: 'ingredient-eggs', quantity: 10, unit: 'pieces' }
    ]
  },
  {
    id: 'recipe-lunch',
    name: 'Kabsa',
    servings: 8,
    calories_per_serving: 650,
    protein_per_serving: 30,
    carbs_per_serving: 55,
    fat_per_serving: 18,
    sodium_per_serving: 400,
    sugar_per_serving: 3,
    allergens: [],
    ingredients: [
      { ingredient_id: 'ingredient-rice', quantity: 2, unit: 'kg' }
    ]
  }
];

const sampleIngredients = [
  { id: 'ingredient-eggs', cost_per_unit: 2, unit: 'pieces' },
  { id: 'ingredient-rice', cost_per_unit: 8, unit: 'kg' }
];

const cases = [
  {
    name: 'creates an empty daily menu state',
    run() {
      assert.deepEqual(createEmptyDailyMenuState(), {
        breakfast: [createEmptyMealEntry()],
        lunch: [createEmptyMealEntry()],
        dinner: [createEmptyMealEntry()]
      });
    }
  },
  {
    name: 'loads breakfast lunch and dinner rows from an existing plan',
    run() {
      assert.deepEqual(
        buildDailyMenuState({
          meals: [
            { meal_type: 'breakfast', recipe_id: 'recipe-breakfast', expected_servings: 25 },
            { meal_type: 'breakfast', recipe_id: 'recipe-lunch', expected_servings: 12 },
            { meal_type: 'lunch', recipe_id: 'recipe-lunch', expected_servings: 60 },
            { meal_type: 'snack', recipe_id: 'snack-1', expected_servings: 15 }
          ]
        }),
        {
          breakfast: [
            { recipe_id: 'recipe-breakfast', expected_servings: '25' },
            { recipe_id: 'recipe-lunch', expected_servings: '12' }
          ],
          lunch: [{ recipe_id: 'recipe-lunch', expected_servings: '60' }],
          dinner: [{ recipe_id: '', expected_servings: '' }]
        }
      );
    }
  },
  {
    name: 'summarizes live calendar meals from the daily editor',
    run() {
      const summary = summarizeMenuCalendarDay({
        plan: null,
        formState: {
          breakfast: [{ recipe_id: 'recipe-breakfast', expected_servings: '25' }],
          lunch: [
            { recipe_id: 'recipe-lunch', expected_servings: '50' },
            { recipe_id: 'recipe-breakfast', expected_servings: '10' }
          ],
          dinner: [{ recipe_id: '', expected_servings: '' }]
        },
        recipes: sampleRecipes
      });

      assert.equal(summary.has_core_meals, true);
      assert.equal(summary.total_recipes, 3);
      assert.equal(summary.total_expected_servings, 85);
      assert.equal(summary.incomplete_items, 0);
      assert.equal(summary.meals.breakfast.entries[0].recipe_name, 'Eggs');
      assert.equal(summary.meals.lunch.recipe_count, 2);
    }
  },
  {
    name: 'marks partial calendar entries as incomplete instead of empty',
    run() {
      const summary = summarizeMenuCalendarDay({
        formState: {
          breakfast: [{ recipe_id: 'recipe-breakfast', expected_servings: '' }],
          lunch: [{ recipe_id: '', expected_servings: '20' }],
          dinner: [{ recipe_id: '', expected_servings: '' }]
        },
        recipes: sampleRecipes
      });

      assert.equal(summary.has_core_meals, true);
      assert.equal(summary.total_items, 2);
      assert.equal(summary.incomplete_items, 2);
      assert.equal(summary.total_expected_servings, 0);
    }
  },
  {
    name: 'detects saved and unsaved calendar editor states',
    run() {
      const plan = {
        meals: [
          { meal_type: 'Breakfast', recipe_id: 'recipe-breakfast', expected_servings: 25 },
          { meal_type: 'lunch', recipe_id: 'recipe-lunch', expected_servings: 50 }
        ]
      };
      const matchingState = buildDailyMenuState(plan);

      assert.equal(hasMenuCalendarChanges(createEmptyDailyMenuState(), null), false);
      assert.equal(hasMenuCalendarChanges(matchingState, plan), false);
      assert.equal(hasMenuCalendarChanges({
        ...matchingState,
        lunch: [{ recipe_id: 'recipe-lunch', expected_servings: '60' }]
      }, plan), true);

      const summary = summarizeMenuCalendarDay({ plan, recipes: sampleRecipes });
      assert.equal(summary.meals.breakfast.recipe_count, 1);
      assert.equal(summary.total_expected_servings, 75);
    }
  },
  {
    name: 'preserves non core meals and supports multiple recipes per meal',
    run() {
      const meals = buildMenuPlanMeals(
        {
          breakfast: [
            { recipe_id: 'recipe-breakfast', expected_servings: '20' },
            { recipe_id: 'recipe-lunch', expected_servings: '15' }
          ],
          lunch: [{ recipe_id: 'recipe-lunch', expected_servings: '40' }],
          dinner: [{ recipe_id: '', expected_servings: '' }]
        },
        sampleRecipes,
        sampleIngredients,
        {
          meals: [
            { meal_type: 'snack', recipe_id: 'snack-1', recipe_name: 'Fruit Cup', expected_servings: 10 }
          ]
        }
      );

      assert.equal(meals.length, 4);
      assert.equal(meals[0].meal_type, 'breakfast');
      assert.equal(meals[1].meal_type, 'breakfast');
      assert.equal(meals[2].meal_type, 'lunch');
      assert.equal(meals[3].meal_type, 'snack');
      assert.equal(meals[0].cost_per_serving, 20 / 18);
      assert.equal(meals[2].total_cost, 80);
    }
  },
  {
    name: 'creates a draggable meal row from a recipe',
    run() {
      assert.deepEqual(
        createMealEntryFromRecipe({ id: 'recipe-breakfast', servings: 18 }),
        { recipe_id: 'recipe-breakfast', expected_servings: '18' }
      );
    }
  },
  {
    name: 'reorders recipes within a meal',
    run() {
      const reordered = reorderMealEntries(
        [
          { recipe_id: 'one', expected_servings: '5' },
          { recipe_id: 'two', expected_servings: '10' }
        ],
        0,
        1
      );

      assert.deepEqual(reordered.map((entry) => entry.recipe_id), ['two', 'one']);
    }
  },
  {
    name: 'moves a recipe between meal sections',
    run() {
      const nextState = moveMealEntry(
        {
          breakfast: [
            { recipe_id: 'one', expected_servings: '5' },
            { recipe_id: 'two', expected_servings: '10' }
          ],
          lunch: [{ recipe_id: 'three', expected_servings: '8' }],
          dinner: [{ recipe_id: '', expected_servings: '' }]
        },
        'breakfast',
        'dinner',
        1,
        0
      );

      assert.deepEqual(nextState.breakfast.map((entry) => entry.recipe_id), ['one']);
      assert.deepEqual(nextState.dinner.map((entry) => entry.recipe_id), ['two', '']);
    }
  },
  {
    name: 'calculates recipe cost from ingredient costs',
    run() {
      const snapshot = calculateRecipeCostSnapshot(sampleRecipes[1], sampleIngredients);
      assert.equal(snapshot.has_cost, true);
      assert.equal(snapshot.total_cost, 16);
      assert.equal(snapshot.cost_per_serving, 2);
    }
  },
  {
    name: 'summarizes meal wise and total costs safely',
    run() {
      const summary = summarizeDailyMenuCosts(
        {
          breakfast: [{ recipe_id: 'recipe-breakfast', expected_servings: '18' }],
          lunch: [{ recipe_id: 'recipe-lunch', expected_servings: '10' }],
          dinner: [{ recipe_id: 'unknown-recipe', expected_servings: '5' }]
        },
        sampleRecipes,
        sampleIngredients
      );

      assert.equal(summary.breakfast.total_cost, 20);
      assert.equal(summary.lunch.total_cost, 20);
      assert.equal(summary.dinner.missing_cost_count, 1);
      assert.equal(summary.total_cost, 40);
    }
  },
  {
    name: 'computes remaining and exceeded budget safely',
    run() {
      assert.deepEqual(
        computeBudgetComparison(120, 90),
        {
          budget_amount: 120,
          planned_cost: 90,
          remaining_budget: 30,
          exceeded_amount: 0,
          is_over_budget: false
        }
      );

      assert.deepEqual(
        computeBudgetComparison(75, 100),
        {
          budget_amount: 75,
          planned_cost: 100,
          remaining_budget: 0,
          exceeded_amount: 25,
          is_over_budget: true
        }
      );
    }
  },
  {
    name: 'computes meal budget status safely',
    run() {
      assert.deepEqual(
        computeMealBudgetStatus(40, 22),
        {
          limit_amount: 40,
          planned_cost: 22,
          remaining_amount: 18,
          exceeded_amount: 0,
          has_limit: true,
          is_over_limit: false
        }
      );

      assert.deepEqual(
        computeMealBudgetStatus(15, 21),
        {
          limit_amount: 15,
          planned_cost: 21,
          remaining_amount: 0,
          exceeded_amount: 6,
          has_limit: true,
          is_over_limit: true
        }
      );
    }
  },
  {
    name: 'summarizes servings and calories correctly',
    run() {
      const summary = summarizeMenuPlanMeals([
        { expected_servings: 20, calories_per_serving: 220, total_cost: 30 },
        { expected_servings: 40, calories_per_serving: 650, total_cost: 70 }
      ]);

      assert.deepEqual(summary, {
        total_expected_servings: 60,
        total_calories: 30400,
        total_planned_cost: 100
      });
    }
  },
  {
    name: 'validates date wise meal editor rules',
    run() {
      assert.deepEqual(
        validateDailyMenuState({
          breakfast: [{ recipe_id: '', expected_servings: '' }],
          lunch: [{ recipe_id: '', expected_servings: '' }],
          dinner: [{ recipe_id: '', expected_servings: '' }]
        }),
        ['Plan at least one of breakfast, lunch, or dinner.']
      );

      const errors = validateDailyMenuState({
        breakfast: [{ recipe_id: 'recipe-breakfast', expected_servings: '' }],
        lunch: [{ recipe_id: '', expected_servings: '15' }],
        dinner: [{ recipe_id: '', expected_servings: '' }]
      });

      assert.equal(errors.length, 2);
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
  console.log(`PASS ${cases.length} menu planning tests`);
}
