import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TrendingDown, DollarSign, Scale, Search, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadCSV } from '../components/utils/exportData';
import StatCard from '@/components/ui/StatCard';
import { Skeleton } from '@/components/ui/skeleton';
import YieldTemplateDownload from '../components/yield/YieldTemplateDownload';
import YieldUpload from '../components/yield/YieldUpload';
import CostReport from '../components/yield/CostReport';
import { formatCurrency } from '@/lib/currency';
import { calculateRecipeCostSnapshot } from '@/lib/menuPlanning';
import { getItemCode, putItemCodeAndNameFirst } from '../../shared/itemCode.js';

function averageBy(items, selector) {
  const values = items
    .map(selector)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export default function YieldCost() {
  const { isAdmin } = usePermissions();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCuisine, setSelectedCuisine] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const queryClient = useQueryClient();

  const { data: ingredients = [], isLoading } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const handleUploadSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['ingredients'] });
  };

  const filteredIngredients = ingredients.filter(ing => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || ing.name?.toLowerCase().includes(normalizedSearch)
      || getItemCode(ing, '').toLowerCase().includes(normalizedSearch);
    const matchesCuisine = selectedCuisine === 'all' || ing.cuisine_type === selectedCuisine;
    const matchesCategory = selectedCategory === 'all' || ing.category === selectedCategory;
    return matchesSearch && matchesCuisine && matchesCategory;
  });

  // Calculate statistics
  const avgYield = averageBy(filteredIngredients, (ing) => Number(ing.cooking_yield_percent));

  const avgShrinkage = averageBy(filteredIngredients, (ing) => Number(ing.shrinkage_percent));

  const avgCost = averageBy(filteredIngredients, (ing) => Number(ing.cost_per_unit));

  const totalInventoryValue = filteredIngredients.reduce((sum, ing) => sum + (ing.cost_per_unit || 0), 0).toFixed(2);

  // Calculate recipe costs
  const recipeCosts = recipes.map(recipe => {
    const costSnapshot = calculateRecipeCostSnapshot(recipe, ingredients, recipes);

    return {
      ...recipe,
      total_cost: costSnapshot.has_cost ? costSnapshot.total_cost : null,
      cost_per_serving: costSnapshot.has_cost ? costSnapshot.cost_per_serving : null
    };
  }).filter(r => r.total_cost !== null);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <PageHeader
          title="Yield & Cost Management"
          description="Track cooking yields, shrinkage, and cost analysis"
        >
          <Button
            variant="outline"
            onClick={() => downloadCSV(
              filteredIngredients.map((ingredient) => putItemCodeAndNameFirst(ingredient, {
                nameKey: 'name',
                outputNameKey: 'item_name'
              })),
              'yield-cost-data'
            )}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Avg Cooking Yield"
            value={`${avgYield.toFixed(1)}%`}
            subtitle="Weight retention"
            icon={Scale}
            iconColor="text-blue-600"
            bgColor="bg-blue-50"
          />
          <StatCard
            title="Avg Shrinkage"
            value={`${avgShrinkage.toFixed(1)}%`}
            subtitle="Weight loss"
            icon={TrendingDown}
            iconColor="text-red-600"
            bgColor="bg-red-50"
          />
          <StatCard
            title="Avg Cost/Unit"
            value={formatCurrency(avgCost)}
            subtitle="Per ingredient"
            icon={DollarSign}
            iconColor="text-green-600"
            bgColor="bg-green-50"
          />
          <StatCard
            title="Total Value"
            value={formatCurrency(totalInventoryValue, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            subtitle="All ingredients"
            icon={DollarSign}
            iconColor="text-purple-600"
            bgColor="bg-purple-50"
          />
        </div>

        {/* Templates and Upload */}
        <Card>
          <CardHeader>
            <CardTitle>Yield Data Management</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <YieldTemplateDownload />
            {isAdmin ? (
              <YieldUpload isAdmin onSuccess={handleUploadSuccess} />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                Yield templates remain available for download. Uploading yield data is restricted to administrators.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cost Reports */}
        <CostReport ingredients={ingredients} recipes={recipes} />

        <Tabs defaultValue="ingredients" className="w-full">
          <TabsList>
            <TabsTrigger value="ingredients">Ingredient Yields</TabsTrigger>
            <TabsTrigger value="recipes">Recipe Costs</TabsTrigger>
          </TabsList>

          <TabsContent value="ingredients" className="space-y-4">
            {/* Filters */}
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search ingredients..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  <Select value={selectedCuisine} onValueChange={setSelectedCuisine}>
                    <SelectTrigger className="w-full sm:w-[200px]">
                      <SelectValue placeholder="Cuisine" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Cuisines</SelectItem>
                      <SelectItem value="universal">Universal</SelectItem>
                      <SelectItem value="continental">Continental</SelectItem>
                      <SelectItem value="desi">Desi</SelectItem>
                      <SelectItem value="italian">Italian</SelectItem>
                      <SelectItem value="chinese">Chinese</SelectItem>
                      <SelectItem value="japanese">Japanese</SelectItem>
                      <SelectItem value="korean">Korean</SelectItem>
                      <SelectItem value="thai">Thai</SelectItem>
                      <SelectItem value="middle_eastern">Middle Eastern</SelectItem>
                      <SelectItem value="mediterranean">Mediterranean</SelectItem>
                      <SelectItem value="mexican">Mexican</SelectItem>
                      <SelectItem value="latin_american">Latin American</SelectItem>
                      <SelectItem value="african">African</SelectItem>
                      <SelectItem value="seafood">Seafood</SelectItem>
                      <SelectItem value="vegetarian">Vegetarian</SelectItem>
                      <SelectItem value="vegan">Vegan</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                    <SelectTrigger className="w-full sm:w-[200px]">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      <SelectItem value="proteins_meat">Meat</SelectItem>
                      <SelectItem value="proteins_poultry">Poultry</SelectItem>
                      <SelectItem value="proteins_seafood">Seafood</SelectItem>
                      <SelectItem value="vegetables">Vegetables</SelectItem>
                      <SelectItem value="grains_cereals">Grains</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* Ingredients Table */}
            <Card>
              <CardHeader>
                <CardTitle>Ingredient Yield & Cost Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12" />)}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item Code</TableHead>
                          <TableHead>Item Name</TableHead>
                          <TableHead>Cuisine</TableHead>
                          <TableHead>Category</TableHead>
                          <TableHead className="text-right">Raw Weight (g)</TableHead>
                          <TableHead className="text-right">Cooked Weight (g)</TableHead>
                          <TableHead className="text-right">Yield %</TableHead>
                          <TableHead className="text-right">Shrinkage %</TableHead>
                          <TableHead className="text-right">Cost/Unit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredIngredients.map(ingredient => (
                          <TableRow key={ingredient.id}>
                            <TableCell className="font-mono text-xs text-slate-600">{getItemCode(ingredient)}</TableCell>
                            <TableCell className="font-medium">{ingredient.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="capitalize">
                                {ingredient.cuisine_type?.replace(/_/g, ' ')}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              {ingredient.category?.replace(/_/g, ' ')}
                            </TableCell>
                            <TableCell className="text-right">{ingredient.raw_weight_per_unit || '-'}</TableCell>
                            <TableCell className="text-right">{ingredient.cooked_weight_per_unit || '-'}</TableCell>
                            <TableCell className="text-right">
                              {ingredient.cooking_yield_percent ? (
                                <Badge className="bg-blue-100 text-blue-700">
                                  {ingredient.cooking_yield_percent}%
                                </Badge>
                              ) : '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              {ingredient.shrinkage_percent ? (
                                <Badge className="bg-red-100 text-red-700">
                                  {ingredient.shrinkage_percent}%
                                </Badge>
                              ) : '-'}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {ingredient.cost_per_unit ? formatCurrency(ingredient.cost_per_unit) : '-'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="recipes" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Recipe Cost Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipe</TableHead>
                        <TableHead>Cuisine</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Servings</TableHead>
                        <TableHead className="text-right">Total Cost</TableHead>
                        <TableHead className="text-right">Cost/Serving</TableHead>
                        <TableHead className="text-right">Calories/Serving</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recipeCosts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center py-8 text-slate-500">
                            No recipes with cost data available
                          </TableCell>
                        </TableRow>
                      ) : (
                        recipeCosts.map(recipe => (
                          <TableRow key={recipe.id}>
                            <TableCell className="font-medium">{recipe.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="capitalize">
                                {recipe.cuisine_type?.replace(/_/g, ' ')}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-slate-600 capitalize">
                              {recipe.category}
                            </TableCell>
                            <TableCell className="text-right">{recipe.servings}</TableCell>
                            <TableCell className="text-right font-semibold text-green-700">
                              {formatCurrency(recipe.total_cost)}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {recipe.cost_per_serving != null ? formatCurrency(recipe.cost_per_serving) : '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              {recipe.calories_per_serving || '-'}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
