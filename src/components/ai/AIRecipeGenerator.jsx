import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2, Save, RefreshCw, DollarSign } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AIRecipeGenerator() {
  const [filters, setFilters] = useState({
    siteId: '',
    cuisineType: 'continental',
    category: 'main_course',
    servings: 4
  });
  const [generating, setGenerating] = useState(false);
  const [generatedRecipe, setGeneratedRecipe] = useState(null);
  const [costAnalysis, setCostAnalysis] = useState(null);
  const [substitutions, setSubstitutions] = useState(null);
  const [analyzingCost, setAnalyzingCost] = useState(false);
  const [error, setError] = useState(null);

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const saveRecipeMutation = useMutation({
    mutationFn: (recipeData) => base44.entities.Recipe.create(recipeData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      setGeneratedRecipe(null);
    }
  });

  const availableIngredients = inventory
    .filter(i => 
      i.quantity > 0 && 
      (!filters.siteId || i.site_id === filters.siteId)
    )
    .map(i => {
      const ing = ingredients.find(ing => ing.id === i.ingredient_id);
      return {
        name: i.ingredient_name,
        quantity: i.quantity,
        unit: i.unit,
        cuisine_type: ing?.cuisine_type,
        category: ing?.category
      };
    });

  const generateRecipe = async () => {
    setGenerating(true);
    setError(null);

    try {
      const prompt = `You are a professional chef and nutritionist. Generate a complete recipe based on the following requirements:

Cuisine Type: ${filters.cuisineType}
Meal Category: ${filters.category}
Servings: ${filters.servings}

Available Ingredients (use at least 5-8 of these):
${availableIngredients.map(i => `- ${i.name} (${i.quantity} ${i.unit})`).join('\n')}

Requirements:
1. Create an authentic ${filters.cuisineType} ${filters.category} recipe
2. Use ingredients that are currently available in inventory
3. Include realistic quantities per serving
4. Provide detailed cooking instructions (5-8 steps)
5. Calculate approximate nutritional information per serving
6. Make it delicious and practical for production scale

Consider current food trends: healthy options, balanced nutrition, sustainable cooking.

Provide the recipe in the exact JSON format below (no markdown, no code blocks, just pure JSON):`;

      const response = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ingredient_name: { type: "string" },
                  quantity: { type: "number" },
                  unit: { type: "string" }
                }
              }
            },
            instructions: { type: "string" },
            prep_time_minutes: { type: "number" },
            cook_time_minutes: { type: "number" },
            calories_per_serving: { type: "number" },
            protein_per_serving: { type: "number" },
            carbs_per_serving: { type: "number" },
            fat_per_serving: { type: "number" }
          }
        }
      });

      const recipe = {
        ...response,
        cuisine_type: filters.cuisineType,
        category: filters.category,
        servings: parseInt(filters.servings),
        total_calories: response.calories_per_serving * parseInt(filters.servings),
        is_active: true
      };

      // Match ingredients with IDs from database
      recipe.ingredients = recipe.ingredients.map(ing => {
        const matchedIng = ingredients.find(i => 
          i.name.toLowerCase().includes(ing.ingredient_name.toLowerCase()) ||
          ing.ingredient_name.toLowerCase().includes(i.name.toLowerCase())
        );
        
        return {
          ingredient_id: matchedIng?.id || null,
          ingredient_name: ing.ingredient_name,
          quantity: ing.quantity,
          unit: ing.unit
        };
      });

      setGeneratedRecipe(recipe);
      
      // Automatically analyze cost after generation
      analyzeCostAndSubstitutions(recipe);
    } catch (err) {
      setError(err.message || 'Failed to generate recipe');
      console.error('Recipe generation error:', err);
    } finally {
      setGenerating(false);
    }
  };

  const analyzeCostAndSubstitutions = async (recipe) => {
    setAnalyzingCost(true);
    try {
      let totalCost = 0;
      const ingredientCosts = [];
      
      recipe.ingredients.forEach(recipeIng => {
        const ingredient = ingredients.find(i => 
          i.name.toLowerCase().includes(recipeIng.ingredient_name.toLowerCase()) ||
          recipeIng.ingredient_name.toLowerCase().includes(i.name.toLowerCase())
        );
        
        const cost = ingredient?.cost_per_unit ? (recipeIng.quantity * ingredient.cost_per_unit) : 0;
        totalCost += cost;
        
        ingredientCosts.push({
          name: recipeIng.ingredient_name,
          quantity: recipeIng.quantity,
          unit: recipeIng.unit,
          unitCost: ingredient?.cost_per_unit || 0,
          totalCost: cost,
          category: ingredient?.category
        });
      });

      const costPerServing = totalCost / recipe.servings;

      // Get AI suggestions for cost optimization
      const optimizationPrompt = `Analyze this recipe and suggest cost optimizations:

Recipe: ${recipe.name}
Current Total Cost: $${totalCost.toFixed(2)}
Cost Per Serving: $${costPerServing.toFixed(2)}

Ingredients and Costs:
${ingredientCosts.map(i => `- ${i.name}: ${i.quantity} ${i.unit} = $${i.totalCost.toFixed(2)}`).join('\n')}

Available substitute ingredients:
${ingredients.filter(i => i.cost_per_unit).map(i => `- ${i.name} ($${i.cost_per_unit}/${i.unit}) - ${i.category}`).join('\n')}

Provide:
1. 3-5 specific ingredient substitutions that reduce cost while maintaining quality and flavor
2. Quantity adjustments that could optimize cost
3. Price fluctuation forecast (what if prices increase/decrease by 10-20%)
4. Overall cost optimization strategy

Format as JSON.`;

      const aiResponse = await base44.integrations.Core.InvokeLLM({
        prompt: optimizationPrompt,
        response_json_schema: {
          type: "object",
          properties: {
            substitutions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  original_ingredient: { type: "string" },
                  substitute: { type: "string" },
                  cost_savings: { type: "number" },
                  impact_on_quality: { type: "string" },
                  flavor_profile_notes: { type: "string" }
                }
              }
            },
            quantity_adjustments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ingredient: { type: "string" },
                  current_quantity: { type: "number" },
                  suggested_quantity: { type: "number" },
                  reasoning: { type: "string" }
                }
              }
            },
            price_fluctuation_forecast: {
              type: "object",
              properties: {
                increase_10_percent: { type: "number" },
                increase_20_percent: { type: "number" },
                decrease_10_percent: { type: "number" },
                decrease_20_percent: { type: "number" }
              }
            },
            optimization_summary: { type: "string" }
          }
        }
      });

      setCostAnalysis({
        totalCost,
        costPerServing,
        ingredientCosts,
        ...aiResponse
      });

      setSubstitutions(aiResponse.substitutions || []);
    } catch (err) {
      console.error('Cost analysis error:', err);
    } finally {
      setAnalyzingCost(false);
    }
  };

  const saveRecipe = () => {
    if (generatedRecipe) {
      saveRecipeMutation.mutate(generatedRecipe);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-purple-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            AI Recipe Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <Label>Site (Optional)</Label>
              <Select value={filters.siteId || 'all'} onValueChange={(value) => setFilters({ ...filters, siteId: value === 'all' ? '' : value })}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="All sites" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sites</SelectItem>
                  {sites.map(site => (
                    <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Cuisine Type</Label>
              <Select value={filters.cuisineType} onValueChange={(value) => setFilters({ ...filters, cuisineType: value })}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="continental">Continental</SelectItem>
                  <SelectItem value="desi">Desi</SelectItem>
                  <SelectItem value="italian">Italian</SelectItem>
                  <SelectItem value="chinese">Chinese</SelectItem>
                  <SelectItem value="japanese">Japanese</SelectItem>
                  <SelectItem value="mexican">Mexican</SelectItem>
                  <SelectItem value="thai">Thai</SelectItem>
                  <SelectItem value="mediterranean">Mediterranean</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Category</Label>
              <Select value={filters.category} onValueChange={(value) => setFilters({ ...filters, category: value })}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="breakfast">Breakfast</SelectItem>
                  <SelectItem value="lunch">Lunch</SelectItem>
                  <SelectItem value="dinner">Dinner</SelectItem>
                  <SelectItem value="snack">Snack</SelectItem>
                  <SelectItem value="appetizer">Appetizer</SelectItem>
                  <SelectItem value="main_course">Main Course</SelectItem>
                  <SelectItem value="dessert">Dessert</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Servings</Label>
              <Input
                type="number"
                min="1"
                value={filters.servings}
                onChange={(e) => setFilters({ ...filters, servings: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>

          <div className="bg-slate-50 rounded-lg p-4">
            <p className="text-sm font-medium mb-2">Available Ingredients ({availableIngredients.length}):</p>
            <div className="flex flex-wrap gap-2">
              {availableIngredients.slice(0, 15).map((ing, idx) => (
                <Badge key={idx} variant="outline">
                  {ing.name}
                </Badge>
              ))}
              {availableIngredients.length > 15 && (
                <Badge variant="outline">+{availableIngredients.length - 15} more</Badge>
              )}
            </div>
          </div>

          <Button 
            onClick={generateRecipe} 
            disabled={generating || availableIngredients.length < 3}
            className="w-full bg-purple-600 hover:bg-purple-700"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating Recipe...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate AI Recipe
              </>
            )}
          </Button>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Generated Recipe Display */}
      {generatedRecipe && (
        <Card className="border-green-200">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>{generatedRecipe.name}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={generateRecipe}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Regenerate
                </Button>
                <Button 
                  size="sm" 
                  onClick={saveRecipe}
                  disabled={saveRecipeMutation.isPending}
                  className="bg-green-600 hover:bg-green-700"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {saveRecipeMutation.isPending ? 'Saving...' : 'Save Recipe'}
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-slate-600">{generatedRecipe.description}</p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-blue-50 rounded-lg p-3">
                <p className="text-xs text-slate-600">Prep Time</p>
                <p className="font-semibold">{generatedRecipe.prep_time_minutes} min</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3">
                <p className="text-xs text-slate-600">Cook Time</p>
                <p className="font-semibold">{generatedRecipe.cook_time_minutes} min</p>
              </div>
              <div className="bg-orange-50 rounded-lg p-3">
                <p className="text-xs text-slate-600">Calories</p>
                <p className="font-semibold">{generatedRecipe.calories_per_serving}</p>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <p className="text-xs text-slate-600">Protein</p>
                <p className="font-semibold">{generatedRecipe.protein_per_serving}g</p>
              </div>
            </div>

            <div>
              <h4 className="font-medium mb-2">Ingredients ({generatedRecipe.servings} servings):</h4>
              <div className="space-y-1">
                {generatedRecipe.ingredients.map((ing, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <span className="text-slate-600">•</span>
                    <span>{ing.quantity} {ing.unit} {ing.ingredient_name}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="font-medium mb-2">Instructions:</h4>
              <div className="prose prose-sm max-w-none">
                <p className="whitespace-pre-line text-sm text-slate-600">{generatedRecipe.instructions}</p>
              </div>
            </div>

            {/* Cost Analysis Section */}
            {costAnalysis && (
              <div className="mt-6 space-y-4">
                <div className="border-t pt-4">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <DollarSign className="w-5 h-5 text-green-600" />
                    Cost Analysis & Optimization
                  </h3>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                    <div className="bg-green-50 rounded-lg p-3">
                      <p className="text-xs text-slate-600">Total Cost</p>
                      <p className="text-xl font-bold text-green-700">${costAnalysis.totalCost.toFixed(2)}</p>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-3">
                      <p className="text-xs text-slate-600">Per Serving</p>
                      <p className="text-xl font-bold text-blue-700">${costAnalysis.costPerServing.toFixed(2)}</p>
                    </div>
                    <div className="bg-red-50 rounded-lg p-3">
                      <p className="text-xs text-slate-600">+20% Price ↑</p>
                      <p className="text-xl font-bold text-red-700">${costAnalysis.price_fluctuation_forecast?.increase_20_percent?.toFixed(2)}</p>
                    </div>
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <p className="text-xs text-slate-600">-20% Price ↓</p>
                      <p className="text-xl font-bold text-emerald-700">${costAnalysis.price_fluctuation_forecast?.decrease_20_percent?.toFixed(2)}</p>
                    </div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4 mb-4">
                    <p className="text-sm font-medium mb-2">Optimization Summary</p>
                    <p className="text-sm text-slate-600">{costAnalysis.optimization_summary}</p>
                  </div>

                  {substitutions && substitutions.length > 0 && (
                    <div>
                      <h4 className="font-medium mb-3">Suggested Substitutions</h4>
                      <div className="space-y-3">
                        {substitutions.map((sub, idx) => (
                          <div key={idx} className="bg-white border border-green-200 rounded-lg p-3">
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <p className="font-medium text-sm">
                                  Replace <span className="text-slate-600">{sub.original_ingredient}</span>
                                  {' → '}
                                  <span className="text-green-600">{sub.substitute}</span>
                                </p>
                                <p className="text-xs text-green-600 font-medium mt-1">
                                  Save ${sub.cost_savings?.toFixed(2)}
                                </p>
                              </div>
                            </div>
                            <p className="text-xs text-slate-600 mb-1">
                              <span className="font-medium">Quality Impact:</span> {sub.impact_on_quality}
                            </p>
                            <p className="text-xs text-slate-600">
                              <span className="font-medium">Flavor Notes:</span> {sub.flavor_profile_notes}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {costAnalysis.quantity_adjustments && costAnalysis.quantity_adjustments.length > 0 && (
                    <div className="mt-4">
                      <h4 className="font-medium mb-3">Quantity Adjustments</h4>
                      <div className="space-y-2">
                        {costAnalysis.quantity_adjustments.map((adj, idx) => (
                          <div key={idx} className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p className="text-sm font-medium">
                              {adj.ingredient}: {adj.current_quantity} → {adj.suggested_quantity}
                            </p>
                            <p className="text-xs text-slate-600 mt-1">{adj.reasoning}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
