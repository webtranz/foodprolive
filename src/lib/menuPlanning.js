import { quantityInIngredientBaseUnit } from '../../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';

export const CORE_MENU_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
export const createEmptyMealEntry = () => ({ recipe_id: '', expected_servings: '' });
export const createMealEntryFromRecipe = (recipe) => ({
  recipe_id: recipe?.id || '',
  expected_servings: recipe?.servings ? String(recipe.servings) : ''
});

function safeNumber(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function calculateRecipeCostSnapshot(recipe, ingredients = [], recipes = []) {
  const directCostPerServing = safeNumber(recipe?.cost_per_serving, null);
  const servings = safeNumber(recipe?.servings, 0);

  if (directCostPerServing !== null && directCostPerServing >= 0) {
    return {
      cost_per_serving: directCostPerServing,
      total_cost: servings > 0 ? directCostPerServing * servings : directCostPerServing,
      has_cost: true,
      source: 'recipe'
    };
  }

  const directTotalCost = safeNumber(recipe?.total_cost, null);
  if (directTotalCost !== null && directTotalCost >= 0 && servings > 0) {
    return {
      cost_per_serving: directTotalCost / servings,
      total_cost: directTotalCost,
      has_cost: true,
      source: 'recipe'
    };
  }

  const recipeIngredients = expandRecipeIngredients(
    recipe,
    recipes,
    ingredients,
    { aggregate: true }
  ).ingredients;
  if (recipeIngredients.length === 0) {
    return { cost_per_serving: 0, total_cost: 0, has_cost: false, source: 'missing' };
  }

  let totalCost = 0;
  let hasAllCosts = true;

  recipeIngredients.forEach((recipeIngredient) => {
    const ingredient = ingredients.find((entry) => entry.id === recipeIngredient.ingredient_id);
    const ingredientCost = safeNumber(ingredient?.cost_per_unit, null);
    if (ingredientCost === null || ingredientCost < 0) {
      hasAllCosts = false;
      return;
    }

    const quantityInCostUnits = quantityInIngredientBaseUnit(
      recipeIngredient.quantity,
      recipeIngredient.unit || ingredient?.unit,
      ingredient
    );

    totalCost += quantityInCostUnits * ingredientCost;
  });

  if (!hasAllCosts) {
    return { cost_per_serving: 0, total_cost: 0, has_cost: false, source: 'missing' };
  }

  return {
    cost_per_serving: servings > 0 ? totalCost / servings : totalCost,
    total_cost: totalCost,
    has_cost: true,
    source: 'ingredients'
  };
}

export function createEmptyDailyMenuState() {
  return {
    breakfast: [createEmptyMealEntry()],
    lunch: [createEmptyMealEntry()],
    dinner: [createEmptyMealEntry()]
  };
}

export function buildDailyMenuState(plan) {
  const nextState = createEmptyDailyMenuState();
  const meals = Array.isArray(plan?.meals) ? plan.meals : [];

  CORE_MENU_MEAL_TYPES.forEach((mealType) => {
    const matchingMeals = meals.filter((entry) => String(entry?.meal_type || '').trim().toLowerCase() === mealType);
    if (matchingMeals.length === 0) {
      return;
    }

    nextState[mealType] = matchingMeals.map((meal) => ({
      recipe_id: meal.recipe_id || '',
      expected_servings: meal.expected_servings ? String(meal.expected_servings) : ''
    }));
  });

  return nextState;
}

function normalizeCalendarMeal(mealType, meal = {}, recipes = []) {
  const recipeId = String(meal?.recipe_id || '').trim();
  const rawServings = meal?.expected_servings;
  const hasServings = rawServings !== '' && rawServings !== null && typeof rawServings !== 'undefined';
  const expectedServings = hasServings ? safeNumber(rawServings, 0) : 0;
  const recipe = recipes.find((entry) => entry.id === recipeId);

  return {
    meal_type: mealType,
    recipe_id: recipeId,
    recipe_name: String(meal?.recipe_name || recipe?.name || '').trim(),
    expected_servings: expectedServings,
    has_recipe: Boolean(recipeId),
    has_servings: hasServings,
    is_complete: Boolean(recipeId) && expectedServings > 0
  };
}

function getCalendarMealRows(plan, formState, recipes) {
  if (formState) {
    return CORE_MENU_MEAL_TYPES.flatMap((mealType) => (
      (Array.isArray(formState[mealType]) ? formState[mealType] : [])
        .map((meal) => normalizeCalendarMeal(mealType, meal, recipes))
        .filter((meal) => meal.has_recipe || meal.has_servings)
    ));
  }

  return (Array.isArray(plan?.meals) ? plan.meals : [])
    .map((meal) => {
      const mealType = String(meal?.meal_type || '').trim().toLowerCase();
      return CORE_MENU_MEAL_TYPES.includes(mealType)
        ? normalizeCalendarMeal(mealType, meal, recipes)
        : null;
    })
    .filter((meal) => meal && (meal.has_recipe || meal.has_servings));
}

export function summarizeMenuCalendarDay({ plan = null, formState = null, recipes = [] } = {}) {
  const entries = getCalendarMealRows(plan, formState, recipes);
  const meals = Object.fromEntries(CORE_MENU_MEAL_TYPES.map((mealType) => {
    const mealEntries = entries.filter((entry) => entry.meal_type === mealType);
    return [mealType, {
      entries: mealEntries,
      item_count: mealEntries.length,
      recipe_count: mealEntries.filter((entry) => entry.has_recipe).length,
      complete_count: mealEntries.filter((entry) => entry.is_complete).length,
      incomplete_count: mealEntries.filter((entry) => !entry.is_complete).length,
      expected_servings: mealEntries.reduce(
        (total, entry) => total + (entry.is_complete ? entry.expected_servings : 0),
        0
      )
    }];
  }));

  return {
    meals,
    has_core_meals: entries.length > 0,
    total_items: entries.length,
    total_recipes: entries.filter((entry) => entry.has_recipe).length,
    complete_items: entries.filter((entry) => entry.is_complete).length,
    incomplete_items: entries.filter((entry) => !entry.is_complete).length,
    total_expected_servings: entries.reduce(
      (total, entry) => total + (entry.is_complete ? entry.expected_servings : 0),
      0
    )
  };
}

function calendarMealFingerprint(plan, formState) {
  return getCalendarMealRows(plan, formState, [])
    .map((entry) => ({
      meal_type: entry.meal_type,
      recipe_id: entry.recipe_id,
      expected_servings: entry.has_servings ? entry.expected_servings : null
    }));
}

export function hasMenuCalendarChanges(formState, plan = null) {
  return JSON.stringify(calendarMealFingerprint(null, formState))
    !== JSON.stringify(calendarMealFingerprint(plan, null));
}

export function buildMenuPlanMeals(formState, recipes = [], ingredients = [], existingPlan = null) {
  const preservedMeals = (Array.isArray(existingPlan?.meals) ? existingPlan.meals : [])
    .filter((meal) => !CORE_MENU_MEAL_TYPES.includes(meal.meal_type));

  const nextMeals = CORE_MENU_MEAL_TYPES.flatMap((mealType) => (
    (Array.isArray(formState?.[mealType]) ? formState[mealType] : [])
      .flatMap((row) => {
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

        const costSnapshot = calculateRecipeCostSnapshot(recipe, ingredients, recipes);
        const costPerServing = costSnapshot.has_cost ? costSnapshot.cost_per_serving : 0;

        return [{
          meal_type: mealType,
          recipe_id: recipe.id,
          recipe_name: recipe.name || '',
          expected_servings: servings,
          cost_per_serving: costPerServing,
          total_cost: costPerServing * servings,
          calories_per_serving: safeNumber(recipe.calories_per_serving, 0),
          protein_per_serving: safeNumber(recipe.protein_per_serving, 0),
          carbs_per_serving: safeNumber(recipe.carbs_per_serving, 0),
          fat_per_serving: safeNumber(recipe.fat_per_serving, 0),
          sodium_per_serving: safeNumber(recipe.sodium_per_serving, 0),
          sugar_per_serving: safeNumber(recipe.sugar_per_serving, 0),
          allergens: Array.isArray(recipe.allergens) ? recipe.allergens : []
        }];
      })
  ));

  return [...nextMeals, ...preservedMeals];
}

export function summarizeMenuPlanMeals(meals = []) {
  return meals.reduce((summary, meal) => {
    const servings = safeNumber(meal.expected_servings, 0);
    const calories = safeNumber(meal.calories_per_serving, 0);
    const totalCost = safeNumber(meal.total_cost, 0);
    return {
      total_expected_servings: summary.total_expected_servings + servings,
      total_calories: summary.total_calories + (servings * calories),
      total_planned_cost: summary.total_planned_cost + totalCost
    };
  }, {
    total_expected_servings: 0,
    total_calories: 0,
    total_planned_cost: 0
  });
}

export function validateDailyMenuState(formState) {
  const errors = [];
  const hasAtLeastOneMeal = CORE_MENU_MEAL_TYPES.some((mealType) => {
    const rows = Array.isArray(formState?.[mealType]) ? formState[mealType] : [];
    return rows.some((row) => row.recipe_id || row.expected_servings);
  });

  if (!hasAtLeastOneMeal) {
    errors.push('Plan at least one of breakfast, lunch, or dinner.');
  }

  CORE_MENU_MEAL_TYPES.forEach((mealType) => {
    const rows = Array.isArray(formState?.[mealType]) ? formState[mealType] : [];
    rows.forEach((row, index) => {
      const hasRecipe = Boolean(row.recipe_id);
      const hasServings = row.expected_servings !== '' && row.expected_servings !== null && typeof row.expected_servings !== 'undefined';
      const rowLabel = rows.length > 1 ? `${mealType[0].toUpperCase()}${mealType.slice(1)} item ${index + 1}` : `${mealType[0].toUpperCase()}${mealType.slice(1)}`;

      if (hasRecipe && !hasServings) {
        errors.push(`${rowLabel} servings are required when a recipe is selected.`);
      }

      if (!hasRecipe && hasServings) {
        errors.push(`Select a ${mealType} recipe before entering servings for ${rowLabel.toLowerCase()}.`);
      }

      if (hasServings && safeNumber(row.expected_servings, 0) <= 0) {
        errors.push(`${rowLabel} servings must be greater than zero.`);
      }
    });
  });

  return errors;
}

export function reorderMealEntries(entries, startIndex, endIndex) {
  const nextEntries = [...entries];
  const [movedEntry] = nextEntries.splice(startIndex, 1);
  nextEntries.splice(endIndex, 0, movedEntry);
  return nextEntries;
}

export function moveMealEntry(formState, sourceMealType, destinationMealType, sourceIndex, destinationIndex) {
  const sourceEntries = [...(Array.isArray(formState?.[sourceMealType]) ? formState[sourceMealType] : [])];
  const destinationEntries = sourceMealType === destinationMealType
    ? sourceEntries
    : [...(Array.isArray(formState?.[destinationMealType]) ? formState[destinationMealType] : [])];

  const [movedEntry] = sourceEntries.splice(sourceIndex, 1);
  destinationEntries.splice(destinationIndex, 0, movedEntry);

  return {
    ...formState,
    [sourceMealType]: sourceMealType === destinationMealType
      ? destinationEntries
      : (sourceEntries.length > 0 ? sourceEntries : [createEmptyMealEntry()]),
    [destinationMealType]: destinationEntries.length > 0 ? destinationEntries : [createEmptyMealEntry()]
  };
}

export function summarizeDailyMenuCosts(formState, recipes = [], ingredients = []) {
  return CORE_MENU_MEAL_TYPES.reduce((summary, mealType) => {
    const rows = Array.isArray(formState?.[mealType]) ? formState[mealType] : [];
    const entries = rows.map((row) => {
      const recipe = recipes.find((entry) => entry.id === row.recipe_id);
      const servings = safeNumber(row.expected_servings, 0);
      if (!recipe || servings <= 0) {
        return {
          recipe_id: row.recipe_id || '',
          expected_servings: servings,
          cost_per_serving: 0,
          total_cost: 0,
          has_cost: false
        };
      }

      const costSnapshot = calculateRecipeCostSnapshot(recipe, ingredients, recipes);
      const costPerServing = costSnapshot.has_cost ? costSnapshot.cost_per_serving : 0;
      return {
        recipe_id: recipe.id,
        expected_servings: servings,
        cost_per_serving: costPerServing,
        total_cost: costPerServing * servings,
        has_cost: costSnapshot.has_cost
      };
    });

    const mealTotal = entries.reduce((sum, entry) => sum + entry.total_cost, 0);
    const missingCostCount = entries.filter((entry) => entry.expected_servings > 0 && !entry.has_cost).length;

    summary[mealType] = {
      total_cost: mealTotal,
      missing_cost_count: missingCostCount,
      entries
    };
    summary.total_cost += mealTotal;
    summary.missing_cost_count += missingCostCount;
    return summary;
  }, {
    breakfast: { total_cost: 0, missing_cost_count: 0, entries: [] },
    lunch: { total_cost: 0, missing_cost_count: 0, entries: [] },
    dinner: { total_cost: 0, missing_cost_count: 0, entries: [] },
    total_cost: 0,
    missing_cost_count: 0
  });
}

export function computeBudgetComparison(budgetAmount, plannedCost) {
  const normalizedBudgetAmount = safeNumber(budgetAmount, 0);
  const normalizedPlannedCost = safeNumber(plannedCost, 0);
  const remainingBudget = normalizedBudgetAmount - normalizedPlannedCost;

  return {
    budget_amount: normalizedBudgetAmount,
    planned_cost: normalizedPlannedCost,
    remaining_budget: remainingBudget > 0 ? remainingBudget : 0,
    exceeded_amount: remainingBudget < 0 ? Math.abs(remainingBudget) : 0,
    is_over_budget: remainingBudget < 0
  };
}

export function computeMealBudgetStatus(limitAmount, plannedCost) {
  const normalizedLimitAmount = safeNumber(limitAmount, 0);
  const normalizedPlannedCost = safeNumber(plannedCost, 0);
  const remainingAmount = normalizedLimitAmount - normalizedPlannedCost;

  return {
    limit_amount: normalizedLimitAmount,
    planned_cost: normalizedPlannedCost,
    remaining_amount: remainingAmount > 0 ? remainingAmount : 0,
    exceeded_amount: remainingAmount < 0 ? Math.abs(remainingAmount) : 0,
    has_limit: normalizedLimitAmount > 0,
    is_over_limit: normalizedLimitAmount > 0 && remainingAmount < 0
  };
}
