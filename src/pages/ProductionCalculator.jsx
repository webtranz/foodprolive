import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Factory, Users, Scale, TrendingDown, AlertCircle, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/currency';
import { calculateIngredientCost } from '../../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';
import { calculateYieldAdjustedQuantity } from '../../shared/ingredientYield.js';
import { calculateRecipeServingWeight } from '../../shared/recipeWeight.js';

export default function ProductionCalculator() {
  const [selectedRecipe, setSelectedRecipe] = useState('');
  const [targetServings, setTargetServings] = useState('');
  const [targetWeight, setTargetWeight] = useState('');
  const [calculationMode, setCalculationMode] = useState('servings'); // 'servings' or 'weight'
  const [calculations, setCalculations] = useState(null);

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  useEffect(() => {
    if (!selectedRecipe) {
      setCalculations(null);
      return;
    }

    const recipe = recipes.find(r => r.id === selectedRecipe);
    const recipeData = recipe?.data || recipe;
    const recipeIngredients = expandRecipeIngredients(
      recipeData,
      recipes,
      ingredients,
      { aggregate: true }
    ).ingredients;
    
    if (!recipe || !recipeIngredients || recipeIngredients.length === 0) {
      setCalculations(null);
      return;
    }

    let multiplier = 0;

    if (calculationMode === 'servings' && targetServings) {
      multiplier = parseFloat(targetServings) / (recipeData.servings || 1);
    } else if (calculationMode === 'weight' && targetWeight) {
      const recipeWeight = calculateRecipeServingWeight(recipeData, recipes, ingredients);
      const totalRecipeWeight = recipeWeight.raw_total_grams || 0;
      if (totalRecipeWeight > 0) {
        multiplier = (parseFloat(targetWeight) * 1000) / totalRecipeWeight;
      }
    }

    if (multiplier === 0) {
      setCalculations(null);
      return;
    }

    const calculatedIngredients = recipeIngredients.map(ing => {
      const ingredientData = ingredients.find(i => i.id === ing.ingredient_id);
      const ingData = ingredientData?.data || ingredientData;
      const netQuantity = (ing.quantity || 0) * multiplier;
      const yieldAdjustment = calculateYieldAdjustedQuantity(netQuantity, ingData);
      const rawRequiredQuantity = yieldAdjustment.required_raw_quantity;
      const estimatedCost = calculateIngredientCost(rawRequiredQuantity, ing.unit, ingData);
      
      return {
        id: ing.ingredient_id,
        name: ing.ingredient_name,
        netQuantity: Number(netQuantity.toFixed(4)),
        rawRequiredQuantity: Number(rawRequiredQuantity.toFixed(4)),
        unit: ing.unit,
        yieldPercent: Number(yieldAdjustment.yield_percent.toFixed(2)),
        yieldSource: yieldAdjustment.yield_source,
        estimatedCost: Math.round(estimatedCost * 100) / 100,
        category: ingData?.category,
        sourceRecipeNames: ing.source_recipe_names || []
      };
    });

    const totalCost = calculatedIngredients.reduce((sum, ing) => sum + ing.estimatedCost, 0);
    const estimatedServings = calculationMode === 'servings' 
      ? parseFloat(targetServings) 
      : Math.round((recipeData.servings || 1) * multiplier);
    
    setCalculations({
      recipe: recipeData,
      multiplier,
      ingredients: calculatedIngredients,
      totalCost: Math.round(totalCost * 100) / 100,
      totalCalories: Math.round((recipeData.calories_per_serving || 0) * estimatedServings),
      estimatedServings,
      costPerServing: estimatedServings > 0 ? Math.round((totalCost / estimatedServings) * 100) / 100 : 0
    });
  }, [selectedRecipe, targetServings, targetWeight, calculationMode, recipes, ingredients]);

  const printCalculations = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto">
        <PageHeader 
          title="Production Calculator" 
          description="Calculate ingredient quantities for scaled production"
        >
          {calculations && (
            <Button variant="outline" onClick={printCalculations}>
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
          )}
        </PageHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Input Section */}
          <Card className="border-slate-100 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Factory className="w-5 h-5 text-emerald-600" />
                Production Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Select Recipe</Label>
                <Select value={selectedRecipe} onValueChange={setSelectedRecipe}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Choose a recipe" />
                  </SelectTrigger>
                  <SelectContent>
                    {recipes.map(recipe => {
                      const data = recipe.data || recipe;
                      return (
                        <SelectItem key={recipe.id} value={recipe.id}>
                          {data.name} ({data.servings} servings)
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Calculation Mode</Label>
                <Select value={calculationMode} onValueChange={setCalculationMode}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="servings">By Servings</SelectItem>
                    <SelectItem value="weight">By Target Weight (kg)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {calculationMode === 'servings' ? (
                <div>
                  <Label>Target Servings</Label>
                  <Input
                    type="number"
                    min="1"
                    value={targetServings}
                    onChange={(e) => setTargetServings(e.target.value)}
                    placeholder="e.g., 100"
                    className="mt-1"
                  />
                </div>
              ) : (
                <div>
                  <Label>Target Finished Weight (kg)</Label>
                  <Input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={targetWeight}
                    onChange={(e) => setTargetWeight(e.target.value)}
                    placeholder="e.g., 10"
                    className="mt-1"
                  />
                </div>
              )}

              {selectedRecipe && (
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                  <p className="text-sm text-blue-700 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    Raw issue quantities are calculated from each ingredient's cooking yield
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Results Section */}
          <div className="lg:col-span-2 space-y-6">
            {calculations ? (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Card className="border-slate-100 shadow-sm">
                    <CardContent className="p-4 text-center">
                      <Users className="w-6 h-6 text-emerald-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-slate-900">{calculations.estimatedServings}</p>
                      <p className="text-xs text-slate-500">Servings</p>
                    </CardContent>
                  </Card>
                  <Card className="border-slate-100 shadow-sm">
                    <CardContent className="p-4 text-center">
                      <Scale className="w-6 h-6 text-blue-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-slate-900">{calculations.multiplier.toFixed(1)}x</p>
                      <p className="text-xs text-slate-500">Scale Factor</p>
                    </CardContent>
                  </Card>
                  <Card className="border-slate-100 shadow-sm">
                    <CardContent className="p-4 text-center">
                      <TrendingDown className="w-6 h-6 text-amber-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-slate-900">{formatCurrency(calculations.totalCost)}</p>
                      <p className="text-xs text-slate-500">Est. Cost</p>
                    </CardContent>
                  </Card>
                  <Card className="border-slate-100 shadow-sm">
                    <CardContent className="p-4 text-center">
                      <Factory className="w-6 h-6 text-orange-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-slate-900">{calculations.totalCalories}</p>
                      <p className="text-xs text-slate-500">Total Cal</p>
                    </CardContent>
                  </Card>
                </div>

                {/* Ingredients Table */}
                <Card className="border-slate-100 shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      Required Ingredients for "{calculations.recipe.name}"
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Ingredient</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead>Net Recipe Qty</TableHead>
                            <TableHead>Yield</TableHead>
                            <TableHead>Raw Required</TableHead>
                            <TableHead>Est. Cost</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {calculations.ingredients.map((ing, index) => (
                            <TableRow key={index}>
                              <TableCell className="font-medium">{ing.name}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className="capitalize">
                                  {ing.category || 'other'}
                                </Badge>
                              </TableCell>
                              <TableCell>{ing.netQuantity} {ing.unit}</TableCell>
                              <TableCell>{ing.yieldPercent}%</TableCell>
                              <TableCell className="font-semibold text-emerald-600">
                                {ing.rawRequiredQuantity} {ing.unit}
                              </TableCell>
                              <TableCell>{formatCurrency(ing.estimatedCost)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    <div className="mt-4 pt-4 border-t border-slate-100 flex justify-between items-center">
                      <span className="text-slate-600">Cost per serving:</span>
                      <span className="text-lg font-bold text-slate-900">{formatCurrency(calculations.costPerServing)}</span>
                    </div>
                  </CardContent>
                </Card>

                {/* Production Tips */}
                <Card className="border-slate-100 shadow-sm bg-gradient-to-r from-emerald-50 to-teal-50">
                  <CardContent className="p-6">
                    <h3 className="font-semibold text-emerald-900 mb-3">Production Tips</h3>
                    <ul className="space-y-2 text-sm text-emerald-800">
                      <li>• Raw requirements use net recipe quantity ÷ ingredient cooking yield</li>
                      <li>• Verify inventory levels before starting production</li>
                      <li>• Track actual usage vs. planned for waste analysis</li>
                      <li>• Prep time: {calculations.recipe.prep_time_minutes || 0} min, Cook time: {calculations.recipe.cook_time_minutes || 0} min</li>
                    </ul>
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card className="border-slate-100 shadow-sm">
                <CardContent className="p-12 text-center">
                  <Factory className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-slate-700 mb-2">
                    Production Calculator
                  </h3>
                  <p className="text-slate-500">
                    Select a recipe and enter target servings or weight to calculate ingredient requirements
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
