import {
  getMenuCategoryLabel,
  getMenuCuisineLabel,
  normalizeMenuCategory,
  normalizeMenuCuisine
} from './menuCategories.js';

const MEAL_LABELS = Object.freeze({
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack'
});

function text(value) {
  return String(value || '').trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function titleCase(value) {
  return text(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getMealLabel(production = {}) {
  const normalized = text(production.meal_type).toLowerCase();
  return MEAL_LABELS[normalized] || titleCase(production.meal_type);
}

export function getProductionEventItemCount(production = {}, fallback = 0) {
  const issueItems = Array.isArray(production.menu_issue_items) ? production.menu_issue_items : [];
  if (issueItems.length > 0) return issueItems.length;

  const explicit = number(
    production.production_issue_item_count
      ?? production.item_count
      ?? production.production_issue_dish_count
      ?? production.dish_count
      ?? production.recipe_count,
    0
  );
  if (explicit > 0) return explicit;
  const savedName = text(
    production.production_name
      || production.recipe_name
      || production.name
  );
  const genericNameMatch = savedName.match(/\((\d+)\s+(?:items?|dishes?)\)/i);
  if (genericNameMatch) return number(genericNameMatch[1], fallback);
  return fallback;
}

export function getProductionEventDishCount(production = {}, fallback = 0) {
  return getProductionEventItemCount(production, fallback);
}

export function formatProductionItemCountLabel(itemCount = 0) {
  const count = number(itemCount, 0);
  return `${count} Item${count === 1 ? '' : 's'}`;
}

export function getProductionEventScopeLabel(production = {}) {
  const rawMenuType = text(
    production.menu_type
      || production.cuisine_type
      || production.menu_cuisine
  );
  const rawMenuCategory = text(production.menu_category);
  const menuType = rawMenuType ? normalizeMenuCuisine(rawMenuType, '') : '';
  const menuCategory = rawMenuCategory ? normalizeMenuCategory(rawMenuCategory, '') : '';
  const categoryLabel = menuCategory
    ? getMenuCategoryLabel(menuCategory) || titleCase(menuCategory)
    : '';
  const typeLabel = menuType
    ? getMenuCuisineLabel(menuType) || titleCase(menuType)
    : '';
  return [categoryLabel, typeLabel].filter(Boolean).join(' / ');
}

function isMenuProduction(production = {}) {
  const savedName = text(
    production.production_name
      || production.recipe_name
      || production.name
  );
  return production.production_issue_grouped === true
    || getProductionEventItemCount(production, 0) > 1
    || (Array.isArray(production.menu_issue_items) && production.menu_issue_items.length > 0)
    || hasGenericMenuProductionName(savedName);
}

function hasGenericMenuProductionName(value) {
  return /^[a-z]+\s+menu\s+production(?:\s*\(\d+\s+(?:items?|dishes?)\))?$/i.test(text(value));
}

export function formatProductionEventTitle(
  production = {},
  {
    includeDishCount = true,
    includeItemCount = includeDishCount,
    fallback = 'Production request',
    preferSavedName = false
  } = {}
) {
  const savedName = text(
    production.production_name
      || production.recipe_name
      || production.name
  );
  const menuProduction = isMenuProduction(production);

  if (
    preferSavedName
    && savedName
    && (!menuProduction || !hasGenericMenuProductionName(savedName))
  ) {
    return savedName;
  }

  if (menuProduction) {
    const mealLabel = getMealLabel(production) || 'Meal';
    const scopeLabel = getProductionEventScopeLabel(production);
    const itemCount = getProductionEventItemCount(production, 0);
    const itemCountLabel = includeItemCount && itemCount > 0
      ? ` (${formatProductionItemCountLabel(itemCount)})`
      : '';
    return `${mealLabel} Menu${scopeLabel ? ` ${scopeLabel}` : ''}${itemCountLabel}`;
  }

  return savedName || fallback;
}
