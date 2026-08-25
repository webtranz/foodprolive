import {
  convertIngredientQuantity,
  normalizeIngredientUnit
} from './ingredientUnits.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from './siteHierarchy.js';
import { toBusinessDateOnly } from './businessDate.js';

export const D365_QUANTITY_SEMANTICS = Object.freeze({
  RECEIPT: 'receipt',
  SNAPSHOT: 'snapshot'
});

const WEIGHT_UNITS = new Set(['kg', 'g']);
const VOLUME_UNITS = new Set(['l', 'ml']);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizedLookup(value) {
  return normalizeText(value).toLowerCase();
}

function pickValue(row, fields = []) {
  for (const field of fields) {
    if (row?.[field] !== undefined && row?.[field] !== null && row?.[field] !== '') {
      return row[field];
    }
  }
  return undefined;
}

function requireNumber(value, label, options = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (options.minimum !== undefined && numeric < options.minimum) {
    throw new Error(`${label} must be ${options.minimum} or greater`);
  }
  if (options.exclusiveMinimum !== undefined && numeric <= options.exclusiveMinimum) {
    throw new Error(`${label} must be greater than ${options.exclusiveMinimum}`);
  }
  return numeric;
}

function optionalNumber(value, label, fallback = null, options = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  return requireNumber(value, label, options);
}

export function normalizeD365Date(value, fallback = null, label = 'date') {
  const raw = normalizeText(value);
  if (!raw) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsedDateOnly = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(parsedDateOnly.getTime()) && parsedDateOnly.toISOString().slice(0, 10) === raw) {
      return raw;
    }
    throw new Error(`${label} is not a valid date`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is not a valid date`);
  }
  return toBusinessDateOnly(parsed);
}

export function normalizeD365QuantitySemantics(value) {
  const normalized = normalizedLookup(value || D365_QUANTITY_SEMANTICS.RECEIPT);
  if (!Object.values(D365_QUANTITY_SEMANTICS).includes(normalized)) {
    throw new Error('quantity_semantics must be receipt or snapshot');
  }
  return normalized;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Four independent 32-bit lanes keep this browser-safe while providing a
// stable 128-bit identifier for deterministic batches and document IDs.
export function stableD365Hash(value) {
  const text = typeof value === 'string' ? value : stableSerialize(value);
  const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] ^= code + (lane * 97);
      lanes[lane] = Math.imul(lanes[lane], 0x01000193 + (lane * 2)) >>> 0;
      lanes[lane] ^= lanes[lane] >>> (13 + lane);
    }
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

function identifierToken(value, fallback) {
  const token = normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18);
  return token || fallback;
}

export function buildD365RowIdempotencyKey(row, options = {}) {
  const moduleKey = normalizeText(options.moduleKey || 'inventory_sync_api').toLowerCase();
  const semantics = normalizeD365QuantitySemantics(
    options.quantitySemantics || row?.quantity_semantics || D365_QUANTITY_SEMANTICS.RECEIPT
  );
  const explicitEventId = normalizeText(row?.external_event_id || row?.source_document_id);
  const explicitLineId = normalizeText(row?.external_line_id || row?.source_line_id);
  const explicitIdentity = explicitEventId && explicitLineId
    ? { external_event_id: explicitEventId, external_line_id: explicitLineId }
    : null;
  const contentIdentity = {
    item_id: normalizeText(row?.item_id),
    warehouse_id: normalizeText(row?.warehouse_id),
    quantity: Number(row?.quantity),
    unit: normalizeIngredientUnit(row?.unit),
    batch_number: normalizeText(row?.batch_number),
    stock_date: normalizeText(row?.stock_date),
    expiry_date: normalizeText(row?.expiry_date),
    unit_cost: row?.unit_cost === undefined || row?.unit_cost === null || row?.unit_cost === ''
      ? null
      : Number(row.unit_cost),
    external_version: normalizeText(row?.external_version)
  };
  const rowIdentity = explicitIdentity
    ? (semantics === D365_QUANTITY_SEMANTICS.SNAPSHOT
      ? { ...explicitIdentity, snapshot_state: contentIdentity }
      : explicitIdentity)
    : contentIdentity;
  // Receipt identities deliberately survive across sync runs so replaying the
  // same D365 receipt cannot add stock twice. A snapshot is different: it is a
  // reconciliation instruction for a particular sync run. The same snapshot
  // in a later run must be allowed to repair FoodPro drift that happened after
  // the previous run, while a retry of the same run remains idempotent.
  const identity = semantics === D365_QUANTITY_SEMANTICS.SNAPSHOT
    ? {
        sync_id: normalizeText(options.syncId),
        snapshot: rowIdentity
      }
    : rowIdentity;

  return stableD365Hash({
    source_system: normalizeText(options.sourceSystem || 'd365').toLowerCase(),
    module_key: moduleKey,
    quantity_semantics: semantics,
    identity
  });
}

export function generateD365BatchNumber(row, idempotencyKey = '') {
  if (normalizeText(row?.batch_number)) return normalizeText(row.batch_number);
  const date = normalizeText(row?.stock_date).replace(/-/g, '') || 'UNDATED';
  const warehouse = identifierToken(row?.warehouse_id, 'WAREHOUSE');
  const item = identifierToken(row?.item_id, 'ITEM');
  const suffix = normalizeText(idempotencyKey || stableD365Hash(row)).slice(0, 10).toUpperCase();
  return `D365-${date}-${warehouse}-${item}-${suffix}`;
}

export function areD365UnitsCompatible(sourceUnit, targetUnit, ingredient = {}) {
  const source = normalizeIngredientUnit(sourceUnit);
  const target = normalizeIngredientUnit(targetUnit);
  if (!source || !target || source === target) return true;
  if (WEIGHT_UNITS.has(source) && WEIGHT_UNITS.has(target)) return true;
  if (VOLUME_UNITS.has(source) && VOLUME_UNITS.has(target)) return true;

  const base = normalizeIngredientUnit(ingredient?.unit);
  const conversionUnit = normalizeIngredientUnit(ingredient?.conversion_unit);
  const factor = Number(ingredient?.conversion_factor);
  return Number.isFinite(factor)
    && factor > 0
    && ((source === base && target === conversionUnit) || (source === conversionUnit && target === base));
}

export function convertD365Quantity(quantity, sourceUnit, targetUnit, ingredient = {}) {
  if (!areD365UnitsCompatible(sourceUnit, targetUnit, ingredient)) {
    throw new Error(`Cannot convert D365 unit ${sourceUnit || '(blank)'} to ${targetUnit || '(blank)'}`);
  }
  return convertIngredientQuantity(quantity, sourceUnit, targetUnit, ingredient);
}

export function convertD365UnitCost(unitCost, sourceQuantity, convertedQuantity) {
  if (unitCost === undefined || unitCost === null || unitCost === '') return null;
  const cost = Number(unitCost);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error('unit_cost must be zero or greater');
  }
  if (convertedQuantity <= 0) return 0;
  return (Number(sourceQuantity) * cost) / convertedQuantity;
}

export function normalizeD365InventoryRow(input = {}, options = {}) {
  const semantics = normalizeD365QuantitySemantics(options.quantitySemantics || input.quantity_semantics);
  const receivedAt = normalizeD365Date(options.receivedAt || new Date(), null, 'received_at');
  const itemId = normalizeText(pickValue(input, [
    'item_id', 'd365_item_id', 'item_code', 'Item ID', 'ItemId', 'ItemNumber'
  ]));
  const warehouseId = normalizeText(pickValue(input, [
    'warehouse_id', 'invent_location_id', 'site_id', 'Warehouse ID', 'InventLocationId', 'InventLocation'
  ]));
  const unit = normalizeIngredientUnit(pickValue(input, [
    'unit', 'inventory_unit', 'purchase_unit', 'Unit', 'UnitId'
  ]));
  const quantityValue = semantics === D365_QUANTITY_SEMANTICS.RECEIPT
    ? pickValue(input, ['received_quantity', 'quantity', 'receipt_quantity', 'Received Quantity', 'Quantity'])
    : pickValue(input, ['available_quantity', 'quantity', 'on_hand_quantity', 'Available Quantity', 'AvailPhysical']);

  if (!itemId) throw new Error('item_id is required');
  if (!warehouseId) throw new Error('warehouse_id is required');
  if (!unit) throw new Error('unit is required');

  const quantity = requireNumber(
    quantityValue,
    semantics === D365_QUANTITY_SEMANTICS.RECEIPT ? 'received_quantity' : 'available_quantity',
    semantics === D365_QUANTITY_SEMANTICS.RECEIPT ? { exclusiveMinimum: 0 } : { minimum: 0 }
  );
  const stockDate = normalizeD365Date(
    pickValue(input, ['stock_date', 'received_date', 'transaction_date', 'Stock Date', 'ReceiptDate']),
    receivedAt,
    'stock_date'
  );
  const expiryDate = normalizeD365Date(
    pickValue(input, ['expiry_date', 'expiration_date', 'Expiry Date', 'ExpDate']),
    null,
    'expiry_date'
  );
  if (expiryDate && stockDate && expiryDate < stockDate) {
    throw new Error('expiry_date cannot be earlier than stock_date');
  }

  const normalized = {
    item_id: itemId,
    item_name: normalizeText(pickValue(input, ['item_name', 'name', 'Item Name', 'ProductName'])),
    warehouse_id: warehouseId,
    warehouse_name: normalizeText(pickValue(input, ['warehouse_name', 'site_name', 'Warehouse Name'])),
    quantity,
    quantity_semantics: semantics,
    unit,
    unit_cost: optionalNumber(
      pickValue(input, ['unit_cost', 'last_cost', 'cost_per_unit', 'Unit Cost']),
      'unit_cost',
      null,
      { minimum: 0 }
    ),
    batch_number: normalizeText(pickValue(input, ['batch_number', 'lot_number', 'batch_id', 'Batch Number', 'InventBatchId'])),
    stock_date: stockDate,
    expiry_date: expiryDate,
    external_event_id: normalizeText(pickValue(input, [
      'external_event_id', 'source_document_id', 'receipt_id', 'journal_id', 'External Event ID'
    ])),
    external_line_id: normalizeText(pickValue(input, [
      'external_line_id', 'source_line_id', 'transaction_id', 'inventory_dimension_id', 'External Line ID'
    ])),
    external_version: normalizeText(pickValue(input, [
      'external_version', 'source_version', 'row_version', 'modified_at', 'ModifiedDateTime'
    ])),
    ordered_in_total: optionalNumber(
      pickValue(input, ['ordered_in_total', 'ordered_quantity']),
      'ordered_in_total',
      undefined,
      { minimum: 0 }
    ),
    on_order_reserved: optionalNumber(
      pickValue(input, ['on_order_reserved', 'reserved_quantity']),
      'on_order_reserved',
      undefined,
      { minimum: 0 }
    )
  };

  normalized.idempotency_key = buildD365RowIdempotencyKey(normalized, {
    moduleKey: options.moduleKey,
    quantitySemantics: semantics,
    sourceSystem: options.sourceSystem,
    syncId: options.syncId
  });
  normalized.batch_number = generateD365BatchNumber(normalized, normalized.idempotency_key);
  return normalized;
}

export function normalizeD365IngredientRow(input = {}) {
  const itemId = normalizeText(pickValue(input, [
    'item_id', 'd365_item_id', 'item_code', 'Item ID', 'ItemId', 'ItemNumber'
  ]));
  if (!itemId) throw new Error('item_id is required');

  const itemName = pickValue(input, ['item_name', 'name', 'Item Name', 'ProductName']);
  const itemCode = pickValue(input, ['item_code', 'sku', 'Item Code']);
  const sku = pickValue(input, ['sku', 'item_code', 'SKU']);
  const unit = pickValue(input, ['unit', 'inventory_unit', 'Unit', 'UnitId']);
  const category = pickValue(input, ['category', 'item_group', 'Category']);
  const supplierItemName = pickValue(input, ['supplier_item_name', 'vendor_item_name']);
  const cost = pickValue(input, ['cost_per_unit', 'unit_cost', 'last_cost']);
  const hasActiveState = Object.prototype.hasOwnProperty.call(input, 'is_active');

  return {
    item_id: itemId,
    item_name: itemName === undefined ? undefined : normalizeText(itemName),
    item_code: itemCode === undefined ? undefined : normalizeText(itemCode),
    sku: sku === undefined ? undefined : normalizeText(sku),
    unit: unit === undefined ? undefined : normalizeIngredientUnit(unit),
    category: category === undefined ? undefined : normalizeText(category),
    supplier_item_name: supplierItemName === undefined ? undefined : normalizeText(supplierItemName),
    cost_per_unit: optionalNumber(cost, 'cost_per_unit', undefined, { minimum: 0 }),
    is_active: hasActiveState
      ? !['false', '0', 'no', 'inactive'].includes(normalizedLookup(input.is_active))
      : undefined,
    external_event_id: normalizeText(pickValue(input, ['external_event_id', 'source_document_id'])),
    external_line_id: normalizeText(pickValue(input, ['external_line_id', 'source_line_id'])),
    external_version: normalizeText(pickValue(input, [
      'external_version', 'source_version', 'row_version', 'modified_at', 'ModifiedDateTime'
    ]))
  };
}

export function resolveD365Ingredient(ingredients = [], itemId = '') {
  const target = normalizedLookup(itemId);
  const matchTier = (fields) => {
    const matches = ingredients.filter((ingredient) => fields.some(
      (field) => normalizedLookup(ingredient?.[field]) === target
    ));
    return matches.length === 1 ? matches[0] : (matches.length > 1 ? false : null);
  };
  for (const fields of [
    ['d365_item_id'],
    ['item_code', 'ingredient_code', 'sku'],
    ['id']
  ]) {
    const match = matchTier(fields);
    if (match === false) return null;
    if (match) return match;
  }
  return null;
}

export function resolveD365Store(sites = [], warehouseId = '') {
  const target = normalizedLookup(warehouseId);
  const stores = sites.filter((site) => (
    normalizeSiteType(site?.type) === SITE_HIERARCHY_TYPES.STORE
  ));
  const matchTier = (fields) => {
    const matches = stores.filter((site) => fields.some(
      (field) => normalizedLookup(site?.[field]) === target
    ));
    return matches.length === 1 ? matches[0] : (matches.length > 1 ? false : null);
  };
  const match = matchTier(['d365_warehouse_id']);
  return match || null;
}

export function extractD365WarehouseId(input = {}) {
  return normalizeText(pickValue(input, [
    'warehouse_id', 'invent_location_id', 'site_id', 'Warehouse ID', 'InventLocationId', 'InventLocation'
  ]));
}

export function sanitizeD365Row(row = {}) {
  const allowed = [
    'item_id', 'item_name', 'item_code', 'sku', 'warehouse_id', 'warehouse_name',
    'quantity', 'quantity_semantics', 'unit', 'unit_cost', 'batch_number',
    'stock_date', 'expiry_date', 'external_event_id', 'external_line_id', 'external_version',
    'ordered_in_total', 'on_order_reserved', 'idempotency_key', 'category',
    'supplier_item_name', 'cost_per_unit', 'is_active'
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => row[key] !== undefined)
      .map((key) => [key, row[key]])
  );
}
