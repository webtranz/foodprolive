import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { DollarSign, TrendingDown, Download, Target, ChefHat, AlertCircle } from 'lucide-react';
import { format, subDays } from 'date-fns';
import StatCard from '@/components/ui/StatCard';
import { downloadCSV } from '../components/utils/exportData';
import { formatCurrency, SAR_SYMBOL } from '@/lib/currency';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export default function CostControl() {
  const [selectedSite, setSelectedSite] = useState('all');
  const [dateRange, setDateRange] = useState('month');

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: productions = [] } = useQuery({ queryKey: ['productions'], queryFn: () => base44.entities.Production.list('-production_date', 500) });
  const { data: foodWaste = [] } = useQuery({ queryKey: ['foodWaste'], queryFn: () => base44.entities.FoodWaste.list('-waste_date', 500) });
  const { data: recipes = [] } = useQuery({ queryKey: ['recipes'], queryFn: () => base44.entities.Recipe.list() });
  const { data: ingredients = [] } = useQuery({ queryKey: ['ingredients'], queryFn: () => base44.entities.Ingredient.list() });

  const dateFilter = useMemo(() => {
    const today = new Date();
    if (dateRange === 'week') return subDays(today, 7);
    if (dateRange === 'month') return subDays(today, 30);
    if (dateRange === 'quarter') return subDays(today, 90);
    return subDays(today, 365);
  }, [dateRange]);

  const filteredProductions = useMemo(() => productions.filter(p => {
    const matchesSite = selectedSite === 'all' || p.site_id === selectedSite;
    const matchesDate = new Date(p.production_date) >= dateFilter;
    return matchesSite && matchesDate && p.status === 'completed';
  }), [productions, selectedSite, dateFilter]);

  const filteredWaste = useMemo(() => foodWaste.filter(w => {
    const matchesSite = selectedSite === 'all' || w.site_id === selectedSite;
    const matchesDate = new Date(w.waste_date) >= dateFilter;
    return matchesSite && matchesDate;
  }), [foodWaste, selectedSite, dateFilter]);

  // Calculate ingredient costs from productions
  const ingredientCosts = useMemo(() => {
    const costMap = {};
    filteredProductions.forEach(prod => {
      (prod.ingredients_used || []).forEach(ing => {
        const ingData = ingredients.find(i => i.id === ing.ingredient_id);
        const costPerUnit = ingData?.cost_per_unit || 0;
        const qty = ing.actual_quantity || ing.planned_quantity || 0;
        const cost = qty * costPerUnit;
        if (!costMap[ing.ingredient_id]) {
          costMap[ing.ingredient_id] = { name: ing.ingredient_name, totalQty: 0, totalCost: 0, unit: ing.unit };
        }
        costMap[ing.ingredient_id].totalQty += qty;
        costMap[ing.ingredient_id].totalCost += cost;
      });
    });
    return Object.values(costMap).sort((a, b) => b.totalCost - a.totalCost);
  }, [filteredProductions, ingredients]);

  const totalIngredientCost = ingredientCosts.reduce((sum, i) => sum + i.totalCost, 0);
  const totalServings = filteredProductions.reduce((sum, p) => sum + (p.actual_servings || p.target_servings || 0), 0);
  const costPerMeal = totalServings > 0 ? totalIngredientCost / totalServings : 0;
  const totalWasteCost = filteredWaste.reduce((sum, w) => sum + (w.estimated_cost || 0), 0);
  const foodCostPercent = totalIngredientCost > 0 ? (totalWasteCost / totalIngredientCost) * 100 : 0;

  // Recipe cost analysis
  const recipeCostData = useMemo(() => {
    const recipeMap = {};
    filteredProductions.forEach(prod => {
      if (!prod.recipe_id) return;
      if (!recipeMap[prod.recipe_id]) {
        recipeMap[prod.recipe_id] = { name: prod.recipe_name, totalServings: 0, totalCost: 0, productions: 0 };
      }
      recipeMap[prod.recipe_id].totalServings += prod.actual_servings || prod.target_servings || 0;
      recipeMap[prod.recipe_id].productions += 1;
      const ingCost = (prod.ingredients_used || []).reduce((sum, ing) => {
        const ingData = ingredients.find(i => i.id === ing.ingredient_id);
        const qty = ing.actual_quantity || ing.planned_quantity || 0;
        return sum + (qty * (ingData?.cost_per_unit || 0));
      }, 0);
      recipeMap[prod.recipe_id].totalCost += ingCost;
    });
    return Object.values(recipeMap).map(r => ({
      ...r,
      costPerServing: r.totalServings > 0 ? r.totalCost / r.totalServings : 0
    })).sort((a, b) => b.costPerServing - a.costPerServing);
  }, [filteredProductions, ingredients]);

  // Daily cost trend
  const dailyCostTrend = useMemo(() => {
    const dayMap = {};
    filteredProductions.forEach(prod => {
      const day = prod.production_date;
      if (!dayMap[day]) dayMap[day] = { date: day, cost: 0, servings: 0 };
      const ingCost = (prod.ingredients_used || []).reduce((sum, ing) => {
        const ingData = ingredients.find(i => i.id === ing.ingredient_id);
        const qty = ing.actual_quantity || ing.planned_quantity || 0;
        return sum + (qty * (ingData?.cost_per_unit || 0));
      }, 0);
      dayMap[day].cost += ingCost;
      dayMap[day].servings += prod.actual_servings || prod.target_servings || 0;
    });
    return Object.values(dayMap)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-14)
      .map(d => ({
        ...d,
        dateLabel: format(new Date(d.date), 'MMM d'),
        costPerMeal: d.servings > 0 ? d.cost / d.servings : 0
      }));
  }, [filteredProductions, ingredients]);

  // Ingredient cost pie
  const topIngCosts = ingredientCosts.slice(0, 6).map((i, idx) => ({
    name: i.name.length > 15 ? i.name.substring(0, 15) + '…' : i.name,
    value: Math.round(i.totalCost * 100) / 100
  }));

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader title="Cost Control" description="Track food cost, cost per meal, and budget performance">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[150px] bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sites</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[130px] bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="month">Last 30 days</SelectItem>
              <SelectItem value="quarter">Last 90 days</SelectItem>
              <SelectItem value="year">Last year</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => downloadCSV(ingredientCosts, 'cost_control')}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
        </PageHeader>

        {/* KPI Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard title="Total Food Cost" value={formatCurrency(totalIngredientCost)} icon={DollarSign} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Cost per Meal" value={formatCurrency(costPerMeal)} icon={ChefHat} iconBg="bg-blue-50" iconColor="text-blue-600" />
          <StatCard title="Waste Cost" value={formatCurrency(totalWasteCost)} icon={TrendingDown} iconBg="bg-red-50" iconColor="text-red-600" />
          <StatCard title="Waste Cost %" value={`${foodCostPercent.toFixed(1)}%`} icon={Target} iconBg="bg-amber-50" iconColor="text-amber-600" />
        </div>

        <Tabs defaultValue="trends" className="space-y-6">
          <TabsList className="bg-white border border-slate-200">
            <TabsTrigger value="trends">Cost Trends</TabsTrigger>
            <TabsTrigger value="recipes">Recipe Costs</TabsTrigger>
            <TabsTrigger value="ingredients">Ingredient Costs</TabsTrigger>
          </TabsList>

          <TabsContent value="trends">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-slate-100 shadow-sm">
                <CardHeader><CardTitle>Daily Total Cost</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dailyCostTrend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={v => formatCurrency(v)} />
                        <Bar dataKey="cost" fill="#10b981" radius={[4, 4, 0, 0]} name={`Cost (${SAR_SYMBOL})`} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-100 shadow-sm">
                <CardHeader><CardTitle>Cost per Meal Trend</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyCostTrend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={v => formatCurrency(v)} />
                        <Line type="monotone" dataKey="costPerMeal" stroke="#3b82f6" strokeWidth={2} dot={false} name={`${SAR_SYMBOL}/meal`} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="recipes">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader><CardTitle>Recipe Cost Analysis</CardTitle></CardHeader>
              <CardContent>
                {recipeCostData.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <AlertCircle className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    No production cost data for selected period
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipe</TableHead>
                        <TableHead>Total Servings</TableHead>
                        <TableHead>Total Cost</TableHead>
                        <TableHead>Cost/Serving</TableHead>
                        <TableHead>Productions</TableHead>
                        <TableHead>Rating</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recipeCostData.map((recipe, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-medium">{recipe.name}</TableCell>
                          <TableCell>{recipe.totalServings.toLocaleString()}</TableCell>
                          <TableCell>{formatCurrency(recipe.totalCost)}</TableCell>
                          <TableCell className="font-semibold">{formatCurrency(recipe.costPerServing)}</TableCell>
                          <TableCell>{recipe.productions}</TableCell>
                          <TableCell>
                            <Badge className={recipe.costPerServing < 2 ? 'bg-emerald-100 text-emerald-700' : recipe.costPerServing < 5 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}>
                              {recipe.costPerServing < 2 ? 'Efficient' : recipe.costPerServing < 5 ? 'Moderate' : 'Expensive'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ingredients">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-slate-100 shadow-sm">
                <CardHeader><CardTitle>Top Ingredient Costs</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={topIngCosts} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                          {topIngCosts.map((_, idx) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={v => formatCurrency(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-100 shadow-sm">
                <CardHeader><CardTitle>Ingredient Cost Breakdown</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Qty Used</TableHead>
                        <TableHead>Total Cost</TableHead>
                        <TableHead>% of Budget</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ingredientCosts.slice(0, 10).map((ing, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-medium">{ing.name}</TableCell>
                          <TableCell>{ing.totalQty.toFixed(1)} {ing.unit}</TableCell>
                          <TableCell>{formatCurrency(ing.totalCost)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-slate-100 rounded-full h-1.5">
                                <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: `${totalIngredientCost > 0 ? Math.min(100, (ing.totalCost / totalIngredientCost) * 100) : 0}%` }} />
                              </div>
                              <span className="text-xs text-slate-600">
                                {totalIngredientCost > 0 ? ((ing.totalCost / totalIngredientCost) * 100).toFixed(1) : 0}%
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {ingredientCosts.length === 0 && (
                        <TableRow><TableCell colSpan={4} className="text-center text-slate-500 py-8">No cost data available</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
