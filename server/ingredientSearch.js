import { pool } from './db.js';
import { normalizeIngredientSearchText } from '../shared/ingredientSearch.js';

function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizeSiteIds(siteIds) {
  if (siteIds === null) return null;
  return [...new Set((siteIds || []).filter(Boolean).map(String))];
}

export async function searchIngredients(options = {}) {
  const startedAt = performance.now();
  const query = normalizeIngredientSearchText(options.query).slice(0, 120);
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 20));
  const offset = (page - 1) * limit;
  const siteIds = normalizeSiteIds(options.siteIds);
  const stockOnly = options.stockOnly === true;
  const containsPattern = `%${escapeLikePattern(query)}%`;

  const result = await pool.query(
    `WITH ingredient_catalog AS (
       SELECT
         record.id,
         record.data,
         LOWER(BTRIM(COALESCE(record.data->>'name', ''))) AS sort_name,
         ARRAY_REMOVE(ARRAY[
           LOWER(BTRIM(COALESCE(record.data->>'name', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'sku', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'ingredient_code', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'item_code', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'category', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'alias', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'alternative_name', ''))),
           LOWER(BTRIM(COALESCE(record.data->>'supplier_item_name', '')))
         ], '')
         || CASE WHEN jsonb_typeof(record.data->'aliases') = 'array'
              THEN ARRAY(SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(record.data->'aliases'))
              ELSE ARRAY_REMOVE(ARRAY[LOWER(BTRIM(COALESCE(record.data->>'aliases', '')))], '')
            END
         || CASE WHEN jsonb_typeof(record.data->'alternative_names') = 'array'
              THEN ARRAY(SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(record.data->'alternative_names'))
              ELSE ARRAY_REMOVE(ARRAY[LOWER(BTRIM(COALESCE(record.data->>'alternative_names', '')))], '')
            END
         || CASE WHEN jsonb_typeof(record.data->'supplier_item_names') = 'array'
              THEN ARRAY(SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(record.data->'supplier_item_names'))
              ELSE ARRAY_REMOVE(ARRAY[LOWER(BTRIM(COALESCE(record.data->>'supplier_item_names', '')))], '')
            END AS search_fields,
         LOWER(
           COALESCE(record.data->>'name', '') || ' ' ||
           COALESCE(record.data->>'sku', '') || ' ' ||
           COALESCE(record.data->>'ingredient_code', '') || ' ' ||
           COALESCE(record.data->>'item_code', '') || ' ' ||
           COALESCE(record.data->>'category', '') || ' ' ||
           COALESCE(record.data->>'alias', '') || ' ' ||
           COALESCE(record.data->>'aliases', '') || ' ' ||
           COALESCE(record.data->>'alternative_name', '') || ' ' ||
           COALESCE(record.data->>'alternative_names', '') || ' ' ||
           COALESCE(record.data->>'supplier_item_name', '') || ' ' ||
           COALESCE(record.data->>'supplier_item_names', '')
         ) AS search_document
       FROM entity_records record
       WHERE record.entity_name = 'Ingredient'
         AND COALESCE(LOWER(NULLIF(BTRIM(record.data->>'is_active'), '')), 'true') NOT IN ('false', '0', 'no', 'inactive')
     ),
     stock_totals AS (
       SELECT
         inventory.data->>'ingredient_id' AS ingredient_id,
         SUM(COALESCE(NULLIF(inventory.data->>'quantity', '')::numeric, 0)) AS current_stock
       FROM entity_records inventory
       WHERE inventory.entity_name = 'Inventory'
         AND ($5::text[] IS NULL OR inventory.data->>'site_id' = ANY($5::text[]))
       GROUP BY inventory.data->>'ingredient_id'
     ),
     matching AS (
       SELECT
         catalog.*,
         COALESCE(stock.current_stock, 0) AS current_stock,
         CASE
           WHEN $1 = '' THEN 0
           WHEN EXISTS (SELECT 1 FROM unnest(catalog.search_fields) field WHERE field = $1) THEN 0
           WHEN EXISTS (SELECT 1 FROM unnest(catalog.search_fields) field WHERE LEFT(field, LENGTH($1)) = $1) THEN 1
           ELSE 2
         END AS relevance
       FROM ingredient_catalog catalog
       LEFT JOIN stock_totals stock ON stock.ingredient_id = catalog.id
       WHERE ($1 = '' OR catalog.search_document LIKE $2 ESCAPE '\\')
     ),
     ranked AS (
       SELECT *
       FROM matching
       WHERE ($6::boolean = FALSE OR current_stock > 0)
     ),
     paged AS (
       SELECT * FROM ranked
       ORDER BY relevance, sort_name, id
       LIMIT $3 OFFSET $4
     ),
     hydrated AS (
       SELECT
         paged.id,
         paged.sort_name,
         paged.relevance,
         paged.data || jsonb_build_object(
           'id', paged.id,
           'current_stock', paged.current_stock,
           'stock_unit', COALESCE(paged.data->>'unit', ''),
           'last_cost', COALESCE(price.unit_price, NULLIF(paged.data->>'cost_per_unit', '')::numeric),
           'last_cost_currency', COALESCE(price.currency, paged.data->>'currency', 'SAR'),
           'last_supplier_name', price.supplier_name,
           'relevance', paged.relevance
         ) AS item
       FROM paged
       LEFT JOIN LATERAL (
         SELECT history.unit_price, history.currency, history.supplier_name
         FROM supplier_price_history history
         WHERE history.ingredient_id = paged.id
           AND ($5::text[] IS NULL OR history.site_id IS NULL OR history.site_id = ANY($5::text[]))
         ORDER BY history.effective_date DESC, history.created_at DESC
         LIMIT 1
       ) price ON TRUE
     )
     SELECT
       (SELECT COUNT(*)::integer FROM ingredient_catalog) AS indexed_count,
       (SELECT COUNT(*)::integer FROM ranked) AS total_count,
       COALESCE(
         (SELECT jsonb_agg(item ORDER BY relevance, sort_name, id) FROM hydrated),
         '[]'::jsonb
       ) AS items`,
    [query, containsPattern, limit, offset, siteIds, stockOnly]
  );

  const row = result.rows[0] || {};
  const totalCount = Number(row.total_count || 0);
  return {
    items: row.items || [],
    total_count: totalCount,
    indexed_count: Number(row.indexed_count || 0),
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(totalCount / limit)),
    has_more: offset + limit < totalCount,
    elapsed_ms: Math.max(1, Math.round(performance.now() - startedAt))
  };
}
