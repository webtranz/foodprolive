import { normalizeMenuCategory, normalizeMenuCuisine } from './menuCategories.js';

const OPERATIONAL_MENU_STATUSES = new Set(['planned', 'active', 'approved']);

function text(value) {
  return String(value || '').trim();
}

export function resolveAutoScheduleMenuLink({
  menuPlans = [],
  siteId = '',
  productionDate = '',
  mealType = '',
  recipeId = ''
} = {}) {
  const targetSiteId = text(siteId);
  const targetDate = text(productionDate).slice(0, 10);
  const targetMealType = text(mealType).toLowerCase();
  const targetRecipeId = text(recipeId);
  const matches = menuPlans.filter((plan) => (
    text(plan.site_id) === targetSiteId
    && text(plan.plan_date).slice(0, 10) === targetDate
    && !text(plan.event_name)
    && OPERATIONAL_MENU_STATUSES.has(text(plan.status || 'planned').toLowerCase())
    && (Array.isArray(plan.meals) ? plan.meals : []).some((meal) => (
      text(meal.recipe_id) === targetRecipeId
      && text(meal.meal_type).toLowerCase() === targetMealType
    ))
  ));

  if (matches.length !== 1) {
    return {
      source_type: 'auto_schedule_unlinked',
      menu_plan_id: null,
      cuisine_type: null,
      menu_type: null,
      menu_category: null,
      menu_link_status: matches.length === 0 ? 'not_found' : 'ambiguous'
    };
  }

  const plan = matches[0];
  const menuType = normalizeMenuCuisine(plan.cuisine_type || plan.menu_type, 'general');
  return {
    source_type: 'auto_schedule_menu_plan',
    menu_plan_id: plan.id,
    cuisine_type: menuType,
    menu_type: menuType,
    menu_category: normalizeMenuCategory(plan.menu_category, 'senior'),
    menu_link_status: 'linked'
  };
}
