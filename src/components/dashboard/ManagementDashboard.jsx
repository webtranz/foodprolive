import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Factory,
  PackageSearch,
  Percent,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Tag,
  Trash2,
  Truck,
  UserCheck,
  UsersRound,
  WalletCards
} from 'lucide-react';

import { base44 } from '@/api/base44Client';
import AsyncStatePanel from '@/components/ui/AsyncStatePanel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency, formatNumber } from '@/lib/currency';

const VIEW_CONFIG = {
  gm: {
    title: 'FoodPro Dashboard',
    eyebrow: 'GM View · Enterprise performance across your assigned locations',
    scopeLabel: 'Location scope'
  },
  agm: {
    title: 'FoodPro Dashboard',
    eyebrow: 'AGM View · Operational exceptions and follow-up across locations',
    scopeLabel: 'Location scope'
  },
  area_manager: {
    title: 'FoodPro Dashboard',
    eyebrow: 'Area Manager View · Location performance for your assigned area',
    scopeLabel: 'Assigned area'
  },
  project_manager: {
    title: 'Project Manager View',
    eyebrow: 'Operational control across the selected reporting period',
    scopeLabel: 'Selected project'
  }
};

const MIN_DATE_VALUE = '0001-01-01';
const MAX_DATE_VALUE = '9999-12-31';
const MAX_RANGE_OFFSET_DAYS = 365;

const ENTITY_NAMES = [
  'Site',
  'Production',
  'FoodWaste',
  'Inventory',
  'Budget',
  'MenuPlan',
  'MaterialRequest',
  'AttendanceRecord',
  'StaffShift',
  'QualityControl',
  'PurchaseRequest',
  'PurchaseOrder',
  'GoodsReceipt'
];

const PALETTE = ['#0f766e', '#2563eb', '#f59e0b', '#e11d48', '#7c3aed', '#0891b2', '#16a34a', '#ea580c'];

const TONE_CLASSES = {
  emerald: { icon: 'bg-emerald-50 text-emerald-600', value: 'text-emerald-700' },
  blue: { icon: 'bg-blue-50 text-blue-600', value: 'text-blue-700' },
  amber: { icon: 'bg-amber-50 text-amber-600', value: 'text-amber-700' },
  rose: { icon: 'bg-rose-50 text-rose-600', value: 'text-rose-700' },
  violet: { icon: 'bg-violet-50 text-violet-600', value: 'text-violet-700' },
  cyan: { icon: 'bg-cyan-50 text-cyan-600', value: 'text-cyan-700' },
  slate: { icon: 'bg-slate-100 text-slate-600', value: 'text-slate-800' }
};

const ACTION_TONES = {
  emerald: 'bg-emerald-50 text-emerald-700',
  green: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  rose: 'bg-rose-50 text-rose-700',
  violet: 'bg-violet-50 text-violet-700',
  cyan: 'bg-cyan-50 text-cyan-700',
  slate: 'bg-slate-100 text-slate-700'
};

const ACTION_ICONS = {
  procurement: ClipboardCheck,
  pr_approvals: ClipboardCheck,
  production: Factory,
  production_requests: Factory,
  production_approvals: Factory,
  waste: Trash2,
  waste_review: Trash2,
  inventory: PackageSearch,
  inventory_shortage: PackageSearch,
  supplier: Truck,
  supplier_exceptions: Truck,
  attendance: UsersRound,
  attendance_gaps: UsersRound,
  quality: ShieldCheck,
  high_waste: Percent,
  low_stock: PackageSearch,
  late_supplier: Truck,
  attendance_gap: UsersRound
};

function normalizeView(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['gm', 'general_manager', 'generalmanager'].includes(normalized)) return 'gm';
  if (['agm', 'assistant_general_manager', 'assistantgeneralmanager'].includes(normalized)) return 'agm';
  if (['area', 'area_manager', 'areamanager'].includes(normalized)) return 'area_manager';
  if (['pm', 'project', 'project_manager', 'projectmanager'].includes(normalized)) return 'project_manager';
  return 'gm';
}

function todayValue() {
  const value = new Date();
  const offset = value.getTimezoneOffset();
  return new Date(value.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function shiftDateValue(value, days) {
  const shifted = new Date(`${value}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  if (shifted.getUTCFullYear() < 1) return MIN_DATE_VALUE;
  if (shifted.getUTCFullYear() > 9999) return MAX_DATE_VALUE;
  return shifted.toISOString().slice(0, 10);
}

export function getInitialManagementDateRange() {
  const endDate = todayValue();
  return {
    startDate: shiftDateValue(endDate, -6),
    endDate
  };
}

function number(value, digits = 0) {
  return formatNumber(Number(value) || 0, digits);
}

function percent(value) {
  return `${number(value, 1)}%`;
}

function nullablePercent(value) {
  return value === null || typeof value === 'undefined' || value === '' ? '—' : percent(value);
}

function compactCurrency(value) {
  return formatCurrency(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function timestamp(value) {
  if (!value) return 'Live data';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Live data';
  return `Updated ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(parsed)}`;
}

function statusClass(value) {
  const normalized = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['healthy', 'on_track', 'complete', 'completed', 'normal'].includes(normalized)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (['overdue', 'critical', 'at_risk', 'high', 'high_priority'].includes(normalized)) {
    return 'border-rose-200 bg-rose-50 text-rose-700';
  }
  if (['due_soon', 'review', 'warning', 'medium'].includes(normalized)) {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function displayStatus(value) {
  if (!value) return 'On track';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function actionPath(href) {
  if (!href) return '';
  return String(href).startsWith('/') ? String(href) : `/${String(href).replace(/\s+/g, '-')}`;
}

function chartMoneyFormatter(value) {
  return compactCurrency(Number(value) || 0);
}

function chartNumberFormatter(value) {
  return number(value, 0);
}

function MetricCard({ label, value, icon: Icon, tone = 'slate', subtitle }) {
  const style = TONE_CLASSES[tone] || TONE_CLASSES.slate;
  return (
    <Card className="min-w-0 border-slate-200 bg-white shadow-sm">
      <CardContent className="flex items-center gap-3 p-4 sm:p-5">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${style.icon}`}>
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-slate-500 sm:text-sm">{label}</p>
          <p className={`mt-1 break-words text-xl font-bold tracking-tight sm:text-2xl ${style.value}`}>{value}</p>
          {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Panel({ title, children, className = '', panelRef }) {
  return (
    <Card ref={panelRef} tabIndex={-1} className={`scroll-mt-20 border-slate-200 bg-white shadow-sm ${className}`}>
      <CardHeader className="border-b border-slate-100 px-4 py-4 sm:px-5">
        <CardTitle className="text-base text-slate-900">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

function NoRows({ children = 'No operational records were found for this selection.' }) {
  return (
    <div className="flex min-h-40 items-center justify-center p-6 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

function ActionsPanel({ actions = [], title = 'Management Actions', panelRef, linksEnabled = false }) {
  return (
    <Panel title={title} panelRef={panelRef}>
      {actions.length === 0 ? (
        <NoRows>No pending management actions for this selection.</NoRows>
      ) : (
        <div className="divide-y divide-slate-100 p-2">
          {actions.map((action, index) => {
            const Icon = ACTION_ICONS[action.key] || AlertCircle;
            const row = (
              <div className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-slate-50">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${ACTION_TONES[action.tone] || ACTION_TONES.slate}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <span className="min-w-0 flex-1 text-sm font-medium text-slate-800">{action.label}</span>
                <Badge variant="outline" className={ACTION_TONES[action.tone] || ACTION_TONES.slate}>
                  {number(action.count)}
                </Badge>
                {action.href && linksEnabled ? <span className="text-slate-400" aria-hidden="true">›</span> : null}
              </div>
            );
            return action.href && linksEnabled ? (
              <Link key={`${action.key || 'action'}-${index}`} to={actionPath(action.href)} className="block rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                {row}
              </Link>
            ) : (
              <div key={`${action.key || 'action'}-${index}`}>{row}</div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function LocationTable({ locations, mode, panelRef }) {
  const isAgm = mode === 'agm';
  return (
    <Panel title={isAgm ? 'Location Exception Summary' : 'Location Comparison'} panelRef={panelRef}>
      {locations.length === 0 ? <NoRows /> : (
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead className="min-w-40 px-4">Location</TableHead>
              {!isAgm ? <TableHead>Meals</TableHead> : null}
              <TableHead>Budget</TableHead>
              <TableHead>Spent</TableHead>
              {isAgm ? <TableHead>Variance</TableHead> : <TableHead>Cost / Meal</TableHead>}
              <TableHead>{isAgm ? 'Waste Cost' : 'Waste'}</TableHead>
              {isAgm ? (
                <>
                  <TableHead>Exceptions</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Priority Window</TableHead>
                  <TableHead>Priority</TableHead>
                </>
              ) : (
                <>
                  <TableHead>Waste Cost</TableHead>
                  <TableHead>Approvals</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.map((location) => {
              const variance = (Number(location.budget) || 0) - (Number(location.spent) || 0);
              return (
                <TableRow key={location.id || location.name}>
                  <TableCell className="px-4 font-semibold text-slate-900">{location.name}</TableCell>
                  {!isAgm ? <TableCell>{number(location.meals)}</TableCell> : null}
                  <TableCell>{compactCurrency(location.budget)}</TableCell>
                  <TableCell>{compactCurrency(location.spent)}</TableCell>
                  {isAgm ? (
                    <TableCell className={variance < 0 ? 'font-semibold text-rose-600' : 'font-semibold text-emerald-700'}>
                      {formatCurrency(variance, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </TableCell>
                  ) : (
                    <TableCell>{formatCurrency(location.cost_per_meal)}</TableCell>
                  )}
                  <TableCell className={!isAgm && Number(location.waste_percent) >= 3 ? 'font-semibold text-rose-600' : ''}>
                    {isAgm ? compactCurrency(location.waste_cost) : percent(location.waste_percent)}
                  </TableCell>
                  {isAgm ? (
                    <>
                      <TableCell className={Number(location.exceptions) > 0 ? 'font-semibold text-rose-600' : 'text-emerald-700'}>{number(location.exceptions)}</TableCell>
                      <TableCell>{location.owner || '—'}</TableCell>
                      <TableCell>{location.due || '—'}</TableCell>
                      <TableCell><Badge variant="outline" className={statusClass(location.status)}>{displayStatus(location.status)}</Badge></TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>{compactCurrency(location.waste_cost)}</TableCell>
                      <TableCell>{number(location.approvals)}</TableCell>
                    </>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function MealOperationsTable({ meals, panelRef }) {
  return (
    <Panel title="Project Operations" panelRef={panelRef}>
      {meals.length === 0 ? <NoRows>No meal-period production was found for this project and date range.</NoRows> : (
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead className="px-4">Meal Period</TableHead>
              <TableHead>Planned</TableHead>
              <TableHead>Produced</TableHead>
              <TableHead>Variance</TableHead>
              <TableHead>Budget</TableHead>
              <TableHead>Spent</TableHead>
              <TableHead>Waste Cost</TableHead>
              <TableHead>Action Required</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {meals.map((meal) => (
              <TableRow key={meal.meal_type}>
                <TableCell className="px-4 font-semibold capitalize text-slate-900">{String(meal.meal_type || 'Unassigned').replace(/_/g, ' ')}</TableCell>
                <TableCell>{number(meal.planned)}</TableCell>
                <TableCell>{number(meal.produced)}</TableCell>
                <TableCell className={Number(meal.variance) < 0 ? 'font-semibold text-rose-600' : Number(meal.variance) > 0 ? 'font-semibold text-emerald-700' : ''}>
                  {Number(meal.variance) > 0 ? '+' : ''}{number(meal.variance)}
                </TableCell>
                <TableCell>{compactCurrency(meal.budget)}</TableCell>
                <TableCell>{compactCurrency(meal.spent)}</TableCell>
                <TableCell>{compactCurrency(meal.waste_cost)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={meal.action && String(meal.action).toLowerCase() !== 'none' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 bg-slate-50 text-slate-600'}>
                    {meal.action || 'None'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function MoneyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <p className="mb-2 font-semibold text-slate-800">{label}</p>
      {payload.map((item) => (
        <div key={`${item.dataKey}-${item.name}`} className="flex items-center justify-between gap-5 py-0.5" style={{ color: item.color }}>
          <span>{item.name}</span>
          <strong>{chartMoneyFormatter(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function CountTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <p className="mb-2 font-semibold text-slate-800">{label}</p>
      {payload.map((item) => (
        <div key={`${item.dataKey}-${item.name}`} className="flex items-center justify-between gap-5 py-0.5" style={{ color: item.color }}>
          <span>{item.name}</span>
          <strong>{chartNumberFormatter(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function ProjectCharts({ trends, meals, panelRef }) {
  return (
    <div ref={panelRef} tabIndex={-1} className="scroll-mt-20 grid gap-4 xl:grid-cols-2">
      <Panel title="Cost Overview">
        {trends.length === 0 ? <NoRows /> : (
          <div className="h-72 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trends} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => number(value / 1000, 0) + 'k'} />
                <Tooltip content={<MoneyTooltip />} />
                <Legend />
                <Line type="monotone" dataKey="budget" name="Budget" stroke="#2563eb" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="spent" name="Spent" stroke="#059669" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="waste_cost" name="Waste Cost" stroke="#e11d48" strokeWidth={2} strokeDasharray="5 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      <Panel title="Meal Production vs Plan">
        {meals.length === 0 ? <NoRows /> : (
          <div className="h-72 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={meals} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="meal_type" tick={{ fontSize: 11 }} tickFormatter={(value) => displayStatus(value)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => number(value)} />
                <Tooltip content={<CountTooltip />} />
                <Legend />
                <Bar dataKey="planned" name="Planned" fill="#60a5fa" radius={[4, 4, 0, 0]} />
                <Bar dataKey="produced" name="Produced" fill="#34d399" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
    </div>
  );
}

function GmCharts({ trends, locations, locationSeries, panelRef }) {
  const series = locationSeries.length > 0
    ? locationSeries
    : [
      { key: 'planned', name: 'Planned', color: '#2563eb' },
      { key: 'produced', name: 'Produced', color: '#059669' }
    ];
  return (
    <div ref={panelRef} tabIndex={-1} className="scroll-mt-20 grid gap-4 xl:grid-cols-2">
      <Panel title="Production Trend">
        {trends.length === 0 ? <NoRows /> : (
          <div className="h-72 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trends} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => number(value)} />
                <Tooltip content={<CountTooltip />} />
                <Legend />
                {series.map((item, index) => (
                  <Line key={item.key} type="monotone" dataKey={item.key} name={item.name} stroke={item.color || PALETTE[index % PALETTE.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      <Panel title="Budget vs Spent">
        {locations.length === 0 ? <NoRows /> : (
          <div className="h-72 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={locations} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} tickFormatter={(value) => String(value).length > 12 ? `${String(value).slice(0, 11)}…` : value} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => number(value / 1000, 0) + 'k'} />
                <Tooltip content={<MoneyTooltip />} />
                <Legend />
                <Bar dataKey="budget" name="Budget" fill="#2563eb" radius={[4, 4, 0, 0]} />
                <Bar dataKey="spent" name="Spent" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
    </div>
  );
}

function AreaCharts({ locations, panelRef }) {
  const wasteTotal = locations.reduce((sum, location) => sum + (Number(location.waste_cost) || 0), 0);
  return (
    <div ref={panelRef} tabIndex={-1} className="scroll-mt-20 grid gap-4 xl:grid-cols-2">
      <Panel title="Budget vs Spent">
        {locations.length === 0 ? <NoRows /> : (
          <div className="h-72 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={locations} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => number(value / 1000, 0) + 'k'} />
                <Tooltip content={<MoneyTooltip />} />
                <Legend />
                <Bar dataKey="budget" name="Budget" fill="#2563eb" radius={[4, 4, 0, 0]} />
                <Bar dataKey="spent" name="Spent" fill="#16a34a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      <Panel title="Waste Cost by Location">
        {locations.length === 0 || wasteTotal <= 0 ? <NoRows>No recorded waste cost for this selection.</NoRows> : (
          <div className="grid min-h-72 gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.8fr)]">
            <div className="relative h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={locations.filter((item) => Number(item.waste_cost) > 0)} dataKey="waste_cost" nameKey="name" innerRadius="52%" outerRadius="82%" paddingAngle={1}>
                    {locations.filter((item) => Number(item.waste_cost) > 0).map((item, index) => <Cell key={item.id || item.name} fill={PALETTE[index % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip formatter={chartMoneyFormatter} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="text-center"><p className="text-lg font-bold text-slate-900">{compactCurrency(wasteTotal)}</p><p className="text-xs text-slate-500">Total</p></div>
              </div>
            </div>
            <div className="flex flex-col justify-center gap-2">
              {locations.filter((item) => Number(item.waste_cost) > 0).map((location, index) => (
                <div key={location.id || location.name} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PALETTE[index % PALETTE.length] }} />
                  <div className="min-w-0"><p className="truncate font-medium text-slate-700">{location.name}</p><p className="text-slate-500">{compactCurrency(location.waste_cost)} · {percent((Number(location.waste_cost) / wasteTotal) * 100)}</p></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function PrimaryMetrics({ metrics, view }) {
  const common = [
    { key: 'total_meals', label: 'Total Meals', value: number(metrics.total_meals), icon: UsersRound, tone: 'emerald' },
    { key: 'cost_per_meal', label: 'Cost / Meal', value: formatCurrency(metrics.cost_per_meal), icon: Tag, tone: 'emerald' },
    { key: 'daily_budget', label: 'Range Budget', value: compactCurrency(metrics.daily_budget), icon: WalletCards, tone: 'blue' },
    { key: 'daily_spent', label: 'Range Spent', value: compactCurrency(metrics.daily_spent), icon: ReceiptText, tone: 'blue' },
    { key: 'food_wastage_cost', label: 'Food Wastage Cost', value: compactCurrency(metrics.food_wastage_cost), icon: Trash2, tone: 'rose' }
  ];
  const cards = view === 'agm' ? common.filter((item) => item.key !== 'total_meals') : common;
  return <div className={`grid gap-3 sm:grid-cols-2 ${cards.length === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-5'}`}>{cards.map((card) => <MetricCard key={card.key} {...card} />)}</div>;
}

function SecondaryMetrics({ metrics, view }) {
  const base = [
    { key: 'waste_percent', label: 'Waste %', value: percent(metrics.waste_percent), icon: Percent, tone: 'rose' },
    { key: 'stock_risk', label: 'Current Stock Risk', value: `${number(metrics.stock_risk)} Items`, icon: AlertTriangle, tone: 'amber' },
    { key: 'pending_approvals', label: 'Open Approvals', value: number(metrics.pending_approvals), icon: ClipboardCheck, tone: 'violet' }
  ];
  let cards;
  if (view === 'project_manager') {
    cards = [...base, { key: 'menu_plan_completion', label: 'Menu Plan', value: `${number(metrics.menu_plan_completion, 0)}% Complete`, icon: CalendarCheck2, tone: 'emerald' }];
  } else if (view === 'agm') {
    cards = [
      { key: 'open_exceptions', label: 'Open Exceptions', value: number(metrics.open_exceptions), icon: AlertCircle, tone: 'amber' },
      ...base,
      { key: 'supplier_sla', label: 'Supplier SLA', value: nullablePercent(metrics.supplier_sla), icon: Truck, tone: 'emerald' }
    ];
  } else if (view === 'area_manager') {
    cards = [...base, { key: 'supplier_sla', label: 'Supplier SLA', value: nullablePercent(metrics.supplier_sla), icon: Truck, tone: 'blue' }];
  } else {
    cards = [
      ...base,
      { key: 'supplier_sla', label: 'Supplier SLA', value: nullablePercent(metrics.supplier_sla), icon: Truck, tone: 'cyan' },
      { key: 'attendance', label: 'Attendance', value: nullablePercent(metrics.attendance), icon: UserCheck, tone: 'blue' },
      { key: 'quality_score', label: 'Quality Score', value: nullablePercent(metrics.quality_score), icon: ShieldCheck, tone: 'emerald' }
    ];
  }
  return <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${cards.length === 4 ? 'xl:grid-cols-4' : cards.length === 5 ? 'xl:grid-cols-5' : 'xl:grid-cols-6'}`}>{cards.map((card) => <MetricCard key={card.key} {...card} />)}</div>;
}

function Toolbar({
  config,
  startDate,
  endDate,
  setStartDate,
  setEndDate,
  siteId,
  setSiteId,
  scope,
  onLocations,
  onCompare,
  onFollowUp,
  view,
  isFetching,
  navigationDisabled = false
}) {
  const options = Array.isArray(scope?.available_scopes) ? scope.available_scopes : [];
  const isProject = view === 'project_manager';
  const selectedValue = siteId || scope?.selected_site_id || (isProject ? '__select_project' : '__all');
  const scopeLabelId = useId();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm xl:flex-row xl:items-end">
      <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-3">
        <div className="min-w-0">
          <span id={scopeLabelId} className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{config.scopeLabel}</span>
          <Select value={selectedValue} onValueChange={(value) => setSiteId(value === '__all' ? '' : value)}>
            <SelectTrigger aria-labelledby={scopeLabelId} className="h-10 bg-white"><Building2 className="mr-2 h-4 w-4 text-slate-400" /><SelectValue placeholder={isProject ? 'Select project' : 'All assigned locations'} /></SelectTrigger>
            <SelectContent>
              {!isProject ? <SelectItem value="__all">All assigned locations</SelectItem> : null}
              {isProject && selectedValue === '__select_project' ? <SelectItem value="__select_project" disabled>Select project</SelectItem> : null}
              {options.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Date range start</span>
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <Input
              type="date"
              value={startDate}
              min={MIN_DATE_VALUE}
              max={MAX_DATE_VALUE}
              onChange={(event) => setStartDate(event.target.value || endDate)}
              className="h-10 bg-white pl-9"
            />
          </div>
        </label>
        <label>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Date range end</span>
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <Input
              type="date"
              value={endDate}
              min={MIN_DATE_VALUE}
              max={MAX_DATE_VALUE}
              onChange={(event) => setEndDate(event.target.value || todayValue())}
              className="h-10 bg-white pl-9"
            />
          </div>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={navigationDisabled} onClick={onLocations}><Building2 className="mr-2 h-4 w-4" />View Multiple Location Stats</Button>
        <Button type="button" variant="outline" disabled={navigationDisabled} onClick={onCompare}><BarChart3 className="mr-2 h-4 w-4" />Compare Locations</Button>
        {view === 'agm' ? <Button type="button" disabled={navigationDisabled} className="bg-emerald-700 hover:bg-emerald-800" onClick={onFollowUp}><ClipboardCheck className="mr-2 h-4 w-4" />Operations Follow-up</Button> : null}
        {isFetching ? <div className="flex items-center px-2 text-xs text-slate-500"><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />Refreshing</div> : null}
      </div>
    </div>
  );
}

export default function ManagementDashboard({
  view,
  isAdminPreview = false,
  dateRange: controlledDateRange = null,
  onDateRangeChange = null
}) {
  const normalizedView = normalizeView(view);
  const config = VIEW_CONFIG[normalizedView];
  const [internalDateRange, setInternalDateRange] = useState(getInitialManagementDateRange);
  const activeDateRange = controlledDateRange?.startDate && controlledDateRange?.endDate
    ? controlledDateRange
    : internalDateRange;
  const { startDate, endDate } = activeDateRange;
  const [siteId, setSiteId] = useState('');
  const queryClient = useQueryClient();
  const locationRef = useRef(null);
  const chartRef = useRef(null);
  const actionsRef = useRef(null);

  useEffect(() => {
    setSiteId('');
  }, [normalizedView]);

  const updateDateRange = (nextRange) => {
    if (onDateRangeChange) onDateRangeChange(nextRange);
    else setInternalDateRange(nextRange);
  };

  const setStartDate = (value) => {
    const latestEndDate = shiftDateValue(value, MAX_RANGE_OFFSET_DAYS);
    updateDateRange({
      startDate: value,
      endDate: value > endDate || endDate > latestEndDate
        ? (value > endDate ? value : latestEndDate)
        : endDate
    });
  };
  const setEndDate = (value) => {
    const earliestStartDate = shiftDateValue(value, -MAX_RANGE_OFFSET_DAYS);
    updateDateRange({
      startDate: value < startDate || startDate < earliestStartDate
        ? (value < startDate ? value : earliestStartDate)
        : startDate,
      endDate: value
    });
  };

  const resetDateRange = () => {
    const defaults = getInitialManagementDateRange();
    if (defaults.startDate === startDate && defaults.endDate === endDate) {
      snapshotQuery.refetch();
      return;
    }
    updateDateRange(defaults);
  };

  const queryKey = useMemo(
    () => ['management-dashboard', normalizedView, startDate, endDate, siteId || 'all'],
    [endDate, normalizedView, siteId, startDate]
  );
  const snapshotQuery = useQuery({
    queryKey,
    queryFn: () => base44.managementDashboard.getSnapshot({
      view: normalizedView,
      start_date: startDate,
      end_date: endDate,
      site_id: siteId || undefined
    }),
    placeholderData: (previousData) => previousData?.view === normalizedView ? previousData : undefined,
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true
  });

  useEffect(() => {
    if (normalizedView !== 'project_manager' || siteId) return;
    const responseScope = snapshotQuery.data?.scope;
    if (responseScope?.selected_site_id) return;
    const defaultProjectId = responseScope?.available_scopes?.[0]?.id;
    if (defaultProjectId) setSiteId(String(defaultProjectId));
  }, [normalizedView, siteId, snapshotQuery.data]);

  useEffect(() => {
    const unsubscribe = ENTITY_NAMES.map((entityName) => base44.entities[entityName].subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['management-dashboard'] });
    }));
    return () => unsubscribe.forEach((stop) => stop());
  }, [queryClient]);

  const scrollTo = (reference) => {
    const target = reference.current;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus?.({ preventScroll: true });
  };

  if (snapshotQuery.isLoading) {
    return <AsyncStatePanel variant="loading" title={`Loading ${config.title}`} description="Collecting the latest scoped production, cost, inventory, quality, and workforce data." />;
  }

  if (snapshotQuery.isError) {
    return (
      <div className="space-y-4 pb-8">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{config.title}</h1>
            {isAdminPreview ? <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">Admin preview</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">{config.eyebrow}</p>
        </div>
        <Toolbar
          config={config}
          startDate={startDate}
          endDate={endDate}
          setStartDate={setStartDate}
          setEndDate={setEndDate}
          siteId={siteId}
          setSiteId={setSiteId}
          scope={snapshotQuery.data?.scope || {}}
          view={normalizedView}
          isFetching={snapshotQuery.isFetching}
          navigationDisabled
          onLocations={() => {}}
          onCompare={() => {}}
          onFollowUp={() => {}}
        />
        <AsyncStatePanel
          variant="error"
          title="Management dashboard unavailable"
          description={snapshotQuery.error?.message || 'Live operational data could not be loaded. Adjust the date range above or try again.'}
          action={(
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => snapshotQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Try again</Button>
              <Button type="button" variant="outline" onClick={resetDateRange}><CalendarDays className="mr-2 h-4 w-4" />Reset to last 7 days</Button>
            </div>
          )}
        />
      </div>
    );
  }

  const snapshot = snapshotQuery.data;
  if (!snapshot) {
    return <AsyncStatePanel variant="empty" title="No dashboard data" description="No management snapshot was returned for this role and date range." />;
  }

  const awaitingProjectScope = normalizedView === 'project_manager'
    && !siteId
    && !snapshot.scope?.selected_site_id
    && snapshot.scope?.available_scopes?.length > 0;
  if (awaitingProjectScope) {
    return <AsyncStatePanel variant="loading" title="Selecting assigned project" description="Applying the project scope before management figures are displayed." />;
  }

  const metrics = snapshot.metrics || {};
  const locations = Array.isArray(snapshot.locations) ? snapshot.locations : [];
  const meals = Array.isArray(snapshot.meals) ? snapshot.meals : [];
  const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
  const trends = Array.isArray(snapshot.trends) ? snapshot.trends : [];
  const locationSeries = Array.isArray(snapshot.location_series) ? snapshot.location_series : [];
  const qualityNotes = Array.isArray(snapshot.data_quality) ? snapshot.data_quality : [];
  const actionLinksEnabled = isAdminPreview || normalizedView === 'project_manager';

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{config.title}</h1>
            {isAdminPreview ? <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">Admin preview</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">{config.eyebrow}</p>
        </div>
        <div className={`flex items-center gap-2 text-xs ${snapshotQuery.isRefetchError ? 'text-amber-700' : 'text-slate-500'}`} role="status">
          <span className={`h-2 w-2 rounded-full ${snapshotQuery.isRefetchError ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
          <span>{snapshotQuery.isRefetchError ? `Refresh delayed · ${timestamp(snapshot.generated_at)}` : timestamp(snapshot.generated_at)}</span>
        </div>
      </div>

      <Toolbar
        config={config}
        startDate={startDate}
        endDate={endDate}
        setStartDate={setStartDate}
        setEndDate={setEndDate}
        siteId={siteId}
        setSiteId={setSiteId}
        scope={snapshot.scope || {}}
        view={normalizedView}
        isFetching={snapshotQuery.isFetching}
        onLocations={() => scrollTo(locationRef)}
        onCompare={() => scrollTo(normalizedView === 'agm' ? locationRef : chartRef)}
        onFollowUp={() => scrollTo(actionsRef)}
      />

      {qualityNotes.length > 0 ? (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Data coverage notice</AlertTitle>
          <AlertDescription>{qualityNotes.join(' ')}</AlertDescription>
        </Alert>
      ) : null}

      <PrimaryMetrics metrics={metrics} view={normalizedView} />
      <SecondaryMetrics metrics={metrics} view={normalizedView} />

      {normalizedView === 'project_manager' ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,0.85fr)]">
            <MealOperationsTable meals={meals} panelRef={locationRef} />
            <ActionsPanel actions={actions} title="Approvals & Exceptions" panelRef={actionsRef} linksEnabled={actionLinksEnabled} />
          </div>
          <ProjectCharts trends={trends} meals={meals} panelRef={chartRef} />
        </>
      ) : normalizedView === 'agm' ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2.4fr)_minmax(280px,0.8fr)]">
          <LocationTable locations={locations} mode="agm" panelRef={locationRef} />
          <ActionsPanel actions={actions} title="Current Actions" panelRef={actionsRef} linksEnabled={actionLinksEnabled} />
        </div>
      ) : (
        <>
          <LocationTable locations={locations} mode={normalizedView} panelRef={locationRef} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2.1fr)_minmax(280px,0.8fr)]">
            <div className="min-w-0">
              {normalizedView === 'area_manager'
                ? <AreaCharts locations={locations} panelRef={chartRef} />
                : <GmCharts trends={trends} locations={locations} locationSeries={locationSeries} panelRef={chartRef} />}
            </div>
            <ActionsPanel actions={actions} title={normalizedView === 'area_manager' ? 'Area Actions' : 'Executive Actions'} panelRef={actionsRef} linksEnabled={actionLinksEnabled} />
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />Operational metrics, tables and trends use the selected date range; budgets are informational and do not stop production.</span>
        <span>{snapshot.scope?.selected_site_name || (normalizedView === 'area_manager' ? 'Assigned area' : 'All assigned locations')} · {snapshot.range_start || startDate} to {snapshot.range_end || endDate}</span>
      </div>
    </div>
  );
}
