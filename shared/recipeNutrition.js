import { calculateFrozenProductionLineWeight } from './productionReconciliation.js';
import { isExemptProcessingAid, recipeLineRetainedFraction, recipeLineWeightFields } from './recipeLineWeight.js';
import { ingredientWeightConversion, normalizeIngredientUnit } from './ingredientUnits.js';
import { PACKAGE_UNITS, packageBaseQuantityForUnit, packageMeasureToCanonical } from './packageUnits.js';
import { normalizeAllergenTags } from './allergens.js';

const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat', 'sodium', 'sugar'];
const VOLUME_MILLILITRES = { l: 1000, ml: 1 };
const MAX_DEPTH = 12;

function nonnegativeNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function positiveNumber(value) {
  const numeric = nonnegativeNumber(value);
  return numeric > 0 ? numeric : null;
}

// Missing nutrient entries contribute zero by recipe policy. Keep this default
// separate from quantity and weight validation, where missing data is unknown.
function nutrientNumber(value) {
  if (value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '')) return 0;
  return nonnegativeNumber(value);
}

function identifier(value) {
  return String(value ?? '').trim();
}

// Production reconstruction also supports legacy assumptions. Nutrition must
// have an established mass, so reject inferred density and package sizes here.
function rawGrams(line, ingredient) {
  const unit = normalizeIngredientUnit(line.unit || ingredient.unit);
  if (!unit) return null;
  const boundWeight = recipeLineWeightFields(line);
  let weightIngredient = ingredient;

  if (!Object.keys(boundWeight).length) {
    const conversion = ingredientWeightConversion(line.quantity, unit, ingredient);
    if (conversion !== null) return positiveNumber(conversion.grams);

    const packageBase = PACKAGE_UNITS.has(unit) ? packageBaseQuantityForUnit(ingredient, unit) : null;
    const packageSource = ingredient.package_parse_source || packageBase?.source;
    const packageName = ingredient.supplier_item_name || ingredient.ingredient_name
      || ingredient.name || ingredient.item_name || '';
    const hasNamedMeasure = /\d\s*(?:KG|KGS|G|GM|GMS|GRAMS|LTR|L|LT|LITRE|LITER|ML|CT|CNT|COUNT|COUNTS|OZ|Z)\b/i.test(packageName);
    const unverifiedPackage = PACKAGE_UNITS.has(unit) && (!packageBase
      || packageSource === 'default_bundle_weight'
      || (packageSource === 'item_name_package' && !hasNamedMeasure));

    if (unverifiedPackage) {
      // An actual gram weight for this base package can replace an absent or
      // guessed descriptor. A normalized 1-unit yield sample is not a weight.
      const rawWeight = positiveNumber(ingredient.raw_weight_per_unit);
      if (unit !== normalizeIngredientUnit(ingredient.unit) || !(rawWeight > 1)) return null;
      weightIngredient = { ...ingredient, package_base_quantity: rawWeight, package_base_unit: 'g' };
    }

    const canonicalPackage = packageBase && !unverifiedPackage
      ? packageMeasureToCanonical(packageBase.quantity, packageBase.unit)
      : null;
    if (unit in VOLUME_MILLILITRES || canonicalPackage?.unit === 'l') {
      let density = positiveNumber(ingredient.density_g_per_ml ?? ingredient.density_grams_per_ml);
      if (density === null) {
        const baseUnit = normalizeIngredientUnit(ingredient.unit);
        const rawWeight = positiveNumber(ingredient.raw_weight_per_unit);
        if (baseUnit in VOLUME_MILLILITRES && rawWeight > 1) {
          density = rawWeight / VOLUME_MILLILITRES[baseUnit];
        } else if (baseUnit === unit && canonicalPackage?.unit === 'l' && rawWeight > 1) {
          density = rawWeight / (canonicalPackage.quantity * 1000);
        }
      }
      if (!(density > 0) || !Number.isFinite(density)) return null;
      weightIngredient = { ...weightIngredient, density_g_per_ml: density };
    }
  }

  // Never accept client-frozen totals, yield multipliers, or other line fields.
  const weight = calculateFrozenProductionLineWeight({
    ...boundWeight,
    ingredient_id: line.ingredient_id,
    planned_quantity: line.quantity,
    unit
  }, weightIngredient).raw_weight_grams;
  return positiveNumber(weight);
}

/** Derive current nutrition and tagged allergens without changing recipe data. */
export function calculateRecipeNutrition(recipe = {}, recipes = [], ingredients = []) {
  recipe = recipe && typeof recipe === 'object' ? recipe : {};
  const recipeMap = new Map((Array.isArray(recipes) ? recipes : [])
    .filter(Boolean).map((item) => [identifier(item.id), item]));
  if (identifier(recipe.id)) recipeMap.set(identifier(recipe.id), recipe);
  const ingredientMap = new Map((Array.isArray(ingredients) ? ingredients : [])
    .filter(Boolean).map((item) => [identifier(item.id), item]));
  const totals = Object.fromEntries(NUTRIENTS.map((nutrient) => [nutrient, 0]));
  const nutritionWarnings = new Set();
  const allergenWarnings = new Set();
  const allergens = new Set();
  const legacyTags = new Set();
  let allWeightsKnown = true;
  let activeIngredientCount = 0;

  function compositionWarning(message) {
    nutritionWarnings.add(message);
    allergenWarnings.add(message);
    allWeightsKnown = false;
  }

  function collectTags(value, label, required = true) {
    if (!Array.isArray(value)) {
      if (typeof value === 'string' && value.trim()) return normalizeAllergenTags(value);
      if (required || value !== undefined) allergenWarnings.add(`Allergen tags are unavailable for ${label}.`);
      return [];
    }
    if (Array.isArray(value) && value.some((tag) => tag == null || (typeof tag === 'string' && !tag.trim()))) {
      allergenWarnings.add(`Some allergen tags are invalid for ${label}.`);
    }
    return normalizeAllergenTags(value);
  }

  function declarations(current) {
    const label = `recipe ${current.name || current.id || 'unnamed'}`;
    return [...new Set(collectTags(current.declared_allergens, label, false))];
  }

  function legacyCandidates(current) {
    const label = `recipe ${current.name || current.id || 'unnamed'}`;
    const value = current.nutrition_calculation_version === undefined || current.nutrition_calculation_version === null
      ? current.allergens
      : current.legacy_allergens;
    return [...new Set(collectTags(value, label, false))];
  }

  const declaredAllergens = declarations(recipe);
  const rootLegacyCandidates = legacyCandidates(recipe);

  // Keep lines separate: the same ingredient can have different bound weights
  // in different recipes, and aggregation would lose those conversions.
  function visit(current, multiplier, path = []) {
    const key = identifier(current.id) || current;
    const label = current.name || current.id || 'unnamed recipe';
    declarations(current).forEach((tag) => allergens.add(tag));
    legacyCandidates(current).forEach((tag) => legacyTags.add(tag));
    if (path.includes(key)) {
      compositionWarning(`Circular recipe reference detected at ${label}.`);
      return;
    }
    if (path.length >= MAX_DEPTH) {
      compositionWarning(`Recipe expansion exceeded ${MAX_DEPTH} levels at ${label}.`);
      return;
    }
    const nextPath = [...path, key];
    const directLines = Array.isArray(current.ingredients) ? current.ingredients : [];
    const childLines = Array.isArray(current.sub_recipes) ? current.sub_recipes : [];
    if ((current.ingredients != null && !Array.isArray(current.ingredients))
      || (current.sub_recipes != null && !Array.isArray(current.sub_recipes))) {
      compositionWarning(`Ingredient or sub-recipe lines are invalid for ${label}.`);
    }
    if (!directLines.length && !childLines.length) compositionWarning(`Recipe ${label} has no ingredients to calculate.`);

    directLines.forEach((line, index) => {
      const quantity = nonnegativeNumber(line?.quantity);
      if (quantity === 0) return;
      const name = line?.ingredient_name || line?.ingredient_id || `line ${index + 1} in ${label}`;
      if (quantity === null || !Number.isFinite(quantity * multiplier)) {
        compositionWarning(`Quantity is unavailable or invalid for ingredient ${name}.`);
      }
      const id = identifier(line?.ingredient_id);
      const ingredient = id ? ingredientMap.get(id) : null;
      if (!ingredient) {
        if (isExemptProcessingAid(line)) {
          allergenWarnings.add(`Ingredient ${name} was not found.`);
        } else {
          compositionWarning(`Ingredient ${name} was not found.`);
        }
        return;
      }
      collectTags(ingredient.allergens, `ingredient ${ingredient.name || name}`)
        .forEach((tag) => allergens.add(tag));
      const retainedFraction = recipeLineRetainedFraction(line);
      if (retainedFraction <= 0) return;
      activeIngredientCount += 1;
      if (quantity === null || !Number.isFinite(quantity * multiplier)) return;
      const grams = rawGrams({ ...line, quantity: quantity * multiplier * retainedFraction }, ingredient);
      const nutrientValues = Object.fromEntries(
        NUTRIENTS.map((nutrient) => [nutrient, nutrientNumber(ingredient[`${nutrient}_per_100g`])])
      );
      const hasNonZeroNutrition = Object.values(nutrientValues)
        .some((value) => value === null || value > 0);
      if (grams === null && hasNonZeroNutrition) {
        nutritionWarnings.add(`Weight unavailable for ingredient ${ingredient.name || name}; a verified gram conversion is required.`);
        allWeightsKnown = false;
      }
      NUTRIENTS.forEach((nutrient) => {
        const value = nutrientValues[nutrient];
        if (value === null) {
          totals[nutrient] = null;
          nutritionWarnings.add(`${nutrient[0].toUpperCase()}${nutrient.slice(1)} per 100 g is unavailable for ingredient ${ingredient.name || name}.`);
        } else if (grams !== null && totals[nutrient] !== null) {
          totals[nutrient] += value * grams / 100;
          if (!Number.isFinite(totals[nutrient])) {
            totals[nutrient] = null;
            nutritionWarnings.add(`${nutrient} could not be calculated for ingredient ${ingredient.name || name}.`);
          }
        }
      });
    });

    childLines.forEach((line, index) => {
      const quantity = nonnegativeNumber(line?.quantity);
      if (quantity === 0) return;
      const id = identifier(line?.recipe_id);
      const child = id ? recipeMap.get(id) : null;
      const name = line?.recipe_name || id || `line ${index + 1} in ${label}`;
      if (!child) {
        compositionWarning(`Referenced sub-recipe ${name} was not found.`);
        return;
      }
      const unit = line?.unit || 'batch';
      const childServings = positiveNumber(child.servings);
      const validQuantity = quantity !== null && (unit === 'batch' || unit === 'servings')
        && (unit !== 'servings' || childServings !== null);
      const childMultiplier = validQuantity ? multiplier * quantity / (unit === 'servings' ? childServings : 1) : null;
      if (childMultiplier === null || !Number.isFinite(childMultiplier)) {
        compositionWarning(`Quantity or servings are unavailable or invalid for sub-recipe ${name}.`);
        // Still collect known tags from a referenced recipe of unknown quantity.
        visit(child, multiplier, nextPath);
      } else {
        visit(child, childMultiplier, nextPath);
      }
    });
  }

  visit(recipe, 1);
  // Old saves mixed calculated tags with manual entries. Matching current data
  // can be recalculated safely; unmatched tags remain visible until reviewed.
  // Keep root legacy candidates separate so child tags never become permanent
  // parent declarations when a sub-recipe changes or is removed.
  const currentAllergens = new Set(allergens);
  const legacyAllergens = rootLegacyCandidates.filter((tag) => !currentAllergens.has(tag));
  legacyTags.forEach((tag) => {
    if (!currentAllergens.has(tag)) {
      allergens.add(tag);
      allergenWarnings.add(`Previously saved allergen ${tag} needs review; it is not present in current ingredient or declared allergen data.`);
    }
  });
  if (!activeIngredientCount) compositionWarning('Recipe has no non-exempt ingredients to calculate.');
  const servings = positiveNumber(recipe.servings);
  if (servings === null) nutritionWarnings.add('A valid number of servings is required for nutrition per serving.');
  const result = {};
  NUTRIENTS.forEach((nutrient) => {
    const total = allWeightsKnown ? totals[nutrient] : null;
    const rounded = (value) => Number(value.toFixed(nutrient === 'calories' ? 0 : 2));
    result[`total_${nutrient}`] = total === null ? null : rounded(total);
    const perServing = total === null || servings === null ? null : total / servings;
    result[`${nutrient}_per_serving`] = perServing === null || !Number.isFinite(perServing) ? null : rounded(perServing);
  });
  return {
    ...result,
    allergens: [...allergens].sort(),
    declared_allergens: [...declaredAllergens].sort(),
    legacy_allergens: legacyAllergens.sort(),
    nutrition_complete: nutritionWarnings.size === 0 && NUTRIENTS.every((nutrient) => result[`${nutrient}_per_serving`] !== null),
    nutrition_warnings: [...nutritionWarnings],
    allergens_complete: allergenWarnings.size === 0,
    allergens_warnings: [...allergenWarnings],
    nutrition_calculation_version: 1
  };
}
