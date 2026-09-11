import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Download, FileText, Plus, ShieldAlert, UtensilsCrossed, Users } from 'lucide-react';
import { format } from 'date-fns';
import { downloadCSV, downloadPDF } from '@/components/utils/exportData';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';
import { normalizeAllergenTags } from '../../shared/allergens.js';
import { calculateRecipeNutritionSnapshot } from '../../shared/recipeNutrition.js';

function formatNutritionRows(recipe) {
  return [
    { key: 'calories', label: 'Calories', unit: 'kcal' },
    { key: 'protein', label: 'Protein', unit: 'g' },
    { key: 'carbs', label: 'Carbohydrates', unit: 'g' },
    { key: 'fat', label: 'Fat', unit: 'g' },
    { key: 'sodium', label: 'Sodium', unit: 'mg' },
    { key: 'sugar', label: 'Sugar', unit: 'g' }
  ].map((metric) => ({
    ...metric,
    total: recipe[`total_${metric.key}`] ?? null,
    perPortion: recipe[`${metric.key}_per_serving`] ?? null
  }));
}

function formatNutritionStatus(recipe) {
  return recipe.nutrition_complete === true
    ? 'Nutrition complete'
    : 'Nutrition incomplete — awaiting ingredient nutrition or weight data.';
}

function formatAllergenStatus(recipe) {
  return recipe.allergens_complete === true
    ? 'Allergen information complete'
    : 'Allergen information incomplete — awaiting ingredient allergen data.';
}

function formatSourceWarnings(warnings) {
  if (!Array.isArray(warnings)) return '';
  const summary = warnings.slice(0, 3).join(' ');
  return warnings.length > 3 ? `${summary} +${warnings.length - 3} more source data gaps.` : summary;
}

function formatAllergenSummary(recipe) {
  const allergens = normalizeAllergenTags(recipe.allergens);
  if (recipe.allergens_complete !== true) {
    return [allergens.join(', '), formatAllergenStatus(recipe)].filter(Boolean).join('. ');
  }
  return allergens.length > 0 ? allergens.join(', ') : 'No allergens declared in the ingredient or recipe data.';
}

function exportNutritionRecipes(recipes) {
  downloadCSV(recipes.map((recipe) => ({
    ...recipe,
    ...Object.fromEntries(formatNutritionRows(recipe).flatMap((row) => [
      [`total_${row.key}`, row.total ?? 'Unknown'],
      [`${row.key}_per_serving`, row.perPortion ?? 'Unknown']
    ])),
    nutrition_status: formatNutritionStatus(recipe),
    allergen_status: formatAllergenSummary(recipe)
  })), 'nutrition_recipes');
}

function exportNutritionLabel(recipe) {
  downloadPDF({
    title: `${recipe.name} Nutrition Label`,
    subtitle: `Generated on ${format(new Date(), 'PPP')} for Tamimi Global Catering system`,
    filename: `${recipe.name.replace(/\s+/g, '_').toLowerCase()}_nutrition_label`,
    sections: [
      {
        heading: 'Recipe Summary',
        lines: [
          `Recipe code: ${recipe.recipe_code || 'N/A'}`,
          `Category: ${recipe.category || 'N/A'}`,
          `Cuisine: ${recipe.cuisine_type || 'N/A'}`,
          `Servings: ${recipe.servings || 1}`,
          formatNutritionStatus(recipe),
          recipe.nutrition_complete !== true ? formatSourceWarnings(recipe.nutrition_warnings) : '',
          `Allergens: ${formatAllergenSummary(recipe)}`,
          recipe.allergens_complete !== true ? formatSourceWarnings(recipe.allergens_warnings) : ''
        ].filter(Boolean)
      },
      {
        heading: 'Per Portion',
        lines: formatNutritionRows(recipe).map((row) => `${row.label}: ${row.perPortion === null ? 'Unknown' : `${row.perPortion} ${row.unit}`}`)
      },
      {
        heading: 'Whole Recipe',
        lines: formatNutritionRows(recipe).map((row) => `${row.label}: ${row.total === null ? 'Unknown' : `${row.total} ${row.unit}`}`)
      }
    ]
  });
}

export default function NutritionAllergen() {
  const queryClient = useQueryClient();
  const [selectedRecipeId, setSelectedRecipeId] = useState('all');
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [mealPlanOpen, setMealPlanOpen] = useState(false);
  const [mealPlanForm, setMealPlanForm] = useState({
    name: '',
    site_id: '',
    plan_date: format(new Date(), 'yyyy-MM-dd'),
    customer_name: '',
    notes: '',
    meals: [{ recipe_id: '', meal_type: 'lunch', portions: 1, servings_per_attendee: 1 }]
  });

  const { data: recipes = [], isLoading: recipesLoading } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const effectiveRecipes = useMemo(() => recipes.map((recipe) => ({
    ...recipe,
    ...calculateRecipeNutritionSnapshot(recipe, recipes, ingredients)
  })), [ingredients, recipes]);
  const effectiveRecipeById = useMemo(
    () => new Map(effectiveRecipes.map((recipe) => [recipe.id, recipe])),
    [effectiveRecipes]
  );

  const { data: menuPlans = [] } = useQuery({
    queryKey: ['menuPlans'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 250)
  });

  const { data: mealPlans = [] } = useQuery({
    queryKey: ['customerMealPlans'],
    queryFn: () => base44.entities.CustomerMealPlan.list('-plan_date', 250)
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const createMealPlanMutation = useMutation({
    mutationFn: (payload) => base44.entities.CustomerMealPlan.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customerMealPlans'] });
      setMealPlanOpen(false);
      setMealPlanForm({
        name: '',
        site_id: '',
        plan_date: format(new Date(), 'yyyy-MM-dd'),
        customer_name: '',
        notes: '',
        meals: [{ recipe_id: '', meal_type: 'lunch', portions: 1, servings_per_attendee: 1 }]
      });
    }
  });

  const filteredRecipes = useMemo(() => {
    return effectiveRecipes.filter((recipe) => {
      const recipeMatches = selectedRecipeId === 'all' || recipe.id === selectedRecipeId;
      const siteMatches = selectedSite === 'all'
        || !recipe.site_scope
        || recipe.site_scope === 'global'
        || (Array.isArray(recipe.site_ids) && recipe.site_ids.includes(selectedSite));
      const categoryMatches = selectedCategory === 'all' || recipe.category === selectedCategory;
      return recipeMatches && siteMatches && categoryMatches;
    });
  }, [effectiveRecipes, selectedRecipeId, selectedSite, selectedCategory]);

  const allergenSummary = useMemo(() => {
    const counts = new Map();
    filteredRecipes.forEach((recipe) => {
      normalizeAllergenTags(recipe.allergens).forEach((allergen) => {
        counts.set(allergen, (counts.get(allergen) || 0) + 1);
      });
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [filteredRecipes]);

  const menuWarnings = useMemo(() => {
    return menuPlans
      .filter((plan) => selectedSite === 'all' || plan.site_id === selectedSite)
      .map((plan) => ({
        ...plan,
        warnings: (plan.meals || [])
          .map((meal) => {
            const currentRecipe = effectiveRecipeById.get(meal.recipe_id);
            return currentRecipe ? { ...meal, allergens: currentRecipe.allergens || [] } : meal;
          })
          .filter((meal) => Array.isArray(meal.allergens) && meal.allergens.length > 0)
      }))
      .filter((plan) => plan.warnings.length > 0);
  }, [effectiveRecipeById, menuPlans, selectedSite]);

  const mealPlanSummaries = useMemo(() => {
    return mealPlans.map((plan) => {
      const meals = Array.isArray(plan.meals) ? plan.meals : [];
      const totals = meals.reduce((accumulator, meal) => {
        accumulator.calories += Number(meal.total_calories || 0);
        accumulator.protein += Number(meal.total_protein || 0);
        accumulator.carbs += Number(meal.total_carbs || 0);
        accumulator.fat += Number(meal.total_fat || 0);
        accumulator.sodium += Number(meal.total_sodium || 0);
        accumulator.sugar += Number(meal.total_sugar || 0);
        normalizeAllergenTags(meal.allergens).forEach((allergen) => accumulator.allergens.add(allergen));
        return accumulator;
      }, { calories: 0, protein: 0, carbs: 0, fat: 0, sodium: 0, sugar: 0, allergens: new Set() });

      return {
        ...plan,
        totals: {
          calories: Math.round(totals.calories),
          protein: Math.round(totals.protein * 10) / 10,
          carbs: Math.round(totals.carbs * 10) / 10,
          fat: Math.round(totals.fat * 10) / 10,
          sodium: Math.round(totals.sodium * 10) / 10,
          sugar: Math.round(totals.sugar * 10) / 10
        },
        allergens: Array.from(totals.allergens)
      };
    });
  }, [mealPlans]);

  const categoryOptions = Array.from(new Set(effectiveRecipes.map((recipe) => recipe.category).filter(Boolean)));
  const projectSites = sites.filter((site) => (
    site.is_active !== false
    && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT
  ));

  const buildMealPlanPayload = () => {
    const site = sites.find((item) => item.id === mealPlanForm.site_id);
    const meals = mealPlanForm.meals
      .map((meal) => {
        const recipe = effectiveRecipes.find((item) => item.id === meal.recipe_id);
        const portions = Math.max(1, Number(meal.portions) || 1);
        if (!recipe) {
          return null;
        }
        return {
          recipe_id: recipe.id,
          recipe_name: recipe.name,
          meal_type: meal.meal_type || 'lunch',
          portions,
          servings_per_attendee: Math.max(0.01, Number(meal.servings_per_attendee) || 1),
          portion_size_grams: Number(recipe.portion_size_grams) || null,
          calories_per_serving: recipe.calories_per_serving || 0,
          protein_per_serving: recipe.protein_per_serving || 0,
          carbs_per_serving: recipe.carbs_per_serving || 0,
          fat_per_serving: recipe.fat_per_serving || 0,
          sodium_per_serving: recipe.sodium_per_serving || 0,
          sugar_per_serving: recipe.sugar_per_serving || 0,
          total_calories: (recipe.calories_per_serving || 0) * portions,
          total_protein: (recipe.protein_per_serving || 0) * portions,
          total_carbs: (recipe.carbs_per_serving || 0) * portions,
          total_fat: (recipe.fat_per_serving || 0) * portions,
          total_sodium: (recipe.sodium_per_serving || 0) * portions,
          total_sugar: (recipe.sugar_per_serving || 0) * portions,
          allergens: Array.isArray(recipe.allergens) ? recipe.allergens : []
        };
      })
      .filter(Boolean);

    return {
      name: mealPlanForm.name,
      customer_name: mealPlanForm.customer_name,
      site_id: mealPlanForm.site_id,
      site_name: site?.name || '',
      plan_date: mealPlanForm.plan_date,
      notes: mealPlanForm.notes,
      meals,
      status: 'active'
    };
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px]">
        <PageHeader
          title="Nutrition & Allergens"
          description="Manage ingredient nutrition, recipe labels, menu allergen warnings, and customer meal plans."
        >
          <Button
            variant="outline"
            onClick={() => exportNutritionRecipes(filteredRecipes)}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={() => setMealPlanOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
            <Plus className="mr-2 h-4 w-4" />
            Create Meal Plan
          </Button>
        </PageHeader>

        <div className="mb-6 grid grid-cols-1 gap-4 rounded-xl border border-slate-100 bg-white p-4 lg:grid-cols-3">
          <div>
            <Label>Recipe</Label>
            <Select value={selectedRecipeId} onValueChange={setSelectedRecipeId}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All recipes</SelectItem>
                {effectiveRecipes.map((recipe) => (
                  <SelectItem key={recipe.id} value={recipe.id}>{recipe.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Location</Label>
            <Select value={selectedSite} onValueChange={setSelectedSite}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categoryOptions.map((category) => (
                  <SelectItem key={category} value={category}>{category}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <Card className="border-slate-100">
            <CardContent className="p-5">
              <p className="text-sm text-slate-500">Nutrition-enabled ingredients</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{ingredients.length}</p>
            </CardContent>
          </Card>
          <Card className="border-slate-100">
            <CardContent className="p-5">
              <p className="text-sm text-slate-500">Recipes with allergen labels</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{effectiveRecipes.filter((recipe) => (recipe.allergens || []).length > 0).length}</p>
            </CardContent>
          </Card>
          <Card className="border-slate-100">
            <CardContent className="p-5">
              <p className="text-sm text-slate-500">Menu plans with warnings</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{menuWarnings.length}</p>
            </CardContent>
          </Card>
          <Card className="border-slate-100">
            <CardContent className="p-5">
              <p className="text-sm text-slate-500">Customer meal plans</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">{mealPlans.length}</p>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="labels" className="space-y-6">
          <TabsList className="grid w-full grid-cols-1 gap-2 bg-transparent md:grid-cols-3">
            <TabsTrigger value="labels">Nutrition Labels</TabsTrigger>
            <TabsTrigger value="menus">Menu Warnings</TabsTrigger>
            <TabsTrigger value="mealPlans">Customer Meal Plans</TabsTrigger>
          </TabsList>

          <TabsContent value="labels">
            {recipesLoading ? (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {[...Array(4)].map((_, index) => (
                  <Skeleton key={index} className="h-72 rounded-xl" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {filteredRecipes.map((recipe) => {
                  const recipeAllergens = normalizeAllergenTags(recipe.allergens);
                  return (
                  <Card key={recipe.id} className="border-slate-100 shadow-sm">
                    <CardHeader className="flex flex-row items-start justify-between space-y-0">
                      <div>
                        <CardTitle className="text-lg">{recipe.name}</CardTitle>
                        <p className="mt-1 text-sm text-slate-500">
                          {recipe.category || 'Uncategorized'} · {recipe.servings || 1} portions
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => exportNutritionLabel(recipe)}>
                        <FileText className="mr-2 h-4 w-4" />
                        PDF Label
                      </Button>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                        {formatNutritionRows(recipe).map((row) => (
                          <div key={row.label} className="rounded-lg bg-slate-50 p-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{row.label}</p>
                            <p className="mt-1 text-lg font-bold text-slate-900">{row.perPortion ?? '—'} {row.unit}</p>
                            <p className="text-xs text-slate-500">Per portion · total {row.total ?? '—'} {row.unit}</p>
                          </div>
                        ))}
                      </div>
                      {recipe.nutrition_complete !== true && (
                        <p className="text-sm text-amber-800">
                          {formatNutritionStatus(recipe)}{' '}{formatSourceWarnings(recipe.nutrition_warnings)}
                        </p>
                      )}
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                        <div className="mb-2 flex items-center gap-2 text-amber-800">
                          <ShieldAlert className="h-4 w-4" />
                          <span className="font-semibold">Allergen warning</span>
                        </div>
                        {recipeAllergens.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {recipeAllergens.map((allergen) => (
                              <Badge key={allergen} variant="outline" className="border-amber-300 bg-white text-amber-700">
                                {allergen}
                              </Badge>
                            ))}
                          </div>
                        ) : recipe.allergens_complete === true ? (
                          <p className="text-sm text-slate-600">No allergens declared in the ingredient or recipe data.</p>
                        ) : null}
                        {recipe.allergens_complete !== true && (
                          <p className="mt-2 text-sm text-amber-800">
                            {formatAllergenStatus(recipe)}{' '}{formatSourceWarnings(recipe.allergens_warnings)}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="menus">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
              <Card className="border-slate-100">
                <CardHeader>
                  <CardTitle className="text-base">Top allergen tags</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {allergenSummary.length > 0 ? allergenSummary.map(([allergen, count]) => (
                    <div key={allergen} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                      <span className="capitalize text-slate-700">{allergen}</span>
                      <Badge>{count}</Badge>
                    </div>
                  )) : (
                    <p className="text-sm text-slate-500">No allergen tags found in the current filter set.</p>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-4">
                {menuWarnings.length > 0 ? menuWarnings.map((plan) => (
                  <Card key={plan.id} className="border-slate-100">
                    <CardHeader>
                      <CardTitle className="text-base">
                        {plan.site_name || 'Location'} · {plan.plan_date ? format(new Date(plan.plan_date), 'PPP') : 'Planned menu'}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {plan.warnings.map((meal, index) => (
                        <div key={`${plan.id}-${index}`} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="font-semibold text-slate-900">{meal.recipe_name}</p>
                              <p className="text-sm text-slate-600 capitalize">{meal.meal_type} · {meal.expected_servings || 0} servings</p>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(meal.allergens || []).map((allergen) => (
                                <Badge key={allergen} variant="outline" className="border-amber-300 bg-white text-amber-700">
                                  {allergen}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )) : (
                  <Card className="border-slate-100">
                    <CardContent className="p-10 text-center text-slate-500">
                      No menu allergen warnings found for the selected filters.
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="mealPlans">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {mealPlanSummaries.length > 0 ? mealPlanSummaries.map((plan) => (
                <Card key={plan.id} className="border-slate-100">
                  <CardHeader className="flex flex-row items-start justify-between space-y-0">
                    <div>
                      <CardTitle className="text-base">{plan.name || 'Customer Meal Plan'}</CardTitle>
                      <p className="mt-1 text-sm text-slate-500">
                        {plan.customer_name || 'Guest'} · {plan.site_name || 'Location'} · {plan.plan_date ? format(new Date(plan.plan_date), 'PPP') : 'No date'}
                      </p>
                    </div>
                    <Users className="h-5 w-5 text-emerald-600" />
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Calories</p>
                        <p className="text-xl font-bold text-slate-900">{plan.totals.calories}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Protein</p>
                        <p className="text-xl font-bold text-slate-900">{plan.totals.protein}g</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Carbs</p>
                        <p className="text-xl font-bold text-slate-900">{plan.totals.carbs}g</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Fat</p>
                        <p className="text-xl font-bold text-slate-900">{plan.totals.fat}g</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Sodium</p>
                        <p className="text-xl font-bold text-slate-900">{plan.totals.sodium}mg</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Sugar</p>
                        <p className="text-xl font-bold text-slate-900">{plan.totals.sugar}g</p>
                      </div>
                    </div>
                    <div>
                      <p className="mb-2 text-sm font-medium text-slate-700">Meals</p>
                      <div className="space-y-2">
                        {(plan.meals || []).map((meal, index) => {
                          const mealAllergens = normalizeAllergenTags(meal.allergens);
                          return (
                          <div key={`${plan.id}-${index}`} className="rounded-lg border border-slate-200 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="font-medium text-slate-900">{meal.recipe_name}</p>
                                <p className="text-sm text-slate-500">
                                  {meal.portions} portions · {meal.meal_type || 'lunch'} · {meal.servings_per_attendee || 1} serving/customer · {meal.total_calories} kcal
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {mealAllergens.map((allergen) => (
                                  <Badge key={allergen} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                                    {allergen}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                    {plan.allergens.length > 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <p className="mb-2 text-sm font-semibold text-amber-800">Plan allergen summary</p>
                        <div className="flex flex-wrap gap-1.5">
                          {plan.allergens.map((allergen) => (
                            <Badge key={allergen} variant="outline" className="border-amber-300 bg-white text-amber-700">
                              {allergen}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              )) : (
                <Card className="border-slate-100 xl:col-span-2">
                  <CardContent className="p-10 text-center text-slate-500">
                    No customer meal plans created yet.
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={mealPlanOpen} onOpenChange={setMealPlanOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Customer Meal Plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>Plan name</Label>
                <Input className="mt-1" value={mealPlanForm.name} onChange={(event) => setMealPlanForm((current) => ({ ...current, name: event.target.value }))} placeholder="Executive lunch plan" />
              </div>
              <div>
                <Label>Customer name</Label>
                <Input className="mt-1" value={mealPlanForm.customer_name} onChange={(event) => setMealPlanForm((current) => ({ ...current, customer_name: event.target.value }))} placeholder="Client or camp group" />
              </div>
              <div>
                <Label>Location</Label>
                <Select value={mealPlanForm.site_id} onValueChange={(value) => setMealPlanForm((current) => ({ ...current, site_id: value }))}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select location" />
                  </SelectTrigger>
                  <SelectContent>
                    {projectSites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Plan date</Label>
                <Input type="date" className="mt-1" value={mealPlanForm.plan_date} onChange={(event) => setMealPlanForm((current) => ({ ...current, plan_date: event.target.value }))} />
              </div>
            </div>

            <div>
              <Label>Meals</Label>
              <div className="mt-2 space-y-3">
                <div className="hidden grid-cols-[minmax(180px,1fr)_140px_120px_160px] gap-3 px-3 text-xs font-medium text-slate-500 md:grid">
                  <span>Recipe</span>
                  <span>Meal period</span>
                  <span>Planned portions</span>
                  <span>Servings per customer</span>
                </div>
                {mealPlanForm.meals.map((meal, index) => (
                  <div key={index} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[minmax(180px,1fr)_140px_120px_160px]">
                    <Select
                      value={meal.recipe_id}
                      onValueChange={(value) => setMealPlanForm((current) => ({
                        ...current,
                        meals: current.meals.map((currentMeal, currentIndex) => currentIndex === index ? { ...currentMeal, recipe_id: value } : currentMeal)
                      }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select recipe" />
                      </SelectTrigger>
                      <SelectContent>
                        {effectiveRecipes.map((recipe) => (
                          <SelectItem key={recipe.id} value={recipe.id}>
                            {recipe.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={meal.meal_type || 'lunch'}
                      onValueChange={(value) => setMealPlanForm((current) => ({
                        ...current,
                        meals: current.meals.map((currentMeal, currentIndex) => currentIndex === index ? { ...currentMeal, meal_type: value } : currentMeal)
                      }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="breakfast">Breakfast</SelectItem>
                        <SelectItem value="lunch">Lunch</SelectItem>
                        <SelectItem value="dinner">Dinner</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min="1"
                      value={meal.portions}
                      onChange={(event) => setMealPlanForm((current) => ({
                        ...current,
                        meals: current.meals.map((currentMeal, currentIndex) => currentIndex === index ? { ...currentMeal, portions: event.target.value } : currentMeal)
                      }))}
                      placeholder="Portions"
                    />
                    <Input
                      type="number"
                      min="0.01"
                      max="20"
                      step="0.01"
                      value={meal.servings_per_attendee ?? 1}
                      onChange={(event) => setMealPlanForm((current) => ({
                        ...current,
                        meals: current.meals.map((currentMeal, currentIndex) => currentIndex === index ? { ...currentMeal, servings_per_attendee: event.target.value } : currentMeal)
                      }))}
                      aria-label="Servings per attendee"
                      placeholder="Servings / customer"
                    />
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => setMealPlanForm((current) => ({
                  ...current,
                  meals: [...current.meals, { recipe_id: '', meal_type: 'lunch', portions: 1, servings_per_attendee: 1 }]
                }))}
              >
                <UtensilsCrossed className="mr-2 h-4 w-4" />
                Add meal
              </Button>
            </div>

            <div>
              <Label>Notes</Label>
              <Textarea className="mt-1" rows={3} value={mealPlanForm.notes} onChange={(event) => setMealPlanForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Dietary guidance, allergy instructions, or service notes" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setMealPlanOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={createMealPlanMutation.isPending}
              onClick={() => createMealPlanMutation.mutate(buildMealPlanPayload())}
            >
              {createMealPlanMutation.isPending ? 'Saving...' : 'Save meal plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
