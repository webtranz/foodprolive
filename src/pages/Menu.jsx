import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import PageHeader from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { ChefHat, Flame, Clock, Users, Plus, ShieldAlert, Candy, Droplets } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

const CUISINE_TYPES = [
  { value: 'continental', label: 'Continental', icon: '🍽️' },
  { value: 'desi', label: 'Desi', icon: '🍛' },
  { value: 'italian', label: 'Italian', icon: '🍝' },
  { value: 'chinese', label: 'Chinese', icon: '🥢' },
  { value: 'japanese', label: 'Japanese', icon: '🍣' },
  { value: 'korean', label: 'Korean', icon: '🍜' },
  { value: 'thai', label: 'Thai', icon: '🌶️' },
  { value: 'middle_eastern', label: 'Middle Eastern', icon: '🧆' },
  { value: 'mediterranean', label: 'Mediterranean', icon: '🫒' },
  { value: 'american', label: 'American', icon: '🍔' },
  { value: 'mexican', label: 'Mexican', icon: '🌮' },
  { value: 'latin_american', label: 'Latin American', icon: '🫔' },
  { value: 'african', label: 'African', icon: '🥘' },
  { value: 'fast_food', label: 'Fast Food', icon: '🍟' },
  { value: 'street_food', label: 'Street Food', icon: '🥙' },
  { value: 'bbq', label: 'BBQ', icon: '🍖' },
  { value: 'seafood', label: 'Seafood', icon: '🦞' },
  { value: 'vegetarian', label: 'Vegetarian', icon: '🥗' },
  { value: 'vegan', label: 'Vegan', icon: '🌱' },
  { value: 'bakery', label: 'Bakery', icon: '🥐' },
  { value: 'fusion', label: 'Fusion', icon: '🍱' }
];

const MENU_CATEGORIES = [
  { value: 'all', label: 'All Meals' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'event', label: 'Events' },
  { value: 'custom', label: 'Custom' }
];

export default function Menu() {
  const [selectedCuisine, setSelectedCuisine] = useState('continental');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['recipes', selectedCuisine, selectedCategory],
    queryFn: async () => {
      const allRecipes = await base44.entities.Recipe.list();
      return allRecipes.filter(r => {
        const cuisineMatch = r.cuisine_type === selectedCuisine;
        const categoryMatch = selectedCategory === 'all' || r.category === selectedCategory;
        return cuisineMatch && categoryMatch;
      });
    }
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients', selectedCuisine],
    queryFn: async () => {
      const allIngredients = await base44.entities.Ingredient.list();
      return allIngredients.filter(i => i.cuisine_type === selectedCuisine || i.cuisine_type === 'universal');
    }
  });

  const currentCuisine = CUISINE_TYPES.find(c => c.value === selectedCuisine);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <PageHeader
          title={`${currentCuisine?.icon} Menu Management`}
          description="Browse recipes and ingredients by cuisine type"
        >
          <Link to={createPageUrl('Recipes')}>
            <Button className="bg-emerald-600 hover:bg-emerald-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Recipe
            </Button>
          </Link>
        </PageHeader>

        {/* Category Filter */}
        <div className="bg-white rounded-xl border border-slate-100 p-4 mb-4">
          <Label className="text-sm mb-2 block">Filter by Meal Type</Label>
          <div className="flex flex-wrap gap-2">
            {MENU_CATEGORIES.map(cat => (
              <Button
                key={cat.value}
                variant={selectedCategory === cat.value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedCategory(cat.value)}
                className={selectedCategory === cat.value ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
              >
                {cat.label}
              </Button>
            ))}
          </div>
        </div>

        <Tabs value={selectedCuisine} onValueChange={setSelectedCuisine} className="w-full">
          <TabsList className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2 h-auto bg-transparent">
            {CUISINE_TYPES.map(cuisine => (
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

          {CUISINE_TYPES.map(cuisine => (
            <TabsContent key={cuisine.value} value={cuisine.value} className="space-y-6 mt-6">
              {/* Recipes Section */}
              <div>
                <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                  <ChefHat className="w-5 h-5" />
                  {cuisine.label} Recipes
                </h2>
                {isLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[1, 2, 3].map(i => (
                      <Skeleton key={i} className="h-64" />
                    ))}
                  </div>
                ) : recipes.length === 0 ? (
                  <Card>
                    <CardContent className="py-12 text-center">
                      <p className="text-slate-500">No recipes available for this cuisine yet</p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {recipes.map(recipe => (
                      <Card key={recipe.id} className="hover:shadow-lg transition-shadow">
                        <CardHeader>
                          <div className="flex items-start justify-between">
                            <CardTitle className="text-lg">{recipe.name}</CardTitle>
                            <Badge variant="outline">{recipe.category}</Badge>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {recipe.description && (
                            <p className="text-sm text-slate-600 line-clamp-2">{recipe.description}</p>
                          )}
                          <div className="flex flex-wrap gap-3 text-sm text-slate-600">
                            <div className="flex items-center gap-1">
                              <Users className="w-4 h-4" />
                              {recipe.servings} servings
                            </div>
                            {recipe.prep_time_minutes && (
                              <div className="flex items-center gap-1">
                                <Clock className="w-4 h-4" />
                                {recipe.prep_time_minutes + (recipe.cook_time_minutes || 0)} min
                              </div>
                            )}
                            {recipe.calories_per_serving && (
                              <div className="flex items-center gap-1">
                                <Flame className="w-4 h-4" />
                                {recipe.calories_per_serving} cal
                              </div>
                            )}
                          </div>
                          {(recipe.protein_per_serving || recipe.carbs_per_serving || recipe.fat_per_serving) && (
                            <div className="pt-2 border-t flex gap-3 text-xs">
                              {recipe.protein_per_serving && (
                                <div>
                                  <span className="font-semibold">P:</span> {recipe.protein_per_serving}g
                                </div>
                              )}
                              {recipe.carbs_per_serving && (
                                <div>
                                  <span className="font-semibold">C:</span> {recipe.carbs_per_serving}g
                                </div>
                              )}
                              {recipe.fat_per_serving && (
                                <div>
                                  <span className="font-semibold">F:</span> {recipe.fat_per_serving}g
                                </div>
                              )}
                            </div>
                          )}
                          {(recipe.sodium_per_serving || recipe.sugar_per_serving) && (
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
                          )}
                          {Array.isArray(recipe.allergens) && recipe.allergens.length > 0 ? (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
                              <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-amber-800">
                                <ShieldAlert className="w-3 h-3" />
                                Allergen warning
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {recipe.allergens.map((allergen) => (
                                  <Badge key={allergen} variant="outline" className="border-amber-300 bg-white text-[11px] text-amber-700">
                                    {allergen}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>

              {/* Ingredients Section */}
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
                    {ingredients.map(ingredient => (
                      <Card key={ingredient.id} className="hover:shadow-md transition-shadow">
                        <CardContent className="p-4">
                          <p className="font-medium text-sm mb-1">{ingredient.name}</p>
                          <Badge variant="secondary" className="text-xs">
                            {ingredient.category.replace(/_/g, ' ')}
                          </Badge>
                          <div className="mt-2 text-xs text-slate-600">
                            <div>{ingredient.calories_per_100g} cal/100g</div>
                            {ingredient.protein_per_100g && (
                              <div>Protein: {ingredient.protein_per_100g}g</div>
                            )}
                            {ingredient.sodium_per_100g ? (
                              <div>Sodium: {ingredient.sodium_per_100g}mg</div>
                            ) : null}
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
      </div>
    </div>
  );
}
