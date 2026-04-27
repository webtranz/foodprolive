import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, Calendar, Flame, Users, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { format, addDays, startOfWeek, eachDayOfInterval } from 'date-fns';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'event', 'custom'];

const MEAL_COLORS = {
  breakfast: 'bg-amber-100 text-amber-700 border-amber-200',
  lunch: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  dinner: 'bg-blue-100 text-blue-700 border-blue-200',
  snack: 'bg-purple-100 text-purple-700 border-purple-200',
  event: 'bg-pink-100 text-pink-700 border-pink-200',
  custom: 'bg-indigo-100 text-indigo-700 border-indigo-200'
};

export default function MenuPlanning() {
  const [selectedSite, setSelectedSite] = useState('');
  const [currentWeekStart, setCurrentWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [formOpen, setFormOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null);
  const [formData, setFormData] = useState({
    meal_type: 'lunch',
    recipe_id: '',
    expected_servings: ''
  });

  const queryClient = useQueryClient();

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
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 100),
    enabled: !!selectedSite
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.MenuPlan.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.MenuPlan.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
    }
  });

  const weekDays = eachDayOfInterval({
    start: currentWeekStart,
    end: addDays(currentWeekStart, 6)
  });

  const getPlanForDay = (date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return menuPlans.find(p => p.site_id === selectedSite && p.plan_date === dateStr);
  };

  const navigateWeek = (direction) => {
    setCurrentWeekStart(prev => addDays(prev, direction * 7));
  };

  const openAddMeal = (day) => {
    setSelectedDay(day);
    setFormData({ meal_type: 'lunch', recipe_id: '', expected_servings: '' });
    setFormOpen(true);
  };

  const handleAddMeal = async () => {
    if (!formData.recipe_id || !formData.expected_servings) return;

    const dateStr = format(selectedDay, 'yyyy-MM-dd');
    const existingPlan = getPlanForDay(selectedDay);
    const recipe = recipes.find(r => r.id === formData.recipe_id);
    const site = sites.find(s => s.id === selectedSite);

    const newMeal = {
      meal_type: formData.meal_type,
      recipe_id: formData.recipe_id,
      recipe_name: recipe?.name || '',
      expected_servings: parseInt(formData.expected_servings),
      calories_per_serving: recipe?.calories_per_serving || 0,
      protein_per_serving: recipe?.protein_per_serving || 0,
      carbs_per_serving: recipe?.carbs_per_serving || 0,
      fat_per_serving: recipe?.fat_per_serving || 0,
      sodium_per_serving: recipe?.sodium_per_serving || 0,
      sugar_per_serving: recipe?.sugar_per_serving || 0,
      allergens: Array.isArray(recipe?.allergens) ? recipe.allergens : []
    };

    if (existingPlan) {
      const updatedMeals = [...(existingPlan.meals || []), newMeal];
      const totalServings = updatedMeals.reduce((sum, m) => sum + (m.expected_servings || 0), 0);
      const totalCalories = updatedMeals.reduce((sum, m) => 
        sum + ((m.expected_servings || 0) * (m.calories_per_serving || 0)), 0
      );

      await updateMutation.mutateAsync({
        id: existingPlan.id,
        data: {
          meals: updatedMeals,
          total_expected_servings: totalServings,
          total_calories: totalCalories
        }
      });
    } else {
      await createMutation.mutateAsync({
        site_id: selectedSite,
        site_name: site?.name || '',
        plan_date: dateStr,
        meals: [newMeal],
        total_expected_servings: newMeal.expected_servings,
        total_calories: newMeal.expected_servings * (newMeal.calories_per_serving || 0),
        status: 'draft'
      });
    }

    setFormOpen(false);
  };

  const availableRecipes = recipes.filter((recipe) => {
    if (!recipe.site_scope || recipe.site_scope === 'global') {
      return true;
    }
    return Array.isArray(recipe.site_ids) && recipe.site_ids.includes(selectedSite);
  });

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Menu Planning" 
          description="Plan weekly menus for your sites"
        >
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px] bg-white">
              <SelectValue placeholder="Select site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map(site => (
                <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PageHeader>

        {!selectedSite ? (
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-12 text-center">
              <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-700 mb-2">Select a Site</h3>
              <p className="text-slate-500">Choose a site to start planning menus</p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Week Navigation */}
            <div className="flex items-center justify-between mb-6">
              <Button variant="outline" onClick={() => navigateWeek(-1)}>
                <ChevronLeft className="w-4 h-4 mr-1" />
                Previous
              </Button>
              <h2 className="text-lg font-semibold text-slate-900">
                {format(currentWeekStart, 'MMM d')} - {format(addDays(currentWeekStart, 6), 'MMM d, yyyy')}
              </h2>
              <Button variant="outline" onClick={() => navigateWeek(1)}>
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>

            {/* Weekly Calendar Grid */}
            <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
              {weekDays.map(day => {
                const plan = getPlanForDay(day);
                const isToday = format(day, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');

                return (
                  <Card 
                    key={day.toISOString()} 
                    className={`border-slate-100 shadow-sm ${isToday ? 'ring-2 ring-emerald-500' : ''}`}
                  >
                    <CardHeader className="p-3 pb-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-slate-500 uppercase">
                            {format(day, 'EEE')}
                          </p>
                          <p className={`text-lg font-bold ${isToday ? 'text-emerald-600' : 'text-slate-900'}`}>
                            {format(day, 'd')}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openAddMeal(day)}
                        >
                          <Plus className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="p-3 pt-0">
                      {plan?.meals && plan.meals.length > 0 ? (
                        <div className="space-y-2">
                          {MEAL_TYPES.map(mealType => {
                            const meals = plan.meals.filter(m => m.meal_type === mealType);
                            if (meals.length === 0) return null;
                            
                            return meals.map((meal, idx) => (
                              <div 
                                key={`${mealType}-${idx}`}
                                className={`p-2 rounded-lg border ${MEAL_COLORS[mealType]}`}
                              >
                                <p className="text-xs font-medium capitalize mb-1">{mealType}</p>
                                <p className="text-sm font-semibold truncate">{meal.recipe_name}</p>
                                <div className="flex items-center gap-2 mt-1 text-xs">
                                  <Users className="w-3 h-3" />
                                  <span>{meal.expected_servings}</span>
                                  {meal.calories_per_serving > 0 && (
                                    <>
                                      <Flame className="w-3 h-3" />
                                      <span>{meal.calories_per_serving}</span>
                                    </>
                                  )}
                                </div>
                                {Array.isArray(meal.allergens) && meal.allergens.length > 0 ? (
                                  <div className="mt-2">
                                    <div className="mb-1 flex items-center gap-1 text-[11px] font-medium">
                                      <ShieldAlert className="h-3 w-3" />
                                      Allergens
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                      {meal.allergens.slice(0, 3).map((allergen) => (
                                        <Badge key={allergen} variant="outline" className="border-white/70 bg-white/70 px-1.5 py-0 text-[10px] capitalize">
                                          {allergen}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ));
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-400 text-center py-4">
                          No meals planned
                        </p>
                      )}

                      {plan && (
                        <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
                          <div className="flex justify-between">
                            <span>Total:</span>
                            <span>{plan.total_expected_servings || 0} servings</span>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* Add Meal Dialog */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Add Meal - {selectedDay && format(selectedDay, 'EEEE, MMM d')}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Meal Type</Label>
                <Select
                  value={formData.meal_type}
                  onValueChange={(value) => setFormData({ ...formData, meal_type: value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEAL_TYPES.map(type => (
                      <SelectItem key={type} value={type} className="capitalize">{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Recipe</Label>
                <Select
                  value={formData.recipe_id}
                  onValueChange={(value) => setFormData({ ...formData, recipe_id: value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select recipe" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRecipes
                      .filter(r => r.category === formData.meal_type || formData.meal_type === 'snack')
                      .map(recipe => (
                        <SelectItem key={recipe.id} value={recipe.id}>
                          {recipe.name}
                        </SelectItem>
                      ))}
                    {availableRecipes
                      .filter(r => r.category !== formData.meal_type && formData.meal_type !== 'snack')
                      .map(recipe => (
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
                  value={formData.expected_servings}
                  onChange={(e) => setFormData({ ...formData, expected_servings: e.target.value })}
                  placeholder="Number of servings"
                  className="mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
              <Button 
                onClick={handleAddMeal}
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                Add Meal
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
