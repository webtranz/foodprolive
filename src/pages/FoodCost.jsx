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
import {
  buildConfirmedFoodCostRows,
  buildPendingProductionRows,
  groupFoodCostRows,
  safeFoodCostNumber,
  titleCaseFoodCost
} from '../../shared/foodCostReport.js';

export default function FoodCost() {
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    category: 'all',
    mealType: 'all',
    menuType: 'all',
    view: 'detail'
  });

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: recipes = [] } = useQuery({ queryKey: ['recipes'], queryFn: () => base44.entities.Recipe.list() });
  const { data: ingredients = [] } = useQuery({ queryKey: ['ingredients'], queryFn: () => base44.entities.Ingredient.list() });
  const { data: productions = [] } = useQuery({ queryKey: ['foodCostProductionsPage'], queryFn: () => base44.entities.Production.list('-production_date', 5000) });
  const { data: mealServiceConsumptions = [] } = useQuery({ queryKey: ['foodCostMealServiceConsumptionsPage'], queryFn: () => base44.entities.MealServiceConsumption.list('-service_date', 5000) });
  const { data: producedItemBatches = [] } = useQuery({ queryKey: ['foodCostProducedItemBatchesPage'], queryFn: () => base44.entities.ProducedItemBatch.list('-production_date', 5000) });

  const recipeMap = useMemo(
    () => new Map(recipes.map((recipe) => [String(recipe.id), recipe])),
    [recipes]
  );
  const relatedLocationIds = useMemo(() => {
    if (filters.locationId === 'all') return null;
    const siteMap = new Map(sites.map((site) => [String(site.id), site]));
    const related = new Set([String(filters.locationId)]);

    let selectedCursor = siteMap.get(String(filters.locationId));
    while (selectedCursor?.parent_site_id) {
      related.add(String(selectedCursor.parent_site_id));
      selectedCursor = siteMap.get(String(selectedCursor.parent_site_id));
    }

    sites.forEach((site) => {
      let cursor = site;
      while (cursor?.parent_site_id) {
        if (String(cursor.parent_site_id) === String(filters.locationId)) {
          related.add(String(site.id));
          break;
        }
        cursor = siteMap.get(String(cursor.parent_site_id));
      }
    });

    return related;
  }, [filters.locationId, sites]);

  const categories = useMemo(() => {
    const values = new Set();
    recipes.forEach((recipe) => { if (recipe.category) values.add(recipe.category); });
    productions.forEach((production) => { if (production.menu_category) values.add(production.menu_category); });
    mealServiceConsumptions.forEach((consumption) => { if (consumption.menu_category) values.add(consumption.menu_category); });
    return [...values].sort();
  }, [mealServiceConsumptions, productions, recipes]);

  const menuTypes = useMemo(() => {
    const values = new Set();
    recipes.forEach((recipe) => {
      const value = recipe.menu_type || recipe.cuisine_type;
      if (value) values.add(value);
    });
    productions.forEach((production) => {
      const value = production.menu_type || production.cuisine_type;
      if (value) values.add(value);
    });
    mealServiceConsumptions.forEach((consumption) => {
      if (consumption.menu_type) values.add(consumption.menu_type);
    });
    return [...values].sort();
  }, [mealServiceConsumptions, productions, recipes]);

  const filteredSourceData = useMemo(() => {
    const matchesDate = (value) => value && value >= filters.startDate && value <= filters.endDate;
    const matchesLocation = (siteId) => filters.locationId === 'all' || relatedLocationIds?.has(String(siteId || ''));
    const matchesCategory = (category) => filters.category === 'all' || category === filters.category;
    const matchesMealType = (mealType) => filters.mealType === 'all' || (mealType || 'unspecified') === filters.mealType;
    const matchesMenuType = (menuType) => filters.menuType === 'all' || (menuType || 'general') === filters.menuType;

    const filteredProductions = productions.filter((production) => {
      const recipe = recipeMap.get(String(production.recipe_id || ''));
      const category = production.menu_category || recipe?.category || '';
      const menuType = production.menu_type || production.cuisine_type || recipe?.menu_type || recipe?.cuisine_type || 'general';
      return matchesDate(production.production_date)
        && matchesLocation(production.site_id)
        && matchesCategory(category)
        && matchesMealType(production.meal_type)
        && matchesMenuType(menuType);
    });

    const filteredConsumptions = mealServiceConsumptions.filter((consumption) => {
      const recipe = recipeMap.get(String(consumption.recipe_id || ''));
      const category = consumption.menu_category || recipe?.category || '';
      const menuType = consumption.menu_type || recipe?.menu_type || recipe?.cuisine_type || 'general';
      return matchesDate(consumption.service_date)
        && matchesLocation(consumption.site_id)
        && matchesCategory(category)
        && matchesMealType(consumption.meal_type)
        && matchesMenuType(menuType);
    });

    return {
      consumptions: filteredConsumptions,
      productions: filteredProductions
    };
  }, [filters, mealServiceConsumptions, productions, recipeMap, relatedLocationIds]);

  const filteredRows = useMemo(() => {
    const detailRows = buildConfirmedFoodCostRows({
      consumptions: filteredSourceData.consumptions,
      productions,
      producedItemBatches,
      recipes,
      ingredients
    });
    return groupFoodCostRows(detailRows, filters.view);
  }, [filteredSourceData.consumptions, filters.view, ingredients, producedItemBatches, productions, recipes]);

  const pendingProductionRows = useMemo(() => buildPendingProductionRows({
    consumptions: mealServiceConsumptions,
    productions: filteredSourceData.productions,
    producedItemBatches,
    recipes,
    ingredients
  }), [filteredSourceData.productions, ingredients, mealServiceConsumptions, producedItemBatches, recipes]);

  const summary = useMemo(() => {
    const totalCost = filteredRows.reduce((sum, row) => sum + safeFoodCostNumber(row.total_cost), 0);
    const servings = filteredRows.reduce((sum, row) => sum + safeFoodCostNumber(row.servings ?? row.total_servings), 0);
    return {
      totalCost,
      servings,
      averageCostPerServing: servings > 0 ? totalCost / servings : 0
    };
  }, [filteredRows]);

  const exportRows = filteredRows.map((row) => ({
    ...row,
    total_cost: safeFoodCostNumber(row.total_cost),
    cost_per_serving: safeFoodCostNumber(row.cost_per_serving)
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
            `Confirmed covers: ${summary.servings.toFixed(0)}`,
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
          description={`Confirmed Meal Service ${SAR_NAME} food cost reporting with production-only rows kept separate until covers are saved`}
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
          <StatCard title="Confirmed Covers" value={summary.servings.toFixed(0)} icon={UtensilsCrossed} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Avg. Cost / Serving" value={formatCurrency(summary.averageCostPerServing)} icon={TrendingUp} iconBg="bg-blue-50" iconColor="text-blue-600" />
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Food Cost Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-7">
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
                <Label>Menu Type</Label>
                <Select value={filters.menuType} onValueChange={(value) => setFilters((current) => ({ ...current, menuType: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Menu Types</SelectItem>
                    {menuTypes.map((menuType) => <SelectItem key={menuType} value={menuType}>{titleCaseFoodCost(menuType)}</SelectItem>)}
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
            <CardTitle>Confirmed Meal Cost Report</CardTitle>
            <p className="text-sm text-slate-500">
              These figures are populated only after Meal Service commits covers and a serving size for the selected menu scope.
            </p>
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
                    <TableCell className="py-10 text-center text-slate-500">
                      No confirmed Meal Service food cost is available for this filter range.
                    </TableCell>
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

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Production Data Pending Meal Service</CardTitle>
            <p className="text-sm text-slate-500">
              These completed productions are informational only. They do not affect Food Cost totals until Meal Service saves the actual covers and portion size.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {pendingProductionRows.length ? Object.keys(pendingProductionRows[0]).map((column) => (
                    <TableHead key={column}>{column.replace(/_/g, ' ')}</TableHead>
                  )) : (
                    <TableHead>Production</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingProductionRows.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-8 text-center text-slate-500">
                      No production-only rows are waiting for Meal Service under the current filters.
                    </TableCell>
                  </TableRow>
                ) : pendingProductionRows.map((row, index) => (
                  <TableRow key={`${row.date || 'production'}-${index}`}>
                    {Object.keys(pendingProductionRows[0]).map((column) => (
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
