import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Candy,
  ChefHat,
  Clock,
  Droplets,
  Flame,
  Plus,
  ShieldAlert,
  Users
} from 'lucide-react';
import { formatCurrency } from '@/lib/currency';
import { calculateProductionIngredientCost } from '../../shared/ingredientUnits.js';
import { normalizeAllergenTags } from '../../shared/allergens.js';
import { calculateRecipeNutritionSnapshot } from '../../shared/recipeNutrition.js';

const CUISINE_TYPES = [
  { value: 'continental', label: 'Continental', icon: 'C' },
  { value: 'desi', label: 'Desi', icon: 'D' },
  { value: 'italian', label: 'Italian', icon: 'I' },
  { value: 'chinese', label: 'Chinese', icon: 'CH' },
  { value: 'japanese', label: 'Japanese', icon: 'J' },
  { value: 'korean', label: 'Korean', icon: 'K' },
  { value: 'thai', label: 'Thai', icon: 'T' },
  { value: 'middle_eastern', label: 'Middle Eastern', icon: 'ME' },
  { value: 'mediterranean', label: 'Mediterranean', icon: 'MD' },
  { value: 'american', label: 'American', icon: 'A' },
  { value: 'mexican', label: 'Mexican', icon: 'M' },
  { value: 'latin_american', label: 'Latin American', icon: 'LA' },
  { value: 'african', label: 'African', icon: 'AF' },
  { value: 'fast_food', label: 'Fast Food', icon: 'FF' },
  { value: 'street_food', label: 'Street Food', icon: 'SF' },
  { value: 'bbq', label: 'BBQ', icon: 'B' },
  { value: 'seafood', label: 'Seafood', icon: 'S' },
  { value: 'vegetarian', label: 'Vegetarian', icon: 'V' },
  { value: 'vegan', label: 'Vegan', icon: 'VG' },
  { value: 'bakery', label: 'Bakery', icon: 'BK' },
  { value: 'fusion', label: 'Fusion', icon: 'F' }
];

const MENU_CATEGORIES = [
  { value: 'all', label: 'All Meals' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'event', label: 'Events' },
  { value: 'custom', label: 'Custom' }
];

const STATUS_STYLES = {
  completed: 'bg-emerald-100 text-emerald-700',
  in_progress: 'bg-violet-100 text-violet-700',
  approved: 'bg-green-100 text-green-700',
  pending_approval: 'bg-amber-100 text-amber-700',
  planned: 'bg-blue-100 text-blue-700'
};

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export default function Menu() {
  const [activeView, setActiveView] = useState('recipes');
  const [selectedCuisine, setSelectedCuisine] = useState('continental');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['recipes', selectedCuisine, selectedCategory],
    queryFn: async () => {
      const allRecipes = await base44.entities.Recipe.list();
      return allRecipes.filter((recipe) => {
        const cuisineMatch = recipe.cuisine_type === selectedCuisine;
        const categoryMatch = selectedCategory === 'all' || recipe.category === selectedCategory;
        return cuisineMatch && categoryMatch;
      });
    }
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients', selectedCuisine],
    queryFn: async () => {
      const allIngredients = await base44.entities.Ingredient.list();
      return allIngredients.filter((ingredient) => ingredient.cuisine_type === selectedCuisine || ingredient.cuisine_type === 'universal');
    }
  });

  const { data: allIngredients = [] } = useQuery({
    queryKey: ['all-ingredients-for-production-cost'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: productions = [] } = useQuery({
    queryKey: ['menu-production-costs'],
    queryFn: () => base44.entities.Production.list('-production_date', 300)
  });

  const ingredientMap = useMemo(
    () => Object.fromEntries(allIngredients.map((ingredient) => [ingredient.id, ingredient])),
    [allIngredients]
  );

  const effectiveRecipes = useMemo(() => recipes.map((recipe) => ({
    ...recipe,
    ...calculateRecipeNutritionSnapshot(recipe, recipes, allIngredients)
  })), [allIngredients, recipes]);

  const currentCuisine = CUISINE_TYPES.find((cuisine) => cuisine.value === selectedCuisine);
  const productionCostRows = useMemo(() => {
    return productions.map((production) => {
      const fallbackCost = (production.ingredients_used || []).reduce((sum, ingredient) => {
        const ingredientData = ingredientMap[ingredient.ingredient_id];
        return sum + calculateProductionIngredientCost(ingredient, ingredientData);
      }, 0);

      const totalCost = toNumber(production.production_cost_total || production.ingredient_cost_total, fallbackCost);
      const servings = Math.max(1, toNumber(production.target_servings, 0));
      const costPerServing = toNumber(production.cost_per_serving, totalCost / servings);

      return {
        id: production.id,
        production_date: production.production_date,
        recipe_name: production.recipe_name,
        site_name: production.site_name,
        meal_type: production.meal_type,
        status: production.status,
        target_servings: servings,
        total_cost: Number(totalCost.toFixed(2)),
        cost_per_serving: Number(costPerServing.toFixed(2)),
        shortage: Number(toNumber(production.total_shortage_quantity, 0).toFixed(2)),
        completed_by: production.completed_by || '-'
      };
    });
  }, [ingredientMap, productions]);

  const completedRows = productionCostRows.filter((row) => row.status === 'completed');
  const totalProductionCost = completedRows.reduce((sum, row) => sum + row.total_cost, 0);
  const totalServings = completedRows.reduce((sum, row) => sum + row.target_servings, 0);
  const averageCostPerServing = totalServings > 0 ? totalProductionCost / totalServings : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <PageHeader
          title="Menu Management"
          description="Browse cuisine menus and review cost posted from production batches"
        >
          <Link to={createPageUrl('Recipes')}>
            <Button className="bg-emerald-600 hover:bg-emerald-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Recipe
            </Button>
          </Link>
        </PageHeader>

        <Tabs value={activeView} onValueChange={setActiveView}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="recipes">Recipes & Menus</TabsTrigger>
            <TabsTrigger value="costs">Production Cost</TabsTrigger>
          </TabsList>

          <TabsContent value="recipes" className="space-y-6">
            <div className="bg-white rounded-xl border border-slate-100 p-4 mb-4">
              <Label className="text-sm mb-2 block">Filter by Meal Type</Label>
              <div className="flex flex-wrap gap-2">
                {MENU_CATEGORIES.map((category) => (
                  <Button
                    key={category.value}
                    variant={selectedCategory === category.value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedCategory(category.value)}
                    className={selectedCategory === category.value ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
                  >
                    {category.label}
                  </Button>
                ))}
              </div>
            </div>

            <Tabs value={selectedCuisine} onValueChange={setSelectedCuisine} className="w-full">
              <TabsList className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2 h-auto bg-transparent">
                {CUISINE_TYPES.map((cuisine) => (
                  <TabsTrigger
                    key={cuisine.value}
                    value={cuisine.value}
                    className="flex items-center gap-2 data-[state=active]:bg-slate-900 data-[state=active]:text-white"
                  >
                    <span>{cuisine.icon}</span>
                    <span className="hidden sm:inline">{cuisine.label}</span>
                  </TabsTrigger>
                ))}
              </TabsList>

              {CUISINE_TYPES.map((cuisine) => (
                <TabsContent key={cuisine.value} value={cuisine.value} className="space-y-6 mt-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                      <ChefHat className="w-5 h-5" />
                      {cuisine.label} Recipes
                    </h2>
                    {isLoading ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[1, 2, 3].map((index) => <Skeleton key={index} className="h-64" />)}
                      </div>
                    ) : effectiveRecipes.length === 0 ? (
                      <Card>
                        <CardContent className="py-12 text-center">
                          <p className="text-slate-500">No recipes available for this cuisine yet</p>
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {effectiveRecipes.map((recipe) => {
                          const recipeAllergens = normalizeAllergenTags(recipe.allergens);
                          return (
                          <Card key={recipe.id} className="hover:shadow-lg transition-shadow">
                            <CardHeader>
                              <div className="flex items-start justify-between">
                                <CardTitle className="text-lg">{recipe.name}</CardTitle>
                                <Badge variant="outline">{recipe.category}</Badge>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              {recipe.description ? <p className="text-sm text-slate-600 line-clamp-2">{recipe.description}</p> : null}
                              <div className="flex flex-wrap gap-3 text-sm text-slate-600">
                                <div className="flex items-center gap-1">
                                  <Users className="w-4 h-4" />
                                  {recipe.servings} servings
                                </div>
                                {recipe.prep_time_minutes ? (
                                  <div className="flex items-center gap-1">
                                    <Clock className="w-4 h-4" />
                                    {recipe.prep_time_minutes + (recipe.cook_time_minutes || 0)} min
                                  </div>
                                ) : null}
                                {recipe.calories_per_serving ? (
                                  <div className="flex items-center gap-1">
                                    <Flame className="w-4 h-4" />
                                    {recipe.calories_per_serving} cal
                                  </div>
                                ) : null}
                              </div>
                              {(recipe.protein_per_serving || recipe.carbs_per_serving || recipe.fat_per_serving) ? (
                                <div className="pt-2 border-t flex gap-3 text-xs">
                                  {recipe.protein_per_serving ? <div><span className="font-semibold">P:</span> {recipe.protein_per_serving}g</div> : null}
                                  {recipe.carbs_per_serving ? <div><span className="font-semibold">C:</span> {recipe.carbs_per_serving}g</div> : null}
                                  {recipe.fat_per_serving ? <div><span className="font-semibold">F:</span> {recipe.fat_per_serving}g</div> : null}
                                </div>
                              ) : null}
                              {(recipe.sodium_per_serving || recipe.sugar_per_serving) ? (
                                <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                                  {recipe.sodium_per_serving ? (
                                    <div className="flex items-center gap-1">
                                      <Droplets className="w-3 h-3 text-cyan-600" />
                                      {recipe.sodium_per_serving} mg sodium
                                    </div>
                                  ) : null}
                                  {recipe.sugar_per_serving ? (
                                    <div className="flex items-center gap-1">
                                      <Candy className="w-3 h-3 text-pink-500" />
                                      {recipe.sugar_per_serving} g sugar
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                              {recipeAllergens.length > 0 ? (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
                                  <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-amber-800">
                                    <ShieldAlert className="w-3 h-3" />
                                    Allergen warning
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {recipeAllergens.map((allergen) => (
                                      <Badge key={allergen} variant="outline" className="border-amber-300 bg-white text-[11px] text-amber-700">
                                        {allergen}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </CardContent>
                          </Card>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-4">Available Ingredients</h2>
                    {ingredients.length === 0 ? (
                      <Card>
                        <CardContent className="py-12 text-center">
                          <p className="text-slate-500">No ingredients available for this cuisine yet</p>
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                        {ingredients.map((ingredient) => (
                          <Card key={ingredient.id} className="hover:shadow-md transition-shadow">
                            <CardContent className="p-4">
                              <p className="font-medium text-sm mb-1">{ingredient.name}</p>
                              <Badge variant="secondary" className="text-xs">{String(ingredient.category || '').replace(/_/g, ' ')}</Badge>
                              <div className="mt-2 text-xs text-slate-600">
                                <div>{ingredient.calories_per_100g} cal/100g</div>
                                {ingredient.protein_per_100g ? <div>Protein: {ingredient.protein_per_100g}g</div> : null}
                                {ingredient.sodium_per_100g ? <div>Sodium: {ingredient.sodium_per_100g}mg</div> : null}
                              </div>
                              {Array.isArray(ingredient.allergens) && ingredient.allergens.length > 0 ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {ingredient.allergens.map((allergen) => (
                                    <Badge key={allergen} variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                                      {allergen}
                                    </Badge>
                                  ))}
                                </div>
                              ) : null}
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </TabsContent>

          <TabsContent value="costs" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-slate-500">Completed Batches</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold text-slate-900">{completedRows.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-slate-500">Total Production Cost</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold text-slate-900">{formatCurrency(totalProductionCost)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-slate-500">Average Cost Per Serving</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold text-slate-900">{formatCurrency(averageCostPerServing)}</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Production Cost Per Batch</CardTitle>
              </CardHeader>
              <CardContent>
                {productionCostRows.length === 0 ? (
                  <p className="text-sm text-slate-500">No production batches are available yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Recipe</TableHead>
                        <TableHead>Project</TableHead>
                        <TableHead>Meal</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Servings</TableHead>
                        <TableHead>Total Cost</TableHead>
                        <TableHead>Cost / Serving</TableHead>
                        <TableHead>Shortage</TableHead>
                        <TableHead>Completed By</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {productionCostRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{row.production_date || '-'}</TableCell>
                          <TableCell className="font-medium">{row.recipe_name || '-'}</TableCell>
                          <TableCell>{row.site_name || '-'}</TableCell>
                          <TableCell className="capitalize">{row.meal_type || '-'}</TableCell>
                          <TableCell>
                            <Badge className={STATUS_STYLES[row.status] || 'bg-slate-100 text-slate-700'}>
                              {String(row.status || 'planned').replace(/_/g, ' ')}
                            </Badge>
                          </TableCell>
                          <TableCell>{row.target_servings}</TableCell>
                          <TableCell>{formatCurrency(row.total_cost)}</TableCell>
                          <TableCell>{formatCurrency(row.cost_per_serving)}</TableCell>
                          <TableCell>{row.shortage}</TableCell>
                          <TableCell>{row.completed_by}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
