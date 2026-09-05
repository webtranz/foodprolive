import {
  withTransaction,
  createDocument,
  findDocument,
  listDocuments,
  updateDocument
} from './db.js';
import { receiveStock, deductStock } from './inventory.js';
import {
  D365_QUANTITY_SEMANTICS,
  buildD365RowIdempotencyKey,
  convertD365Quantity,
  convertD365UnitCost,
  normalizeD365IngredientRow,
  normalizeD365InventoryRow,
  normalizeD365QuantitySemantics,
  resolveD365Ingredient,
  resolveD365Store,
  sanitizeD365Row,
  stableD365Hash
} from '../shared/d365Inventory.js';

const nowIso = () => new Date().toISOString();

const defaultDependencies = Object.freeze({
  withTransaction,
  createDocument,
  findDocument,
  listDocuments,
  updateDocument,
  receiveStock,
  deductStock
});

function dependenciesWith(overrides = {}) {
  return { ...defaultDependencies, ...overrides };
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function serializeReceivedAt(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? normalizeText(value) || null : parsed.toISOString();
}

function isDuplicateDocumentError(error) {
  return error?.code === '23505'
    || error?.status === 409
    || /duplicate key|already exists/i.test(error?.message || '');
}

function errorWithStatus(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function assertSiteInScope(site, scope = null) {
  if (!scope || scope.unrestricted === true) return;
  const accessibleSiteIds = new Set([
    ...(scope.accessibleSiteIds || []),
    ...(scope.accessible_site_ids || [])
  ].filter(Boolean).map(String));
  if (!accessibleSiteIds.has(String(site?.id || ''))) {
    throw errorWithStatus('The D365 warehouse is outside your accessible location scope', 403);
  }
}

export function resolveAuthorizedD365PullStore(sites = [], options = {}) {
  const locationId = normalizeText(options.location_id || options.locationId);
  const requestedWarehouseId = normalizeText(options.warehouse_id || options.warehouseId);
  const scope = options.scope || null;
  if (!locationId && !requestedWarehouseId) {
    throw errorWithStatus('Select an accessible Store with a D365 warehouse mapping before pulling inventory', 400);
  }

  let site = null;
  if (locationId) {
    site = sites.find((candidate) => String(candidate?.id || '') === locationId) || null;
    if (!site) throw errorWithStatus('Selected D365 inventory Store was not found', 404);
    assertSiteInScope(site, scope);
  } else {
    const accessibleSiteIds = new Set([
      ...(scope?.accessibleSiteIds || []),
      ...(scope?.accessible_site_ids || [])
    ].filter(Boolean).map(String));
    const visibleSites = scope?.unrestricted === true
      ? sites
      : sites.filter((candidate) => accessibleSiteIds.has(String(candidate?.id || '')));
    site = resolveD365Store(visibleSites, requestedWarehouseId);
    if (!site) {
      throw errorWithStatus('D365 warehouse is not mapped to an accessible Store', 404);
    }
  }

  const mappedWarehouseId = normalizeText(site?.d365_warehouse_id);
  const mappedStore = mappedWarehouseId ? resolveD365Store([site], mappedWarehouseId) : null;
  if (!mappedStore || mappedStore.id !== site.id) {
    throw errorWithStatus('Selected location must be a Store with an explicit D365 warehouse mapping', 409);
  }
  if (site.is_active === false) {
    throw errorWithStatus('Selected D365 inventory Store is inactive', 409);
  }
  if (
    requestedWarehouseId
    && requestedWarehouseId.toLowerCase() !== mappedWarehouseId.toLowerCase()
  ) {
    throw errorWithStatus('Selected Store does not match the requested D365 warehouse', 409);
  }

  return { site, warehouse_id: mappedWarehouseId };
}

function sanitizeInboundInput(record = {}) {
  const sensitive = /password|secret|token|authorization|api[_-]?key|credential/i;
  return Object.fromEntries(Object.entries(record || {})
    .filter(([key, value]) => !sensitive.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => {
      if (typeof value === 'string') return [key, value.slice(0, 500)];
      if (['number', 'boolean'].includes(typeof value)) return [key, value];
      return [key, String(value).slice(0, 500)];
    }));
}

function inventoryRowWithDefaults(record = {}, payload = {}) {
  const row = { ...(record || {}) };
  const setDefault = (target, aliases, value) => {
    if (value === undefined || value === null || value === '') return;
    if (!aliases.some((field) => row[field] !== undefined && row[field] !== null && row[field] !== '')) {
      row[target] = value;
    }
  };
  setDefault('batch_number', ['batch_number', 'lot_number', 'batch_id', 'Batch Number', 'InventBatchId'], payload.batch_number);
  setDefault('stock_date', ['stock_date', 'received_date', 'transaction_date', 'Stock Date', 'ReceiptDate'], payload.stock_date);
  setDefault('expiry_date', ['expiry_date', 'expiration_date', 'Expiry Date', 'ExpDate'], payload.expiry_date);
  setDefault('unit_cost', ['unit_cost', 'last_cost', 'cost_per_unit', 'Unit Cost'], payload.unit_cost);
  return row;
}

function actorIdentity(user = null) {
  return {
    id: user?.id || null,
    email: user?.email || 'd365-integration',
    name: user?.full_name || user?.email || 'D365 Integration'
  };
}

function logStatus(summary) {
  if (summary.failed_rows === 0) return 'success';
  if (summary.applied_rows > 0 || summary.skipped_rows > 0) return 'partial_success';
  return 'failed';
}

function summarizeRows(rows = []) {
  return {
    total_rows: rows.length,
    applied_rows: rows.filter((row) => row.status === 'applied').length,
    skipped_rows: rows.filter((row) => row.status === 'skipped_duplicate').length,
    failed_rows: rows.filter((row) => row.status === 'failed').length
  };
}

async function createInboundLog({
  operation,
  moduleKey,
  sourceSystem,
  syncId,
  semantics,
  records,
  receivedAt = null,
  user,
  retryOfLogId = null,
  configId = null
}, dependencies) {
  const actor = actorIdentity(user);
  return dependencies.createDocument('ERPIntegrationLog', {
    config_id: configId || null,
    provider_name: 'Dynamics 365 Finance & Operations',
    module_key: moduleKey,
    operation,
    direction: 'inbound',
    transport: 'api',
    status: 'processing',
    message: `Processing ${records.length} inbound D365 row${records.length === 1 ? '' : 's'}.`,
    records_count: records.length,
    source_system: sourceSystem,
    sync_id: syncId,
    retry_of_log_id: retryOfLogId,
    request_payload: {
      operation,
      module_key: moduleKey,
      source_system: sourceSystem,
      sync_id: syncId,
      quantity_semantics: semantics || null,
      received_at: serializeReceivedAt(receivedAt),
      records: records.map(sanitizeInboundInput)
    },
    response_payload: { rows: [] },
    retry_count: retryOfLogId ? 1 : 0,
    attempted_by: actor.email,
    attempted_by_name: actor.name,
    attempted_at: nowIso()
  });
}

async function finishInboundLog(log, rowResults, dependencies) {
  const summary = summarizeRows(rowResults);
  const status = logStatus(summary);
  const siteIds = [...new Set(rowResults.map((row) => row.site_id).filter(Boolean))];
  const completedAt = nowIso();
  const updated = await dependencies.updateDocument('ERPIntegrationLog', log.id, {
    status,
    message: `${summary.applied_rows} applied, ${summary.skipped_rows} skipped, ${summary.failed_rows} failed.`,
    records_count: summary.total_rows,
    applied_count: summary.applied_rows,
    skipped_count: summary.skipped_rows,
    failed_count: summary.failed_rows,
    site_id: siteIds.length === 1 ? siteIds[0] : null,
    site_ids: siteIds,
    response_payload: {
      summary,
      rows: rowResults
    },
    completed_at: completedAt
  });
  return { log: updated, summary, rows: rowResults };
}

function idempotencyDocumentId(key) {
  return `d365evt_${normalizeText(key).slice(0, 48)}`;
}

async function claimRowIdempotency({
  key,
  moduleKey,
  sourceSystem,
  syncId,
  site,
  ingredient,
  input,
  logId
}, dependencies, executor) {
  const id = idempotencyDocumentId(key);
  const existing = await dependencies.findDocument('D365Master', id, executor, true);
  if (existing) return { claimed: false, record: existing };

  try {
    const record = await dependencies.createDocument('D365Master', {
      id,
      status: 'processed',
      source_system: sourceSystem,
      module_key: moduleKey,
      sync_id: syncId,
      idempotency_key: key,
      site_id: site?.id || null,
      site_name: site?.name || null,
      ingredient_id: ingredient?.id || null,
      ingredient_name: ingredient?.name || input?.item_name || null,
      d365_item_id: input?.item_id || null,
      d365_warehouse_id: input?.warehouse_id || null,
      integration_log_id: logId,
      processed_at: nowIso()
    }, executor);
    return { claimed: true, record };
  } catch (error) {
    if (!isDuplicateDocumentError(error)) throw error;
    return {
      claimed: false,
      record: await dependencies.findDocument('D365Master', id, executor, true)
    };
  }
}

async function findInventory(siteId, ingredientId, dependencies, executor) {
  const records = await dependencies.listDocuments('Inventory', {
    filters: { site_id: siteId, ingredient_id: ingredientId },
    limit: 2,
    lock: Boolean(executor)
  }, executor || undefined);
  return records[0] || null;
}

function inventoryQuantity(record) {
  // D365 snapshots represent physical stock. Local production reservations
  // reduce allocatable quantity without changing physical on-hand, so comparing
  // a snapshot with available_quantity would fabricate an inbound receipt.
  const numeric = Number(
    record?.on_hand_quantity
      ?? record?.usable_on_hand_quantity
      ?? record?.available_quantity
      ?? record?.quantity
      ?? 0
  );
  return Number.isFinite(numeric) ? numeric : 0;
}

function assertRequestedWarehouse(normalized, payload = {}) {
  const requested = normalizeText(payload.warehouse_id).toLowerCase();
  if (requested && normalizeText(normalized?.warehouse_id).toLowerCase() !== requested) {
    throw errorWithStatus(
      `D365 row warehouse ${normalized?.warehouse_id || '(blank)'} does not match selected warehouse ${payload.warehouse_id}`,
      409
    );
  }
}

function knownNonNegativeCost(record, fields = []) {
  for (const field of fields) {
    const value = record?.[field];
    if (value === undefined || value === null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function resolveCanonicalUnitCost({ normalized, ingredient, inventory, canonicalQuantity }) {
  if (normalized.unit_cost !== undefined && normalized.unit_cost !== null) {
    return convertD365UnitCost(normalized.unit_cost, normalized.quantity, canonicalQuantity);
  }
  const existingCost = knownNonNegativeCost(inventory, [
    'average_unit_cost', 'last_unit_cost', 'unit_cost'
  ]);
  if (existingCost !== null) return existingCost;
  const ingredientCost = knownNonNegativeCost(ingredient, [
    'cost_per_unit', 'last_cost', 'average_cost', 'current_cost'
  ]);
  if (ingredientCost !== null) return ingredientCost;
  throw errorWithStatus(
    `D365 item ${normalized.item_id} has no unit cost and no existing FoodPro cost is available`,
    409
  );
}

function assertNoDuplicateSnapshotTargets({
  records,
  ingredients,
  sites,
  payload,
  sourceSystem,
  syncId,
  semantics
}) {
  if (semantics !== D365_QUANTITY_SEMANTICS.SNAPSHOT) return;
  const targets = new Map();
  for (let index = 0; index < records.length; index += 1) {
    try {
      const normalized = normalizeD365InventoryRow(records[index], {
        quantitySemantics: semantics,
        receivedAt: payload.received_at || new Date(),
        moduleKey: 'inventory_sync_api',
        sourceSystem,
        syncId
      });
      assertRequestedWarehouse(normalized, payload);
      const site = resolveD365Store(sites, normalized.warehouse_id);
      const ingredient = resolveD365Ingredient(ingredients, normalized.item_id);
      const target = `${site?.id || normalized.warehouse_id.toLowerCase()}::${ingredient?.id || normalized.item_id.toLowerCase()}`;
      if (targets.has(target)) {
        throw errorWithStatus(
          `Snapshot rows ${targets.get(target)} and ${index + 1} target the same FoodPro item and Store. Send one aggregate snapshot row per item/warehouse, or use receipt mode for separate batches.`,
          409
        );
      }
      targets.set(target, index + 1);
    } catch (error) {
      if (error?.status === 409 && /target the same FoodPro item and Store/.test(error.message || '')) {
        throw error;
      }
      // Ordinary row validation remains row-scoped so one malformed row does
      // not suppress the integration log for the other rows.
    }
  }
}

function buildAppliedRow({
  rowNumber,
  normalized,
  site,
  ingredient,
  beforeQuantity,
  incomingQuantity,
  deltaQuantity,
  afterQuantity,
  canonicalUnitCost,
  receipt,
  lot,
  movement,
  sourceSystem,
  input
}) {
  const transaction = receipt?.transaction || movement?.transaction || null;
  const movementLayers = receipt?.transaction?.movement_layers || movement?.movement_layers || [];
  const action = deltaQuantity > 0
    ? (normalized.quantity_semantics === D365_QUANTITY_SEMANTICS.RECEIPT ? 'received' : 'increased')
    : (deltaQuantity < 0 ? 'decreased' : 'reconciled_no_change');
  const transactionType = transaction?.transaction_type
    || (deltaQuantity > 0 ? 'receipt' : (deltaQuantity < 0 ? 'adjustment' : 'reconciliation'));
  return {
    row_number: rowNumber,
    status: 'applied',
    action,
    transaction_type: transactionType,
    source: transaction?.source || sourceSystem || 'd365',
    source_type: transaction?.source_type || (normalized.quantity_semantics === D365_QUANTITY_SEMANTICS.RECEIPT
      ? 'new_stock_upload'
      : 'stock_correction'),
    reason_code: transaction?.reason_code || (normalized.quantity_semantics === D365_QUANTITY_SEMANTICS.RECEIPT
      ? 'd365_new_stock_upload'
      : 'd365_stock_correction'),
    site_id: site.id,
    site_name: site.name,
    ingredient_id: ingredient.id,
    ingredient_name: ingredient.name,
    item_id: normalized.item_id,
    warehouse_id: normalized.warehouse_id,
    quantity_semantics: normalized.quantity_semantics,
    before_quantity: Number(beforeQuantity.toFixed(4)),
    incoming_quantity: Number(incomingQuantity.toFixed(4)),
    adjustment_quantity: Number(deltaQuantity.toFixed(4)),
    after_quantity: Number(afterQuantity.toFixed(4)),
    unit: ingredient.unit || normalized.unit,
    unit_cost: canonicalUnitCost,
    total_cost: receipt?.transaction?.total_cost
      ?? movement?.total_cost
      ?? (canonicalUnitCost === null ? null : Number((Math.abs(deltaQuantity) * canonicalUnitCost).toFixed(2))),
    batch_number: lot?.batch_number || normalized.batch_number,
    stock_date: lot?.stock_date || lot?.received_date || normalized.stock_date,
    expiry_date: lot?.expiry_date || normalized.expiry_date,
    inventory_lot_id: lot?.id || null,
    inventory_transaction_id: receipt?.transaction?.id
      || movement?.transaction_id
      || movement?.transaction?.id
      || null,
    movement_layers: movementLayers,
    affected_batches: movementLayers
      .map((layer) => ({
        inventory_lot_id: layer.inventory_lot_id || null,
        batch_number: layer.batch_number || null,
        stock_date: layer.stock_date || layer.received_date || null,
        expiry_date: layer.expiry_date || null,
        quantity: layer.quantity,
        quantity_before: layer.quantity_before,
        quantity_after: layer.quantity_after,
        unit_cost: layer.unit_cost,
        total_cost: layer.total_cost,
        accounting_unit_cost: layer.accounting_unit_cost,
        accounting_total_cost: layer.accounting_total_cost
      })),
    idempotency_key: normalized.idempotency_key,
    input: sanitizeInboundInput(input)
  };
}

export async function importD365Inventory(payload = {}, dependencyOverrides = {}) {
  const dependencies = dependenciesWith(dependencyOverrides);
  const records = (Array.isArray(payload.records) ? payload.records : [])
    .map((record) => inventoryRowWithDefaults(record, payload));
  const sourceSystem = normalizeText(payload.source_system || 'd365').toLowerCase();
  const syncId = normalizeText(payload.sync_id);
  const semantics = normalizeD365QuantitySemantics(payload.quantity_semantics);
  const receivedAt = payload.received_at || new Date();
  if (!syncId) throw errorWithStatus('sync_id is required for D365 inventory imports');
  if (!records.length) throw errorWithStatus('At least one D365 inventory row is required');
  if (payload.dry_run === true) {
    return previewD365InventoryImport(payload, dependencyOverrides);
  }

  const moduleKey = 'inventory_sync_api';
  const [ingredients, sites] = await Promise.all([
    dependencies.listDocuments('Ingredient', { limit: 10000 }),
    dependencies.listDocuments('Site', { limit: 10000 })
  ]);
  assertNoDuplicateSnapshotTargets({
    records,
    ingredients,
    sites,
    payload: { ...payload, received_at: receivedAt },
    sourceSystem,
    syncId,
    semantics
  });
  const log = await createInboundLog({
    operation: 'inventory_import',
    moduleKey,
    sourceSystem,
    syncId,
    semantics,
    records,
    receivedAt,
    user: payload.user,
    retryOfLogId: payload.retry_of_log_id,
    configId: payload.config_id
  }, dependencies);
  const rowResults = [];

  for (let index = 0; index < records.length; index += 1) {
    const input = records[index] || {};
    const rowNumber = index + 1;
    let normalized = null;
    let ingredient = null;
    let site = null;
    try {
      normalized = normalizeD365InventoryRow(input, {
        quantitySemantics: semantics,
        receivedAt,
        moduleKey,
        sourceSystem,
        syncId
      });
      assertRequestedWarehouse(normalized, payload);
      site = resolveD365Store(sites, normalized.warehouse_id);
      if (!site) throw errorWithStatus(`D365 warehouse ${normalized.warehouse_id} is not mapped to a Store`, 409);
      assertSiteInScope(site, payload.scope);
      ingredient = resolveD365Ingredient(ingredients, normalized.item_id);
      if (!ingredient) throw errorWithStatus(`D365 item ${normalized.item_id} is not mapped to an Ingredient`, 409);
      const canonicalUnit = ingredient.unit || normalized.unit;
      const canonicalQuantity = convertD365Quantity(
        normalized.quantity,
        normalized.unit,
        canonicalUnit,
        ingredient
      );

      const result = await dependencies.withTransaction(async (client) => {
        const claim = await claimRowIdempotency({
          key: normalized.idempotency_key,
          moduleKey,
          sourceSystem,
          syncId,
          site,
          ingredient,
          input: normalized,
          logId: log.id
        }, dependencies, client);
        if (!claim.claimed) {
          return {
            row_number: rowNumber,
            status: 'skipped_duplicate',
            site_id: site.id,
            site_name: site.name,
            ingredient_id: ingredient.id,
            ingredient_name: ingredient.name,
            item_id: normalized.item_id,
            warehouse_id: normalized.warehouse_id,
            idempotency_key: normalized.idempotency_key,
            input: sanitizeInboundInput(input)
          };
        }

        if (typeof client?.query === 'function') {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`inventory:${String(site.id)}:${String(ingredient.id)}`]
          );
        }
        const existingInventory = await findInventory(site.id, ingredient.id, dependencies, client);
        const beforeQuantity = inventoryQuantity(existingInventory);
        const deltaQuantity = semantics === D365_QUANTITY_SEMANTICS.SNAPSHOT
          ? canonicalQuantity - beforeQuantity
          : canonicalQuantity;
        const canonicalUnitCost = deltaQuantity > 0
          ? resolveCanonicalUnitCost({
            normalized,
            ingredient,
            inventory: existingInventory,
            canonicalQuantity
          })
          : (normalized.unit_cost === null
            ? null
            : convertD365UnitCost(normalized.unit_cost, normalized.quantity, canonicalQuantity));
        let receipt = null;
        let movement = null;

        if (deltaQuantity > 0) {
          receipt = await dependencies.receiveStock({
            site_id: site.id,
            site_name: site.name,
            ingredient_id: ingredient.id,
            ingredient_name: ingredient.name,
            quantity: deltaQuantity,
            unit: canonicalUnit,
            unit_cost: canonicalUnitCost,
            batch_number: normalized.batch_number,
            stock_date: normalized.stock_date,
            received_date: normalized.stock_date,
            transaction_date: normalized.stock_date,
            expiry_date: normalized.expiry_date,
            reference_id: normalized.external_event_id || normalized.idempotency_key,
            reference_type: 'd365_inventory_import',
            notes: [
              semantics === D365_QUANTITY_SEMANTICS.RECEIPT
                ? `New stock received from D365 sync ${syncId}`
                : `Positive D365 inventory snapshot correction from sync ${syncId}`,
              normalizeText(payload.notes)
            ].filter(Boolean).join(' — '),
            performed_by: actorIdentity(payload.user).email,
            reason_code: semantics === D365_QUANTITY_SEMANTICS.RECEIPT
              ? 'd365_new_stock_upload'
              : 'd365_stock_correction',
            source_name: 'D365',
            source: sourceSystem,
            source_type: semantics === D365_QUANTITY_SEMANTICS.RECEIPT ? 'new_stock_upload' : 'stock_correction',
            operation: 'd365_inventory_import',
            operation_id: normalized.external_event_id || syncId,
            idempotency_key: normalized.idempotency_key,
            metadata: {
              integration_log_id: log.id,
              external_event_id: normalized.external_event_id || syncId,
              external_line_id: normalized.external_line_id || normalized.idempotency_key,
              quantity_semantics: semantics,
              d365_warehouse_id: normalized.warehouse_id
            }
          }, client);
        } else if (deltaQuantity < 0) {
          movement = await dependencies.deductStock({
            site_id: site.id,
            site_name: site.name,
            ingredient_id: ingredient.id,
            ingredient_name: ingredient.name,
            quantity: Math.abs(deltaQuantity),
            unit: canonicalUnit,
            transaction_type: 'adjustment',
            transaction_date: normalized.stock_date,
            reference_id: normalized.external_event_id || normalized.idempotency_key,
            reference_type: 'd365_inventory_import',
            notes: [
              `Negative D365 inventory snapshot correction from sync ${syncId}`,
              normalizeText(payload.notes)
            ].filter(Boolean).join(' — '),
            performed_by: actorIdentity(payload.user).email,
            valuation_method: existingInventory?.valuation_method || 'fifo',
            reason_code: 'd365_stock_correction',
            allow_shortage: false,
            source_name: 'D365',
            source: sourceSystem,
            source_type: 'stock_correction',
            operation: 'd365_inventory_import',
            operation_id: normalized.external_event_id || syncId,
            idempotency_key: normalized.idempotency_key,
            metadata: {
              integration_log_id: log.id,
              external_event_id: normalized.external_event_id || syncId,
              external_line_id: normalized.external_line_id || normalized.idempotency_key,
              quantity_semantics: semantics,
              d365_warehouse_id: normalized.warehouse_id
            }
          }, client);
        }

        const refreshedInventory = receipt?.inventory
          || movement?.inventory
          || existingInventory;
        if (refreshedInventory) {
          await dependencies.updateDocument('Inventory', refreshedInventory.id, compactObject({
            d365_item_id: normalized.item_id,
            d365_warehouse_id: normalized.warehouse_id,
            d365_ordered_in_total: normalized.ordered_in_total,
            d365_on_order_reserved: normalized.on_order_reserved,
            d365_last_available_quantity: semantics === D365_QUANTITY_SEMANTICS.SNAPSHOT
              ? canonicalQuantity
              : undefined,
            d365_last_sync_id: syncId,
            d365_last_synced_at: nowIso()
          }), client);
        }
        const afterQuantity = refreshedInventory
          ? inventoryQuantity(refreshedInventory)
          : (beforeQuantity + deltaQuantity);
        const appliedUnitCost = deltaQuantity < 0 && Number(movement?.issued_quantity) > 0
          ? Number(movement.total_cost || 0) / Number(movement.issued_quantity)
          : canonicalUnitCost;

        return buildAppliedRow({
          rowNumber,
          normalized,
          site,
          ingredient,
          beforeQuantity,
          incomingQuantity: canonicalQuantity,
          deltaQuantity,
          afterQuantity,
          canonicalUnitCost: appliedUnitCost,
          receipt,
          lot: receipt?.lot,
          movement,
          sourceSystem,
          input
        });
      });
      rowResults.push(result);
    } catch (error) {
      rowResults.push({
        row_number: rowNumber,
        status: 'failed',
        error: error.message || 'D365 inventory row failed',
        site_id: site?.id || null,
        site_name: site?.name || null,
        ingredient_id: ingredient?.id || null,
        ingredient_name: ingredient?.name || null,
        item_id: normalized?.item_id || null,
        warehouse_id: normalized?.warehouse_id || null,
        idempotency_key: normalized?.idempotency_key || null,
        input: sanitizeInboundInput(input)
      });
    }
  }

  return finishInboundLog(log, rowResults, dependencies);
}

export async function previewD365InventoryImport(payload = {}, dependencyOverrides = {}) {
  const dependencies = dependenciesWith(dependencyOverrides);
  const records = (Array.isArray(payload.records) ? payload.records : [])
    .map((record) => inventoryRowWithDefaults(record, payload));
  const sourceSystem = normalizeText(payload.source_system || 'd365').toLowerCase();
  const semantics = normalizeD365QuantitySemantics(payload.quantity_semantics);
  if (!records.length) throw errorWithStatus('At least one D365 inventory row is required');

  const [ingredients, sites] = await Promise.all([
    dependencies.listDocuments('Ingredient', { limit: 10000 }),
    dependencies.listDocuments('Site', { limit: 10000 })
  ]);
  assertNoDuplicateSnapshotTargets({
    records,
    ingredients,
    sites,
    payload,
    sourceSystem,
    syncId: payload.sync_id,
    semantics
  });
  const rows = [];
  for (let index = 0; index < records.length; index += 1) {
    const input = records[index] || {};
    try {
      const normalized = normalizeD365InventoryRow(input, {
        quantitySemantics: semantics,
        receivedAt: payload.received_at || new Date(),
        moduleKey: 'inventory_sync_api',
        sourceSystem,
        syncId: payload.sync_id
      });
      assertRequestedWarehouse(normalized, payload);
      const site = resolveD365Store(sites, normalized.warehouse_id);
      if (!site) throw errorWithStatus(`D365 warehouse ${normalized.warehouse_id} is not mapped to a Store`, 409);
      assertSiteInScope(site, payload.scope);
      const ingredient = resolveD365Ingredient(ingredients, normalized.item_id);
      if (!ingredient) throw errorWithStatus(`D365 item ${normalized.item_id} is not mapped to an Ingredient`, 409);
      const canonicalUnit = ingredient.unit || normalized.unit;
      const canonicalQuantity = convertD365Quantity(
        normalized.quantity,
        normalized.unit,
        canonicalUnit,
        ingredient
      );
      const inventory = await findInventory(site.id, ingredient.id, dependencies, null);
      const beforeQuantity = inventoryQuantity(inventory);
      const deltaQuantity = semantics === D365_QUANTITY_SEMANTICS.SNAPSHOT
        ? canonicalQuantity - beforeQuantity
        : canonicalQuantity;
      const canonicalUnitCost = deltaQuantity > 0
        ? resolveCanonicalUnitCost({
          normalized,
          ingredient,
          inventory,
          canonicalQuantity
        })
        : (normalized.unit_cost === null
          ? null
          : convertD365UnitCost(normalized.unit_cost, normalized.quantity, canonicalQuantity));
      rows.push({
        row_number: index + 1,
        status: 'ready',
        site_id: site.id,
        site_name: site.name,
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name,
        item_id: normalized.item_id,
        warehouse_id: normalized.warehouse_id,
        quantity_semantics: semantics,
        before_quantity: Number(beforeQuantity.toFixed(4)),
        incoming_quantity: Number(canonicalQuantity.toFixed(4)),
        adjustment_quantity: Number(deltaQuantity.toFixed(4)),
        projected_quantity: Number((beforeQuantity + deltaQuantity).toFixed(4)),
        unit: canonicalUnit,
        unit_cost: canonicalUnitCost,
        batch_number: normalized.batch_number,
        stock_date: normalized.stock_date,
        expiry_date: normalized.expiry_date,
        idempotency_key: normalized.idempotency_key,
        input: sanitizeInboundInput(input)
      });
    } catch (error) {
      rows.push({
        row_number: index + 1,
        status: 'failed',
        error: error.message || 'D365 inventory row failed validation',
        input: sanitizeInboundInput(input)
      });
    }
  }

  const summary = {
    total_rows: rows.length,
    ready_rows: rows.filter((row) => row.status === 'ready').length,
    failed_rows: rows.filter((row) => row.status === 'failed').length
  };
  return { dry_run: true, quantity_semantics: semantics, summary, rows };
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  )));
}

function ingredientRowKey(row, sourceSystem, syncId) {
  const content = sanitizeD365Row(row);
  const hasExplicitIdentity = Boolean(row.external_event_id && row.external_line_id);
  const explicitVersion = normalizeText(row.external_version);
  const identity = hasExplicitIdentity && explicitVersion
    ? {
      external_event_id: row.external_event_id,
      external_line_id: row.external_line_id,
      external_version: explicitVersion
    }
    : {
      sync_id: syncId,
      ...(hasExplicitIdentity ? {
        external_event_id: row.external_event_id,
        external_line_id: row.external_line_id
      } : { item_id: row.item_id }),
      content
    };
  return stableD365Hash({
    source_system: sourceSystem,
    module_key: 'ingredient_master_api',
    identity
  });
}

export async function importD365Ingredients(payload = {}, dependencyOverrides = {}) {
  const dependencies = dependenciesWith(dependencyOverrides);
  const records = Array.isArray(payload.records) ? payload.records : [];
  const sourceSystem = normalizeText(payload.source_system || 'd365').toLowerCase();
  const syncId = normalizeText(payload.sync_id);
  if (!syncId) throw errorWithStatus('sync_id is required for D365 ingredient imports');
  if (!records.length) throw errorWithStatus('At least one D365 ingredient row is required');

  const moduleKey = 'ingredient_master_api';
  const log = await createInboundLog({
    operation: 'ingredient_import',
    moduleKey,
    sourceSystem,
    syncId,
    semantics: null,
    records,
    user: payload.user,
    retryOfLogId: payload.retry_of_log_id,
    configId: payload.config_id
  }, dependencies);
  const ingredients = await dependencies.listDocuments('Ingredient', { limit: 10000 });
  const rowResults = [];

  for (let index = 0; index < records.length; index += 1) {
    const input = records[index] || {};
    const rowNumber = index + 1;
    try {
      const normalized = normalizeD365IngredientRow(input);
      const key = ingredientRowKey(normalized, sourceSystem, syncId);
      const current = resolveD365Ingredient(ingredients, normalized.item_id);
      if (!current && (!normalized.item_name || !normalized.unit)) {
        throw errorWithStatus(`New D365 item ${normalized.item_id} requires item_name and unit`);
      }

      const result = await dependencies.withTransaction(async (client) => {
        const claim = await claimRowIdempotency({
          key,
          moduleKey,
          sourceSystem,
          syncId,
          site: null,
          ingredient: current,
          input: normalized,
          logId: log.id
        }, dependencies, client);
        if (!claim.claimed) {
          return {
            row_number: rowNumber,
            status: 'skipped_duplicate',
            ingredient_id: current?.id || claim.record?.ingredient_id || null,
            ingredient_name: current?.name || normalized.item_name,
            item_id: normalized.item_id,
            idempotency_key: key,
            input: sanitizeInboundInput(input)
          };
        }

        const fields = compactObject({
          d365_item_id: normalized.item_id,
          item_code: current ? normalized.item_code : (normalized.item_code || normalized.item_id),
          sku: normalized.sku,
          name: normalized.item_name,
          unit: normalized.unit,
          category: normalized.category,
          supplier_item_name: normalized.supplier_item_name,
          cost_per_unit: normalized.cost_per_unit,
          is_active: current ? normalized.is_active : (normalized.is_active ?? true),
          d365_last_sync_id: syncId,
          d365_last_synced_at: nowIso(),
          source_name: 'D365'
        });
        const saved = current
          ? await dependencies.updateDocument('Ingredient', current.id, fields, client)
          : await dependencies.createDocument('Ingredient', fields, client);
        await dependencies.updateDocument('D365Master', claim.record.id, {
          ingredient_id: saved.id,
          ingredient_name: saved.name
        }, client);
        return {
          row_number: rowNumber,
          status: 'applied',
          action: current ? 'updated' : 'created',
          ingredient_id: saved.id,
          ingredient_name: saved.name,
          item_id: normalized.item_id,
          idempotency_key: key,
          input: sanitizeInboundInput(input)
        };
      });
      const savedIngredient = result.status === 'applied'
        ? await dependencies.findDocument('Ingredient', result.ingredient_id)
        : null;
      if (savedIngredient) {
        const existingIndex = ingredients.findIndex((ingredient) => ingredient.id === savedIngredient.id);
        if (existingIndex >= 0) ingredients[existingIndex] = savedIngredient;
        else ingredients.push(savedIngredient);
      }
      rowResults.push(result);
    } catch (error) {
      rowResults.push({
        row_number: rowNumber,
        status: 'failed',
        error: error.message || 'D365 ingredient row failed',
        input: sanitizeInboundInput(input)
      });
    }
  }

  return finishInboundLog(log, rowResults, dependencies);
}

export async function retryD365ImportLog(existingLog, user, options = {}, dependencyOverrides = {}) {
  if (!existingLog || String(existingLog.direction || '').toLowerCase() !== 'inbound') {
    throw errorWithStatus('The selected log is not an inbound D365 import', 409);
  }
  const requestPayload = existingLog.request_payload || {};
  const records = Array.isArray(requestPayload.records) ? requestPayload.records : [];
  const common = {
    user,
    records,
    sync_id: requestPayload.sync_id || existingLog.sync_id,
    source_system: requestPayload.source_system || existingLog.source_system || 'd365',
    config_id: existingLog.config_id || null,
    received_at: requestPayload.received_at || existingLog.attempted_at || null,
    retry_of_log_id: existingLog.id,
    scope: options.scope || null
  };

  if (existingLog.operation === 'inventory_import' || existingLog.module_key === 'inventory_sync_api') {
    return importD365Inventory({
      ...common,
      quantity_semantics: requestPayload.quantity_semantics || D365_QUANTITY_SEMANTICS.RECEIPT
    }, dependencyOverrides);
  }
  if (existingLog.operation === 'ingredient_import' || existingLog.module_key === 'ingredient_master_api') {
    return importD365Ingredients(common, dependencyOverrides);
  }
  throw errorWithStatus('Unsupported inbound D365 import operation', 400);
}

function sanitizeLogHeader(log = {}) {
  const requestPayload = { ...(log.request_payload || {}) };
  const responsePayload = { ...(log.response_payload || {}) };
  delete requestPayload.records;
  delete responsePayload.rows;
  return {
    ...log,
    request_payload: requestPayload,
    response_payload: responsePayload
  };
}

export async function getD365ImportLogDetails(logId, options = {}, dependencyOverrides = {}) {
  const dependencies = dependenciesWith(dependencyOverrides);
  const log = await dependencies.findDocument('ERPIntegrationLog', logId);
  if (!log) throw errorWithStatus('Integration log not found', 404);
  if (String(log.direction || '').toLowerCase() !== 'inbound') {
    throw errorWithStatus('The selected log does not contain inbound D365 row details', 409);
  }

  const unrestricted = options.scope?.unrestricted === true;
  const accessibleSiteIds = new Set([
    ...(options.scope?.accessibleSiteIds || []),
    ...(options.scope?.accessible_site_ids || [])
  ].filter(Boolean).map(String));
  const rawRows = Array.isArray(log.response_payload?.rows) ? log.response_payload.rows : [];
  const accessibleRows = unrestricted
    ? rawRows
    : rawRows.filter((row) => row.site_id && accessibleSiteIds.has(String(row.site_id)));
  if (!unrestricted && accessibleRows.length === 0) {
    throw errorWithStatus('Integration log not found in your accessible location scope', 404);
  }
  let rows = accessibleRows;
  if (options.status) rows = rows.filter((row) => row.status === options.status);

  const page = Math.max(1, Math.trunc(Number(options.page) || 1));
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(options.limit) || 50)));
  const offset = (page - 1) * limit;
  const totalCount = rows.length;
  const scopedLog = sanitizeLogHeader(log);
  if (!unrestricted) {
    const scopedSummary = summarizeRows(accessibleRows);
    const scopedSiteIds = [...new Set(accessibleRows.map((row) => row.site_id).filter(Boolean))];
    scopedLog.records_count = scopedSummary.total_rows;
    scopedLog.applied_count = scopedSummary.applied_rows;
    scopedLog.skipped_count = scopedSummary.skipped_rows;
    scopedLog.failed_count = scopedSummary.failed_rows;
    scopedLog.site_id = scopedSiteIds.length === 1 ? scopedSiteIds[0] : null;
    scopedLog.site_ids = scopedSiteIds;
    scopedLog.response_payload.summary = scopedSummary;
  }
  return {
    log: scopedLog,
    rows: rows.slice(offset, offset + limit),
    total_count: totalCount,
    page,
    limit,
    total_pages: Math.ceil(totalCount / limit),
    has_more: offset + limit < totalCount
  };
}

export { sanitizeInboundInput };
