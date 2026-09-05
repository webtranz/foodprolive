import { calculateRecipeCostingSnapshot } from '../shared/recipeCosting.js';
import { normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';

const CORE_MENU_MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeDateOnly(value) {
  const normalized = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : '';
}

function addUtcDays(dateOnly, days) {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildMenuPlanWeekRange(weekStart) {
  const startDate = normalizeDateOnly(weekStart);
  if (!startDate) return null;
  return {
    start_date: startDate,
    end_date: addUtcDays(startDate, 6)
  };
}

function filterMenuPlansForWeek(records = [], siteId, weekStart, options = {}) {
  const range = buildMenuPlanWeekRange(weekStart);
  const normalizedSiteId = normalizeText(siteId);
  const cuisineType = normalizeMenuCuisine(options.cuisine_type || options.cuisineType, 'general');
  const menuCategory = normalizeMenuCategory(options.menu_category || options.menuCategory, 'senior');
  if (!range || !normalizedSiteId) return [];

  return (Array.isArray(records) ? records : []).filter((record) => (
    normalizeText(record?.site_id) === normalizedSiteId
      && !normalizeText(record?.event_name)
      && normalizeDateOnly(record?.plan_date) >= range.start_date
      && normalizeDateOnly(record?.plan_date) <= range.end_date
      && normalizeMenuCuisine(record?.cuisine_type, 'general') === cuisineType
      && normalizeMenuCategory(record?.menu_category, 'senior') === menuCategory
  ));
}

function calculateRecipeCostSnapshot(recipe, ingredients = [], recipes = []) {
  const hasRecipeLines = (Array.isArray(recipe?.ingredients) && recipe.ingredients.length > 0)
    || (Array.isArray(recipe?.sub_recipes) && recipe.sub_recipes.length > 0);
  const servings = Math.max(0, toNumber(recipe?.servings, 0));
  const ingredientCost = calculateRecipeCostingSnapshot(recipe, ingredients, recipes);
  if (ingredientCost.has_cost) {
    const totalCost = toNumber(ingredientCost.total_cost, 0);
    return {
      has_cost: true,
      source: 'ingredients',
      cost_per_serving: servings > 0 ? totalCost / servings : totalCost,
      total_cost: totalCost,
      costing_method: ingredientCost.costing_method
    };
  }

  if (hasRecipeLines) {
    return {
      has_cost: false,
      source: 'missing',
      cost_per_serving: 0,
      total_cost: 0,
      missing_cost_count: ingredientCost.missing_cost_count || 0
    };
  }

  const directCostPerServing = toNumber(recipe?.cost_per_serving, NaN);

  if (Number.isFinite(directCostPerServing) && directCostPerServing >= 0) {
    return {
      has_cost: true,
      source: 'recipe',
      cost_per_serving: directCostPerServing,
      total_cost: servings > 0 ? directCostPerServing * servings : directCostPerServing
    };
  }

  const directTotalCost = toNumber(recipe?.total_cost, NaN);
  if (Number.isFinite(directTotalCost) && directTotalCost >= 0 && servings > 0) {
    return {
      has_cost: true,
      source: 'recipe',
      cost_per_serving: directTotalCost / servings,
      total_cost: directTotalCost
    };
  }

  return { has_cost: false, source: 'missing', cost_per_serving: 0, total_cost: 0 };
}

function summarizeMenuPlanCostPreview(meals = [], recipes = [], ingredients = []) {
  const summary = {
    breakfast: { total_cost: 0, missing_cost_count: 0, entries: [] },
    lunch: { total_cost: 0, missing_cost_count: 0, entries: [] },
    dinner: { total_cost: 0, missing_cost_count: 0, entries: [] },
    total_cost: 0,
    missing_cost_count: 0
  };

  (Array.isArray(meals) ? meals : []).forEach((meal) => {
    const mealType = normalizeText(meal?.meal_type).toLowerCase();
    if (!CORE_MENU_MEAL_TYPES.has(mealType) || !meal?.recipe_id) {
      return;
    }

    const recipe = recipes.find((entry) => entry.id === meal.recipe_id);
    const servings = Math.max(0, toNumber(meal.expected_servings, 0));
    const costSnapshot = recipe ? calculateRecipeCostSnapshot(recipe, ingredients, recipes) : {
      has_cost: false,
      source: 'missing',
      cost_per_serving: 0,
      total_cost: 0
    };
    const costPerServing = costSnapshot.has_cost ? costSnapshot.cost_per_serving : 0;
    const totalCost = servings > 0 ? costPerServing * servings : 0;

    const entry = {
      meal_type: mealType,
      recipe_id: meal.recipe_id,
      recipe_name: recipe?.name || meal.recipe_name || '',
      expected_servings: servings,
      cost_per_serving: costPerServing,
      total_cost: totalCost,
      has_cost: costSnapshot.has_cost
    };

    summary[mealType].entries.push(entry);
    summary[mealType].total_cost += totalCost;
    if (servings > 0 && !costSnapshot.has_cost) {
      summary[mealType].missing_cost_count += 1;
      summary.missing_cost_count += 1;
    }

    summary.total_cost += totalCost;
  });

  return summary;
}

function buildApiObjectResponse(data, meta = {}) {
  return {
    ok: true,
    data,
    meta,
    ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {})
  };
}

function validateSiteAndDateInput({ siteId, planDate }) {
  const errors = [];
  if (!normalizeText(siteId)) {
    errors.push('site_id is required');
  }
  if (!normalizeDateOnly(planDate)) {
    errors.push('plan_date must be provided in YYYY-MM-DD format');
  }
  return errors;
}

function validateMenuPlanPayload(payload = {}) {
  const errors = validateSiteAndDateInput({
    siteId: payload.site_id,
    planDate: payload.plan_date
  });

  const meals = Array.isArray(payload.meals) ? payload.meals : [];
  const operationalMeals = meals.filter((meal) => CORE_MENU_MEAL_TYPES.has(normalizeText(meal?.meal_type).toLowerCase()));
  const cuisineType = normalizeMenuCuisine(payload.cuisine_type, 'general');
  const menuCategory = normalizeMenuCategory(payload.menu_category, 'senior');

  if (!operationalMeals.length) {
    errors.push('At least one breakfast, lunch, or dinner menu item is required.');
  }
  if (cuisineType === 'philippines' && menuCategory === 'management_menu') {
    errors.push('Philippines menus support Senior, Junior, or Labor categories.');
  }

  operationalMeals.forEach((meal, index) => {
    if (!normalizeText(meal.recipe_id)) {
      errors.push(`Meal entry ${index + 1} requires a recipe_id.`);
    }

    if (toNumber(meal.expected_servings, 0) <= 0) {
      errors.push(`Meal entry ${index + 1} must have expected_servings greater than zero.`);
    }
  });

  return errors;
}

function validatePRGenerationPayload(payload = {}) {
  const errors = [];
  if (!normalizeText(payload.site_id)) {
    errors.push('site_id is required');
  }
  if (!normalizeText(payload.site_name)) {
    errors.push('site_name is required');
  }
  if (payload.reference_date && !normalizeDateOnly(payload.reference_date)) {
    errors.push('reference_date must be provided in YYYY-MM-DD format');
  }
  return errors;
}

function validateFoodWasteContextInput({ siteId, wasteDate, mealType, token = '' }) {
  const errors = [];
  if (token !== undefined && token !== null && String(token).trim() !== '' && !normalizeText(token)) {
    errors.push('token is required');
  }
  if (siteId !== undefined && !normalizeText(siteId)) {
    errors.push('site_id is required');
  }
  if (wasteDate !== undefined && !normalizeDateOnly(wasteDate)) {
    errors.push('waste_date must be provided in YYYY-MM-DD format');
  }
  if (mealType !== undefined && !CORE_MENU_MEAL_TYPES.has(normalizeText(mealType).toLowerCase())) {
    errors.push('meal_type must be breakfast, lunch, or dinner');
  }
  return errors;
}

export {
  buildApiObjectResponse,
  buildMenuPlanWeekRange,
  filterMenuPlansForWeek,
  summarizeMenuPlanCostPreview,
  validateSiteAndDateInput,
  validateMenuPlanPayload,
  validatePRGenerationPayload,
  validateFoodWasteContextInput
};
