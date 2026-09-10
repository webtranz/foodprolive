import { hasAdministratorAccess } from '../shared/bulkUploadAccess.js';
import { normalizeIngredientUnit } from '../shared/ingredientUnits.js';
import {
  clearRecipeLineWeight,
  getRecipeLinePrepExemptPercent,
  getRecipeLineWeight,
  isExemptProcessingAid,
  RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD,
  recipeLineWeightFields,
  recipeLineWeightInUnit
} from '../shared/recipeLineWeight.js';
import { expandRecipeIngredients } from '../shared/recipeComposition.js';

function identity(line) {
  return `${line.ingredient_id || ''}::${normalizeIngredientUnit(line.unit)}`;
}

function fail(message, status) {
  throw Object.assign(new Error(message), { status });
}

function normalizePrepExemptPercent(line = {}) {
  if (isExemptProcessingAid(line)) return null;
  const supplied = line[RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD];
  if (supplied === null || supplied === undefined || supplied === '' || Number(supplied) === 0) return null;
  const numeric = Number(supplied);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 99.99) {
    fail('% exempt during prep must be a number from 1 to 99.99.', 400);
  }
  return Number(numeric.toFixed(2));
}

// Runs for normal entity saves and bulk imports. Never trust client audit fields.
export function prepareRecipeLineWeights(user, lines = [], existingLines = []) {
  const admin = hasAdministratorAccess(user);
  return lines.map((line) => {
    const supplied = line.weight_per_unit_grams;
    const hasValue = supplied !== null && supplied !== undefined && supplied !== '';
    const weight = hasValue ? Number(supplied) : null;
    if (hasValue && (!Number.isFinite(weight) || weight <= 0 || weight > 1e9)) {
      fail('Recipe-line weight must be a positive number of grams, at most 1,000,000,000.', 400);
    }
    if (hasValue && ['g', 'kg'].includes(normalizeIngredientUnit(line.unit))) {
      fail('Gram and kilogram recipe lines already have an exact weight. Use their raw quantity instead.', 400);
    }
    const candidates = existingLines.filter((prior) => identity(prior) === identity(line));
    const unchanged = candidates.find((prior) => getRecipeLineWeight(prior) === weight);
    if (!admin && ((weight !== null && !unchanged) || (weight === null && candidates.some((prior) => getRecipeLineWeight(prior) !== null)))) {
      fail('Only administrators can define, change, or clear recipe-line weights.', 403);
    }
    const clean = clearRecipeLineWeight(line);
    const prepExemptPercent = normalizePrepExemptPercent(line);
    if (prepExemptPercent === null) {
      delete clean[RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD];
    } else {
      clean[RECIPE_LINE_PREP_EXEMPT_PERCENT_FIELD] = prepExemptPercent;
    }
    if (weight === null) return clean;
    if (!line.ingredient_id || !line.unit) fail('Select an ingredient and unit before defining its weight.', 400);
    if (unchanged) return { ...clean, ...recipeLineWeightFields(unchanged) };
    return {
      ...clean,
      weight_per_unit_grams: weight,
      weight_unit: normalizeIngredientUnit(line.unit),
      weight_ingredient_id: String(line.ingredient_id),
      weight_defined_by: String(user?.id || user?.email || 'admin'),
      weight_defined_at: new Date().toISOString()
    };
  });
}

// Production inherits only server-owned recipe definitions (or its existing
// frozen definition). A posted production payload cannot create a new weight.
export function bindProductionRecipeLineWeights(production, recipe, recipes, ingredients, existing = null) {
  const ingredientMap = new Map(ingredients.map((item) => [String(item.id), item]));
  const bind = (lines, definitions, priorLines = []) => lines.map((line) => {
    const clean = clearRecipeLineWeight(line);
    const processingAid = isExemptProcessingAid(line);
    const prepExemptPercent = getRecipeLinePrepExemptPercent(line);
    const prior = priorLines.find((item) => (
      String(item.ingredient_id) === String(line.ingredient_id)
      && isExemptProcessingAid(item) === processingAid
      && getRecipeLinePrepExemptPercent(item) === prepExemptPercent
      && getRecipeLineWeight(item) !== null
    ));
    const definition = prior
      || definitions.find((item) => (
        String(item.ingredient_id) === String(line.ingredient_id)
        && isExemptProcessingAid(item) === processingAid
        && getRecipeLinePrepExemptPercent(item) === prepExemptPercent
      ))
      || definitions.find((item) => String(item.ingredient_id) === String(line.ingredient_id));
    const grams = definition && recipeLineWeightInUnit(definition, ingredientMap.get(String(line.ingredient_id)) || {}, line.unit);
    // Recalculate weights at submission; never accept a client-provided frozen total.
    delete clean.raw_weight_grams;
    delete clean.yielded_weight_grams;
    if (!(grams > 0)) return clean;
    return {
      ...clean,
      weight_per_unit_grams: grams,
      weight_unit: normalizeIngredientUnit(line.unit),
      weight_ingredient_id: String(line.ingredient_id)
    };
  });
  const definitionsFor = (source) => expandRecipeIngredients(source, recipes, ingredients).ingredients;
  let definitions = definitionsFor(recipe);
  let menuItems = production.menu_issue_items;
  if (Array.isArray(menuItems) && menuItems.length) {
    menuItems = menuItems.map((item) => {
      const source = recipes.find((entry) => String(entry.id) === String(item.recipe_id));
      const previous = existing?.menu_issue_items?.find((entry) => entry.key === item.key);
      return {
        ...item,
        ingredients_used: bind(item.ingredients_used || [], source ? definitionsFor(source) : [], previous?.ingredients_used)
      };
    });
    definitions = expandRecipeIngredients({
      ingredients: menuItems.flatMap((item) => item.ingredients_used.map((line) => ({
        ...line, quantity: line.raw_quantity ?? line.planned_quantity ?? line.required_quantity ?? 0
      })))
    }, [], ingredients).ingredients;
  }
  return {
    ...production,
    ...(Array.isArray(menuItems) ? { menu_issue_items: menuItems } : {}),
    ingredients_used: bind(production.ingredients_used || [], definitions, existing?.ingredients_used)
  };
}
