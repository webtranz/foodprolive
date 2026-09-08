// D365 stock imports identify an Ingredient by d365_item_id. Treat it as the
// final display fallback so historical D365 inventory never renders a blank
// item code when an internal SKU has not been assigned yet.
export const ITEM_CODE_FIELDS = Object.freeze(['item_code', 'ingredient_code', 'sku', 'd365_item_id']);

function normalizeCodeValue(value) {
  if (value === null || typeof value === 'undefined') return '';
  return String(value).trim();
}

export function getItemCode(item = {}, fallback = '—') {
  if (!item || typeof item !== 'object') return fallback;

  const sources = [item];
  if (item.data && typeof item.data === 'object' && !Array.isArray(item.data)) {
    sources.push(item.data);
  }

  for (const field of ITEM_CODE_FIELDS) {
    for (const source of sources) {
      const value = normalizeCodeValue(source[field]);
      if (value) return value;
    }
  }

  return fallback;
}

export function getItemCodeFromRecords(records = [], fallback = '—') {
  for (const record of records) {
    const value = getItemCode(record, '');
    if (value) return value;
  }
  return fallback;
}

export function putItemCodeAndNameFirst(record = {}, options = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const nameKey = options.nameKey || 'name';
  const outputNameKey = options.outputNameKey || nameKey;
  const itemCode = normalizeCodeValue(options.itemCode) || getItemCode(source, options.fallback ?? '—');
  const itemName = source[nameKey] ?? source.item_name ?? source.ingredient_name ?? source.name ?? options.fallback ?? '—';
  const remainder = {};

  Object.entries(source).forEach(([key, value]) => {
    if (key === 'item_code' || key === nameKey || key === outputNameKey) return;
    remainder[key] = value;
  });

  return {
    item_code: itemCode,
    [outputNameKey]: itemName,
    ...remainder
  };
}
