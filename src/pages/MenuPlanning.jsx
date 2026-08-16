import React, { useEffect, useMemo, useState } from 'react';
import { addDays, eachDayOfInterval, format, startOfWeek } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import AsyncStatePanel from '@/components/ui/AsyncStatePanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Calendar, ChevronLeft, ChevronRight, GripVertical, Plus, RefreshCw, Save, ShoppingCart, Trash2, Users } from 'lucide-react';
import { formatCurrency } from '@/lib/currency';
import { usePermissions } from '@/components/auth/usePermissions';
import {
  buildDailyMenuState,
  buildMenuPlanMeals,
  calculateRecipeCostSnapshot,
  computeBudgetComparison,
  computeMealBudgetStatus,
  CORE_MENU_MEAL_TYPES,
  createEmptyMealEntry,
  createMealEntryFromRecipe,
  createEmptyDailyMenuState,
  hasMenuCalendarChanges,
  moveMealEntry,
  reorderMealEntries,
  summarizeDailyMenuCosts,
  summarizeMenuCalendarDay,
  summarizeMenuPlanMeals,
  validateDailyMenuState
} from '@/lib/menuPlanning';

const MEAL_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner'
};

const MEAL_BADGES = {
  breakfast: 'bg-amber-100 text-amber-700 border-amber-200',
  lunch: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  dinner: 'bg-blue-100 text-blue-700 border-blue-200'
};

function recipeMatchesSite(recipe, siteId) {
  if (!siteId) {
    return true;
  }

  if (!recipe.site_scope || recipe.site_scope === 'global') {
    return true;
  }

  return Array.isArray(recipe.site_ids) && recipe.site_ids.includes(siteId);
}

function isOperationalMenuPlan(plan) {
  return !String(plan?.event_name || '').trim();
}

function getMealDroppableId(mealType) {
  return `meal-${mealType}`;
}

function parseMealDroppableId(droppableId) {
  return droppableId.startsWith('meal-') ? droppableId.replace('meal-', '') : null;
}

function getGeneratedPRNumber(run) {
  return run?.generated_pr_number || run?.generated_request_number || '';
}

export default function MenuPlanning() {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [currentWeekStart, setCurrentWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [formData, setFormData] = useState(createEmptyDailyMenuState());
  const [selectedBudgetId, setSelectedBudgetId] = useState('');
  const [manualBudgetName, setManualBudgetName] = useState('');
  const [manualBudgetAmount, setManualBudgetAmount] = useState('');
  const [mealBudgetLimits, setMealBudgetLimits] = useState({
    breakfast: '',
    lunch: '',
    dinner: ''
  });
  const [prScheduleConfig, setPrScheduleConfig] = useState({
    cycle_days: '7',
    preferred_weekday: 'thursday',
    is_active: true
  });
  const [prScheduleNotes, setPrScheduleNotes] = useState('');
  const [message, setMessage] = useState('');

  const {
    data: sites = [],
    isLoading: sitesLoading,
    error: sitesError
  } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const {
    data: recipes = [],
    isLoading: recipesLoading,
    error: recipesError
  } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const {
    data: ingredients = [],
    isLoading: ingredientsLoading,
    error: ingredientsError
  } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const weekStartKey = format(currentWeekStart, 'yyyy-MM-dd');
  const {
    data: weekPlanResponse,
    isLoading: menuPlansLoading,
    error: menuPlansError
  } = useQuery({
    queryKey: ['menuPlansByWeek', selectedSite, weekStartKey],
    queryFn: () => base44.menuPlanning.getWeek(selectedSite, weekStartKey),
    enabled: !!selectedSite
  });

  const {
    data: selectedPlanResponse,
    isLoading: selectedPlanLoading,
    error: selectedPlanError
  } = useQuery({
    queryKey: ['menuPlanByDate', selectedSite, selectedDate],
    queryFn: () => base44.menuPlanning.getByDate(selectedSite, selectedDate),
    enabled: !!selectedSite && !!selectedDate
  });

  const {
    data: prGenerationContext,
    isLoading: prGenerationLoading
  } = useQuery({
    queryKey: ['menuPlanPRGeneration', selectedSite, selectedDate],
    queryFn: () => base44.menuPlanning.getPRGenerationContext(selectedSite, selectedDate),
    enabled: !!selectedSite && !!selectedDate
  });

  const selectedPlan = selectedPlanResponse?.plan || null;
  const autoLinkedBudget = selectedPlanResponse?.linked_budget || null;
  const budgetCandidates = Array.isArray(selectedPlanResponse?.budget_candidates) ? selectedPlanResponse.budget_candidates : [];

  const createMutation = useMutation({
    mutationFn: (payload) => base44.menuPlanning.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlansByWeek'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
      setMessage('Menu plan saved successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to save menu plan')
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => base44.menuPlanning.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlansByWeek'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
      setMessage('Menu plan updated successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to update menu plan')
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.menuPlanning.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlansByWeek'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
      setFormData(createEmptyDailyMenuState());
      setMessage('Menu plan cleared for the selected date.');
    },
    onError: (error) => setMessage(error.message || 'Failed to clear menu plan')
  });

  const savePRConfigMutation = useMutation({
    mutationFn: (payload) => base44.menuPlanning.savePRGenerationConfig(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlanPRGeneration'] });
      setMessage('PR generation schedule updated successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to update PR generation schedule')
  });

  const runPRGenerationMutation = useMutation({
    mutationFn: (payload) => base44.menuPlanning.runPRGeneration(payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['menuPlanPRGeneration'] });
      queryClient.invalidateQueries({ queryKey: ['procurementRequests'] });
      if (result?.duplicate_prevented) {
        setMessage(`PR already exists for cycle ${result?.run?.cycle_start} to ${result?.run?.cycle_end}. Duplicate generation was prevented.`);
        return;
      }
      setMessage(`PR ${result?.purchase_request?.request_number || getGeneratedPRNumber(result?.run) || ''} generated successfully for the next menu planning cycle.`);
    },
    onError: (error) => setMessage(error.message || 'Failed to generate PR')
  });

  useEffect(() => {
    setCurrentWeekStart(startOfWeek(new Date(selectedDate), { weekStartsOn: 1 }));
  }, [selectedDate]);

  useEffect(() => {
    setFormData(buildDailyMenuState(selectedPlan));
  }, [selectedPlan]);

  useEffect(() => {
    setSelectedBudgetId(
      selectedPlan?.budget_source === 'manual'
        ? 'manual'
        : (selectedPlan?.budget_id || autoLinkedBudget?.id || '')
    );
    setManualBudgetName(selectedPlan?.manual_budget_name || '');
    setManualBudgetAmount(selectedPlan?.budget_source === 'manual' && Number(selectedPlan?.budget_amount) > 0
      ? String(selectedPlan.budget_amount)
      : '');
    setMealBudgetLimits({
      breakfast: selectedPlan?.meal_budget_limits?.breakfast ? String(selectedPlan.meal_budget_limits.breakfast) : '',
      lunch: selectedPlan?.meal_budget_limits?.lunch ? String(selectedPlan.meal_budget_limits.lunch) : '',
      dinner: selectedPlan?.meal_budget_limits?.dinner ? String(selectedPlan.meal_budget_limits.dinner) : ''
    });
  }, [selectedPlan, autoLinkedBudget?.id]);

  useEffect(() => {
    const schedule = prGenerationContext?.schedule;
    if (!schedule) {
      return;
    }

    setPrScheduleConfig({
      cycle_days: String(schedule.cycle_days || 7),
      preferred_weekday: schedule.preferred_weekday || 'thursday',
      is_active: schedule.is_active !== false
    });
    setPrScheduleNotes(schedule.notes || '');
  }, [prGenerationContext?.schedule]);

  const operationalPlans = useMemo(() => (
    (Array.isArray(weekPlanResponse?.plans) ? weekPlanResponse.plans : [])
      .filter((plan) => plan.site_id === selectedSite)
      .filter(isOperationalMenuPlan)
  ), [weekPlanResponse?.plans, selectedSite]);

  const selectedSiteRecord = useMemo(
    () => sites.find((site) => site.id === selectedSite) || null,
    [sites, selectedSite]
  );

  const additionalMeals = useMemo(() => (
    (Array.isArray(selectedPlan?.meals) ? selectedPlan.meals : [])
      .filter((meal) => !CORE_MENU_MEAL_TYPES.includes(meal.meal_type))
  ), [selectedPlan]);

  const availableRecipes = useMemo(() => (
    recipes.filter((recipe) => recipeMatchesSite(recipe, selectedSite))
  ), [recipes, selectedSite]);

  const sortedAvailableRecipes = useMemo(() => (
    [...availableRecipes].sort((left, right) => {
      const leftCategory = String(left.category || '');
      const rightCategory = String(right.category || '');
      if (leftCategory !== rightCategory) {
        return leftCategory.localeCompare(rightCategory);
      }
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
  ), [availableRecipes]);

  const costSummary = useMemo(
    () => summarizeDailyMenuCosts(formData, availableRecipes, ingredients),
    [formData, availableRecipes, ingredients]
  );

  const selectedBudget = useMemo(() => {
    if (selectedBudgetId === 'manual') {
      return {
        id: null,
        name: manualBudgetName || 'Manual Budget',
        budget_amount: Number(manualBudgetAmount) > 0 ? Number(manualBudgetAmount) : 0,
        currency: 'SAR',
        scope_type: 'manual',
        start_date: selectedDate,
        end_date: selectedDate
      };
    }
    if (selectedBudgetId) {
      return budgetCandidates.find((budget) => budget.id === selectedBudgetId) || autoLinkedBudget || null;
    }
    return autoLinkedBudget || null;
  }, [selectedBudgetId, budgetCandidates, autoLinkedBudget, manualBudgetAmount, manualBudgetName, selectedDate]);

  const budgetComparison = useMemo(
    () => computeBudgetComparison(selectedBudget?.budget_amount || 0, costSummary.total_cost),
    [selectedBudget?.budget_amount, costSummary.total_cost]
  );

  const mealBudgetStatuses = useMemo(() => ({
    breakfast: computeMealBudgetStatus(mealBudgetLimits.breakfast, costSummary.breakfast.total_cost),
    lunch: computeMealBudgetStatus(mealBudgetLimits.lunch, costSummary.lunch.total_cost),
    dinner: computeMealBudgetStatus(mealBudgetLimits.dinner, costSummary.dinner.total_cost)
  }), [mealBudgetLimits, costSummary]);

  const weekDays = useMemo(() => eachDayOfInterval({
    start: currentWeekStart,
    end: addDays(currentWeekStart, 6)
  }), [currentWeekStart]);

  const getPlanForDay = (date) => {
    const dayKey = format(date, 'yyyy-MM-dd');
    return operationalPlans.find((plan) => plan.plan_date === dayKey);
  };

  const getCalendarDaySummary = (date) => {
    const dayKey = format(date, 'yyyy-MM-dd');
    const plan = getPlanForDay(date);
    const isSelected = dayKey === selectedDate;
    return {
      plan,
      isSelected,
      isLoading: isSelected && selectedPlanLoading,
      hasUnsavedChanges: isSelected
        && !selectedPlanLoading
        && hasMenuCalendarChanges(formData, selectedPlan),
      summary: summarizeMenuCalendarDay({
        plan,
        formState: isSelected && !selectedPlanLoading ? formData : null,
        recipes: availableRecipes
      })
    };
  };

  const prSchedule = prGenerationContext?.schedule || null;
  const prCurrentCycleRun = prGenerationContext?.current_cycle_run || null;
  const prRecentRuns = Array.isArray(prGenerationContext?.recent_runs) ? prGenerationContext.recent_runs.slice(0, 5) : [];
  const bootstrapError = sitesError || recipesError || ingredientsError || menuPlansError || selectedPlanError;
  const bootstrapLoading = sitesLoading || recipesLoading || ingredientsLoading || (Boolean(selectedSite) && menuPlansLoading);

  const getRecipesForMeal = (mealType) => (
    [...availableRecipes].sort((left, right) => {
      const leftScore = left.category === mealType ? 0 : 1;
      const rightScore = right.category === mealType ? 0 : 1;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
  );

  const setMealValue = (mealType, index, field, value) => {
    setFormData((current) => ({
      ...current,
      [mealType]: (Array.isArray(current[mealType]) ? current[mealType] : []).map((entry, entryIndex) => (
        entryIndex === index
          ? {
              ...entry,
              [field]: value
            }
          : entry
      ))
    }));
  };

  const addMealRow = (mealType) => {
    setFormData((current) => ({
      ...current,
      [mealType]: [...(Array.isArray(current[mealType]) ? current[mealType] : []), createEmptyMealEntry()]
    }));
  };

  const removeMealRow = (mealType, index) => {
    setFormData((current) => {
      const rows = Array.isArray(current[mealType]) ? current[mealType] : [];
      const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
      return {
        ...current,
        [mealType]: nextRows.length > 0 ? nextRows : [createEmptyMealEntry()]
      };
    });
  };

  const setMealBudgetLimit = (mealType, value) => {
    setMealBudgetLimits((current) => ({
      ...current,
      [mealType]: value
    }));
  };

  const handleDragEnd = (result) => {
    const { source, destination } = result;
    if (!destination) {
      return;
    }

    const sourceMealType = parseMealDroppableId(source.droppableId);
    const destinationMealType = parseMealDroppableId(destination.droppableId);

    if (source.droppableId === 'available-recipes' && destinationMealType) {
      const recipe = sortedAvailableRecipes[source.index];
      if (!recipe) {
        return;
      }

      const destinationRows = Array.isArray(formData[destinationMealType]) ? formData[destinationMealType] : [];
      if (destinationRows.some((row) => row.recipe_id === recipe.id)) {
        setMessage(`${recipe.name} is already planned for ${MEAL_LABELS[destinationMealType]}.`);
        return;
      }

      const nextRows = [...destinationRows];
      const hasOnlyPlaceholder = nextRows.length === 1 && !nextRows[0].recipe_id && !nextRows[0].expected_servings;
      const insertAt = Math.min(destination.index, hasOnlyPlaceholder ? 0 : nextRows.length);
      if (hasOnlyPlaceholder) {
        nextRows.splice(0, 1);
      }
      nextRows.splice(insertAt, 0, createMealEntryFromRecipe(recipe));
      setFormData((current) => ({
        ...current,
        [destinationMealType]: nextRows
      }));
      setMessage('');
      return;
    }

    if (sourceMealType && destinationMealType) {
      const sourceRows = Array.isArray(formData[sourceMealType]) ? formData[sourceMealType] : [];
      const movedRow = sourceRows[source.index];
      if (!movedRow) {
        return;
      }

      if (
        sourceMealType !== destinationMealType &&
        (Array.isArray(formData[destinationMealType]) ? formData[destinationMealType] : []).some(
          (row) => row.recipe_id === movedRow.recipe_id && row.recipe_id
        )
      ) {
        const recipe = availableRecipes.find((entry) => entry.id === movedRow.recipe_id);
        setMessage(`${recipe?.name || 'This recipe'} is already planned for ${MEAL_LABELS[destinationMealType]}.`);
        return;
      }

      setFormData((current) => {
        if (sourceMealType === destinationMealType) {
          return {
            ...current,
            [sourceMealType]: reorderMealEntries(sourceRows, source.index, destination.index)
          };
        }

        return moveMealEntry(current, sourceMealType, destinationMealType, source.index, destination.index);
      });
      setMessage('');
    }
  };

  const handleSave = async () => {
    setMessage('');

    if (!selectedSiteRecord) {
      setMessage('Select a project first.');
      return;
    }

    const errors = validateDailyMenuState(formData);
    if (errors.length > 0) {
      setMessage(errors[0]);
      return;
    }

    if (selectedBudgetId === 'manual' && !(Number(manualBudgetAmount) > 0)) {
      setMessage('Enter a valid manual budget amount to use manual budget mode.');
      return;
    }

    const meals = buildMenuPlanMeals(formData, availableRecipes, ingredients, selectedPlan);
    const summary = summarizeMenuPlanMeals(meals);
    const payload = {
      site_id: selectedSiteRecord.id,
      site_name: selectedSiteRecord.name,
      plan_date: selectedDate,
      meals,
      status: selectedPlan?.status || 'planned',
      total_expected_servings: summary.total_expected_servings,
      total_calories: summary.total_calories,
      total_planned_cost: summary.total_planned_cost,
      budget_source: selectedBudgetId === 'manual' ? 'manual' : 'linked',
      budget_id: selectedBudgetId === 'manual' ? null : (selectedBudget?.id || null),
      budget_name: selectedBudget?.name || null,
      manual_budget_name: selectedBudgetId === 'manual' ? (manualBudgetName || 'Manual Budget') : null,
      budget_amount: selectedBudget?.budget_amount || 0,
      meal_budget_limits: {
        breakfast: Number(mealBudgetLimits.breakfast) > 0 ? Number(mealBudgetLimits.breakfast) : 0,
        lunch: Number(mealBudgetLimits.lunch) > 0 ? Number(mealBudgetLimits.lunch) : 0,
        dinner: Number(mealBudgetLimits.dinner) > 0 ? Number(mealBudgetLimits.dinner) : 0
      },
      remaining_budget: budgetComparison.remaining_budget,
      exceeded_budget_by: budgetComparison.exceeded_amount
    };

    if (selectedPlan?.id) {
      await updateMutation.mutateAsync({ id: selectedPlan.id, payload });
      return;
    }

    await createMutation.mutateAsync(payload);
  };

  const handleClearPlan = async () => {
    setMessage('');
    if (!selectedPlan?.id) {
      setFormData(createEmptyDailyMenuState());
      setMessage('There is no saved menu plan for this date yet.');
      return;
    }
    await deleteMutation.mutateAsync(selectedPlan.id);
  };

  const handleSavePRConfig = async () => {
    if (!selectedSiteRecord) {
      setMessage('Select a project first.');
      return;
    }

    await savePRConfigMutation.mutateAsync({
      site_id: selectedSiteRecord.id,
      site_name: selectedSiteRecord.name,
      cycle_days: prScheduleConfig.cycle_days,
      preferred_weekday: prScheduleConfig.preferred_weekday,
      is_active: prScheduleConfig.is_active,
      notes: prScheduleNotes
    });
  };

  const handleRunPRGeneration = async () => {
    if (!selectedSiteRecord) {
      setMessage('Select a project first.');
      return;
    }

    await runPRGenerationMutation.mutateAsync({
      site_id: selectedSiteRecord.id,
      site_name: selectedSiteRecord.name,
      reference_date: selectedDate,
      trigger_type: 'manual'
    });
  };

  const navigateWeek = (direction) => {
    const nextDate = addDays(currentWeekStart, direction * 7);
    setCurrentWeekStart(nextDate);
    setSelectedDate(format(nextDate, 'yyyy-MM-dd'));
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <PageHeader
          title="Menu Planning"
          description="Plan breakfast, lunch, and dinner by date using the weekly calendar and daily menu editor."
        >
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[250px] bg-white">
              <SelectValue placeholder="Select project / location" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((site) => (
                <SelectItem key={site.id} value={site.id}>
                  {site.hierarchy_path || site.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PageHeader>

        {message ? (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{message}</span>
          </div>
        ) : null}

        {bootstrapError ? (
          <AsyncStatePanel
            variant="error"
            title="Menu Planning Could Not Load"
            description={bootstrapError.message || 'Some planning data could not be loaded. Refresh the page or try again in a moment.'}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ['sites'] });
                  queryClient.invalidateQueries({ queryKey: ['recipes'] });
                  queryClient.invalidateQueries({ queryKey: ['ingredients'] });
                  queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
                  queryClient.invalidateQueries({ queryKey: ['menuPlansByWeek'] });
                  queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry Loading
              </Button>
            }
          />
        ) : bootstrapLoading ? (
          <AsyncStatePanel
            variant="loading"
            title="Loading Menu Planning Workspace"
            description="Fetching projects, recipes, ingredients, and saved plans for the current planning cycle."
          />
        ) : !selectedSite ? (
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-12 text-center">
              <Calendar className="mx-auto mb-4 h-16 w-16 text-slate-300" />
              <h3 className="mb-2 text-lg font-semibold text-slate-700">Select a Project</h3>
              <p className="text-slate-500">Choose a project or kitchen to start planning menus date-wise.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {availableRecipes.length === 0 ? (
              <AsyncStatePanel
                variant="empty"
                title="No Recipes Available For This Project"
                description="This project does not currently have any recipes in scope. Add or assign recipes first, then return to build Breakfast, Lunch, and Dinner plans."
              />
            ) : null}

            <Card className="border-slate-100 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="text-lg">Calendar Planning View</CardTitle>
                    <p className="mt-1 text-sm text-slate-500">Select a date to create or edit Breakfast, Lunch, and Dinner for that day.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => navigateWeek(-1)}>
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      Previous
                    </Button>
                    <Button variant="outline" onClick={() => navigateWeek(1)}>
                      Next
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
                  <div>
                    <Label htmlFor="selectedDate">Planning Date</Label>
                    <Input
                      id="selectedDate"
                      type="date"
                      className="mt-2 bg-white"
                      value={selectedDate}
                      onChange={(event) => setSelectedDate(event.target.value)}
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      Existing menu planning data for the selected date loads automatically.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
                    {weekDays.map((day) => {
                      const dayKey = format(day, 'yyyy-MM-dd');
                      const {
                        plan,
                        isSelected,
                        isLoading,
                        hasUnsavedChanges,
                        summary
                      } = getCalendarDaySummary(day);
                      const savedStatus = String(plan?.status || 'planned').trim().replace(/_/g, ' ');
                      const statusText = isLoading
                        ? 'Loading menu…'
                        : !summary.has_core_meals && hasUnsavedChanges
                          ? 'Unsaved changes · no meals'
                          : !summary.has_core_meals
                          ? 'No core meals planned'
                          : summary.incomplete_items > 0
                            ? `${summary.incomplete_items} item${summary.incomplete_items === 1 ? '' : 's'} need details`
                            : hasUnsavedChanges
                              ? `${summary.total_recipes} recipe${summary.total_recipes === 1 ? '' : 's'} ready to save`
                              : `${savedStatus} · ${summary.total_expected_servings} servings`;

                      return (
                        <button
                          key={dayKey}
                          type="button"
                          onClick={() => setSelectedDate(dayKey)}
                          className={`rounded-2xl border p-3 text-left transition-all ${isSelected ? 'border-emerald-400 bg-emerald-50 shadow-sm' : 'border-slate-200 bg-white hover:border-emerald-200'}`}
                        >
                          <p className="text-xs uppercase text-slate-500">{format(day, 'EEE')}</p>
                          <p className={`text-lg font-bold ${isSelected ? 'text-emerald-700' : 'text-slate-900'}`}>{format(day, 'd')}</p>
                          <div className="mt-2 space-y-1">
                            {CORE_MENU_MEAL_TYPES.map((mealType) => {
                              const mealSummary = summary.meals[mealType];
                              return mealSummary.item_count > 0 ? (
                                <div key={mealType} className={`rounded-lg border px-2 py-1 text-[11px] ${MEAL_BADGES[mealType]}`}>
                                  <p className="font-medium">{MEAL_LABELS[mealType]}</p>
                                  <p className="truncate">
                                    {mealSummary.recipe_count === 1 && mealSummary.item_count === 1
                                      ? (mealSummary.entries[0].recipe_name || 'Recipe selected')
                                      : mealSummary.incomplete_count > 0
                                        ? `${mealSummary.item_count} item${mealSummary.item_count === 1 ? '' : 's'} · ${mealSummary.incomplete_count} incomplete`
                                        : `${mealSummary.recipe_count} recipes planned`}
                                  </p>
                                </div>
                              ) : null;
                            })}
                            <p className={`pt-2 text-center text-[11px] ${
                              isLoading
                                ? 'text-slate-400'
                                : summary.incomplete_items > 0 || hasUnsavedChanges
                                  ? 'font-medium text-amber-700'
                                  : summary.has_core_meals
                                    ? 'font-medium capitalize text-emerald-700'
                                    : 'text-slate-400'
                            }`}>{statusText}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-100 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <CardTitle className="text-lg">
                      {format(new Date(selectedDate), 'EEEE, MMM d, yyyy')}
                    </CardTitle>
                    <p className="mt-1 text-sm text-slate-500">
                      {selectedPlanLoading
                        ? 'Loading existing menu plan...'
                        : selectedPlan
                          ? 'Existing menu plan loaded for the selected date.'
                          : 'Create a new menu plan for the selected date.'}
                    </p>
                  </div>
                  {selectedPlan ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="capitalize">
                        {String(selectedPlan.status || 'planned').replace(/_/g, ' ')}
                      </Badge>
                      <Badge variant="outline">
                        {selectedPlan.total_expected_servings || 0} servings
                      </Badge>
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {additionalMeals.length > 0 ? (
                  <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                    Additional meals for this date are being preserved automatically:
                    <div className="mt-2 flex flex-wrap gap-2">
                      {additionalMeals.map((meal, index) => (
                        <Badge key={`${meal.meal_type}-${index}`} variant="outline" className="border-blue-200 bg-white text-blue-700">
                          {meal.meal_type}: {meal.recipe_name || 'Unnamed meal'}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className={`rounded-2xl border p-4 ${budgetComparison.is_over_budget ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50/60'}`}>
                  <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
                    <div>
                      <Label>Linked Budget</Label>
                      <Select value={selectedBudgetId || 'auto'} onValueChange={(value) => setSelectedBudgetId(value === 'auto' ? '' : value)}>
                        <SelectTrigger className="mt-2 bg-white">
                          <SelectValue placeholder="Auto-link budget" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto-link applicable budget</SelectItem>
                          <SelectItem value="manual">Manual budget entry</SelectItem>
                          {budgetCandidates.map((budget) => (
                            <SelectItem key={budget.id} value={budget.id}>
                              {budget.name} · {formatCurrency(budget.budget_amount || 0)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedBudgetId === 'manual' ? (
                        <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                          <div>
                            <Label htmlFor="manualBudgetName">Manual Budget Name</Label>
                            <Input
                              id="manualBudgetName"
                              className="mt-2 bg-white"
                              value={manualBudgetName}
                              onChange={(event) => setManualBudgetName(event.target.value)}
                              placeholder="Daily food budget"
                            />
                          </div>
                          <div>
                            <Label htmlFor="manualBudgetAmount">Manual Budget Amount</Label>
                            <Input
                              id="manualBudgetAmount"
                              type="number"
                              min="0"
                              className="mt-2 bg-white"
                              value={manualBudgetAmount}
                              onChange={(event) => setManualBudgetAmount(event.target.value)}
                              placeholder="Enter budget amount"
                            />
                          </div>
                        </div>
                      ) : null}
                      <p className="mt-2 text-xs text-slate-500">
                        {selectedBudget
                          ? `Active budget window: ${selectedBudget.start_date} to ${selectedBudget.end_date}`
                          : 'No active budget was found for this project and date.'}
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <p className="text-xs uppercase text-slate-500">Budget</p>
                        <p className="mt-1 text-lg font-semibold text-slate-900">
                          {formatCurrency(budgetComparison.budget_amount)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {selectedBudget?.name || 'No budget linked'}
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <p className="text-xs uppercase text-slate-500">Planned Cost</p>
                        <p className={`mt-1 text-lg font-semibold ${budgetComparison.is_over_budget ? 'text-red-700' : 'text-emerald-700'}`}>
                          {formatCurrency(budgetComparison.planned_cost)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">Real-time from selected recipes and servings</p>
                        {budgetComparison.is_over_budget ? (
                          <span className="sr-only">Planned cost is over the allowed budget.</span>
                        ) : null}
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <p className="text-xs uppercase text-slate-500">{budgetComparison.is_over_budget ? 'Exceeded By' : 'Remaining Budget'}</p>
                        <p className={`mt-1 text-lg font-semibold ${budgetComparison.is_over_budget ? 'text-red-700' : 'text-slate-900'}`}>
                          {formatCurrency(budgetComparison.is_over_budget ? budgetComparison.exceeded_amount : budgetComparison.remaining_budget)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {budgetComparison.is_over_budget ? 'Planned menu is over budget.' : 'Available amount after this menu plan.'}
                        </p>
                      </div>
                      <div className={`rounded-xl border px-4 py-3 ${budgetComparison.is_over_budget ? 'border-red-200 bg-red-100/70' : 'border-emerald-200 bg-emerald-100/70'}`}>
                        <p className="text-xs uppercase text-slate-500">Budget Status</p>
                        <p className={`mt-1 text-lg font-semibold ${budgetComparison.is_over_budget ? 'text-red-700' : 'text-emerald-700'}`}>
                          {budgetComparison.is_over_budget ? 'Over Budget' : 'Within Budget'}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {selectedBudget
                            ? `${selectedBudget.scope_type || 'site_period'} budget`
                            : 'Link a budget to compare spending.'}
                        </p>
                      </div>
                    </div>
                  </div>
                  {selectedBudget && budgetComparison.is_over_budget ? (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-white px-4 py-3 text-sm text-red-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      <span>
                        Planned food cost exceeds the linked budget by {formatCurrency(budgetComparison.exceeded_amount)}. Review recipes or servings before saving.
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">PR Generation</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        Generate a PR from the next 7-day menu cycle. Thursday is the preferred generation day, and duplicate PRs are blocked automatically.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {can('generate_menu_plan_pr') ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleSavePRConfig}
                          disabled={!selectedSiteRecord || savePRConfigMutation.isPending}
                        >
                          <Save className="mr-2 h-4 w-4" />
                          Save Schedule
                        </Button>
                      ) : null}
                      {can('generate_menu_plan_pr') ? (
                        <Button
                          type="button"
                          onClick={handleRunPRGeneration}
                          disabled={!selectedSiteRecord || runPRGenerationMutation.isPending}
                        >
                          {runPRGenerationMutation.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShoppingCart className="mr-2 h-4 w-4" />}
                          Generate PR
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 xl:grid-cols-[320px_1fr]">
                    <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                      <div>
                        <Label htmlFor="pr-cycle-days">Cycle Length (Days)</Label>
                        <Input
                          id="pr-cycle-days"
                          type="number"
                          min="1"
                          className="mt-2 bg-white"
                          value={prScheduleConfig.cycle_days}
                          onChange={(event) => setPrScheduleConfig((current) => ({ ...current, cycle_days: event.target.value }))}
                        />
                      </div>
                      <div>
                        <Label>Preferred Generation Day</Label>
                        <Select
                          value={prScheduleConfig.preferred_weekday}
                          onValueChange={(value) => setPrScheduleConfig((current) => ({ ...current, preferred_weekday: value }))}
                        >
                          <SelectTrigger className="mt-2 bg-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((day) => (
                              <SelectItem key={day} value={day}>
                                {day.charAt(0).toUpperCase() + day.slice(1)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="pr-schedule-notes">Schedule Notes</Label>
                        <Input
                          id="pr-schedule-notes"
                          className="mt-2 bg-white"
                          value={prScheduleNotes}
                          onChange={(event) => setPrScheduleNotes(event.target.value)}
                          placeholder="Optional internal notes"
                        />
                      </div>
                      <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={prScheduleConfig.is_active}
                          onChange={(event) => setPrScheduleConfig((current) => ({ ...current, is_active: event.target.checked }))}
                        />
                        Schedule active
                      </label>
                    </div>

                    <div className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                          <p className="text-xs uppercase text-slate-500">Preferred Run Date</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {prSchedule?.preferred_run_date || 'Not set'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {prGenerationLoading ? 'Loading schedule...' : 'Next preferred generation day'}
                          </p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                          <p className="text-xs uppercase text-slate-500">Cycle Window</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">
                            {prSchedule ? `${prSchedule.cycle_start} to ${prSchedule.cycle_end}` : 'Not set'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {prSchedule ? `${prSchedule.cycle_days} day planning cycle` : 'Select a project to calculate'}
                          </p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                          <p className="text-xs uppercase text-slate-500">Current Cycle Status</p>
                          <p className={`mt-1 text-lg font-semibold ${
                            prCurrentCycleRun?.status === 'generated'
                              ? 'text-emerald-700'
                              : prCurrentCycleRun?.status === 'skipped'
                                ? 'text-amber-700'
                                : 'text-slate-900'
                          }`}>
                            {prCurrentCycleRun ? String(prCurrentCycleRun.status || 'pending').replace(/_/g, ' ') : 'Not generated'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {getGeneratedPRNumber(prCurrentCycleRun) || 'No PR generated for this cycle yet'}
                          </p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                          <p className="text-xs uppercase text-slate-500">Thursday Preference</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {prSchedule?.preferred_weekday ? prSchedule.preferred_weekday.charAt(0).toUpperCase() + prSchedule.preferred_weekday.slice(1) : 'Thursday'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {prSchedule?.is_preferred_day ? 'Selected date is the preferred run day.' : 'Generation is aligned to the next preferred day.'}
                          </p>
                        </div>
                      </div>

                      {prCurrentCycleRun?.status === 'generated' ? (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                          PR <strong>{getGeneratedPRNumber(prCurrentCycleRun)}</strong> already covers this cycle. Duplicate generation will be prevented automatically.
                        </div>
                      ) : null}

                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">Recent PR Generation Runs</p>
                            <p className="text-xs text-slate-500">Shows the latest generated, skipped, or protected cycles for this project.</p>
                          </div>
                          {prGenerationLoading ? <RefreshCw className="h-4 w-4 animate-spin text-slate-400" /> : null}
                        </div>
                        <div className="mt-3 space-y-3">
                          {prRecentRuns.length > 0 ? prRecentRuns.map((run) => (
                            <div key={run.id} className="flex flex-col gap-1 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="font-medium text-slate-900">
                                  {run.cycle_start} to {run.cycle_end}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {getGeneratedPRNumber(run) || 'No PR number'} · {run.generated_item_count || 0} items
                                </p>
                              </div>
                              <Badge
                                variant="outline"
                                className={
                                  run.status === 'generated'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : run.status === 'skipped'
                                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                                      : 'border-slate-200 bg-white text-slate-700'
                                }
                              >
                                {String(run.status || 'pending').replace(/_/g, ' ')}
                              </Badge>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
                              No PR generation runs recorded yet for this project.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  {!can('generate_menu_plan_pr') ? (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      You can plan menus here, but only authorized users can generate PRs for the cycle.
                    </div>
                  ) : null}
                </div>

                <DragDropContext onDragEnd={handleDragEnd}>
                  <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
                    <Card className="border-slate-200 shadow-none">
                      <CardHeader>
                        <CardTitle className="text-base">Available Recipes</CardTitle>
                        <p className="text-sm text-slate-500">
                          Drag recipes into Breakfast, Lunch, or Dinner. Existing manual selection still works.
                        </p>
                      </CardHeader>
                      <CardContent>
                        <Droppable droppableId="available-recipes" isDropDisabled>
                          {(provided) => (
                            <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-3">
                              {sortedAvailableRecipes.map((recipe, index) => (
                                <Draggable key={`available-${recipe.id}`} draggableId={`available-${recipe.id}`} index={index}>
                                  {(dragProvided, snapshot) => (
                                    <div
                                      ref={dragProvided.innerRef}
                                      {...dragProvided.draggableProps}
                                      {...dragProvided.dragHandleProps}
                                      className={`rounded-xl border bg-white p-3 shadow-sm transition ${snapshot.isDragging ? 'border-emerald-300 shadow-lg' : 'border-slate-200'}`}
                                    >
                                      <div className="flex items-start gap-3">
                                        <GripVertical className="mt-0.5 h-4 w-4 text-slate-400" />
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate font-medium text-slate-900">{recipe.name}</p>
                                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                                            <Badge variant="outline">{recipe.category || 'uncategorized'}</Badge>
                                            <span>{recipe.servings || 0} default servings</span>
                                            <span>{recipe.calories_per_serving || 0} cal / serving</span>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </Draggable>
                              ))}
                              {provided.placeholder}
                            </div>
                          )}
                        </Droppable>
                      </CardContent>
                    </Card>

                    <div className="grid gap-4 xl:grid-cols-3">
                      {CORE_MENU_MEAL_TYPES.map((mealType) => {
                        const mealRecipes = getRecipesForMeal(mealType);
                        const mealRows = Array.isArray(formData[mealType]) ? formData[mealType] : [createEmptyMealEntry()];

                        return (
                          <Card key={mealType} className="border-slate-200 shadow-none">
                            <CardHeader>
                              <CardTitle className="flex items-center justify-between text-base">
                                <span>{MEAL_LABELS[mealType]}</span>
                                <div className="flex items-center gap-2">
                                  <Badge className={MEAL_BADGES[mealType]}>
                                    {mealRows.filter((row) => row.recipe_id).length} planned
                                  </Badge>
                                  <Button type="button" variant="outline" size="sm" onClick={() => addMealRow(mealType)}>
                                    <Plus className="mr-1 h-4 w-4" />
                                    Add Recipe
                                  </Button>
                                </div>
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                              <Droppable droppableId={getMealDroppableId(mealType)}>
                                {(provided, snapshot) => (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.droppableProps}
                                    className={`space-y-4 rounded-2xl border border-dashed p-2 transition ${snapshot.isDraggingOver ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-slate-50/40'}`}
                                  >
                                    {mealRows.map((recipeRow, index) => {
                                      const selectedRecipe = availableRecipes.find((recipe) => recipe.id === recipeRow.recipe_id);
                                      return (
                                        <Draggable key={`${mealType}-${index}-${recipeRow.recipe_id || 'empty'}`} draggableId={`${mealType}-${index}-${recipeRow.recipe_id || `empty-${index}`}`} index={index}>
                                          {(dragProvided, dragSnapshot) => (
                                            <div
                                              ref={dragProvided.innerRef}
                                              {...dragProvided.draggableProps}
                                              className={`space-y-4 rounded-xl border border-slate-200 bg-white p-4 ${dragSnapshot.isDragging ? 'shadow-lg ring-2 ring-emerald-200' : ''}`}
                                            >
                                              <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2">
                                                  <button
                                                    type="button"
                                                    {...dragProvided.dragHandleProps}
                                                    className="rounded-md border border-slate-200 p-1 text-slate-400 hover:bg-slate-50"
                                                    aria-label={`Reorder ${MEAL_LABELS[mealType]} recipe ${index + 1}`}
                                                  >
                                                    <GripVertical className="h-4 w-4" />
                                                  </button>
                                                  <p className="text-sm font-medium text-slate-700">
                                                    {MEAL_LABELS[mealType]} Recipe {index + 1}
                                                  </p>
                                                </div>
                                                <Button
                                                  type="button"
                                                  variant="ghost"
                                                  size="sm"
                                                  className="text-red-600 hover:bg-red-50 hover:text-red-700"
                                                  onClick={() => removeMealRow(mealType, index)}
                                                  disabled={mealRows.length === 1}
                                                >
                                                  <Trash2 className="mr-1 h-4 w-4" />
                                                  Remove
                                                </Button>
                                              </div>

                                              <div>
                                                <Label>Recipe</Label>
                                                <Select
                                                  value={recipeRow.recipe_id || 'none'}
                                                  onValueChange={(value) => setMealValue(mealType, index, 'recipe_id', value === 'none' ? '' : value)}
                                                >
                                                  <SelectTrigger className="mt-2 bg-white">
                                                    <SelectValue placeholder={`Select ${mealType} recipe`} />
                                                  </SelectTrigger>
                                                  <SelectContent>
                                                    <SelectItem value="none">No recipe selected</SelectItem>
                                                    {mealRecipes.map((recipe) => (
                                                      <SelectItem key={recipe.id} value={recipe.id}>
                                                        {recipe.name}
                                                      </SelectItem>
                                                    ))}
                                                  </SelectContent>
                                                </Select>
                                              </div>

                                              <div>
                                                <Label>Expected Servings</Label>
                                                <Input
                                                  type="number"
                                                  min="1"
                                                  className="mt-2 bg-white"
                                                  value={recipeRow.expected_servings}
                                                  onChange={(event) => setMealValue(mealType, index, 'expected_servings', event.target.value)}
                                                  placeholder="Enter servings"
                                                />
                                              </div>

                                              {selectedRecipe ? (
                                                <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
                                                  <p className="font-medium text-slate-800">{selectedRecipe.name}</p>
                                                  <div className="mt-2 flex flex-wrap gap-3 text-xs">
                                                    <span>{selectedRecipe.category || 'uncategorized'}</span>
                                                    <span>{selectedRecipe.servings || 0} recipe servings</span>
                                                    <span>{selectedRecipe.calories_per_serving || 0} cal / serving</span>
                                                  </div>
                                                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs">
                                                    <div>
                                                      <p className="text-slate-500">Cost / serving</p>
                                                      <p className="font-semibold text-slate-900">
                                                        {calculateRecipeCostSnapshot(selectedRecipe, ingredients, recipes).has_cost
                                                          ? formatCurrency(calculateRecipeCostSnapshot(selectedRecipe, ingredients, recipes).cost_per_serving)
                                                          : 'Cost unavailable'}
                                                      </p>
                                                    </div>
                                                    <div>
                                                      <p className="text-slate-500">Planned item cost</p>
                                                      <p className="font-semibold text-slate-900">
                                                        {costSummary[mealType].entries[index]?.has_cost
                                                          ? formatCurrency(costSummary[mealType].entries[index]?.total_cost || 0)
                                                          : 'Cost unavailable'}
                                                      </p>
                                                    </div>
                                                  </div>
                                                </div>
                                              ) : (
                                                <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-400">
                                                  Drag a recipe here or choose one manually.
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </Draggable>
                                      );
                                    })}
                                    {provided.placeholder}
                                  </div>
                                )}
                              </Droppable>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                </DragDropContext>

                <div className="grid gap-4 md:grid-cols-3">
                  {CORE_MENU_MEAL_TYPES.map((mealType) => {
                    const mealSummary = (Array.isArray(formData[mealType]) ? formData[mealType] : []).reduce((total, row) => {
                      const servings = Number(row.expected_servings);
                      return total + (Number.isFinite(servings) ? servings : 0);
                    }, 0);
                    const mealBudgetStatus = mealBudgetStatuses[mealType];
                    return (
                      <div key={`summary-${mealType}`} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <p className="text-xs uppercase text-slate-500">{MEAL_LABELS[mealType]}</p>
                        <p className="mt-1 text-sm font-semibold text-slate-900">
                          {mealSummary} servings across {(Array.isArray(formData[mealType]) ? formData[mealType] : []).filter((row) => row.recipe_id).length} recipes
                        </p>
                        <p className={`mt-2 text-sm font-semibold ${mealBudgetStatus.is_over_limit ? 'text-red-700' : 'text-emerald-700'}`}>
                          {formatCurrency(costSummary[mealType].total_cost)}
                        </p>
                        <div className="mt-2">
                          <Label htmlFor={`meal-budget-${mealType}`} className="text-xs text-slate-500">
                            {MEAL_LABELS[mealType]} Budget Limit
                          </Label>
                          <Input
                            id={`meal-budget-${mealType}`}
                            type="number"
                            min="0"
                            className="mt-1 h-9 bg-white text-sm"
                            value={mealBudgetLimits[mealType]}
                            onChange={(event) => setMealBudgetLimit(mealType, event.target.value)}
                            placeholder="Optional limit"
                          />
                        </div>
                        {mealBudgetStatus.has_limit ? (
                          <p className={`mt-2 flex items-start gap-1 text-xs ${mealBudgetStatus.is_over_limit ? 'text-red-700' : 'text-slate-500'}`}>
                            {mealBudgetStatus.is_over_limit ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> : null}
                            <span>
                              {mealBudgetStatus.is_over_limit
                                ? `${MEAL_LABELS[mealType]} exceeds its limit by ${formatCurrency(mealBudgetStatus.exceeded_amount)}`
                                : `${MEAL_LABELS[mealType]} remaining limit: ${formatCurrency(mealBudgetStatus.remaining_amount)}`}
                            </span>
                            {mealBudgetStatus.is_over_limit ? (
                              <span className="sr-only">{MEAL_LABELS[mealType]} cost is above the defined meal budget limit.</span>
                            ) : null}
                          </p>
                        ) : null}
                        {costSummary[mealType].missing_cost_count > 0 ? (
                          <p className="mt-1 text-xs text-amber-600">
                            {costSummary[mealType].missing_cost_count} item(s) missing cost data
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      <span>
                        Total planned servings:{' '}
                        <strong className="text-slate-900">
                          {summarizeMenuPlanMeals(buildMenuPlanMeals(formData, availableRecipes, ingredients, selectedPlan)).total_expected_servings}
                        </strong>
                      </span>
                    </div>
                    <div>
                      Total planned cost:{' '}
                      <strong className="text-emerald-700">
                        {formatCurrency(costSummary.total_cost)}
                      </strong>
                    </div>
                    {costSummary.missing_cost_count > 0 ? (
                      <div className="text-amber-600">
                        {costSummary.missing_cost_count} planned item(s) have missing cost data
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="border-red-200 text-red-700 hover:bg-red-50"
                      onClick={handleClearPlan}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Clear Date Plan
                    </Button>
                    <Button
                      type="button"
                      className="bg-emerald-600 hover:bg-emerald-700"
                      onClick={handleSave}
                      disabled={createMutation.isPending || updateMutation.isPending}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {selectedPlan ? 'Update Menu Plan' : 'Save Menu Plan'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
