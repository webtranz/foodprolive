import { normalizeIngredientUnit } from './ingredientUnits.js';
import { expandRecipeIngredients } from './recipeComposition.js';
import { resolveIngredientYieldMultiplier } from './ingredientYield.js';

const WEIGHT_IN_GRAMS = Object.freeze({ kg: 1000, g: 1 });
const VOLUME_IN_MILLILITRES = Object.freeze({ l: 1000, ml: 1 });

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
function roundWeight(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function quantityInBaseUnit(quantity, fromUnit, ingredient = {}) {
  const sourceUnit = normalizeIngredientUnit(fromUnit || ingredient.unit);
  const baseUnit = normalizeIngredientUnit(ingredient.unit || sourceUnit);
  if (!sourceUnit || !baseUnit) return null;
  if (sourceUnit === baseUnit) return quantity;

  const conversionUnit = normalizeIngredientUnit(ingredient.conversion_unit);
  const conversionFactor = finiteNumber(ingredient.conversion_factor, 0);
  if (conversionUnit && conversionFactor > 0) {
    if (sourceUnit === conversionUnit && baseUnit === normalizeIngredientUnit(ingredient.unit)) {
      return quantity / conversionFactor;
    }
  }

  if (sourceUnit in WEIGHT_IN_GRAMS && baseUnit in WEIGHT_IN_GRAMS) {
    return (quantity * WEIGHT_IN_GRAMS[sourceUnit]) / WEIGHT_IN_GRAMS[baseUnit];
  }

  if (sourceUnit in VOLUME_IN_MILLILITRES && baseUnit in VOLUME_IN_MILLILITRES) {
    return (quantity * VOLUME_IN_MILLILITRES[sourceUnit]) / VOLUME_IN_MILLILITRES[baseUnit];
  }

  return null;
}

function calculateIngredientLineWeight(line = {}, ingredient = {}) {
  const quantity = finiteNumber(line.quantity, 0);
  if (quantity < 0) return null;

  const lineUnit = normalizeIngredientUnit(line.unit || ingredient.unit);
  const baseQuantity = quantityInBaseUnit(quantity, lineUnit, ingredient);
  const rawWeightPerUnit = finiteNumber(ingredient.raw_weight_per_unit);
  const cookedWeightPerUnit = finiteNumber(ingredient.cooked_weight_per_unit);

  if (baseQuantity !== null && rawWeightPerUnit > 0) {
    const rawGrams = baseQuantity * rawWeightPerUnit;
    const cookedGrams = cookedWeightPerUnit !== null && cookedWeightPerUnit >= 0
      ? baseQuantity * cookedWeightPerUnit
      : rawGrams * resolveIngredientYieldMultiplier(ingredient);
    return { rawGrams, cookedGrams };
  }

  if (baseQuantity !== null && cookedWeightPerUnit !== null && cookedWeightPerUnit >= 0) {
    return { rawGrams: null, cookedGrams: baseQuantity * cookedWeightPerUnit };
  }

  let rawGrams = null;
  if (lineUnit in WEIGHT_IN_GRAMS) {
    rawGrams = quantity * WEIGHT_IN_GRAMS[lineUnit];
  } else if (lineUnit in VOLUME_IN_MILLILITRES) {
    const density = finiteNumber(
      ingredient.density_g_per_ml ?? ingredient.density_grams_per_ml,
      1
    );
    rawGrams = quantity * VOLUME_IN_MILLILITRES[lineUnit] * Math.max(0, density);
  }

  if (rawGrams === null) return null;
  return {
    rawGrams,
    cookedGrams: rawGrams * resolveIngredientYieldMultiplier(ingredient)
  };
}

export function calculateRecipeServingWeight(recipe, recipes = [], ingredients = []) {
  const ingredientMap = new Map(
    ingredients.map((ingredient) => [String(ingredient?.id || ''), ingredient])
  );
  const expansion = expandRecipeIngredients(recipe, recipes, ingredients, { aggregate: false });
  const missing = [];
  let rawTotal = 0;
  let cookedTotal = 0;
  let calculatedLines = 0;
  let rawCalculatedLines = 0;

  expansion.ingredients.forEach((line) => {
    const ingredient = ingredientMap.get(String(line.ingredient_id || ''));
    if (!ingredient) {
      missing.push(line.ingredient_name || line.ingredient_id || 'Unknown ingredient');
      return;
    }

    const weight = calculateIngredientLineWeight(line, ingredient);
    if (!weight) {
      missing.push(`${ingredient.name || line.ingredient_name || line.ingredient_id} (${line.unit || ingredient.unit || 'unknown unit'})`);
      return;
    }

    if (Number.isFinite(weight.rawGrams)) {
      rawTotal += weight.rawGrams;
      rawCalculatedLines += 1;
    }
    cookedTotal += weight.cookedGrams;
    calculatedLines += 1;
  });

  const servings = Math.max(1, finiteNumber(recipe?.servings, 1));
  const warnings = [
    ...(expansion.ingredients.length === 0 ? ['Recipe has no ingredients to weigh.'] : []),
    ...expansion.warnings,
    ...expansion.cycles.map((cycle) => `Circular recipe reference: ${cycle.join(' → ')}`),
    ...missing.map((item) => `Weight unavailable for ${item}.`)
  ];
  const isComplete = expansion.ingredients.length > 0
    && calculatedLines === expansion.ingredients.length
    && warnings.length === 0;

  return {
    servings,
    raw_total_grams: isComplete && rawCalculatedLines === expansion.ingredients.length
      ? roundWeight(rawTotal)
      : null,
    cooked_total_grams: isComplete ? roundWeight(cookedTotal) : null,
    raw_grams_per_serving: isComplete && rawCalculatedLines === expansion.ingredients.length
      ? roundWeight(rawTotal / servings)
      : null,
    grams_per_serving: isComplete ? roundWeight(cookedTotal / servings) : null,
    is_complete: isComplete,
    warnings
  };
}
