import { isIngredientUnitCompatible, quantityInIngredientBaseUnit } from './ingredientUnits.js';
import { expandRecipeIngredients } from './recipeComposition.js';
import { calculateRecipeServingWeight } from './recipeWeight.js';
import { roundStandardDecimal } from './recipeNumbers.js';
import { ingredientForRecipeLine } from './recipeLineWeight.js';

export const RECIPE_COSTING_METHODS = Object.freeze({
  average_cost: 'Average cost',
  last_cost: 'Last cost',
  standard_cost: 'Standard cost'
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeRecipeCostingMethod(value) {
  return Object.prototype.hasOwnProperty.call(RECIPE_COSTING_METHODS, value)
    ? value
    : 'average_cost';
}

export function resolveIngredientItemCost(ingredient = {}, costingMethod = 'average_cost') {
  const method = normalizeRecipeCostingMethod(costingMethod);
  const candidates = method === 'last_cost'
    ? [ingredient.last_cost, ingredient.cost_per_unit, ingredient.standard_cost, ingredient.average_cost]
    : method === 'standard_cost'
      ? [ingredient.standard_cost, ingredient.cost_per_unit, ingredient.last_cost, ingredient.average_cost]
      : [ingredient.average_cost, ingredient.cost_per_unit, ingredient.last_cost, ingredient.standard_cost];

  for (const candidate of candidates) {
    const numeric = finiteNumber(candidate);
    if (numeric !== null && numeric >= 0) return numeric;
  }
  return null;
}

export function calculateRecipeIngredientLineCost(line = {}, ingredient = {}, costingMethod = 'average_cost') {
  ingredient = ingredientForRecipeLine(line, ingredient);
  const itemCost = resolveIngredientItemCost(ingredient, costingMethod);
  const isCompatible = isIngredientUnitCompatible(
    line.unit || ingredient.unit,
    ingredient.unit,
    ingredient
  );
  if (!isCompatible) {
    return {
      item_cost: itemCost,
      normalized_quantity: null,
      line_cost: null,
      incompatible_unit: true
    };
  }
  const normalizedQuantity = quantityInIngredientBaseUnit(
    line.quantity,
    line.unit || ingredient.unit,
    ingredient
  );
  return {
    item_cost: itemCost,
    normalized_quantity: normalizedQuantity,
    raw_quantity: normalizedQuantity,
    line_cost: itemCost === null ? null : normalizedQuantity * itemCost
  };
}

export function calculateRecipeCostingSnapshot(recipe = {}, ingredients = [], recipes = []) {
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient?.id || ''), ingredient]));
  const expansion = expandRecipeIngredients(recipe, recipes, ingredients, { aggregate: false });
  const method = normalizeRecipeCostingMethod(recipe.costing_method);
  const lines = expansion.ingredients.map((line) => {
    const ingredient = ingredientMap.get(String(line.ingredient_id || '')) || null;
    const costing = ingredient
      ? calculateRecipeIngredientLineCost(line, ingredient, method)
      : { item_cost: null, normalized_quantity: Number(line.quantity) || 0, line_cost: null };
    return { ...line, ingredient, ...costing };
  });
  const hasCost = lines.length > 0 && lines.every((line) => line.line_cost !== null);
  const totalCost = hasCost ? lines.reduce((sum, line) => sum + line.line_cost, 0) : null;
  const servings = Math.max(1, Number(recipe.servings) || 1);
  const weight = calculateRecipeServingWeight(recipe, recipes, ingredients);
  const sellingPrice = finiteNumber(recipe.target_selling_price);
  const costPerServing = hasCost ? totalCost / servings : null;
  const costPer100g = hasCost && weight.cooked_total_grams > 0
    ? (totalCost / weight.cooked_total_grams) * 100
    : null;

  return {
    costing_method: method,
    lines,
    has_cost: hasCost,
    missing_cost_count: lines.filter((line) => line.line_cost === null).length,
    total_cost: totalCost === null ? null : roundStandardDecimal(totalCost, 4),
    cost_per_serving: costPerServing === null ? null : roundStandardDecimal(costPerServing, 4),
    cost_per_100g: costPer100g === null ? null : roundStandardDecimal(costPer100g, 4),
    total_recipe_weight_grams: weight.cooked_total_grams,
    total_raw_recipe_weight_grams: weight.raw_total_grams,
    expected_yield_weight_grams: weight.yielded_total_grams,
    quantity_semantics: 'raw_recipe_to_yielded_output_v2',
    target_selling_price: sellingPrice,
    margin_per_serving: sellingPrice === null || costPerServing === null
      ? null
      : roundStandardDecimal(sellingPrice - costPerServing, 4),
    food_cost_percent: sellingPrice === null || sellingPrice <= 0 || costPerServing === null
      ? null
      : roundStandardDecimal((costPerServing / sellingPrice) * 100, 2),
    weight,
    warnings: [...expansion.warnings, ...expansion.cycles.map((cycle) => `Circular recipe reference: ${cycle.join(' → ')}`)]
  };
}
