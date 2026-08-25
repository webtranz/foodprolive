import {
  createDocument,
  findDocument,
  listDocuments,
  listDocumentsPage,
  updateDocument
} from './db.js';
import { listPurchaseOrders, listSupplierInvoices } from './procurement.js';
import {
  getInventoryValuationReport,
  getStockMovementReport,
  getStockOnHandReport
} from './inventory.js';
import { getLocationScope } from './locationScope.js';
import { calculateProductionIngredientCost } from '../shared/ingredientUnits.js';
import {
  getD365ImportLogDetails,
  importD365Ingredients,
  importD365Inventory,
  previewD365InventoryImport,
  retryD365ImportLog
} from './erpInventoryImport.js';

const nowIso = () => new Date().toISOString();
const ROW_EXPORT_TRANSPORTS = new Set(['csv', 'excel', 'preview']);

const D365_MODULE_CONTRACTS = {
  po_api: {
    apiName: 'PO API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: ['PurchTable', 'PurchLine', 'LogisticsPostalAddressBaseEntity', 'VendPackingSlipJour', 'InventDim', 'ReleasedProduct'],
    trigger: 'Date and optional PurchID filters retrieve updated and confirmed purchase orders from D365.'
  },
  warehouse_project_api: {
    apiName: 'Warehouse and Project API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: ['InventLocation', 'ProjTable'],
    trigger: 'Scheduled batch job keeps activated warehouses and project master data synchronized.'
  },
  movement_api: {
    apiName: 'Movement / Issuance Information API',
    direction: 'App -> D365',
    method: 'POST',
    entities: ['InventJournalTable', 'InventJournalTrans'],
    trigger: 'Application posts movement and issuance journals so D365 updates inventory.',
    requiredFields: ['date_time', 'item_id', 'quantity', 'unit', 'transaction_type'],
    valueFields: ['unit_cost', 'total_cost'],
    sourceFields: ['source', 'source_type', 'reason_code']
  },
  inventory_sync_api: {
    apiName: 'Inventory Sync API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: ['InventSum', 'InventOnHand'],
    trigger: 'Triggered on D365 inventory changes and before application-side transactional posting.',
    quantitySemantics: ['receipt', 'snapshot'],
    requiredFields: ['item_id', 'warehouse_id', 'quantity', 'unit'],
    optionalFields: [
      'item_name', 'batch_number', 'stock_date', 'expiry_date', 'unit_cost',
      'external_event_id', 'external_line_id', 'ordered_in_total', 'on_order_reserved'
    ]
  },
  uom_api: {
    apiName: 'Unit of Measure API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: ['UnitOfMeasureConversionStandard'],
    trigger: 'Triggered automatically whenever unit-of-measure conversion figures are updated in D365.'
  }
};

const D365_DEFAULT_MAPPING = {
  po_api: {
    'PO Number': 'po_number',
    'Vendor Account': 'vendor_account',
    'PO Created DateTime': 'po_created_datetime',
    'PO Modified DateTime': 'po_modified_datetime',
    'PO Status': 'po_status',
    'Inventory Dimension ID': 'inventory_dimension_id',
    'Item ID': 'item_id',
    'Delivery Date': 'delivery_date',
    'Purchase Unit': 'purchase_unit',
    'Quantity Ordered': 'quantity_ordered',
    'Item Name': 'item_name'
  },
  warehouse_project_api: {
    'Record Type': 'record_type',
    'Site ID': 'site_id',
    'Warehouse ID': 'warehouse_id',
    'Warehouse Name': 'warehouse_name',
    'Project ID': 'project_id',
    'Project Name': 'project_name'
  },
  movement_api: {
    'Date & Time': 'date_time',
    'Item ID': 'item_id',
    Quantity: 'quantity',
    'Movement Direction': 'movement_direction',
    Unit: 'unit',
    'Transaction Type': 'transaction_type',
    Source: 'source',
    'Source Type': 'source_type',
    'Reason Code': 'reason_code',
    'Unit Cost': 'unit_cost',
    'Total Cost': 'total_cost',
    'Originating Warehouse': 'originating_warehouse',
    'D365 Project Code': 'd365_project_code',
    Activity: 'activity',
    'Destination Warehouse': 'destination_warehouse',
    'Confirmation / Error': 'confirmation_or_error'
  },
  inventory_sync_api: {
    'Item ID': 'item_id',
    'Item Name': 'item_name',
    'Warehouse ID': 'warehouse_id',
    'Available Quantity': 'available_quantity',
    'Received Quantity': 'received_quantity',
    Unit: 'unit',
    'Batch Number': 'batch_number',
    'Stock Date': 'stock_date',
    'Expiry Date': 'expiry_date',
    'Unit Cost': 'unit_cost',
    'External Event ID': 'external_event_id',
    'External Line ID': 'external_line_id',
    'Ordered in Total': 'ordered_in_total',
    'On Order (Reserved)': 'on_order_reserved'
  },
  uom_api: {
    'Item ID': 'item_id',
    Unit1: 'unit1',
    Unit2: 'unit2',
    Factor: 'factor',
    Numerator: 'numerator',
    Denominator: 'denominator'
  }
};

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeDateTime(value) {
  if (!value) return nowIso();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
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

function mapInboundFields(row, mapping = {}) {
  return Object.entries(mapping || {}).reduce((mapped, [externalField, foodProField]) => {
    if (row?.[externalField] !== undefined && row?.[externalField] !== null) {
      mapped[foodProField] = row[externalField];
    }
    return mapped;
  }, { ...(row || {}) });
}

function mappingForModule(config, moduleKey) {
  return config?.data_mapping?.[moduleKey] || D365_DEFAULT_MAPPING[moduleKey] || {};
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

function recordsFromD365Response(responsePayload) {
  if (Array.isArray(responsePayload)) return responsePayload;
  if (Array.isArray(responsePayload?.records)) return responsePayload.records;
  if (Array.isArray(responsePayload?.data)) return responsePayload.data;
  if (Array.isArray(responsePayload?.value)) return responsePayload.value;
  if (Array.isArray(responsePayload?.data?.records)) return responsePayload.data.records;
  if (Array.isArray(responsePayload?.data?.value)) return responsePayload.data.value;
  return [];
}

async function pullD365InventoryRecords(options = {}) {
  const configId = options.configId || options.config_id || null;
  const config = await getActiveConfig(configId);
  if (!config?.api_endpoint) {
    const error = new Error('D365 API endpoint is not configured');
    error.status = 400;
    throw error;
  }

  const mode = String(options.mode || options.quantity_semantics || 'snapshot').trim().toLowerCase();
  if (!['receipt', 'snapshot'].includes(mode)) {
    const error = new Error('D365 inventory mode must be receipt or snapshot');
    error.status = 400;
    throw error;
  }

  let endpoint;
  try {
    endpoint = new URL(config.api_endpoint);
  } catch {
    const error = new Error('D365 API endpoint must be a valid absolute URL');
    error.status = 400;
    throw error;
  }
  endpoint.searchParams.set('module', 'inventory_sync_api');
  endpoint.searchParams.set('mode', mode);
  [
    ['warehouse_id', options.warehouse_id || options.warehouseId],
    ['start_date', options.start_date || options.startDate],
    ['end_date', options.end_date || options.endDate],
    ['sync_id', options.sync_id || options.syncId]
  ].forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      endpoint.searchParams.set(key, String(value));
    }
  });

  const headers = {
    Accept: 'application/json',
    ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {})
  };
  const maxPages = Math.min(100, Math.max(1, Math.trunc(Number(options.max_pages) || 50)));
  const rawRecords = [];
  let currentEndpoint = endpoint;
  let responsePayload = null;
  let firstResponsePayload = null;
  let pagesPulled = 0;
  let nextLink = null;

  do {
    const response = await fetch(currentEndpoint, { method: 'GET', headers });
    responsePayload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(responsePayload?.message || `D365 inventory pull failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!firstResponsePayload) firstResponsePayload = responsePayload;
    rawRecords.push(...recordsFromD365Response(responsePayload));
    pagesPulled += 1;
    nextLink = responsePayload?.next_link
      || responsePayload?.['@odata.nextLink']
      || responsePayload?.data?.next_link
      || responsePayload?.data?.['@odata.nextLink']
      || null;
    if (!nextLink) break;
    if (pagesPulled >= maxPages) {
      const error = new Error(`D365 inventory pull exceeded the ${maxPages}-page safety limit`);
      error.status = 502;
      throw error;
    }
    const nextEndpoint = new URL(nextLink, currentEndpoint);
    if (nextEndpoint.origin !== endpoint.origin) {
      const error = new Error('D365 pagination link changed origin and was rejected');
      error.status = 502;
      throw error;
    }
    currentEndpoint = nextEndpoint;
  } while (nextLink);

  const mapping = mappingForModule(config, 'inventory_sync_api');
  const receivedAt = nowIso();
  const syncId = String(
    options.sync_id
      || options.syncId
      || firstResponsePayload?.sync_id
      || firstResponsePayload?.syncId
      || `d365-pull-${receivedAt.replace(/[^0-9]/g, '')}`
  );
  return {
    config_id: config.id,
    source_system: 'd365',
    sync_id: syncId,
    quantity_semantics: mode,
    received_at: receivedAt,
    records: rawRecords.map((row) => mapInboundFields(row, mapping)),
    total_count: Number(
      firstResponsePayload?.total_count
        ?? firstResponsePayload?.['@odata.count']
        ?? rawRecords.length
    ),
    pages_pulled: pagesPulled,
    next_link: null
  };
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
              return sum + calculateProductionIngredientCost(
                ingredient,
                ingredientMap.get(ingredient.ingredient_id)
              );
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

async function buildD365PurchaseOrderRows({ startDate, endDate, locationId, scope }) {
  const orders = await listPurchaseOrders();
  const scopedOrders = filterByLocation(
    filterByScope(
      orders.filter((order) => matchesDate(order.order_date, startDate, endDate)),
      scope
    ),
    locationId
  );

  return scopedOrders.flatMap((order) => {
    const items = normalizeArray(order.items);
    const baseRow = {
      po_number: order.po_number,
      vendor_account: order.vendor_account || order.supplier_id || order.supplier_name || '',
      po_created_datetime: normalizeDateTime(order.created_at || order.order_date),
      po_modified_datetime: normalizeDateTime(order.updated_at || order.approved_at || order.order_date),
      po_status: order.status || '',
      site_id: order.site_id || '',
      site_name: order.site_name || ''
    };

    if (items.length === 0) {
      return [{
        ...baseRow,
        inventory_dimension_id: order.inventory_dimension_id || '',
        item_id: '',
        delivery_date: order.expected_delivery_date || '',
        purchase_unit: '',
        quantity_ordered: 0,
        item_name: ''
      }];
    }

    return items.map((item) => ({
      ...baseRow,
      inventory_dimension_id: item.inventory_dimension_id || item.invent_dim_id || '',
      item_id: item.d365_item_id || item.ingredient_id || '',
      delivery_date: item.delivery_date || order.expected_delivery_date || '',
      purchase_unit: item.unit || '',
      quantity_ordered: Number(safeNumber(item.ordered_quantity || item.quantity).toFixed(3)),
      item_name: item.ingredient_name || item.item_name || ''
    }));
  });
}

async function buildD365WarehouseProjectRows({ locationId, scope }) {
  const sites = await listDocuments('Site', { sort: 'name', limit: 5000 });
  const scopedSites = filterByLocation(
    scope?.unrestricted
      ? sites
      : sites.filter((site) => scope?.accessibleTreeIds?.has(String(site.id))),
    locationId,
    ['id', 'parent_site_id']
  );
  const rows = [];

  scopedSites
    .filter((site) => site.type === 'warehouse' || site.type === 'store')
    .forEach((site) => {
      rows.push({
        record_type: 'Warehouse',
        site_id: site.parent_site_id || site.project_code || site.id,
        warehouse_id: site.project_code || site.id,
        warehouse_name: site.name,
        project_id: '',
        project_name: ''
      });
    });

  scopedSites
    .filter((site) => site.project_code)
    .forEach((site) => {
      rows.push({
        record_type: 'Project',
        site_id: site.id,
        warehouse_id: '',
        warehouse_name: '',
        project_id: site.project_code,
        project_name: site.name
      });
    });

  return rows;
}

export function buildD365MovementExportRows({
  movements = [],
  ingredients = [],
  sites = [],
  scope = { unrestricted: true }
} = {}) {
  const ingredientsById = new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient]));
  const sitesById = new Map(sites.map((site) => [String(site.id), site]));
  const warehouseId = (siteId) => {
    if (!siteId) return '';
    return sitesById.get(String(siteId))?.d365_warehouse_id || String(siteId);
  };
  return filterByScope(movements, scope)
    .filter((movement) => [
      'issuance',
      'pos_sale',
      'transfer_out',
      'production_use',
      'production_commitment',
      'production_return',
      'production_release',
      'adjustment',
      'waste'
    ].includes(String(movement.transaction_type || '')))
    .map((movement) => {
      const ingredient = ingredientsById.get(String(movement.ingredient_id || ''));
      const quantity = safeNumber(movement.quantity);
      const unitCost = Math.abs(safeNumber(movement.unit_cost));
      const totalCost = Math.abs(safeNumber(movement.total_cost, Math.abs(quantity) * unitCost));
      return {
        date_time: normalizeDateTime(movement.transaction_date || movement.created_date),
        item_id: movement.d365_item_id
          || ingredient?.d365_item_id
          || ingredient?.item_code
          || movement.ingredient_id
          || '',
        quantity: Number(Math.abs(quantity).toFixed(3)),
        movement_direction: quantity < 0 ? 'issue' : 'return',
        unit: movement.unit || ingredient?.unit || '',
        transaction_type: movement.transaction_type || '',
        source: movement.source || '',
        source_type: movement.source_type || '',
        reason_code: movement.reason_code || '',
        unit_cost: Number(unitCost.toFixed(4)),
        total_cost: Number(totalCost.toFixed(2)),
        originating_warehouse: warehouseId(movement.from_site_id || movement.site_id),
        d365_project_code: movement.project_code || movement.site_project_code || '',
        activity: movement.reason_code || movement.transaction_type || '',
        destination_warehouse: warehouseId(movement.to_site_id),
        confirmation_or_error: movement.d365_response || movement.status || 'Pending'
      };
    });
}

async function buildD365MovementRows({ startDate, endDate, locationId, scope }) {
  const [movements, ingredients, sites] = await Promise.all([
    getStockMovementReport({ siteId: locationId, dateFrom: startDate, dateTo: endDate }),
    listDocuments('Ingredient', { limit: 10000 }),
    listDocuments('Site', { limit: 10000 })
  ]);
  return buildD365MovementExportRows({ movements, ingredients, sites, scope });
}

async function buildD365InventoryRows({ locationId, category, scope }) {
  const rows = await getStockOnHandReport();
  return filterByCategory(
    filterByLocation(
      filterByScope(rows, scope),
      locationId
    ),
    category
  ).map((item) => ({
    item_id: item.d365_item_id || item.ingredient_id || item.id || '',
    item_name: item.ingredient_name || item.name || '',
    available_quantity: Number(safeNumber(item.available_quantity ?? item.quantity).toFixed(3)),
    unit: item.unit || '',
    ordered_in_total: Number(safeNumber(item.ordered_quantity || item.ordered_in_total).toFixed(3)),
    on_order_reserved: Number(safeNumber(item.reserved_quantity || item.on_order_reserved).toFixed(3))
  }));
}

async function buildD365UomRows({ category }) {
  const ingredients = await listDocuments('Ingredient', { sort: 'name', limit: 5000 });
  return filterByCategory(ingredients, category).flatMap((ingredient) => {
    const conversions = normalizeArray(ingredient.uom_conversions || ingredient.unit_conversions);
    if (conversions.length === 0) {
      return [{
        item_id: ingredient.d365_item_id || ingredient.id,
        unit1: ingredient.unit || '',
        unit2: ingredient.unit || '',
        factor: 1,
        numerator: 1,
        denominator: 1
      }];
    }

    return conversions.map((conversion) => ({
      item_id: ingredient.d365_item_id || ingredient.id,
      unit1: conversion.unit1 || conversion.from_unit || ingredient.unit || '',
      unit2: conversion.unit2 || conversion.to_unit || '',
      factor: Number(safeNumber(conversion.factor, 1).toFixed(6)),
      numerator: Number(safeNumber(conversion.numerator, 1).toFixed(6)),
      denominator: Number(safeNumber(conversion.denominator, 1).toFixed(6))
    }));
  });
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
    case 'po_api':
      return buildD365PurchaseOrderRows({ startDate, endDate, locationId, scope });
    case 'warehouse_project_api':
      return buildD365WarehouseProjectRows({ locationId, scope });
    case 'movement_api':
      return buildD365MovementRows({ startDate, endDate, locationId, scope });
    case 'inventory_sync_api':
      return buildD365InventoryRows({ locationId, category, scope });
    case 'uom_api':
      return buildD365UomRows({ category });
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
  const contract = D365_MODULE_CONTRACTS[moduleKey] || null;
  const mapping = mappingForModule(config, moduleKey);
  const mappedRows = rows.map((row) => mapFields(row, mapping));
  const requestPayload = {
    moduleKey,
    transport,
    startDate,
    endDate,
    locationId,
    category,
    configId: config?.id || null,
    contract
  };

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
        api_name: contract?.apiName || moduleKey,
        direction: contract?.direction || 'App -> ERP',
        method: contract?.method || 'POST',
        d365_entities: contract?.entities || [],
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

  const scope = await getLocationScope(user);
  if (!scope?.unrestricted) {
    const accessibleSiteIds = new Set([...(scope?.accessibleSiteIds || [])].map(String));
    const originalSiteIds = [...new Set([
      ...normalizeArray(existingLog.site_ids),
      existingLog.site_id
    ].filter(Boolean).map(String))];
    if (originalSiteIds.length === 0 || originalSiteIds.some((siteId) => !accessibleSiteIds.has(siteId))) {
      const error = new Error('You cannot retry an integration log outside your accessible location scope');
      error.status = 403;
      throw error;
    }
  }

  if (String(existingLog.direction || '').toLowerCase() === 'inbound') {
    try {
      const response = await retryD365ImportLog(existingLog, user, { scope });
      await updateDocument('ERPIntegrationLog', existingLog.id, {
        status: 'retried',
        retry_count: safeNumber(existingLog.retry_count) + 1,
        retried_at: nowIso(),
        last_retry_status: response.log?.status || 'success',
        last_retry_log_id: response.log?.id || null
      });
      return response;
    } catch (error) {
      await updateDocument('ERPIntegrationLog', existingLog.id, {
        retry_count: safeNumber(existingLog.retry_count) + 1,
        retried_at: nowIso(),
        last_retry_status: 'failed',
        last_retry_error: error.message || 'Inbound D365 retry failed'
      });
      throw error;
    }
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

function summarizeInboundLogRows(rows = []) {
  return {
    total_rows: rows.length,
    applied_rows: rows.filter((row) => row.status === 'applied').length,
    skipped_rows: rows.filter((row) => row.status === 'skipped_duplicate').length,
    failed_rows: rows.filter((row) => row.status === 'failed').length
  };
}

function sanitizeErpLogSummary(log = {}, scope = null) {
  const requestPayload = { ...(log.request_payload || {}) };
  const responsePayload = { ...(log.response_payload || {}) };
  delete requestPayload.records;
  delete responsePayload.rows;
  const sanitized = {
    ...log,
    request_payload: requestPayload,
    response_payload: responsePayload
  };
  if (String(log.direction || '').toLowerCase() === 'inbound' && !scope?.unrestricted) {
    const accessibleSiteIds = new Set([...(scope?.accessibleSiteIds || [])].map(String));
    const scopedRows = normalizeArray(log.response_payload?.rows).filter(
      (row) => row.site_id && accessibleSiteIds.has(String(row.site_id))
    );
    const summary = summarizeInboundLogRows(scopedRows);
    const siteIds = [...new Set(scopedRows.map((row) => String(row.site_id)))];
    sanitized.records_count = summary.total_rows;
    sanitized.applied_count = summary.applied_rows;
    sanitized.skipped_count = summary.skipped_rows;
    sanitized.failed_count = summary.failed_rows;
    sanitized.site_id = siteIds.length === 1 ? siteIds[0] : null;
    sanitized.site_ids = siteIds;
    sanitized.response_payload.summary = summary;
  }
  return sanitized;
}

async function listErpLogs(scope, dependencyOverrides = {}) {
  const pageLoader = dependencyOverrides.listDocumentsPage || listDocumentsPage;
  const location = scope?.unrestricted
    ? null
    : {
      unrestricted: false,
      accessibleSiteIds: [...(scope?.accessibleSiteIds || [])].map(String)
    };
  const maxResults = 500;
  const pageSize = 200;
  const logs = [];
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  while (logs.length < maxResults && offset < totalCount) {
    const page = await pageLoader('ERPIntegrationLog', {
      sort: '-attempted_at',
      limit: Math.min(pageSize, maxResults - logs.length),
      offset,
      location
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    logs.push(...items);
    totalCount = Number.isFinite(Number(page?.total_count))
      ? Math.max(0, Number(page.total_count))
      : offset + items.length;
    if (items.length === 0) break;
    offset += items.length;
  }

  return logs.slice(0, maxResults).map((log) => sanitizeErpLogSummary(log, scope));
}

export {
  exportToErp,
  getD365ImportLogDetails,
  getD365ImportLogDetails as getLogDetails,
  importD365Ingredients,
  importD365Inventory,
  importD365Inventory as importInventory,
  previewD365InventoryImport,
  previewD365InventoryImport as previewInventoryImport,
  pullD365InventoryRecords,
  retryErpSync,
  listErpLogs
};
