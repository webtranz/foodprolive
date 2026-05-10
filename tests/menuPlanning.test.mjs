import assert from 'node:assert/strict';

import {
  buildDailyMenuState,
  buildMenuPlanMeals,
  createEmptyDailyMenuState,
  summarizeMenuPlanMeals,
  validateDailyMenuState
} from '../src/lib/menuPlanning.js';

const sampleRecipes = [
  {
    id: 'recipe-breakfast',
    name: 'Eggs',
    calories_per_serving: 220,
    protein_per_serving: 12,
    carbs_per_serving: 4,
    fat_per_serving: 8,
    sodium_per_serving: 120,
    sugar_per_serving: 2,
    allergens: ['eggs']
  },
  {
    id: 'recipe-lunch',
    name: 'Kabsa',
    calories_per_serving: 650,
    protein_per_serving: 30,
    carbs_per_serving: 55,
    fat_per_serving: 18,
    sodium_per_serving: 400,
    sugar_per_serving: 3,
    allergens: []
  }
];

const cases = [
  {
    name: 'creates an empty daily menu state',
    run() {
      assert.deepEqual(createEmptyDailyMenuState(), {
        breakfast: { recipe_id: '', expected_servings: '' },
        lunch: { recipe_id: '', expected_servings: '' },
        dinner: { recipe_id: '', expected_servings: '' }
      });
    }
  },
  {
    name: 'loads breakfast lunch and dinner from an existing plan',
    run() {
      assert.deepEqual(
        buildDailyMenuState({
          meals: [
            { meal_type: 'breakfast', recipe_id: 'recipe-breakfast', expected_servings: 25 },
            { meal_type: 'lunch', recipe_id: 'recipe-lunch', expected_servings: 60 },
            { meal_type: 'snack', recipe_id: 'snack-1', expected_servings: 15 }
          ]
        }),
        {
          breakfast: { recipe_id: 'recipe-breakfast', expected_servings: '25' },
          lunch: { recipe_id: 'recipe-lunch', expected_servings: '60' },
          dinner: { recipe_id: '', expected_servings: '' }
        }
      );
    }
  },
  {
    name: 'preserves non core meals when rebuilding menu plan meals',
    run() {
      const meals = buildMenuPlanMeals(
        {
          breakfast: { recipe_id: 'recipe-breakfast', expected_servings: '20' },
          lunch: { recipe_id: 'recipe-lunch', expected_servings: '40' },
          dinner: { recipe_id: '', expected_servings: '' }
        },
        sampleRecipes,
        {
          meals: [
            { meal_type: 'snack', recipe_id: 'snack-1', recipe_name: 'Fruit Cup', expected_servings: 10 }
          ]
        }
      );

      assert.equal(meals.length, 3);
      assert.equal(meals[0].meal_type, 'breakfast');
      assert.equal(meals[1].meal_type, 'lunch');
      assert.equal(meals[2].meal_type, 'snack');
    }
  },
  {
    name: 'summarizes servings and calories correctly',
    run() {
      const summary = summarizeMenuPlanMeals([
        { expected_servings: 20, calories_per_serving: 220 },
        { expected_servings: 40, calories_per_serving: 650 }
      ]);

      assert.deepEqual(summary, {
        total_expected_servings: 60,
        total_calories: 30400
      });
    }
  },
  {
    name: 'validates date wise meal editor rules',
    run() {
      assert.deepEqual(
        validateDailyMenuState({
          breakfast: { recipe_id: '', expected_servings: '' },
          lunch: { recipe_id: '', expected_servings: '' },
          dinner: { recipe_id: '', expected_servings: '' }
        }),
        ['Plan at least one of breakfast, lunch, or dinner.']
      );

      const errors = validateDailyMenuState({
        breakfast: { recipe_id: 'recipe-breakfast', expected_servings: '' },
        lunch: { recipe_id: '', expected_servings: '15' },
        dinner: { recipe_id: '', expected_servings: '' }
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
