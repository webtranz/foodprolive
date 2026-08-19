import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import {
  AlertTriangle,
  CalendarClock,
  Download,
  FileSpreadsheet,
  FileText,
  PlayCircle,
  ShieldAlert,
  TrendingUp
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV, downloadExcel, downloadPDF } from '@/components/utils/exportData';
import { getItemCode } from '../../shared/itemCode.js';

function defaultFilters() {
  return {
    startDate: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    category: 'all',
    status: 'all',
    horizonDays: '7',
    safetyBufferPercent: '10'
  };
}

const scenarioTemplate = {
  name: '',
  location_id: 'all',
  category: 'all',
  status_filter: 'all',
  start_date: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
  end_date: format(new Date(), 'yyyy-MM-dd'),
  forecast_horizon_days: '7',
  safety_buffer_percent: '10',
  notes: ''
};

function summaryToPdf(summary, rows, filters) {
  downloadPDF({
    title: 'Demand Forecast Summary',
    subtitle: `Range ${filters.startDate} to ${filters.endDate} | Horizon ${filters.horizonDays} days`,
    filename: 'forecast_summary',
    sections: [
      {
        heading: 'Summary',
        lines: [
          `Forecast items: ${summary.total_items || 0}`,
          `Forecast quantity: ${summary.total_forecast_quantity || 0}`,
          `Recommended production: ${summary.total_recommended_production || 0}`,
          `Average confidence: ${summary.average_confidence || 0}`,
          `High-risk items: ${summary.high_risk_items || 0}`,
          `Locations covered: ${summary.location_count || 0}`
        ]
      },
      {
        heading: 'Top Forecast Items',
        lines: rows.slice(0, 12).map((row) => `${getItemCode(row)} | ${row.item} | ${row.location} | forecast ${row.forecast_quantity} | recommended ${row.recommended_production} | confidence ${row.confidence_score}`)
      }
    ]
  });
}

export default function Forecasting() {
  const { can, loading: permissionLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(defaultFilters());
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [scenarioForm, setScenarioForm] = useState(scenarioTemplate);
  const [latestRun, setLatestRun] = useState(null);

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: scenarios = [] } = useQuery({
    queryKey: ['forecastScenarios'],
    queryFn: () => base44.entities.ForecastScenario.list('-updated_date', 100),
    enabled: can('view_reports')
  });

  const { data: snapshots = [] } = useQuery({
    queryKey: ['forecastSnapshots'],
    queryFn: () => base44.entities.ForecastSnapshot.list('-generated_at', 100),
    enabled: can('view_reports')
  });

  const summaryQuery = useQuery({
    queryKey: ['forecastSummary', filters],
    queryFn: () => base44.forecasting.getSummary({
      start_date: filters.startDate,
      end_date: filters.endDate,
      location_id: filters.locationId === 'all' ? '' : filters.locationId,
      category: filters.category,
      status: filters.status,
      horizon_days: filters.horizonDays,
      safety_buffer_percent: filters.safetyBufferPercent
    }),
    enabled: can('view_reports')
  });

  const createScenarioMutation = useMutation({
    mutationFn: (payload) => base44.entities.ForecastScenario.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forecastScenarios'] });
      setScenarioOpen(false);
      setScenarioForm(scenarioTemplate);
    }
  });

  const runScenarioMutation = useMutation({
    mutationFn: (scenarioId) => base44.forecasting.runScenario(scenarioId),
    onSuccess: (result) => {
      setLatestRun(result);
      queryClient.invalidateQueries({ queryKey: ['forecastScenarios'] });
      queryClient.invalidateQueries({ queryKey: ['forecastSnapshots'] });
    }
  });

  const categoryOptions = useMemo(
    () => Array.from(new Set(recipes.map((recipe) => recipe.category).filter(Boolean))).sort(),
    [recipes]
  );

  const summary = summaryQuery.data?.summary || {};
  const rows = summaryQuery.data?.rows || [];
  const chartData = summaryQuery.data?.chart || [];
  const inventoryCoverage = summaryQuery.data?.inventoryCoverage || [];
  const exportRows = useMemo(() => rows.map((row) => ({
    item_code: getItemCode(row),
    item_name: row.item || '—',
    location: row.location,
    category: row.category,
    forecast_quantity: row.forecast_quantity,
    recommended_production: row.recommended_production,
    confidence_score: row.confidence_score,
    risk_level: row.risk_level
  })), [rows]);

  if (permissionLoading) {
    return <div className="p-8 text-slate-500">Loading forecasting workspace...</div>;
  }

  if (!can('view_reports')) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <Card className="max-w-sm w-full text-center p-8">
          <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500 mt-2">You do not have access to the forecasting workspace.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1680px] mx-auto space-y-6">
        <PageHeader
          title="Demand Forecasting"
          description="Forecast production demand across locations using POS sales, production history, menu plans, meal plans, and waste patterns."
        >
          <Button variant="outline" onClick={() => downloadCSV(exportRows, 'forecast_rows')}>
            <Download className="w-4 h-4 mr-2" />
            CSV
          </Button>
          <Button variant="outline" onClick={() => downloadExcel(exportRows, 'forecast_rows', 'Forecast')}>
            <FileSpreadsheet className="w-4 h-4 mr-2" />
            Excel
          </Button>
          <Button variant="outline" onClick={() => summaryToPdf(summary, rows, filters)}>
            <FileText className="w-4 h-4 mr-2" />
            PDF
          </Button>
          <Button onClick={() => setScenarioOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
            <CalendarClock className="w-4 h-4 mr-2" />
            Save Scenario
          </Button>
        </PageHeader>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Forecast Filters</CardTitle>
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
                <Label>Location</Label>
                <Select value={filters.locationId} onValueChange={(value) => setFilters((current) => ({ ...current, locationId: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select value={filters.category} onValueChange={(value) => setFilters((current) => ({ ...current, category: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categoryOptions.map((category) => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Status</Label>
                <Select value={filters.status} onValueChange={(value) => setFilters((current) => ({ ...current, status: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="planned">Planned</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Horizon</Label>
                  <Select value={filters.horizonDays} onValueChange={(value) => setFilters((current) => ({ ...current, horizonDays: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3">3 Days</SelectItem>
                      <SelectItem value="7">7 Days</SelectItem>
                      <SelectItem value="14">14 Days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Buffer %</Label>
                  <Input type="number" className="mt-1" value={filters.safetyBufferPercent} onChange={(event) => setFilters((current) => ({ ...current, safetyBufferPercent: event.target.value }))} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            { title: 'Forecast Items', value: summary.total_items || 0, subtitle: 'Items with active demand signal' },
            { title: 'Forecast Quantity', value: summary.total_forecast_quantity || 0, subtitle: `Projected over ${filters.horizonDays} days` },
            { title: 'Recommended Production', value: summary.total_recommended_production || 0, subtitle: 'Includes safety buffer' },
            { title: 'Average Confidence', value: `${summary.average_confidence || 0}%`, subtitle: 'Signal quality across inputs' },
            { title: 'High-Risk Items', value: summary.high_risk_items || 0, subtitle: 'Low confidence or high waste signal' }
          ].map((card) => (
            <Card key={card.title} className="border-slate-200 shadow-sm">
              <CardContent className="p-5">
                <p className="text-sm text-slate-500">{card.title}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{card.value}</p>
                <p className="mt-1 text-xs text-slate-500">{card.subtitle}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Top Forecast Items</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="item" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="forecast_quantity" name="Forecast Qty" fill="#2563eb" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="recommended_production" name="Recommended Production" fill="#10b981" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Confidence View</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="item" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="confidence_score" name="Confidence %" fill="#7c3aed" radius={[6, 6, 0, 0]} />
                    <Line type="monotone" dataKey="forecast_quantity" name="Forecast Qty" stroke="#f97316" strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Forecast Output</CardTitle>
              <Badge variant="outline">{rows.length} rows</Badge>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Forecast Qty</TableHead>
                      <TableHead>Recommended</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Risk</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-8 text-center text-slate-500">
                          No forecast rows available for the selected filters.
                        </TableCell>
                      </TableRow>
                    ) : rows.slice(0, 30).map((row) => (
                      <TableRow key={`${row.site_id}-${row.item}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{getItemCode(row)}</TableCell>
                        <TableCell className="font-medium">{row.item}</TableCell>
                        <TableCell>{row.location}</TableCell>
                        <TableCell>{row.category}</TableCell>
                        <TableCell>{row.forecast_quantity}</TableCell>
                        <TableCell>{row.recommended_production}</TableCell>
                        <TableCell>{row.confidence_score}%</TableCell>
                        <TableCell>
                          <Badge className={row.risk_level === 'high' ? 'bg-red-600' : row.risk_level === 'medium' ? 'bg-amber-500' : 'bg-emerald-600'}>
                            {row.risk_level}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Inventory Coverage Watch</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {inventoryCoverage.slice(0, 12).map((item) => (
                <div key={`${item.site_id}-${item.ingredient}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{getItemCode(item)}</p>
                      <p className="font-medium text-slate-900">{item.ingredient}</p>
                      <p className="text-sm text-slate-500">{item.location}</p>
                    </div>
                    <Badge className={item.status === 'out_of_stock' ? 'bg-red-600' : item.status === 'low_stock' ? 'bg-amber-500' : 'bg-emerald-600'}>
                      {item.status || 'in_stock'}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
                    <span>Qty: {item.quantity}</span>
                    <span>Min: {item.min_stock_level || 0}</span>
                  </div>
                </div>
              ))}
              {inventoryCoverage.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                  No inventory coverage records available.
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Saved Forecast Scenarios</CardTitle>
              <Badge variant="outline">{scenarios.length}</Badge>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Horizon</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scenarios.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-slate-500">No saved forecast scenarios yet.</TableCell>
                      </TableRow>
                    ) : scenarios.map((scenario) => (
                      <TableRow key={scenario.id}>
                        <TableCell className="font-medium">{scenario.name}</TableCell>
                        <TableCell>{scenario.site_name || scenario.location_name || 'All locations'}</TableCell>
                        <TableCell>{scenario.forecast_horizon_days} days</TableCell>
                        <TableCell>
                          <Badge variant="outline">{scenario.status || 'draft'}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" onClick={() => runScenarioMutation.mutate(scenario.id)} disabled={runScenarioMutation.isPending}>
                            <PlayCircle className="w-4 h-4 mr-2" />
                            Run
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Latest Forecast Snapshots</CardTitle>
              <Badge variant="outline">{snapshots.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {latestRun ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="flex items-start gap-3">
                    <TrendingUp className="w-5 h-5 text-emerald-700 mt-0.5" />
                    <div>
                      <p className="font-medium text-emerald-900">Scenario run completed</p>
                      <p className="text-sm text-emerald-700 mt-1">
                        Snapshot {latestRun.snapshot?.scenario_name || latestRun.snapshot?.scenario_id} created with {latestRun.summary?.total_items || 0} forecast rows.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
              {snapshots.slice(0, 6).map((snapshot) => (
                <div key={snapshot.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{snapshot.scenario_name || 'Forecast Snapshot'}</p>
                      <p className="text-sm text-slate-500">{snapshot.site_name || 'All locations'} | {String(snapshot.generated_at || snapshot.created_date || '').slice(0, 10)}</p>
                    </div>
                    <Badge variant="outline">{snapshot.summary?.total_items || 0} items</Badge>
                  </div>
                </div>
              ))}
              {snapshots.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                  No forecast snapshots generated yet.
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Dialog open={scenarioOpen} onOpenChange={setScenarioOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Save Forecast Scenario</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input className="mt-1" value={scenarioForm.name} onChange={(event) => setScenarioForm((current) => ({ ...current, name: event.target.value }))} placeholder="Weekly Riyadh Lunch Forecast" />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Location</Label>
                  <Select value={scenarioForm.location_id} onValueChange={(value) => setScenarioForm((current) => ({ ...current, location_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Locations</SelectItem>
                      {sites.map((site) => (
                        <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Category</Label>
                  <Select value={scenarioForm.category} onValueChange={(value) => setScenarioForm((current) => ({ ...current, category: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {categoryOptions.map((category) => (
                        <SelectItem key={category} value={category}>{category}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Start Date</Label>
                  <Input type="date" className="mt-1" value={scenarioForm.start_date} onChange={(event) => setScenarioForm((current) => ({ ...current, start_date: event.target.value }))} />
                </div>
                <div>
                  <Label>End Date</Label>
                  <Input type="date" className="mt-1" value={scenarioForm.end_date} onChange={(event) => setScenarioForm((current) => ({ ...current, end_date: event.target.value }))} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <Label>Status Filter</Label>
                  <Select value={scenarioForm.status_filter} onValueChange={(value) => setScenarioForm((current) => ({ ...current, status_filter: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      <SelectItem value="planned">Planned</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Horizon Days</Label>
                  <Input type="number" className="mt-1" value={scenarioForm.forecast_horizon_days} onChange={(event) => setScenarioForm((current) => ({ ...current, forecast_horizon_days: event.target.value }))} />
                </div>
                <div>
                  <Label>Safety Buffer %</Label>
                  <Input type="number" className="mt-1" value={scenarioForm.safety_buffer_percent} onChange={(event) => setScenarioForm((current) => ({ ...current, safety_buffer_percent: event.target.value }))} />
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea className="mt-1" rows={3} value={scenarioForm.notes} onChange={(event) => setScenarioForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Scenario assumptions, event demand, labor context, or seasonality notes" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setScenarioOpen(false)}>Cancel</Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={createScenarioMutation.isPending || !scenarioForm.name.trim()}
                onClick={() => {
                  const location = sites.find((site) => site.id === scenarioForm.location_id);
                  createScenarioMutation.mutate({
                    ...scenarioForm,
                    location_id: scenarioForm.location_id === 'all' ? null : scenarioForm.location_id,
                    location_name: scenarioForm.location_id === 'all' ? 'All Locations' : (location?.name || ''),
                    site_id: scenarioForm.location_id === 'all' ? null : scenarioForm.location_id,
                    site_name: scenarioForm.location_id === 'all' ? 'All Locations' : (location?.name || ''),
                    forecast_horizon_days: Number(scenarioForm.forecast_horizon_days) || 7,
                    safety_buffer_percent: Number(scenarioForm.safety_buffer_percent) || 10,
                    model_type: 'blended_average',
                    status: 'draft'
                  });
                }}
              >
                {createScenarioMutation.isPending ? 'Saving...' : 'Save Scenario'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {rows.some((row) => row.risk_level === 'high') ? (
          <Card className="border-red-200 bg-red-50 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
                <div>
                  <p className="font-medium text-red-900">High-risk forecast items detected</p>
                  <p className="text-sm text-red-700 mt-1">
                    Review low-confidence items and locations with high waste rate before locking production plans.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
