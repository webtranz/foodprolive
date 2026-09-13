import {
  PACKAGE_UNITS,
  packageBaseQuantityForUnit,
  packageMeasureToCanonical
} from './packageUnits.js';

const UNIT_ALIASES = {
  kilogram: 'kg',
  kilograms: 'kg',
  kgs: 'kg',
  pound: 'lb',
  pounds: 'lb',
  lb: 'lb',
  lbs: 'lb',
  ounce: 'oz',
  ounces: 'oz',
  oz: 'oz',
  'cubic meter': 'm3',
  'cubic meters': 'm3',
  'cubic metre': 'm3',
  'cubic metres': 'm3',
  'cubic mtr': 'm3',
  'cubic mtrs': 'm3',
  gram: 'g',
  grams: 'g',
  gm: 'g',
  gms: 'g',
  cubic_meter: 'm3',
  cubic_meters: 'm3',
  cubic_metre: 'm3',
  cubic_metres: 'm3',
  cubic_mtr: 'm3',
  cubic_mtrs: 'm3',
  cbm: 'm3',
  cum: 'm3',
  m3: 'm3',
  'm^3': 'm3',
  'm³': 'm3',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  ltr: 'l',
  ltrs: 'l',
  lt: 'l',
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

const WEIGHT_IN_GRAMS = { kg: 1000, g: 1, lb: 453.59237, oz: 28.349523125 };
const VOLUME_IN_MILLILITRES = { m3: 1000000, l: 1000, ml: 1 };
const COUNT_IN_PIECES = { pieces: 1, ea: 1 };

function positiveConversionNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

// Describe units without crossing dimensions. Guessed packages are not evidence
// for a new weight conversion, even when older quantity paths accept them.
function establishedUnitMeasure(unit, ingredient) {
  if (unit in WEIGHT_IN_GRAMS) return { dimension: 'mass', quantity: WEIGHT_IN_GRAMS[unit] };
  if (unit in VOLUME_IN_MILLILITRES) return { dimension: 'volume', quantity: VOLUME_IN_MILLILITRES[unit] };
  if (unit in COUNT_IN_PIECES) return { dimension: 'count', quantity: 1 };
  const base = packageBaseQuantityForUnit(ingredient, unit);
  if (!base) return null;
  const source = ingredient.package_parse_source || base.source;
  const name = ingredient.supplier_item_name || ingredient.ingredient_name || ingredient.name || ingredient.item_name || '';
  if (source === 'default_bundle_weight'
    || (source === 'item_name_package' && !/\d\s*(?:KG|KGS|G|GM|GMS|GRAMS|LTR|L|LT|LITRE|LITER|ML|CT|CNT|COUNT|COUNTS|OZ|Z)\b/i.test(name))) return null;
  const canonical = packageMeasureToCanonical(base.quantity, base.unit);
  if (!(canonical.quantity > 0) || !Number.isFinite(canonical.quantity)) return null;
  if (canonical.unit === 'kg') return { dimension: 'mass', quantity: canonical.quantity * 1000 };
  if (canonical.unit === 'l') return { dimension: 'volume', quantity: canonical.quantity * 1000 };
  if (canonical.unit === 'pieces') return { dimension: 'count', quantity: canonical.quantity };
  return null;
}

function sameMeasureConversion(fromUnit, toUnit, ingredient) {
  if (fromUnit === toUnit) return 1;
  const from = establishedUnitMeasure(fromUnit, ingredient);
  const to = establishedUnitMeasure(toUnit, ingredient);
  return from && to && from.dimension === to.dimension ? from.quantity / to.quantity : null;
}

function configuredConversionFactor(fromUnit, toUnit, ingredient) {
  const baseUnit = normalizeIngredientUnit(ingredient.unit);
  const conversionUnit = normalizeIngredientUnit(ingredient.conversion_unit);
  const factor = positiveConversionNumber(ingredient.conversion_factor);
  if (!baseUnit || !conversionUnit || baseUnit === conversionUnit || factor === null) return null;
  if (fromUnit === baseUnit && toUnit === conversionUnit) return factor;
  if (fromUnit === conversionUnit && toUnit === baseUnit) return 1 / factor;

  // Chain scales around the saved relation: e.g. ml -> L -> g -> kg.
  const sourceToBase = sameMeasureConversion(fromUnit, baseUnit, ingredient);
  const conversionToTarget = sameMeasureConversion(conversionUnit, toUnit, ingredient);
  const forward = sourceToBase !== null && conversionToTarget !== null
    ? sourceToBase * factor * conversionToTarget : null;
  if (forward > 0 && Number.isFinite(forward)) return forward;
  const sourceToConversion = sameMeasureConversion(fromUnit, conversionUnit, ingredient);
  const baseToTarget = sameMeasureConversion(baseUnit, toUnit, ingredient);
  const reverse = sourceToConversion !== null && baseToTarget !== null
    ? sourceToConversion / factor * baseToTarget : null;
  return reverse > 0 && Number.isFinite(reverse) ? reverse : null;
}

function densityConversionFactor(fromUnit, toUnit, ingredient) {
  const density = positiveConversionNumber(ingredient.density_g_per_ml ?? ingredient.density_grams_per_ml);
  if (density === null) return null;
  const from = establishedUnitMeasure(fromUnit, ingredient);
  const to = establishedUnitMeasure(toUnit, ingredient);
  if (!from || !to) return null;
  if (from.dimension === 'volume' && to.dimension === 'mass') return from.quantity * density / to.quantity;
  if (from.dimension === 'mass' && to.dimension === 'volume') return from.quantity / density / to.quantity;
  return null;
}

/** Established ingredient-level cross-unit weight; never assumes water density. */
export function ingredientWeightConversion(quantity, unit, ingredient = {}) {
  if (typeof quantity !== 'number' && typeof quantity !== 'string') return null;
  if (typeof quantity === 'string' && !quantity.trim()) return null;
  const numeric = Number(quantity);
  const normalizedUnit = normalizeIngredientUnit(unit || ingredient.unit);
  if (!Number.isFinite(numeric) || numeric < 0 || !normalizedUnit) return null;
  // Physical weight units already have an exact conversion in weight calculators.
  if (normalizedUnit in WEIGHT_IN_GRAMS) return null;
  const configured = configuredConversionFactor(normalizedUnit, 'g', ingredient);
  const density = configured === null ? densityConversionFactor(normalizedUnit, 'g', ingredient) : null;
  const factor = configured ?? density;
  const grams = factor === null ? null : numeric * factor;
  return grams !== null && Number.isFinite(grams)
    ? { grams, source: configured !== null ? 'ingredient_conversion' : 'ingredient_density' }
    : null;
}

function recipeScopedGramsPerUnit(unit, ingredient = {}) {
  const grams = Number(ingredient.recipe_weight_per_unit_grams);
  const definedUnit = normalizeIngredientUnit(ingredient.recipe_weight_unit);
  if (!(grams > 0) || !Number.isFinite(grams) || !definedUnit) return null;
  if (unit === definedUnit) return grams;
  if (unit in WEIGHT_IN_GRAMS) return WEIGHT_IN_GRAMS[unit];
  const scale = sameMeasureConversion(unit, definedUnit, ingredient);
  if (scale !== null) return scale * grams;
  const base = packageBaseQuantityForUnit(ingredient, unit);
  if (base) {
    const canonical = packageMeasureToCanonical(base.quantity, base.unit);
    if (canonical.unit === 'kg') return canonical.quantity * 1000;
    if (canonical.unit === 'pieces' && definedUnit === 'pieces') return canonical.quantity * grams;
  }
  return null;
}

function recipeScopedConversion(fromUnit, toUnit, ingredient) {
  const fromGrams = recipeScopedGramsPerUnit(fromUnit, ingredient);
  const toGrams = recipeScopedGramsPerUnit(toUnit, ingredient);
  return fromGrams > 0 && toGrams > 0 ? fromGrams / toGrams : null;
}

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

  const recipeConversion = recipeScopedConversion(sourceUnit, targetUnit, ingredient);
  if (recipeConversion !== null) return numericQuantity * recipeConversion;
  const baseUnit = normalizeIngredientUnit(ingredient.unit);
  const conversionUnit = normalizeIngredientUnit(ingredient.conversion_unit);
  const conversionFactor = positiveConversionNumber(ingredient.conversion_factor);
  if (conversionFactor !== null && baseUnit && conversionUnit && baseUnit !== conversionUnit) {
    // Retain direct division precision used by existing stock/cost calculations.
    if (sourceUnit === conversionUnit && targetUnit === baseUnit) return numericQuantity / conversionFactor;
    if (sourceUnit === baseUnit && targetUnit === conversionUnit) return numericQuantity * conversionFactor;
  }
  if (sourceUnit in WEIGHT_IN_GRAMS && targetUnit in WEIGHT_IN_GRAMS) {
    return (numericQuantity * WEIGHT_IN_GRAMS[sourceUnit]) / WEIGHT_IN_GRAMS[targetUnit];
  }

  if (sourceUnit in VOLUME_IN_MILLILITRES && targetUnit in VOLUME_IN_MILLILITRES) {
    return (numericQuantity * VOLUME_IN_MILLILITRES[sourceUnit]) / VOLUME_IN_MILLILITRES[targetUnit];
  }

  if (sourceUnit in COUNT_IN_PIECES && targetUnit in COUNT_IN_PIECES) {
    return (numericQuantity * COUNT_IN_PIECES[sourceUnit]) / COUNT_IN_PIECES[targetUnit];
  }

  const configuredConversion = configuredConversionFactor(sourceUnit, targetUnit, ingredient);
  if (configuredConversion !== null) return numericQuantity * configuredConversion;
  const densityConversion = densityConversionFactor(sourceUnit, targetUnit, ingredient);
  if (densityConversion !== null) return numericQuantity * densityConversion;

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
  if (recipeScopedConversion(source, target, ingredient) !== null) return true;
  if (configuredConversionFactor(source, target, ingredient) !== null) return true;
  if (densityConversionFactor(source, target, ingredient) !== null) return true;
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
