import { convertIngredientQuantity } from './ingredientUnits.js';
import { expandRecipeIngredients } from './recipeComposition.js';
import { calculateRecipeCostingSnapshot } from './recipeCosting.js';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, digits = 2) {
  return Number(number(value).toFixed(digits));
}

export function normalizeEventRecipeLinks(links = []) {
  return (Array.isArray(links) ? links : [])
    .filter((link) => link?.recipe_id)
    .map((link) => ({
      recipe_id: String(link.recipe_id),
      recipe_name: String(link.recipe_name || ''),
      course_name: String(link.course_name || link.recipe_name || ''),
      meal_period: String(link.meal_period || 'lunch').toLowerCase(),
      portion_requirement: Math.max(0.01, number(link.portion_requirement, 1)),
      kitchen_station: String(link.kitchen_station || 'Unassigned'),
      production_status: String(link.production_status || 'not_generated')
    }));
}

export function calculateEventPlanningSnapshot(event = {}, recipes = [], ingredients = [], inventory = []) {
  const guests = Math.max(0, number(event.expected_participants ?? event.guest_count));
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe.id), recipe]));
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient]));
  const inventoryByIngredient = new Map();

  inventory
    .filter((row) => !event.site_id || !row.site_id || String(row.site_id) === String(event.site_id))
    .forEach((row) => {
      const key = String(row.ingredient_id || '');
      const ingredient = ingredientMap.get(key) || {};
      const targetUnit = ingredient.unit || row.unit || 'unit';
      const current = inventoryByIngredient.get(key) || { quantity: 0, unit: targetUnit };
      current.quantity += convertIngredientQuantity(number(row.quantity), row.unit || targetUnit, targetUnit, ingredient);
      inventoryByIngredient.set(key, current);
    });

  const requirements = new Map();
  const missingRecipeIds = [];
  const linkedRecipes = normalizeEventRecipeLinks(event.linked_recipes).map((link) => {
    const recipe = recipeMap.get(link.recipe_id);
    const requiredPortions = rounded(guests * link.portion_requirement, 3);
    if (!recipe) {
      missingRecipeIds.push(link.recipe_id);
      return { ...link, required_portions: requiredPortions, item_cost: null, line_cost: null, costing_valid: false };
    }

    const costing = calculateRecipeCostingSnapshot(recipe, ingredients, recipes);
    const itemCost = costing.cost_per_serving;
    const servingsPerBatch = Math.max(1, number(recipe.servings, 1));
    const multiplier = requiredPortions / servingsPerBatch;
    const expanded = expandRecipeIngredients(recipe, recipes, ingredients, { multiplier, aggregate: true });

    expanded.ingredients.forEach((line) => {
      const ingredient = ingredientMap.get(String(line.ingredient_id)) || {};
      const unit = ingredient.unit || line.unit || 'unit';
      const requiredQuantity = convertIngredientQuantity(line.quantity, line.unit || unit, unit, ingredient);
      const key = String(line.ingredient_id);
      const current = requirements.get(key) || {
        ingredient_id: line.ingredient_id,
        ingredient_name: ingredient.name || line.ingredient_name || 'Unnamed ingredient',
        required_quantity: 0,
        unit,
        estimated_unit_cost: number(ingredient.last_cost ?? ingredient.cost_per_unit ?? ingredient.average_cost),
        linked_recipe_ids: new Set()
      };
      current.required_quantity += requiredQuantity;
      current.linked_recipe_ids.add(recipe.id);
      requirements.set(key, current);
    });

    return {
      ...link,
      recipe_name: recipe.name || link.recipe_name,
      course_name: link.course_name || recipe.name,
      required_portions: requiredPortions,
      portion_size_grams: number(recipe.portion_size_grams),
      portion_size: recipe.portion_size || (number(recipe.portion_size_grams) > 0 ? `${number(recipe.portion_size_grams)} g` : 'Not set'),
      batch_yield: number(recipe.batch_yield, recipe.servings || 1),
      item_cost: itemCost,
      line_cost: itemCost === null ? null : rounded(itemCost * requiredPortions),
      costing_valid: costing.has_cost,
      costing_warnings: costing.warnings
    };
  });

  const ingredientRequirements = [...requirements.values()].map((requirement) => {
    const stock = inventoryByIngredient.get(String(requirement.ingredient_id));
    const available = number(stock?.quantity);
    const shortage = Math.max(0, requirement.required_quantity - available);
    return {
      ...requirement,
      required_quantity: rounded(requirement.required_quantity, 4),
      available_stock: rounded(available, 4),
      shortage_quantity: rounded(shortage, 4),
      estimated_procurement_spend: rounded(shortage * requirement.estimated_unit_cost),
      linked_recipe_ids: [...requirement.linked_recipe_ids]
    };
  });

  const completeCosts = linkedRecipes.length > 0 && linkedRecipes.every((link) => link.line_cost !== null);
  const totalEventCost = completeCosts ? rounded(linkedRecipes.reduce((sum, link) => sum + link.line_cost, 0)) : null;
  const eventBudget = number(event.event_budget ?? event.budget_amount);
  const sellingPrice = number(event.selling_price_per_guest);
  const costPerGuest = totalEventCost === null || guests <= 0 ? null : rounded(totalEventCost / guests);
  const averageItemCost = linkedRecipes.length && completeCosts
    ? rounded(linkedRecipes.reduce((sum, link) => sum + number(link.item_cost), 0) / linkedRecipes.length)
    : null;
  const budgetRemaining = totalEventCost === null ? eventBudget : rounded(eventBudget - totalEventCost);
  const procurementSpend = rounded(ingredientRequirements.reduce((sum, item) => sum + item.estimated_procurement_spend, 0));

  const checklist = {
    event_details: Boolean(
      event.event_name
      && (event.event_date || event.plan_date)
      && event.site_id
      && event.event_location
      && event.meal_period
      && event.service_style
      && guests > 0
    ),
    menu_and_costing: linkedRecipes.length > 0 && completeCosts && missingRecipeIds.length === 0,
    budget_check: eventBudget > 0 && totalEventCost !== null && totalEventCost <= eventBudget,
    procurement_plan: Boolean(event.procurement_pr_id),
    production_plan: Array.isArray(event.production_plan_ids) && event.production_plan_ids.length > 0
  };

  return {
    linked_recipes: linkedRecipes,
    ingredient_requirements: ingredientRequirements,
    shortage_items: ingredientRequirements.filter((item) => item.shortage_quantity > 0),
    total_event_cost: totalEventCost,
    cost_per_guest: costPerGuest,
    average_item_cost: averageItemCost,
    budget_amount: eventBudget,
    budget_remaining: budgetRemaining,
    is_over_budget: totalEventCost !== null && eventBudget > 0 && totalEventCost > eventBudget,
    food_cost_percent: sellingPrice > 0 && costPerGuest !== null ? rounded((costPerGuest / sellingPrice) * 100) : null,
    margin_per_guest: sellingPrice > 0 && costPerGuest !== null ? rounded(sellingPrice - costPerGuest) : null,
    estimated_procurement_spend: procurementSpend,
    missing_recipe_ids: [...new Set(missingRecipeIds)],
    checklist,
    ready_to_submit: checklist.event_details && checklist.menu_and_costing
  };
}

export function assertEventReadyForSubmission(event = {}, snapshot = {}) {
  if (!Array.isArray(event.linked_recipes) || event.linked_recipes.length === 0) {
    const error = new Error('Link at least one menu package recipe before submitting the event.');
    error.status = 400;
    throw error;
  }
  if (!snapshot.checklist?.event_details) {
    const error = new Error('Complete the event details before submitting for approval.');
    error.status = 400;
    throw error;
  }
  if (!snapshot.checklist?.menu_and_costing) {
    const error = new Error('All linked recipes must exist and have complete current costing before submission.');
    error.status = 400;
    throw error;
  }
}

export function buildEventProductionPlanPayloads(event = {}, snapshot = {}, recipes = [], ingredients = []) {
  const recipeMap = new Map(recipes.map((recipe) => [String(recipe.id), recipe]));
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient]));
  const requirementMap = new Map((snapshot.ingredient_requirements || []).map((item) => [String(item.ingredient_id), item]));

  return (snapshot.linked_recipes || []).flatMap((link) => {
    const recipe = recipeMap.get(String(link.recipe_id));
    if (!recipe) return [];
    const multiplier = number(link.required_portions) / Math.max(1, number(recipe.servings, 1));
    const expanded = expandRecipeIngredients(recipe, recipes, ingredients, { multiplier, aggregate: true });
    return [{
      production_date: event.event_date || event.plan_date,
      site_id: event.site_id,
      site_name: event.site_name,
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      meal_type: link.meal_period,
      target_servings: number(link.required_portions),
      kitchen_station: link.kitchen_station || event.kitchen_assignment || recipe.kitchen_station || 'Unassigned',
      status: 'planned',
      estimated_cost: number(link.line_cost),
      ingredients_used: expanded.ingredients.map((line) => {
        const ingredient = ingredientMap.get(String(line.ingredient_id)) || {};
        const requirement = requirementMap.get(String(line.ingredient_id));
        return {
          ingredient_id: line.ingredient_id,
          ingredient_name: ingredient.name || line.ingredient_name,
          planned_quantity: number(line.quantity),
          required_quantity: number(line.quantity),
          unit: ingredient.unit || line.unit || 'unit',
          unit_cost: number(requirement?.estimated_unit_cost ?? ingredient.last_cost ?? ingredient.cost_per_unit ?? ingredient.average_cost)
        };
      }),
      source_type: 'special_event',
      source_event_id: event.id,
      source_event_name: event.event_name,
      source_event_recipe_id: recipe.id,
      notes: `Generated from event ${event.event_name}`
    }];
  });
}

export function buildEventPurchaseRequestItems(snapshot = {}, eventName = '') {
  return (snapshot.shortage_items || [])
    .filter((item) => number(item.shortage_quantity) > 0)
    .map((item) => ({
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      description: `Event shortage for ${eventName}`,
      requested_quantity: number(item.shortage_quantity),
      unit: item.unit,
      estimated_unit_price: number(item.estimated_unit_cost)
    }));
}
