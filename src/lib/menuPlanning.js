export const CORE_MENU_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];

function safeNumber(value, fallback = '') {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function createEmptyDailyMenuState() {
  return {
    breakfast: { recipe_id: '', expected_servings: '' },
    lunch: { recipe_id: '', expected_servings: '' },
    dinner: { recipe_id: '', expected_servings: '' }
  };
}

export function buildDailyMenuState(plan) {
  const nextState = createEmptyDailyMenuState();
  const meals = Array.isArray(plan?.meals) ? plan.meals : [];

  CORE_MENU_MEAL_TYPES.forEach((mealType) => {
    const meal = meals.find((entry) => entry.meal_type === mealType);
    if (!meal) {
      return;
    }

    nextState[mealType] = {
      recipe_id: meal.recipe_id || '',
      expected_servings: meal.expected_servings ? String(meal.expected_servings) : ''
    };
  });

  return nextState;
}

export function buildMenuPlanMeals(formState, recipes = [], existingPlan = null) {
  const preservedMeals = (Array.isArray(existingPlan?.meals) ? existingPlan.meals : [])
    .filter((meal) => !CORE_MENU_MEAL_TYPES.includes(meal.meal_type));

  const nextMeals = CORE_MENU_MEAL_TYPES.flatMap((mealType) => {
    const row = formState?.[mealType] || {};
    if (!row.recipe_id || !row.expected_servings) {
      return [];
    }

    const servings = safeNumber(row.expected_servings, 0);
    if (servings <= 0) {
      return [];
    }

    const recipe = recipes.find((entry) => entry.id === row.recipe_id);
    if (!recipe) {
      return [];
    }

    return [{
      meal_type: mealType,
      recipe_id: recipe.id,
      recipe_name: recipe.name || '',
      expected_servings: servings,
      calories_per_serving: safeNumber(recipe.calories_per_serving, 0),
      protein_per_serving: safeNumber(recipe.protein_per_serving, 0),
      carbs_per_serving: safeNumber(recipe.carbs_per_serving, 0),
      fat_per_serving: safeNumber(recipe.fat_per_serving, 0),
      sodium_per_serving: safeNumber(recipe.sodium_per_serving, 0),
      sugar_per_serving: safeNumber(recipe.sugar_per_serving, 0),
      allergens: Array.isArray(recipe.allergens) ? recipe.allergens : []
    }];
  });

  return [...nextMeals, ...preservedMeals];
}

export function summarizeMenuPlanMeals(meals = []) {
  return meals.reduce((summary, meal) => {
    const servings = safeNumber(meal.expected_servings, 0);
    const calories = safeNumber(meal.calories_per_serving, 0);
    return {
      total_expected_servings: summary.total_expected_servings + servings,
      total_calories: summary.total_calories + (servings * calories)
    };
  }, {
    total_expected_servings: 0,
    total_calories: 0
  });
}

export function validateDailyMenuState(formState) {
  const errors = [];
  const hasAtLeastOneMeal = CORE_MENU_MEAL_TYPES.some((mealType) => {
    const row = formState?.[mealType] || {};
    return row.recipe_id || row.expected_servings;
  });

  if (!hasAtLeastOneMeal) {
    errors.push('Plan at least one of breakfast, lunch, or dinner.');
  }

  CORE_MENU_MEAL_TYPES.forEach((mealType) => {
    const row = formState?.[mealType] || {};
    const hasRecipe = Boolean(row.recipe_id);
    const hasServings = row.expected_servings !== '' && row.expected_servings !== null && typeof row.expected_servings !== 'undefined';

    if (hasRecipe && !hasServings) {
      errors.push(`${mealType[0].toUpperCase()}${mealType.slice(1)} servings are required when a recipe is selected.`);
    }

    if (!hasRecipe && hasServings) {
      errors.push(`Select a ${mealType} recipe before entering servings.`);
    }

    if (hasServings && safeNumber(row.expected_servings, 0) <= 0) {
      errors.push(`${mealType[0].toUpperCase()} servings must be greater than zero.`);
    }
  });

  return errors;
}
