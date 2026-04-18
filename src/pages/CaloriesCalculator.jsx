import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Trash2, Flame, Calculator, RotateCcw } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

const MACRO_COLORS = {
  protein: '#10b981',
  carbs: '#f59e0b',
  fat: '#ef4444',
  fiber: '#8b5cf6'
};

export default function CaloriesCalculator() {
  const [selectedItems, setSelectedItems] = useState([]);
  const [servings, setServings] = useState(1);

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const addItem = (type, id) => {
    if (!id) return;
    
    const existing = selectedItems.find(item => item.type === type && item.id === id);
    if (existing) return;

    if (type === 'ingredient') {
      const ingredient = ingredients.find(i => i.id === id);
      if (ingredient) {
        setSelectedItems([...selectedItems, {
          type: 'ingredient',
          id: ingredient.id,
          name: ingredient.name || ingredient.data?.name,
          quantity: 100,
          unit: 'g',
          calories_per_100g: ingredient.calories_per_100g || ingredient.data?.calories_per_100g || 0,
          protein_per_100g: ingredient.protein_per_100g || ingredient.data?.protein_per_100g || 0,
          carbs_per_100g: ingredient.carbs_per_100g || ingredient.data?.carbs_per_100g || 0,
          fat_per_100g: ingredient.fat_per_100g || ingredient.data?.fat_per_100g || 0,
          fiber_per_100g: ingredient.fiber_per_100g || ingredient.data?.fiber_per_100g || 0
        }]);
      }
    } else if (type === 'recipe') {
      const recipe = recipes.find(r => r.id === id);
      if (recipe) {
        setSelectedItems([...selectedItems, {
          type: 'recipe',
          id: recipe.id,
          name: recipe.name || recipe.data?.name,
          quantity: 1,
          unit: 'serving',
          calories_per_serving: recipe.calories_per_serving || recipe.data?.calories_per_serving || 0,
          servings: recipe.servings || recipe.data?.servings || 1
        }]);
      }
    }
  };

  const updateItemQuantity = (index, quantity) => {
    const updated = [...selectedItems];
    updated[index] = { ...updated[index], quantity: parseFloat(quantity) || 0 };
    setSelectedItems(updated);
  };

  const removeItem = (index) => {
    setSelectedItems(selectedItems.filter((_, i) => i !== index));
  };

  const calculations = useMemo(() => {
    let totalCalories = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;
    let totalFiber = 0;

    selectedItems.forEach(item => {
      if (item.type === 'ingredient') {
        const multiplier = item.quantity / 100;
        totalCalories += (item.calories_per_100g || 0) * multiplier;
        totalProtein += (item.protein_per_100g || 0) * multiplier;
        totalCarbs += (item.carbs_per_100g || 0) * multiplier;
        totalFat += (item.fat_per_100g || 0) * multiplier;
        totalFiber += (item.fiber_per_100g || 0) * multiplier;
      } else if (item.type === 'recipe') {
        totalCalories += (item.calories_per_serving || 0) * item.quantity;
      }
    });

    return {
      calories: Math.round(totalCalories * servings),
      protein: Math.round(totalProtein * servings * 10) / 10,
      carbs: Math.round(totalCarbs * servings * 10) / 10,
      fat: Math.round(totalFat * servings * 10) / 10,
      fiber: Math.round(totalFiber * servings * 10) / 10,
      perServing: Math.round(totalCalories)
    };
  }, [selectedItems, servings]);

  const macroChartData = [
    { name: 'Protein', value: calculations.protein, color: MACRO_COLORS.protein },
    { name: 'Carbs', value: calculations.carbs, color: MACRO_COLORS.carbs },
    { name: 'Fat', value: calculations.fat, color: MACRO_COLORS.fat },
    { name: 'Fiber', value: calculations.fiber, color: MACRO_COLORS.fiber }
  ].filter(m => m.value > 0);

  const resetCalculator = () => {
    setSelectedItems([]);
    setServings(1);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto">
        <PageHeader 
          title="Calories Calculator" 
          description="Calculate nutritional values for ingredients and recipes"
        >
          <Button variant="outline" onClick={resetCalculator}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset
          </Button>
        </PageHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Input Section */}
          <div className="lg:col-span-2 space-y-6">
            {/* Add Items */}
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calculator className="w-5 h-5 text-emerald-600" />
                  Add Items
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div>
                    <Label className="mb-2 block">Add Ingredient</Label>
                    <Select onValueChange={(value) => addItem('ingredient', value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select ingredient" />
                      </SelectTrigger>
                      <SelectContent>
                        {ingredients.map(ing => (
                          <SelectItem key={ing.id} value={ing.id}>
                            {ing.name || ing.data?.name} ({ing.calories_per_100g || ing.data?.calories_per_100g || 0} cal/100g)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-2 block">Add Recipe</Label>
                    <Select onValueChange={(value) => addItem('recipe', value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select recipe" />
                      </SelectTrigger>
                      <SelectContent>
                        {recipes.map(recipe => (
                          <SelectItem key={recipe.id} value={recipe.id}>
                            {recipe.name || recipe.data?.name} ({recipe.calories_per_serving || recipe.data?.calories_per_serving || 0} cal/serving)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Label>Number of Servings:</Label>
                  <Input
                    type="number"
                    min="1"
                    value={servings}
                    onChange={(e) => setServings(parseInt(e.target.value) || 1)}
                    className="w-24"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Selected Items */}
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">Selected Items</CardTitle>
              </CardHeader>
              <CardContent>
                {selectedItems.length === 0 ? (
                  <p className="text-center text-slate-500 py-8">
                    Add ingredients or recipes to calculate calories
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Calories</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedItems.map((item, index) => {
                        const itemCalories = item.type === 'ingredient'
                          ? Math.round((item.calories_per_100g || 0) * item.quantity / 100)
                          : Math.round((item.calories_per_serving || 0) * item.quantity);
                        
                        return (
                          <TableRow key={index}>
                            <TableCell className="font-medium">{item.name}</TableCell>
                            <TableCell className="capitalize">{item.type}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Input
                                  type="number"
                                  min="0"
                                  step={item.type === 'ingredient' ? '10' : '1'}
                                  value={item.quantity}
                                  onChange={(e) => updateItemQuantity(index, e.target.value)}
                                  className="w-20"
                                />
                                <span className="text-slate-500">{item.unit}</span>
                              </div>
                            </TableCell>
                            <TableCell className="font-medium text-orange-600">
                              {itemCalories} cal
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeItem(index)}
                                className="text-red-500 hover:text-red-600 hover:bg-red-50"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Results Section */}
          <div className="space-y-6">
            {/* Total Calories */}
            <Card className="border-slate-100 shadow-sm bg-gradient-to-br from-orange-50 to-amber-50">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-orange-100 flex items-center justify-center">
                    <Flame className="w-6 h-6 text-orange-600" />
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Total Calories</p>
                    <p className="text-3xl font-bold text-orange-900">{calculations.calories}</p>
                  </div>
                </div>
                {servings > 1 && (
                  <p className="text-sm text-orange-700">
                    {calculations.perServing} cal per serving × {servings} servings
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Macros Breakdown */}
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">Macros Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                {macroChartData.length > 0 ? (
                  <>
                    <div className="h-[200px] mb-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={macroChartData}
                            cx="50%"
                            cy="50%"
                            innerRadius={40}
                            outerRadius={70}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {macroChartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(value) => `${value}g`} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                          <span className="text-sm text-slate-600">Protein</span>
                        </div>
                        <span className="font-medium">{calculations.protein}g</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                          <span className="text-sm text-slate-600">Carbs</span>
                        </div>
                        <span className="font-medium">{calculations.carbs}g</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-red-500"></div>
                          <span className="text-sm text-slate-600">Fat</span>
                        </div>
                        <span className="font-medium">{calculations.fat}g</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-purple-500"></div>
                          <span className="text-sm text-slate-600">Fiber</span>
                        </div>
                        <span className="font-medium">{calculations.fiber}g</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-center text-slate-500 py-8">
                    Add items to see macro breakdown
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}