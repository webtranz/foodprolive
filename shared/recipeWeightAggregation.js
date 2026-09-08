import { calculateFrozenProductionLineWeight } from './productionReconciliation.js';
import { getRecipeLineWeight, recipeLineWeightFields } from './recipeLineWeight.js';

export function accumulateRecipeLineWeight(group, line, ingredient, quantity) {
  const weight = calculateFrozenProductionLineWeight({
    ...recipeLineWeightFields(line), ingredient_id: line.ingredient_id, unit: line.unit,
    planned_quantity: quantity
  }, ingredient);
  group._has_recipe_weight = Boolean(group._has_recipe_weight || getRecipeLineWeight(line) !== null);
  group._recipe_weight_complete = group._recipe_weight_complete !== false
    && (quantity === 0 || weight.raw_weight_grams !== null);
  group._recipe_raw_grams = (group._recipe_raw_grams || 0) + (weight.raw_weight_grams || 0);
}

export function finishRecipeLineWeight(group, quantity) {
  const { _has_recipe_weight, _recipe_weight_complete, _recipe_raw_grams, ...line } = group;
  if (!_has_recipe_weight || !_recipe_weight_complete || !(quantity > 0)) return line;
  return {
    ...line,
    weight_per_unit_grams: _recipe_raw_grams / quantity,
    weight_unit: line.unit,
    weight_ingredient_id: line.ingredient_id
  };
}
