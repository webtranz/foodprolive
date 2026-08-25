import { listDocumentsPage } from './db.js';
import { getItemCodeFromRecords } from '../shared/itemCode.js';

const EPSILON = 0.000001;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundQuantity(value) {
  return Number(toNumber(value, 0).toFixed(6));
}

function roundValue(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function toDateOnly(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function movementDate(transaction = {}) {
  return toDateOnly(
    transaction.transaction_date
      || transaction.created_date
      || transaction.created_at
      || transaction.updated_date
  );
}

function movementSource(transaction = {}) {
  return String(
    transaction.source_type
      || transaction.source
      || transaction.reference_type
      || transaction.reason_code
      || transaction.transaction_type
      || 'inventory_movement'
  ).trim();
}

function classifyMovement(transaction = {}, delta = 0) {
  const type = String(transaction.transaction_type || '').toLowerCase();
  const reason = String(transaction.reason_code || '').toLowerCase();
  const source = String(transaction.source_type || transaction.source || '').toLowerCase();

  if (type === 'opening_balance') return 'opening';

  if (
    ['production_return', 'production_release'].includes(type)
    || source.includes('return')
    || reason.includes('return')
    || reason.includes('cancellation')
  ) return 'return';

  if (
    delta < 0
    && (
      type === 'issue'
      || type === 'issuance'
      || source.includes('manual_issue')
      || reason.includes('manual_issue')
    )
  ) return 'consumption';

  if (
    type === 'adjustment'
    || source.includes('correction')
    || reason.includes('correction')
    || reason.includes('adjustment')
  ) return 'correction';

  return delta >= 0 ? 'addition' : 'consumption';
}

function layerDelta(transaction = {}, layer = {}) {
  const before = Number(layer.quantity_before);
  const after = Number(layer.quantity_after);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;

  const quantity = Math.abs(toNumber(layer.quantity, 0));
  return toNumber(transaction.quantity, 0) < 0 ? quantity * -1 : quantity;
}

function layerAccountingUnitCost(transaction = {}, layer = {}, lot = {}) {
  return Math.max(0, toNumber(
    layer.accounting_unit_cost
      ?? transaction.accounting_unit_cost
      ?? layer.unit_cost
      ?? transaction.unit_cost
      ?? lot.accounting_unit_cost
      ?? lot.unit_cost,
    0
  ));
}

function layerAccountingValue(transaction = {}, layer = {}, lot = {}, delta = 0, layerCount = 1) {
  const quantity = Math.abs(delta);
  if (quantity <= EPSILON) return 0;

  const hasLayerAccountingTotal = layer.accounting_total_cost !== null
    && typeof layer.accounting_total_cost !== 'undefined'
    && String(layer.accounting_total_cost).trim() !== '';
  const explicitAccountingTotal = Number(layer.accounting_total_cost);
  if (hasLayerAccountingTotal && Number.isFinite(explicitAccountingTotal)) {
    return Math.abs(explicitAccountingTotal);
  }

  // A transaction total can be attributed directly only when it represents a
  // single movement layer. Multi-layer issues must use their per-layer cost.
  const hasTransactionTotal = transaction.total_cost !== null
    && typeof transaction.total_cost !== 'undefined'
    && String(transaction.total_cost).trim() !== '';
  const transactionTotal = Number(transaction.total_cost);
  if (layerCount === 1 && hasTransactionTotal && Number.isFinite(transactionTotal)) {
    return Math.abs(transactionTotal);
  }

  return quantity * layerAccountingUnitCost(transaction, layer, lot);
}

function movementReferences(transaction = {}) {
  return String(
    transaction.reference_name
      || transaction.reference_number
      || transaction.reference_id
      || transaction.external_reference
      || ''
  ).trim();
}

function buildLotLookup(lots = []) {
  const byId = new Map();
  const byBatch = new Map();
  lots.forEach((lot) => {
    if (lot?.id) byId.set(String(lot.id), lot);
    const batch = String(lot?.batch_number || lot?.lot_number || '').trim();
    if (batch) {
      byBatch.set(`${lot.site_id || ''}::${lot.ingredient_id || ''}::${batch}`, lot);
    }
  });
  return { byId, byBatch };
}

function inventoryKey(record = {}) {
  return `${record.site_id || ''}::${record.ingredient_id || ''}`;
}

function buildLegacyInventoryLots(inventories = [], lots = [], transactions = []) {
  const represented = new Set(lots.map(inventoryKey));
  const moved = new Set(transactions.map(inventoryKey));
  return inventories.flatMap((inventory) => {
    const key = inventoryKey(inventory);
    const quantity = Math.max(0, toNumber(
      inventory.on_hand_quantity ?? inventory.available_quantity ?? inventory.quantity,
      0
    ));
    if (!inventory?.id || quantity <= EPSILON || represented.has(key) || moved.has(key)) return [];
    const stockDate = inventory.stock_date || inventory.received_date || inventory.created_date || null;
    const unitCost = Math.max(0, toNumber(
      inventory.average_unit_cost ?? inventory.unit_cost,
      0
    ));
    return [{
      id: `legacy-inventory-${inventory.id}`,
      site_id: inventory.site_id || null,
      site_name: inventory.site_name || null,
      ingredient_id: inventory.ingredient_id || null,
      ingredient_name: inventory.ingredient_name || null,
      batch_number: inventory.batch_number || `LEGACY-${String(inventory.id).slice(-12)}`,
      lot_number: inventory.lot_number || null,
      stock_date: stockDate,
      received_date: stockDate,
      expiry_date: inventory.expiry_date || null,
      quantity_received: quantity,
      remaining_quantity: quantity,
      unit: inventory.unit || null,
      unit_cost: unitCost,
      accounting_unit_cost: unitCost,
      accounting_total_cost: roundValue(quantity * unitCost),
      source: 'legacy_aggregate_inventory',
      source_type: 'legacy_aggregate_inventory',
      reference_id: inventory.id,
      status: 'legacy_unmigrated'
    }];
  });
}

function applyWeightedAverageAllocations(rows = [], inventories = []) {
  const weightedKeys = new Set(
    inventories
      .filter((inventory) => String(inventory?.valuation_method || '').toLowerCase() === 'weighted_average')
      .map(inventoryKey)
  );
  if (weightedKeys.size === 0) return rows;

  const groupedRows = new Map();
  rows.forEach((row) => {
    const key = inventoryKey(row);
    if (!weightedKeys.has(key)) return;
    if (!groupedRows.has(key)) groupedRows.set(key, []);
    groupedRows.get(key).push(row);
  });

  groupedRows.forEach((group) => {
    const openingQuantity = group.reduce((sum, row) => sum + toNumber(row.opening_quantity, 0), 0);
    const openingValue = group.reduce((sum, row) => sum + toNumber(row.opening_value, 0), 0);
    const closingQuantity = group.reduce((sum, row) => sum + toNumber(row.closing_quantity, 0), 0);
    const closingValue = group.reduce((sum, row) => sum + toNumber(row.closing_value, 0), 0);
    const openingAverage = openingQuantity > EPSILON ? openingValue / openingQuantity : 0;
    const closingAverage = closingQuantity > EPSILON ? closingValue / closingQuantity : openingAverage;

    group.forEach((row) => {
      const allocatedOpening = roundValue(toNumber(row.opening_quantity, 0) * openingAverage);
      const allocatedClosing = roundValue(toNumber(row.closing_quantity, 0) * closingAverage);
      const activityValue = toNumber(row.addition_value, 0)
        - toNumber(row.consumption_value, 0)
        + toNumber(row.return_value, 0)
        + toNumber(row.correction_value, 0);
      row.opening_value = allocatedOpening;
      row.closing_value = allocatedClosing;
      row.valuation_reallocation_value = roundValue(allocatedClosing - allocatedOpening - activityValue);
      row.unit_cost = Number(closingAverage.toFixed(4));
      row.valuation_method = 'weighted_average';
    });
  });

  return rows;
}

function isMovementWithinPeriod(movement, from, to) {
  // Undated movements cannot be assigned safely to a requested accounting
  // period. They remain available as the fallback anchor for an unfiltered
  // report, but are excluded whenever a date boundary is requested.
  if (!movement.date) return !from && !to;
  return (!from || movement.date >= from) && (!to || movement.date <= to);
}

function isMovementBeforePeriod(movement, from) {
  return Boolean(from && movement.date && movement.date < from);
}

function isMovementAtOrBeforeClose(movement, to) {
  if (!to) return Boolean(movement.date) || !movement.date;
  return Boolean(movement.date && movement.date <= to);
}

function stockDateForLot(lot = {}) {
  return toDateOnly(lot.stock_date || lot.received_date || lot.created_date || '');
}

function initialLedgerState(lot, movements) {
  const first = movements[0] || null;
  const firstBefore = Number(first?.layer?.quantity_before);
  const currentQuantity = Math.max(0, toNumber(lot.remaining_quantity ?? lot.quantity, 0));
  const allMovementDelta = movements.reduce((sum, movement) => sum + movement.delta, 0);
  const quantity = Number.isFinite(firstBefore)
    ? Math.max(0, firstBefore)
    : Math.max(0, currentQuantity - allMovementDelta);
  const firstCost = first?.accounting_unit_cost;
  const fallbackCost = toNumber(lot.accounting_unit_cost ?? lot.unit_cost, 0);
  const unitCost = Number.isFinite(Number(firstCost)) ? Number(firstCost) : fallbackCost;

  return {
    quantity,
    value: quantity * Math.max(0, unitCost)
  };
}

function applyMovement(state, movement) {
  const nextQuantity = state.quantity + movement.delta;
  const nextValue = state.value + movement.value_delta;
  return {
    quantity: Math.abs(nextQuantity) <= EPSILON ? 0 : nextQuantity,
    value: Math.abs(nextValue) <= 0.005 ? 0 : nextValue
  };
}

function buildHistoricalStates(lot, movements, from, to) {
  const ledgerMovements = (from || to)
    ? movements.filter((movement) => movement.date)
    : movements;

  if (ledgerMovements.length === 0) {
    const lotDate = stockDateForLot(lot);
    const currentQuantity = Math.max(0, toNumber(lot.remaining_quantity ?? lot.quantity, 0));
    const currentUnitCost = Math.max(0, toNumber(lot.accounting_unit_cost ?? lot.unit_cost, 0));
    const existsAtClose = !to || !lotDate || lotDate <= to;
    const existsAtOpen = existsAtClose && (!from || !lotDate || lotDate < from);
    return {
      opening: {
        quantity: existsAtOpen ? currentQuantity : 0,
        value: existsAtOpen ? currentQuantity * currentUnitCost : 0
      },
      closing: {
        quantity: existsAtClose ? currentQuantity : 0,
        value: existsAtClose ? currentQuantity * currentUnitCost : 0
      }
    };
  }

  let state = initialLedgerState(lot, ledgerMovements);
  let opening = { ...state };
  let closing = { ...state };

  ledgerMovements.forEach((movement) => {
    if (isMovementBeforePeriod(movement, from)) {
      state = applyMovement(state, movement);
      opening = { ...state };
      closing = { ...state };
      return;
    }

    if (isMovementAtOrBeforeClose(movement, to)) {
      state = applyMovement(state, movement);
      closing = { ...state };
    }
  });

  // With no lower boundary, opening means the ledger state immediately before
  // the first reported movement, not the current repriced lot state.
  if (!from) opening = initialLedgerState(lot, ledgerMovements);

  return { opening, closing };
}

function syntheticLotFromMovement(transaction, layer, index) {
  const batchNumber = layer?.batch_number || transaction?.batch_number || null;
  return {
    id: layer?.inventory_lot_id || `movement-${transaction?.id || 'unknown'}-${index}`,
    site_id: transaction?.site_id || null,
    site_name: transaction?.site_name || null,
    ingredient_id: transaction?.ingredient_id || null,
    ingredient_name: transaction?.ingredient_name || null,
    batch_number: batchNumber,
    lot_number: batchNumber,
    stock_date: layer?.stock_date || transaction?.stock_date || transaction?.received_date || null,
    received_date: layer?.received_date || transaction?.received_date || transaction?.stock_date || null,
    expiry_date: layer?.expiry_date || transaction?.expiry_date || null,
    remaining_quantity: Number.isFinite(Number(layer?.quantity_after)) ? Number(layer.quantity_after) : 0,
    unit: transaction?.unit || null,
    unit_cost: layer?.unit_cost ?? transaction?.unit_cost ?? 0,
    source: movementSource(transaction),
    reference_id: transaction?.reference_id || null,
    status: 'historical'
  };
}

export function buildInventoryLotValueRows({
  lots = [],
  transactions = [],
  inventories = [],
  ingredients = [],
  dateFrom = '',
  dateTo = ''
} = {}) {
  const from = toDateOnly(dateFrom);
  const to = toDateOnly(dateTo);
  const ingredientMap = new Map(
    (Array.isArray(ingredients) ? ingredients : [])
      .filter((ingredient) => ingredient?.id)
      .map((ingredient) => [String(ingredient.id), ingredient])
  );
  const suppliedLots = (Array.isArray(lots) ? lots : []).map((lot) => ({ ...lot }));
  const suppliedTransactions = Array.isArray(transactions) ? transactions : [];
  const normalizedLots = [
    ...suppliedLots,
    ...buildLegacyInventoryLots(
      Array.isArray(inventories) ? inventories : [],
      suppliedLots,
      suppliedTransactions
    )
  ];
  const lookup = buildLotLookup(normalizedLots);
  const syntheticLots = new Map();
  const movementsByLot = new Map();

  suppliedTransactions.forEach((transaction) => {
    const layers = Array.isArray(transaction?.movement_layers) && transaction.movement_layers.length > 0
      ? transaction.movement_layers
      : [{
          inventory_lot_id: null,
          batch_number: transaction?.batch_number || null,
          stock_date: transaction?.stock_date || transaction?.received_date || null,
          expiry_date: transaction?.expiry_date || null,
          quantity: Math.abs(toNumber(transaction?.quantity, 0)),
          unit_cost: transaction?.unit_cost ?? 0
        }];

    layers.forEach((layer, layerIndex) => {
      const lotId = String(layer?.inventory_lot_id || '').trim();
      const batch = String(layer?.batch_number || transaction?.batch_number || '').trim();
      const batchKey = `${transaction?.site_id || ''}::${transaction?.ingredient_id || ''}::${batch}`;
      let lot = (lotId && lookup.byId.get(lotId)) || (batch && lookup.byBatch.get(batchKey));
      if (!lot) {
        const syntheticKey = batch
          ? `batch::${batchKey}`
          : `unbatched::${transaction?.site_id || ''}::${transaction?.ingredient_id || ''}`;
        lot = syntheticLots.get(syntheticKey);
        if (!lot) {
          lot = syntheticLotFromMovement(transaction, layer, layerIndex);
          syntheticLots.set(syntheticKey, lot);
          normalizedLots.push(lot);
          lookup.byId.set(String(lot.id), lot);
          if (batch) lookup.byBatch.set(batchKey, lot);
        }
      }

      const delta = layerDelta(transaction, layer);
      const accountingUnitCost = layerAccountingUnitCost(transaction, layer, lot);
      const accountingValue = layerAccountingValue(transaction, layer, lot, delta, layers.length);
      const movement = {
        id: transaction?.id || null,
        date: movementDate(transaction),
        delta,
        accounting_unit_cost: accountingUnitCost,
        accounting_value: accountingValue,
        value_delta: delta < 0 ? accountingValue * -1 : accountingValue,
        classification: classifyMovement(transaction, delta),
        source: movementSource(transaction),
        reference: movementReferences(transaction),
        transaction,
        layer
      };
      const key = String(lot.id);
      if (!movementsByLot.has(key)) movementsByLot.set(key, []);
      movementsByLot.get(key).push(movement);
    });
  });

  const rows = normalizedLots.map((lot) => {
    const movements = (movementsByLot.get(String(lot.id)) || [])
      .sort((left, right) => {
        if (!left.date && right.date) return 1;
        if (left.date && !right.date) return -1;
        return `${left.date}:${left.id || ''}`.localeCompare(`${right.date}:${right.id || ''}`);
      });
    const { opening, closing } = buildHistoricalStates(lot, movements, from, to);
    const openingQuantity = roundQuantity(Math.max(0, opening.quantity));
    const closingQuantity = roundQuantity(Math.max(0, closing.quantity));
    const openingValue = roundValue(Math.max(0, opening.value));
    const closingValue = roundValue(Math.max(0, closing.value));
    const periodMovements = movements.filter((movement) => isMovementWithinPeriod(movement, from, to));
    const totals = periodMovements.reduce((summary, movement) => {
      const amount = Math.abs(movement.delta);
      if (amount <= EPSILON) return summary;
      const value = Math.abs(movement.accounting_value);
      if (movement.classification === 'return') {
        summary.return_quantity += amount;
        summary.return_value += value;
      } else if (movement.classification === 'correction') {
        summary.correction_quantity += movement.delta;
        summary.correction_value += movement.value_delta;
      } else if (movement.classification === 'opening') {
        // An opening balance posted inside the requested period introduces
        // stock during that period, so it participates in additions while
        // remaining separately auditable.
        summary.opening_balance_quantity += movement.delta;
        summary.opening_balance_value += movement.value_delta;
        if (movement.delta >= 0) {
          summary.addition_quantity += amount;
          summary.addition_value += value;
        } else {
          summary.correction_quantity += movement.delta;
          summary.correction_value += movement.value_delta;
        }
      } else if (movement.classification === 'addition') {
        summary.addition_quantity += amount;
        summary.addition_value += value;
      } else if (movement.classification === 'consumption') {
        summary.consumption_quantity += amount;
        summary.consumption_value += value;
      }
      return summary;
    }, {
      addition_quantity: 0,
      addition_value: 0,
      consumption_quantity: 0,
      consumption_value: 0,
      return_quantity: 0,
      return_value: 0,
      correction_quantity: 0,
      correction_value: 0,
      opening_balance_quantity: 0,
      opening_balance_value: 0
    });
    const sources = [...new Set(periodMovements.map((movement) => movement.source).filter(Boolean))];
    const references = [...new Set(periodMovements.map((movement) => movement.reference).filter(Boolean))];
    const ingredient = ingredientMap.get(String(lot.ingredient_id || '')) || {};
    const physicalUnitCost = toNumber(lot.unit_cost, 0);
    const historicalUnitCost = closingQuantity > EPSILON
      ? closingValue / closingQuantity
      : openingQuantity > EPSILON
        ? openingValue / openingQuantity
        : movements.at(-1)?.accounting_unit_cost;
    const unitCost = toNumber(historicalUnitCost ?? lot.accounting_unit_cost ?? physicalUnitCost, 0);

    return {
      ...lot,
      item_code: getItemCodeFromRecords([ingredient, lot], null),
      ingredient_name: lot.ingredient_name || ingredient.name || lot.ingredient_id || null,
      stock_date: lot.stock_date || lot.received_date || null,
      opening_quantity: openingQuantity,
      addition_quantity: roundQuantity(totals.addition_quantity),
      addition_value: roundValue(totals.addition_value),
      consumption_quantity: roundQuantity(totals.consumption_quantity),
      consumption_value: roundValue(totals.consumption_value),
      return_quantity: roundQuantity(totals.return_quantity),
      return_value: roundValue(totals.return_value),
      correction_quantity: roundQuantity(totals.correction_quantity),
      correction_value: roundValue(totals.correction_value),
      opening_balance_quantity: roundQuantity(totals.opening_balance_quantity),
      opening_balance_value: roundValue(totals.opening_balance_value),
      closing_quantity: closingQuantity,
      unit_cost: Number(unitCost.toFixed(4)),
      physical_unit_cost: Number(physicalUnitCost.toFixed(4)),
      opening_value: openingValue,
      closing_value: closingValue,
      movement_count: periodMovements.length,
      source: sources.length === 1 ? sources[0] : sources.length > 1 ? 'multiple_sources' : lot.source || lot.source_type || null,
      reference: references.length === 1 ? references[0] : references.length > 1 ? 'multiple_references' : lot.reference_id || null,
      date_from: from || null,
      date_to: to || null
    };
  });

  return applyWeightedAverageAllocations(
    rows,
    Array.isArray(inventories) ? inventories : []
  ).sort((left, right) => (
    `${left.site_name || ''}:${left.ingredient_name || ''}:${left.stock_date || ''}:${left.batch_number || ''}`
      .localeCompare(`${right.site_name || ''}:${right.ingredient_name || ''}:${right.stock_date || ''}:${right.batch_number || ''}`)
  ));
}

export async function listAllInventoryReportDocuments(
  entity,
  { filters = {}, sort = undefined, pageSize = 200, location = null } = {},
  pageLoader = listDocumentsPage
) {
  const rows = [];
  const safePageSize = Math.min(Math.max(Number(pageSize) || 200, 1), 200);
  let offset = 0;

  while (true) {
    const page = await pageLoader(entity, {
      filters,
      sort,
      limit: safePageSize,
      offset,
      location
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    rows.push(...items);
    offset += items.length;
    const totalCount = Math.max(0, toNumber(page?.total_count, offset));
    if (items.length === 0 || items.length < safePageSize || offset >= totalCount) break;
  }

  return rows;
}

export async function getInventoryValueHistoryReport({
  siteId = '',
  ingredientId = '',
  dateFrom = '',
  dateTo = '',
  location = null
} = {}) {
  const filters = {};
  if (siteId) filters.site_id = siteId;
  if (ingredientId) filters.ingredient_id = ingredientId;
  const [lots, transactions, inventories, ingredients] = await Promise.all([
    listAllInventoryReportDocuments('InventoryLot', { filters, sort: 'stock_date', location }),
    listAllInventoryReportDocuments('InventoryTransaction', { filters, sort: 'transaction_date', location }),
    listAllInventoryReportDocuments('Inventory', { filters, sort: 'ingredient_name', location }),
    listAllInventoryReportDocuments('Ingredient', { sort: 'name' })
  ]);
  return buildInventoryLotValueRows({
    lots,
    transactions,
    inventories,
    ingredients,
    dateFrom,
    dateTo
  });
}
