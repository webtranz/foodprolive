import crypto from 'node:crypto';
import { pool, withTransaction, listDocuments } from './db.js';
import { filterRecordsByLocation, getLocationScope } from './locationScope.js';
import { expandRecipeIngredients } from '../shared/recipeComposition.js';
import { convertIngredientQuantity } from '../shared/ingredientUnits.js';
import { calculateYieldOutputQuantity } from '../shared/ingredientYield.js';
import { getItemCode } from '../shared/itemCode.js';
import { normalizeSiteType, SITE_HIERARCHY_TYPES } from '../shared/siteHierarchy.js';

const D365_EXPORT_HEADERS = [
  'site_id',
  'site_name',
  'project_id',
  'project_name',
  'warehouse_id',
  'warehouse_name',
  'request_month',
  'inclusions',
  'item_id',
  'item_name',
  'purchase_unit',
  'quantity_ordered',
  'delivery_date',
  'estimated_unit_price',
  'estimated_line_amount'
];

const MONTHLY_PR_STATUS = Object.freeze({
  PENDING_PROJECT_MANAGER: 'pending_project_manager',
  PENDING_AREA_MANAGER: 'pending_area_manager',
  READY_FOR_STOREKEEPER: 'ready_for_storekeeper',
  EXPORTED: 'exported',
  RETURNED_TO_CHEF: 'returned_to_chef'
});

const MONTHLY_PR_STEP = Object.freeze({
  PROJECT_MANAGER: 'project_manager',
  AREA_MANAGER: 'area_manager',
  STOREKEEPER_EXPORT: 'storekeeper_export',
  COMPLETE: 'complete',
  CHEF_REVISION: 'chef_revision'
});

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function normalizeDateOnly(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function monthRange(month) {
  const monthKey = normalizeText(month).match(/^\d{4}-\d{2}$/)?.[0]
    || new Date().toISOString().slice(0, 7);
  const start = `${monthKey}-01`;
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(startDate);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return {
    month_key: monthKey,
    start_date: start,
    end_date: endDate.toISOString().slice(0, 10)
  };
}

function buildSiteGraph(sites = []) {
  const byId = new Map(sites.map((site) => [String(site.id), site]));
  const children = new Map();
  sites.forEach((site) => {
    const parentId = site.parent_site_id ? String(site.parent_site_id) : null;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(site);
  });
  return { byId, children };
}

function collectDescendants(siteId, graph) {
  const visited = new Set();
  const queue = [String(siteId || '')].filter(Boolean);
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    (graph.children.get(current) || []).forEach((child) => queue.push(String(child.id)));
  }
  return [...visited].map((id) => graph.byId.get(id)).filter(Boolean);
}

function collectAncestors(siteId, graph) {
  const ancestors = [];
  let cursor = graph.byId.get(String(siteId || ''));
  const visited = new Set();
  while (cursor?.parent_site_id) {
    const parentId = String(cursor.parent_site_id);
    if (!parentId || visited.has(parentId)) break;
    visited.add(parentId);
    const parent = graph.byId.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    cursor = parent;
  }
  return ancestors;
}

function resolveRequestSiteContext({ sites = [], siteId }) {
  const graph = buildSiteGraph(sites);
  const selectedSite = graph.byId.get(String(siteId || ''));
  if (!selectedSite) {
    const error = new Error('Select a valid site, project, or area for the purchase request.');
    error.status = 400;
    throw error;
  }

  const descendants = collectDescendants(selectedSite.id, graph);
  const warehouseSites = descendants.filter((site) =>
    normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
  );
  const selectedType = normalizeSiteType(selectedSite.type);
  const firstWarehouse = selectedType === SITE_HIERARCHY_TYPES.STORE
    ? selectedSite
    : warehouseSites[0] || null;
  const ancestors = collectAncestors(firstWarehouse?.id || selectedSite.id, graph);
  const area = selectedType === SITE_HIERARCHY_TYPES.AREA
    ? selectedSite
    : ancestors.find((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.AREA) || null;
  const project = selectedType === SITE_HIERARCHY_TYPES.PROJECT
    ? selectedSite
    : ancestors.find((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT) || null;

  return {
    selected_site_id: selectedSite.id,
    selected_site_name: selectedSite.name,
    selected_site_type: selectedType,
    area_id: area?.id || null,
    area_name: area?.name || null,
    project_id: project?.id || null,
    project_name: project?.name || null,
    warehouse_ids: warehouseSites.map((site) => String(site.id)),
    warehouse_names: warehouseSites.map((site) => site.name).filter(Boolean),
    primary_warehouse_id: firstWarehouse?.id || null,
    primary_warehouse_name: firstWarehouse?.name || null
  };
}

function planIsSpecialEvent(plan = {}) {
  return Boolean(normalizeText(plan.event_name || plan.event_id || plan.special_event_id));
}

function includePlanForScope(plan, inclusions) {
  const normalized = normalizeLower(inclusions || 'all_meals');
  if (planIsSpecialEvent(plan)) {
    return normalized.includes('special');
  }
  return true;
}

function getPlanLines(plan = {}) {
  if (Array.isArray(plan.meals) && plan.meals.length) {
    return plan.meals.map((meal, index) => ({
      source: meal,
      line_number: index + 1,
      meal_period: meal.meal_type || plan.meal_type || plan.meal_period,
      recipe_id: meal.recipe_id || meal.recipe_version_id || null,
      recipe_name: meal.recipe_name || meal.item_name || meal.name || '',
      planned_covers: meal.expected_servings ?? meal.planned_servings ?? meal.servings ?? null
    }));
  }
  if (Array.isArray(plan.menu_plan_lines) && plan.menu_plan_lines.length) {
    return plan.menu_plan_lines.map((line, index) => ({
      source: line,
      line_number: index + 1,
      meal_period: line.meal_type || line.meal_period || plan.meal_type || plan.meal_period,
      recipe_id: line.recipe_id || line.recipe_version_id || null,
      recipe_name: line.recipe_name || line.item_name || line.name || '',
      planned_covers: line.expected_servings ?? line.planned_servings ?? line.servings ?? null
    }));
  }
  return [{
    source: plan,
    line_number: 1,
    meal_period: plan.meal_type || plan.meal_period,
    recipe_id: plan.recipe_id || plan.recipe_version_id || null,
    recipe_name: plan.recipe_name || plan.item_name || '',
    planned_covers: plan.expected_servings ?? plan.planned_servings ?? plan.total_expected_servings ?? null
  }];
}

function normalizeMenuType(plan = {}) {
  return normalizeText(plan.menu_type || plan.cuisine_type || 'General') || 'General';
}

function normalizeMenuCategory(plan = {}) {
  return normalizeText(plan.menu_category || 'Senior') || 'Senior';
}

function normalizeMealPeriod(value) {
  const text = normalizeText(value || 'All meals');
  return text || 'All meals';
}

function buildSourceMenuLines(menuPlans = []) {
  return menuPlans.flatMap((plan) => {
    const planDate = normalizeDateOnly(plan.plan_date);
    return getPlanLines(plan).map((line) => {
      const plannedCovers = toNumber(line.planned_covers, 0);
      const recipeId = normalizeText(line.recipe_id);
      const sourceLineId = normalizeText(
        line.source?.menu_plan_line_id
        || line.source?.id
        || `${plan.id}:line:${line.line_number}`
      );
      const warningCodes = [];
      if (plannedCovers <= 0) warningCodes.push('zero_pax');
      else if (plannedCovers <= 1) warningCodes.push('one_pax');
      if (!recipeId) warningCodes.push('missing_recipe');
      return {
        source_line_id: sourceLineId,
        menu_plan_id: plan.id,
        menu_plan_line_id: sourceLineId,
        warehouse_id: plan.site_id || plan.warehouse_id || null,
        plan_date: planDate,
        meal_period: normalizeMealPeriod(line.meal_period),
        menu_type: normalizeMenuType(plan),
        menu_category: normalizeMenuCategory(plan),
        recipe_id: recipeId || null,
        recipe_name: normalizeText(line.recipe_name) || 'Unlinked menu line',
        planned_covers: plannedCovers,
        warning_codes: warningCodes
      };
    });
  });
}

function warningSeverity(codes = []) {
  return codes.includes('missing_recipe') || codes.includes('zero_pax') ? 'high' : 'medium';
}

function warningMessage(sourceLine = {}) {
  const codes = sourceLine.warning_codes || [];
  if (codes.includes('missing_recipe')) {
    return 'This menu line has no linked recipe, so ingredient demand cannot be calculated.';
  }
  if (codes.includes('zero_pax')) {
    return 'This planned meal/category has 0 pax/covers. Fix the menu plan or exclude it before approving demand.';
  }
  if (codes.includes('one_pax')) {
    return 'This planned meal/category has only 1 pax/cover. Confirm it is intentional before approving demand.';
  }
  return '';
}

function buildWarnings(sourceLines = []) {
  return sourceLines
    .filter((line) => (line.warning_codes || []).length > 0)
    .map((line) => ({
      warning_id: randomId('prw'),
      warning_type: line.warning_codes[0],
      severity: warningSeverity(line.warning_codes),
      menu_plan_id: line.menu_plan_id,
      menu_plan_line_id: line.menu_plan_line_id,
      plan_date: line.plan_date,
      meal_period: line.meal_period,
      menu_type: line.menu_type,
      menu_category: line.menu_category,
      recipe_id: line.recipe_id,
      recipe_name: line.recipe_name,
      planned_covers: line.planned_covers,
      message: warningMessage(line),
      resolution_status: 'open'
    }));
}

function getIngredientUnit(ingredient, recipeIngredient) {
  return normalizeText(ingredient?.unit || ingredient?.base_unit || recipeIngredient?.unit || 'unit') || 'unit';
}

function buildInventoryPriceMap(inventory = []) {
  const priceMap = new Map();
  (Array.isArray(inventory) ? inventory : []).forEach((item) => {
    const ingredientId = normalizeText(item.ingredient_id);
    const warehouseId = normalizeText(item.site_id || item.warehouse_id);
    if (!ingredientId || !warehouseId) return;
    const price = toNumber(item.average_unit_cost, 0) || toNumber(item.last_unit_cost, 0) || toNumber(item.unit_cost, 0);
    if (price <= 0) return;
    priceMap.set(`${warehouseId}|${ingredientId}`, price);
  });
  return priceMap;
}

function buildPurchaseLines({ sourceLines = [], recipes = [], ingredients = [], inventory = [] } = {}) {
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe.id), recipe]));
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient]));
  const inventoryPriceMap = buildInventoryPriceMap(inventory);
  const aggregation = new Map();
  const missingRecipeIds = new Set();
  const missingIngredientIds = new Set();

  sourceLines
    .filter((line) => line.recipe_id && line.planned_covers > 0)
    .forEach((line) => {
      const recipe = recipeMap.get(String(line.recipe_id));
      if (!recipe) {
        missingRecipeIds.add(line.recipe_id);
        return;
      }

      const recipeServings = Math.max(1, toNumber(recipe.servings ?? recipe.batch_yield, 1));
      const multiplier = line.planned_covers / recipeServings;
      const expanded = expandRecipeIngredients(
        recipe,
        recipes,
        ingredients,
        { multiplier, aggregate: true }
      ).ingredients || [];

      expanded.forEach((recipeIngredient) => {
        const ingredientId = normalizeText(recipeIngredient?.ingredient_id);
        if (!ingredientId) return;
        const ingredient = ingredientMap.get(ingredientId);
        if (!ingredient) {
          missingIngredientIds.add(ingredientId);
          return;
        }

        const purchaseUnit = getIngredientUnit(ingredient, recipeIngredient);
        const yieldOutput = calculateYieldOutputQuantity(recipeIngredient.quantity, ingredient);
        const requestedQuantity = convertIngredientQuantity(
          toNumber(recipeIngredient.quantity, 0),
          recipeIngredient.unit || ingredient.unit || ingredient.base_unit,
          purchaseUnit,
          ingredient
        );
        const unitPrice = inventoryPriceMap.get(`${line.warehouse_id}|${ingredientId}`)
          || toNumber(ingredient.cost_per_unit, 0)
          || toNumber(ingredient.average_unit_cost, 0)
          || toNumber(ingredient.last_unit_cost, 0);
        const key = `${line.warehouse_id || ''}|${ingredientId}|${purchaseUnit}`;
        const existing = aggregation.get(key) || {
          line_id: randomId('mprl'),
          ingredient_id: ingredientId,
          item_code: getItemCode(ingredient, getItemCode(recipeIngredient, null)),
          item_name: ingredient.name || recipeIngredient.ingredient_name || 'Unnamed ingredient',
          warehouse_id: line.warehouse_id || null,
          delivery_date: line.plan_date,
          requested_quantity: 0,
          unit: purchaseUnit,
          estimated_unit_price: unitPrice,
          estimated_line_amount: 0,
          source_line_ids: new Set(),
          source_menu_descriptions: new Set(),
          yield_multiplier: yieldOutput.yield_multiplier,
          yield_percent: yieldOutput.yield_percent
        };
        existing.delivery_date = existing.delivery_date && existing.delivery_date < line.plan_date
          ? existing.delivery_date
          : line.plan_date;
        existing.requested_quantity += requestedQuantity;
        existing.estimated_unit_price = unitPrice || existing.estimated_unit_price || 0;
        existing.estimated_line_amount = existing.requested_quantity * existing.estimated_unit_price;
        existing.source_line_ids.add(line.source_line_id);
        existing.source_menu_descriptions.add(`${line.plan_date} ${line.meal_period} ${line.menu_category}/${line.menu_type}`);
        aggregation.set(key, existing);
      });
    });

  return {
    lines: [...aggregation.values()]
      .map((line) => ({
        ...line,
        requested_quantity: round(line.requested_quantity, 4),
        estimated_unit_price: round(line.estimated_unit_price, 4),
        estimated_line_amount: round(line.estimated_line_amount, 2),
        source_line_ids: [...line.source_line_ids],
        source_menu_descriptions: [...line.source_menu_descriptions].slice(0, 5)
      }))
      .filter((line) => line.requested_quantity > 0)
      .sort((left, right) => String(left.item_name).localeCompare(String(right.item_name))),
    missing_recipe_ids: [...missingRecipeIds],
    missing_ingredient_ids: [...missingIngredientIds]
  };
}

function buildRequestNumber({ monthKey, selectedSiteName }) {
  const siteToken = normalizeText(selectedSiteName || 'SITE')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 10)
    .toUpperCase() || 'SITE';
  return `PR-${monthKey.replace('-', '')}-${siteToken}-${Date.now().toString().slice(-5)}`;
}

function buildD365Rows(request = {}, lines = []) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    site_id: request.selected_site_id || request.site_id || '',
    site_name: request.selected_site_name || request.site_name || '',
    project_id: request.project_id || '',
    project_name: request.project_name || '',
    warehouse_id: line.warehouse_id || request.primary_warehouse_id || request.warehouse_id || '',
    warehouse_name: request.primary_warehouse_name || request.warehouse_name || '',
    request_month: request.month_key || '',
    inclusions: request.inclusions || '',
    item_id: line.item_code || line.ingredient_id || '',
    item_name: line.item_name || '',
    purchase_unit: line.unit || '',
    quantity_ordered: line.requested_quantity || 0,
    delivery_date: line.delivery_date || request.start_date || '',
    estimated_unit_price: line.estimated_unit_price || 0,
    estimated_line_amount: line.estimated_line_amount || 0
  }));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(rows = []) {
  return [
    D365_EXPORT_HEADERS.join(','),
    ...rows.map((row) => D365_EXPORT_HEADERS.map((header) => csvEscape(row[header])).join(','))
  ].join('\n');
}

async function buildMonthlyPurchaseRequestPreview(user, payload = {}) {
  const scope = await getLocationScope(user);
  const sites = filterRecordsByLocation(user, 'Site', await listDocuments('Site', { limit: 5000, sort: 'name' }), scope);
  const siteContext = resolveRequestSiteContext({ sites, siteId: payload.site_id });
  if (!siteContext.warehouse_ids.length) {
    const error = new Error('The selected site does not contain an active Store for purchase demand.');
    error.status = 400;
    throw error;
  }

  const range = monthRange(payload.month);
  const inclusions = normalizeText(payload.inclusions || 'all_meals') || 'all_meals';
  const [menuPlans, recipes, ingredients, inventory] = await Promise.all([
    listDocuments('MenuPlan', { limit: 10000, sort: 'plan_date' }),
    listDocuments('Recipe', { limit: 10000 }),
    listDocuments('Ingredient', { limit: 10000 }),
    listDocuments('Inventory', { limit: 10000 })
  ]);

  const warehouseSet = new Set(siteContext.warehouse_ids);
  const scopedPlans = filterRecordsByLocation(user, 'MenuPlan', menuPlans, scope)
    .filter((plan) => warehouseSet.has(String(plan.site_id || plan.warehouse_id || '')))
    .filter((plan) => {
      const planDate = normalizeDateOnly(plan.plan_date);
      return planDate >= range.start_date && planDate <= range.end_date;
    })
    .filter((plan) => includePlanForScope(plan, inclusions));

  const sourceLines = buildSourceMenuLines(scopedPlans);
  const warnings = buildWarnings(sourceLines);
  const { lines, missing_recipe_ids, missing_ingredient_ids } = buildPurchaseLines({
    sourceLines,
    recipes,
    ingredients,
    inventory
  });

  return {
    ...siteContext,
    ...range,
    inclusions,
    request_number_preview: buildRequestNumber({
      monthKey: range.month_key,
      selectedSiteName: siteContext.selected_site_name
    }),
    menu_plan_count: scopedPlans.length,
    source_line_count: sourceLines.length,
    warning_count: warnings.length,
    line_count: lines.length,
    total_estimated_cost: round(lines.reduce((sum, line) => sum + toNumber(line.estimated_line_amount, 0), 0), 2),
    warnings,
    source_lines: sourceLines,
    lines,
    d365_rows: buildD365Rows({ ...siteContext, ...range, inclusions }, lines),
    missing_recipe_ids,
    missing_ingredient_ids
  };
}

async function getMonthlyPurchaseRequestById(id, executor = pool) {
  const headerResult = await executor.query(
    'SELECT * FROM monthly_purchase_requests WHERE request_id = $1 LIMIT 1',
    [id]
  );
  if (!headerResult.rowCount) return null;
  const request = headerResult.rows[0];
  const [lines, sourceLines, warnings, actions, exportsResult] = await Promise.all([
    executor.query('SELECT * FROM monthly_purchase_request_lines WHERE request_id = $1 ORDER BY item_name ASC', [id]),
    executor.query('SELECT * FROM monthly_purchase_request_source_lines WHERE request_id = $1 ORDER BY plan_date ASC, meal_period ASC, menu_category ASC, recipe_name ASC', [id]),
    executor.query('SELECT * FROM monthly_purchase_request_warnings WHERE request_id = $1 ORDER BY severity DESC, plan_date ASC', [id]),
    executor.query('SELECT * FROM monthly_purchase_request_workflow_actions WHERE request_id = $1 ORDER BY created_at ASC', [id]),
    executor.query('SELECT * FROM monthly_purchase_request_exports WHERE request_id = $1 ORDER BY exported_at DESC', [id])
  ]);
  return {
    ...request,
    lines: lines.rows,
    source_lines: sourceLines.rows,
    warnings: warnings.rows,
    workflow_actions: actions.rows,
    exports: exportsResult.rows,
    d365_rows: buildD365Rows(request, lines.rows)
  };
}

async function listMonthlyPurchaseRequests(user, filters = {}) {
  const scope = await getLocationScope(user);
  const params = [];
  const clauses = ['status <> $1'];
  params.push('cancelled');
  if (filters.month) {
    params.push(monthRange(filters.month).month_key);
    clauses.push(`month_key = $${params.length}`);
  }
  if (filters.site_id) {
    params.push(String(filters.site_id));
    clauses.push(`(selected_site_id = $${params.length} OR $${params.length} = ANY(warehouse_ids))`);
  }
  const result = await pool.query(
    `SELECT *
       FROM monthly_purchase_requests
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 100`,
    params
  );
  const rows = scope.unrestricted ? result.rows : result.rows.filter((row) => {
    const siteIds = [
      row.selected_site_id,
      row.area_id,
      row.project_id,
      row.primary_warehouse_id,
      ...(Array.isArray(row.warehouse_ids) ? row.warehouse_ids : [])
    ].filter(Boolean).map(String);
    return siteIds.some((siteId) => scope.accessibleSiteIds.has(siteId) || scope.accessibleTreeIds.has(siteId));
  });
  return rows;
}

async function createMonthlyPurchaseRequest(user, payload = {}) {
  const preview = await buildMonthlyPurchaseRequestPreview(user, payload);
  if (!preview.lines.length) {
    const error = new Error('No purchase demand was found for the selected site and month.');
    error.status = 400;
    throw error;
  }
  if (preview.warning_count > 0 && !normalizeText(payload.warning_note)) {
    const error = new Error('Add a chef note explaining how the low/zero pax warnings were corrected, excluded, or accepted.');
    error.status = 400;
    throw error;
  }

  return withTransaction(async (client) => {
    const requestId = randomId('mpr');
    const requestNumber = buildRequestNumber({
      monthKey: preview.month_key,
      selectedSiteName: preview.selected_site_name
    });
    await client.query(
      `INSERT INTO monthly_purchase_requests (
        request_id, request_number, selected_site_id, selected_site_name, area_id, area_name,
        project_id, project_name, primary_warehouse_id, primary_warehouse_name, warehouse_ids,
        month_key, start_date, end_date, inclusions, status, current_step,
        prepared_by, prepared_by_name, warning_count, line_count, total_estimated_cost,
        chef_warning_note, d365_status, payload, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,'placeholder',$24::jsonb,NOW(),NOW()
      )`,
      [
        requestId,
        requestNumber,
        preview.selected_site_id,
        preview.selected_site_name,
        preview.area_id,
        preview.area_name,
        preview.project_id,
        preview.project_name,
        preview.primary_warehouse_id,
        preview.primary_warehouse_name,
        preview.warehouse_ids,
        preview.month_key,
        preview.start_date,
        preview.end_date,
        preview.inclusions,
        MONTHLY_PR_STATUS.PENDING_PROJECT_MANAGER,
        MONTHLY_PR_STEP.PROJECT_MANAGER,
        user.email,
        user.full_name || user.email,
        preview.warning_count,
        preview.line_count,
        preview.total_estimated_cost,
        normalizeText(payload.warning_note) || null,
        JSON.stringify({
          missing_recipe_ids: preview.missing_recipe_ids,
          missing_ingredient_ids: preview.missing_ingredient_ids
        })
      ]
    );

    for (const line of preview.lines) {
      await client.query(
        `INSERT INTO monthly_purchase_request_lines (
          line_id, request_id, ingredient_id, item_code, item_name, warehouse_id,
          project_id, delivery_date, requested_quantity, unit, estimated_unit_price,
          estimated_line_amount, source_line_count, payload, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,NOW(),NOW())`,
        [
          line.line_id,
          requestId,
          line.ingredient_id,
          line.item_code || null,
          line.item_name,
          line.warehouse_id,
          preview.project_id,
          line.delivery_date || preview.start_date,
          line.requested_quantity,
          line.unit,
          line.estimated_unit_price,
          line.estimated_line_amount,
          line.source_line_ids.length,
          JSON.stringify(line)
        ]
      );
    }

    for (const sourceLine of preview.source_lines) {
      await client.query(
        `INSERT INTO monthly_purchase_request_source_lines (
          source_id, request_id, menu_plan_id, menu_plan_line_id, warehouse_id,
          plan_date, meal_period, menu_type, menu_category, recipe_id, recipe_name,
          planned_covers, warning_codes, payload, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,NOW())`,
        [
          randomId('mprs'),
          requestId,
          sourceLine.menu_plan_id,
          sourceLine.menu_plan_line_id,
          sourceLine.warehouse_id,
          sourceLine.plan_date,
          sourceLine.meal_period,
          sourceLine.menu_type,
          sourceLine.menu_category,
          sourceLine.recipe_id,
          sourceLine.recipe_name,
          sourceLine.planned_covers,
          JSON.stringify(sourceLine.warning_codes || []),
          JSON.stringify(sourceLine)
        ]
      );
    }

    for (const warning of preview.warnings) {
      await client.query(
        `INSERT INTO monthly_purchase_request_warnings (
          warning_id, request_id, warning_type, severity, menu_plan_id, menu_plan_line_id,
          plan_date, meal_period, menu_type, menu_category, recipe_id, recipe_name,
          planned_covers, message, resolution_status, resolution_note, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'accepted_with_note',$15,NOW(),NOW())`,
        [
          warning.warning_id,
          requestId,
          warning.warning_type,
          warning.severity,
          warning.menu_plan_id,
          warning.menu_plan_line_id,
          warning.plan_date,
          warning.meal_period,
          warning.menu_type,
          warning.menu_category,
          warning.recipe_id,
          warning.recipe_name,
          warning.planned_covers,
          warning.message,
          normalizeText(payload.warning_note) || null
        ]
      );
    }

    await recordWorkflowAction(client, requestId, user, 'submit_to_project_manager', 'chef', normalizeText(payload.warning_note) || null);
    return getMonthlyPurchaseRequestById(requestId, client);
  });
}

async function recordWorkflowAction(executor, requestId, user, action, stage, notes = null) {
  await executor.query(
    `INSERT INTO monthly_purchase_request_workflow_actions (
      action_id, request_id, action, stage, actor_email, actor_name, notes, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [
      randomId('mpra'),
      requestId,
      action,
      stage,
      user.email,
      user.full_name || user.email,
      normalizeText(notes) || null
    ]
  );
}

function requireRoleForMonthlyPR(user, allowedRoles = [], fallbackPermissions = []) {
  const role = normalizeLower(user?.role);
  const permissions = new Set(Array.isArray(user?.role_permissions) ? user.role_permissions : []);
  if (role === 'admin' || allowedRoles.includes(role)) return;
  if (fallbackPermissions.some((permission) => permissions.has(permission))) return;
  const error = new Error('You do not have permission for this purchase request action.');
  error.status = 403;
  throw error;
}

async function updateMonthlyPurchaseRequestWorkflow(user, requestId, payload = {}) {
  const action = normalizeLower(payload.action);
  const notes = normalizeText(payload.notes);
  return withTransaction(async (client) => {
    const existing = await getMonthlyPurchaseRequestById(requestId, client);
    if (!existing) {
      const error = new Error('Purchase request not found.');
      error.status = 404;
      throw error;
    }

    let nextStatus = existing.status;
    let nextStep = existing.current_step;
    let workflowAction = action;
    let stage = existing.current_step;
    const patch = [];
    const values = [requestId];
    const set = (sql, value) => {
      values.push(value);
      patch.push(`${sql} = $${values.length}`);
    };

    if (action === 'project_approve') {
      requireRoleForMonthlyPR(user, ['project_manager', 'manager']);
      if (existing.status !== MONTHLY_PR_STATUS.PENDING_PROJECT_MANAGER) {
        const error = new Error('Only PRs pending Project Manager review can be project-approved.');
        error.status = 409;
        throw error;
      }
      nextStatus = MONTHLY_PR_STATUS.PENDING_AREA_MANAGER;
      nextStep = MONTHLY_PR_STEP.AREA_MANAGER;
      stage = 'project_manager';
      set('project_manager_approved_by', user.email);
      set('project_manager_approved_by_name', user.full_name || user.email);
      patch.push('project_manager_approved_at = NOW()');
    } else if (action === 'area_approve') {
      requireRoleForMonthlyPR(user, ['area_manager', 'manager']);
      if (existing.status !== MONTHLY_PR_STATUS.PENDING_AREA_MANAGER) {
        const error = new Error('Only PRs pending Area Manager review can receive final business approval.');
        error.status = 409;
        throw error;
      }
      nextStatus = MONTHLY_PR_STATUS.READY_FOR_STOREKEEPER;
      nextStep = MONTHLY_PR_STEP.STOREKEEPER_EXPORT;
      stage = 'area_manager';
      set('area_manager_approved_by', user.email);
      set('area_manager_approved_by_name', user.full_name || user.email);
      patch.push('area_manager_approved_at = NOW()');
    } else if (action === 'return_to_chef') {
      requireRoleForMonthlyPR(user, ['project_manager', 'area_manager', 'manager']);
      nextStatus = MONTHLY_PR_STATUS.RETURNED_TO_CHEF;
      nextStep = MONTHLY_PR_STEP.CHEF_REVISION;
      stage = existing.current_step || 'business_review';
      workflowAction = 'return_to_chef';
      set('return_reason', notes || 'Returned for correction');
    } else if (action === 'mark_exported') {
      requireRoleForMonthlyPR(user, ['storekeeper', 'manager']);
      if (existing.status !== MONTHLY_PR_STATUS.READY_FOR_STOREKEEPER) {
        const error = new Error('Only Area Manager approved PRs can be exported by the Store Keeper.');
        error.status = 409;
        throw error;
      }
      nextStatus = MONTHLY_PR_STATUS.EXPORTED;
      nextStep = MONTHLY_PR_STEP.COMPLETE;
      stage = 'storekeeper_export';
      set('exported_by', user.email);
      set('exported_by_name', user.full_name || user.email);
      patch.push('exported_at = NOW()');
      set('d365_status', 'manual_exported');
      await client.query(
        `INSERT INTO monthly_purchase_request_exports (
          export_id, request_id, export_format, exported_by, exported_by_name,
          d365_status, notes, exported_at
        ) VALUES ($1,$2,'csv',$3,$4,'manual_exported',$5,NOW())`,
        [
          randomId('mpre'),
          requestId,
          user.email,
          user.full_name || user.email,
          notes || 'Marked exported for manual D365 upload.'
        ]
      );
    } else {
      const error = new Error('Unsupported purchase request workflow action.');
      error.status = 400;
      throw error;
    }

    set('status', nextStatus);
    set('current_step', nextStep);
    patch.push('updated_at = NOW()');
    await client.query(
      `UPDATE monthly_purchase_requests SET ${patch.join(', ')} WHERE request_id = $1`,
      values
    );
    await recordWorkflowAction(client, requestId, user, workflowAction, stage, notes || null);
    return getMonthlyPurchaseRequestById(requestId, client);
  });
}

async function getMonthlyPurchaseRequestD365Export(user, requestId) {
  const request = await getMonthlyPurchaseRequestById(requestId);
  if (!request) {
    const error = new Error('Purchase request not found.');
    error.status = 404;
    throw error;
  }
  requireRoleForMonthlyPR(user, ['storekeeper', 'manager']);
  const rows = buildD365Rows(request, request.lines || []);
  return {
    request_id: request.request_id,
    request_number: request.request_number,
    d365_status: request.d365_status || 'placeholder',
    message: 'Live D365 integration is not active yet. Download this file and upload it manually in D365.',
    headers: D365_EXPORT_HEADERS,
    rows,
    csv: buildCsv(rows)
  };
}

export {
  D365_EXPORT_HEADERS,
  MONTHLY_PR_STATUS,
  buildMonthlyPurchaseRequestPreview,
  listMonthlyPurchaseRequests,
  createMonthlyPurchaseRequest,
  getMonthlyPurchaseRequestById,
  updateMonthlyPurchaseRequestWorkflow,
  getMonthlyPurchaseRequestD365Export
};
