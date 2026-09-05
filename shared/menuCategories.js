export const MENU_CUISINE_OPTIONS = Object.freeze([
  { value: 'general', label: 'General' },
  { value: 'philippines', label: 'Philippines' }
]);

export const MENU_CATEGORY_OPTIONS = Object.freeze([
  { value: 'senior', label: 'Senior' },
  { value: 'junior', label: 'Junior' },
  { value: 'labor', label: 'Labor' },
  { value: 'management_menu', label: 'Management Menu' }
]);

export const PHILIPPINES_MENU_CATEGORY_OPTIONS = Object.freeze([
  { value: 'senior', label: 'Senior' },
  { value: 'junior', label: 'Junior' },
  { value: 'labor', label: 'Labor' }
]);

export function normalizeMenuCuisine(value, fallback = 'general') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'philippines' || normalized === 'filipino' || normalized === 'phillipines' || normalized === 'philipino') {
    return 'philippines';
  }
  if (normalized === 'general') return 'general';
  return fallback;
}

export function normalizeMenuCategory(value, fallback = 'senior') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'labour') return 'labor';
  if (['senior', 'junior', 'labor', 'management_menu'].includes(normalized)) return normalized;
  return fallback;
}

export function getMenuCategoryOptions(cuisineType = 'general') {
  return normalizeMenuCuisine(cuisineType) === 'philippines'
    ? PHILIPPINES_MENU_CATEGORY_OPTIONS
    : MENU_CATEGORY_OPTIONS;
}

export function getMenuCategoryLabel(value) {
  const category = normalizeMenuCategory(value, '');
  return MENU_CATEGORY_OPTIONS.find((option) => option.value === category)?.label || '';
}

export function getMenuCuisineLabel(value) {
  const cuisine = normalizeMenuCuisine(value, '');
  return MENU_CUISINE_OPTIONS.find((option) => option.value === cuisine)?.label || '';
}

const UNCLASSIFIED_PRODUCTION_SOURCE_TYPES = new Set([
  'special_event',
  'event',
  'auto_schedule_unlinked'
]);

function productionText(value) {
  return String(value || '').trim();
}

function productionMenuScopeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function requiresRoutineProductionMenuScope(production = {}) {
  const sourceType = productionText(production.source_type).toLowerCase();
  return !productionText(production.source_event_id)
    && !UNCLASSIFIED_PRODUCTION_SOURCE_TYPES.has(sourceType);
}

/**
 * Freeze the dimensions used to route routine production into Meal Service.
 * Drafts may remain wholly unclassified, but partial or invalid classifications
 * are never persisted. Event and explicitly unlinked auto-schedule output stays
 * outside this routine scope by design.
 */
export function normalizeProductionMenuScope(
  production = {},
  { required = false, errorStatus = 400 } = {}
) {
  if (!requiresRoutineProductionMenuScope(production)) return { ...production };

  const rawMenuType = productionText(
    production.menu_type || production.cuisine_type || production.menu_cuisine
  );
  const rawMenuCategory = productionText(production.menu_category);
  if (!rawMenuType && !rawMenuCategory) {
    if (!required) return { ...production };
    throw productionMenuScopeError(
      'Routine production requires both Menu Type and Menu Category before submission or completion.',
      errorStatus
    );
  }
  if (!rawMenuType || !rawMenuCategory) {
    throw productionMenuScopeError(
      'Routine production must include both Menu Type and Menu Category.',
      errorStatus
    );
  }

  const menuType = normalizeMenuCuisine(rawMenuType, '');
  if (!menuType) {
    throw productionMenuScopeError('Menu Type must be General or Philippines.', errorStatus);
  }
  const menuCategory = normalizeMenuCategory(rawMenuCategory, '');
  if (!menuCategory) {
    throw productionMenuScopeError(
      'Menu Category must be Senior, Junior, Labor, or Management Menu.',
      errorStatus
    );
  }
  if (!getMenuCategoryOptions(menuType).some((option) => option.value === menuCategory)) {
    throw productionMenuScopeError(
      `Menu Category ${rawMenuCategory} is not available for ${menuType}.`,
      errorStatus
    );
  }

  return {
    ...production,
    cuisine_type: menuType,
    menu_type: menuType,
    menu_category: menuCategory
  };
}
