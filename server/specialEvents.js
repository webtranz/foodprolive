import { normalizeAllergenTags } from '../shared/allergens.js';

function numericMatch(input, fallback = 0) {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function trimString(value) {
  return String(value || '').trim();
}

function normalizeLinkedRecipes(links = [], existingLinks = []) {
  const existingByRecipeId = new Map(
    (Array.isArray(existingLinks) ? existingLinks : [])
      .filter((link) => link?.recipe_id)
      .map((link) => [trimString(link.recipe_id), link])
  );

  return (Array.isArray(links) ? links : [])
    .filter((link) => link?.recipe_id)
    .map((link) => {
      const recipeId = trimString(link.recipe_id);
      const existingLink = existingByRecipeId.get(recipeId);
      return {
        recipe_id: recipeId,
        recipe_name: trimString(link.recipe_name),
        course_name: trimString(link.course_name || link.recipe_name),
        meal_period: trimString(link.meal_period || 'lunch').toLowerCase(),
        portion_requirement: Math.max(0.01, numericMatch(link.portion_requirement, 1)),
        kitchen_station: trimString(link.kitchen_station || 'Unassigned'),
        production_status: trimString(existingLink?.production_status || 'not_generated')
      };
    });
}

export const SPECIAL_EVENT_STATUSES = {
  draft: 'draft',
  pendingApproval: 'pending_approval',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled'
};

export function isSpecialEventPlan(plan) {
  return Boolean(trimString(plan?.event_name));
}

export function summarizeSpecialEventMeals(meals = []) {
  return (Array.isArray(meals) ? meals : []).reduce((summary, meal) => {
    const servings = numericMatch(meal?.expected_servings, 0);
    return {
      total_expected_servings: summary.total_expected_servings + servings,
      total_calories: summary.total_calories + (servings * numericMatch(meal?.calories_per_serving, 0))
    };
  }, {
    total_expected_servings: 0,
    total_calories: 0
  });
}

export function buildSpecialEventMeals(mealTypes = [], expectedParticipants = 0, existingMeals = []) {
  const normalizedParticipants = numericMatch(expectedParticipants, 0);
  const existingByType = new Map(
    (Array.isArray(existingMeals) ? existingMeals : [])
      .filter((meal) => meal?.meal_type)
      .map((meal) => [String(meal.meal_type).toLowerCase(), meal])
  );

  return [...new Set((Array.isArray(mealTypes) ? mealTypes : []).map((mealType) => String(mealType || '').toLowerCase()).filter(Boolean))]
    .map((mealType) => {
      const existing = existingByType.get(mealType);
      return {
        meal_type: mealType,
        recipe_id: existing?.recipe_id || '',
        recipe_name: existing?.recipe_name || '',
        expected_servings: numericMatch(existing?.expected_servings, normalizedParticipants || numericMatch(existing?.expected_servings, 0)),
        cost_per_serving: numericMatch(existing?.cost_per_serving, 0),
        total_cost: numericMatch(existing?.total_cost, 0),
        calories_per_serving: numericMatch(existing?.calories_per_serving, 0),
        protein_per_serving: numericMatch(existing?.protein_per_serving, 0),
        carbs_per_serving: numericMatch(existing?.carbs_per_serving, 0),
        fat_per_serving: numericMatch(existing?.fat_per_serving, 0),
        sodium_per_serving: numericMatch(existing?.sodium_per_serving, 0),
        sugar_per_serving: numericMatch(existing?.sugar_per_serving, 0),
        allergens: normalizeAllergenTags(existing?.allergens)
      };
    });
}

export function buildSpecialEventWritePayload(body = {}, existing = null) {
  const expectedParticipants = numericMatch(
    body.expected_participants ?? body.total_expected_servings ?? existing?.expected_participants ?? existing?.total_expected_servings,
    0
  );
  const explicitMealTypes = Array.isArray(body.meal_types) && body.meal_types.length > 0
    ? body.meal_types
    : (Array.isArray(existing?.meals) ? existing.meals.map((meal) => meal.meal_type) : []);
  const meals = buildSpecialEventMeals(explicitMealTypes, expectedParticipants, body.meals ?? existing?.meals ?? []);
  const summary = summarizeSpecialEventMeals(meals);
  const estimatedCost = numericMatch(
    body.estimated_cost ?? body.total_planned_cost ?? existing?.estimated_cost ?? existing?.total_planned_cost,
    0
  );
  const eventDate = trimString(body.event_date || body.plan_date || existing?.event_date || existing?.plan_date);

  return {
    ...body,
    event_name: trimString(body.event_name || existing?.event_name),
    plan_date: eventDate,
    event_date: eventDate,
    status: trimString(body.status || existing?.status || SPECIAL_EVENT_STATUSES.draft),
    meals,
    total_expected_servings: expectedParticipants || numericMatch(summary.total_expected_servings, 0),
    expected_participants: expectedParticipants || numericMatch(summary.total_expected_servings, 0),
    total_calories: numericMatch(summary.total_calories, 0),
    estimated_cost: estimatedCost,
    total_planned_cost: estimatedCost,
    event_location: trimString(body.event_location ?? existing?.event_location),
    meal_period: trimString(body.meal_period ?? existing?.meal_period ?? explicitMealTypes[0] ?? 'lunch').toLowerCase(),
    menu_package_name: trimString(body.menu_package_name ?? existing?.menu_package_name ?? 'Custom menu package'),
    linked_recipes: normalizeLinkedRecipes(
      body.linked_recipes ?? existing?.linked_recipes,
      existing?.linked_recipes
    ),
    event_budget: numericMatch(body.event_budget ?? existing?.event_budget ?? body.budget_amount ?? existing?.budget_amount, 0),
    selling_price_per_guest: numericMatch(body.selling_price_per_guest ?? existing?.selling_price_per_guest, 0),
    prep_start_date: trimString(body.prep_start_date ?? existing?.prep_start_date),
    kitchen_assignment: trimString(body.kitchen_assignment ?? existing?.kitchen_assignment),
    production_plan_status: trimString(existing?.production_plan_status || 'not_generated'),
    production_plan_ids: Array.isArray(existing?.production_plan_ids) ? [...existing.production_plan_ids] : [],
    production_generated_at: existing?.production_generated_at ?? null,
    production_generated_by: existing?.production_generated_by ?? null,
    production_generated_by_name: existing?.production_generated_by_name ?? null,
    procurement_pr_status: trimString(existing?.procurement_pr_status || 'not_created'),
    procurement_pr_id: existing?.procurement_pr_id ?? null,
    procurement_pr_number: existing?.procurement_pr_number ?? null,
    procurement_generated_at: existing?.procurement_generated_at ?? null,
    procurement_generated_by: existing?.procurement_generated_by ?? null,
    procurement_generated_by_name: existing?.procurement_generated_by_name ?? null,
    event_duration_hours: numericMatch(body.event_duration_hours ?? existing?.event_duration_hours, 1),
    consumption_per_person_g: numericMatch(body.consumption_per_person_g ?? existing?.consumption_per_person_g, 550),
    buffer_percent: numericMatch(body.buffer_percent ?? existing?.buffer_percent, 10),
    total_food_kg: numericMatch(body.total_food_kg ?? existing?.total_food_kg, 0),
    budget_source: body.budget_source ?? existing?.budget_source ?? 'linked',
    budget_id: body.budget_id ?? existing?.budget_id ?? null,
    budget_name: body.budget_name ?? existing?.budget_name ?? null,
    budget_amount: numericMatch(body.budget_amount ?? existing?.budget_amount, 0),
    remaining_budget: numericMatch(body.remaining_budget ?? existing?.remaining_budget, 0),
    exceeded_budget_by: numericMatch(body.exceeded_budget_by ?? existing?.exceeded_budget_by, 0),
    approval_history: Array.isArray(existing?.approval_history) ? existing.approval_history : []
  };
}

export function createApprovalHistoryEntry({ action, fromStatus, toStatus, actor, note }) {
  return {
    action,
    from_status: fromStatus || null,
    to_status: toStatus || null,
    actor_email: actor?.email || null,
    actor_name: actor?.full_name || actor?.email || null,
    note: trimString(note) || null,
    timestamp: new Date().toISOString()
  };
}

export function appendApprovalHistory(existingHistory = [], entry) {
  return [
    ...(Array.isArray(existingHistory) ? existingHistory : []),
    entry
  ];
}

export function assertSpecialEventBudgetApproval(record, budgetContext) {
  if (!budgetContext?.linked_budget) {
    const error = new Error('A linked budget is required before a special event can be approved.');
    error.status = 400;
    throw error;
  }

  if (budgetContext.budget_comparison?.is_over_budget) {
    const error = new Error('Special event cost exceeds the available budget and cannot be approved.');
    error.status = 400;
    throw error;
  }

  if (numericMatch(record?.estimated_cost ?? record?.total_planned_cost, 0) <= 0) {
    const error = new Error('Estimated event cost is required before approval.');
    error.status = 400;
    throw error;
  }
}
