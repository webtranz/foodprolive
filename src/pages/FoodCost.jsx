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
  const filteredRows = foodCostReport.rows || [];
  const pendingProductionRows = foodCostReport.pending_production_rows || [];

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
      subtitle: `Date: ${filters.startDate} to ${filters.endDate} | Meal type: ${filters.mealType === 'all' ? 'All' : titleCaseFoodCost(filters.mealType)} | View: ${titleCaseFoodCost(filters.view)}`,
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
