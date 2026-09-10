import { calculateYieldOutputQuantity } from './ingredientYield.js';
import {
  getRecipeLinePrepExemptPercent,
  getRecipeLineWeight,
  isExemptProcessingAid,
  recipeLineRetainedFraction
} from './recipeLineWeight.js';
import { convertIngredientQuantity, ingredientWeightConversion, isIngredientUnitCompatible, normalizeIngredientUnit } from './ingredientUnits.js';
import {
  PACKAGE_UNITS,
  packageBaseQuantityForUnit,
  packageMeasureToCanonical
} from './packageUnits.js';

const WEIGHT_GRAMS = Object.freeze({ kg: 1000, g: 1 });
const VOLUME_MILLILITRES = Object.freeze({ l: 1000, ml: 1 });

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function positiveNumber(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function round(value) {
  return Number(Number(value).toFixed(6));
}

function densityGramsPerMillilitre(ingredient = {}) {
  return Math.max(0, finiteNumber(
    ingredient.density_g_per_ml ?? ingredient.density_grams_per_ml,
    1
  ));
}

function rawWeightFromMetadata(quantity, unit, ingredient) {
  const rawWeight = positiveNumber(ingredient.raw_weight_per_unit);
  const baseUnit = normalizeIngredientUnit(ingredient.unit || unit);
  const basePackage = packageBaseQuantityForUnit(ingredient, baseUnit);
  // A normalized 1-unit yield sample does not establish a gram weight for a
  // packet of counted items. Keep it unknown until an actual weight is entered.
  if (rawWeight === 1 && (basePackage?.unit === 'pieces' || PACKAGE_UNITS.has(baseUnit) || baseUnit === 'pieces')) return null;
  if (!rawWeight || !isIngredientUnitCompatible(unit, baseUnit, ingredient)) return null;
  return convertIngredientQuantity(quantity, unit, baseUnit, ingredient) * rawWeight;
}

function packageRawWeightGrams(quantity, unit, ingredient = {}) {
  if (!PACKAGE_UNITS.has(unit)) return null;
  const packageBase = packageBaseQuantityForUnit(ingredient, unit);
  if (!packageBase) return null;
  const canonical = packageMeasureToCanonical(packageBase.quantity, packageBase.unit);
  if (canonical.unit === 'kg') return quantity * canonical.quantity * 1000;
  if (canonical.unit === 'l') {
    return quantity * canonical.quantity * 1000 * densityGramsPerMillilitre(ingredient);
  }
  if (canonical.unit === 'pieces') {
    return rawWeightFromMetadata(quantity, unit, ingredient);
  }
  return null;
}

export function calculateFrozenProductionLineWeight(line = {}, ingredient = {}) {
  const processingAid = isExemptProcessingAid(line);
  const prepExemptPercent = getRecipeLinePrepExemptPercent(line);
  const retainedFraction = recipeLineRetainedFraction(line);
  const hasPartialPrepExemption = prepExemptPercent > 0 && prepExemptPercent < 100;
  const adjustedSource = (source) => {
    if (/prep_exempt_percent|exempt_processing_aid/i.test(String(source || ''))) return source;
    if (processingAid) return `${source}:exempt_processing_aid`;
    return hasPartialPrepExemption ? `${source}:prep_exempt_percent` : source;
  };
  const adjustedYieldSource = (source) => {
    if (/prep_exempt_percent|exempt_processing_aid/i.test(String(source || ''))) return source;
    if (processingAid) return 'exempt_processing_aid';
    return hasPartialPrepExemption ? `${source}:prep_exempt_percent` : source;
  };
  const rawQuantity = finiteNumber(
    line.planned_quantity ?? line.raw_quantity ?? line.required_quantity
  );
  if (rawQuantity === null || rawQuantity < 0) {
    return {
      raw_weight_grams: null,
      yielded_weight_grams: null,
      source: 'invalid_raw_quantity',
      weight_snapshot_status: 'invalid'
    };
  }

  const frozenRawWeight = finiteNumber(line.raw_weight_grams);
  const frozenYieldedWeight = finiteNumber(line.yielded_weight_grams);
  const hasValidFrozenWeights = rawQuantity === 0
    ? frozenRawWeight === 0 && frozenYieldedWeight === 0
    : frozenRawWeight > 0 && frozenYieldedWeight > 0;
  if (hasValidFrozenWeights) {
    const frozenSource = [
      line.weight_calculation_source,
      line.yield_calculation_source,
      line.yield_source
    ].filter(Boolean).join(':');
    const prepExemptionAlreadyApplied = /prep_exempt_percent|exempt_processing_aid/i.test(frozenSource);
    const frozenYieldedAfterPrep = prepExemptionAlreadyApplied
      ? frozenYieldedWeight
      : frozenYieldedWeight * retainedFraction;
    const frozenMultiplier = frozenRawWeight > 0
      ? frozenYieldedAfterPrep / frozenRawWeight
      : positiveNumber(line.yield_multiplier) ?? 0;
    return {
      raw_weight_grams: round(frozenRawWeight),
      yielded_weight_grams: round(frozenYieldedAfterPrep),
      yield_multiplier: round(frozenMultiplier),
      yield_percent: round(frozenMultiplier * 100),
      source: adjustedSource(line.weight_calculation_source || 'frozen_weight_snapshot'),
      yield_source: adjustedYieldSource(line.yield_calculation_source || line.yield_source || 'frozen_yield_snapshot'),
      prep_exempt_percent: prepExemptPercent,
      retained_fraction: round(retainedFraction),
      weight_snapshot_status: 'frozen'
    };
  }
  const unit = normalizeIngredientUnit(line.unit || ingredient.unit);
  const definedWeight = getRecipeLineWeight(line);
  const ingredientWeight = definedWeight === null ? ingredientWeightConversion(rawQuantity, unit, ingredient) : null;
  let rawWeightGrams = definedWeight === null
    ? ingredientWeight?.grams ?? packageRawWeightGrams(rawQuantity, unit, ingredient)
    : rawQuantity * definedWeight;
  let weightSource = definedWeight !== null ? 'admin_recipe_line_weight'
    : ingredientWeight?.source ?? (rawWeightGrams === null ? null : 'package_measure');

  if (rawWeightGrams === null && unit in WEIGHT_GRAMS) {
    rawWeightGrams = rawQuantity * WEIGHT_GRAMS[unit];
    weightSource = 'weight_unit';
  }
  if (rawWeightGrams === null && unit in VOLUME_MILLILITRES) {
    rawWeightGrams = rawQuantity
      * VOLUME_MILLILITRES[unit]
      * densityGramsPerMillilitre(ingredient);
    weightSource = 'volume_density';
  }
  if (rawWeightGrams === null) {
    const metadataWeight = rawWeightFromMetadata(rawQuantity, unit, ingredient);
    if (metadataWeight !== null) {
      rawWeightGrams = metadataWeight;
      weightSource = 'raw_weight_per_unit';
    }
  }
  if (rawWeightGrams === null) {
    return {
      raw_weight_grams: null,
      yielded_weight_grams: null,
      source: 'weight_unavailable',
      weight_snapshot_status: 'unavailable'
    };
  }

  const frozenMultiplier = positiveNumber(line.yield_multiplier);
  const frozenPercent = positiveNumber(line.yield_percent);
  const resolvedYield = calculateYieldOutputQuantity(rawWeightGrams, ingredient);
  const multiplier = frozenMultiplier
    ?? (frozenPercent ? frozenPercent / 100 : resolvedYield.yield_multiplier);
  const yieldSource = frozenMultiplier
    ? 'frozen_yield_multiplier'
    : frozenPercent
      ? 'frozen_yield_percent'
      : resolvedYield.yield_source;

  return {
    raw_weight_grams: round(rawWeightGrams),
    yielded_weight_grams: round(rawWeightGrams * multiplier * retainedFraction),
    yield_multiplier: round(multiplier * retainedFraction),
    yield_percent: round(multiplier * retainedFraction * 100),
    source: adjustedSource(`${weightSource}:${yieldSource}`),
    yield_source: adjustedYieldSource(yieldSource),
    prep_exempt_percent: prepExemptPercent,
    retained_fraction: round(retainedFraction),
    weight_snapshot_status: 'metadata_reconstruction'
  };
}

/**
 * Calculate finished output only from server-owned production lines, ingredient
 * package metadata and frozen yield values. This is shared with the UI solely
 * for preview; the server recalculates it again when completion is posted.
 */
export function buildAutomaticProductionYieldSummary({
  production = {},
  recipe = {},
  ingredients = []
} = {}) {
  const isV2Snapshot = Number(production.yield_adjustment_version || 0) >= 2
    && String(production.quantity_semantics || '').toLowerCase().includes('raw');
  const ingredientMap = new Map(
    (Array.isArray(ingredients) ? ingredients : [])
      .map((ingredient) => [String(ingredient?.id || ''), ingredient])
  );
  const lines = (Array.isArray(production.ingredients_used) ? production.ingredients_used : [])
    .map((line) => {
      const rawQuantity = finiteNumber(
        line?.planned_quantity ?? line?.raw_quantity ?? line?.required_quantity,
        0
      );
      const ingredient = {
        ...line,
        ...(ingredientMap.get(String(line?.ingredient_id || '')) || {})
      };
      return {
        ingredient_id: line?.ingredient_id || null,
        raw_quantity: rawQuantity,
        exempt_processing_aid: isExemptProcessingAid(line),
        prep_exempt_percent: getRecipeLinePrepExemptPercent(line),
        ...calculateFrozenProductionLineWeight(
          line,
          ingredient
        )
      };
    });
  const outputLines = lines.filter((line) => !line.exempt_processing_aid);
  const measurableLines = outputLines.filter((line) => line.yielded_weight_grams !== null);
  const rawWeight = measurableLines.reduce((total, line) => (
    total + (line.raw_weight_grams * recipeLineRetainedFraction(line))
  ), 0);
  const yieldedWeight = measurableLines.reduce((total, line) => total + line.yielded_weight_grams, 0);
  const positiveLines = outputLines.filter((line) => line.raw_quantity > 0);
  const measurablePositiveLines = positiveLines.filter((line) => line.yielded_weight_grams !== null);
  const isComplete = positiveLines.length > 0 && measurablePositiveLines.length === positiveLines.length;
  const usesMetadataRepair = positiveLines.some(
    (line) => line.weight_snapshot_status === 'metadata_reconstruction'
  );
  const targetServings = positiveNumber(production.target_servings);
  const frozenPortion = positiveNumber(production.portion_size_grams);
  const frozenPortionSource = String(production.portion_size_source || '').toLowerCase();
  const frozenRecipePortion = frozenPortionSource === 'recipe_portion_size'
    ? frozenPortion
    : null;
  // Current recipe data is a permitted fallback only for legacy records. A v2
  // approval must remain reproducible even after the recipe master changes.
  const recipePortion = isV2Snapshot ? null : positiveNumber(recipe.portion_size_grams);
  const yieldDerivedPortion = isComplete && targetServings
    ? yieldedWeight / targetServings
    : null;
  const configuredPortion = isV2Snapshot
    ? frozenPortionSource === 'yield_calculated'
      ? yieldDerivedPortion
      : frozenPortion ?? yieldDerivedPortion
    : frozenRecipePortion ?? recipePortion ?? frozenPortion;
  const configuredToYieldRatio = configuredPortion && yieldDerivedPortion
    ? Math.max(configuredPortion, yieldDerivedPortion) / Math.min(configuredPortion, yieldDerivedPortion)
    : 1;
  // Protect against the historical kg-as-g defect (for example 0.32 stored
  // where the line-derived serving weight is 320 g). A 100x+ discrepancy is a
  // unit-scale anomaly, not a credible portion variance.
  const hasPortionUnitScaleAnomaly = configuredToYieldRatio >= 100;
  const portionSize = frozenPortionSource === 'yield_calculated' && yieldDerivedPortion
    ? yieldDerivedPortion
    : hasPortionUnitScaleAnomaly
    ? yieldDerivedPortion
    : configuredPortion ?? yieldDerivedPortion;
  const expectedFinishedWeight = isComplete ? yieldedWeight : null;
  const expectedYieldServings = expectedFinishedWeight && portionSize
    ? expectedFinishedWeight / portionSize
    : null;

  return {
    quantity_semantics: 'raw_recipe_to_yielded_output_v2',
    reconciliation_mode: 'automatic_yield_plan',
    output_calculation_source: isComplete
      ? isV2Snapshot && usesMetadataRepair
        ? 'legacy_v2_metadata_repair'
        : isV2Snapshot
          ? 'frozen_raw_line_yields'
          : 'legacy_recipe_raw_line_yields'
      : 'yield_weight_fallback_required',
    recipe_raw_weight_grams: isComplete ? round(rawWeight) : null,
    expected_finished_weight_grams: expectedFinishedWeight ? round(expectedFinishedWeight) : null,
    portion_size_grams: portionSize ? round(portionSize) : null,
    portion_size_source: hasPortionUnitScaleAnomaly
      ? 'yield_calculated_unit_correction'
      : frozenPortionSource === 'yield_calculated' && yieldDerivedPortion
        ? 'yield_calculated'
        : frozenRecipePortion
        ? 'recipe_portion_size'
        : recipePortion
          ? 'recipe_portion_size'
          : yieldDerivedPortion
            ? 'yield_calculated'
            : 'unavailable',
    expected_yield_servings: expectedYieldServings ? round(expectedYieldServings) : null,
    line_weights: lines,
    warnings: [
      ...(hasPortionUnitScaleAnomaly
        ? [`Configured portion size ${round(configuredPortion)} g was replaced by the line-derived ${round(yieldDerivedPortion)} g because the values differ by a unit scale.`]
        : []),
      ...outputLines
      .filter((line) => line.raw_quantity > 0 && line.yielded_weight_grams === null)
      .map((line) => `Yield weight unavailable for ingredient ${line.ingredient_id || 'unknown'}.`)
    ]
  };
}
