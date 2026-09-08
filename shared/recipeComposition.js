import { convertIngredientQuantity } from './ingredientUnits.js';
import {
  ingredientForRecipeLine,
  isExemptProcessingAid,
  recipeLineProcessingAidField
} from './recipeLineWeight.js';
import { accumulateRecipeLineWeight, finishRecipeLineWeight } from './recipeWeightAggregation.js';

const SUB_RECIPE_UNITS = new Set(['batch', 'servings']);

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function recipeId(recipe) {
  return String(recipe?.id || '').trim();
}

export function getSubRecipeLines(recipe) {
  return Array.isArray(recipe?.sub_recipes) ? recipe.sub_recipes : [];
}

export function getSubRecipeMultiplier(line, subRecipe) {
  const quantity = Math.max(0, finiteNumber(line?.quantity, 0));
  const unit = SUB_RECIPE_UNITS.has(line?.unit) ? line.unit : 'batch';
  if (unit === 'servings') {
    return quantity / Math.max(1, finiteNumber(subRecipe?.servings, 1));
  }
  return quantity;
}

export function wouldCreateRecipeCycle(parentRecipeId, candidateRecipeId, recipes = []) {
  const parentId = String(parentRecipeId || '').trim();
  const candidateId = String(candidateRecipeId || '').trim();
  if (!parentId || !candidateId) return false;
  if (parentId === candidateId) return true;

  const recipeMap = new Map(recipes.map((recipe) => [recipeId(recipe), recipe]));
  const visited = new Set();
  const pending = [candidateId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === parentId) return true;
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const current = recipeMap.get(currentId);
    getSubRecipeLines(current).forEach((line) => pending.push(String(line?.recipe_id || '').trim()));
  }

  return false;
}

export function expandRecipeIngredients(
  recipe,
  recipes = [],
  ingredients = [],
  { multiplier = 1, aggregate = true, maxDepth = 12 } = {}
) {
  const recipeMap = new Map(recipes.map((item) => [recipeId(item), item]));
  if (recipeId(recipe)) recipeMap.set(recipeId(recipe), recipe);
  const ingredientMap = new Map(ingredients.map((item) => [String(item?.id || ''), item]));
  const expanded = [];
  const warnings = [];
  const cycles = [];

  function visit(currentRecipe, currentMultiplier, path = []) {
    const currentId = recipeId(currentRecipe) || `anonymous-${path.length}`;
    if (path.includes(currentId)) {
      cycles.push([...path, currentId]);
      return;
    }
    if (path.length >= maxDepth) {
      warnings.push(`Recipe expansion exceeded ${maxDepth} levels at ${currentRecipe?.name || currentId}.`);
      return;
    }

    const nextPath = [...path, currentId];
    (Array.isArray(currentRecipe?.ingredients) ? currentRecipe.ingredients : []).forEach((line) => {
      if (!line?.ingredient_id) return;
      expanded.push({
        ...line,
        quantity: finiteNumber(line.quantity, 0) * currentMultiplier,
        quantity_basis: 'raw',
        source_recipe_id: currentRecipe?.id || null,
        source_recipe_name: currentRecipe?.name || null,
        source_recipe_path: nextPath
      });
    });

    getSubRecipeLines(currentRecipe).forEach((line) => {
      const childId = String(line?.recipe_id || '').trim();
      const childRecipe = recipeMap.get(childId);
      if (!childRecipe) {
        warnings.push(`Referenced sub-recipe ${line?.recipe_name || childId || 'unknown'} was not found.`);
        return;
      }
      const childMultiplier = getSubRecipeMultiplier(line, childRecipe);
      if (childMultiplier <= 0) return;
      visit(childRecipe, currentMultiplier * childMultiplier, nextPath);
    });
  }

  visit(recipe, finiteNumber(multiplier, 0), []);

  if (!aggregate) {
    return { ingredients: expanded, warnings, cycles, has_errors: warnings.length > 0 || cycles.length > 0 };
  }

  const aggregated = new Map();
  expanded.forEach((line) => {
    const ingredient = ingredientForRecipeLine(line, ingredientMap.get(String(line.ingredient_id)));
    const targetUnit = ingredient?.unit || line.unit || 'unit';
    const normalizedQuantity = convertIngredientQuantity(
      line.quantity,
      line.unit || targetUnit,
      targetUnit,
      ingredient
    );
    const processingAid = isExemptProcessingAid(line);
    const key = `${line.ingredient_id}::${targetUnit}::${processingAid ? 'processing_aid' : 'food'}`;
    const current = aggregated.get(key) || {
      ingredient_id: line.ingredient_id,
      ingredient_name: ingredient?.name || line.ingredient_name || 'Unnamed ingredient',
      quantity: 0,
      unit: targetUnit,
      quantity_basis: 'raw',
      ...recipeLineProcessingAidField(line),
      source_recipe_ids: new Set(),
      source_recipe_names: new Set()
    };
    current.quantity += normalizedQuantity;
    accumulateRecipeLineWeight(current, line, ingredient, line.quantity);
    if (line.source_recipe_id) current.source_recipe_ids.add(line.source_recipe_id);
    if (line.source_recipe_name) current.source_recipe_names.add(line.source_recipe_name);
    aggregated.set(key, current);
  });

  return {
    ingredients: [...aggregated.values()].map((line) => ({
      ...finishRecipeLineWeight(line, line.quantity),
      quantity: Number(line.quantity.toFixed(6)),
      source_recipe_ids: [...line.source_recipe_ids],
      source_recipe_names: [...line.source_recipe_names]
    })),
    warnings,
    cycles,
    has_errors: warnings.length > 0 || cycles.length > 0
  };
}

export function validateRecipeComposition(recipe, recipes = []) {
  const errors = [];
  const availableIds = new Set(recipes.map((item) => recipeId(item)).filter(Boolean));
  const currentId = recipeId(recipe);
  if (currentId) availableIds.add(currentId);

  getSubRecipeLines(recipe).forEach((line, index) => {
    const childId = String(line?.recipe_id || '').trim();
    const quantity = finiteNumber(line?.quantity, 0);
    const unit = line?.unit || 'batch';
    if (!childId) errors.push(`Sub-recipe ${index + 1} must select a recipe.`);
    else if (currentId && childId === currentId) errors.push('A recipe cannot include itself.');
    else if (!availableIds.has(childId)) errors.push(`Sub-recipe ${line?.recipe_name || childId} does not exist.`);
    if (quantity <= 0) errors.push(`Sub-recipe ${line?.recipe_name || index + 1} must have a quantity greater than zero.`);
    if (!SUB_RECIPE_UNITS.has(unit)) errors.push(`Sub-recipe ${line?.recipe_name || index + 1} has an invalid quantity unit.`);
  });

  const catalog = recipes.map((item) => (currentId && recipeId(item) === currentId ? recipe : item));
  if (currentId && !catalog.some((item) => recipeId(item) === currentId)) catalog.push(recipe);
  const expansion = expandRecipeIngredients(recipe, catalog, [], { aggregate: false });
  expansion.cycles.forEach((cycle) => errors.push(`Circular recipe reference detected: ${cycle.join(' → ')}.`));
  expansion.warnings.forEach((warning) => errors.push(warning));

  return [...new Set(errors)];
}
