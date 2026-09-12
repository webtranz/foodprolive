import {
  convertIngredientQuantity,
  isIngredientUnitCompatible,
  normalizeIngredientUnit
} from './ingredientUnits.js';
import {
  formatRecipeQuantity,
  getRecipeQuantityPrecision,
  roundStandardDecimal
} from './recipeNumbers.js';
import { getItemCode } from './itemCode.js';
import { clearRecipeLineWeight } from './recipeLineWeight.js';

function text(value) {
  return String(value || '').trim();
}

function unitKey(value) {
  return text(value).toLowerCase();
}

function numericQuantity(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function ingredientMapFrom(ingredients = []) {
  return new Map((Array.isArray(ingredients) ? ingredients : [])
    .filter((ingredient) => ingredient?.id)
    .map((ingredient) => [String(ingredient.id), ingredient]));
}

export function recipeUnitSyncKey({ recipe_id, line_index, ingredient_id }) {
  return `${recipe_id || ''}:${line_index}:${ingredient_id || ''}`;
}

export function describeIngredientUnitConversion(ingredient = {}) {
  const baseUnit = text(ingredient.unit);
  const conversionUnit = text(ingredient.conversion_unit);
  const conversionFactor = Number(ingredient.conversion_factor);

  if (baseUnit && conversionUnit && Number.isFinite(conversionFactor) && conversionFactor > 0) {
    return `1 ${baseUnit} = ${formatRecipeQuantity(conversionFactor, conversionUnit)} ${conversionUnit}`;
  }

  return baseUnit ? `Ingredient base unit: ${baseUnit}` : 'No ingredient unit configured';
}

function skippedRecipeLine(recipe, line, lineIndex, reason) {
  return {
    key: recipeUnitSyncKey({
      recipe_id: recipe?.id,
      line_index: lineIndex,
      ingredient_id: line?.ingredient_id
    }),
    recipe_id: recipe?.id || '',
    recipe_name: recipe?.name || recipe?.recipe_name || 'Unnamed recipe',
    line_index: lineIndex,
    ingredient_id: line?.ingredient_id || '',
    ingredient_name: line?.ingredient_name || 'Ingredient',
    current_quantity: line?.quantity,
    current_unit: line?.unit || '',
    reason
  };
}

export function buildRecipeIngredientUnitSyncPreview({ recipes = [], ingredients = [] } = {}) {
  const ingredientMap = ingredientMapFrom(ingredients);
  const changes = [];
  const skipped = [];

  (Array.isArray(recipes) ? recipes : []).forEach((recipe) => {
    const recipeLines = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
    recipeLines.forEach((line, lineIndex) => {
      if (!line?.ingredient_id) return;

      const ingredient = ingredientMap.get(String(line.ingredient_id));
      if (!ingredient) {
        skipped.push(skippedRecipeLine(recipe, line, lineIndex, 'Ingredient master record was not found.'));
        return;
      }

      const currentUnit = text(line.unit || ingredient.unit);
      const proposedUnit = text(ingredient.unit);
      if (!currentUnit || !proposedUnit) {
        skipped.push(skippedRecipeLine(recipe, line, lineIndex, 'Recipe line or ingredient master unit is missing.'));
        return;
      }

      if (unitKey(currentUnit) === unitKey(proposedUnit)) return;

      const quantity = numericQuantity(line.quantity);
      if (quantity === null) {
        skipped.push(skippedRecipeLine(recipe, line, lineIndex, 'Recipe line quantity is not a valid number.'));
        return;
      }

      if (!isIngredientUnitCompatible(currentUnit, proposedUnit, ingredient)) {
        skipped.push(skippedRecipeLine(
          recipe,
          line,
          lineIndex,
          `Cannot convert ${currentUnit} to ${proposedUnit} with the current ingredient conversion rules.`
        ));
        return;
      }

      const converted = convertIngredientQuantity(quantity, currentUnit, proposedUnit, ingredient);
      if (!Number.isFinite(converted) || converted < 0) {
        skipped.push(skippedRecipeLine(recipe, line, lineIndex, 'Conversion did not produce a valid quantity.'));
        return;
      }

      const proposedQuantity = roundStandardDecimal(
        converted,
        getRecipeQuantityPrecision(proposedUnit)
      );
      if (proposedQuantity === null) {
        skipped.push(skippedRecipeLine(recipe, line, lineIndex, 'Converted quantity could not be rounded safely.'));
        return;
      }

      changes.push({
        key: recipeUnitSyncKey({
          recipe_id: recipe.id,
          line_index: lineIndex,
          ingredient_id: ingredient.id
        }),
        recipe_id: recipe.id,
        recipe_name: recipe.name || recipe.recipe_name || 'Unnamed recipe',
        line_index: lineIndex,
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name || line.ingredient_name || 'Ingredient',
        item_code: getItemCode(ingredient, line.item_code || ''),
        current_quantity: quantity,
        current_unit: currentUnit,
        proposed_quantity: proposedQuantity,
        proposed_unit: proposedUnit,
        conversion_summary: describeIngredientUnitConversion(ingredient),
        normalized_current_unit: normalizeIngredientUnit(currentUnit),
        normalized_proposed_unit: normalizeIngredientUnit(proposedUnit)
      });
    });
  });

  return { changes, skipped };
}

export function applyRecipeIngredientUnitSync(recipe = {}, ingredients = [], requestedChanges = []) {
  const requestedKeys = new Set((Array.isArray(requestedChanges) ? requestedChanges : [])
    .map((change) => change?.key || recipeUnitSyncKey(change || {}))
    .filter(Boolean));
  const preview = buildRecipeIngredientUnitSyncPreview({ recipes: [recipe], ingredients });
  const applicable = preview.changes.filter((change) => requestedKeys.has(change.key));

  if (!applicable.length) {
    return {
      recipe,
      changes: [],
      skipped: [
        ...preview.skipped,
        ...(requestedKeys.size > 0 ? [] : [{ recipe_id: recipe.id, recipe_name: recipe.name || 'Recipe', reason: 'No recipe lines were selected.' }])
      ]
    };
  }

  const changeByIndex = new Map(applicable.map((change) => [change.line_index, change]));
  const nextIngredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map((line, lineIndex) => {
    const change = changeByIndex.get(lineIndex);
    if (!change) return line;
    return {
      ...clearRecipeLineWeight(line),
      quantity: change.proposed_quantity,
      unit: change.proposed_unit
    };
  });

  return {
    recipe: { ...recipe, ingredients: nextIngredients },
    changes: applicable,
    skipped: preview.skipped
  };
}
