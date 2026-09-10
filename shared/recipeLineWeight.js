import {
  convertIngredientQuantity,
  isIngredientUnitCompatible,
  normalizeIngredientUnit
} from './ingredientUnits.js';

export const RECIPE_LINE_WEIGHT_FIELDS = Object.freeze([
  'weight_per_unit_grams', 'weight_unit', 'weight_ingredient_id',
  'weight_defined_by', 'weight_defined_at'
]);

export const RECIPE_LINE_PROCESSING_AID_FIELD = 'exempt_processing_aid';
export const RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD = 'prep_exempt_percent';

export function isExemptProcessingAid(line = {}) {
  const value = line?.[RECIPE_LINE_PROCESSING_AID_FIELD];
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

export function getRecipeLinePrepExemptPercent(line = {}) {
  if (isExemptProcessingAid(line)) return 100;
  const value = line?.[RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD];
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(99.99, numeric);
}

export function recipeLineRetainedFraction(line = {}) {
  const exemptPercent = getRecipeLinePrepExemptPercent(line);
  return Math.max(0, Math.min(1, (100 - exemptPercent) / 100));
}

export function recipeLineProcessingAidField(line = {}) {
  if (isExemptProcessingAid(line)) return { [RECIPE_LINE_PROCESSING_AID_FIELD]: true };
  const exemptPercent = getRecipeLinePrepExemptPercent(line);
  return exemptPercent > 0 ? { [RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD]: exemptPercent } : {};
}

export function clearRecipeLineWeight(line = {}) {
  return Object.fromEntries(Object.entries(line).filter(([key]) => !RECIPE_LINE_WEIGHT_FIELDS.includes(key)));
}

export function getRecipeLineWeight(line = {}) {
  const value = Number(line.weight_per_unit_grams);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!line.weight_unit || normalizeIngredientUnit(line.weight_unit) !== normalizeIngredientUnit(line.unit)) return null;
  if (!line.weight_ingredient_id || String(line.weight_ingredient_id) !== String(line.ingredient_id)) return null;
  return value;
}

// A recipe-specific conversion never mutates the shared ingredient master.
export function ingredientForRecipeLine(line = {}, ingredient = {}) {
  const grams = getRecipeLineWeight(line);
  if (grams === null) return ingredient;
  return {
    ...ingredient,
    recipe_weight_unit: normalizeIngredientUnit(line.unit),
    recipe_weight_per_unit_grams: grams
  };
}

export function recipeLineWeightFields(line = {}) {
  if (getRecipeLineWeight(line) === null) return {};
  return Object.fromEntries(RECIPE_LINE_WEIGHT_FIELDS.filter((key) => line[key] !== undefined).map((key) => [key, line[key]]));
}

export function recipeLineWeightInUnit(line, ingredient, targetUnit) {
  const grams = getRecipeLineWeight(line);
  if (grams === null) return null;
  const effectiveIngredient = ingredientForRecipeLine(line, ingredient);
  if (!isIngredientUnitCompatible(line.unit, targetUnit, effectiveIngredient)) return null;
  const baseQuantity = convertIngredientQuantity(1, line.unit, targetUnit, effectiveIngredient);
  return baseQuantity > 0 ? grams / baseQuantity : null;
}
