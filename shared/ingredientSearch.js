const SEARCH_FIELD_KEYS = [
  'name',
  'sku',
  'ingredient_code',
  'item_code',
  'category',
  'alias',
  'aliases',
  'alternative_name',
  'alternative_names',
  'supplier_item_name',
  'supplier_item_names'
];

export function normalizeIngredientSearchText(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function flattenSearchValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap(flattenSearchValue);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(flattenSearchValue);
  }
  const normalized = normalizeIngredientSearchText(value);
  return normalized ? [normalized] : [];
}

export function getIngredientSearchFields(ingredient = {}) {
  return [...new Set(SEARCH_FIELD_KEYS.flatMap((key) => flattenSearchValue(ingredient[key])))];
}

export function rankIngredientSearchMatch(ingredient, query) {
  const normalizedQuery = normalizeIngredientSearchText(query);
  if (!normalizedQuery) return 0;

  const fields = getIngredientSearchFields(ingredient);
  if (fields.some((field) => field === normalizedQuery)) return 0;
  if (fields.some((field) => field.startsWith(normalizedQuery))) return 1;
  if (fields.some((field) => field.includes(normalizedQuery))) return 2;
  return null;
}

export function searchIngredientCatalog(records = [], options = {}) {
  const query = normalizeIngredientSearchText(options.query);
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const activeRecords = records.filter((ingredient) => (
    !['false', '0', 'no', 'inactive'].includes(normalizeIngredientSearchText(ingredient?.is_active))
  ));

  const ranked = activeRecords
    .map((ingredient) => ({ ingredient, relevance: rankIngredientSearchMatch(ingredient, query) }))
    .filter(({ relevance }) => relevance !== null)
    .sort((left, right) => (
      left.relevance - right.relevance ||
      String(left.ingredient.name || '').localeCompare(String(right.ingredient.name || ''), undefined, {
        sensitivity: 'base',
        numeric: true
      }) ||
      String(left.ingredient.id || '').localeCompare(String(right.ingredient.id || ''))
    ));

  const offset = (page - 1) * limit;
  const totalCount = ranked.length;
  return {
    items: ranked.slice(offset, offset + limit).map(({ ingredient, relevance }) => ({
      ...ingredient,
      relevance
    })),
    total_count: totalCount,
    indexed_count: activeRecords.length,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(totalCount / limit)),
    has_more: offset + limit < totalCount
  };
}

export function splitHighlightedIngredientText(value, query) {
  const text = String(value ?? '');
  const normalizedQuery = normalizeIngredientSearchText(query);
  if (!normalizedQuery) return [{ text, match: false }];

  const normalizedText = text.toLocaleLowerCase();
  const parts = [];
  let cursor = 0;
  let matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push({ text: text.slice(cursor, matchIndex), match: false });
    }
    parts.push({ text: text.slice(matchIndex, matchIndex + normalizedQuery.length), match: true });
    cursor = matchIndex + normalizedQuery.length;
    matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

export function moveIngredientPickerIndex(currentIndex, key, itemCount) {
  if (itemCount <= 0) return -1;
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  if (key === 'ArrowUp') return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
  return currentIndex;
}

export function resolveIngredientPickerKey(key, activeIndex, items = []) {
  if (key === 'Escape') return { action: 'close', activeIndex, item: null };
  if (key === 'Enter' && activeIndex >= 0 && activeIndex < items.length) {
    return { action: 'select', activeIndex, item: items[activeIndex] };
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return {
      action: 'navigate',
      activeIndex: moveIngredientPickerIndex(activeIndex, key, items.length),
      item: null
    };
  }
  return { action: 'none', activeIndex, item: null };
}
