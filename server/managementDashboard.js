import { buildManagementDashboardSnapshot } from '../shared/managementDashboard.js';
import { DASHBOARD_VIEWS } from '../shared/managementDashboardRoles.js';
import { listDocuments, pool } from './db.js';
import { filterRecordsByLocation, getLocationScope } from './locationScope.js';
import {
  assertManagementDashboardViewAccess,
  selectDefaultProjectScope
} from './managementDashboardAccess.js';

const numericEnv = (key, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[key] || '', 10);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};

const SOURCE_PAGE_SIZE = numericEnv('MANAGEMENT_DASHBOARD_SOURCE_PAGE_SIZE', 5000, 100, 10000);
const MAX_SOURCE_ROWS = numericEnv('MANAGEMENT_DASHBOARD_MAX_SOURCE_ROWS', 250000, SOURCE_PAGE_SIZE, 1000000);
const SNAPSHOT_CACHE_TTL_MS = numericEnv('MANAGEMENT_DASHBOARD_CACHE_TTL_MS', 5000, 0, 60000);
const SNAPSHOT_CACHE_MAX_ENTRIES = numericEnv('MANAGEMENT_DASHBOARD_CACHE_MAX_ENTRIES', 1024, 1, 5000);
const MAX_REPORTING_RANGE_DAYS = numericEnv('MANAGEMENT_DASHBOARD_MAX_RANGE_DAYS', 366, 1, 3660);
const snapshotCache = new Map();

const PURCHASE_REQUEST_OPEN_STATUSES = Object.freeze([
  'draft', 'pending', 'pending_approval', 'submitted', 'awaiting_approval'
]);
const PURCHASE_ORDER_OPEN_STATUSES = Object.freeze([
  'pending', 'approved', 'partially_received'
]);
const APPROVAL_OPEN_STATUSES = Object.freeze([
  'pending', 'pending_approval', 'pending_procurement', 'pending_production',
  'awaiting_approval', 'submitted', 'under_review'
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeDate(value, label = 'Date') {
  const candidate = String(value || currentOperationalDate()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw httpError(400, `${label} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw httpError(400, `${label} is not a valid calendar date`);
  }
  return candidate;
}

function currentOperationalDate() {
  const timeZone = process.env.APP_TIME_ZONE || process.env.TZ || 'Asia/Riyadh';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addUtcDays(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function inclusiveRangeDays(startDate, endDate) {
  const startTime = Date.parse(`${startDate}T00:00:00.000Z`);
  const endTime = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.round((endTime - startTime) / 86400000) + 1;
}

function resolveDateSelection(filters = {}) {
  const startValue = filters.start_date ?? filters.startDate;
  const endValue = filters.end_date ?? filters.endDate;
  const hasStart = String(startValue ?? '').trim() !== '';
  const hasEnd = String(endValue ?? '').trim() !== '';

  if (hasStart !== hasEnd) {
    throw httpError(400, 'start_date and end_date must be provided together');
  }

  if (hasStart && hasEnd) {
    const rangeStart = normalizeDate(startValue, 'Start date');
    const rangeEnd = normalizeDate(endValue, 'End date');
    if (rangeStart > rangeEnd) {
      throw httpError(400, 'Start date must be on or before end date');
    }
    if (inclusiveRangeDays(rangeStart, rangeEnd) > MAX_REPORTING_RANGE_DAYS) {
      throw httpError(400, `Date range cannot exceed ${MAX_REPORTING_RANGE_DAYS} days`);
    }
    return {
      date: rangeEnd,
      rangeStart,
      rangeEnd,
      aggregateRange: true
    };
  }

  const date = normalizeDate(filters.date);
  return {
    date,
    rangeStart: addUtcDays(date, -6),
    rangeEnd: date,
    aggregateRange: false
  };
}

function collectDescendantIds(rootId, graph) {
  const visited = new Set();
  const queue = [String(rootId)];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    (graph.children.get(id) || []).forEach((site) => queue.push(String(site.id)));
  }
  return visited;
}

function filterBySelectedSites(records, selectedSiteIds) {
  const selected = selectedSiteIds instanceof Set ? selectedSiteIds : new Set(selectedSiteIds || []);
  if (selected.size === 0) return [];
  return (records || []).filter((record) => {
    const referencedSites = [record.site_id, record.from_site_id, record.to_site_id]
      .filter(Boolean)
      .map(String);
    if (referencedSites.length > 0) {
      return referencedSites.every((siteId) => selected.has(siteId));
    }
    const scopedSites = Array.isArray(record.site_ids)
      ? record.site_ids.filter(Boolean).map(String)
      : [];
    if (scopedSites.length > 0) {
      return scopedSites.some((siteId) => selected.has(siteId));
    }
    // Management summaries never include unattributed operational records:
    // they cannot be proven to belong to the signed-in user's selected scope.
    return false;
  });
}

function scopeRecords(user, entity, records, scope, selectedSiteIds) {
  const accessible = filterRecordsByLocation(user, entity, records || [], scope);
  return filterBySelectedSites(accessible, selectedSiteIds);
}

function normalizeDateFields(fields) {
  return [...new Set(fields.map((field) => String(field || '').trim()).filter(Boolean))];
}

function normalizeOpenStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

async function listDatedDocuments({
  entity,
  dateFields,
  startDate,
  endDate,
  siteIds,
  openStatusFields = [],
  openStatuses = [],
  limit = MAX_SOURCE_ROWS
}) {
  const fields = normalizeDateFields(dateFields);
  if (!fields.length || !siteIds.size) return [];

  const baseParameters = [entity, startDate, endDate, [...siteIds]];
  const dateClauses = fields.map((field) => {
    baseParameters.push(field);
    return `LEFT(COALESCE(record.data->>$${baseParameters.length}, ''), 10) BETWEEN $2 AND $3`;
  });
  const normalizedOpenFields = normalizeDateFields(openStatusFields);
  const normalizedOpenStatuses = [...new Set((openStatuses || [])
    .map(normalizeOpenStatus)
    .filter(Boolean))];
  let openClause = '';
  if (normalizedOpenFields.length > 0 && normalizedOpenStatuses.length > 0) {
    const statusExpressions = normalizedOpenFields.map((field) => {
      baseParameters.push(field);
      return `REGEXP_REPLACE(LOWER(BTRIM(COALESCE(record.data->>$${baseParameters.length}, ''))), '[[:space:]-]+', '_', 'g')`;
    });
    baseParameters.push(normalizedOpenStatuses);
    const statusesParameter = `$${baseParameters.length}`;
    openClause = ` OR (${statusExpressions.map((expression) => `${expression} = ANY(${statusesParameter}::text[])`).join(' OR ')})`;
  }
  const requestedMaximum = Math.min(MAX_SOURCE_ROWS, Math.max(SOURCE_PAGE_SIZE, Number(limit) || MAX_SOURCE_ROWS));
  const records = [];
  let cursor = null;

  while (records.length <= requestedMaximum) {
    const parameters = [...baseParameters];
    let cursorClause = '';
    if (cursor) {
      parameters.push(cursor.updatedAt, cursor.id);
      const updatedParameter = `$${parameters.length - 1}`;
      const idParameter = `$${parameters.length}`;
      cursorClause = `AND (
        record.updated_at < ${updatedParameter}::timestamptz
        OR (record.updated_at = ${updatedParameter}::timestamptz AND record.id > ${idParameter}::text)
      )`;
    }
    const pageLimit = Math.min(SOURCE_PAGE_SIZE, requestedMaximum + 1 - records.length);
    parameters.push(pageLimit);
    const limitParameter = `$${parameters.length}`;

    const result = await pool.query(
      `SELECT record.data, record.updated_at, record.id
         FROM entity_records record
        WHERE record.entity_name = $1
          AND (${dateClauses.join(' OR ')}${openClause})
          AND (
            (
              COALESCE(record.data->>'site_id', '') = ''
              AND COALESCE(record.data->>'from_site_id', '') = ''
              AND COALESCE(record.data->>'to_site_id', '') = ''
              AND CASE
                WHEN jsonb_typeof(record.data->'site_ids') = 'array'
                  AND jsonb_array_length(record.data->'site_ids') > 0
                THEN EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(record.data->'site_ids') scoped_site(value)
                   WHERE scoped_site.value = ANY($4::text[])
                )
                ELSE FALSE
              END
            )
            OR (
              (COALESCE(record.data->>'site_id', '') = '' OR record.data->>'site_id' = ANY($4::text[]))
              AND (COALESCE(record.data->>'from_site_id', '') = '' OR record.data->>'from_site_id' = ANY($4::text[]))
              AND (COALESCE(record.data->>'to_site_id', '') = '' OR record.data->>'to_site_id' = ANY($4::text[]))
              AND (
                COALESCE(record.data->>'site_id', '') <> ''
                OR COALESCE(record.data->>'from_site_id', '') <> ''
                OR COALESCE(record.data->>'to_site_id', '') <> ''
              )
            )
          )
          ${cursorClause}
        ORDER BY record.updated_at DESC, record.id ASC
        LIMIT ${limitParameter}::integer`,
      parameters
    );

    records.push(...result.rows.map((row) => row.data));
    if (records.length > requestedMaximum) {
      const error = httpError(503, `${entity} volume exceeds the safe dashboard query limit; use an aggregated reporting source`);
      error.code = 'MANAGEMENT_DASHBOARD_SOURCE_LIMIT';
      throw error;
    }
    if (result.rows.length < pageLimit) break;
    const last = result.rows[result.rows.length - 1];
    cursor = { updatedAt: last.updated_at, id: String(last.id) };
  }

  return records;
}

async function listInventoryRiskCounts(siteIds) {
  if (!siteIds.size) return [];
  const quantityExpression = `CASE
    WHEN BTRIM(COALESCE(record.data->>'quantity', record.data->>'available_quantity', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
    THEN BTRIM(COALESCE(record.data->>'quantity', record.data->>'available_quantity'))::numeric
    ELSE 0::numeric
  END`;
  const minimumExpression = `GREATEST(0::numeric, CASE
    WHEN BTRIM(COALESCE(record.data->>'min_stock_level', record.data->>'reorder_level', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
    THEN BTRIM(COALESCE(record.data->>'min_stock_level', record.data->>'reorder_level'))::numeric
    ELSE 0::numeric
  END)`;
  const result = await pool.query(
    `SELECT record.data->>'site_id' AS site_id, COUNT(*)::integer AS risk_count
       FROM entity_records record
      WHERE record.entity_name = 'Inventory'
        AND record.data->>'site_id' = ANY($1::text[])
        AND (
          (${quantityExpression}) <= 0
          OR ((${minimumExpression}) > 0 AND (${quantityExpression}) <= (${minimumExpression}))
        )
      GROUP BY record.data->>'site_id'`,
    [[...siteIds]]
  );
  return result.rows.map((row) => ({
    site_id: String(row.site_id),
    risk_count: Math.max(0, Number(row.risk_count) || 0)
  }));
}

async function listCurrentDocuments(entity, siteIds, { sort = '-updated_date', limit = MAX_SOURCE_ROWS } = {}) {
  if (!siteIds.size) return [];
  const requestedMaximum = Math.min(MAX_SOURCE_ROWS, Math.max(SOURCE_PAGE_SIZE, Number(limit) || MAX_SOURCE_ROWS));
  const records = [];
  while (records.length <= requestedMaximum) {
    const pageLimit = Math.min(SOURCE_PAGE_SIZE, requestedMaximum + 1 - records.length);
    const page = await listDocuments(entity, {
      sort,
      limit: pageLimit,
      offset: records.length,
      location: { unrestricted: false, accessibleSiteIds: [...siteIds] }
    });
    records.push(...page);
    if (records.length > requestedMaximum) {
      const error = httpError(503, `${entity} volume exceeds the safe dashboard query limit; use an aggregated reporting source`);
      error.code = 'MANAGEMENT_DASHBOARD_SOURCE_LIMIT';
      throw error;
    }
    if (page.length < pageLimit) break;
  }
  return records;
}

async function listNormalizedRows({
  table,
  dateField,
  siteIds,
  startDate,
  endDate,
  openStatuses = [],
  includeReceiptLinked = false,
  limit = MAX_SOURCE_ROWS
}) {
  if (!siteIds.size) return [];
  const allowedTables = new Set(['purchase_requests', 'purchase_orders', 'goods_receipts']);
  const allowedDateFields = new Set(['request_date', 'order_date', 'receipt_date']);
  if (!allowedTables.has(table) || !allowedDateFields.has(dateField)) {
    throw new Error('Unsupported normalized dashboard source');
  }

  const keepOpen = Array.isArray(openStatuses) && openStatuses.length > 0;
  const openClause = keepOpen
    ? `OR REGEXP_REPLACE(LOWER(BTRIM(COALESCE(status, ''))), '[[:space:]-]+', '_', 'g') = ANY($5::text[])`
    : '';
  const receiptLinkedClause = includeReceiptLinked && table === 'purchase_orders'
    ? `OR id IN (
        SELECT receipt.purchase_order_id
          FROM goods_receipts receipt
         WHERE receipt.site_id = ANY($1::text[])
           AND receipt.receipt_date BETWEEN $2::date AND $3::date
      )`
    : '';
  const requestedMaximum = Math.min(MAX_SOURCE_ROWS, Math.max(SOURCE_PAGE_SIZE, Number(limit) || MAX_SOURCE_ROWS));
  const records = [];
  while (records.length <= requestedMaximum) {
    const pageLimit = Math.min(SOURCE_PAGE_SIZE, requestedMaximum + 1 - records.length);
    const parameters = [[...siteIds], startDate, endDate, pageLimit];
    if (keepOpen) parameters.push(openStatuses.map(normalizeOpenStatus));
    parameters.push(records.length);
    const offsetParameter = `$${parameters.length}`;
    const headerResult = await pool.query(
      `SELECT *
        FROM ${table}
        WHERE site_id = ANY($1::text[])
          AND (${dateField} BETWEEN $2::date AND $3::date ${openClause} ${receiptLinkedClause})
        ORDER BY ${dateField} DESC, created_at DESC, id ASC
        LIMIT $4::integer
        OFFSET ${offsetParameter}::integer`,
      parameters
    );
    records.push(...headerResult.rows);
    if (records.length > requestedMaximum) {
      const error = httpError(503, `${table} volume exceeds the safe dashboard query limit; use an aggregated reporting source`);
      error.code = 'MANAGEMENT_DASHBOARD_SOURCE_LIMIT';
      throw error;
    }
    if (headerResult.rows.length < pageLimit) break;
  }
  return records;
}

function resolveSelectedScope(scope, selectedSiteId) {
  if (!selectedSiteId) return new Set(scope.accessibleSiteIds);
  if (!scope.accessibleSiteIds.has(selectedSiteId)) {
    throw httpError(403, 'You do not have access to the selected location');
  }
  const descendants = collectDescendantIds(selectedSiteId, scope.graph);
  return new Set([...descendants].filter((id) => scope.accessibleSiteIds.has(id)));
}

function inventoryRiskByLocation(riskRows, sites, locationId) {
  const children = new Map();
  sites.forEach((site) => {
    const parentId = site.parent_site_id ? String(site.parent_site_id) : null;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(String(site.id));
  });
  const descendants = new Set();
  const queue = [String(locationId)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || descendants.has(current)) continue;
    descendants.add(current);
    (children.get(current) || []).forEach((childId) => queue.push(childId));
  }
  return riskRows.reduce((sum, row) => (
    descendants.has(String(row.site_id)) ? sum + row.risk_count : sum
  ), 0);
}

function applyInventoryRiskCounts(snapshot, riskRows, sites) {
  const totalRisk = riskRows.reduce((sum, row) => sum + row.risk_count, 0);
  const oldTotal = Number(snapshot?.metrics?.stock_risk) || 0;
  snapshot.metrics.stock_risk = totalRisk;
  snapshot.metrics.open_exceptions = Math.max(
    0,
    (Number(snapshot.metrics.open_exceptions) || 0) - oldTotal + totalRisk
  );

  (snapshot.actions || []).forEach((action) => {
    if (action.key === 'inventory') action.count = totalRisk;
  });
  (snapshot.locations || []).forEach((location) => {
    const previous = Number(location.stock_risk) || 0;
    const next = inventoryRiskByLocation(riskRows, sites, location.id);
    location.stock_risk = next;
    location.exceptions = Math.max(0, (Number(location.exceptions) || 0) - previous + next);
    if (location.exceptions === 0) {
      location.due = 'No priority';
      location.status = 'On Track';
    } else if (String(location.status || '').toLowerCase() === 'on track') {
      location.due = 'Monitor';
      location.status = 'Review';
    }
  });
  return snapshot;
}

function pruneSnapshotCache(now = Date.now()) {
  snapshotCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) snapshotCache.delete(key);
  });
  while (snapshotCache.size >= SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = snapshotCache.keys().next().value;
    if (oldestKey === undefined) break;
    snapshotCache.delete(oldestKey);
  }
}

function snapshotCacheKey({
  view,
  date,
  rangeStart,
  rangeEnd,
  aggregateRange,
  selectedSiteId,
  accessibleSiteIds
}) {
  return JSON.stringify([
    view,
    date,
    rangeStart || null,
    rangeEnd || null,
    Boolean(aggregateRange),
    selectedSiteId || null,
    [...accessibleSiteIds].map(String).sort()
  ]);
}

async function withSnapshotCache(key, loader) {
  if (SNAPSHOT_CACHE_TTL_MS <= 0) return loader();
  const now = Date.now();
  const cached = snapshotCache.get(key);
  if (cached?.promise) return cached.promise;
  if (cached?.expiresAt > now) return cached.value ?? cached.promise;

  pruneSnapshotCache(now);
  const promise = Promise.resolve().then(loader);
  snapshotCache.set(key, { promise, value: null, expiresAt: now + SNAPSHOT_CACHE_TTL_MS });
  try {
    const value = await promise;
    if (snapshotCache.get(key)?.promise === promise) {
      snapshotCache.set(key, {
        promise: null,
        value,
        expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS
      });
    }
    return value;
  } catch (error) {
    if (snapshotCache.get(key)?.promise === promise) snapshotCache.delete(key);
    throw error;
  }
}

async function loadManagementDashboardSnapshot({
  user,
  view,
  date,
  rangeStart,
  rangeEnd,
  aggregateRange,
  selectedSiteId,
  selectedSiteIds,
  accessibleSites,
  selectedSites,
  scope
}) {

  const [
    productionRaw,
    foodWasteRaw,
    inventoryRiskRows,
    budgetRaw,
    menuPlanRaw,
    attendanceRaw,
    staffShiftRaw,
    qualityRaw,
    purchaseRequests,
    purchaseOrders,
    goodsReceipts
  ] = await Promise.all([
    listDatedDocuments({
      entity: 'Production',
      dateFields: ['production_date', 'planned_date', 'date'],
      startDate: rangeStart,
      endDate: rangeEnd,
      siteIds: selectedSiteIds,
      openStatusFields: ['status'],
      openStatuses: APPROVAL_OPEN_STATUSES
    }),
    listDatedDocuments({
      entity: 'FoodWaste',
      dateFields: ['waste_date', 'served_at', 'created_date'],
      startDate: rangeStart,
      endDate: rangeEnd,
      siteIds: selectedSiteIds,
      openStatusFields: ['approval_status', 'status'],
      openStatuses: APPROVAL_OPEN_STATUSES
    }),
    listInventoryRiskCounts(selectedSiteIds),
    listCurrentDocuments('Budget', selectedSiteIds, { sort: '-start_date' }),
    listDatedDocuments({
      entity: 'MenuPlan',
      dateFields: ['plan_date', 'event_date'],
      startDate: rangeStart,
      endDate: rangeEnd,
      siteIds: selectedSiteIds,
      openStatusFields: ['approval_status', 'status'],
      openStatuses: APPROVAL_OPEN_STATUSES
    }),
    listDatedDocuments({
      entity: 'AttendanceRecord',
      dateFields: ['shift_date', 'attendance_date', 'marked_at', 'created_date'],
      startDate: rangeStart,
      endDate: rangeEnd,
      siteIds: selectedSiteIds,
      openStatusFields: ['approval_status'],
      openStatuses: APPROVAL_OPEN_STATUSES
    }),
    listDatedDocuments({
      entity: 'StaffShift',
      dateFields: ['shift_date', 'created_date'],
      startDate: rangeStart,
      endDate: rangeEnd,
      siteIds: selectedSiteIds
    }),
    listDatedDocuments({
      entity: 'QualityControl',
      dateFields: ['inspection_date', 'created_date'],
      startDate: rangeStart,
      endDate: rangeEnd,
      siteIds: selectedSiteIds
    }),
    listNormalizedRows({
      table: 'purchase_requests',
      dateField: 'request_date',
      siteIds: selectedSiteIds,
      startDate: rangeStart,
      endDate: rangeEnd,
      openStatuses: PURCHASE_REQUEST_OPEN_STATUSES
    }),
    listNormalizedRows({
      table: 'purchase_orders',
      dateField: 'order_date',
      siteIds: selectedSiteIds,
      startDate: rangeStart,
      endDate: rangeEnd,
      openStatuses: PURCHASE_ORDER_OPEN_STATUSES,
      includeReceiptLinked: true
    }),
    listNormalizedRows({
      table: 'goods_receipts',
      dateField: 'receipt_date',
      siteIds: selectedSiteIds,
      startDate: rangeStart,
      endDate: rangeEnd
    })
  ]);

  const production = scopeRecords(user, 'Production', productionRaw, scope, selectedSiteIds);
  const foodWaste = scopeRecords(user, 'FoodWaste', foodWasteRaw, scope, selectedSiteIds);
  const budgets = filterBySelectedSites(budgetRaw, selectedSiteIds);
  const menuPlans = scopeRecords(user, 'MenuPlan', menuPlanRaw, scope, selectedSiteIds);
  const attendanceRecords = scopeRecords(user, 'AttendanceRecord', attendanceRaw, scope, selectedSiteIds);
  const staffShifts = scopeRecords(user, 'StaffShift', staffShiftRaw, scope, selectedSiteIds);
  const qualityControls = scopeRecords(user, 'QualityControl', qualityRaw, scope, selectedSiteIds);

  const snapshot = buildManagementDashboardSnapshot({
    view,
    date,
    rangeStart,
    rangeEnd,
    aggregateRange,
    ...(aggregateRange ? { startDate: rangeStart, endDate: rangeEnd } : {}),
    selectedSiteId,
    selectedSiteIds: [...selectedSiteIds],
    sites: accessibleSites,
    selectedSites,
    production,
    foodWaste,
    inventory: [],
    budgets,
    menuPlans,
    materialRequests: [],
    attendanceRecords,
    staffShifts,
    qualityControls,
    purchaseRequests,
    purchaseOrders,
    goodsReceipts
  });
  return applyInventoryRiskCounts(snapshot, inventoryRiskRows, accessibleSites);
}

export async function getManagementDashboardSnapshot(user, filters = {}) {
  const view = assertManagementDashboardViewAccess(user, filters.view);
  const {
    date,
    rangeStart,
    rangeEnd,
    aggregateRange
  } = resolveDateSelection(filters);
  let selectedSiteId = String(filters.site_id || filters.siteId || '').trim() || null;
  const scope = await getLocationScope(user);
  const accessibleSites = (scope.sites || []).filter((site) => scope.accessibleSiteIds.has(String(site.id)));

  if (view === DASHBOARD_VIEWS.PROJECT_MANAGER && !selectedSiteId) {
    selectedSiteId = selectDefaultProjectScope({
      user,
      sites: accessibleSites,
      accessibleSiteIds: scope.accessibleSiteIds
    });
    if (!selectedSiteId) {
      throw httpError(400, 'No authorized project or operational location is assigned to this user');
    }
  }

  if (selectedSiteId && !scope.graph.byId.has(selectedSiteId)) {
    // Avoid disclosing whether an inaccessible location exists.
    if (!scope.unrestricted) throw httpError(403, 'You do not have access to the selected location');
    throw httpError(404, 'Selected location was not found');
  }

  const selectedSiteIds = resolveSelectedScope(scope, selectedSiteId);
  const selectedSites = accessibleSites.filter((site) => selectedSiteIds.has(String(site.id)));
  const cacheKey = snapshotCacheKey({
    view,
    date,
    rangeStart,
    rangeEnd,
    aggregateRange,
    selectedSiteId,
    accessibleSiteIds: scope.accessibleSiteIds
  });

  return withSnapshotCache(cacheKey, () => loadManagementDashboardSnapshot({
    user,
    view,
    date,
    rangeStart,
    rangeEnd,
    aggregateRange,
    selectedSiteId,
    selectedSiteIds,
    accessibleSites,
    selectedSites,
    scope
  }));
}

export const managementDashboardInternals = {
  normalizeDate,
  normalizeOpenStatus,
  resolveDateSelection,
  inclusiveRangeDays,
  collectDescendantIds,
  filterBySelectedSites,
  applyInventoryRiskCounts,
  snapshotCacheKey
};
