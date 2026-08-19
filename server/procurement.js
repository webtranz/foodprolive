import crypto from 'node:crypto';
import {
  pool,
  withTransaction,
  listDocuments,
  findDocument,
  createDocument,
  updateDocument,
  validateDocumentRelationships
} from './db.js';
import { receiveStock } from './inventory.js';
import { enrichIngredientItemCodes } from './itemCodes.js';

const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();

function normalizeText(value) {
  return String(value || '').trim();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function dateOnly(value = new Date()) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

async function validateProcurementReferences(
  { siteId = null, items = [] } = {},
  executor = pool
) {
  await validateDocumentRelationships(
    'ProcurementRecord',
    {
      site_id: normalizeText(siteId) || null,
      items
    },
    null,
    executor
  );
  const supplierIds = [...new Set(
    items.map((item) => normalizeText(item.preferred_supplier_id)).filter(Boolean)
  )];
  for (const supplierId of supplierIds) {
    const supplier = await getSupplierById(supplierId, executor);
    if (!supplier) {
      const error = new Error('Preferred supplier not found');
      error.status = 404;
      throw error;
    }
  }
}

function daysBetween(start, end) {
  if (!start || !end) return null;
  const first = new Date(start);
  const second = new Date(end);
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return null;
  const diff = second.getTime() - first.getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

async function query(text, params = [], executor = pool) {
  return executor.query(text, params);
}

async function clientQuery(client, text, params = []) {
  return client.query(text, params);
}

function toSupplier(row) {
  return {
    ...row,
    categories: row.categories || []
  };
}

async function listSuppliers() {
  const result = await query('SELECT * FROM suppliers ORDER BY updated_at DESC, name ASC');
  return result.rows.map(toSupplier);
}

async function getSupplierById(id, executor = pool) {
  const result = await query('SELECT * FROM suppliers WHERE id = $1 LIMIT 1', [id], executor);
  return result.rowCount ? toSupplier(result.rows[0]) : null;
}

async function createSupplier(payload) {
  const id = randomId('sup');
  const result = await query(
    `INSERT INTO suppliers (
      id, name, contact_person, email, phone, address, city, country, payment_terms,
      lead_time_days, status, rating, categories, notes, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,NOW(),NOW())
    RETURNING *`,
    [
      id,
      normalizeText(payload.name),
      normalizeText(payload.contact_person) || null,
      normalizeText(payload.email) || null,
      normalizeText(payload.phone) || null,
      normalizeText(payload.address) || null,
      normalizeText(payload.city) || null,
      normalizeText(payload.country) || null,
      normalizeText(payload.payment_terms) || null,
      Math.max(0, Math.round(toNumber(payload.lead_time_days, 0))),
      normalizeText(payload.status || 'active') || 'active',
      toNumber(payload.rating, 0),
      JSON.stringify(Array.isArray(payload.categories) ? payload.categories : []),
      normalizeText(payload.notes) || null
    ]
  );
  return toSupplier(result.rows[0]);
}

async function updateSupplier(id, payload) {
  const existing = await getSupplierById(id);
  if (!existing) return null;
  const result = await query(
    `UPDATE suppliers
     SET name = $2,
         contact_person = $3,
         email = $4,
         phone = $5,
         address = $6,
         city = $7,
         country = $8,
         payment_terms = $9,
         lead_time_days = $10,
         status = $11,
         rating = $12,
         categories = $13::jsonb,
         notes = $14,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      normalizeText(payload.name ?? existing.name),
      normalizeText(payload.contact_person ?? existing.contact_person) || null,
      normalizeText(payload.email ?? existing.email) || null,
      normalizeText(payload.phone ?? existing.phone) || null,
      normalizeText(payload.address ?? existing.address) || null,
      normalizeText(payload.city ?? existing.city) || null,
      normalizeText(payload.country ?? existing.country) || null,
      normalizeText(payload.payment_terms ?? existing.payment_terms) || null,
      Math.max(0, Math.round(toNumber(payload.lead_time_days ?? existing.lead_time_days, 0))),
      normalizeText(payload.status ?? existing.status) || 'active',
      toNumber(payload.rating ?? existing.rating, 0),
      JSON.stringify(Array.isArray(payload.categories) ? payload.categories : existing.categories || []),
      normalizeText(payload.notes ?? existing.notes) || null
    ]
  );
  return toSupplier(result.rows[0]);
}

async function deleteSupplier(id) {
  const result = await query('DELETE FROM suppliers WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function getRequestItems(requestIds = [], executor = pool) {
  if (!requestIds.length) return [];
  const result = await query(
    'SELECT * FROM purchase_request_items WHERE request_id = ANY($1::text[]) ORDER BY created_at ASC',
    [requestIds],
    executor
  );
  return enrichIngredientItemCodes(result.rows, executor);
}

async function listPurchaseRequests(executor = pool) {
  const headers = await query('SELECT * FROM purchase_requests ORDER BY created_at DESC', [], executor);
  const ids = headers.rows.map((row) => row.id);
  const items = await getRequestItems(ids, executor);
  const itemMap = new Map();

  items.forEach((item) => {
    if (!itemMap.has(item.request_id)) {
      itemMap.set(item.request_id, []);
    }
    itemMap.get(item.request_id).push(item);
  });

  return headers.rows.map((row) => ({
    ...row,
    items: itemMap.get(row.id) || []
  }));
}

async function getPurchaseRequestById(id, executor = pool) {
  const result = await query('SELECT * FROM purchase_requests WHERE id = $1 LIMIT 1', [id], executor);
  if (!result.rowCount) return null;
  const items = await getRequestItems([id], executor);
  return {
    ...result.rows[0],
    items
  };
}

function normalizeRequestItems(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const requestedQuantity = toNumber(item.requested_quantity, 0);
    const estimatedUnitPrice = toNumber(item.estimated_unit_price, 0);
    return {
      id: item.id || randomId('pri'),
      ingredient_id: normalizeText(item.ingredient_id) || null,
      ingredient_name: normalizeText(item.ingredient_name || item.description),
      description: normalizeText(item.description) || null,
      requested_quantity: requestedQuantity,
      approved_quantity: toNumber(item.approved_quantity, 0),
      ordered_quantity: toNumber(item.ordered_quantity, 0),
      unit: normalizeText(item.unit),
      estimated_unit_price: estimatedUnitPrice,
      line_total: requestedQuantity * estimatedUnitPrice,
      status: normalizeText(item.status || 'pending') || 'pending',
      preferred_supplier_id: normalizeText(item.preferred_supplier_id) || null,
      preferred_supplier_name: normalizeText(item.preferred_supplier_name) || null
    };
  }).filter((item) => item.ingredient_name && item.requested_quantity > 0);
}

async function createPurchaseRequest(payload, actor) {
  const items = normalizeRequestItems(payload.items || []);
  if (!items.length) {
    const error = new Error('At least one purchase request item is required');
    error.status = 400;
    throw error;
  }

  return withTransaction(async (client) => {
    await validateProcurementReferences({
      siteId: payload.site_id,
      items
    }, client);

    const id = randomId('pr');
    const requestNumber = normalizeText(payload.request_number || `PR-${Date.now()}`);
    const totalEstimatedCost = items.reduce((sum, item) => sum + item.line_total, 0);
    await clientQuery(
      client,
      `INSERT INTO purchase_requests (
        id, request_number, site_id, site_name, request_date, needed_by, requested_by,
        requested_by_name, priority, status, approval_role, auto_generated, source_type,
        notes, total_estimated_cost, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())`,
      [
        id,
        requestNumber,
        normalizeText(payload.site_id) || null,
        normalizeText(payload.site_name) || null,
        dateOnly(payload.request_date || nowIso()),
        payload.needed_by ? dateOnly(payload.needed_by) : null,
        actor.email,
        actor.full_name || actor.email,
        normalizeText(payload.priority || 'normal') || 'normal',
        normalizeText(payload.status || 'pending') || 'pending',
        normalizeText(payload.approval_role || 'manager') || 'manager',
        payload.auto_generated === true,
        normalizeText(payload.source_type || 'manual') || 'manual',
        normalizeText(payload.notes) || null,
        totalEstimatedCost
      ]
    );

    for (const item of items) {
      await clientQuery(
        client,
        `INSERT INTO purchase_request_items (
          id, request_id, ingredient_id, ingredient_name, description, requested_quantity,
          approved_quantity, ordered_quantity, unit, estimated_unit_price, line_total,
          status, preferred_supplier_id, preferred_supplier_name, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
        [
          item.id,
          id,
          item.ingredient_id,
          item.ingredient_name,
          item.description,
          item.requested_quantity,
          item.approved_quantity,
          item.ordered_quantity,
          item.unit,
          item.estimated_unit_price,
          item.line_total,
          item.status,
          item.preferred_supplier_id,
          item.preferred_supplier_name
        ]
      );
    }

    return getPurchaseRequestById(id, client);
  });
}

async function approvePurchaseRequest(id, payload, actor) {
  const request = await getPurchaseRequestById(id);
  if (!request) return null;
  if (['cancelled', 'rejected'].includes(request.status)) {
    const error = new Error('This purchase request can no longer be approved');
    error.status = 400;
    throw error;
  }

  const itemUpdates = new Map(
    (Array.isArray(payload.items) ? payload.items : []).map((item) => [
      String(item.id),
      item
    ])
  );

  return withTransaction(async (client) => {
    await clientQuery(
      client,
      `UPDATE purchase_requests
       SET status = $2,
           approved_by = $3,
           approved_by_name = $4,
           approved_at = NOW(),
           notes = COALESCE($5, notes),
           updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        normalizeText(payload.status || 'approved') || 'approved',
        actor.email,
        actor.full_name || actor.email,
        normalizeText(payload.notes) || null
      ]
    );

    for (const item of request.items) {
      const patch = itemUpdates.get(String(item.id));
      const approvedQuantity = patch ? toNumber(patch.approved_quantity, item.requested_quantity) : (item.approved_quantity > 0 ? item.approved_quantity : item.requested_quantity);
      await clientQuery(
        client,
        `UPDATE purchase_request_items
         SET approved_quantity = $2,
             status = $3
         WHERE id = $1`,
        [
          item.id,
          approvedQuantity,
          normalizeText(payload.status || 'approved') === 'approved' ? 'approved' : normalizeText(payload.status || 'rejected')
        ]
      );
    }

    return getPurchaseRequestById(id, client);
  });
}

async function autoGeneratePurchaseRequestFromLowStock(payload, actor) {
  const inventory = await listDocuments('Inventory', { limit: 2000 });
  const ingredients = await listDocuments('Ingredient', { limit: 2000 });
  const filteredInventory = inventory.filter((item) => {
    const siteMatch = !payload.site_id || item.site_id === payload.site_id;
    const minimum = toNumber(item.min_stock_level, 0);
    const quantity = toNumber(item.quantity, 0);
    const lowByStatus = ['low_stock', 'out_of_stock'].includes(String(item.status || '').toLowerCase());
    const lowByThreshold = minimum > 0 && quantity <= minimum;
    return siteMatch && (lowByStatus || lowByThreshold);
  });

  const items = [];
  for (const stockItem of filteredInventory) {
    const minimum = Math.max(1, toNumber(stockItem.min_stock_level, 0));
    const targetQuantity = minimum * 2;
    const requestQuantity = Math.max(0, targetQuantity - toNumber(stockItem.quantity, 0));
    if (requestQuantity <= 0) continue;

    const ingredient = ingredients.find((entry) => entry.id === stockItem.ingredient_id);
    const latestPrice = await getLatestIngredientPrice(stockItem.ingredient_id);
    items.push({
      ingredient_id: stockItem.ingredient_id,
      ingredient_name: stockItem.ingredient_name || ingredient?.name || 'Unknown ingredient',
      description: `Auto-generated from low stock at ${stockItem.site_name || 'unknown site'}`,
      requested_quantity: requestQuantity,
      unit: stockItem.unit || ingredient?.unit || 'unit',
      estimated_unit_price: latestPrice?.unit_price || ingredient?.cost_per_unit || 0,
      preferred_supplier_id: latestPrice?.supplier_id || null,
      preferred_supplier_name: latestPrice?.supplier_name || null
    });
  }

  if (!items.length) {
    const error = new Error('No low stock items found for auto-generation');
    error.status = 400;
    throw error;
  }

  return createPurchaseRequest({
    request_number: `PR-LOW-${Date.now()}`,
    site_id: payload.site_id || null,
    site_name: payload.site_name || null,
    request_date: payload.request_date || dateOnly(),
    needed_by: payload.needed_by || null,
    priority: payload.priority || 'high',
    approval_role: 'manager',
    auto_generated: true,
    source_type: 'low_stock',
    notes: payload.notes || 'Automatically generated from low stock inventory items',
    items
  }, actor);
}

async function getOrderItems(orderIds = [], executor = pool, lock = false) {
  if (!orderIds.length) return [];
  const result = await query(
    `SELECT *
     FROM purchase_order_items
     WHERE order_id = ANY($1::text[])
     ORDER BY created_at ASC
     ${lock ? 'FOR UPDATE' : ''}`,
    [orderIds],
    executor
  );
  return enrichIngredientItemCodes(result.rows, executor);
}

async function listPurchaseOrders(executor = pool) {
  const headers = await query('SELECT * FROM purchase_orders ORDER BY created_at DESC', [], executor);
  const ids = headers.rows.map((row) => row.id);
  const items = await getOrderItems(ids, executor);
  const itemMap = new Map();
  items.forEach((item) => {
    if (!itemMap.has(item.order_id)) {
      itemMap.set(item.order_id, []);
    }
    itemMap.get(item.order_id).push(item);
  });

  return headers.rows.map((row) => ({
    ...row,
    items: itemMap.get(row.id) || []
  }));
}

async function getPurchaseOrderById(id, executor = pool, lock = false) {
  const result = await query(
    `SELECT * FROM purchase_orders WHERE id = $1 LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
    executor
  );
  if (!result.rowCount) return null;
  return {
    ...result.rows[0],
    items: await getOrderItems([id], executor, lock)
  };
}

async function recordSupplierPriceHistory(client, { supplier, item, order, siteId, siteName }) {
  await clientQuery(
    client,
    `INSERT INTO supplier_price_history (
      id, supplier_id, supplier_name, ingredient_id, ingredient_name, purchase_order_item_id,
      unit_price, currency, effective_date, lead_time_days, site_id, site_name, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
    [
      randomId('sph'),
      supplier?.id || null,
      supplier?.name || null,
      item.ingredient_id || null,
      item.ingredient_name,
      item.id,
      item.unit_price,
      order.currency || 'SAR',
      order.order_date,
      supplier?.lead_time_days || 0,
      siteId || null,
      siteName || null
    ]
  );
}

async function createPurchaseOrder(payload, actor) {
  const supplier = await getSupplierById(payload.supplier_id);
  if (!supplier) {
    const error = new Error('Supplier not found');
    error.status = 404;
    throw error;
  }

  const requestId = normalizeText(payload.request_id) || null;
  const linkedRequest = requestId ? await getPurchaseRequestById(requestId) : null;
  if (requestId && !linkedRequest) {
    const error = new Error('Purchase request not found');
    error.status = 404;
    throw error;
  }

  const linkedRequestItems = new Map(
    (linkedRequest?.items || []).map((item) => [String(item.id), item])
  );
  const sourceItems = Array.isArray(payload.items) && payload.items.length
    ? payload.items
    : (linkedRequest?.items || []).map((item) => ({
      request_item_id: item.id,
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      ordered_quantity: item.approved_quantity > 0 ? item.approved_quantity : item.requested_quantity,
      unit: item.unit,
      unit_price: item.estimated_unit_price
    }));

  const items = sourceItems.map((item) => {
    const requestItemId = normalizeText(item.request_item_id) || null;
    const linkedRequestItem = requestItemId ? linkedRequestItems.get(requestItemId) : null;
    if (requestItemId && !linkedRequestItem) {
      const error = new Error('Purchase order item does not belong to the selected purchase request');
      error.status = 409;
      throw error;
    }

    const orderedQuantity = toNumber(item.ordered_quantity, 0);
    const unitPrice = toNumber(item.unit_price, 0);
    return {
      id: item.id || randomId('poi'),
      request_item_id: requestItemId,
      ingredient_id: normalizeText(linkedRequestItem?.ingredient_id || item.ingredient_id) || null,
      ingredient_name: normalizeText(linkedRequestItem?.ingredient_name || item.ingredient_name),
      ordered_quantity: orderedQuantity,
      received_quantity: 0,
      unit: normalizeText(linkedRequestItem?.unit || item.unit),
      unit_price: unitPrice,
      line_total: orderedQuantity * unitPrice,
      status: 'pending'
    };
  }).filter((item) => item.ingredient_name && item.ordered_quantity > 0);

  if (!items.length) {
    const error = new Error('At least one purchase order item is required');
    error.status = 400;
    throw error;
  }

  return withTransaction(async (client) => {
    await validateProcurementReferences({
      siteId: payload.site_id || linkedRequest?.site_id,
      items
    }, client);

    const id = randomId('po');
    const order = {
      po_number: normalizeText(payload.po_number || `PO-${Date.now()}`),
      order_date: dateOnly(payload.order_date || nowIso()),
      expected_delivery_date: payload.expected_delivery_date ? dateOnly(payload.expected_delivery_date) : null,
      currency: normalizeText(payload.currency || 'SAR') || 'SAR'
    };
    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const taxAmount = toNumber(payload.tax_amount, 0);
    const totalAmount = subtotal + taxAmount;

    await clientQuery(
      client,
      `INSERT INTO purchase_orders (
        id, po_number, request_id, supplier_id, supplier_name, site_id, site_name, order_date,
        expected_delivery_date, currency, subtotal, tax_amount, total_amount, status,
        created_by, created_by_name, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16,NOW(),NOW())`,
      [
        id,
        order.po_number,
        linkedRequest?.id || null,
        supplier.id,
        supplier.name,
        normalizeText(payload.site_id || linkedRequest?.site_id) || null,
        normalizeText(payload.site_name || linkedRequest?.site_name) || null,
        order.order_date,
        order.expected_delivery_date,
        order.currency,
        subtotal,
        taxAmount,
        totalAmount,
        actor.email,
        actor.full_name || actor.email,
        normalizeText(payload.notes) || null
      ]
    );

    for (const item of items) {
      await clientQuery(
        client,
        `INSERT INTO purchase_order_items (
          id, order_id, request_item_id, ingredient_id, ingredient_name, ordered_quantity,
          received_quantity, unit, unit_price, line_total, status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [
          item.id,
          id,
          item.request_item_id,
          item.ingredient_id,
          item.ingredient_name,
          item.ordered_quantity,
          item.received_quantity,
          item.unit,
          item.unit_price,
          item.line_total,
          item.status
        ]
      );

      if (item.request_item_id) {
        await clientQuery(
          client,
          `UPDATE purchase_request_items
           SET ordered_quantity = ordered_quantity + $2
           WHERE id = $1`,
          [item.request_item_id, item.ordered_quantity]
        );
      }

      await recordSupplierPriceHistory(client, {
        supplier,
        item,
        order,
        siteId: payload.site_id || linkedRequest?.site_id,
        siteName: payload.site_name || linkedRequest?.site_name
      });
    }

    return getPurchaseOrderById(id, client);
  });
}

async function approvePurchaseOrder(id, payload, actor) {
  const existing = await getPurchaseOrderById(id);
  if (!existing) return null;
  if (existing.status === 'cancelled') {
    const error = new Error('Cancelled orders cannot be approved');
    error.status = 400;
    throw error;
  }

  await query(
    `UPDATE purchase_orders
     SET status = $2,
         approved_by = $3,
         approved_by_name = $4,
         approved_at = NOW(),
         notes = COALESCE($5, notes),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      normalizeText(payload.status || 'approved') || 'approved',
      actor.email,
      actor.full_name || actor.email,
      normalizeText(payload.notes) || null
    ]
  );

  return getPurchaseOrderById(id);
}

async function cancelPurchaseOrder(id, payload, actor) {
  const existing = await getPurchaseOrderById(id);
  if (!existing) return null;
  await query(
    `UPDATE purchase_orders
     SET status = 'cancelled',
         notes = COALESCE($2, notes),
         approved_by = $3,
         approved_by_name = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [id, normalizeText(payload.notes) || null, actor.email, actor.full_name || actor.email]
  );
  return getPurchaseOrderById(id);
}

async function getReceiptItems(receiptIds = [], executor = pool) {
  if (!receiptIds.length) return [];
  const result = await query(
    'SELECT * FROM goods_receipt_items WHERE receipt_id = ANY($1::text[]) ORDER BY created_at ASC',
    [receiptIds],
    executor
  );
  return enrichIngredientItemCodes(result.rows, executor);
}

async function listGoodsReceipts(executor = pool) {
  const headers = await query('SELECT * FROM goods_receipts ORDER BY created_at DESC', [], executor);
  const ids = headers.rows.map((row) => row.id);
  const items = await getReceiptItems(ids, executor);
  const itemMap = new Map();
  items.forEach((item) => {
    if (!itemMap.has(item.receipt_id)) {
      itemMap.set(item.receipt_id, []);
    }
    itemMap.get(item.receipt_id).push(item);
  });

  return headers.rows.map((row) => ({
    ...row,
    items: itemMap.get(row.id) || []
  }));
}

async function getGoodsReceiptById(id, executor = pool) {
  const result = await query('SELECT * FROM goods_receipts WHERE id = $1 LIMIT 1', [id], executor);
  if (!result.rowCount) return null;
  return {
    ...result.rows[0],
    items: await getReceiptItems([id], executor)
  };
}

function inventoryStatus(quantity, minimum) {
  if (quantity <= 0) return 'out_of_stock';
  if (minimum > 0 && quantity <= minimum) return 'low_stock';
  return 'in_stock';
}

async function applyReceiptToInventory(order, receiptItem, actor, executor = null) {
  await receiveStock({
    site_id: order.site_id,
    site_name: order.site_name,
    ingredient_id: receiptItem.ingredient_id,
    ingredient_name: receiptItem.ingredient_name,
    quantity: toNumber(receiptItem.accepted_quantity, 0),
    unit: receiptItem.unit,
    unit_cost: toNumber(receiptItem.unit_cost, 0),
    batch_number: receiptItem.batch_number || null,
    expiry_date: receiptItem.expiry_date || null,
    reference_id: order.id,
    reference_type: 'goods_receipt',
    notes: `Goods receipt for PO ${order.po_number}`,
    performed_by: actor.email,
    reason_code: 'procurement_receipt'
  }, executor);
}

async function createGoodsReceipt(payload, actor) {
  const order = await getPurchaseOrderById(payload.purchase_order_id);
  if (!order) {
    const error = new Error('Purchase order not found');
    error.status = 404;
    throw error;
  }

  const sourceItems = Array.isArray(payload.items) && payload.items.length
    ? payload.items
    : order.items.map((item) => ({
      order_item_id: item.id,
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      received_quantity: Math.max(0, toNumber(item.ordered_quantity) - toNumber(item.received_quantity)),
      accepted_quantity: Math.max(0, toNumber(item.ordered_quantity) - toNumber(item.received_quantity)),
      rejected_quantity: 0,
      unit: item.unit,
      batch_number: '',
      expiry_date: null
    }));

  const orderItemsById = new Map(order.items.map((item) => [String(item.id), item]));
  const items = sourceItems.map((item) => {
    const orderItemId = normalizeText(item.order_item_id);
    const linkedOrderItem = orderItemsById.get(orderItemId);
    if (!orderItemId || !linkedOrderItem) {
      const error = new Error('Goods receipt item does not belong to the selected purchase order');
      error.status = 409;
      throw error;
    }

    const receivedQuantity = toNumber(item.received_quantity, 0);
    const acceptedQuantity = toNumber(item.accepted_quantity, receivedQuantity);
    const rejectedQuantity = toNumber(item.rejected_quantity, 0);
    if (
      receivedQuantity <= 0 ||
      acceptedQuantity < 0 ||
      rejectedQuantity < 0 ||
      acceptedQuantity + rejectedQuantity > receivedQuantity
    ) {
      const error = new Error('Received, accepted, and rejected quantities are inconsistent');
      error.status = 400;
      throw error;
    }

    return {
      id: item.id || randomId('gri'),
      order_item_id: orderItemId,
      ingredient_id: normalizeText(linkedOrderItem.ingredient_id) || null,
      ingredient_name: normalizeText(linkedOrderItem.ingredient_name),
      received_quantity: receivedQuantity,
      accepted_quantity: acceptedQuantity,
      rejected_quantity: rejectedQuantity,
      unit: normalizeText(linkedOrderItem.unit || item.unit),
      unit_cost: toNumber(item.unit_cost, linkedOrderItem.unit_price),
      batch_number: normalizeText(item.batch_number) || null,
      expiry_date: item.expiry_date ? dateOnly(item.expiry_date) : null,
      status: normalizeText(item.status || 'accepted') || 'accepted'
    };
  }).filter((item) => item.ingredient_name && item.received_quantity > 0);

  if (!items.length) {
    const error = new Error('At least one received item is required');
    error.status = 400;
    throw error;
  }

  return withTransaction(async (client) => {
    const lockedOrder = await getPurchaseOrderById(order.id, client, true);
    if (!lockedOrder) {
      const error = new Error('Purchase order not found');
      error.status = 404;
      throw error;
    }
    const lockedItemsById = new Map(lockedOrder.items.map((item) => [String(item.id), item]));
    for (const item of items) {
      const lockedItem = lockedItemsById.get(item.order_item_id);
      const remainingQuantity = Math.max(
        0,
        toNumber(lockedItem?.ordered_quantity, 0) - toNumber(lockedItem?.received_quantity, 0)
      );
      if (!lockedItem || item.accepted_quantity > remainingQuantity) {
        const error = new Error('Accepted quantity exceeds the remaining purchase order quantity');
        error.status = 409;
        throw error;
      }
    }

    const receiptId = randomId('grn');
    await clientQuery(
      client,
      `INSERT INTO goods_receipts (
        id, grn_number, purchase_order_id, supplier_id, supplier_name, site_id, site_name,
        receipt_date, received_by, received_by_name, status, notes, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'posted',$11,NOW())`,
      [
        receiptId,
        normalizeText(payload.grn_number || `GRN-${Date.now()}`),
        lockedOrder.id,
        lockedOrder.supplier_id,
        lockedOrder.supplier_name,
        lockedOrder.site_id,
        lockedOrder.site_name,
        dateOnly(payload.receipt_date || nowIso()),
        actor.email,
        actor.full_name || actor.email,
        normalizeText(payload.notes) || null
      ]
    );

    for (const item of items) {
      await clientQuery(
        client,
        `INSERT INTO goods_receipt_items (
          id, receipt_id, order_item_id, ingredient_id, ingredient_name, received_quantity,
          accepted_quantity, rejected_quantity, unit, batch_number, expiry_date, status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
        [
          item.id,
          receiptId,
          item.order_item_id,
          item.ingredient_id,
          item.ingredient_name,
          item.received_quantity,
          item.accepted_quantity,
          item.rejected_quantity,
          item.unit,
          item.batch_number,
          item.expiry_date,
          item.status
        ]
      );

      if (item.order_item_id) {
        await clientQuery(
          client,
          `UPDATE purchase_order_items
           SET received_quantity = received_quantity + $2,
               status = CASE
                 WHEN received_quantity + $2 >= ordered_quantity THEN 'received'
                 ELSE 'partially_received'
               END
           WHERE id = $1`,
          [item.order_item_id, item.accepted_quantity]
        );
      }
    }

    const refreshedOrder = await getPurchaseOrderById(lockedOrder.id, client);
    const totalOrdered = refreshedOrder.items.reduce((sum, item) => sum + toNumber(item.ordered_quantity, 0), 0);
    const totalReceived = refreshedOrder.items.reduce((sum, item) => sum + toNumber(item.received_quantity, 0), 0);
    const receivedPercentage = totalOrdered > 0 ? (totalReceived / totalOrdered) * 100 : 0;
    const nextStatus = receivedPercentage >= 100 ? 'received' : 'partially_received';

    await clientQuery(
      client,
      `UPDATE purchase_orders
       SET status = $2,
           received_percentage = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [lockedOrder.id, nextStatus, receivedPercentage]
    );

    for (const item of items) {
      await applyReceiptToInventory(lockedOrder, item, actor, client);
    }

    return getGoodsReceiptById(receiptId, client);
  });
}

async function listSupplierInvoices() {
  const result = await query('SELECT * FROM supplier_invoices ORDER BY created_at DESC');
  return result.rows;
}

async function createSupplierInvoice(payload, actor) {
  const supplier = payload.supplier_id ? await getSupplierById(payload.supplier_id) : null;
  const receipt = payload.goods_receipt_id ? await getGoodsReceiptById(payload.goods_receipt_id) : null;
  let order = payload.purchase_order_id ? await getPurchaseOrderById(payload.purchase_order_id) : null;

  if (payload.supplier_id && !supplier) {
    const error = new Error('Supplier not found');
    error.status = 404;
    throw error;
  }
  if (payload.purchase_order_id && !order) {
    const error = new Error('Purchase order not found');
    error.status = 404;
    throw error;
  }
  if (payload.goods_receipt_id && !receipt) {
    const error = new Error('Goods receipt not found');
    error.status = 404;
    throw error;
  }

  if (receipt && !order) {
    order = await getPurchaseOrderById(receipt.purchase_order_id);
  }
  if (receipt && order && receipt.purchase_order_id !== order.id) {
    const error = new Error('Goods receipt does not belong to the selected purchase order');
    error.status = 409;
    throw error;
  }
  if (supplier && order?.supplier_id && supplier.id !== order.supplier_id) {
    const error = new Error('Supplier does not belong to the selected purchase order');
    error.status = 409;
    throw error;
  }
  if (supplier && receipt?.supplier_id && supplier.id !== receipt.supplier_id) {
    const error = new Error('Supplier does not belong to the selected goods receipt');
    error.status = 409;
    throw error;
  }

  const subtotal = toNumber(payload.subtotal, order?.subtotal || 0);
  const taxAmount = toNumber(payload.tax_amount, order?.tax_amount || 0);
  const totalAmount = toNumber(payload.total_amount, subtotal + taxAmount);

  const result = await query(
    `INSERT INTO supplier_invoices (
      id, invoice_number, supplier_id, supplier_name, purchase_order_id, goods_receipt_id,
      invoice_date, due_date, subtotal, tax_amount, total_amount, status, entered_by,
      entered_by_name, notes, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
    RETURNING *`,
    [
      randomId('inv'),
      normalizeText(payload.invoice_number || `INV-${Date.now()}`),
      supplier?.id || order?.supplier_id || null,
      supplier?.name || order?.supplier_name || receipt?.supplier_name || null,
      order?.id || null,
      receipt?.id || null,
      dateOnly(payload.invoice_date || nowIso()),
      payload.due_date ? dateOnly(payload.due_date) : null,
      subtotal,
      taxAmount,
      totalAmount,
      normalizeText(payload.status || 'pending') || 'pending',
      actor.email,
      actor.full_name || actor.email,
      normalizeText(payload.notes) || null
    ]
  );

  return result.rows[0];
}

async function getLatestIngredientPrice(ingredientId) {
  if (!ingredientId) return null;
  const result = await query(
    `SELECT *
     FROM supplier_price_history
     WHERE ingredient_id = $1
     ORDER BY effective_date DESC, created_at DESC
     LIMIT 1`,
    [ingredientId]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function listSupplierPriceComparison({ ingredientId = '', supplierId = '' } = {}) {
  const params = [];
  const clauses = [];
  if (ingredientId) {
    params.push(ingredientId);
    clauses.push(`ingredient_id = $${params.length}`);
  }
  if (supplierId) {
    params.push(supplierId);
    clauses.push(`supplier_id = $${params.length}`);
  }

  const result = await query(
    `SELECT DISTINCT ON (COALESCE(ingredient_id, ingredient_name), COALESCE(supplier_id, supplier_name))
        *
     FROM supplier_price_history
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY COALESCE(ingredient_id, ingredient_name), COALESCE(supplier_id, supplier_name), effective_date DESC, created_at DESC`,
    params
  );
  return enrichIngredientItemCodes(result.rows);
}

async function getSupplierPerformanceDashboard() {
  const [suppliers, orders, receipts, invoices] = await Promise.all([
    listSuppliers(),
    listPurchaseOrders(),
    listGoodsReceipts(),
    listSupplierInvoices()
  ]);

  const receiptByOrder = new Map();
  receipts.forEach((receipt) => {
    if (!receiptByOrder.has(receipt.purchase_order_id)) {
      receiptByOrder.set(receipt.purchase_order_id, []);
    }
    receiptByOrder.get(receipt.purchase_order_id).push(receipt);
  });

  return suppliers.map((supplier) => {
    const supplierOrders = orders.filter((order) => order.supplier_id === supplier.id);
    const supplierInvoices = invoices.filter((invoice) => invoice.supplier_id === supplier.id);
    let delivered = 0;
    let onTime = 0;
    let leadTimeTotal = 0;
    let leadTimeCount = 0;
    let orderedQuantity = 0;
    let receivedQuantity = 0;

    supplierOrders.forEach((order) => {
      const receiptsForOrder = receiptByOrder.get(order.id) || [];
      if (receiptsForOrder.length) {
        delivered += 1;
        const firstReceipt = receiptsForOrder
          .map((receipt) => receipt.receipt_date)
          .sort()[0];
        const leadTime = daysBetween(order.order_date, firstReceipt);
        if (leadTime !== null) {
          leadTimeTotal += leadTime;
          leadTimeCount += 1;
        }
        if (!order.expected_delivery_date || firstReceipt <= order.expected_delivery_date) {
          onTime += 1;
        }
      }

      order.items.forEach((item) => {
        orderedQuantity += toNumber(item.ordered_quantity, 0);
        receivedQuantity += toNumber(item.received_quantity, 0);
      });
    });

    const totalSpend = supplierOrders.reduce((sum, order) => sum + toNumber(order.total_amount, 0), 0);
    const invoicedAmount = supplierInvoices.reduce((sum, invoice) => sum + toNumber(invoice.total_amount, 0), 0);
    const fulfilmentRate = orderedQuantity > 0 ? (receivedQuantity / orderedQuantity) * 100 : 0;

    return {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      status: supplier.status,
      total_orders: supplierOrders.length,
      pending_orders: supplierOrders.filter((order) => ['pending', 'approved', 'partially_received'].includes(order.status)).length,
      completed_orders: supplierOrders.filter((order) => order.status === 'received').length,
      cancelled_orders: supplierOrders.filter((order) => order.status === 'cancelled').length,
      total_spend: totalSpend,
      invoiced_amount: invoicedAmount,
      on_time_delivery_rate: delivered > 0 ? (onTime / delivered) * 100 : 0,
      average_lead_time_days: leadTimeCount > 0 ? leadTimeTotal / leadTimeCount : 0,
      fulfilment_rate: fulfilmentRate,
      quality_rating: supplier.rating || 0
    };
  }).sort((left, right) => right.total_spend - left.total_spend);
}

export {
  listSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listPurchaseRequests,
  getPurchaseRequestById,
  createPurchaseRequest,
  approvePurchaseRequest,
  autoGeneratePurchaseRequestFromLowStock,
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  listGoodsReceipts,
  getGoodsReceiptById,
  createGoodsReceipt,
  listSupplierInvoices,
  createSupplierInvoice,
  listSupplierPriceComparison,
  getSupplierPerformanceDashboard
};
