import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, FileText, DollarSign, TrendingUp } from 'lucide-react';
import { downloadCSV } from '../utils/exportData';
import { format } from 'date-fns';
import { formatCurrency } from '@/lib/currency';
import { calculateRecipeCostSnapshot } from '@/lib/menuPlanning';

function averageBy(items, selector) {
  const values = items
    .map(selector)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export default function CostReport({ ingredients = [], recipes = [] }) {
  const generateCostReport = () => {
    const reportData = ingredients.map(ing => ({
      ingredient: ing.name,
      cuisine: ing.cuisine_type,
      category: ing.category,
      unit: ing.unit,
      cost_per_unit: ing.cost_per_unit || 0,
      yield_percent: ing.cooking_yield_percent || 100,
      shrinkage_percent: ing.shrinkage_percent || 0,
      effective_cost: ing.cost_per_unit && ing.cooking_yield_percent 
        ? (ing.cost_per_unit / (ing.cooking_yield_percent / 100)).toFixed(2)
        : ing.cost_per_unit || 0
    }));

    downloadCSV(reportData, `cost_report_${format(new Date(), 'yyyy-MM-dd')}`);
  };

  const generateRecipeCostReport = () => {
    const recipeCosts = recipes.map(recipe => {
      const costSnapshot = calculateRecipeCostSnapshot(recipe, ingredients, recipes);
      const totalCost = costSnapshot.has_cost ? costSnapshot.total_cost : 0;

      const servings = Number(recipe.servings) || 0;
      const caloriesPerServing = Number(recipe.calories_per_serving) || 0;

      return {
        recipe: recipe.name,
        cuisine: recipe.cuisine_type,
        category: recipe.category,
        servings: servings || '',
        total_cost: totalCost.toFixed(2),
        cost_per_serving: servings > 0 ? (totalCost / servings).toFixed(2) : '',
        calories_per_serving: caloriesPerServing || 0,
        cost_per_calorie: servings > 0 && caloriesPerServing > 0
          ? (totalCost / servings / caloriesPerServing * 100).toFixed(4)
          : 0
      };
    });

    downloadCSV(recipeCosts, `recipe_cost_report_${format(new Date(), 'yyyy-MM-dd')}`);
  };

  const generateYieldReport = () => {
    const yieldData = ingredients
      .filter(ing => ing.cooking_yield_percent || ing.shrinkage_percent)
      .map(ing => ({
        ingredient: ing.name,
        cuisine: ing.cuisine_type,
        category: ing.category,
        raw_weight: ing.raw_weight_per_unit || 0,
        cooked_weight: ing.cooked_weight_per_unit || 0,
        yield_percent: ing.cooking_yield_percent || 0,
        shrinkage_percent: ing.shrinkage_percent || 0,
        cost_per_unit: ing.cost_per_unit || 0,
        effective_cost_per_kg: ing.cost_per_unit && ing.cooking_yield_percent
          ? ((ing.cost_per_unit / (ing.cooking_yield_percent / 100)) * 1000 / (ing.raw_weight_per_unit || 1000)).toFixed(2)
          : 0
      }));

    downloadCSV(yieldData, `yield_report_${format(new Date(), 'yyyy-MM-dd')}`);
  };

  const totalInventoryValue = ingredients.reduce((sum, ing) => sum + (ing.cost_per_unit || 0), 0);
  const avgYield = averageBy(ingredients, (ing) => Number(ing.cooking_yield_percent));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600">Total Inventory Value</p>
                <p className="text-2xl font-bold text-green-700">{formatCurrency(totalInventoryValue)}</p>
              </div>
              <DollarSign className="w-8 h-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600">Average Yield</p>
                <p className="text-2xl font-bold text-blue-700">{avgYield.toFixed(1)}%</p>
              </div>
              <TrendingUp className="w-8 h-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Downloadable Reports
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Button onClick={generateCostReport} variant="outline" className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Ingredient Cost Report
            </Button>

            <Button onClick={generateRecipeCostReport} variant="outline" className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Recipe Cost Report
            </Button>

            <Button onClick={generateYieldReport} variant="outline" className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Yield Analysis Report
            </Button>
          </div>

          <p className="text-xs text-slate-500 mt-2">
            Reports include effective costs adjusted for cooking yields and shrinkage
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
