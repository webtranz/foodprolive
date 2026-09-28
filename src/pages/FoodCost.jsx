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
import { CircleDollarSign, Download, TrendingDown, TrendingUp, UtensilsCrossed } from 'lucide-react';
import { formatCurrency, SAR_NAME } from '@/lib/currency';
import {
  safeFoodCostNumber,
  titleCaseFoodCost
} from '../../shared/foodCostReport.js';

const MASTER_DATA_QUERY_OPTIONS = {
  staleTime: 10 * 60 * 1000,
  gcTime: 60 * 60 * 1000
};

const REPORT_DATA_QUERY_OPTIONS = {
  staleTime: 60 * 1000,
  gcTime: 10 * 60 * 1000
};

const COLUMN_LABELS = {
  date: 'Date',
  location: 'Location',
  meal_type: 'Meal Type',
  menu_type: 'Menu Type',
  production: 'Production',
  recipe: 'Recipe',
  category: 'Meal Category',
  movement: 'Movement',
  produced_output_kg: 'Produced Weight kg',
  served_weight_kg: 'Consumed Weight kg',
  servings: 'Servings',
  total_servings: 'Servings',
  production_servings: 'Production Servings',
  portion_size_g: 'Portion Size g',
  total_weight_kg: 'Weight kg',
  total_cost: 'Total Cost',
  cost_per_serving: 'Cost / Serving',
  source: 'Source',
  section: 'Section'
};

const reportColumnLabel = (column) => COLUMN_LABELS[column] || column.replace(/_/g, ' ');

const formatReportValue = (column, value) => {
  if (column.includes('cost')) return formatCurrency(value);
  if (['produced_output_kg', 'served_weight_kg', 'total_weight_kg'].includes(column)) {
    return `${safeFoodCostNumber(value).toFixed(3)} kg`;
  }
  if (column === 'portion_size_g') return `${safeFoodCostNumber(value).toFixed(2)} g`;
  if (['servings', 'total_servings', 'production_servings'].includes(column)) {
    const numericValue = safeFoodCostNumber(value);
    return Number.isInteger(numericValue) ? numericValue.toFixed(0) : numericValue.toFixed(3);
  }
  return value ?? '—';
};

function ReportTable({ rows, emptyLabel }) {
  const columns = rows.length ? Object.keys(rows[0]) : [];

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.length ? columns.map((column) => (
            <TableHead key={column}>{reportColumnLabel(column)}</TableHead>
          )) : (
            <TableHead>Report</TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell className="py-10 text-center text-slate-500">
              {emptyLabel}
            </TableCell>
          </TableRow>
        ) : rows.map((row, index) => (
          <TableRow key={`${row.date || row.meal_type || row.production || row.recipe || 'row'}-${index}`}>
            {columns.map((column) => (
              <TableCell key={column}>
                {formatReportValue(column, row[column])}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

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

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const foodCostReportFilters = useMemo(() => ({
    startDate: filters.startDate,
    endDate: filters.endDate,
    locationId: filters.locationId,
    category: filters.category,
    mealType: filters.mealType,
    menuType: filters.menuType,
    view: filters.view
  }), [filters]);

  const { data: foodCostReport = {} } = useQuery({
    queryKey: ['foodCostReport', foodCostReportFilters],
    queryFn: () => base44.reports.getFoodCost(foodCostReportFilters),
    ...REPORT_DATA_QUERY_OPTIONS
  });

  const categories = foodCostReport.categories || [];
  const menuTypes = foodCostReport.menu_types || [];
  const productionRows = foodCostReport.rows || [];
  const consumedRows = foodCostReport.consumed_rows || [];

  const summary = useMemo(() => {
    const serverSummary = foodCostReport.summary || {};
    const totalCost = safeFoodCostNumber(serverSummary.total_cost);
    const servings = safeFoodCostNumber(serverSummary.servings);
    return {
      totalCost,
      servings,
      averageCostPerServing: safeFoodCostNumber(
        serverSummary.average_cost_per_serving,
        servings > 0 ? totalCost / servings : 0
      )
    };
  }, [foodCostReport.summary]);

  const consumedSummary = useMemo(() => {
    const serverSummary = foodCostReport.consumed_summary || {};
    const totalCost = safeFoodCostNumber(serverSummary.total_cost);
    const servings = safeFoodCostNumber(serverSummary.servings);
    return {
      totalCost,
      servings,
      averageCostPerServing: safeFoodCostNumber(
        serverSummary.average_cost_per_serving,
        servings > 0 ? totalCost / servings : 0
      )
    };
  }, [foodCostReport.consumed_summary]);

  const exportRows = [
    ...productionRows.map((row) => ({ section: 'Food Cost - Production', ...row })),
    ...consumedRows.map((row) => ({ section: 'Consumed Cost - Meal Service', ...row }))
  ].map((row) => ({
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
      subtitle: `Date: ${filters.startDate} to ${filters.endDate} | Meal type: ${filters.mealType === 'all' ? 'All' : titleCaseFoodCost(filters.mealType)} | View: ${titleCaseFoodCost(filters.view)}`,
      sections: [
        {
          heading: 'Food Cost Summary',
          lines: [
            `Production food cost: ${formatCurrency(summary.totalCost)}`,
            `Production servings: ${summary.servings.toFixed(0)}`,
            `Average production cost per serving: ${formatCurrency(summary.averageCostPerServing)}`
          ]
        },
        {
          heading: 'Consumed Cost Summary',
          lines: [
            `Consumed cost: ${formatCurrency(consumedSummary.totalCost)}`,
            `Consumed covers: ${consumedSummary.servings.toFixed(0)}`,
            `Average consumed cost per serving: ${formatCurrency(consumedSummary.averageCostPerServing)}`,
            'Plate waste rows are shown as deductions from consumed cost.'
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
          description={`${SAR_NAME} production cost reporting from completed production, with Meal Service consumption shown separately as Consumed Cost`}
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
          <StatCard title="Production Servings" value={summary.servings.toFixed(0)} icon={UtensilsCrossed} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Avg. Production Cost / Serving" value={formatCurrency(summary.averageCostPerServing)} icon={TrendingUp} iconBg="bg-blue-50" iconColor="text-blue-600" />
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
            <CardTitle>Production Food Cost Report</CardTitle>
            <p className="text-sm text-slate-500">
              These figures are populated as soon as production is completed. Meal Service is not required for this Food Cost total.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ReportTable
              rows={productionRows}
              emptyLabel="No completed production food cost is available for this filter range."
            />
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="space-y-4">
            <div>
              <CardTitle>Consumed Cost</CardTitle>
              <p className="text-sm text-slate-500">
                These figures are populated after Meal Service commits covers and serving size. Plate waste is shown as a deduction from Consumed Cost.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <StatCard title="Total Consumed Cost" value={formatCurrency(consumedSummary.totalCost)} icon={CircleDollarSign} iconBg="bg-rose-50" iconColor="text-rose-600" />
              <StatCard title="Consumed Covers" value={consumedSummary.servings.toFixed(0)} icon={UtensilsCrossed} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
              <StatCard title="Avg. Consumed Cost / Serving" value={formatCurrency(consumedSummary.averageCostPerServing)} icon={TrendingDown} iconBg="bg-blue-50" iconColor="text-blue-600" />
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ReportTable
              rows={consumedRows}
              emptyLabel="No Meal Service consumed cost is available for this filter range."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
