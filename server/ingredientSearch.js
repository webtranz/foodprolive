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
         ingredient.ingredient_id AS id,
         ingredient.payload || jsonb_build_object(
           'id', ingredient.ingredient_id,
           'name', ingredient.name,
           'item_code', ingredient.item_code,
           'ingredient_code', ingredient.ingredient_code,
           'sku', ingredient.sku,
           'd365_item_id', ingredient.d365_item_id,
           'category', ingredient.category_id,
           'unit', ingredient.base_unit,
           'source_name', ingredient.source_name,
           'is_active', LOWER(COALESCE(ingredient.status, 'active')) <> 'inactive'
         ) AS data,
         LOWER(BTRIM(COALESCE(ingredient.name, ''))) AS sort_name,
         ARRAY_REMOVE(ARRAY[
           LOWER(BTRIM(COALESCE(ingredient.name, ''))),
           LOWER(BTRIM(COALESCE(ingredient.sku, ''))),
           LOWER(BTRIM(COALESCE(ingredient.ingredient_code, ''))),
           LOWER(BTRIM(COALESCE(ingredient.item_code, ''))),
           LOWER(BTRIM(COALESCE(ingredient.d365_item_id, ''))),
           LOWER(BTRIM(COALESCE(ingredient.category_id, ''))),
           LOWER(BTRIM(COALESCE(ingredient.payload->>'alias', ''))),
           LOWER(BTRIM(COALESCE(ingredient.payload->>'alternative_name', ''))),
           LOWER(BTRIM(COALESCE(ingredient.payload->>'supplier_item_name', '')))
         ], '')
         || CASE WHEN jsonb_typeof(ingredient.payload->'aliases') = 'array'
              THEN ARRAY(SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(ingredient.payload->'aliases'))
              ELSE ARRAY_REMOVE(ARRAY[LOWER(BTRIM(COALESCE(ingredient.payload->>'aliases', '')))], '')
            END
         || CASE WHEN jsonb_typeof(ingredient.payload->'alternative_names') = 'array'
              THEN ARRAY(SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(ingredient.payload->'alternative_names'))
              ELSE ARRAY_REMOVE(ARRAY[LOWER(BTRIM(COALESCE(ingredient.payload->>'alternative_names', '')))], '')
            END
         || CASE WHEN jsonb_typeof(ingredient.payload->'supplier_item_names') = 'array'
              THEN ARRAY(SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(ingredient.payload->'supplier_item_names'))
              ELSE ARRAY_REMOVE(ARRAY[LOWER(BTRIM(COALESCE(ingredient.payload->>'supplier_item_names', '')))], '')
            END AS search_fields,
         LOWER(
           COALESCE(ingredient.name, '') || ' ' ||
           COALESCE(ingredient.sku, '') || ' ' ||
           COALESCE(ingredient.ingredient_code, '') || ' ' ||
           COALESCE(ingredient.item_code, '') || ' ' ||
           COALESCE(ingredient.d365_item_id, '') || ' ' ||
           COALESCE(ingredient.category_id, '') || ' ' ||
           COALESCE(ingredient.payload->>'alias', '') || ' ' ||
           COALESCE(ingredient.payload->>'aliases', '') || ' ' ||
           COALESCE(ingredient.payload->>'alternative_name', '') || ' ' ||
           COALESCE(ingredient.payload->>'alternative_names', '') || ' ' ||
           COALESCE(ingredient.payload->>'supplier_item_name', '') || ' ' ||
           COALESCE(ingredient.payload->>'supplier_item_names', '')
         ) AS search_document
       FROM ingredients ingredient
       WHERE LOWER(COALESCE(ingredient.status, 'active')) <> 'inactive'
     ),
     stock_totals AS (
       SELECT
         inventory.ingredient_id,
         SUM(COALESCE(inventory.available_quantity, inventory.on_hand_quantity, 0)) AS current_stock
       FROM warehouse_inventory inventory
       WHERE ($5::text[] IS NULL OR inventory.warehouse_id = ANY($5::text[]))
       GROUP BY inventory.ingredient_id
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

/** Resolve the same latest and weighted-average costs used by the picker. */
export async function getIngredientCostSnapshots(options = {}) {
  const ingredientIds = [...new Set((options.ingredientIds || []).filter(Boolean).map(String))];
  if (ingredientIds.length === 0) return {};
  const siteIds = normalizeSiteIds(options.siteIds ?? null);
  const result = await pool.query(
    `WITH requested AS (
       SELECT UNNEST($1::text[]) AS ingredient_id
     ),
     inventory_costs AS (
       SELECT
         inventory.ingredient_id,
         SUM(COALESCE(inventory.on_hand_quantity, inventory.available_quantity, 0)) AS total_quantity,
         SUM(
           COALESCE(inventory.on_hand_quantity, inventory.available_quantity, 0)
           * COALESCE(inventory.average_unit_cost, inventory.last_unit_cost, 0)
         ) AS total_value
       FROM warehouse_inventory inventory
       JOIN requested ON requested.ingredient_id = inventory.ingredient_id
       WHERE ($2::text[] IS NULL OR inventory.warehouse_id = ANY($2::text[]))
       GROUP BY inventory.ingredient_id
     )
     SELECT
       requested.ingredient_id,
       latest.unit_price AS last_cost,
       CASE WHEN inventory.total_quantity > 0
         THEN inventory.total_value / inventory.total_quantity
         ELSE NULL
       END AS average_cost
     FROM requested
     LEFT JOIN inventory_costs inventory USING (ingredient_id)
     LEFT JOIN LATERAL (
       SELECT history.unit_price
       FROM supplier_price_history history
       WHERE history.ingredient_id = requested.ingredient_id
         AND ($2::text[] IS NULL OR history.site_id IS NULL OR history.site_id = ANY($2::text[]))
       ORDER BY history.effective_date DESC, history.created_at DESC
       LIMIT 1
     ) latest ON TRUE`,
    [ingredientIds, siteIds]
  );

  return Object.fromEntries(result.rows.map((row) => [row.ingredient_id, {
    last_cost: row.last_cost === null ? null : Number(row.last_cost),
    average_cost: row.average_cost === null ? null : Number(row.average_cost)
  }]));
}
