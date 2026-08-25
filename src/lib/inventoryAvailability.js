function finiteNumber(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegative(value, fallback = 0) {
  const numeric = finiteNumber(value);
  return numeric === null ? fallback : Math.max(0, numeric);
}

/**
 * Normalizes the stock quantities returned by both the reservation-aware API
 * and older stock-on-hand responses. `on_hand` is physical stock,
 * `reserved` is held for approved productions, and `available` is what can be
 * promised to another request.
 */
export function getInventoryQuantities(record = {}) {
  const explicitOnHand = finiteNumber(
    record.on_hand_quantity
      ?? record.physical_quantity
      ?? record.stock_on_hand_quantity
      ?? record.remaining_quantity
  );
  const explicitReserved = finiteNumber(
    record.reserved_quantity
      ?? record.reservation_quantity
      ?? record.allocated_quantity
  );
  const explicitAvailable = finiteNumber(record.available_quantity);
  const legacyQuantity = nonNegative(record.quantity, 0);
  const reservedQuantity = nonNegative(explicitReserved, 0);
  const onHandQuantity = Math.max(0, explicitOnHand ?? (
    explicitAvailable === null
      ? legacyQuantity
      : explicitAvailable + reservedQuantity
  ));
  const availableQuantity = Math.max(0, explicitAvailable ?? (onHandQuantity - reservedQuantity));

  return {
    on_hand_quantity: onHandQuantity,
    reserved_quantity: Math.min(reservedQuantity, onHandQuantity),
    available_quantity: Math.min(availableQuantity, onHandQuantity)
  };
}

export function getAvailableInventoryQuantity(record = {}) {
  return getInventoryQuantities(record).available_quantity;
}

const INVENTORY_STATE_CONFIG = Object.freeze({
  reserved: Object.freeze({
    label: 'Inventory reserved',
    description: 'Stock is reserved for this approved production and remains on hand until production starts.',
    tone: 'reserved'
  }),
  partially_reserved: Object.freeze({
    label: 'Reservation incomplete',
    description: 'Only part of the required stock is reserved. Resolve shortages before production starts.',
    tone: 'warning'
  }),
  consumed: Object.freeze({
    label: 'Inventory consumed at start',
    description: 'Reserved stock was deducted when production started.',
    tone: 'consumed'
  }),
  partially_consumed: Object.freeze({
    label: 'Consumption incomplete',
    description: 'Only part of the reserved stock was consumed when production started.',
    tone: 'warning'
  }),
  committed: Object.freeze({
    label: 'Inventory consumed at approval (legacy)',
    description: 'This older record deducted physical stock during Area Manager approval under the previous workflow.',
    tone: 'consumed'
  }),
  partially_committed: Object.freeze({
    label: 'Legacy approval consumption incomplete',
    description: 'This older record deducted only part of the required physical stock during Area Manager approval.',
    tone: 'warning'
  }),
  released: Object.freeze({
    label: 'Reservation released',
    description: 'Reserved stock was released back to available inventory.',
    tone: 'released'
  }),
  none: Object.freeze({
    label: 'Not reserved',
    description: 'Inventory has not been reserved for this production.',
    tone: 'none'
  })
});

export function getProductionInventoryState(production = {}) {
  const status = String(
    production.inventory_commitment?.status
      || production.inventory_reservation_status
      || production.inventory_commitment_status
      || 'none'
  ).trim().toLowerCase();
  const normalizedStatus = INVENTORY_STATE_CONFIG[status] ? status : 'none';
  const lines = Array.isArray(production.inventory_commitment?.lines)
    ? production.inventory_commitment.lines
    : Array.isArray(production.inventory_committed_lines)
      ? production.inventory_committed_lines
      : [];

  return {
    status: normalizedStatus,
    ...INVENTORY_STATE_CONFIG[normalizedStatus],
    lines,
    reserved_at: production.inventory_reserved_at || null,
    consumed_at: production.inventory_consumed_at || production.inventory_committed_at || null,
    revision: nonNegative(production.inventory_commitment_revision, 0),
    is_reserved: ['reserved', 'partially_reserved'].includes(normalizedStatus),
    is_consumed: ['consumed', 'partially_consumed', 'committed', 'partially_committed'].includes(normalizedStatus),
    is_legacy_consumption: ['committed', 'partially_committed'].includes(normalizedStatus)
  };
}
