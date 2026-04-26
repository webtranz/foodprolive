import { createDocument, findDocument, listDocuments, updateDocument } from './db.js';
import { listPurchaseOrders, listSupplierInvoices } from './procurement.js';
import { getInventoryValuationReport } from './inventory.js';
import { getLocationScope } from './locationScope.js';

const nowIso = () => new Date().toISOString();
const ROW_EXPORT_TRANSPORTS = new Set(['csv', 'excel', 'preview']);

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function matchesDate(value, startDate, endDate) {
  if (!value) return true;
  if (startDate && String(value) < startDate) return false;
  if (endDate && String(value) > endDate) return false;
  return true;
}

function filterByScope(rows = [], scope, fields = ['site_id']) {
  if (scope?.unrestricted) return rows;
  return rows.filter((row) => fields
    .map((field) => row?.[field])
    .filter(Boolean)
    .every((siteId) => scope.accessibleSiteIds.has(String(siteId))));
}

function filterByLocation(rows = [], locationId, fields = ['site_id']) {
  if (!locationId) return rows;
  return rows.filter((row) => fields.some((field) => String(row?.[field] || '') === String(locationId)));
}

function filterByCategory(rows = [], category) {
  if (!category) return rows;
  return rows.filter((row) => String(row.category || '') === String(category));
}

function mapFields(row, mapping = {}) {
  const mappingEntries = Object.entries(mapping || {});
  if (mappingEntries.length === 0) {
    return row;
  }

  return mappingEntries.reduce((accumulator, [externalField, foodProField]) => {
    accumulator[externalField] = row?.[foodProField] ?? null;
    return accumulator;
  }, {});
}

async function getActiveConfig(configId = null) {
  if (configId) {
    return findDocument('ERPIntegrationConfig', configId);
  }

  const configs = await listDocuments('ERPIntegrationConfig', {
    filters: { is_active: true },
    sort: '-updated_date',
    limit: 1
  });
  return configs[0] || null;
}

async function buildFoodCostRows({ startDate, endDate, locationId, category, scope }) {
  const [productions, ingredients, recipes] = await Promise.all([
    listDocuments('Production', { sort: '-production_date', limit: 1000 }),
    listDocuments('Ingredient', { sort: 'name', limit: 2000 }),
    listDocuments('Recipe', { sort: 'name', limit: 1000 })
  ]);

  const ingredientMap = new Map(ingredients.map((item) => [item.id, item]));
  const recipeMap = new Map(recipes.map((item) => [item.id, item]));

  return filterByCategory(
    filterByLocation(
      filterByScope(
        productions
          .filter((production) => matchesDate(production.production_date, startDate, endDate))
          .map((production) => {
            const totalCost = (production.ingredients_used || []).reduce((sum, ingredient) => {
              const unitCost = safeNumber(ingredientMap.get(ingredient.ingredient_id)?.cost_per_unit);
              const quantity = safeNumber(ingredient.actual_quantity || ingredient.planned_quantity);
              return sum + (unitCost * quantity);
            }, 0);
            const servings = safeNumber(production.actual_servings || production.target_servings);
            return {
              site_id: production.site_id,
              site_name: production.site_name,
              production_date: production.production_date,
              recipe_id: production.recipe_id,
              recipe_name: production.recipe_name,
              category: production.menu_category || recipeMap.get(production.recipe_id)?.category || '-',
              servings,
              total_food_cost: Number(totalCost.toFixed(2)),
              cost_per_serving: Number((servings > 0 ? totalCost / servings : 0).toFixed(2))
            };
          }),
        scope
      ),
      locationId
    ),
    category
  );
}

async function buildWasteCostRows({ startDate, endDate, locationId, category, scope }) {
  const waste = await listDocuments('FoodWaste', { sort: '-waste_date', limit: 1000 });
  return filterByCategory(
    filterByLocation(
      filterByScope(
        waste
          .filter((entry) => matchesDate(entry.waste_date, startDate, endDate))
          .map((entry) => ({
            site_id: entry.site_id,
            site_name: entry.site_name,
            waste_date: entry.waste_date,
            item_name: entry.ingredient_name || entry.recipe_name || 'Waste Item',
            category: entry.category || '-',
            quantity: Number(safeNumber(entry.quantity).toFixed(2)),
            estimated_cost: Number(safeNumber(entry.estimated_cost).toFixed(2)),
            reason: entry.reason || entry.notes || '-'
          })),
        scope
      ),
      locationId
    ),
    category
  );
}

async function buildPurchaseOrderRows({ startDate, endDate, locationId, scope }) {
  const orders = await listPurchaseOrders();
  return filterByLocation(
    filterByScope(
      orders
        .filter((order) => matchesDate(order.order_date, startDate, endDate))
        .map((order) => ({
          site_id: order.site_id,
          site_name: order.site_name,
          po_number: order.po_number,
          supplier_name: order.supplier_name,
          order_date: order.order_date,
          expected_delivery_date: order.expected_delivery_date,
          total_amount: Number(safeNumber(order.total_amount).toFixed(2)),
          status: order.status,
          item_count: normalizeArray(order.items).length
        })),
      scope
    ),
    locationId
  );
}

async function buildSupplierInvoiceRows({ startDate, endDate, locationId, scope }) {
  const invoices = await listSupplierInvoices();
  return filterByLocation(
    filterByScope(
      invoices
        .filter((invoice) => matchesDate(invoice.invoice_date, startDate, endDate))
        .map((invoice) => ({
          site_id: invoice.site_id,
          site_name: invoice.site_name,
          invoice_number: invoice.invoice_number,
          supplier_name: invoice.supplier_name,
          purchase_order_id: invoice.purchase_order_id,
          invoice_date: invoice.invoice_date,
          due_date: invoice.due_date,
          total_amount: Number(safeNumber(invoice.total_amount).toFixed(2)),
          status: invoice.status
        })),
      scope
    ),
    locationId
  );
}

async function buildInventoryValuationRows({ locationId, category, scope }) {
  const rows = await getInventoryValuationReport();
  return filterByCategory(
    filterByLocation(
      filterByScope(
        rows.map((item) => ({
          site_id: item.site_id,
          site_name: item.site_name,
          ingredient_name: item.ingredient_name,
          category: item.category || '-',
          quantity: Number(safeNumber(item.quantity).toFixed(2)),
          valuation_method: item.valuation_method,
          fifo_value: Number(safeNumber(item.fifo_value).toFixed(2)),
          weighted_average_value: Number(safeNumber(item.weighted_average_value).toFixed(2))
        })),
        scope
      ),
      locationId
    ),
    category
  );
}

async function getExportRows({ moduleKey, startDate, endDate, locationId, category, scope }) {
  switch (moduleKey) {
    case 'purchase_orders':
      return buildPurchaseOrderRows({ startDate, endDate, locationId, scope });
    case 'supplier_invoices':
      return buildSupplierInvoiceRows({ startDate, endDate, locationId, scope });
    case 'inventory_valuation':
      return buildInventoryValuationRows({ locationId, category, scope });
    case 'food_cost_summary':
      return buildFoodCostRows({ startDate, endDate, locationId, category, scope });
    case 'waste_cost_summary':
      return buildWasteCostRows({ startDate, endDate, locationId, category, scope });
    default: {
      const error = new Error('Unsupported ERP export module');
      error.status = 400;
      throw error;
    }
  }
}

async function logIntegrationAttempt({
  config,
  moduleKey,
  transport,
  rows,
  status,
  message,
  actorEmail,
  requestPayload,
  responsePayload,
  retryCount = 0,
  locationId = null
}) {
  return createDocument('ERPIntegrationLog', {
    config_id: config?.id || null,
    provider_name: config?.provider_name || 'Unconfigured',
    module_key: moduleKey,
    transport,
    status,
    message,
    records_count: rows.length,
    site_id: locationId || null,
    site_ids: [...new Set(rows.map((row) => row.site_id).filter(Boolean))],
    request_payload: requestPayload || {},
    response_payload: responsePayload || {},
    retry_count: retryCount,
    attempted_by: actorEmail,
    attempted_at: nowIso()
  });
}

async function exportToErp({
  user,
  configId = null,
  moduleKey,
  transport = 'csv',
  startDate = '',
  endDate = '',
  locationId = '',
  category = ''
}) {
  const scope = await getLocationScope(user);
  const config = await getActiveConfig(configId);
  const rows = await getExportRows({ moduleKey, startDate, endDate, locationId, category, scope });
  const mapping = config?.data_mapping?.[moduleKey] || {};
  const mappedRows = rows.map((row) => mapFields(row, mapping));
  const requestPayload = { moduleKey, transport, startDate, endDate, locationId, category, configId: config?.id || null };

  if (ROW_EXPORT_TRANSPORTS.has(transport)) {
    const log = await logIntegrationAttempt({
      config,
      moduleKey,
      transport,
      rows,
      status: 'success',
      message: `${transport.toUpperCase()} export prepared`,
      actorEmail: user.email,
      requestPayload,
      responsePayload: { preview_count: mappedRows.length },
      locationId
    });

    return {
      rows: mappedRows,
      filename: `${moduleKey}_${startDate || 'all'}_${endDate || 'all'}`,
      log
    };
  }

  if (!config?.api_endpoint) {
    const log = await logIntegrationAttempt({
      config,
      moduleKey,
      transport,
      rows,
      status: 'failed',
      message: 'API endpoint not configured',
      actorEmail: user.email,
      requestPayload,
      responsePayload: {},
      locationId
    });
    const error = new Error('API endpoint not configured');
    error.status = 400;
    error.log = log;
    throw error;
  }

  try {
    const response = await fetch(config.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {})
      },
      body: JSON.stringify({
        provider: config.provider_name,
        module: moduleKey,
        records: mappedRows
      })
    });

    const responsePayload = await response.json().catch(() => ({}));

    if (!response.ok) {
      await logIntegrationAttempt({
        config,
        moduleKey,
        transport,
        rows,
        status: 'failed',
        message: responsePayload.message || `Sync failed with status ${response.status}`,
        actorEmail: user.email,
        requestPayload,
        responsePayload,
        locationId
      });
      const error = new Error(responsePayload.message || 'ERP sync failed');
      error.status = response.status;
      error.alreadyLogged = true;
      throw error;
    }

    const log = await logIntegrationAttempt({
      config,
      moduleKey,
      transport,
      rows,
      status: 'success',
      message: 'API sync completed',
      actorEmail: user.email,
      requestPayload,
      responsePayload,
      locationId
    });

    return {
      rows: mappedRows,
      response: responsePayload,
      log
    };
  } catch (error) {
    if (!error.alreadyLogged) {
      await logIntegrationAttempt({
        config,
        moduleKey,
        transport,
        rows,
        status: 'failed',
        message: error.message || 'ERP sync failed',
        actorEmail: user.email,
        requestPayload,
        responsePayload: {},
        locationId
      });
    }
    throw error;
  }
}

async function retryErpSync(logId, user) {
  const existingLog = await findDocument('ERPIntegrationLog', logId);
  if (!existingLog) {
    const error = new Error('Integration log not found');
    error.status = 404;
    throw error;
  }

  const requestPayload = existingLog.request_payload || {};
  const response = await exportToErp({
    user,
    configId: requestPayload.configId || existingLog.config_id || null,
    moduleKey: requestPayload.moduleKey || existingLog.module_key,
    transport: requestPayload.transport || existingLog.transport,
    startDate: requestPayload.startDate || '',
    endDate: requestPayload.endDate || '',
    locationId: requestPayload.locationId || '',
    category: requestPayload.category || ''
  });

  await updateDocument('ERPIntegrationLog', existingLog.id, {
    status: 'retried',
    retry_count: safeNumber(existingLog.retry_count) + 1,
    retried_at: nowIso(),
    last_retry_status: 'success'
  });

  return response;
}

async function listErpLogs(scope) {
  const logs = await listDocuments('ERPIntegrationLog', { sort: '-attempted_at', limit: 500 });
  if (scope?.unrestricted) return logs;
  return logs.filter((log) => {
    const siteIds = normalizeArray(log.site_ids);
    if (siteIds.length === 0 && !log.site_id) return true;
    return siteIds.some((siteId) => scope.accessibleSiteIds.has(siteId)) || (log.site_id && scope.accessibleSiteIds.has(String(log.site_id)));
  });
}

export {
  exportToErp,
  retryErpSync,
  listErpLogs
};
