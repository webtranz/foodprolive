const MAX_INTERNAL_PAGE_SIZE = 10000;
const NUMERIC_PATTERN = "^-?[0-9]+([.][0-9]+)?$";

function addParameter(parameters, value) {
  parameters.push(value);
  return `$${parameters.length}`;
}

function normalizedLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(MAX_INTERNAL_PAGE_SIZE, Math.max(1, Math.trunc(numeric)));
}

function normalizedOffset(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function numericInventoryFieldExpression(field) {
  const valueExpression = `COALESCE(record.data->>'${field}', '')`;
  return `(CASE
    WHEN ${valueExpression} ~ '${NUMERIC_PATTERN}' THEN (${valueExpression})::numeric
    ELSE 0
  END)`;
}

function inventoryStatusExpression() {
  const quantityExpression = numericInventoryFieldExpression('quantity');
  const minimumExpression = `GREATEST(0, ${numericInventoryFieldExpression('min_stock_level')})`;
  return `(CASE
    WHEN ${quantityExpression} <= 0 THEN 'out_of_stock'
    WHEN ${minimumExpression} > 0 AND ${quantityExpression} <= ${minimumExpression} THEN 'low_stock'
    ELSE 'in_stock'
  END)`;
}

function buildFilterClause(parameters, entity, field, expected) {
  if (entity === 'Inventory' && field === 'status') {
    const derivedStatus = inventoryStatusExpression();
    if (expected === null || expected === undefined || expected === '') {
      return `COALESCE(${derivedStatus}, '') = ''`;
    }
    const expectedParameter = addParameter(parameters, String(expected));
    return `LOWER(${derivedStatus}) = LOWER(${expectedParameter}::text)`;
  }

  const fieldParameter = addParameter(parameters, String(field));
  const textExpression = `record.data->>${fieldParameter}`;
  const jsonExpression = `record.data->${fieldParameter}`;

  if (expected === null || expected === undefined || expected === '') {
    return `COALESCE(${textExpression}, '') = ''`;
  }

  const expectedParameter = addParameter(parameters, String(expected));
  return `(
    LOWER(COALESCE(${textExpression}, '')) = LOWER(${expectedParameter}::text)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(${jsonExpression}) = 'array' THEN ${jsonExpression} ELSE '[]'::jsonb END
      ) AS array_value(value)
      WHERE LOWER(array_value.value) = LOWER(${expectedParameter}::text)
    )
  )`;
}

function buildLocationClause(parameters, entity, location = null) {
  if (!location || location.unrestricted) return null;
  const accessibleSiteIds = [...new Set((location.accessibleSiteIds || []).map(String))];
  const siteParameter = addParameter(parameters, accessibleSiteIds);

  if (entity === 'Site') {
    return `record.id = ANY(${siteParameter}::text[])`;
  }

  const directLocationFields = [
    'site_id',
    'from_site_id',
    'to_site_id',
    ...(['Production', 'ProductionConsumptionReport'].includes(entity) ? ['fulfillment_store_id'] : [])
  ];
  const hasDirectSite = `(${directLocationFields
    .map((field) => `COALESCE(record.data->>'${field}', '') <> ''`)
    .join('\n    OR ')})`;
  const directSitesAllowed = `(${directLocationFields
    .map((field) => `(COALESCE(record.data->>'${field}', '') = '' OR record.data->>'${field}' = ANY(${siteParameter}::text[]))`)
    .join('\n    AND ')})`;
  const scopedArrayAllowed = `(
    jsonb_typeof(record.data->'site_ids') = 'array'
    AND jsonb_array_length(record.data->'site_ids') > 0
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(record.data->'site_ids') AS scoped_site(value)
      WHERE scoped_site.value = ANY(${siteParameter}::text[])
    )
  )`;
  const globalRecipeAllowed = entity === 'Recipe'
    ? `OR (
      NOT ${hasDirectSite}
      AND (
        COALESCE(record.data->>'site_scope', 'global') = 'global'
        OR (
          jsonb_typeof(record.data->'site_ids') = 'array'
          AND jsonb_array_length(record.data->'site_ids') = 0
        )
      )
    )`
    : '';

  return `(
    (${hasDirectSite} AND ${directSitesAllowed})
    OR (NOT ${hasDirectSite} AND ${scopedArrayAllowed})
    ${globalRecipeAllowed}
  )`;
}

function buildOrderClause(parameters, entity, sort) {
  const normalizedSort = String(sort || '').trim();
  if (!normalizedSort) return 'record.updated_at DESC, record.id ASC';

  const descending = normalizedSort.startsWith('-');
  const field = descending ? normalizedSort.slice(1) : normalizedSort;
  if (!field) return 'record.updated_at DESC, record.id ASC';
  const direction = descending ? 'DESC' : 'ASC';
  if (entity === 'Inventory' && field === 'status') {
    return `LOWER(${inventoryStatusExpression()}) ${direction}, record.id ASC`;
  }
  const valueExpression = `record.data->>${addParameter(parameters, field)}`;

  return `
    CASE WHEN COALESCE(${valueExpression}, '') ~ '${NUMERIC_PATTERN}' THEN 0 ELSE 1 END ASC,
    CASE WHEN COALESCE(${valueExpression}, '') ~ '${NUMERIC_PATTERN}' THEN (${valueExpression})::numeric END ${direction} NULLS LAST,
    LOWER(${valueExpression}) ${direction} NULLS LAST,
    record.id ASC
  `;
}

export function buildEntityListQuery({
  entity,
  filters = {},
  sort,
  limit,
  offset = 0,
  lock = false,
  location = null,
  includeTotal = false
} = {}) {
  const parameters = [];
  const entityParameter = addParameter(parameters, entity);
  const clauses = [`record.entity_name = ${entityParameter}`];

  Object.entries(filters || {}).forEach(([field, expected]) => {
    clauses.push(buildFilterClause(parameters, entity, field, expected));
  });

  const locationClause = buildLocationClause(parameters, entity, location);
  if (locationClause) clauses.push(locationClause);

  const orderClause = buildOrderClause(parameters, entity, sort);
  const pageSize = normalizedLimit(limit);
  const pageOffset = normalizedOffset(offset);
  const limitClause = pageSize === null
    ? ''
    : `LIMIT ${addParameter(parameters, pageSize)}::integer`;
  const offsetClause = pageOffset > 0
    ? `OFFSET ${addParameter(parameters, pageOffset)}::integer`
    : '';
  const lockClause = lock ? 'FOR UPDATE' : '';
  const totalColumn = includeTotal ? ', COUNT(*) OVER() AS total_count' : '';

  return {
    text: `SELECT record.data${totalColumn}
      FROM entity_records record
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY ${orderClause}
      ${limitClause}
      ${offsetClause}
      ${lockClause}`,
    parameters,
    limit: pageSize,
    offset: pageOffset
  };
}

export { MAX_INTERNAL_PAGE_SIZE };
