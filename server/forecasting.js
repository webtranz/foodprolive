import { createAppLog, createDocument, findDocument, listDocuments, updateDocument } from './db.js';
import { getDailySalesSummary, getSalesProductionVariance } from './pos.js';

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(safeNumber(value) * factor) / factor;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function buildSiteMeta(sites = []) {
  const byId = new Map(sites.map((site) => [String(site.id), site]));
  return { byId };
}

function matchesLocation(siteId, locationId, siteMeta) {
  if (!locationId) return true;
  if (!siteId) return false;
  const normalizedSiteId = String(siteId);
  if (normalizedSiteId === String(locationId)) return true;

  let current = siteMeta.byId.get(normalizedSiteId);
  while (current?.parent_site_id) {
    if (String(current.parent_site_id) === String(locationId)) {
      return true;
    }
    current = siteMeta.byId.get(String(current.parent_site_id));
  }

  return false;
}

function matchesAllowedSites(siteId, allowedSiteIds) {
  if (!allowedSiteIds || allowedSiteIds.size === 0) return true;
  if (!siteId) return false;
  return allowedSiteIds.has(String(siteId));
}

function matchesDate(value, startDate, endDate) {
  if (!value) return false;
  if (startDate && value < startDate) return false;
  if (endDate && value > endDate) return false;
  return true;
}

function buildFutureDays(horizonDays) {
  const days = [];
  const today = new Date();
  for (let index = 1; index <= horizonDays; index += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

function deriveCategoryForItem(name = '', recipes = []) {
  const normalizedName = normalizeText(name).toLowerCase();
  const recipe = recipes.find((item) => normalizeText(item.name).toLowerCase() === normalizedName);
  return recipe?.category || 'uncategorized';
}

function summarizeRows(rows = []) {
  return rows.reduce((summary, row) => {
    summary.total_items += 1;
    summary.total_forecast_quantity += safeNumber(row.forecast_quantity);
    summary.total_recommended_production += safeNumber(row.recommended_production);
    summary.average_confidence = 0;
    summary.high_risk_items += row.risk_level === 'high' ? 1 : 0;
    return summary;
  }, {
    total_items: 0,
    total_forecast_quantity: 0,
    total_recommended_production: 0,
    average_confidence: 0,
    high_risk_items: 0
  });
}

async function buildForecastSummary({
  startDate,
  endDate,
  locationId,
  accessibleSiteIds = null,
  category = 'all',
  status = 'all',
  horizonDays = 7,
  safetyBufferPercent = 10
}) {
  const [sites, recipes, productions, menuPlans, mealPlans, waste, attendance, inventory] = await Promise.all([
    listDocuments('Site', { sort: 'name', limit: 5000 }),
    listDocuments('Recipe', { sort: 'name', limit: 2000 }),
    listDocuments('Production', { sort: '-production_date', limit: 2000 }),
    listDocuments('MenuPlan', { sort: '-plan_date', limit: 1000 }),
    listDocuments('CustomerMealPlan', { sort: '-plan_date', limit: 1000 }),
    listDocuments('FoodWaste', { sort: '-waste_date', limit: 2000 }),
    listDocuments('AttendanceRecord', { sort: '-created_date', limit: 3000 }),
    listDocuments('Inventory', { sort: 'name', limit: 3000 })
  ]);

  const siteMeta = buildSiteMeta(sites);
  const futureDays = buildFutureDays(horizonDays);
  const salesSummary = await getDailySalesSummary({ startDate, endDate, locationId: locationId || null });
  const varianceRows = await getSalesProductionVariance({ startDate, endDate, locationId: locationId || null });

  const filteredProductions = productions.filter((production) => {
      const recipe = recipes.find((item) => item.id === production.recipe_id);
      const rowCategory = production.menu_category || recipe?.category || 'uncategorized';
      if (!matchesDate(production.production_date, startDate, endDate)) return false;
      if (!matchesAllowedSites(production.site_id, accessibleSiteIds)) return false;
      if (!matchesLocation(production.site_id, locationId, siteMeta)) return false;
    if (category !== 'all' && rowCategory !== category) return false;
    if (status !== 'all' && (production.status || 'draft') !== status) return false;
    return true;
  });

  const filteredMenuPlans = menuPlans.filter((plan) => {
    if (!matchesAllowedSites(plan.site_id, accessibleSiteIds)) return false;
    if (!matchesLocation(plan.site_id, locationId, siteMeta)) return false;
    return true;
  });

  const filteredMealPlans = mealPlans.filter((plan) => {
    if (!matchesAllowedSites(plan.site_id, accessibleSiteIds)) return false;
    if (!matchesLocation(plan.site_id, locationId, siteMeta)) return false;
    return true;
  });

  const filteredWaste = waste.filter((entry) => {
    if (!matchesDate(entry.waste_date, startDate, endDate)) return false;
    if (!matchesAllowedSites(entry.site_id, accessibleSiteIds)) return false;
    if (!matchesLocation(entry.site_id, locationId, siteMeta)) return false;
    return true;
  });

  const filteredAttendance = attendance.filter((record) => {
    const recordDate = String(record.created_date || record.check_in_time || '').slice(0, 10);
    if (!matchesDate(recordDate, startDate, endDate)) return false;
    if (!matchesAllowedSites(record.site_id, accessibleSiteIds)) return false;
    if (!matchesLocation(record.site_id, locationId, siteMeta)) return false;
    return true;
  });

  const itemMap = new Map();
  const ensureRow = (locationName, itemName, siteId, explicitCategory) => {
    const key = `${siteId || locationName}::${itemName}`;
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        site_id: siteId || '',
        location: locationName || 'Unknown',
        item: itemName,
        category: explicitCategory || deriveCategoryForItem(itemName, recipes),
        sales_history: [],
        production_history: [],
        menu_plan_history: [],
        meal_plan_history: [],
        waste_history: [],
        attendance_history: []
      });
    }
    return itemMap.get(key);
  };

  salesSummary.forEach((row) => {
    if (!matchesLocation(row.site_id, locationId, siteMeta) && !matchesLocation(row.location_id, locationId, siteMeta)) {
      return;
    }
    if (!matchesAllowedSites(row.site_id || row.location_id, accessibleSiteIds)) {
      return;
    }
    const item = ensureRow(row.location_name || row.site_name, row.pos_item_name || row.item_name, row.site_id || row.location_id, deriveCategoryForItem(row.pos_item_name || row.item_name, recipes));
    item.sales_history.push(safeNumber(row.total_quantity));
  });

  varianceRows.forEach((row) => {
    if (!matchesAllowedSites(row.site_id, accessibleSiteIds)) return;
    if (!matchesLocation(row.site_id, locationId, siteMeta)) return;
    const item = ensureRow(row.site_name, row.item_name, row.site_id, deriveCategoryForItem(row.item_name, recipes));
    item.production_history.push(safeNumber(row.production_quantity));
  });

  filteredProductions.forEach((production) => {
    const recipe = recipes.find((item) => item.id === production.recipe_id);
    const item = ensureRow(production.site_name, production.recipe_name || recipe?.name || 'Unknown', production.site_id, production.menu_category || recipe?.category);
    item.production_history.push(safeNumber(production.actual_servings || production.target_servings));
  });

  filteredMenuPlans.forEach((plan) => {
    (plan.meals || []).forEach((meal) => {
      const rowCategory = deriveCategoryForItem(meal.recipe_name, recipes);
      if (category !== 'all' && rowCategory !== category) return;
      const item = ensureRow(plan.site_name, meal.recipe_name || 'Unknown', plan.site_id, rowCategory);
      item.menu_plan_history.push(safeNumber(meal.expected_servings));
    });
  });

  filteredMealPlans.forEach((plan) => {
    (plan.meals || []).forEach((meal) => {
      const rowCategory = deriveCategoryForItem(meal.recipe_name, recipes);
      if (category !== 'all' && rowCategory !== category) return;
      const item = ensureRow(plan.site_name, meal.recipe_name || 'Unknown', plan.site_id, rowCategory);
      item.meal_plan_history.push(safeNumber(meal.portions));
    });
  });

  filteredWaste.forEach((entry) => {
    const itemName = entry.recipe_name || entry.ingredient_name || 'Waste Item';
    const row = ensureRow(entry.site_name, itemName, entry.site_id, entry.category || deriveCategoryForItem(itemName, recipes));
    row.waste_history.push(safeNumber(entry.quantity));
  });

  const attendanceBySite = filteredAttendance.reduce((map, record) => {
    const key = String(record.site_id || 'unknown');
    const current = map.get(key) || [];
    current.push(1);
    map.set(key, current);
    return map;
  }, new Map());

  itemMap.forEach((row) => {
    row.attendance_history = attendanceBySite.get(String(row.site_id || 'unknown')) || [];
  });

  const rows = Array.from(itemMap.values())
    .filter((row) => category === 'all' || row.category === category)
    .map((row) => {
      const avgSales = average(row.sales_history);
      const avgProduction = average(row.production_history);
      const avgMenuDemand = average(row.menu_plan_history);
      const avgMealPlanDemand = average(row.meal_plan_history);
      const avgWaste = average(row.waste_history);
      const avgAttendance = average(row.attendance_history);
      const recentSales = average(row.sales_history.slice(0, 7));
      const priorSales = average(row.sales_history.slice(7, 14));
      const trendFactor = priorSales > 0 ? recentSales / priorSales : 1;
      const attendanceFactor = avgAttendance > 0 ? 1 + Math.min(0.15, avgAttendance / 1000) : 1;
      const wasteFactor = avgWaste > 0 ? Math.max(0.9, 1 - (avgWaste / Math.max(1, avgProduction || avgSales || 1)) * 0.1) : 1;

      const baseDailyDemand = (
        (avgSales * 0.45) +
        (avgProduction * 0.2) +
        (avgMenuDemand * 0.25) +
        (avgMealPlanDemand * 0.1)
      ) || avgProduction || avgSales || avgMenuDemand || avgMealPlanDemand;

      const forecastDailyDemand = baseDailyDemand * trendFactor * attendanceFactor * wasteFactor;
      const forecastQuantity = Math.max(0, forecastDailyDemand * horizonDays);
      const recommendedProduction = forecastQuantity * (1 + (safeNumber(safetyBufferPercent) / 100));
      const confidence = Math.min(
        95,
        35 +
        (Math.min(row.sales_history.length, 14) * 2) +
        (row.menu_plan_history.length > 0 ? 12 : 0) +
        (row.meal_plan_history.length > 0 ? 10 : 0) +
        (row.production_history.length > 0 ? 10 : 0)
      );

      const wasteRate = avgProduction > 0 ? (avgWaste / avgProduction) * 100 : 0;
      const riskLevel = confidence < 55 || wasteRate > 12 ? 'high' : (confidence < 72 || wasteRate > 6 ? 'medium' : 'low');

      return {
        site_id: row.site_id,
        location: row.location,
        item: row.item,
        category: row.category,
        avg_daily_sales: round(avgSales),
        avg_daily_production: round(avgProduction),
        avg_daily_menu_demand: round(avgMenuDemand),
        avg_daily_meal_plan_demand: round(avgMealPlanDemand),
        trend_factor: round(trendFactor, 3),
        waste_rate_percent: round(wasteRate),
        confidence_score: round(confidence),
        forecast_quantity: round(forecastQuantity),
        recommended_production: round(recommendedProduction),
        risk_level: riskLevel,
        future_dates: futureDays
      };
    })
    .sort((left, right) => right.forecast_quantity - left.forecast_quantity);

  const summary = summarizeRows(rows);
  summary.average_confidence = rows.length ? round(average(rows.map((row) => row.confidence_score))) : 0;
  summary.location_count = new Set(rows.map((row) => row.location)).size;
  summary.horizon_days = horizonDays;

  const chart = rows.slice(0, 12).map((row) => ({
    location: row.location,
    item: row.item,
    forecast_quantity: row.forecast_quantity,
    recommended_production: row.recommended_production,
    confidence_score: row.confidence_score
  }));

  const inventoryCoverage = inventory
    .filter((item) => matchesLocation(item.site_id, locationId, siteMeta))
    .filter((item) => matchesAllowedSites(item.site_id, accessibleSiteIds))
    .map((item) => ({
      site_id: item.site_id,
      location: item.site_name || siteMeta.byId.get(String(item.site_id))?.name || 'Unknown',
      ingredient: item.ingredient_name,
      quantity: round(item.quantity),
      status: item.status,
      min_stock_level: round(item.min_stock_level),
      max_stock_level: round(item.max_stock_level)
    }));

  return { rows, summary, chart, inventoryCoverage, futureDates: futureDays };
}

async function runForecastScenario({ scenarioId, user, locationScope }) {
  const scenario = await findDocument('ForecastScenario', scenarioId);
  if (!scenario) {
    const error = new Error('Forecast scenario not found');
    error.status = 404;
    throw error;
  }

  const locationId = scenario.location_id && locationScope?.accessibleSiteIds?.has(String(scenario.location_id))
    ? scenario.location_id
    : null;
  const scopedLocationId = scenario.site_id && locationScope?.accessibleSiteIds?.has(String(scenario.site_id))
    ? scenario.site_id
    : locationId;

  const forecast = await buildForecastSummary({
    startDate: scenario.start_date,
    endDate: scenario.end_date,
    locationId: scopedLocationId,
    accessibleSiteIds: locationScope?.unrestricted ? null : locationScope?.accessibleSiteIds,
    category: scenario.category || 'all',
    status: scenario.status_filter || 'all',
    horizonDays: safeNumber(scenario.forecast_horizon_days, 7),
    safetyBufferPercent: safeNumber(scenario.safety_buffer_percent, 10)
  });

  const snapshot = await createDocument('ForecastSnapshot', {
    scenario_id: scenario.id,
    scenario_name: scenario.name,
    site_id: scopedLocationId,
    site_name: scenario.site_name || scenario.location_name || null,
    forecast_rows: forecast.rows,
    summary: forecast.summary,
    chart: forecast.chart,
    inventory_coverage: forecast.inventoryCoverage,
    generated_by_id: user.id,
    generated_by_email: user.email,
    generated_at: new Date().toISOString(),
    start_date: scenario.start_date,
    end_date: scenario.end_date,
    forecast_horizon_days: scenario.forecast_horizon_days,
    status: 'ready'
  });

  await updateDocument('ForecastScenario', scenario.id, {
    last_run_date: new Date().toISOString(),
    latest_snapshot_id: snapshot.id,
    status: 'active'
  });

  await createAppLog({
    page_name: 'Forecasting',
    user_id: user.id,
    user_email: user.email,
    payload: {
      action: 'run_forecast_scenario',
      scenario_id: scenario.id,
      snapshot_id: snapshot.id,
      location_id: scopedLocationId,
      forecast_rows: forecast.rows.length
    }
  });

  return { scenario: { ...scenario, latest_snapshot_id: snapshot.id }, snapshot, ...forecast };
}

export {
  buildForecastSummary,
  runForecastScenario
};
