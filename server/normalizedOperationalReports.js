import { pool } from './db.js';
import {
  groupFoodCostRows,
  roundFoodCostNumber,
  safeFoodCostNumber,
  titleCaseFoodCost
} from '../shared/foodCostReport.js';

function normalizeDate(value, fallback) {
  const text = String(value || '').trim();
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : fallback;
}

function offsetDateOnly(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function normalizeFilterText(value, fallback = 'all') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return normalized || fallback;
}

function normalizeNullableFilter(value) {
  const normalized = normalizeFilterText(value, 'all');
  return normalized === 'all' ? null : normalized;
}

function normalizeAccessibleIds(accessibleSiteIds) {
  if (!Array.isArray(accessibleSiteIds)) return null;
  const ids = [...new Set(accessibleSiteIds.map((id) => String(id || '').trim()).filter(Boolean))];
  return ids.length ? ids : [];
}

function normalizeFoodCostFilters(rawFilters = {}) {
  const endDate = normalizeDate(rawFilters.end_date ?? rawFilters.endDate, offsetDateOnly(0));
  const startDate = normalizeDate(rawFilters.start_date ?? rawFilters.startDate, offsetDateOnly(-30));
  const orderedStart = startDate <= endDate ? startDate : endDate;
  const orderedEnd = startDate <= endDate ? endDate : startDate;
  return {
    startDate: orderedStart,
    endDate: orderedEnd,
    locationId: String(rawFilters.location_id ?? rawFilters.locationId ?? 'all').trim() || 'all',
    category: normalizeFilterText(rawFilters.category, 'all'),
    mealType: normalizeFilterText(rawFilters.meal_type ?? rawFilters.mealType, 'all'),
    menuType: normalizeFilterText(rawFilters.menu_type ?? rawFilters.menuType, 'all'),
    view: normalizeFilterText(rawFilters.view, 'detail')
  };
}

function buildLocationScopePredicate(alias, parameterIndex) {
  return `(
    $${parameterIndex}::text[] IS NULL
    OR ${alias}.warehouse_id = ANY($${parameterIndex}::text[])
    OR ${alias}.project_id = ANY($${parameterIndex}::text[])
    OR ${alias}.area_id = ANY($${parameterIndex}::text[])
  )`;
}

function buildLocationFilterPredicate(alias, parameterIndex) {
  return `(
    $${parameterIndex}::text IS NULL
    OR ${alias}.warehouse_id = $${parameterIndex}
    OR ${alias}.project_id = $${parameterIndex}
    OR ${alias}.area_id = $${parameterIndex}
  )`;
}

const locationDimensionSql = `
  SELECT
    warehouse.warehouse_id,
    warehouse.name AS warehouse_name,
    warehouse.warehouse_code,
    project.project_id,
    project.name AS project_name,
    project.project_code,
    area.area_id,
    area.name AS area_name,
    area.area_code
  FROM warehouses warehouse
  JOIN projects project ON project.project_id = warehouse.project_id
  JOIN areas area ON area.area_id = project.area_id
`;

export async function loadNormalizedFoodCostReport({
  rawFilters = {},
  accessibleSiteIds = null,
  executor = pool
} = {}) {
  const filters = normalizeFoodCostFilters(rawFilters);
  const scopedIds = normalizeAccessibleIds(accessibleSiteIds);
  const locationId = filters.locationId === 'all' ? null : filters.locationId;
  const category = normalizeNullableFilter(filters.category);
  const mealType = normalizeNullableFilter(filters.mealType);
  const menuType = normalizeNullableFilter(filters.menuType);
  const params = [
    filters.startDate,
    filters.endDate,
    scopedIds,
    locationId,
    category,
    mealType,
    menuType
  ];

  const confirmedSql = `
    WITH location_dim AS (${locationDimensionSql}),
    reversed_consumptions AS (
      SELECT DISTINCT reverses_consumption_id
      FROM meal_service_consumptions
      WHERE reverses_consumption_id IS NOT NULL
        AND status NOT IN ('voided', 'cancelled')
    )
    SELECT
      msc.service_date::text AS date,
      COALESCE(location_dim.warehouse_code, location_dim.warehouse_name, msh.warehouse_id, pe.warehouse_id, pob.warehouse_id, 'Unassigned') AS location,
      msc.meal_period AS meal_type,
      COALESCE(msh.menu_type, pe.menu_type, 'general') AS menu_type,
      COALESCE(msh.menu_category, pe.menu_category, rv.menu_category, '-') AS category,
      COALESCE(rv.display_name, pml.item_name, 'Meal Service') AS recipe,
      COALESCE(msc.consumed_servings, 0) AS servings,
      COALESCE(msh.serving_size_grams, 0) AS portion_size_g,
      COALESCE(msc.consumed_weight_grams, 0) AS served_weight_grams,
      COALESCE(
        NULLIF(msc.cost, 0),
        CASE
          WHEN pob.initial_weight_grams > 0
          THEN COALESCE(msc.consumed_weight_grams, 0) * COALESCE(pob.total_cost, 0) / pob.initial_weight_grams
          ELSE 0
        END
      ) AS total_cost
    FROM meal_service_consumptions msc
    LEFT JOIN meal_service_headers msh ON msh.meal_service_id = msc.meal_service_id
    LEFT JOIN produced_output_batches pob ON pob.output_batch_id = msc.output_batch_id
    LEFT JOIN production_events pe ON pe.production_id = COALESCE(msc.production_id, pob.production_id)
    LEFT JOIN production_manifest_lines pml ON pml.production_line_id = pob.production_line_id
    LEFT JOIN recipe_versions rv ON rv.recipe_version_id = COALESCE(msc.recipe_version_id, pob.recipe_version_id, pml.recipe_version_id)
    LEFT JOIN location_dim ON location_dim.warehouse_id = COALESCE(msh.warehouse_id, pe.warehouse_id, pob.warehouse_id)
    LEFT JOIN reversed_consumptions reversed ON reversed.reverses_consumption_id = msc.meal_consumption_id
    WHERE msc.service_date BETWEEN $1::date AND $2::date
      AND msc.status NOT IN ('reversed', 'voided', 'cancelled')
      AND COALESCE(msc.movement_type, 'consumption') NOT IN ('reversal', 'plate_waste_adjustment')
      AND reversed.reverses_consumption_id IS NULL
      AND COALESCE(pe.status, '') NOT IN ('reversed', 'voided', 'cancelled')
      AND COALESCE(pob.status, '') NOT IN ('reversed', 'voided', 'cancelled')
      AND ${buildLocationScopePredicate('location_dim', 3)}
      AND ${buildLocationFilterPredicate('location_dim', 4)}
      AND ($5::text IS NULL OR LOWER(COALESCE(msh.menu_category, pe.menu_category, rv.menu_category, '')) = $5)
      AND ($6::text IS NULL OR LOWER(COALESCE(msc.meal_period, msh.meal_period, pe.meal_period, '')) = $6)
      AND ($7::text IS NULL OR LOWER(COALESCE(msh.menu_type, pe.menu_type, 'general')) = $7)
    ORDER BY msc.service_date DESC, location ASC, meal_type ASC, category ASC, recipe ASC
  `;

  const pendingSql = `
    WITH location_dim AS (${locationDimensionSql}),
    served_productions AS (
      SELECT DISTINCT COALESCE(msc.production_id, pob.production_id) AS production_id
      FROM meal_service_consumptions msc
      LEFT JOIN produced_output_batches pob ON pob.output_batch_id = msc.output_batch_id
      WHERE msc.status NOT IN ('reversed', 'voided', 'cancelled')
        AND COALESCE(msc.movement_type, 'consumption') NOT IN ('reversal', 'plate_waste_adjustment')
        AND COALESCE(msc.consumed_weight_grams, 0) > 0
    ),
    production_totals AS (
      SELECT
        pe.production_id,
        STRING_AGG(DISTINCT pml.item_name, ', ' ORDER BY pml.item_name) FILTER (WHERE COALESCE(pml.item_name, '') <> '') AS production_name,
        SUM(COALESCE(pob.initial_weight_grams, pml.produced_weight_grams, 0)) AS produced_weight_grams,
        SUM(COALESCE(pob.initial_servings, pml.produced_servings, 0)) AS produced_servings,
        SUM(COALESCE(NULLIF(pob.total_cost, 0), pml.actual_cost, pml.estimated_cost, 0)) AS production_cost
      FROM production_events pe
      LEFT JOIN production_manifest_lines pml ON pml.production_id = pe.production_id
      LEFT JOIN produced_output_batches pob ON pob.production_line_id = pml.production_line_id
      GROUP BY pe.production_id
    )
    SELECT
      pe.production_date::text AS date,
      COALESCE(location_dim.warehouse_code, location_dim.warehouse_name, pe.warehouse_id, 'Unassigned') AS location,
      pe.meal_period AS meal_type,
      COALESCE(pe.menu_type, 'general') AS menu_type,
      COALESCE(pe.menu_category, '-') AS category,
      COALESCE(production_totals.production_name, 'Production') AS production,
      COALESCE(production_totals.produced_weight_grams, 0) AS produced_weight_grams,
      COALESCE(production_totals.produced_servings, 0) AS production_servings,
      COALESCE(production_totals.production_cost, 0) AS production_cost
    FROM production_events pe
    LEFT JOIN production_totals ON production_totals.production_id = pe.production_id
    LEFT JOIN served_productions ON served_productions.production_id = pe.production_id
    LEFT JOIN location_dim ON location_dim.warehouse_id = pe.warehouse_id
    WHERE pe.production_date BETWEEN $1::date AND $2::date
      AND pe.status = 'completed'
      AND served_productions.production_id IS NULL
      AND ${buildLocationScopePredicate('location_dim', 3)}
      AND ${buildLocationFilterPredicate('location_dim', 4)}
      AND ($5::text IS NULL OR LOWER(COALESCE(pe.menu_category, '')) = $5)
      AND ($6::text IS NULL OR LOWER(COALESCE(pe.meal_period, '')) = $6)
      AND ($7::text IS NULL OR LOWER(COALESCE(pe.menu_type, 'general')) = $7)
    ORDER BY pe.production_date DESC, location ASC, meal_type ASC, category ASC, production ASC
  `;

  const optionsSql = `
    SELECT DISTINCT menu_category AS category, NULL::text AS menu_type
    FROM meal_service_headers
    WHERE COALESCE(menu_category, '') <> ''
    UNION
    SELECT DISTINCT menu_category AS category, NULL::text AS menu_type
    FROM production_events
    WHERE COALESCE(menu_category, '') <> ''
    UNION
    SELECT NULL::text AS category, DISTINCT_MENU_TYPE.menu_type
    FROM (
      SELECT DISTINCT menu_type FROM meal_service_headers WHERE COALESCE(menu_type, '') <> ''
      UNION
      SELECT DISTINCT menu_type FROM production_events WHERE COALESCE(menu_type, '') <> ''
    ) DISTINCT_MENU_TYPE
  `;

  const [confirmedResult, pendingResult, optionsResult] = await Promise.all([
    executor.query(confirmedSql, params),
    executor.query(pendingSql, params),
    executor.query(optionsSql, [])
  ]);

  const confirmedRows = confirmedResult.rows.map((row) => {
    const servings = safeFoodCostNumber(row.servings);
    const totalCost = roundFoodCostNumber(row.total_cost);
    return {
      date: row.date,
      location: row.location,
      meal_type: titleCaseFoodCost(row.meal_type || 'unspecified'),
      menu_type: titleCaseFoodCost(row.menu_type || 'general'),
      recipe: row.recipe,
      category: row.category || '-',
      servings: roundFoodCostNumber(servings, 3),
      portion_size_g: roundFoodCostNumber(row.portion_size_g, 2),
      served_weight_kg: roundFoodCostNumber(safeFoodCostNumber(row.served_weight_grams) / 1000, 3),
      total_cost: totalCost,
      cost_per_serving: Number((servings > 0 ? totalCost / servings : 0).toFixed(2)),
      source: 'Meal Service confirmed'
    };
  }).filter((row) => (
    Math.abs(safeFoodCostNumber(row.servings)) > 0.000001
    || Math.abs(safeFoodCostNumber(row.served_weight_kg)) > 0.000001
    || Math.abs(safeFoodCostNumber(row.total_cost)) > 0.000001
  ));

  const rows = groupFoodCostRows(confirmedRows, filters.view);
  const pendingProductionRows = pendingResult.rows.map((row) => ({
    date: row.date,
    location: row.location,
    meal_type: titleCaseFoodCost(row.meal_type || 'unspecified'),
    menu_type: titleCaseFoodCost(row.menu_type || 'general'),
    production: row.production,
    category: row.category || '-',
    produced_output_kg: roundFoodCostNumber(safeFoodCostNumber(row.produced_weight_grams) / 1000, 3),
    production_servings: roundFoodCostNumber(row.production_servings, 3),
    production_cost: roundFoodCostNumber(row.production_cost),
    status: 'Pending Meal Service'
  }));
  const summary = rows.reduce((totals, row) => ({
    total_cost: totals.total_cost + safeFoodCostNumber(row.total_cost),
    servings: totals.servings + safeFoodCostNumber(row.servings ?? row.total_servings)
  }), { total_cost: 0, servings: 0 });
  const categories = [...new Set(optionsResult.rows.map((row) => row.category).filter(Boolean))].sort();
  const menuTypes = [...new Set(optionsResult.rows.map((row) => row.menu_type).filter(Boolean))].sort();

  return {
    filters,
    rows,
    pending_production_rows: pendingProductionRows,
    summary: {
      total_cost: roundFoodCostNumber(summary.total_cost),
      servings: roundFoodCostNumber(summary.servings, 3),
      average_cost_per_serving: summary.servings > 0
        ? roundFoodCostNumber(summary.total_cost / summary.servings)
        : 0
    },
    categories,
    menu_types: menuTypes,
    source: 'normalized-relational',
    generated_at: new Date().toISOString()
  };
}

export async function getNormalizedDatabaseAudit({ includeOk = false, executor = pool } = {}) {
  const checks = [
    {
      key: 'menu_plan_lines_without_link',
      severity: 'error',
      description: 'Menu plan lines without a recipe or ingredient link',
      sql: `SELECT menu_plan_line_id AS id
            FROM menu_plan_lines
            WHERE recipe_version_id IS NULL AND ingredient_id IS NULL
            LIMIT 25`
    },
    {
      key: 'production_without_manifest',
      severity: 'error',
      description: 'Production events without any manifest lines',
      sql: `SELECT pe.production_id AS id
            FROM production_events pe
            LEFT JOIN production_manifest_lines pml ON pml.production_id = pe.production_id
            WHERE pe.status NOT IN ('reversed', 'voided', 'cancelled')
            GROUP BY pe.production_id
            HAVING COUNT(pml.production_line_id) = 0
            LIMIT 25`
    },
    {
      key: 'produced_output_without_manifest',
      severity: 'error',
      description: 'Produced output batches not linked to a manifest line',
      sql: `SELECT pob.output_batch_id AS id
            FROM produced_output_batches pob
            LEFT JOIN production_manifest_lines pml ON pml.production_line_id = pob.production_line_id
            WHERE pob.status NOT IN ('reversed', 'voided', 'cancelled')
              AND pml.production_line_id IS NULL
            LIMIT 25`
    },
    {
      key: 'meal_service_on_reversed_output',
      severity: 'error',
      description: 'Meal service consumption linked to reversed or voided production/output',
      sql: `SELECT msc.meal_consumption_id AS id
            FROM meal_service_consumptions msc
            LEFT JOIN produced_output_batches pob ON pob.output_batch_id = msc.output_batch_id
            LEFT JOIN production_events pe ON pe.production_id = COALESCE(msc.production_id, pob.production_id)
            WHERE msc.status NOT IN ('reversed', 'voided', 'cancelled')
              AND COALESCE(msc.movement_type, 'consumption') <> 'reversal'
              AND (
                COALESCE(pob.status, '') IN ('reversed', 'voided', 'cancelled')
                OR COALESCE(pe.status, '') IN ('reversed', 'voided', 'cancelled')
              )
            LIMIT 25`
    },
    {
      key: 'food_waste_on_reversed_output',
      severity: 'error',
      description: 'Food waste linked to reversed or voided production/output',
      sql: `SELECT fwr.food_waste_id AS id
            FROM food_waste_records fwr
            LEFT JOIN food_waste_lines fwl ON fwl.food_waste_id = fwr.food_waste_id
            LEFT JOIN produced_output_batches pob ON pob.output_batch_id = fwl.output_batch_id
            LEFT JOIN production_events pe ON pe.production_id = pob.production_id
            WHERE fwr.status NOT IN ('reversed', 'voided', 'cancelled')
              AND (
                COALESCE(pob.status, '') IN ('reversed', 'voided', 'cancelled')
                OR COALESCE(pe.status, '') IN ('reversed', 'voided', 'cancelled')
              )
            LIMIT 25`
    },
    {
      key: 'inventory_without_ingredient',
      severity: 'error',
      description: 'Warehouse inventory rows with missing ingredient master',
      sql: `SELECT wi.inventory_id AS id
            FROM warehouse_inventory wi
            LEFT JOIN ingredients ingredient ON ingredient.ingredient_id = wi.ingredient_id
            WHERE ingredient.ingredient_id IS NULL
            LIMIT 25`
    },
    {
      key: 'legacy_core_documents_remaining',
      severity: 'warning',
      description: 'Core entities still present in the legacy JSON document table',
      sql: `SELECT id
            FROM entity_records
            WHERE entity_name = ANY($1::text[])
            LIMIT 25`,
      params: [[
        'Site',
        'Ingredient',
        'Inventory',
        'InventoryLot',
        'InventoryTransaction',
        'Recipe',
        'MenuPlan',
        'Production',
        'ProductionConsumptionReport',
        'ProducedItemBatch',
        'MealServiceAttendance',
        'MealServiceConsumption',
        'FoodWaste'
      ]]
    }
  ];

  const results = [];
  for (const check of checks) {
    const result = await executor.query(check.sql, check.params || []);
    if (!includeOk && result.rowCount === 0) continue;
    results.push({
      key: check.key,
      severity: result.rowCount > 0 ? check.severity : 'ok',
      description: check.description,
      count: result.rowCount,
      sample_ids: result.rows.map((row) => String(row.id)).filter(Boolean)
    });
  }

  const legacyBreakdownResult = await executor.query(
    `SELECT entity_name, COUNT(*)::int AS count
     FROM entity_records
     GROUP BY entity_name
     ORDER BY entity_name`
  );
  return {
    generated_at: new Date().toISOString(),
    status: results.some((check) => check.severity === 'error')
      ? 'attention_required'
      : results.some((check) => check.severity === 'warning')
        ? 'warnings'
        : 'ok',
    checks: results,
    legacy_entity_counts: legacyBreakdownResult.rows
  };
}
