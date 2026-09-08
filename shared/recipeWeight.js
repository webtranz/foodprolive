import { convertIngredientQuantity, isIngredientUnitCompatible, normalizeIngredientUnit } from './ingredientUnits.js';
import { expandRecipeIngredients } from './recipeComposition.js';
import { calculateFrozenProductionLineWeight } from './productionReconciliation.js';
import { isExemptProcessingAid, recipeLineWeightFields } from './recipeLineWeight.js';

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
  if (!sourceUnit || !baseUnit || !isIngredientUnitCompatible(sourceUnit, baseUnit, ingredient)) return null;
  const converted = convertIngredientQuantity(quantity, sourceUnit, baseUnit, ingredient);
  return Number.isFinite(converted) ? converted : null;
}

function calculateIngredientLineWeight(line = {}, ingredient = {}) {
  const quantity = finiteNumber(line.quantity, 0);
  if (quantity < 0) return null;

  // Use the same unit/package-first calculation as production. Legacy 1/0.89
  // weight pairs describe yield; they must not turn 1 KG of onion into 1 gram.
  const weight = calculateFrozenProductionLineWeight({
    ...recipeLineWeightFields(line),
    ingredient_id: line.ingredient_id,
    planned_quantity: quantity,
    unit: line.unit || ingredient.unit
  }, ingredient);
  if (weight.raw_weight_grams !== null && weight.yielded_weight_grams !== null) {
    return { rawGrams: weight.raw_weight_grams, cookedGrams: weight.yielded_weight_grams };
  }
  const lineUnit = normalizeIngredientUnit(line.unit || ingredient.unit);
  const baseQuantity = quantityInBaseUnit(quantity, lineUnit, ingredient);
  const rawWeightPerUnit = finiteNumber(ingredient.raw_weight_per_unit);
  const cookedWeightPerUnit = finiteNumber(ingredient.cooked_weight_per_unit);

  if (!(rawWeightPerUnit > 0) && baseQuantity !== null && cookedWeightPerUnit !== null && cookedWeightPerUnit >= 0) {
    return { rawGrams: null, cookedGrams: baseQuantity * cookedWeightPerUnit };
  }
  return null;
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
  let weighedLineCount = 0;

  expansion.ingredients.forEach((line) => {
    if (isExemptProcessingAid(line)) return;
    weighedLineCount += 1;
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
    ...(weighedLineCount === 0 ? ['Recipe has no non-exempt ingredients to weigh.'] : []),
    ...expansion.warnings,
    ...expansion.cycles.map((cycle) => `Circular recipe reference: ${cycle.join(' → ')}`),
    ...missing.map((item) => `Weight unavailable for ${item}.`)
  ];
  const isComplete = weighedLineCount > 0
    && calculatedLines === weighedLineCount
    && warnings.length === 0;

  return {
    quantity_semantics: 'raw_recipe_to_yielded_output_v2',
    servings,
    raw_total_grams: isComplete && rawCalculatedLines === weighedLineCount
      ? roundWeight(rawTotal)
      : null,
    cooked_total_grams: isComplete ? roundWeight(cookedTotal) : null,
    yielded_total_grams: isComplete ? roundWeight(cookedTotal) : null,
    raw_grams_per_serving: isComplete && rawCalculatedLines === expansion.ingredients.length
      ? roundWeight(rawTotal / servings)
      : null,
    grams_per_serving: isComplete ? roundWeight(cookedTotal / servings) : null,
    yielded_grams_per_serving: isComplete ? roundWeight(cookedTotal / servings) : null,
    is_complete: isComplete,
    warnings
  };
}
