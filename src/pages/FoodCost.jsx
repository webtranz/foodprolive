import React, { useMemo, useState } from 'react';
import { format, subDays } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import StatCard from '@/components/ui/StatCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCSV, downloadExcel, downloadPDF } from '@/components/utils/exportData';
import { CircleDollarSign, Download, TrendingUp, UtensilsCrossed } from 'lucide-react';
import { formatCurrency, SAR_NAME } from '@/lib/currency';
import { calculateProductionIngredientCost } from '../../shared/ingredientUnits.js';

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function FoodCost() {
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    category: 'all',
    mealType: 'all',
    view: 'detail'
  });

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: recipes = [] } = useQuery({ queryKey: ['recipes'], queryFn: () => base44.entities.Recipe.list() });
  const { data: ingredients = [] } = useQuery({ queryKey: ['ingredients'], queryFn: () => base44.entities.Ingredient.list() });
  const { data: productions = [] } = useQuery({ queryKey: ['foodCostProductionsPage'], queryFn: () => base44.entities.Production.list('-production_date', 1000) });

  const ingredientMap = useMemo(
    () => Object.fromEntries(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients]
  );

  const categories = useMemo(() => {
    const values = new Set(recipes.map((recipe) => recipe.category).filter(Boolean));
    return [...values].sort();
  }, [recipes]);

  const filteredRows = useMemo(() => {
    const detailRows = productions
      .filter((production) => {
        if (!production.production_date || production.production_date < filters.startDate || production.production_date > filters.endDate) return false;
        if (filters.locationId !== 'all' && production.site_id !== filters.locationId) return false;
        const recipe = recipes.find((item) => item.id === production.recipe_id);
        const category = production.menu_category || recipe?.category || '';
        if (filters.category !== 'all' && category !== filters.category) return false;
        if (filters.mealType !== 'all' && (production.meal_type || 'unspecified') !== filters.mealType) return false;
        return true;
      })
      .map((production) => {
        const recalculatedEstimate = (production.ingredients_used || []).reduce(
          (sum, ingredient) => sum + calculateProductionIngredientCost(
            ingredient,
            ingredientMap[ingredient.ingredient_id]
          ),
          0
        );
        const totalCost = production.status === 'completed'
          ? safeNumber(production.production_cost_total ?? production.ingredient_cost_total) || recalculatedEstimate
          : recalculatedEstimate;
        const servings = safeNumber(production.actual_servings || production.target_servings);
        const recipe = recipes.find((item) => item.id === production.recipe_id);
        return {
          date: production.production_date,
          location: production.site_name,
          meal_type: titleCase(production.meal_type || 'unspecified'),
          recipe: production.recipe_name,
          category: production.menu_category || recipe?.category || '-',
          servings,
          total_cost: Number(totalCost.toFixed(2)),
          cost_per_serving: Number((servings > 0 ? totalCost / servings : 0).toFixed(2))
        };
      });

    if (filters.view === 'detail') return detailRows;

    const grouped = {};
    detailRows.forEach((row) => {
      const key = filters.view === 'daily'
        ? `${row.date}::${row.location}`
        : `${row.meal_type}::${row.location}`;
      if (!grouped[key]) {
        grouped[key] = {
          date: filters.view === 'daily' ? row.date : '',
          meal_type: filters.view === 'meal_type' ? row.meal_type : row.meal_type,
          location: row.location,
          total_servings: 0,
          total_cost: 0
        };
      }
      grouped[key].total_servings += safeNumber(row.servings);
      grouped[key].total_cost += safeNumber(row.total_cost);
    });

    return Object.values(grouped).map((row) => ({
      ...row,
      total_cost: Number(row.total_cost.toFixed(2)),
      cost_per_serving: Number((row.total_servings > 0 ? row.total_cost / row.total_servings : 0).toFixed(2))
    }));
  }, [filters, ingredientMap, productions, recipes]);

  const summary = useMemo(() => {
    const totalCost = filteredRows.reduce((sum, row) => sum + safeNumber(row.total_cost), 0);
    const servings = filteredRows.reduce((sum, row) => sum + safeNumber(row.servings ?? row.total_servings), 0);
    return {
      totalCost,
      servings,
      averageCostPerServing: servings > 0 ? totalCost / servings : 0
    };
  }, [filteredRows]);

  const exportRows = filteredRows.map((row) => ({
    ...row,
    total_cost: safeNumber(row.total_cost),
    cost_per_serving: safeNumber(row.cost_per_serving)
  }));

  const handleExport = (type) => {
    if (!exportRows.length) return;
    if (type === 'csv') {
      downloadCSV(exportRows, 'food_cost_report');
      return;
    }
    if (type === 'excel') {
      downloadExcel(exportRows, 'food_cost_report', 'Food Cost');
      return;
    }
    downloadPDF({
      title: 'Food Cost Report',
      subtitle: `Date: ${filters.startDate} to ${filters.endDate} | Meal type: ${filters.mealType === 'all' ? 'All' : titleCase(filters.mealType)} | View: ${titleCase(filters.view)}`,
      sections: [
        {
          heading: 'Summary',
          lines: [
            `Total cost: ${formatCurrency(summary.totalCost)}`,
            `Servings: ${summary.servings.toFixed(0)}`,
            `Average cost per serving: ${formatCurrency(summary.averageCostPerServing)}`
          ]
        },
        {
          heading: 'Rows',
          lines: exportRows.slice(0, 12).map((row) => JSON.stringify(row))
        }
      ],
      filename: 'food_cost_report'
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1680px] mx-auto space-y-6">
        <PageHeader
          title="Food Cost"
          description={`Daily, date-wise, and meal-type ${SAR_NAME} food cost reporting with direct exports`}
        >
          <Button variant="outline" onClick={() => handleExport('csv')}>
            <Download className="w-4 h-4 mr-2" />
            CSV
          </Button>
          <Button variant="outline" onClick={() => handleExport('excel')}>
            <Download className="w-4 h-4 mr-2" />
            Excel
          </Button>
          <Button variant="outline" onClick={() => handleExport('pdf')}>
            <Download className="w-4 h-4 mr-2" />
            PDF
          </Button>
        </PageHeader>

        <div className="grid gap-4 md:grid-cols-3">
          <StatCard title="Total Food Cost" value={formatCurrency(summary.totalCost)} icon={CircleDollarSign} iconBg="bg-amber-50" iconColor="text-amber-600" />
          <StatCard title="Servings" value={summary.servings.toFixed(0)} icon={UtensilsCrossed} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Avg. Cost / Serving" value={formatCurrency(summary.averageCostPerServing)} icon={TrendingUp} iconBg="bg-blue-50" iconColor="text-blue-600" />
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Food Cost Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
              <div>
                <Label>Start Date</Label>
                <Input type="date" className="mt-1" value={filters.startDate} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))} />
              </div>
              <div>
                <Label>End Date</Label>
                <Input type="date" className="mt-1" value={filters.endDate} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))} />
              </div>
              <div>
                <Label>Project / Location</Label>
                <Select value={filters.locationId} onValueChange={(value) => setFilters((current) => ({ ...current, locationId: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select value={filters.category} onValueChange={(value) => setFilters((current) => ({ ...current, category: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Meal Type</Label>
                <Select value={filters.mealType} onValueChange={(value) => setFilters((current) => ({ ...current, mealType: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Meal Types</SelectItem>
                    <SelectItem value="breakfast">Breakfast</SelectItem>
                    <SelectItem value="lunch">Lunch</SelectItem>
                    <SelectItem value="dinner">Dinner</SelectItem>
                    <SelectItem value="snack">Snack</SelectItem>
                    <SelectItem value="unspecified">Unspecified</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Report View</Label>
                <Select value={filters.view} onValueChange={(value) => setFilters((current) => ({ ...current, view: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="detail">Detailed</SelectItem>
                    <SelectItem value="daily">Daily Wise</SelectItem>
                    <SelectItem value="meal_type">Type Wise</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Food Cost Report</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {filteredRows.length ? Object.keys(filteredRows[0]).map((column) => (
                    <TableHead key={column}>{column.replace(/_/g, ' ')}</TableHead>
                  )) : (
                    <TableHead>Report</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-10 text-center text-slate-500">No food cost data available for this filter range.</TableCell>
                  </TableRow>
                ) : filteredRows.map((row, index) => (
                  <TableRow key={`${row.date || row.meal_type || 'row'}-${index}`}>
                    {Object.keys(filteredRows[0]).map((column) => (
                      <TableCell key={column}>
                        {column.includes('cost') ? formatCurrency(row[column]) : row[column]}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
