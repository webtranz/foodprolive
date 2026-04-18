import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { DollarSign } from 'lucide-react';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export default function CostBreakdownChart({ recipes, ingredients, filters }) {
  const costData = useMemo(() => {
    const recipeCosts = recipes
      .filter(r => filters.cuisineType === 'all' || r.cuisine_type === filters.cuisineType)
      .map(recipe => {
        let totalCost = 0;
        recipe.ingredients?.forEach(recipeIng => {
          const ingredient = ingredients.find(i => i.id === recipeIng.ingredient_id);
          if (ingredient?.cost_per_unit) {
            totalCost += (recipeIng.quantity || 0) * ingredient.cost_per_unit;
          }
        });
        
        return {
          name: recipe.name.length > 15 ? recipe.name.substring(0, 15) + '...' : recipe.name,
          cost: parseFloat(totalCost.toFixed(2)),
          costPerServing: recipe.servings ? parseFloat((totalCost / recipe.servings).toFixed(2)) : 0
        };
      })
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);

    return recipeCosts;
  }, [recipes, ingredients, filters]);

  const categoryData = useMemo(() => {
    const byCategory = {};
    ingredients.forEach(ing => {
      const cat = ing.category || 'other';
      if (!byCategory[cat]) {
        byCategory[cat] = { category: cat, totalValue: 0 };
      }
      byCategory[cat].totalValue += ing.cost_per_unit || 0;
    });
    return Object.values(byCategory).slice(0, 6);
  }, [ingredients]);

  const totalInventoryValue = ingredients.reduce((sum, i) => sum + (i.cost_per_unit || 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-green-600" />
          Cost Breakdown Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bg-green-50 rounded-lg p-4 mb-6">
          <p className="text-sm text-slate-600">Total Inventory Value</p>
          <p className="text-2xl font-bold text-green-700">${totalInventoryValue.toFixed(2)}</p>
        </div>

        <h4 className="font-medium mb-4">Top 10 Most Expensive Recipes</h4>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={costData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" angle={-45} textAnchor="end" height={100} />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="cost" fill="#10b981" name="Total Cost ($)" />
            <Bar dataKey="costPerServing" fill="#3b82f6" name="Cost per Serving ($)" />
          </BarChart>
        </ResponsiveContainer>

        <h4 className="font-medium mb-4 mt-8">Inventory Value by Category</h4>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={categoryData}
              dataKey="totalValue"
              nameKey="category"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={(entry) => entry.category.replace(/_/g, ' ')}
            >
              {categoryData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}