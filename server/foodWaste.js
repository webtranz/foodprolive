const MEAL_SERVICE_SCHEDULE = {
  breakfast: '07:00',
  lunch: '12:00',
  dinner: '19:00'
};

const EDIT_WINDOW_MS = 2 * 60 * 60 * 1000;
const CORE_MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);
const APPROVAL_ONLY_FIELDS = new Set([
  'approval_status',
  'approved_by',
  'approved_at',
  'status'
]);

export function normalizeMealType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CORE_MEAL_TYPES.has(normalized) ? normalized : '';
}

export function getMealServiceSchedule(mealType) {
  const normalized = normalizeMealType(mealType);
  return normalized ? MEAL_SERVICE_SCHEDULE[normalized] : null;
}

export function getMealServiceWindow({ wasteDate, mealType, servedAt = null, now = new Date() }) {
  const normalizedDate = String(wasteDate || '').trim();
  const normalizedMealType = normalizeMealType(mealType);
  if (!normalizedDate || !normalizedMealType) {
    return {
      meal_type: normalizedMealType,
      served_at: null,
      recording_deadline_at: null,
      window_status: 'unknown',
      is_within_recording_window: false,
      can_edit: false,
      message: 'Meal date and meal type are required to determine the recording window.'
    };
  }

  const scheduleTime = getMealServiceSchedule(normalizedMealType);
  const resolvedServedAt = servedAt || `${normalizedDate}T${scheduleTime}:00`;
  const servedAtDate = new Date(resolvedServedAt);
  const currentDate = now instanceof Date ? now : new Date(now);

  if (Number.isNaN(servedAtDate.getTime()) || Number.isNaN(currentDate.getTime())) {
    return {
      meal_type: normalizedMealType,
      served_at: null,
      recording_deadline_at: null,
      window_status: 'unknown',
      is_within_recording_window: false,
      can_edit: false,
      message: 'The meal service window could not be calculated.'
    };
  }

  const deadlineDate = new Date(servedAtDate.getTime() + EDIT_WINDOW_MS);
  let windowStatus = 'closed';
  let message = 'Food waste recording is closed for this meal.';

  if (currentDate < servedAtDate) {
    windowStatus = 'before_service';
    message = 'Food waste can be recorded after the meal service time starts.';
  } else if (currentDate <= deadlineDate) {
    windowStatus = 'open';
    message = 'Food waste recording is open for this meal.';
  }

  return {
    meal_type: normalizedMealType,
    served_at: servedAtDate.toISOString(),
    recording_deadline_at: deadlineDate.toISOString(),
    window_status: windowStatus,
    is_within_recording_window: windowStatus === 'open',
    can_edit: windowStatus === 'open',
    message
  };
}

export function isApprovalOnlyWastePatch(patch = {}) {
  const keys = Object.keys(patch || {});
  return keys.length > 0 && keys.every((key) => APPROVAL_ONLY_FIELDS.has(key));
}

export function decorateFoodWasteRecord(record, now = new Date()) {
  if (!record) return null;
  return {
    ...record,
    ...getMealServiceWindow({
      wasteDate: record.waste_date,
      mealType: record.meal_type,
      servedAt: record.served_at,
      now
    })
  };
}

export function buildFoodWasteMenuPlanSummary(menuPlan, mealType) {
  const normalizedMealType = normalizeMealType(mealType);
  const meals = Array.isArray(menuPlan?.meals)
    ? menuPlan.meals.filter((entry) => normalizeMealType(entry.meal_type) === normalizedMealType)
    : [];

  return {
    id: menuPlan?.id || null,
    plan_date: menuPlan?.plan_date || null,
    site_id: menuPlan?.site_id || null,
    site_name: menuPlan?.site_name || null,
    meal_type: normalizedMealType,
    recipes: meals.map((entry, index) => ({
      id: `${menuPlan?.id || 'menu-plan'}-${normalizedMealType}-${index}`,
      recipe_id: entry.recipe_id || null,
      recipe_name: entry.recipe_name || 'Unnamed recipe',
      expected_servings: Number(entry.expected_servings || 0),
      total_cost: Number(entry.total_cost || 0)
    }))
  };
}
