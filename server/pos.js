import crypto from 'node:crypto';
import {
  pool,
  withTransaction,
  listDocuments,
  findDocument,
  validateDocumentRelationships
} from './db.js';
import { deductStock } from './inventory.js';
import { convertIngredientQuantity } from '../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../shared/recipeComposition.js';

const POS_STATUSES = new Set(['success', 'warning', 'error']);

const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();

function normalizeText(value) {
  return String(value || '').trim();
}

function toLowerSafe(value) {
  return normalizeText(value).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ensureDate(value) {
  if (!value) {
    return nowIso();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
}

function businessDateFromDateTime(value) {
  return ensureDate(value).slice(0, 10);
}

function parseSettingsObject(settings) {
  if (!settings) return {};
  if (typeof settings === 'object') return settings || {};
  try {
    return JSON.parse(settings);
  } catch {
    return {};
  }
}

function parseHeaderLines(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.includes(':') ? line.indexOf(':') : line.indexOf('=');
      if (separatorIndex <= 0) return null;
      const header_name = line.slice(0, separatorIndex).trim();
      const header_value = line.slice(separatorIndex + 1).trim();
      return header_name && header_value ? { header_name, header_value } : null;
    })
    .filter(Boolean);
}

function normalizeSourceHeaders(payload = {}) {
  const settings = parseSettingsObject(payload.settings);
  const headers = [];
  if (settings.headers && typeof settings.headers === 'object' && !Array.isArray(settings.headers)) {
    Object.entries(settings.headers).forEach(([header_name, header_value]) => {
      const name = normalizeText(header_name);
      const value = normalizeText(header_value);
      if (name && value) headers.push({ header_name: name, header_value: value });
    });
  }
  parseHeaderLines(payload.extra_headers_text || payload.headers_text).forEach((header) => headers.push(header));
  if (Array.isArray(payload.headers)) {
    payload.headers.forEach((header) => {
      const name = normalizeText(header.header_name || header.name || header.key);
      const value = normalizeText(header.header_value || header.value);
      if (name && value) headers.push({ header_name: name, header_value: value });
    });
  }
  const deduped = new Map();
  headers.forEach((header) => deduped.set(header.header_name.toLowerCase(), header));
  return [...deduped.values()];
}

function headersObject(headers = []) {
  return Object.fromEntries((Array.isArray(headers) ? headers : [])
    .filter((header) => header?.header_name && header?.header_value)
    .map((header) => [header.header_name, header.header_value]));
}

function headerLines(headers = []) {
  return (Array.isArray(headers) ? headers : [])
    .filter((header) => header?.header_name && header?.header_value)
    .map((header) => `${header.header_name}: ${header.header_value}`)
    .join('\n');
}

function hydratePosSource(row = {}, headers = []) {
  const normalizedHeaders = Array.isArray(headers) ? headers : [];
  return {
    ...row,
    settings: { headers: headersObject(normalizedHeaders) },
    headers: normalizedHeaders,
    extra_headers_text: headerLines(normalizedHeaders)
  };
}

async function listPosSourceHeaders(sourceIds = [], executor = pool) {
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : [])
    .map((id) => normalizeText(id))
    .filter(Boolean))];
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT source_id, header_name, header_value, header_order
       FROM pos_source_headers
      WHERE source_id = ANY($1::text[])
      ORDER BY source_id ASC, header_order ASC, header_name ASC`,
    [ids],
    executor
  );
  return result.rows.reduce((map, row) => {
    if (!map.has(row.source_id)) map.set(row.source_id, []);
    map.get(row.source_id).push({
      header_name: row.header_name,
      header_value: row.header_value
    });
    return map;
  }, new Map());
}

async function replacePosSourceHeaders(sourceId, headers = [], executor = pool) {
  await query('DELETE FROM pos_source_headers WHERE source_id = $1', [sourceId], executor);
  let order = 0;
  for (const header of headers.slice(0, 50)) {
    order += 1;
    await query(
      `INSERT INTO pos_source_headers (
         id, source_id, header_name, header_value, header_order, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [randomId('poshdr'), sourceId, header.header_name, header.header_value, order],
      executor
    );
  }
}

function syncPayloadSummary(payload = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const parts = [];
  if (safePayload.url) parts.push(`URL: ${safePayload.url}`);
  if (safePayload.source_id || safePayload.sourceId) parts.push(`Source: ${safePayload.source_id || safePayload.sourceId}`);
  if (safePayload.order_count !== undefined) parts.push(`Orders: ${safePayload.order_count}`);
  if (safePayload.webhook) parts.push('Webhook import');
  if (Array.isArray(safePayload.headers)) parts.push(`Headers: ${safePayload.headers.join(', ')}`);
  return parts.join(' | ') || null;
}

async function query(text, params = [], executor = pool) {
  return executor.query(text, params);
}

async function requireSite(siteId, executor = pool) {
  const normalizedSiteId = normalizeText(siteId);
  if (!normalizedSiteId) return null;
  await validateDocumentRelationships(
    'PosRecord',
    { site_id: normalizedSiteId },
    null,
    executor
  );
  const site = await findDocument('Site', normalizedSiteId, executor);
  if (!site) {
    const error = new Error('Site not found');
    error.status = 404;
    throw error;
  }
  return site;
}

function requireApiSettings(source) {
  if (!source?.api_url) {
    const error = new Error('POS source API URL is required');
    error.status = 400;
    throw error;
  }
}

function normalizeOrderPayload(order, source) {
  const items = Array.isArray(order.items) ? order.items : [];
  const soldAt = ensureDate(order.sold_at || order.order_date || order.business_date || order.created_at);
  const businessDate = businessDateFromDateTime(order.business_date || soldAt);
  const locationName = normalizeText(order.location_name || order.site_name || order.location || source.default_site_name);
  const siteId = normalizeText(order.site_id || source.default_site_id);
  const siteName = normalizeText(order.site_name || source.default_site_name || locationName);
  const normalizedItems = items.map((item) => ({
    external_item_id: normalizeText(item.external_item_id || item.id),
    pos_item_code: normalizeText(item.pos_item_code || item.item_code || item.sku || item.menu_code),
    pos_item_name: normalizeText(item.pos_item_name || item.name || item.item_name),
    quantity: toNumber(item.quantity, 0),
    unit_price: toNumber(item.unit_price || item.price, 0),
    total_price: toNumber(item.total_price || item.line_total, 0),
    site_id: normalizeText(item.site_id || siteId),
    site_name: normalizeText(item.site_name || siteName)
  })).filter((item) => item.pos_item_name && item.quantity > 0);

  return {
    external_order_id: normalizeText(order.external_order_id || order.order_id || order.id || order.ticket_id),
    order_number: normalizeText(order.order_number || order.order_id || order.ticket_number || order.reference),
    site_id: siteId || null,
    site_name: siteName || null,
    location_name: locationName || siteName || null,
    business_date: businessDate,
    sold_at: soldAt,
    currency: normalizeText(order.currency || 'SAR') || 'SAR',
    total_amount: toNumber(order.total_amount || order.total || order.gross_total, 0),
    items: normalizedItems
  };
}

async function getPosSources() {
  const result = await query('SELECT * FROM pos_sources ORDER BY updated_at DESC');
  const headersBySource = await listPosSourceHeaders(result.rows.map((row) => row.id));
  return result.rows.map((row) => hydratePosSource(row, headersBySource.get(row.id) || []));
}

async function getPosSourceById(id, executor = pool) {
  const result = await query('SELECT * FROM pos_sources WHERE id = $1 LIMIT 1', [id], executor);
  if (!result.rowCount) return null;
  const headersBySource = await listPosSourceHeaders([id], executor);
  return hydratePosSource(result.rows[0], headersBySource.get(id) || []);
}

async function createPosSource(payload) {
  return withTransaction(async (client) => {
    await requireSite(payload.default_site_id, client);
    const id = randomId('possrc');
    const headers = normalizeSourceHeaders(payload);
    const result = await query(
      `INSERT INTO pos_sources (
        id, name, source_type, api_url, api_key, api_secret, sync_frequency, is_active,
        default_site_id, default_site_name, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
      RETURNING *`,
      [
        id,
        normalizeText(payload.name),
        normalizeText(payload.source_type || 'api'),
        normalizeText(payload.api_url) || null,
        normalizeText(payload.api_key) || null,
        normalizeText(payload.api_secret) || null,
        normalizeText(payload.sync_frequency || 'manual'),
        payload.is_active !== false,
        normalizeText(payload.default_site_id) || null,
        normalizeText(payload.default_site_name) || null
      ],
      client
    );
    await replacePosSourceHeaders(id, headers, client);
    return hydratePosSource(result.rows[0], headers);
  });
}

async function updatePosSource(id, patch) {
  const existing = await getPosSourceById(id);
  if (!existing) return null;
  return withTransaction(async (client) => {
    await requireSite(patch.default_site_id ?? existing.default_site_id, client);
    const headers = Object.hasOwn(patch || {}, 'settings')
      || Object.hasOwn(patch || {}, 'extra_headers_text')
      || Object.hasOwn(patch || {}, 'headers_text')
      || Object.hasOwn(patch || {}, 'headers')
      ? normalizeSourceHeaders(patch)
      : existing.headers || [];
    const result = await query(
      `UPDATE pos_sources
       SET name = $2,
           source_type = $3,
           api_url = $4,
           api_key = $5,
           api_secret = $6,
           sync_frequency = $7,
           is_active = $8,
           default_site_id = $9,
           default_site_name = $10,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        normalizeText(patch.name ?? existing.name),
        normalizeText(patch.source_type ?? existing.source_type),
        normalizeText(patch.api_url ?? existing.api_url) || null,
        normalizeText(patch.api_key ?? existing.api_key) || null,
        normalizeText(patch.api_secret ?? existing.api_secret) || null,
        normalizeText(patch.sync_frequency ?? existing.sync_frequency),
        patch.is_active ?? existing.is_active,
        normalizeText(patch.default_site_id ?? existing.default_site_id) || null,
        normalizeText(patch.default_site_name ?? existing.default_site_name) || null
      ],
      client
    );
    await replacePosSourceHeaders(id, headers, client);
    return hydratePosSource(result.rows[0], headers);
  });
}

async function deletePosSource(id) {
  const result = await query('DELETE FROM pos_sources WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function getRecipeMappings() {
  const result = await query('SELECT * FROM pos_recipe_mapping ORDER BY updated_at DESC');
  return result.rows;
}

async function getRecipeMappingById(id) {
  const result = await query('SELECT * FROM pos_recipe_mapping WHERE id = $1 LIMIT 1', [id]);
  return result.rowCount ? result.rows[0] : null;
}

async function createRecipeMapping(payload) {
  return withTransaction(async (client) => {
    await validateDocumentRelationships(
      'PosRecipeMapping',
      {
        recipe_id: normalizeText(payload.recipe_id),
        site_id: normalizeText(payload.site_id) || null
      },
      null,
      client
    );
    const recipe = await findDocument('Recipe', payload.recipe_id, client);
    const id = randomId('posmap');
    const result = await query(
      `INSERT INTO pos_recipe_mapping (
        id, source_id, pos_item_code, pos_item_name, recipe_id, recipe_name, servings_per_sale,
        site_scope, site_id, auto_deduct, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
      RETURNING *`,
      [
        id,
        normalizeText(payload.source_id) || null,
        normalizeText(payload.pos_item_code) || null,
        normalizeText(payload.pos_item_name),
        normalizeText(payload.recipe_id),
        recipe.name || normalizeText(payload.recipe_name),
        toNumber(payload.servings_per_sale, 1),
        normalizeText(payload.site_scope || 'global'),
        normalizeText(payload.site_id) || null,
        payload.auto_deduct !== false,
        normalizeText(payload.notes) || null
      ],
      client
    );
    return result.rows[0];
  });
}

async function updateRecipeMapping(id, patch) {
  const existing = await getRecipeMappingById(id);
  if (!existing) return null;
  return withTransaction(async (client) => {
    const recipeId = normalizeText(patch.recipe_id ?? existing.recipe_id);
    const siteId = normalizeText(patch.site_id ?? existing.site_id) || null;
    await validateDocumentRelationships(
      'PosRecipeMapping',
      { recipe_id: recipeId, site_id: siteId },
      null,
      client
    );
    const recipe = await findDocument('Recipe', recipeId, client);
    const result = await query(
      `UPDATE pos_recipe_mapping
       SET source_id = $2,
           pos_item_code = $3,
           pos_item_name = $4,
           recipe_id = $5,
           recipe_name = $6,
           servings_per_sale = $7,
           site_scope = $8,
           site_id = $9,
           auto_deduct = $10,
           notes = $11,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        normalizeText(patch.source_id ?? existing.source_id) || null,
        normalizeText(patch.pos_item_code ?? existing.pos_item_code) || null,
        normalizeText(patch.pos_item_name ?? existing.pos_item_name),
        recipeId,
        recipe.name || normalizeText(patch.recipe_name ?? existing.recipe_name),
        toNumber(patch.servings_per_sale ?? existing.servings_per_sale, 1),
        normalizeText(patch.site_scope ?? existing.site_scope ?? 'global'),
        siteId,
        patch.auto_deduct ?? existing.auto_deduct,
        normalizeText(patch.notes ?? existing.notes) || null
      ],
      client
    );
    return result.rows[0];
  });
}

async function deleteRecipeMapping(id) {
  const result = await query('DELETE FROM pos_recipe_mapping WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function createSyncLog(payload) {
  const id = randomId('poslog');
  const status = POS_STATUSES.has(payload.status) ? payload.status : 'success';
  await query(
    `INSERT INTO pos_sync_logs (
      id, source_id, sync_type, status, started_at, finished_at, records_received,
      records_imported, records_skipped, message, request_url, request_summary,
      response_summary, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
    [
      id,
      payload.source_id || null,
      payload.sync_type || 'manual_upload',
      status,
      payload.started_at || nowIso(),
      payload.finished_at || nowIso(),
      toNumber(payload.records_received, 0),
      toNumber(payload.records_imported, 0),
      toNumber(payload.records_skipped, 0),
      payload.message || null,
      payload.request_url || payload.request_payload?.url || null,
      payload.request_summary || syncPayloadSummary(payload.request_payload),
      payload.response_summary || syncPayloadSummary(payload.response_payload)
    ]
  );
  return id;
}

async function getSyncLogs(limit = 100) {
  const result = await query(
    'SELECT * FROM pos_sync_logs ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

async function resolveMapping(sourceId, itemCode, itemName, siteId) {
  const result = await query(
    `SELECT * FROM pos_recipe_mapping
     WHERE (source_id = $1 OR source_id IS NULL)
       AND (
         (pos_item_code IS NOT NULL AND LOWER(pos_item_code) = LOWER($2))
         OR LOWER(pos_item_name) = LOWER($3)
       )
     ORDER BY
       CASE
         WHEN site_scope = 'site' AND site_id = $4 THEN 0
         WHEN site_scope = 'global' THEN 1
         ELSE 2
       END,
       updated_at DESC
     LIMIT 1`,
    [sourceId || null, itemCode || '', itemName || '', siteId || null]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function findInventoryRecord(siteId, ingredientId) {
  const inventory = await listDocuments('Inventory', { filters: { site_id: siteId, ingredient_id: ingredientId } });
  return inventory[0] || null;
}

function deriveInventoryStatus(quantity, minimum) {
  if (quantity <= 0) return 'out_of_stock';
  if (minimum > 0 && quantity <= minimum) return 'low_stock';
  return 'in_stock';
}

async function applyMappedItemDeductions({ order, item, mapping, actorEmail }) {
  if (!mapping?.auto_deduct || !mapping.recipe_id) {
    return { applied: false, reason: 'No auto-deduct mapping configured' };
  }

  const [recipes, ingredients] = await Promise.all([
    listDocuments('Recipe', { limit: 5000 }),
    listDocuments('Ingredient', { limit: 5000 })
  ]);
  const recipe = recipes.find((item) => item.id === mapping.recipe_id);
  const hasComponents = recipe
    && ((Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0)
      || (Array.isArray(recipe.sub_recipes) && recipe.sub_recipes.length > 0));
  if (!hasComponents) {
    return { applied: false, reason: 'Mapped recipe has no ingredient definition' };
  }

  const saleMultiplier = recipe.servings > 0
    ? (toNumber(item.quantity) * toNumber(mapping.servings_per_sale, 1)) / toNumber(recipe.servings, 1)
    : toNumber(item.quantity);

  const expandedRecipe = expandRecipeIngredients(
    recipe,
    recipes,
    ingredients,
    { multiplier: saleMultiplier, aggregate: true }
  );

  for (const recipeIngredient of expandedRecipe.ingredients) {
    const ingredientData = ingredients.find((entry) => entry.id === recipeIngredient.ingredient_id);
    const inventory = await findInventoryRecord(order.site_id, recipeIngredient.ingredient_id);
    const inventoryUnit = inventory?.unit || ingredientData?.unit || recipeIngredient.unit;
    const quantityToDeduct = convertIngredientQuantity(
      recipeIngredient.quantity,
      recipeIngredient.unit || inventoryUnit,
      inventoryUnit,
      ingredientData
    );
    if (quantityToDeduct <= 0) continue;
    await deductStock({
      site_id: order.site_id,
      site_name: order.site_name,
      ingredient_id: recipeIngredient.ingredient_id,
      ingredient_name: recipeIngredient.ingredient_name,
      quantity: quantityToDeduct,
      unit: inventoryUnit,
      transaction_type: 'pos_sale',
      transaction_date: order.business_date,
      reference_id: order.id,
      reference_type: 'pos_sale',
      notes: `POS deduction for ${item.pos_item_name}`,
      performed_by: actorEmail || 'system',
      reason_code: 'pos_sale',
      allow_shortage: true
    });
  }

  await query(
    'UPDATE pos_sales_items SET deduction_status = $2 WHERE id = $1',
    [item.id, 'applied']
  );

  return { applied: true };
}

async function importPosOrders({ sourceId = null, syncType = 'manual_upload', actorEmail = 'system', orders = [], requestPayload = {} }) {
  const source = sourceId ? await getPosSourceById(sourceId) : null;
  const startedAt = nowIso();
  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const rawOrder of orders) {
    const order = normalizeOrderPayload(rawOrder, source || {});
    if (!order.items.length) {
      skipped += 1;
      continue;
    }

    const existing = order.external_order_id
      ? await query(
        'SELECT id FROM pos_sales_orders WHERE source_id IS NOT DISTINCT FROM $1 AND external_order_id = $2 LIMIT 1',
        [sourceId, order.external_order_id]
      )
      : { rowCount: 0 };

    if (existing.rowCount > 0) {
      skipped += 1;
      continue;
    }

    const orderId = randomId('posord');
    await query(
      `INSERT INTO pos_sales_orders (
        id, source_id, external_order_id, order_number, site_id, site_name, location_name,
        business_date, sold_at, currency, total_amount, sync_method, inventory_applied,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,NOW(),NOW())`,
      [
        orderId,
        sourceId,
        order.external_order_id || null,
        order.order_number || null,
        order.site_id || null,
        order.site_name || null,
        order.location_name || null,
        order.business_date || null,
        order.sold_at,
        order.currency,
        order.total_amount,
        syncType
      ]
    );

    let appliedForOrder = false;
    for (const normalizedItem of order.items) {
      const mapping = await resolveMapping(sourceId, normalizedItem.pos_item_code, normalizedItem.pos_item_name, normalizedItem.site_id || order.site_id);
      const itemId = randomId('positem');
      await query(
        `INSERT INTO pos_sales_items (
          id, order_id, external_item_id, pos_item_code, pos_item_name, recipe_id, recipe_name,
          quantity, unit_price, total_price, site_id, site_name, deduction_status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
        [
          itemId,
          orderId,
          normalizedItem.external_item_id || null,
          normalizedItem.pos_item_code || null,
          normalizedItem.pos_item_name,
          mapping?.recipe_id || null,
          mapping?.recipe_name || null,
          normalizedItem.quantity,
          normalizedItem.unit_price,
          normalizedItem.total_price,
          normalizedItem.site_id || order.site_id || null,
          normalizedItem.site_name || order.site_name || null,
          mapping?.auto_deduct ? 'ready' : 'unmapped'
        ]
      );

      if (mapping?.auto_deduct) {
        const deductionResult = await applyMappedItemDeductions({
          order: { ...order, id: orderId },
          item: { ...normalizedItem, id: itemId },
          mapping,
          actorEmail
        });
        appliedForOrder = appliedForOrder || deductionResult.applied;
      }
    }

    await query(
      'UPDATE pos_sales_orders SET inventory_applied = $2, updated_at = NOW() WHERE id = $1',
      [orderId, appliedForOrder]
    );

    imported += 1;
  }

  await createSyncLog({
    source_id: sourceId,
    sync_type: syncType,
    status: errors.length ? 'warning' : 'success',
    started_at: startedAt,
    finished_at: nowIso(),
    records_received: orders.length,
    records_imported: imported,
    records_skipped: skipped,
    message: errors.length ? errors.join('; ') : `Imported ${imported} order(s)`,
    request_payload: requestPayload
  });

  return {
    records_received: orders.length,
    records_imported: imported,
    records_skipped: skipped
  };
}

async function syncPosSource(sourceId, actorEmail) {
  const source = await getPosSourceById(sourceId);
  if (!source) {
    const error = new Error('POS source not found');
    error.status = 404;
    throw error;
  }

  requireApiSettings(source);
  const headers = {
    Accept: 'application/json',
    ...(source.api_key ? { Authorization: `Bearer ${source.api_key}` } : {}),
    ...(source.settings?.headers || {})
  };

  const response = await fetch(source.api_url, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    await createSyncLog({
      source_id: sourceId,
      sync_type: 'api_sync',
      status: 'error',
      started_at: nowIso(),
      finished_at: nowIso(),
      records_received: 0,
      records_imported: 0,
      records_skipped: 0,
      message: `POS sync failed with status ${response.status}`,
      request_payload: { url: source.api_url }
    });
    const error = new Error(`POS sync failed with status ${response.status}`);
    error.status = 502;
    throw error;
  }

  const payload = await response.json();
  const orders = Array.isArray(payload) ? payload : (payload.orders || []);
  return importPosOrders({
    sourceId,
    syncType: 'api_sync',
    actorEmail,
    orders,
    requestPayload: { url: source.api_url, headers: Object.keys(headers) }
  });
}

async function getDailySalesSummary({ startDate, endDate, locationId }) {
  const result = await query(
    `SELECT
       o.business_date,
       COALESCE(o.site_id, i.site_id) AS site_id,
       COALESCE(o.site_name, i.site_name, o.location_name, 'Unknown') AS site_name,
       COALESCE(o.site_name, i.site_name, o.location_name, 'Unknown') AS location_name,
       i.pos_item_code,
       i.pos_item_name,
       SUM(i.quantity) AS total_quantity,
       SUM(i.total_price) AS total_value
     FROM pos_sales_orders o
     JOIN pos_sales_items i ON i.order_id = o.id
     WHERE ($1::date IS NULL OR o.business_date >= $1::date)
       AND ($2::date IS NULL OR o.business_date <= $2::date)
       AND ($3::text IS NULL OR COALESCE(o.site_id, i.site_id) = $3::text)
     GROUP BY
       o.business_date,
       COALESCE(o.site_id, i.site_id),
       COALESCE(o.site_name, i.site_name, o.location_name, 'Unknown'),
       i.pos_item_code,
       i.pos_item_name
     ORDER BY o.business_date DESC, location_name ASC, total_quantity DESC`,
    [startDate || null, endDate || null, locationId || null]
  );
  return result.rows.map((row) => ({
    ...row,
    total_quantity: toNumber(row.total_quantity),
    total_value: toNumber(row.total_value)
  }));
}

async function getSalesProductionVariance({ startDate, endDate, locationId }) {
  const salesResult = await query(
    `SELECT
       o.business_date,
       COALESCE(o.site_id, i.site_id) AS site_id,
       COALESCE(o.site_name, i.site_name, o.location_name, 'Unknown') AS site_name,
       COALESCE(i.recipe_id, i.pos_item_name) AS item_key,
       COALESCE(i.recipe_name, i.pos_item_name) AS item_name,
       MAX(NULLIF(i.pos_item_code, '')) AS pos_item_code,
       SUM(i.quantity) AS sales_quantity
     FROM pos_sales_orders o
     JOIN pos_sales_items i ON i.order_id = o.id
     WHERE ($1::date IS NULL OR o.business_date >= $1::date)
       AND ($2::date IS NULL OR o.business_date <= $2::date)
       AND ($3::text IS NULL OR COALESCE(o.site_id, i.site_id) = $3::text)
     GROUP BY
       o.business_date,
       COALESCE(o.site_id, i.site_id),
       COALESCE(o.site_name, i.site_name, o.location_name, 'Unknown'),
       COALESCE(i.recipe_id, i.pos_item_name),
       COALESCE(i.recipe_name, i.pos_item_name)`,
    [startDate || null, endDate || null, locationId || null]
  );

  const [productionRows, recipes] = await Promise.all([
    listDocuments('Production', { sort: '-production_date', limit: 1000 }),
    listDocuments('Recipe', { sort: 'name', limit: 5000 })
  ]);
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe.id), recipe]));
  const productionMap = {};

  productionRows.forEach((production) => {
    if (!production.production_date) return;
    if (startDate && production.production_date < startDate) return;
    if (endDate && production.production_date > endDate) return;
    if (locationId && production.site_id !== locationId) return;

    const key = [
      production.production_date,
      production.site_id || '',
      production.recipe_id || production.recipe_name || ''
    ].join('::');

    if (!productionMap[key]) {
      productionMap[key] = {
        business_date: production.production_date,
        site_id: production.site_id || '',
        site_name: production.site_name || 'Unknown',
        item_key: production.recipe_id || production.recipe_name || '',
        item_code: production.recipe_code || recipeMap.get(String(production.recipe_id || ''))?.recipe_code || '',
        item_name: production.recipe_name || 'Unknown Recipe',
        production_quantity: 0
      };
    }

    productionMap[key].production_quantity += toNumber(production.actual_servings || production.target_servings);
  });

  const salesMap = {};
  salesResult.rows.forEach((row) => {
    const key = [row.business_date, row.site_id || '', row.item_key || ''].join('::');
    salesMap[key] = {
      business_date: row.business_date,
      site_id: row.site_id || '',
      site_name: row.site_name || 'Unknown',
      item_key: row.item_key || '',
      item_code: row.pos_item_code || productionMap[key]?.item_code || '',
      item_name: row.item_name || 'Unknown Item',
      sales_quantity: toNumber(row.sales_quantity),
      production_quantity: productionMap[key]?.production_quantity || 0
    };
  });

  for (const [key, production] of Object.entries(productionMap)) {
    if (!salesMap[key]) {
      salesMap[key] = {
        business_date: production.business_date,
        site_id: production.site_id,
        site_name: production.site_name,
        item_key: production.item_key,
        item_code: production.item_code,
        item_name: production.item_name,
        sales_quantity: 0,
        production_quantity: production.production_quantity
      };
    }
  }

  return Object.values(salesMap)
    .map((row) => ({
      ...row,
      variance_quantity: row.production_quantity - row.sales_quantity
    }))
    .sort((left, right) => {
      if (left.business_date === right.business_date) {
        return left.site_name.localeCompare(right.site_name);
      }
      return String(right.business_date).localeCompare(String(left.business_date));
    });
}

export {
  getPosSources,
  getPosSourceById,
  createPosSource,
  updatePosSource,
  deletePosSource,
  getRecipeMappings,
  createRecipeMapping,
  updateRecipeMapping,
  deleteRecipeMapping,
  getSyncLogs,
  importPosOrders,
  syncPosSource,
  getDailySalesSummary,
  getSalesProductionVariance
};
