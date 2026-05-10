import React, { useEffect, useMemo, useState } from 'react';
import { addDays, eachDayOfInterval, format, startOfWeek } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Calendar, ChevronLeft, ChevronRight, Save, Trash2, Users } from 'lucide-react';
import {
  buildDailyMenuState,
  buildMenuPlanMeals,
  CORE_MENU_MEAL_TYPES,
  createEmptyDailyMenuState,
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

export default function MenuPlanning() {
  const queryClient = useQueryClient();
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [currentWeekStart, setCurrentWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [formData, setFormData] = useState(createEmptyDailyMenuState());
  const [message, setMessage] = useState('');

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: menuPlans = [] } = useQuery({
    queryKey: ['menuPlans', selectedSite],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 300),
    enabled: !!selectedSite
  });

  const {
    data: selectedPlan,
    isLoading: selectedPlanLoading
  } = useQuery({
    queryKey: ['menuPlanByDate', selectedSite, selectedDate],
    queryFn: () => base44.menuPlanning.getByDate(selectedSite, selectedDate),
    enabled: !!selectedSite && !!selectedDate
  });

  const createMutation = useMutation({
    mutationFn: (payload) => base44.menuPlanning.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
      setMessage('Menu plan saved successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to save menu plan')
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => base44.menuPlanning.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
      setMessage('Menu plan updated successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to update menu plan')
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.menuPlanning.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlanByDate'] });
      setFormData(createEmptyDailyMenuState());
      setMessage('Menu plan cleared for the selected date.');
    },
    onError: (error) => setMessage(error.message || 'Failed to clear menu plan')
  });

  useEffect(() => {
    setCurrentWeekStart(startOfWeek(new Date(selectedDate), { weekStartsOn: 1 }));
  }, [selectedDate]);

  useEffect(() => {
    setFormData(buildDailyMenuState(selectedPlan));
  }, [selectedPlan]);

  const operationalPlans = useMemo(() => (
    menuPlans
      .filter((plan) => plan.site_id === selectedSite)
      .filter(isOperationalMenuPlan)
  ), [menuPlans, selectedSite]);

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

  const weekDays = useMemo(() => eachDayOfInterval({
    start: currentWeekStart,
    end: addDays(currentWeekStart, 6)
  }), [currentWeekStart]);

  const getPlanForDay = (date) => {
    const dayKey = format(date, 'yyyy-MM-dd');
    return operationalPlans.find((plan) => plan.plan_date === dayKey);
  };

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

  const setMealValue = (mealType, field, value) => {
    setFormData((current) => ({
      ...current,
      [mealType]: {
        ...current[mealType],
        [field]: value
      }
    }));
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

    const meals = buildMenuPlanMeals(formData, availableRecipes, selectedPlan);
    const summary = summarizeMenuPlanMeals(meals);
    const payload = {
      site_id: selectedSiteRecord.id,
      site_name: selectedSiteRecord.name,
      plan_date: selectedDate,
      meals,
      status: selectedPlan?.status || 'planned',
      total_expected_servings: summary.total_expected_servings,
      total_calories: summary.total_calories
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

        {!selectedSite ? (
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-12 text-center">
              <Calendar className="mx-auto mb-4 h-16 w-16 text-slate-300" />
              <h3 className="mb-2 text-lg font-semibold text-slate-700">Select a Project</h3>
              <p className="text-slate-500">Choose a project or kitchen to start planning menus date-wise.</p>
            </CardContent>
          </Card>
        ) : (
          <>
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
                      const plan = getPlanForDay(day);
                      const dayKey = format(day, 'yyyy-MM-dd');
                      const isSelected = dayKey === selectedDate;

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
                              const meal = plan?.meals?.find((entry) => entry.meal_type === mealType);
                              return meal ? (
                                <div key={mealType} className={`rounded-lg border px-2 py-1 text-[11px] ${MEAL_BADGES[mealType]}`}>
                                  <p className="font-medium">{MEAL_LABELS[mealType]}</p>
                                  <p className="truncate">{meal.recipe_name}</p>
                                </div>
                              ) : null;
                            })}
                            {!plan ? (
                              <p className="pt-4 text-center text-[11px] text-slate-400">No core meals planned</p>
                            ) : null}
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

                <div className="grid gap-4 xl:grid-cols-3">
                  {CORE_MENU_MEAL_TYPES.map((mealType) => {
                    const mealRecipes = getRecipesForMeal(mealType);
                    const recipeRow = formData[mealType];
                    const selectedRecipe = availableRecipes.find((recipe) => recipe.id === recipeRow.recipe_id);

                    return (
                      <Card key={mealType} className="border-slate-200 shadow-none">
                        <CardHeader>
                          <CardTitle className="flex items-center justify-between text-base">
                            <span>{MEAL_LABELS[mealType]}</span>
                            <Badge className={MEAL_BADGES[mealType]}>
                              {MEAL_LABELS[mealType]}
                            </Badge>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div>
                            <Label>Recipe</Label>
                            <Select
                              value={recipeRow.recipe_id || 'none'}
                              onValueChange={(value) => setMealValue(mealType, 'recipe_id', value === 'none' ? '' : value)}
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
                              onChange={(event) => setMealValue(mealType, 'expected_servings', event.target.value)}
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
                            </div>
                          ) : (
                            <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-400">
                              Choose a recipe to plan this meal slot.
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  {CORE_MENU_MEAL_TYPES.map((mealType) => (
                    <div key={`summary-${mealType}`} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <p className="text-xs uppercase text-slate-500">{MEAL_LABELS[mealType]}</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {formData[mealType].expected_servings || 0} servings
                      </p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <Users className="h-4 w-4" />
                    <span>
                      Total planned servings:{' '}
                      <strong className="text-slate-900">
                        {summarizeMenuPlanMeals(buildMenuPlanMeals(formData, availableRecipes, selectedPlan)).total_expected_servings}
                      </strong>
                    </span>
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
