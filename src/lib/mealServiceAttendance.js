const MAX_MEAL_SERVICE_COVERS = 1_000_000;
const MAX_SERVICE_PORTION_GRAMS = 100_000;

export function createMealServiceIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return `meal-service-${globalThis.crypto.randomUUID()}`;
  return `meal-service-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function normalizeMealServiceCovers(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_MEAL_SERVICE_COVERS) return null;
  return parsed;
}

export function normalizeMealServicePortionSize(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_SERVICE_PORTION_GRAMS) return null;
  return Number(parsed.toFixed(6));
}

export function buildMealServiceConfirmationRequest(
  scope = {},
  dishes = [],
  coversByRecipe = {},
  idempotencyKey = '',
  availabilitySnapshot = ''
) {
  return {
    idempotency_key: idempotencyKey,
    availability_snapshot: String(availabilitySnapshot || '').trim(),
    site_id: scope.site_id,
    service_date: scope.service_date,
    meal_type: scope.meal_type,
    menu_type: scope.menu_type,
    menu_category: scope.menu_category,
    dishes: dishes.map((dish) => ({
      recipe_id: dish.recipe_id,
      covers: normalizeMealServiceCovers(coversByRecipe[dish.recipe_id])
    }))
  };
}

export function buildMealServicePortionRequest(scope = {}, dish = {}, portionSizeGrams) {
  return {
    site_id: scope.site_id,
    service_date: scope.service_date,
    meal_type: scope.meal_type,
    menu_type: scope.menu_type,
    menu_category: scope.menu_category,
    recipe_id: dish.recipe_id,
    service_portion_size_grams: normalizeMealServicePortionSize(portionSizeGrams)
  };
}

export function validateMealServiceCovers(dishes = [], coversByRecipe = {}) {
  if (!Array.isArray(dishes) || dishes.length === 0) {
    return { valid: false, message: 'No fully produced dishes are available for Meal Service.' };
  }

  let hasPositiveCover = false;
  for (const dish of dishes) {
    if (normalizeMealServicePortionSize(dish.service_portion_size_grams) === null) {
      return {
        valid: false,
        message: `${dish.recipe_name || 'A prepared dish'} needs an administrator-saved service portion size before Meal Service can be saved.`
      };
    }
    const covers = normalizeMealServiceCovers(coversByRecipe[dish.recipe_id]);
    if (covers === null) {
      return { valid: false, message: `Enter a whole-number cover count for ${dish.recipe_name || 'every dish'}.` };
    }
    const availableCovers = Number(dish.available_covers);
    if (
      dish.available_covers === null
      || typeof dish.available_covers === 'undefined'
      || dish.available_covers === ''
      || !Number.isInteger(availableCovers)
      || availableCovers < 0
    ) {
      return {
        valid: false,
        message: `${dish.recipe_name || 'A prepared dish'} does not have a valid available-cover balance. Refresh after its service portion is saved.`
      };
    }
    if (covers > availableCovers) {
      return {
        valid: false,
        message: `${dish.recipe_name || 'A dish'} has only ${availableCovers} covers available.`
      };
    }
    hasPositiveCover ||= covers > 0;
  }

  return hasPositiveCover
    ? { valid: true, message: '' }
    : { valid: false, message: 'Enter at least one cover before saving Meal Service.' };
}

export function formatMealWeight(value) {
  const grams = Number(value) || 0;
  if (Math.abs(grams) >= 1000) return `${Number((grams / 1000).toFixed(3))} kg`;
  return `${Number(grams.toFixed(3))} g`;
}

export function getDinerScanHeadcount(scans = []) {
  return scans.reduce((total, scan) => {
    const count = Number(scan?.attendee_count ?? scan?.count ?? 1);
    return total + (Number.isFinite(count) && count > 0 ? count : 1);
  }, 0);
}
