const UNIT_ALIASES = Object.freeze({
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  kgs: 'kg',
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  ltr: 'l',
  lt: 'l',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  ct: 'pieces',
  cnt: 'pieces',
  count: 'pieces',
  counts: 'pieces',
  cr: 'pieces',
  crate: 'pieces',
  carton: 'pieces',
  piece: 'pieces',
  pieces: 'pieces',
  oz: 'oz',
  z: 'oz'
});

export const PACKAGING_UNIT_LABELS = Object.freeze({
  bdl: 'Bundle',
  ea: 'Each',
  pak: 'Packet',
  pkt: 'Packet',
  pack: 'Packet',
  packet: 'Packet',
  cs: 'Case',
  case: 'Case'
});

export const PACKAGE_UNITS = new Set(Object.keys(PACKAGING_UNIT_LABELS));

const WEIGHT_TO_KG = Object.freeze({ kg: 1, g: 0.001 });
const VOLUME_TO_L = Object.freeze({ l: 1, ml: 0.001 });
const COUNT_TO_PIECES = Object.freeze({ pieces: 1 });
const OUNCE_TO_KG = 0.028349523125;
const DEFAULT_BUNDLE_WEIGHT_KG = 0.08;

function number(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePackageMeasureUnit(unit) {
  return UNIT_ALIASES[String(unit || '').trim().toLowerCase().replace(/\./g, '')] || '';
}

function normalizePackagingUnit(unit) {
  return String(unit || '').trim().toLowerCase().replace(/\./g, '');
}

function round(value) {
  return Number(Number(value).toFixed(8));
}

function inferImplicitPackageMeasureUnit(text, size) {
  if (/\b(EGG|EGGS|PIECE|PIECES|PCS|PC|CT|CNT|COUNT|COUNTS|CRATE|CARTON)\b/.test(text)) {
    return 'pieces';
  }
  if (size <= 5 && /\b(WATER|OIL|MILK|JUICE|SAUCE|CREAM|VINEGAR|LTR|LITER|LITRE|LT)\b/.test(text)) {
    return 'l';
  }
  return 'g';
}

export function normalizeInventoryUnitLabel(unit) {
  const normalized = normalizePackagingUnit(unit);
  return PACKAGING_UNIT_LABELS[normalized] || String(unit || '').trim();
}

export function parsePackageDescriptor(name = '') {
  const text = String(name || '').toUpperCase();
  const numericPattern = String.raw`\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?`;
  const measurePattern = String.raw`KG|KGS|G|GM|GMS|GRAMS|LTR|L|LT|LITRE|LITER|ML|CT|CNT|COUNT|COUNTS|OZ|Z`;
  const matches = [...text.matchAll(new RegExp(String.raw`\b(${numericPattern})\s*\/\s*(?=(?:${numericPattern}\s*\/\s*)*${numericPattern}\s*(${measurePattern})\b)`, 'g'))];
  const tailWithUnit = text.match(new RegExp(String.raw`((?:${numericPattern}\s*\/\s*)+)(${numericPattern})\s*(${measurePattern})\b`));
  const tailWithoutUnit = tailWithUnit
    ? null
    : text.match(new RegExp(String.raw`((?:${numericPattern}\s*\/\s*)+)(${numericPattern})(?!\s*\/)(?=\s|$|\)|\])`));
  const tail = tailWithUnit || tailWithoutUnit;
  if (!tail) return null;

  const counts = tail[1]
    .split('/')
    .map((part) => Number(String(part).trim().split(/\s*-\s*/)[0]))
    .filter((value) => Number.isFinite(value) && value > 0);
  const size = Number(String(tail[2]).trim().split(/\s*-\s*/)[0]);
  const unit = normalizePackageMeasureUnit(tail[3] || inferImplicitPackageMeasureUnit(text, size));
  if (!Number.isFinite(size) || size <= 0 || !unit) return null;

  return {
    count_levels: counts,
    pack_count: counts[0] || 1,
    inner_count: counts[1] || 1,
    unit_size_quantity: size,
    unit_size_unit: unit,
    level_count: matches.length || counts.length
  };
}

export function packageBaseQuantityForUnit(ingredient = {}, unitOverride = '') {
  const baseUnit = normalizePackagingUnit(unitOverride || ingredient?.unit);
  if (!PACKAGE_UNITS.has(baseUnit)) return null;

  const explicitQuantity = number(ingredient?.package_base_quantity);
  const explicitUnit = normalizePackageMeasureUnit(ingredient?.package_base_unit);
  if (explicitQuantity > 0 && explicitUnit) {
    return {
      quantity: explicitQuantity,
      unit: explicitUnit,
      source: 'explicit_package_base'
    };
  }

  const descriptor = parsePackageDescriptor(
    ingredient?.supplier_item_name
      || ingredient?.ingredient_name
      || ingredient?.name
      || ingredient?.item_name
      || ''
  );
  if (!descriptor) {
    if (baseUnit === 'bdl') {
      return {
        quantity: DEFAULT_BUNDLE_WEIGHT_KG,
        unit: 'kg',
        source: 'default_bundle_weight'
      };
    }
    return null;
  }

  let multiplier = 1;
  if (baseUnit === 'cs' || baseUnit === 'case') {
    multiplier = descriptor.count_levels.reduce((total, value) => total * value, 1);
  } else if (baseUnit === 'pak' || baseUnit === 'pkt' || baseUnit === 'pack' || baseUnit === 'packet') {
    multiplier = descriptor.count_levels.length > 1
      ? descriptor.count_levels.slice(1).reduce((total, value) => total * value, 1)
      : 1;
  } else {
    multiplier = 1;
  }

  return {
    quantity: round(descriptor.unit_size_quantity * multiplier),
    unit: descriptor.unit_size_unit,
    source: 'item_name_package'
  };
}

export function packageMeasureToCanonical(quantity, unit) {
  const numeric = number(quantity, 0);
  const normalized = normalizePackageMeasureUnit(unit);
  if (normalized in WEIGHT_TO_KG) {
    return { quantity: round(numeric * WEIGHT_TO_KG[normalized]), unit: 'kg' };
  }
  if (normalized in VOLUME_TO_L) {
    return { quantity: round(numeric * VOLUME_TO_L[normalized]), unit: 'l' };
  }
  if (normalized in COUNT_TO_PIECES) {
    return { quantity: round(numeric * COUNT_TO_PIECES[normalized]), unit: 'pieces' };
  }
  if (normalized === 'oz') {
    return { quantity: round(numeric * OUNCE_TO_KG), unit: 'kg' };
  }
  return { quantity: numeric, unit: normalized };
}

export function inferPackageFields(source = {}) {
  const descriptor = parsePackageDescriptor(
    source?.supplier_item_name
      || source?.ingredient_name
      || source?.name
      || source?.item_name
      || ''
  );
  const unit = normalizePackagingUnit(source?.unit);
  const base = packageBaseQuantityForUnit({ ...source, unit });
  if (!base) return {};
  const canonical = packageMeasureToCanonical(base.quantity, base.unit);
  return {
    ...(descriptor
      ? {
          package_pack_count: descriptor.pack_count,
          package_inner_count: descriptor.inner_count,
          package_size_quantity: descriptor.unit_size_quantity,
          package_size_unit: descriptor.unit_size_unit
        }
      : {}),
    package_base_quantity: canonical.quantity,
    package_base_unit: canonical.unit,
    package_parse_source: base.source
  };
}
