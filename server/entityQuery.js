const MAX_INTERNAL_PAGE_SIZE = 10000;

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

function buildFilterClause(parameters, field, expected) {
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

  const hasDirectSite = `(
    COALESCE(record.data->>'site_id', '') <> ''
    OR COALESCE(record.data->>'from_site_id', '') <> ''
    OR COALESCE(record.data->>'to_site_id', '') <> ''
  )`;
  const directSitesAllowed = `(
    (COALESCE(record.data->>'site_id', '') = '' OR record.data->>'site_id' = ANY(${siteParameter}::text[]))
    AND (COALESCE(record.data->>'from_site_id', '') = '' OR record.data->>'from_site_id' = ANY(${siteParameter}::text[]))
    AND (COALESCE(record.data->>'to_site_id', '') = '' OR record.data->>'to_site_id' = ANY(${siteParameter}::text[]))
  )`;
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

function buildOrderClause(parameters, sort) {
  const normalizedSort = String(sort || '').trim();
  if (!normalizedSort) return 'record.updated_at DESC, record.id ASC';

  const descending = normalizedSort.startsWith('-');
  const field = descending ? normalizedSort.slice(1) : normalizedSort;
  if (!field) return 'record.updated_at DESC, record.id ASC';
  const fieldParameter = addParameter(parameters, field);
  const direction = descending ? 'DESC' : 'ASC';
  const valueExpression = `record.data->>${fieldParameter}`;
  const numericPattern = "^-?[0-9]+([.][0-9]+)?$";

  return `
    CASE WHEN COALESCE(${valueExpression}, '') ~ '${numericPattern}' THEN 0 ELSE 1 END ASC,
    CASE WHEN COALESCE(${valueExpression}, '') ~ '${numericPattern}' THEN (${valueExpression})::numeric END ${direction} NULLS LAST,
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
    clauses.push(buildFilterClause(parameters, field, expected));
  });

  const locationClause = buildLocationClause(parameters, entity, location);
  if (locationClause) clauses.push(locationClause);

  const orderClause = buildOrderClause(parameters, sort);
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
