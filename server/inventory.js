import crypto from 'node:crypto';
import {
  withTransaction,
  listDocuments,
  findDocument,
  createDocument,
  updateDocument
} from './db.js';
import {
  calculateIngredientCost,
  convertIngredientQuantity
} from '../shared/ingredientUnits.js';

const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();

async function runInTransaction(executor, handler) {
  if (executor) {
    return handler(executor);
  }
  return withTransaction(handler);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toDateOnly(value = new Date()) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10);
}

function daysUntil(dateValue) {
  if (!dateValue) return null;
  const today = new Date(`${toDateOnly()}T00:00:00Z`);
  const target = new Date(`${toDateOnly(dateValue)}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function inventoryStatus(quantity, minimum) {
  if (quantity <= 0) return 'out_of_stock';
  if (minimum > 0 && quantity <= minimum) return 'low_stock';
  return 'in_stock';
}

function getAvailableLotQuantity(lots = []) {
  return lots.reduce(
    (sum, lot) => sum + Math.max(0, toNumber(lot?.remaining_quantity, 0)),
    0
  );
}

function assertSufficientStock(lots, quantity, allowShortage = true) {
  const requiredQuantity = toNumber(quantity, 0);
  const availableQuantity = getAvailableLotQuantity(lots);
  if (!allowShortage && availableQuantity < requiredQuantity) {
    const error = new Error('Insufficient stock available for this movement');
    error.status = 400;
    throw error;
  }
  return availableQuantity;
}

async function listInventoryLots(
  { siteId, ingredientId, includeEmpty = false, lock = false } = {},
  executor = null
) {
  const filters = {};
  if (siteId) filters.site_id = siteId;
  if (ingredientId) filters.ingredient_id = ingredientId;
  const lots = await listDocuments(
    'InventoryLot',
    { filters, limit: 5000, sort: 'received_date', lock },
    executor || undefined
  );
  return lots.filter((lot) => includeEmpty || toNumber(lot.remaining_quantity, 0) > 0);
}

async function ensureInventoryRecord({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  unit,
  min_stock_level = 0,
  max_stock_level = null,
  valuation_method = 'fifo'
}, executor = null) {
  if (executor) {
    await executor.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`inventory:${String(site_id || '')}:${String(ingredient_id || '')}`]
    );
  }

  const existing = (await listDocuments('Inventory', {
    filters: { site_id, ingredient_id },
    limit: 10,
    lock: Boolean(executor)
  }, executor || undefined))[0];

  if (existing) {
    return existing;
  }

  return createDocument('Inventory', {
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    quantity: 0,
    available_quantity: 0,
    unit,
    min_stock_level,
    max_stock_level,
    total_value: 0,
    average_unit_cost: 0,
    valuation_method,
    batch_count: 0,
    status: 'out_of_stock'
  }, executor || undefined);
}

async function recalculateInventoryRecord(record, executor = null) {
  const lots = await listInventoryLots({
    siteId: record.site_id,
    ingredientId: record.ingredient_id,
    includeEmpty: true
  }, executor);

  const activeLots = lots.filter((lot) => toNumber(lot.remaining_quantity, 0) > 0);
  const quantity = activeLots.reduce((sum, lot) => sum + toNumber(lot.remaining_quantity, 0), 0);
  const totalValue = activeLots.reduce((sum, lot) => sum + (toNumber(lot.remaining_quantity, 0) * toNumber(lot.unit_cost, 0)), 0);
  const averageUnitCost = quantity > 0 ? totalValue / quantity : 0;
  const earliestExpiry = activeLots
    .map((lot) => lot.expiry_date)
    .filter(Boolean)
    .sort()[0] || null;
  const nearExpiryCount = activeLots.filter((lot) => {
    const remainingDays = daysUntil(lot.expiry_date);
    return remainingDays !== null && remainingDays >= 0 && remainingDays <= 7;
  }).length;
  const expiredCount = activeLots.filter((lot) => {
    const remainingDays = daysUntil(lot.expiry_date);
    return remainingDays !== null && remainingDays < 0;
  }).length;

  return updateDocument('Inventory', record.id, {
    quantity,
    available_quantity: quantity,
    total_value: Number(totalValue.toFixed(2)),
    average_unit_cost: Number(averageUnitCost.toFixed(4)),
    batch_count: activeLots.length,
    next_expiry_date: earliestExpiry,
    near_expiry_count: nearExpiryCount,
    expired_lot_count: expiredCount,
    status: inventoryStatus(quantity, toNumber(record.min_stock_level, 0))
  }, executor || undefined);
}

async function postInventoryTransaction({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  transaction_type,
  quantity,
  unit,
  transaction_date,
  reference_id,
  reference_type,
  notes,
  performed_by,
  batch_number = null,
  expiry_date = null,
  total_cost = 0,
  unit_cost = 0,
  from_site_id = null,
  from_site_name = null,
  to_site_id = null,
  to_site_name = null,
  reason_code = null,
  movement_layers = []
}, executor = null) {
  return createDocument('InventoryTransaction', {
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    transaction_type,
    quantity,
    unit,
    transaction_date: transaction_date || toDateOnly(),
    reference_id: reference_id || null,
    reference_type: reference_type || null,
    notes: normalizeText(notes) || null,
    performed_by: performed_by || 'system',
    batch_number: normalizeText(batch_number) || null,
    expiry_date: expiry_date || null,
    total_cost: Number(toNumber(total_cost, 0).toFixed(2)),
    unit_cost: Number(toNumber(unit_cost, 0).toFixed(4)),
    from_site_id,
    from_site_name,
    to_site_id,
    to_site_name,
    reason_code: normalizeText(reason_code) || null,
    movement_layers
  }, executor || undefined);
}

async function receiveStockWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  quantity,
  unit,
  unit_cost = 0,
  batch_number = null,
  lot_number = null,
  expiry_date = null,
  min_stock_level = 0,
  max_stock_level = null,
  valuation_method = 'fifo',
  reference_id = null,
  reference_type = null,
  notes = '',
  performed_by = 'system',
  reason_code = 'receipt'
}, executor) {
  const qty = toNumber(quantity, 0);
  if (qty <= 0) {
    const error = new Error('Received quantity must be greater than zero');
    error.status = 400;
    throw error;
  }

  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit,
    min_stock_level,
    max_stock_level,
    valuation_method
  }, executor);

  const lot = await createDocument('InventoryLot', {
    id: randomId('lot'),
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    quantity_received: qty,
    remaining_quantity: qty,
    unit,
    unit_cost: toNumber(unit_cost, 0),
    total_cost: Number((qty * toNumber(unit_cost, 0)).toFixed(2)),
    batch_number: normalizeText(batch_number || lot_number) || `LOT-${Date.now()}`,
    lot_number: normalizeText(lot_number || batch_number) || null,
    expiry_date: expiry_date ? toDateOnly(expiry_date) : null,
    received_date: toDateOnly(),
    reference_id,
    reference_type,
    status: expiry_date && daysUntil(expiry_date) < 0 ? 'expired' : 'active'
  }, executor);

  await postInventoryTransaction({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    transaction_type: reason_code === 'transfer_in' ? 'transfer_in' : 'receipt',
    quantity: qty,
    unit,
    transaction_date: toDateOnly(),
    reference_id,
    reference_type,
    notes,
    performed_by,
    batch_number: lot.batch_number,
    expiry_date: lot.expiry_date,
    total_cost: qty * toNumber(unit_cost, 0),
    unit_cost: toNumber(unit_cost, 0),
    reason_code
  }, executor);

  const refreshed = await recalculateInventoryRecord(inventory, executor);
  return { inventory: refreshed, lot };
}

async function receiveStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => receiveStockWithExecutor(payload, client)
  );
}

async function deductStockWithExecutor({
  site_id,
  site_name,
  ingredient_id,
  ingredient_name,
  quantity,
  unit,
  transaction_type,
  transaction_date = null,
  reference_id = null,
  reference_type = null,
  notes = '',
  performed_by = 'system',
  valuation_method = 'fifo',
  reason_code = null,
  allow_shortage = true
}, executor) {
  const qty = toNumber(quantity, 0);
  if (qty <= 0) {
    const error = new Error('Deduction quantity must be greater than zero');
    error.status = 400;
    throw error;
  }

  const inventory = await ensureInventoryRecord({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    unit,
    valuation_method
  }, executor);

  const lots = await listInventoryLots({
    siteId: site_id,
    ingredientId: ingredient_id,
    lock: true
  }, executor);

  const sortedLots = [...lots].sort((left, right) => {
    const leftExpiry = left.expiry_date || '9999-12-31';
    const rightExpiry = right.expiry_date || '9999-12-31';
    if (leftExpiry === rightExpiry) {
      return String(left.received_date || '').localeCompare(String(right.received_date || ''));
    }
    return leftExpiry.localeCompare(rightExpiry);
  });

  assertSufficientStock(sortedLots, qty, allow_shortage);

  let remainingToDeduct = qty;
  let fifoCost = 0;
  const movementLayers = [];

  for (const lot of sortedLots) {
    if (remainingToDeduct <= 0) break;
    const remaining = toNumber(lot.remaining_quantity, 0);
    if (remaining <= 0) continue;

    const layerQuantity = Math.min(remaining, remainingToDeduct);
    const nextRemaining = remaining - layerQuantity;
    await updateDocument('InventoryLot', lot.id, {
      remaining_quantity: nextRemaining,
      status: nextRemaining <= 0 ? 'consumed' : lot.status
    }, executor);

    const layerCost = layerQuantity * toNumber(lot.unit_cost, 0);
    fifoCost += layerCost;
    movementLayers.push({
      inventory_lot_id: lot.id,
      batch_number: lot.batch_number || null,
      expiry_date: lot.expiry_date || null,
      quantity: layerQuantity,
      unit_cost: toNumber(lot.unit_cost, 0),
      total_cost: Number(layerCost.toFixed(2))
    });

    remainingToDeduct -= layerQuantity;
  }

  const valuationMethod = normalizeText(inventory.valuation_method || valuation_method || 'fifo') || 'fifo';
  const weightedCost = qty * toNumber(inventory.average_unit_cost, 0);
  const totalCost = valuationMethod === 'weighted_average' ? weightedCost : fifoCost;

  await postInventoryTransaction({
    site_id,
    site_name,
    ingredient_id,
    ingredient_name,
    transaction_type,
    quantity: qty * -1,
    unit,
    transaction_date: transaction_date || toDateOnly(),
    reference_id,
    reference_type,
    notes: remainingToDeduct > 0 ? `${notes} (shortage ${remainingToDeduct.toFixed(2)} ${unit})` : notes,
    performed_by,
    total_cost: totalCost,
    unit_cost: qty > 0 ? totalCost / qty : 0,
    reason_code,
    movement_layers: movementLayers
  }, executor);

  const refreshed = await recalculateInventoryRecord(inventory, executor);
  return {
    inventory: refreshed,
    shortage_quantity: Number(remainingToDeduct.toFixed(3)),
    total_cost: Number(totalCost.toFixed(2)),
    movement_layers: movementLayers
  };
}

async function deductStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => deductStockWithExecutor(payload, client)
  );
}

async function adjustStockWithExecutor({
  inventory_id,
  quantity_change,
  reason_code,
  notes,
  transaction_date,
  performed_by
}, executor) {
  const inventory = await findDocument('Inventory', inventory_id, executor, true);
  if (!inventory) {
    const error = new Error('Inventory record not found');
    error.status = 404;
    throw error;
  }

  const delta = toNumber(quantity_change, 0);
  if (delta === 0) {
    const error = new Error('Adjustment quantity cannot be zero');
    error.status = 400;
    throw error;
  }

  if (delta > 0) {
    return receiveStock({
      site_id: inventory.site_id,
      site_name: inventory.site_name,
      ingredient_id: inventory.ingredient_id,
      ingredient_name: inventory.ingredient_name,
      quantity: delta,
      unit: inventory.unit,
      unit_cost: toNumber(inventory.average_unit_cost, 0),
      batch_number: `ADJ-${Date.now()}`,
      min_stock_level: inventory.min_stock_level,
      max_stock_level: inventory.max_stock_level,
      valuation_method: inventory.valuation_method || 'fifo',
      reference_id: inventory.id,
      reference_type: 'adjustment',
      notes,
      performed_by,
      reason_code: reason_code || 'adjustment_positive'
    }, executor);
  }

  return deductStock({
    site_id: inventory.site_id,
    site_name: inventory.site_name,
    ingredient_id: inventory.ingredient_id,
    ingredient_name: inventory.ingredient_name,
    quantity: Math.abs(delta),
    unit: inventory.unit,
    transaction_type: 'adjustment',
    transaction_date,
    reference_id: inventory.id,
    reference_type: 'adjustment',
    notes,
    performed_by,
    valuation_method: inventory.valuation_method || 'fifo',
    reason_code: reason_code || 'adjustment_negative',
    allow_shortage: false
  }, executor);
}

async function adjustStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => adjustStockWithExecutor(payload, client)
  );
}

async function transferStockWithExecutor({
  from_site_id,
  from_site_name,
  to_site_id,
  to_site_name,
  items = [],
  transfer_date,
  reference_id,
  notes,
  performed_by
}, executor) {
  const results = [];

  for (const item of items) {
    const sourceInventory = (await listDocuments('Inventory', {
      filters: { site_id: from_site_id, ingredient_id: item.ingredient_id },
      limit: 10,
      lock: true
    }, executor))[0];

    if (!sourceInventory) {
      const error = new Error(`Source inventory not found for ingredient ${item.ingredient_id}`);
      error.status = 404;
      throw error;
    }

    const deduction = await deductStock({
      site_id: from_site_id,
      site_name: from_site_name,
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      quantity: item.quantity,
      unit: item.unit || sourceInventory.unit,
      transaction_type: 'transfer_out',
      transaction_date: transfer_date,
      reference_id,
      reference_type: 'transfer',
      notes: notes || `Transfer to ${to_site_name}`,
      performed_by,
      valuation_method: sourceInventory.valuation_method || 'fifo',
      reason_code: 'transfer_out',
      allow_shortage: false
    }, executor);

    for (const layer of deduction.movement_layers) {
      await receiveStock({
        site_id: to_site_id,
        site_name: to_site_name,
        ingredient_id: item.ingredient_id,
        ingredient_name: item.ingredient_name,
        quantity: layer.quantity,
        unit: item.unit || sourceInventory.unit,
        unit_cost: layer.unit_cost,
        batch_number: layer.batch_number || `TR-${Date.now()}`,
        expiry_date: layer.expiry_date,
        valuation_method: sourceInventory.valuation_method || 'fifo',
        reference_id,
        reference_type: 'transfer',
        notes: notes || `Transfer from ${from_site_name}`,
        performed_by,
        reason_code: 'transfer_in'
      }, executor);
    }

    results.push(deduction);
  }

  return results;
}

async function transferStock(payload, executor = null) {
  return runInTransaction(
    executor,
    (client) => transferStockWithExecutor(payload, client)
  );
}

async function completeProductionWithExecutor(productionId, actor, executor) {
  const production = await findDocument('Production', productionId, executor, true);
  if (!production) {
    const error = new Error('Production record not found');
    error.status = 404;
    throw error;
  }

  if (production.status === 'completed') {
    return production;
  }

  if (!['approved', 'in_progress'].includes(String(production.status || ''))) {
    const error = new Error('Production can only be completed after approval or while in progress');
    error.status = 400;
    throw error;
  }

  const [ingredientCatalog, inventoryCatalog] = await Promise.all([
    listDocuments('Ingredient', { limit: 5000 }, executor),
    listDocuments('Inventory', {
      filters: { site_id: production.site_id },
      limit: 5000
    }, executor)
  ]);
  const ingredientMap = new Map(ingredientCatalog.map((ingredient) => [ingredient.id, ingredient]));
  const inventoryMap = new Map(inventoryCatalog.map((item) => [item.ingredient_id, item]));
  const consumptionSummary = [];
  let totalProductionCost = 0;
  let totalShortageQuantity = 0;

  for (const ingredient of production.ingredients_used || []) {
    const ingredientData = ingredientMap.get(ingredient.ingredient_id);
    const sourceQuantity = toNumber(
      ingredient.actual_quantity ?? ingredient.planned_quantity ?? ingredient.adjusted_quantity,
      0
    );
    const inventoryItem = inventoryMap.get(ingredient.ingredient_id);
    const inventoryUnit = inventoryItem?.unit || ingredientData?.unit || ingredient.unit;
    const inventoryQuantity = convertIngredientQuantity(
      sourceQuantity,
      ingredient.unit || inventoryUnit,
      inventoryUnit,
      ingredientData
    );
    const movement = await deductStock({
      site_id: production.site_id,
      site_name: production.site_name,
      ingredient_id: ingredient.ingredient_id,
      ingredient_name: ingredient.ingredient_name,
      quantity: inventoryQuantity,
      unit: inventoryUnit,
      transaction_type: 'production_use',
      transaction_date: production.production_date,
      reference_id: production.id,
      reference_type: 'production',
      notes: `Used in production: ${production.recipe_name}`,
      performed_by: actor.email,
      reason_code: 'production_consumption',
      allow_shortage: true
    }, executor);

    const fallbackUnitCost = toNumber(ingredientData?.cost_per_unit, 0);
    const fallbackShortageCost = calculateIngredientCost(
      movement.shortage_quantity,
      inventoryUnit,
      ingredientData,
      fallbackUnitCost
    );
    const movementCost = toNumber(movement.total_cost, 0);

    totalProductionCost += movementCost + fallbackShortageCost;
    totalShortageQuantity += toNumber(movement.shortage_quantity, 0);
    consumptionSummary.push({
      ingredient_id: ingredient.ingredient_id,
      ingredient_name: ingredient.ingredient_name,
      unit: inventoryUnit,
      planned_quantity: Number(inventoryQuantity.toFixed(4)),
      shortage_quantity: toNumber(movement.shortage_quantity, 0),
      posted_cost: Number(movementCost.toFixed(2)),
      estimated_shortage_cost: Number(fallbackShortageCost.toFixed(2)),
      movement_layers: movement.movement_layers || []
    });
  }

  const servings = Math.max(1, toNumber(production.target_servings, 0));
  return updateDocument('Production', productionId, {
    status: 'completed',
    completed_date: nowIso(),
    completed_by: actor.email,
    ingredient_cost_total: Number(totalProductionCost.toFixed(2)),
    production_cost_total: Number(totalProductionCost.toFixed(2)),
    cost_per_serving: Number((totalProductionCost / servings).toFixed(2)),
    total_shortage_quantity: Number(totalShortageQuantity.toFixed(3)),
    completion_lines: consumptionSummary
  }, executor);
}

async function completeProduction(productionId, actor, executor = null) {
  return runInTransaction(
    executor,
    (client) => completeProductionWithExecutor(productionId, actor, client)
  );
}

async function getStockOnHandReport() {
  const inventory = await listDocuments('Inventory', { limit: 5000, sort: 'ingredient_name' });
  return inventory.map((item) => ({
    ...item,
    low_stock_alert: toNumber(item.quantity, 0) <= toNumber(item.min_stock_level, 0),
    overstock_alert: toNumber(item.max_stock_level, 0) > 0 && toNumber(item.quantity, 0) >= toNumber(item.max_stock_level, 0)
  }));
}

async function getStockMovementReport({ siteId = '', ingredientId = '', dateFrom = '', dateTo = '' } = {}) {
  let transactions = await listDocuments('InventoryTransaction', { limit: 5000, sort: '-transaction_date' });
  if (siteId) transactions = transactions.filter((entry) => entry.site_id === siteId);
  if (ingredientId) transactions = transactions.filter((entry) => entry.ingredient_id === ingredientId);
  if (dateFrom) transactions = transactions.filter((entry) => String(entry.transaction_date || '') >= dateFrom);
  if (dateTo) transactions = transactions.filter((entry) => String(entry.transaction_date || '') <= dateTo);
  return transactions;
}

async function getExpiryReport({ thresholdDays = 30 } = {}) {
  const lots = await listInventoryLots({ includeEmpty: false });
  return lots.map((lot) => {
    const remainingDays = daysUntil(lot.expiry_date);
    return {
      ...lot,
      days_until_expiry: remainingDays,
      expiry_status: remainingDays === null
        ? 'no_expiry'
        : remainingDays < 0
          ? 'expired'
          : remainingDays <= thresholdDays
            ? 'near_expiry'
            : 'fresh'
    };
  }).filter((lot) => lot.expiry_status !== 'fresh' || thresholdDays >= 365)
    .sort((left, right) => (left.days_until_expiry ?? 9999) - (right.days_until_expiry ?? 9999));
}

async function getVelocityReports({ days = 30 } = {}) {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - Math.max(1, Number(days || 30)));
  const movements = await getStockMovementReport({ dateFrom: toDateOnly(dateFrom) });
  const consumptionTypes = new Set(['production_use', 'pos_sale', 'issuance', 'transfer_out', 'waste', 'adjustment']);
  const map = new Map();

  movements.forEach((movement) => {
    if (!consumptionTypes.has(movement.transaction_type)) return;
    if (toNumber(movement.quantity, 0) >= 0) return;
    const key = `${movement.site_id || ''}::${movement.ingredient_id || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        site_id: movement.site_id || '',
        site_name: movement.site_name || '',
        ingredient_id: movement.ingredient_id || '',
        ingredient_name: movement.ingredient_name || '',
        total_moved: 0,
        movement_count: 0
      });
    }
    const item = map.get(key);
    item.total_moved += Math.abs(toNumber(movement.quantity, 0));
    item.movement_count += 1;
  });

  const ranked = Array.from(map.values()).sort((left, right) => right.total_moved - left.total_moved);
  return {
    fast_moving: ranked.slice(0, 25),
    slow_moving: [...ranked].reverse().slice(0, 25)
  };
}

async function getInventoryValuationReport() {
  const inventory = await listDocuments('Inventory', { limit: 5000, sort: 'ingredient_name' });
  return inventory.map((item) => {
    const quantity = toNumber(item.quantity, 0);
    const weightedValue = quantity * toNumber(item.average_unit_cost, 0);
    const fifoValue = toNumber(item.total_value, weightedValue);
    return {
      ...item,
      fifo_value: Number(fifoValue.toFixed(2)),
      weighted_average_value: Number(weightedValue.toFixed(2))
    };
  });
}

export {
  listInventoryLots,
  getAvailableLotQuantity,
  assertSufficientStock,
  ensureInventoryRecord,
  recalculateInventoryRecord,
  receiveStock,
  deductStock,
  adjustStock,
  transferStock,
  completeProduction,
  getStockOnHandReport,
  getStockMovementReport,
  getExpiryReport,
  getVelocityReports,
  getInventoryValuationReport
};
