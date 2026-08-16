function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ingredientData(ingredient = {}) {
  return ingredient?.data && typeof ingredient.data === 'object'
    ? { ...ingredient, ...ingredient.data }
    : ingredient;
}

/**
 * Resolve the cooked/net output multiplier for an ingredient.
 *
 * A multiplier of 0.8 means 1 raw unit produces 0.8 cooked units. A
 * multiplier of 2.6 (for an ingredient such as rice) means 1 raw unit
 * produces 2.6 cooked units. Explicit raw/cooked weights take precedence,
 * followed by cooking yield and then shrinkage.
 */
export function resolveIngredientYield(ingredient = {}) {
  const source = ingredientData(ingredient);
  const rawWeight = finiteNumber(source.raw_weight_per_unit);
  const cookedWeight = finiteNumber(source.cooked_weight_per_unit);

  if (rawWeight > 0 && cookedWeight > 0) {
    const multiplier = cookedWeight / rawWeight;
    return {
      multiplier,
      percent: multiplier * 100,
      source: 'weight_ratio'
    };
  }

  const cookingYield = finiteNumber(source.cooking_yield_percent);
  if (cookingYield > 0) {
    return {
      multiplier: cookingYield / 100,
      percent: cookingYield,
      source: 'cooking_yield_percent'
    };
  }

  const shrinkage = finiteNumber(source.shrinkage_percent);
  if (shrinkage !== null && shrinkage >= 0 && shrinkage < 100) {
    const multiplier = 1 - (shrinkage / 100);
    return {
      multiplier,
      percent: multiplier * 100,
      source: 'shrinkage_percent'
    };
  }

  return {
    multiplier: 1,
    percent: 100,
    source: 'default'
  };
}

export function resolveIngredientYieldMultiplier(ingredient = {}) {
  return resolveIngredientYield(ingredient).multiplier;
}

/**
 * Convert the net/cooked recipe requirement into the raw quantity that
 * production must issue from inventory.
 */
export function calculateYieldAdjustedQuantity(netQuantity, ingredient = {}) {
  const normalizedQuantity = Math.max(0, finiteNumber(netQuantity, 0));
  const yieldDetails = resolveIngredientYield(ingredient);
  const requiredRawQuantity = normalizedQuantity / yieldDetails.multiplier;

  return {
    net_quantity: normalizedQuantity,
    required_raw_quantity: requiredRawQuantity,
    yield_multiplier: yieldDetails.multiplier,
    yield_percent: yieldDetails.percent,
    yield_source: yieldDetails.source
  };
}
