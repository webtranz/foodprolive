import {
  PACKAGE_UNITS,
  packageBaseQuantityForUnit,
  packageMeasureToCanonical
} from './packageUnits.js';

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
  piece: 'pieces',
  ct: 'pieces',
  cnt: 'pieces',
  count: 'pieces',
  counts: 'pieces',
  cr: 'pieces',
  crate: 'pieces',
  carton: 'pieces',
  each: 'ea',
  ea: 'ea',
  packet: 'pak',
  packets: 'pak',
  pack: 'pak',
  packs: 'pak',
  pak: 'pak',
  pkt: 'pak',
  bundle: 'bdl',
  bundles: 'bdl',
  bdl: 'bdl',
  case: 'cs',
  cases: 'cs',
  cs: 'cs'
};

const WEIGHT_IN_GRAMS = { kg: 1000, g: 1 };
const VOLUME_IN_MILLILITRES = { l: 1000, ml: 1 };
const COUNT_IN_PIECES = { pieces: 1 };

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

  const sourcePackage = packageBaseQuantityForUnit(ingredient, sourceUnit);
  const targetPackage = packageBaseQuantityForUnit(ingredient, targetUnit);
  if (sourcePackage && (targetUnit in WEIGHT_IN_GRAMS || targetUnit in VOLUME_IN_MILLILITRES || targetUnit in COUNT_IN_PIECES)) {
    const canonicalPackage = packageMeasureToCanonical(sourcePackage.quantity, sourcePackage.unit);
    if (targetUnit in WEIGHT_IN_GRAMS && canonicalPackage.unit === 'kg') {
      return convertIngredientQuantity(numericQuantity * canonicalPackage.quantity, 'kg', targetUnit);
    }
    if (targetUnit in VOLUME_IN_MILLILITRES && canonicalPackage.unit === 'l') {
      return convertIngredientQuantity(numericQuantity * canonicalPackage.quantity, 'l', targetUnit);
    }
    if (targetUnit in COUNT_IN_PIECES && canonicalPackage.unit === 'pieces') {
      return numericQuantity * canonicalPackage.quantity;
    }
  }

  if (targetPackage && (sourceUnit in WEIGHT_IN_GRAMS || sourceUnit in VOLUME_IN_MILLILITRES || sourceUnit in COUNT_IN_PIECES)) {
    const canonicalPackage = packageMeasureToCanonical(targetPackage.quantity, targetPackage.unit);
    if (sourceUnit in WEIGHT_IN_GRAMS && canonicalPackage.unit === 'kg') {
      const sourceKg = convertIngredientQuantity(numericQuantity, sourceUnit, 'kg');
      return canonicalPackage.quantity > 0 ? sourceKg / canonicalPackage.quantity : numericQuantity;
    }
    if (sourceUnit in VOLUME_IN_MILLILITRES && canonicalPackage.unit === 'l') {
      const sourceLitres = convertIngredientQuantity(numericQuantity, sourceUnit, 'l');
      return canonicalPackage.quantity > 0 ? sourceLitres / canonicalPackage.quantity : numericQuantity;
    }
    if (sourceUnit in COUNT_IN_PIECES && canonicalPackage.unit === 'pieces') {
      return canonicalPackage.quantity > 0 ? numericQuantity / canonicalPackage.quantity : numericQuantity;
    }
  }

  if (sourcePackage && targetPackage) {
    const sourceCanonical = packageMeasureToCanonical(sourcePackage.quantity, sourcePackage.unit);
    const targetCanonical = packageMeasureToCanonical(targetPackage.quantity, targetPackage.unit);
    if (sourceCanonical.unit === targetCanonical.unit && targetCanonical.quantity > 0) {
      return (numericQuantity * sourceCanonical.quantity) / targetCanonical.quantity;
    }
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

export function isIngredientUnitCompatible(sourceUnit, targetUnit, ingredient = {}) {
  const source = normalizeIngredientUnit(sourceUnit);
  const target = normalizeIngredientUnit(targetUnit);
  if (!source || !target || source === target) return true;
  const baseUnit = normalizeIngredientUnit(ingredient?.unit);
  const conversionUnit = normalizeIngredientUnit(ingredient?.conversion_unit);
  const conversionFactor = finiteNumber(ingredient?.conversion_factor, 0);
  if (conversionFactor > 0 && baseUnit && conversionUnit) {
    if (source === conversionUnit && target === baseUnit) return true;
    if (source === baseUnit && target === conversionUnit) return true;
  }
  if (source in WEIGHT_IN_GRAMS && target in WEIGHT_IN_GRAMS) return true;
  if (source in VOLUME_IN_MILLILITRES && target in VOLUME_IN_MILLILITRES) return true;
  if (source in COUNT_IN_PIECES && target in COUNT_IN_PIECES) return true;
  const sourcePackage = PACKAGE_UNITS.has(source) ? packageBaseQuantityForUnit(ingredient, source) : null;
  const targetPackage = PACKAGE_UNITS.has(target) ? packageBaseQuantityForUnit(ingredient, target) : null;

  if (sourcePackage && targetPackage) {
    const sourceCanonical = packageMeasureToCanonical(sourcePackage.quantity, sourcePackage.unit);
    const targetCanonical = packageMeasureToCanonical(targetPackage.quantity, targetPackage.unit);
    return sourceCanonical.unit === targetCanonical.unit;
  }

  if (sourcePackage) {
    const sourceCanonical = packageMeasureToCanonical(sourcePackage.quantity, sourcePackage.unit);
    return (
      (target in WEIGHT_IN_GRAMS && sourceCanonical.unit === 'kg')
      || (target in VOLUME_IN_MILLILITRES && sourceCanonical.unit === 'l')
      || (target in COUNT_IN_PIECES && sourceCanonical.unit === 'pieces')
    );
  }

  if (targetPackage) {
    const targetCanonical = packageMeasureToCanonical(targetPackage.quantity, targetPackage.unit);
    return (
      (source in WEIGHT_IN_GRAMS && targetCanonical.unit === 'kg')
      || (source in VOLUME_IN_MILLILITRES && targetCanonical.unit === 'l')
      || (source in COUNT_IN_PIECES && targetCanonical.unit === 'pieces')
    );
  }

  return false;
}
