import { normalizeIngredientUnit } from './ingredientUnits.js';

const UNIT_PRECISION = Object.freeze({
  kg: 3,
  g: 2,
  lb: 4,
  oz: 4,
  m3: 6,
  l: 4,
  ml: 2,
  pieces: 3,
  ea: 6,
  bdl: 6,
  pak: 6,
  cs: 6,
  batch: 3,
  servings: 0
});

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const DECIMAL_DRAFT_PATTERN = /^\d+(?:\.\d*)?$/;

function finiteNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function getRecipeQuantityPrecision(unit, fallback = 3) {
  const normalizedUnit = normalizeIngredientUnit(unit);
  return Object.prototype.hasOwnProperty.call(UNIT_PRECISION, normalizedUnit)
    ? UNIT_PRECISION[normalizedUnit]
    : fallback;
}

export function roundStandardDecimal(value, precision = 3) {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  const factor = 10 ** Math.max(0, precision);
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
}

function decimalText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value ?? '').trim();
}

function normalizeWholeNumber(text) {
  const normalized = text.replace(/^0+(?=\d)/, '');
  return normalized || '0';
}

function finalDisplay(numeric, precision) {
  return new Intl.NumberFormat('en-US', {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: precision
  }).format(numeric);
}

/**
 * Parse a decimal input without ever relying on parseFloat's partial-string
 * behavior. Input mode preserves a trailing decimal point while the user is
 * typing; final mode returns the canonical persisted/display form.
 */
export function parseStandardDecimal(value, options = {}) {
  const {
    unit = '',
    precision = getRecipeQuantityPrecision(unit),
    min = 0,
    max = null,
    allowEmpty = false,
    allowZero = true,
    mode = 'final',
    label = 'Quantity'
  } = options;
  const original = decimalText(value);

  if (!original) {
    return allowEmpty
      ? { valid: true, value: null, display: '', normalized: false, error: '' }
      : { valid: false, value: null, display: '', normalized: false, error: `${label} is required.` };
  }

  const pattern = mode === 'input' ? DECIMAL_DRAFT_PATTERN : DECIMAL_PATTERN;
  if (!pattern.test(original)) {
    return {
      valid: false,
      value: null,
      display: original,
      normalized: false,
      error: `${label} must be a non-negative decimal number.`
    };
  }

  const [rawWhole, rawFraction = ''] = original.split('.');
  if (rawFraction.length > precision) {
    return {
      valid: false,
      value: null,
      display: original,
      normalized: false,
      error: `${label} supports up to ${precision} decimal place${precision === 1 ? '' : 's'} for this unit.`
    };
  }

  const numeric = finiteNumber(original);
  if (numeric === null || numeric < min || (!allowZero && numeric === 0) || (max !== null && numeric > max)) {
    const qualifier = allowZero ? `at least ${min}` : `greater than ${min}`;
    return {
      valid: false,
      value: null,
      display: original,
      normalized: false,
      error: `${label} must be ${qualifier}.`
    };
  }

  const whole = normalizeWholeNumber(rawWhole);
  const preserveTrailingDecimal = mode === 'input' && original.endsWith('.') && precision > 0;
  const display = preserveTrailingDecimal
    ? `${whole}.`
    : mode === 'input' && rawFraction
      ? `${whole}.${rawFraction}`
      : finalDisplay(numeric, precision);

  return {
    valid: true,
    value: roundStandardDecimal(numeric, precision),
    display,
    normalized: original !== display,
    error: ''
  };
}

export function standardizeDecimalValue(value, options = {}) {
  return parseStandardDecimal(value, { ...options, mode: 'final' });
}

export function formatRecipeQuantity(value, unit = '', options = {}) {
  const precision = options.precision ?? getRecipeQuantityPrecision(unit);
  const parsed = standardizeDecimalValue(value, {
    unit,
    precision,
    min: Number.NEGATIVE_INFINITY,
    allowZero: true,
    allowEmpty: true
  });
  if (!parsed.valid || parsed.value === null) return options.fallback ?? '—';
  return new Intl.NumberFormat(options.locale || 'en-US', {
    useGrouping: options.useGrouping !== false,
    minimumFractionDigits: 0,
    maximumFractionDigits: precision
  }).format(parsed.value);
}

function normalizeField(value, options, errors) {
  const parsed = standardizeDecimalValue(value, options);
  if (!parsed.valid) errors.push(parsed.error);
  return parsed.valid ? parsed.value : value;
}

/** Normalize and validate every persisted recipe numeric field. */
export function normalizeRecipeNumericFields(recipe = {}) {
  const errors = [];
  const normalized = { ...recipe };

  normalized.servings = normalizeField(recipe.servings ?? 1, {
    unit: 'servings',
    precision: 0,
    min: 0,
    allowZero: false,
    label: 'Servings'
  }, errors);

  if (recipe.portion_size_grams !== undefined && recipe.portion_size_grams !== null && recipe.portion_size_grams !== '') {
    normalized.portion_size_grams = normalizeField(recipe.portion_size_grams, {
      unit: 'g', min: 0, allowZero: false, label: 'Portion size'
    }, errors);
  }
  if (recipe.batch_yield !== undefined && recipe.batch_yield !== null && recipe.batch_yield !== '') {
    normalized.batch_yield = normalizeField(recipe.batch_yield, {
      unit: 'batch', min: 0, allowZero: false, label: 'Batch yield'
    }, errors);
  }
  if (recipe.target_selling_price !== undefined && recipe.target_selling_price !== null && recipe.target_selling_price !== '') {
    normalized.target_selling_price = normalizeField(recipe.target_selling_price, {
      precision: 2, min: 0, allowZero: true, label: 'Target selling price'
    }, errors);
  }

  normalized.ingredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map((line, index) => ({
    ...line,
    quantity: normalizeField(line?.quantity, {
      unit: line?.unit,
      min: 0,
      allowZero: false,
      label: `Ingredient ${line?.ingredient_name || index + 1} quantity`
    }, errors)
  }));

  normalized.sub_recipes = (Array.isArray(recipe.sub_recipes) ? recipe.sub_recipes : []).map((line, index) => ({
    ...line,
    quantity: normalizeField(line?.quantity, {
      unit: line?.unit || 'batch',
      min: 0,
      allowZero: false,
      label: `Sub-recipe ${line?.recipe_name || index + 1} quantity`
    }, errors)
  }));

  return { recipe: normalized, errors: [...new Set(errors)] };
}

const QUANTITY_FIELD_PATTERN = /(^|_)(quantity|servings?|portions?|weight|yield)$/i;

/** Convert legacy numeric strings to canonical numbers before export. */
export function normalizeQuantityFieldsForExport(value, key = '', parentUnit = '') {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeQuantityFieldsForExport(item, key, parentUnit));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const unit = value.unit || value.base_unit || parentUnit;
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      normalizeQuantityFieldsForExport(childValue, childKey, unit)
    ]));
  }
  if (QUANTITY_FIELD_PATTERN.test(key)) {
    const parsed = standardizeDecimalValue(value, {
      unit: /servings?|portions?/i.test(key) ? 'servings' : parentUnit,
      allowEmpty: true,
      min: Number.NEGATIVE_INFINITY,
      allowZero: true
    });
    return parsed.valid && parsed.value !== null ? parsed.value : value;
  }
  return value;
}
