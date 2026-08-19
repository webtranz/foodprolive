import { DASHBOARD_VIEWS } from './managementDashboardRoles.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from './siteHierarchy.js';

const MEAL_PERIODS = ['breakfast', 'lunch', 'dinner'];
const CLOSED_PRODUCTION_STATUSES = new Set(['completed', 'complete']);
const ACTIVE_PRODUCTION_STATUSES = new Set(['completed', 'complete', 'in_progress', 'started']);
const PENDING_APPROVAL_STATUSES = new Set([
  'pending',
  'pending_approval',
  'awaiting_approval',
  'submitted',
  'under_review'
]);
const CLOSED_ORDER_STATUSES = new Set(['received', 'completed', 'cancelled', 'canceled', 'closed']);
const COMPLETED_ORDER_STATUSES = new Set(['received', 'completed', 'closed']);
const HIGH_WASTE_COST_THRESHOLD = 500;

const LOCATION_SERIES_COLORS = ['#16a34a', '#2563eb', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2'];

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round((safeNumber(value) + Number.EPSILON) * factor) / factor;
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeMealType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return MEAL_PERIODS.includes(normalized) ? normalized : 'other';
}

function dateOnly(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function shiftDate(value, days) {
  const normalized = dateOnly(value);
  if (!normalized) return '';
  const [year, month, day] = normalized.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function rangeDates(endDate, length = 7) {
  return Array.from({ length }, (_, index) => shiftDate(endDate, index - (length - 1)));
}

function inclusiveDays(startDate, endDate) {
  const start = dateOnly(startDate);
  const end = dateOnly(endDate);
  if (!start || !end || end < start) return 1;
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return Math.max(1, Math.round((endTime - startTime) / 86400000) + 1);
}

function recordDate(record, fields) {
  for (const field of fields) {
    const value = dateOnly(record?.[field]);
    if (value) return value;
  }
  return '';
}

function isOnDate(record, targetDate, fields) {
  return recordDate(record, fields) === targetDate;
}

function isPending(value) {
  return PENDING_APPROVAL_STATUSES.has(normalizeStatus(value));
}

function uniqueById(records = []) {
  const seen = new Set();
  return records.filter((record) => {
    const key = String(record?.id || JSON.stringify(record));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstFiniteValue(values = []) {
  return values.find((value) => (
    value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value))
  ));
}

function productionCost(production = {}) {
  const explicit = firstFiniteValue([
    production.production_cost_total,
    production.ingredient_cost_total,
    production.actual_cost,
    production.total_cost,
    production.estimated_batch_cost,
    production.estimated_cost
  ]);

  if (explicit !== undefined) return Math.max(0, safeNumber(explicit));

  return (Array.isArray(production.ingredients_used) ? production.ingredients_used : [])
    .reduce((sum, line) => {
      const lineCost = firstFiniteValue([line.actual_cost, line.line_cost, line.estimated_cost]);
      if (lineCost !== undefined) return sum + Math.max(0, safeNumber(lineCost));
      const quantity = safeNumber(
        line.actual_quantity
        ?? line.planned_quantity
        ?? line.yield_adjusted_quantity
        ?? line.adjusted_quantity
        ?? line.required_quantity
        ?? line.quantity
      );
      const unitCost = safeNumber(line.actual_unit_cost ?? line.unit_cost ?? line.cost_per_unit);
      return sum + Math.max(0, quantity * unitCost);
    }, 0);
}

function producedServings(production = {}) {
  const status = normalizeStatus(production.status);
  const actualValue = firstFiniteValue([production.actual_servings]);
  const actual = actualValue === undefined ? Number.NaN : safeNumber(actualValue, Number.NaN);
  if (Number.isFinite(actual)) return Math.max(0, actual);
  if (CLOSED_PRODUCTION_STATUSES.has(status)) return Math.max(0, safeNumber(production.target_servings));
  return 0;
}

function plannedServings(production = {}) {
  return Math.max(0, safeNumber(production.target_servings ?? production.planned_servings));
}

function productionCountsAsSpend(production = {}) {
  const actualValue = firstFiniteValue([production.actual_servings]);
  return ACTIVE_PRODUCTION_STATUSES.has(normalizeStatus(production.status))
    || (actualValue !== undefined && safeNumber(actualValue, Number.NaN) >= 0);
}

function budgetCoversDate(budget = {}, targetDate) {
  const status = normalizeStatus(budget.status || 'active');
  if (['inactive', 'cancelled', 'canceled', 'closed'].includes(status)) return false;
  const start = dateOnly(budget.start_date || budget.budget_date || targetDate);
  const end = dateOnly(budget.end_date || budget.budget_date || start);
  return Boolean(start && end && targetDate >= start && targetDate <= end);
}

function dailyBudgetAmount(budget = {}, targetDate) {
  if (!budgetCoversDate(budget, targetDate)) return 0;
  const amount = Math.max(0, safeNumber(budget.budget_amount ?? budget.amount));
  const scopeType = normalizeStatus(budget.scope_type);
  if (scopeType.includes('daily') || budget.budget_date) return amount;
  return amount / inclusiveDays(budget.start_date || targetDate, budget.end_date || targetDate);
}

function flattenMenuEntries(plan = {}) {
  const meals = Array.isArray(plan.meals) ? plan.meals : [];
  const entries = [];
  meals.forEach((meal) => {
    const nested = Array.isArray(meal?.items)
      ? meal.items
      : Array.isArray(meal?.recipes)
        ? meal.recipes
        : null;
    if (nested) {
      nested.forEach((item) => entries.push({ ...item, meal_type: item.meal_type || meal.meal_type }));
    } else {
      entries.push(meal);
    }
  });
  return entries;
}

function menuEntryServings(entry = {}) {
  return Math.max(0, safeNumber(
    entry.expected_servings
    ?? entry.servings
    ?? entry.portions
    ?? entry.required_portions
  ));
}

function menuEntryIsComplete(entry = {}) {
  return Boolean(entry.recipe_id || entry.recipe_name || entry.name) && menuEntryServings(entry) > 0;
}

function createSiteHelpers(sites = []) {
  const byId = new Map(sites.map((site) => [String(site.id), site]));
  const children = new Map();
  sites.forEach((site) => {
    const parentId = site.parent_site_id ? String(site.parent_site_id) : null;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(site);
  });

  const descendantIds = (rootId) => {
    if (!rootId) return new Set(sites.map((site) => String(site.id)));
    const result = new Set();
    const queue = [String(rootId)];
    while (queue.length) {
      const current = queue.shift();
      if (!current || result.has(current)) continue;
      result.add(current);
      (children.get(current) || []).forEach((site) => queue.push(String(site.id)));
    }
    return result;
  };

  const operationalAnchor = (siteId) => {
    let current = byId.get(String(siteId || '')) || null;
    const visited = new Set();
    while (current && !visited.has(String(current.id))) {
      visited.add(String(current.id));
      if (normalizeSiteType(current.type) === SITE_HIERARCHY_TYPES.PROJECT) return current;
      current = current.parent_site_id ? byId.get(String(current.parent_site_id)) || null : null;
    }
    return null;
  };

  return { byId, children, descendantIds, operationalAnchor };
}

function siteIdForRecord(record = {}, shiftMap = new Map(), productionMap = new Map()) {
  if (record.site_id) return String(record.site_id);
  if (record.location_id) return String(record.location_id);
  if (record.project_id) return String(record.project_id);
  if (record.shift_id && shiftMap.get(String(record.shift_id))?.site_id) {
    return String(shiftMap.get(String(record.shift_id)).site_id);
  }
  if (record.production_id && productionMap.get(String(record.production_id))?.site_id) {
    return String(productionMap.get(String(record.production_id)).site_id);
  }
  return '';
}

function filterBySiteIds(records = [], siteIds, resolver = (record) => record?.site_id) {
  if (!siteIds) return records;
  return records.filter((record) => {
    const siteId = resolver(record);
    return Boolean(siteId) && siteIds.has(String(siteId));
  });
}

function deriveInventoryStatus(item = {}) {
  const quantity = safeNumber(item.quantity ?? item.available_quantity);
  const minimum = Math.max(0, safeNumber(item.min_stock_level ?? item.reorder_level));
  if (quantity <= 0) return 'out_of_stock';
  if (minimum > 0 && quantity <= minimum) return 'low_stock';
  return 'in_stock';
}

function finalReceiptByOrder(goodsReceipts = []) {
  const result = new Map();
  goodsReceipts.forEach((receipt) => {
    const orderId = String(receipt.purchase_order_id || receipt.order_id || '');
    const receiptDate = recordDate(receipt, ['receipt_date', 'received_date', 'created_at']);
    if (!orderId || !receiptDate) return;
    const current = result.get(orderId);
    if (!current || receiptDate > current) result.set(orderId, receiptDate);
  });
  return result;
}

function computeSupplierStats(purchaseOrders = [], goodsReceipts = [], targetDate) {
  const receiptMap = finalReceiptByOrder(goodsReceipts);
  let delivered = 0;
  let onTime = 0;
  let late = 0;

  purchaseOrders.forEach((order) => {
    const status = normalizeStatus(order.status);
    const orderId = String(order.id || '');
    const receiptDate = receiptMap.get(orderId);
    const expected = dateOnly(order.expected_delivery_date || order.needed_by);
    if (receiptDate && COMPLETED_ORDER_STATUSES.has(status)) {
      delivered += 1;
      if (!expected || receiptDate <= expected) onTime += 1;
      else late += 1;
      return;
    }
    if (expected && expected < targetDate && !CLOSED_ORDER_STATUSES.has(status)) late += 1;
  });

  return {
    supplier_sla: delivered > 0 ? round((onTime / delivered) * 100, 1) : null,
    supplier_exceptions: late
  };
}

function computeAttendanceStats(staffShifts = [], attendanceRecords = []) {
  const activeShifts = uniqueById(staffShifts.filter((shift) => !['cancelled', 'canceled'].includes(normalizeStatus(shift.status))));
  const recordByShift = new Map();
  attendanceRecords.forEach((record) => {
    const key = String(record.shift_id || record.user_id || record.user_email || record.id || '');
    if (key && !recordByShift.has(key)) recordByShift.set(key, record);
  });

  const denominator = activeShifts.length || recordByShift.size;
  const present = denominator === activeShifts.length && activeShifts.length > 0
    ? activeShifts.filter((shift) => {
      const record = recordByShift.get(String(shift.id || shift.user_id || shift.user_email || ''));
      const status = normalizeStatus(record?.attendance_status || record?.status);
      return Boolean(record?.check_in_at || record?.checked_in_at || ['present', 'checked_in', 'completed', 'approved'].includes(status));
    }).length
    : [...recordByShift.values()].filter((record) => {
      const status = normalizeStatus(record.attendance_status || record.status);
      return Boolean(record.check_in_at || record.checked_in_at || ['present', 'checked_in', 'completed', 'approved'].includes(status));
    }).length;

  return {
    attendance: denominator > 0 ? round((present / denominator) * 100, 1) : null,
    attendance_gaps: Math.max(0, denominator - present)
  };
}

function computeQualityScore(qualityControls = []) {
  const finalRecords = qualityControls.filter((record) => {
    const status = normalizeStatus(record.overall_status || record.status || record.qc_status);
    return ['approved', 'passed', 'pass', 'completed', 'complete', 'rejected', 'failed', 'fail'].includes(status);
  });
  if (!finalRecords.length) return null;

  const explicitScores = finalRecords
    .map((record) => firstFiniteValue([
      record.quality_score,
      record.compliance_score,
      record.overall_score,
      record.qc_score,
      record.inspection_score,
      record.score
    ]))
    .filter((value) => value !== undefined)
    .map((value) => Math.min(100, Math.max(0, safeNumber(value))));

  if (explicitScores.length) {
    return round(explicitScores.reduce((sum, value) => sum + value, 0) / explicitScores.length, 1);
  }

  const passed = finalRecords.filter((record) => {
    const status = normalizeStatus(record.overall_status || record.status || record.qc_status);
    return ['approved', 'passed', 'pass', 'completed', 'complete'].includes(status);
  }).length;
  return round((passed / finalRecords.length) * 100, 1);
}

function computeMenuCompletion(menuPlans = [], operationalSiteCount = 1, siteKeyForPlan = null) {
  const completedKeys = new Set();
  menuPlans
    .filter((plan) => !plan.event_name && !plan.event_type)
    .forEach((plan) => {
      const siteKey = typeof siteKeyForPlan === 'function'
        ? siteKeyForPlan(plan)
        : plan.site_id;
      flattenMenuEntries(plan).forEach((entry) => {
        const mealType = normalizeMealType(entry.meal_type);
        if (MEAL_PERIODS.includes(mealType) && menuEntryIsComplete(entry)) {
          completedKeys.add(`${siteKey || 'global'}:${mealType}`);
        }
      });
    });
  const denominator = Math.max(1, operationalSiteCount) * MEAL_PERIODS.length;
  return round(Math.min(100, (completedKeys.size / denominator) * 100), 1);
}

function countApprovals({ productions, foodWaste, attendanceRecords, menuPlans, purchaseRequests }) {
  const production = productions.filter((record) => isPending(record.status)).length;
  const waste = foodWaste.filter((record) => isPending(record.approval_status || record.status)).length;
  const attendance = attendanceRecords.filter((record) => isPending(record.approval_status)).length;
  const events = menuPlans.filter((record) => record.event_name && isPending(record.approval_status || record.status)).length;
  const procurement = purchaseRequests.filter((record) => isPending(record.status)).length;
  return { production, waste, attendance, events, procurement, total: production + waste + attendance + events + procurement };
}

function recordsForSiteIds(data, siteIds, helpers) {
  const shiftMap = new Map(data.staffShifts.map((record) => [String(record.id), record]));
  const productionMap = new Map(data.production.map((record) => [String(record.id), record]));
  const resolve = (record) => siteIdForRecord(record, shiftMap, productionMap);
  return {
    production: filterBySiteIds(data.production, siteIds, resolve),
    foodWaste: filterBySiteIds(data.foodWaste, siteIds, resolve),
    inventory: filterBySiteIds(data.inventory, siteIds, resolve),
    budgets: filterBySiteIds(data.budgets, siteIds, resolve),
    menuPlans: filterBySiteIds(data.menuPlans, siteIds, resolve),
    materialRequests: filterBySiteIds(data.materialRequests, siteIds, resolve),
    attendanceRecords: filterBySiteIds(data.attendanceRecords, siteIds, resolve),
    staffShifts: filterBySiteIds(data.staffShifts, siteIds, resolve),
    qualityControls: filterBySiteIds(data.qualityControls, siteIds, resolve),
    purchaseRequests: filterBySiteIds(data.purchaseRequests, siteIds, resolve),
    purchaseOrders: filterBySiteIds(data.purchaseOrders, siteIds, resolve),
    goodsReceipts: filterBySiteIds(data.goodsReceipts, siteIds, resolve),
    siteIdForRecord: resolve,
    helpers
  };
}

function computeCoreMetrics(records, targetDate, operationalSiteCount) {
  const dayProduction = records.production.filter((record) => isOnDate(record, targetDate, ['production_date', 'date']));
  const dayWaste = records.foodWaste.filter((record) => isOnDate(record, targetDate, ['waste_date', 'date']));
  const dayMenus = records.menuPlans.filter((record) => isOnDate(record, targetDate, ['plan_date', 'event_date', 'date']));
  const dayAttendance = records.attendanceRecords.filter((record) => isOnDate(record, targetDate, ['shift_date', 'attendance_date', 'check_in_at', 'checked_in_at', 'created_date']));
  const dayShifts = records.staffShifts.filter((record) => isOnDate(record, targetDate, ['shift_date', 'date', 'start_date']));
  const dayQuality = records.qualityControls.filter((record) => isOnDate(record, targetDate, ['inspection_date', 'quality_date', 'created_date']));

  const totalMeals = dayProduction.reduce((sum, record) => sum + producedServings(record), 0);
  const spent = dayProduction
    .filter(productionCountsAsSpend)
    .reduce((sum, record) => sum + productionCost(record), 0);
  const wasteCost = dayWaste.reduce((sum, record) => sum + Math.max(0, safeNumber(record.estimated_cost ?? record.waste_cost)), 0);
  const mealBudgetAllocation = buildMealBudgetAllocation(records, targetDate);
  const budget = MEAL_PERIODS.reduce((sum, mealType) => sum + mealBudgetAllocation[mealType], 0);
  const stockRisk = records.inventory.filter((record) => deriveInventoryStatus(record) !== 'in_stock').length;
  // Approval widgets are queues, not selected-day activity counters. Count every
  // open item supplied for the current location scope and exclude unsubmitted drafts.
  const approvals = countApprovals({
    productions: records.production,
    foodWaste: records.foodWaste,
    attendanceRecords: records.attendanceRecords,
    menuPlans: records.menuPlans,
    purchaseRequests: records.purchaseRequests
  });
  const supplier = computeSupplierStats(records.purchaseOrders, records.goodsReceipts, targetDate);
  const attendance = computeAttendanceStats(dayShifts, dayAttendance);

  return {
    total_meals: round(totalMeals, 0),
    cost_per_meal: totalMeals > 0 ? round(spent / totalMeals, 2) : 0,
    daily_budget: round(budget, 2),
    daily_spent: round(spent, 2),
    food_wastage_cost: round(wasteCost, 2),
    waste_percent: spent > 0 ? round((wasteCost / spent) * 100, 1) : 0,
    stock_risk: stockRisk,
    pending_approvals: approvals.total,
    menu_plan_completion: computeMenuCompletion(
      dayMenus,
      operationalSiteCount,
      (plan) => records.helpers.operationalAnchor(records.siteIdForRecord(plan))?.id
        || records.siteIdForRecord(plan)
        || 'global'
    ),
    supplier_sla: supplier.supplier_sla,
    supplier_exceptions: supplier.supplier_exceptions,
    attendance: attendance.attendance,
    attendance_gaps: attendance.attendance_gaps,
    quality_score: computeQualityScore(dayQuality),
    approvals
  };
}

function buildMealBudgetAllocation(records, targetDate, dailyBudget = 0) {
  const allocations = Object.fromEntries(MEAL_PERIODS.map((mealType) => [mealType, 0]));
  const groups = new Map();
  const groupForRecord = (record) => {
    const siteId = records.siteIdForRecord(record);
    const anchor = records.helpers.operationalAnchor(siteId);
    return String(anchor?.id || siteId || 'global');
  };
  const ensureGroup = (key) => {
    if (!groups.has(key)) {
      groups.set(key, {
        explicit: Object.fromEntries(MEAL_PERIODS.map((mealType) => [mealType, 0])),
        mealScoped: Object.fromEntries(MEAL_PERIODS.map((mealType) => [mealType, 0])),
        manualTotal: 0,
        allMealTotal: 0
      });
    }
    return groups.get(key);
  };

  const seenPlans = new Set();
  records.menuPlans
    .filter((plan) => !plan.event_name && !plan.event_type)
    .filter((plan) => isOnDate(plan, targetDate, ['plan_date', 'date']))
    .forEach((plan) => {
      const groupKey = groupForRecord(plan);
      const planSiteKey = records.siteIdForRecord(plan) || groupKey;
      const planKey = String(plan.id || recordDate(plan, ['plan_date', 'date']) || 'menu-plan');
      const uniquePlanKey = `${planSiteKey}:${planKey}`;
      if (seenPlans.has(uniquePlanKey)) return;
      seenPlans.add(uniquePlanKey);
      const group = ensureGroup(groupKey);
      MEAL_PERIODS.forEach((mealType) => {
        const limit = Math.max(0, safeNumber(plan.meal_budget_limits?.[mealType]));
        if (limit > 0) group.explicit[mealType] += limit;
      });
      if (normalizeStatus(plan.budget_source) === 'manual') {
        group.manualTotal += Math.max(0, safeNumber(plan.budget_amount));
      }
    });

  records.budgets
    .filter((budget) => budgetCoversDate(budget, targetDate))
    .forEach((budget) => {
      const amount = dailyBudgetAmount(budget, targetDate);
      if (amount <= 0) return;
      const group = ensureGroup(groupForRecord(budget));
      const mealType = normalizeMealType(budget.meal_type);
      if (MEAL_PERIODS.includes(mealType)) group.mealScoped[mealType] += amount;
      else group.allMealTotal += amount;
    });

  groups.forEach((group) => {
    const direct = Object.fromEntries(MEAL_PERIODS.map((mealType) => [
      mealType,
      group.explicit[mealType] > 0
        ? group.explicit[mealType]
        : (group.manualTotal > 0 ? 0 : group.mealScoped[mealType])
    ]));
    const directTotal = MEAL_PERIODS.reduce((sum, mealType) => sum + direct[mealType], 0);
    const unresolved = MEAL_PERIODS.filter((mealType) => direct[mealType] <= 0);

    // A manual plan budget and a Budget record with meal_type=all are both
    // whole-day ceilings. Only their unallocated remainder is divided, and only
    // across meals that have no explicit limit or meal-scoped budget.
    const allMealCeiling = group.manualTotal > 0 ? group.manualTotal : group.allMealTotal;
    const fallbackShare = unresolved.length > 0
      ? Math.max(0, allMealCeiling - directTotal) / unresolved.length
      : 0;

    MEAL_PERIODS.forEach((mealType) => {
      allocations[mealType] += direct[mealType] > 0 ? direct[mealType] : fallbackShare;
    });
  });

  // Legacy snapshots may provide only a precomputed daily total. Preserve the
  // former equal split solely as a last-resort all-meal fallback.
  if (!groups.size && dailyBudget > 0) {
    MEAL_PERIODS.forEach((mealType) => {
      allocations[mealType] = dailyBudget / MEAL_PERIODS.length;
    });
  }

  const roundedAllocations = Object.fromEntries(
    MEAL_PERIODS.map((mealType) => [mealType, round(allocations[mealType], 2)])
  );
  const rawTotal = round(MEAL_PERIODS.reduce((sum, mealType) => sum + allocations[mealType], 0), 2);
  const roundedTotal = round(MEAL_PERIODS.reduce((sum, mealType) => sum + roundedAllocations[mealType], 0), 2);
  const roundingRemainder = round(rawTotal - roundedTotal, 2);
  if (roundingRemainder !== 0) {
    const adjustmentMeal = [...MEAL_PERIODS].reverse()
      .find((mealType) => roundedAllocations[mealType] > 0) || MEAL_PERIODS.at(-1);
    roundedAllocations[adjustmentMeal] = round(roundedAllocations[adjustmentMeal] + roundingRemainder, 2);
  }
  return roundedAllocations;
}

function buildMealRows(records, targetDate, dailyBudget) {
  const dayProduction = records.production.filter((record) => isOnDate(record, targetDate, ['production_date', 'date']));
  const dayWaste = records.foodWaste.filter((record) => isOnDate(record, targetDate, ['waste_date', 'date']));
  const dayMenus = records.menuPlans.filter((record) => isOnDate(record, targetDate, ['plan_date', 'date']) && !record.event_name);
  const mealBudgets = buildMealBudgetAllocation(records, targetDate, dailyBudget);

  return MEAL_PERIODS.map((mealType) => {
    const production = dayProduction.filter((record) => normalizeMealType(record.meal_type) === mealType);
    const waste = dayWaste.filter((record) => normalizeMealType(record.meal_type) === mealType);
    const menuPlanned = dayMenus.reduce((sum, plan) => sum + flattenMenuEntries(plan)
      .filter((entry) => normalizeMealType(entry.meal_type) === mealType)
      .reduce((entrySum, entry) => entrySum + menuEntryServings(entry), 0), 0);
    const productionPlanned = production.reduce((sum, record) => sum + plannedServings(record), 0);
    const planned = productionPlanned > 0 ? productionPlanned : menuPlanned;
    const produced = production.reduce((sum, record) => sum + producedServings(record), 0);
    const spent = production.filter(productionCountsAsSpend).reduce((sum, record) => sum + productionCost(record), 0);
    const wasteCost = waste.reduce((sum, record) => sum + Math.max(0, safeNumber(record.estimated_cost ?? record.waste_cost)), 0);
    const variance = produced - planned;
    let action = 'None';
    if (planned > 0 && produced === 0) action = 'Start production';
    else if (variance < 0) action = 'Update forecast';
    else if (variance > Math.max(10, planned * 0.05)) action = 'Review overproduction';
    else if (wasteCost > spent * 0.03 && wasteCost > 0) action = 'Review waste';

    return {
      meal_type: mealType,
      planned: round(planned, 0),
      produced: round(produced, 0),
      variance: round(variance, 0),
      budget: mealBudgets[mealType],
      spent: round(spent, 2),
      waste_cost: round(wasteCost, 2),
      action
    };
  });
}

function buildTrendRows(data, records, sites, targetDate, helpers) {
  const dates = rangeDates(targetDate, 7);
  const locationTotals = new Map();
  records.production.forEach((record) => {
    const siteId = records.siteIdForRecord(record);
    const anchor = helpers.operationalAnchor(siteId);
    if (!anchor) return;
    locationTotals.set(String(anchor.id), (locationTotals.get(String(anchor.id)) || 0) + producedServings(record));
  });

  const locationSeries = [...locationTotals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([id], index) => ({
      id,
      name: helpers.byId.get(id)?.name || 'Location',
      key: `location_${index + 1}`,
      color: LOCATION_SERIES_COLORS[index % LOCATION_SERIES_COLORS.length]
    }));

  const rows = dates.map((day) => {
    const dayProduction = records.production.filter((record) => isOnDate(record, day, ['production_date', 'date']));
    const dayWaste = records.foodWaste.filter((record) => isOnDate(record, day, ['waste_date', 'date']));
    const row = {
      date: day,
      label: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)),
      budget: round(records.budgets.reduce((sum, budget) => sum + dailyBudgetAmount(budget, day), 0), 2),
      spent: round(dayProduction.filter(productionCountsAsSpend).reduce((sum, record) => sum + productionCost(record), 0), 2),
      waste_cost: round(dayWaste.reduce((sum, record) => sum + Math.max(0, safeNumber(record.estimated_cost ?? record.waste_cost)), 0), 2),
      planned: round(dayProduction.reduce((sum, record) => sum + plannedServings(record), 0), 0),
      produced: round(dayProduction.reduce((sum, record) => sum + producedServings(record), 0), 0)
    };
    locationSeries.forEach((series) => {
      row[series.key] = round(dayProduction
        .filter((record) => String(helpers.operationalAnchor(records.siteIdForRecord(record))?.id || '') === series.id)
        .reduce((sum, record) => sum + producedServings(record), 0), 0);
    });
    return row;
  });

  return { rows, locationSeries };
}

function buildLocationRows(data, records, targetDate, helpers, selectedIds) {
  const anchors = new Map();
  data.sites.forEach((site) => {
    if (selectedIds && !selectedIds.has(String(site.id))) return;
    const anchor = helpers.operationalAnchor(site.id);
    if (anchor) anchors.set(String(anchor.id), anchor);
  });
  [records.production, records.foodWaste, records.inventory, records.budgets].flat().forEach((record) => {
    const anchor = helpers.operationalAnchor(records.siteIdForRecord(record));
    if (anchor) anchors.set(String(anchor.id), anchor);
  });

  return [...anchors.values()].map((site) => {
    const siteIds = helpers.descendantIds(site.id);
    const scoped = recordsForSiteIds(data, siteIds, helpers);
    const metrics = computeCoreMetrics(scoped, targetDate, 1);
    const highWaste = scoped.foodWaste.filter((record) => isOnDate(record, targetDate, ['waste_date', 'date']))
      .filter((record) => safeNumber(record.estimated_cost ?? record.waste_cost) >= HIGH_WASTE_COST_THRESHOLD)
      .length;
    const exceptions = metrics.stock_risk + metrics.supplier_exceptions + metrics.attendance_gaps + highWaste;
    const overdue = metrics.supplier_exceptions > 0 || highWaste > 0;
    return {
      id: String(site.id),
      name: site.name || 'Location',
      meals: metrics.total_meals,
      budget: metrics.daily_budget,
      spent: metrics.daily_spent,
      cost_per_meal: metrics.cost_per_meal,
      waste_percent: metrics.waste_percent,
      waste_cost: metrics.food_wastage_cost,
      approvals: metrics.pending_approvals,
      stock_risk: metrics.stock_risk,
      supplier_exceptions: metrics.supplier_exceptions,
      attendance_gaps: metrics.attendance_gaps,
      production_approvals: metrics.approvals.production,
      owner: site.manager_name || site.project_manager_name || site.owner_name || 'Unassigned',
      due: overdue ? 'Immediate' : exceptions > 0 ? 'Monitor' : 'No priority',
      status: overdue ? 'High Priority' : exceptions > 0 ? 'Review' : 'On Track',
      exceptions
    };
  }).sort((left, right) => right.meals - left.meals || left.name.localeCompare(right.name));
}

function buildActions(view, metrics, records, targetDate) {
  const highWaste = records.foodWaste.filter((record) => isOnDate(record, targetDate, ['waste_date', 'date']))
    .filter((record) => safeNumber(record.estimated_cost ?? record.waste_cost) >= HIGH_WASTE_COST_THRESHOLD).length;
  const values = {
    procurement: { key: 'procurement', label: 'PR Approvals', count: metrics.approvals.procurement, href: '/ProcurementModule', tone: 'blue' },
    production: { key: 'production', label: view === DASHBOARD_VIEWS.GENERAL_MANAGER ? 'Production Approvals' : 'Production Requests', count: metrics.approvals.production, href: '/Production', tone: 'green' },
    waste: { key: 'waste', label: view === DASHBOARD_VIEWS.GENERAL_MANAGER ? 'Waste Approvals' : 'Waste Review', count: metrics.approvals.waste, href: '/FoodWaste', tone: 'amber' },
    inventory: { key: 'inventory', label: view === DASHBOARD_VIEWS.PROJECT_MANAGER ? 'Inventory Shortage' : 'Low Stock', count: metrics.stock_risk, href: '/Inventory', tone: 'amber' },
    supplier: { key: 'supplier', label: view === DASHBOARD_VIEWS.AREA_MANAGER ? 'Late Supplier' : 'Supplier Exceptions', count: metrics.supplier_exceptions, href: '/ProcurementModule', tone: 'violet' },
    attendance: { key: 'attendance', label: view === DASHBOARD_VIEWS.AREA_MANAGER ? 'Attendance Gap' : 'Attendance Gaps', count: metrics.attendance_gaps, href: '/Attendance', tone: 'rose' },
    highWaste: { key: 'high_waste', label: 'High Waste', count: highWaste, href: '/FoodWaste', tone: 'rose' }
  };

  if (view === DASHBOARD_VIEWS.PROJECT_MANAGER) return [values.procurement, values.production, values.waste, values.inventory];
  if (view === DASHBOARD_VIEWS.AREA_MANAGER) return [values.highWaste, values.inventory, values.supplier, values.attendance];
  if (view === DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER) return [values.procurement, values.production, values.waste, values.supplier, values.attendance];
  return [values.procurement, values.production, values.waste, values.supplier];
}

function normalizeDataset(input = {}) {
  const array = (value) => Array.isArray(value) ? value : [];
  return {
    sites: array(input.sites),
    production: array(input.production || input.productions),
    foodWaste: array(input.foodWaste || input.food_waste),
    inventory: array(input.inventory),
    budgets: array(input.budgets),
    menuPlans: array(input.menuPlans || input.menu_plans),
    materialRequests: array(input.materialRequests || input.material_requests),
    attendanceRecords: array(input.attendanceRecords || input.attendance_records),
    staffShifts: array(input.staffShifts || input.staff_shifts),
    qualityControls: array(input.qualityControls || input.quality_controls),
    purchaseRequests: array(input.purchaseRequests || input.purchase_requests),
    purchaseOrders: array(input.purchaseOrders || input.purchase_orders),
    goodsReceipts: array(input.goodsReceipts || input.goods_receipts)
  };
}

function availableScopeTypes(view) {
  if (view === DASHBOARD_VIEWS.AREA_MANAGER) return new Set([SITE_HIERARCHY_TYPES.AREA]);
  if (view === DASHBOARD_VIEWS.PROJECT_MANAGER) return new Set([SITE_HIERARCHY_TYPES.PROJECT]);
  return new Set([SITE_HIERARCHY_TYPES.AREA, SITE_HIERARCHY_TYPES.PROJECT]);
}

export function buildManagementDashboardSnapshot(input = {}) {
  const data = normalizeDataset(input);
  const view = String(input.view || DASHBOARD_VIEWS.GENERAL_MANAGER);
  const targetDate = dateOnly(input.date) || new Date().toISOString().slice(0, 10);
  const helpers = createSiteHelpers(data.sites);
  const selectedSiteId = input.selectedSiteId || input.siteId || null;
  const selectedIds = selectedSiteId ? helpers.descendantIds(selectedSiteId) : null;
  const records = recordsForSiteIds(data, selectedIds, helpers);

  const operationalSites = data.sites.filter((site) => {
    if (selectedIds && !selectedIds.has(String(site.id))) return false;
    return normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT;
  });
  const operationalAnchors = new Set(operationalSites.map((site) => String(helpers.operationalAnchor(site.id)?.id || site.id)));
  const metrics = computeCoreMetrics(records, targetDate, Math.max(1, operationalAnchors.size));
  metrics.open_exceptions = metrics.stock_risk + metrics.supplier_exceptions + metrics.attendance_gaps
    + metrics.approvals.waste + metrics.approvals.production;

  const trend = buildTrendRows(data, records, data.sites, targetDate, helpers);
  const locations = buildLocationRows(data, records, targetDate, helpers, selectedIds);
  const scopeTypes = availableScopeTypes(view);
  const availableScopes = data.sites
    .filter((site) => scopeTypes.has(normalizeSiteType(site.type)))
    .map((site) => ({
      id: String(site.id),
      name: site.name || 'Location',
      type: site.type || 'location',
      parent_site_id: site.parent_site_id || null
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const selectedSite = selectedSiteId ? helpers.byId.get(String(selectedSiteId)) : null;
  const dataQuality = [];
  if (!records.production.some((record) => isOnDate(record, targetDate, ['production_date', 'date']))) {
    dataQuality.push('No production activity is recorded for the selected date.');
  }
  if (metrics.supplier_sla === null) dataQuality.push('Supplier SLA is unavailable until at least one delivery is recorded.');
  if (metrics.attendance === null) dataQuality.push('Attendance is unavailable because no scheduled shifts are recorded for the selected date.');
  if (metrics.quality_score === null) dataQuality.push('Quality score is unavailable because no completed inspections are linked to this scope.');

  return {
    generated_at: new Date().toISOString(),
    view,
    date: targetDate,
    range_start: input.rangeStart || shiftDate(targetDate, -6),
    range_end: input.rangeEnd || targetDate,
    scope: {
      selected_site_id: selectedSiteId || null,
      selected_site_name: selectedSite?.name || null,
      available_scopes: availableScopes
    },
    metrics,
    locations,
    meals: buildMealRows(records, targetDate, metrics.daily_budget),
    actions: buildActions(view, metrics, records, targetDate),
    trends: trend.rows,
    location_series: trend.locationSeries,
    data_quality: dataQuality
  };
}

export {
  MEAL_PERIODS,
  dateOnly,
  shiftDate,
  safeNumber,
  productionCost,
  producedServings,
  plannedServings,
  dailyBudgetAmount,
  deriveInventoryStatus,
  computeAttendanceStats,
  computeSupplierStats,
  computeMenuCompletion,
  computeQualityScore,
  buildMealBudgetAllocation
};
