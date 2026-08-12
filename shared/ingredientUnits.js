const UNIT_ALIASES = {
  kilogram: 'kg',
  kilograms: 'kg',
  kgs: 'kg',
  gram: 'g',
  grams: 'g',
  gm: 'g',
  gms: 'g',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  millilitre: 'ml',
  millilitres: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  pc: 'pieces',
  pcs: 'pieces',
  piece: 'pieces'
};

const WEIGHT_IN_GRAMS = { kg: 1000, g: 1 };
const VOLUME_IN_MILLILITRES = { l: 1000, ml: 1 };

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeIngredientUnit(unit) {
  const normalized = String(unit || '').trim().toLowerCase();
  return UNIT_ALIASES[normalized] || normalized;
}

/**
 * Convert a quantity between ingredient units.
 *
 * Ingredient conversion_factor is the number of conversion units contained in
 * one base unit. Example: base unit kg, conversion unit g, factor 1000.
 */
export function convertIngredientQuantity(quantity, fromUnit, toUnit, ingredient = {}) {
  const numericQuantity = finiteNumber(quantity, 0);
  const sourceUnit = normalizeIngredientUnit(fromUnit);
  const targetUnit = normalizeIngredientUnit(toUnit);

  if (!sourceUnit || !targetUnit || sourceUnit === targetUnit) {
    return numericQuantity;
  }

  const baseUnit = normalizeIngredientUnit(ingredient?.unit);
  const conversionUnit = normalizeIngredientUnit(ingredient?.conversion_unit);
  const conversionFactor = finiteNumber(ingredient?.conversion_factor, 0);

  if (conversionFactor > 0 && baseUnit && conversionUnit) {
    if (sourceUnit === conversionUnit && targetUnit === baseUnit) {
      return numericQuantity / conversionFactor;
    }
    if (sourceUnit === baseUnit && targetUnit === conversionUnit) {
      return numericQuantity * conversionFactor;
    }
  }

  if (sourceUnit in WEIGHT_IN_GRAMS && targetUnit in WEIGHT_IN_GRAMS) {
    return (numericQuantity * WEIGHT_IN_GRAMS[sourceUnit]) / WEIGHT_IN_GRAMS[targetUnit];
  }

  if (sourceUnit in VOLUME_IN_MILLILITRES && targetUnit in VOLUME_IN_MILLILITRES) {
    return (numericQuantity * VOLUME_IN_MILLILITRES[sourceUnit]) / VOLUME_IN_MILLILITRES[targetUnit];
  }

  // Preserve legacy behavior for unrelated or unknown units.
  return numericQuantity;
}

export function quantityInIngredientBaseUnit(quantity, quantityUnit, ingredient = {}) {
  const baseUnit = ingredient?.unit || quantityUnit;
  return convertIngredientQuantity(quantity, quantityUnit || baseUnit, baseUnit, ingredient);
}

export function calculateIngredientCost(quantity, quantityUnit, ingredient = {}, unitCost) {
  const costPerBaseUnit = finiteNumber(unitCost ?? ingredient?.cost_per_unit, 0);
  return quantityInIngredientBaseUnit(quantity, quantityUnit, ingredient) * costPerBaseUnit;
}

export function calculateProductionIngredientCost(line = {}, ingredient = {}) {
  const quantity = line.actual_quantity ?? line.planned_quantity ?? line.adjusted_quantity ?? line.required_quantity ?? 0;
  return calculateIngredientCost(
    quantity,
    line.unit || ingredient?.unit,
    ingredient,
    line.unit_cost ?? ingredient?.cost_per_unit
  );
}
