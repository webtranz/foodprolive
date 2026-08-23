function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function deriveInventoryStatus(quantity, minimum = 0) {
  const normalizedQuantity = toFiniteNumber(quantity, 0);
  const normalizedMinimum = Math.max(0, toFiniteNumber(minimum, 0));

  if (normalizedQuantity <= 0) return 'out_of_stock';
  if (normalizedMinimum > 0 && normalizedQuantity <= normalizedMinimum) return 'low_stock';
  return 'in_stock';
}

export function deriveInventoryRecord(record = {}) {
  return {
    ...record,
    status: deriveInventoryStatus(record.quantity, record.min_stock_level)
  };
}

export function hasLowStockAlert(record = {}) {
  return deriveInventoryStatus(record.quantity, record.min_stock_level) !== 'in_stock';
}
