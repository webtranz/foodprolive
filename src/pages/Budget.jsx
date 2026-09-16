import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, BarChart3, Building2, CalendarDays, CheckCircle2, Landmark, MapPinned, Save, TrendingUp } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import AsyncStatePanel from '@/components/ui/AsyncStatePanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { formatCurrency, formatNumber } from '@/lib/currency';
import { usePermissions } from '@/components/auth/usePermissions';
import { normalizeSiteType, SITE_HIERARCHY_TYPES } from '../../shared/siteHierarchy.js';

const BUDGET_SOURCE_MODULE = 'budget_planning';
const ACTIVE_STATUSES = new Set(['', 'active', 'published']);
const AREA_SCOPE_ROLES = new Set(['admin', 'general_manager', 'assistant_general_manager', 'area_manager']);
const AREA_SCOPE_DASHBOARDS = new Set(['head_office', 'gm', 'agm', 'area_manager']);

const PROJECT_BUDGET_MODES = [
  { value: 'meal', label: 'Daily meal-wise' },
  { value: 'daily', label: 'Daily total' },
  { value: 'monthly', label: 'Monthly budget' }
];

const MEAL_BUDGETS = [
  { key: 'breakfast', label: 'Breakfast', note: 'Morning service allowance' },
  { key: 'lunch', label: 'Lunch', note: 'Main production meal' },
  { key: 'dinner', label: 'Dinner', note: 'Evening service allowance' }
];

const emptyMealBudgetValues = Object.fromEntries(MEAL_BUDGETS.map((meal) => [meal.key, '']));
const emptyMealStats = Object.fromEntries(MEAL_BUDGETS.map((meal) => [meal.key, {
  monthly_food_cost: 0,
  daily_food_cost: 0,
  monthly_wastage_cost: 0,
  daily_wastage_cost: 0,
  monthly_wastage_grams: 0,
  daily_wastage_grams: 0
}]));

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundCurrency(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function dateToken(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function defaultMonthToken() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthPeriod(monthToken) {
  const normalized = /^\d{4}-\d{2}$/.test(String(monthToken || ''))
    ? monthToken
    : defaultMonthToken();
  const [year, month] = normalized.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  return {
    month: normalized,
    startDate: `${normalized}-01`,
    endDate: `${normalized}-${String(daysInMonth).padStart(2, '0')}`,
    daysInMonth
  };
}

function formatMonthLabel(monthToken) {
  const period = getMonthPeriod(monthToken);
  const [year, month] = period.month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function inclusiveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

function overlapDays(startDate, endDate, period) {
  const start = normalizeDateOnly(startDate) || period.startDate;
  const end = normalizeDateOnly(endDate) || start;
  const effectiveStart = start > period.startDate ? start : period.startDate;
  const effectiveEnd = end < period.endDate ? end : period.endDate;
  return inclusiveDays(effectiveStart, effectiveEnd);
}

function isActiveBudget(record = {}) {
  return ACTIVE_STATUSES.has(String(record.status || 'active').trim().toLowerCase());
}

function isDailyBudget(record = {}) {
  return String(record.scope_type || '').trim().toLowerCase().includes('daily')
    || Boolean(record.budget_date);
}

function budgetMonthlyContribution(record = {}, period) {
  if (!isActiveBudget(record)) return 0;
  const days = overlapDays(record.start_date || record.budget_date, record.end_date || record.budget_date, period);
  if (days <= 0) return 0;
  const amount = Math.max(0, toNumber(record.budget_amount ?? record.amount, 0));
  if (isDailyBudget(record)) return amount * days;
  const budgetDays = inclusiveDays(
    normalizeDateOnly(record.start_date || record.budget_date) || period.startDate,
    normalizeDateOnly(record.end_date || record.budget_date || record.start_date) || period.endDate
  ) || period.daysInMonth;
  return amount * (days / budgetDays);
}

function summarizeBudgets(records = [], siteIds = [], period) {
  const idSet = new Set(siteIds.filter(Boolean).map(String));
  const mealTotals = Object.fromEntries(MEAL_BUDGETS.map((meal) => [meal.key, 0]));
  let monthlyBudget = 0;

  records
    .filter((record) => idSet.has(String(record.site_id || '')))
    .forEach((record) => {
      const amount = budgetMonthlyContribution(record, period);
      monthlyBudget += amount;
      const mealType = String(record.meal_type || '').trim().toLowerCase();
      if (mealTotals[mealType] !== undefined) {
        mealTotals[mealType] += amount;
      }
    });

  return {
    monthly_budget: roundCurrency(monthlyBudget),
    daily_budget: roundCurrency(monthlyBudget / Math.max(1, period.daysInMonth)),
    meal_totals: Object.fromEntries(Object.entries(mealTotals).map(([key, amount]) => [
      key,
      {
        monthly_budget: roundCurrency(amount),
        daily_budget: roundCurrency(amount / Math.max(1, period.daysInMonth))
      }
    ]))
  };
}

function buildChildren(sites = []) {
  const children = new Map();
  sites.forEach((site) => {
    const parentId = site.parent_site_id ? String(site.parent_site_id) : null;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(site);
  });
  return children;
}

function collectDescendantIds(rootId, children) {
  const result = new Set();
  const queue = rootId ? [String(rootId)] : [];
  while (queue.length) {
    const current = queue.shift();
    if (!current || result.has(current)) continue;
    result.add(current);
    (children.get(current) || []).forEach((site) => queue.push(String(site.id)));
  }
  return result;
}

function aggregateSiteSummaries(summaries = [], siteIds = []) {
  const idSet = new Set(siteIds.filter(Boolean).map(String));
  const result = {
    monthly_food_cost: 0,
    daily_food_cost: 0,
    monthly_wastage_cost: 0,
    daily_wastage_cost: 0,
    monthly_wastage_grams: 0,
    daily_wastage_grams: 0,
    meal_stats: JSON.parse(JSON.stringify(emptyMealStats))
  };

  summaries
    .filter((summary) => idSet.has(String(summary.site_id || '')))
    .forEach((summary) => {
      result.monthly_food_cost += toNumber(summary.monthly_food_cost, 0);
      result.daily_food_cost += toNumber(summary.daily_food_cost, 0);
      result.monthly_wastage_cost += toNumber(summary.monthly_wastage_cost, 0);
      result.daily_wastage_cost += toNumber(summary.daily_wastage_cost, 0);
      result.monthly_wastage_grams += toNumber(summary.monthly_wastage_grams, 0);
      result.daily_wastage_grams += toNumber(summary.daily_wastage_grams, 0);

      MEAL_BUDGETS.forEach((meal) => {
        const mealStats = summary.meal_stats?.[meal.key] || {};
        result.meal_stats[meal.key].monthly_food_cost += toNumber(mealStats.monthly_food_cost, 0);
        result.meal_stats[meal.key].daily_food_cost += toNumber(mealStats.daily_food_cost, 0);
        result.meal_stats[meal.key].monthly_wastage_cost += toNumber(mealStats.monthly_wastage_cost, 0);
        result.meal_stats[meal.key].daily_wastage_cost += toNumber(mealStats.daily_wastage_cost, 0);
        result.meal_stats[meal.key].monthly_wastage_grams += toNumber(mealStats.monthly_wastage_grams, 0);
        result.meal_stats[meal.key].daily_wastage_grams += toNumber(mealStats.daily_wastage_grams, 0);
      });
    });

  return {
    ...result,
    monthly_food_cost: roundCurrency(result.monthly_food_cost),
    daily_food_cost: roundCurrency(result.daily_food_cost),
    monthly_wastage_cost: roundCurrency(result.monthly_wastage_cost),
    daily_wastage_cost: roundCurrency(result.daily_wastage_cost),
    monthly_wastage_grams: roundCurrency(result.monthly_wastage_grams),
    daily_wastage_grams: roundCurrency(result.daily_wastage_grams)
  };
}

function getPlanningBudgetRecords(records = [], { siteId, budgetLevel, period }) {
  return records.filter((record) => (
    String(record.site_id || '') === String(siteId || '')
    && String(record.source_module || '') === BUDGET_SOURCE_MODULE
    && String(record.budget_level || '') === String(budgetLevel || '')
    && overlapDays(record.start_date, record.end_date, period) > 0
  ));
}

function getBudgetByKey(records = [], key) {
  return records.find((record) => String(record.budget_key || '') === key && isActiveBudget(record)) || null;
}

function normalizeAmountInput(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

function buildBudgetRecord({
  target,
  period,
  mode,
  mealType = 'all',
  amount,
  monthlyAmount = null,
  dailyAmount = null,
  note = ''
}) {
  const level = target.level === 'area' ? 'area' : 'project';
  const modeLabel = mode === 'meal'
    ? `${mealType} daily meal-wise`
    : mode === 'daily'
      ? 'daily total'
      : 'monthly total';
  const budgetKey = `${BUDGET_SOURCE_MODULE}:${level}:${target.id}:${period.month}:${mode}:${mealType}`;
  const monthlyBudgetAmount = monthlyAmount !== null
    ? monthlyAmount
    : (mode === 'monthly' ? amount : amount * period.daysInMonth);
  const dailyBudgetAmount = dailyAmount !== null
    ? dailyAmount
    : (mode === 'monthly' ? amount / Math.max(1, period.daysInMonth) : amount);

  return {
    budget_key: budgetKey,
    name: `${target.name} · ${formatMonthLabel(period.month)} · ${modeLabel} budget`,
    site_id: target.id,
    site_name: target.name,
    start_date: period.startDate,
    end_date: period.endDate,
    budget_amount: roundCurrency(amount),
    currency: 'SAR',
    scope_type: `${level}_${mode === 'monthly' ? 'period' : 'daily'}_${mode === 'meal' ? 'meal' : 'total'}`,
    meal_type: mealType,
    category: 'food_budget',
    department: 'food_operations',
    status: 'active',
    source_module: BUDGET_SOURCE_MODULE,
    budget_level: level,
    budget_mode: mode,
    daily_budget_amount: roundCurrency(dailyBudgetAmount),
    monthly_budget_amount: roundCurrency(monthlyBudgetAmount),
    notes: note
  };
}

function StatTile({ label, value, hint, tone = 'slate', icon: Icon = BarChart3 }) {
  const toneClass = tone === 'green'
    ? 'text-emerald-700'
    : tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
        ? 'text-red-700'
        : 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <p className={`mt-2 text-xl font-semibold ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default function Budget() {
  const queryClient = useQueryClient();
  const { can, isAdmin, role, dashboardView, currentUser, loading: permissionsLoading } = usePermissions();
  const [month, setMonth] = useState(defaultMonthToken());
  const [scope, setScope] = useState('project');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedAreaId, setSelectedAreaId] = useState('');
  const [selectedAreaSiteId, setSelectedAreaSiteId] = useState('all');
  const [projectBudgetMode, setProjectBudgetMode] = useState('meal');
  const [mealBudgetValues, setMealBudgetValues] = useState(emptyMealBudgetValues);
  const [dailyBudgetValue, setDailyBudgetValue] = useState('');
  const [monthlyBudgetValue, setMonthlyBudgetValue] = useState('');
  const [areaDailyBudgetValue, setAreaDailyBudgetValue] = useState('');
  const [areaMonthlyBudgetValue, setAreaMonthlyBudgetValue] = useState('');

  const period = useMemo(() => getMonthPeriod(month), [month]);
  const today = dateToken(new Date());
  const dailyStatsDate = today >= period.startDate && today <= period.endDate ? today : period.startDate;
  const canManageBudget = can('manage_budget');
  const normalizedRole = String(role || '').trim().toLowerCase();
  const canUseAreaScope = isAdmin || AREA_SCOPE_ROLES.has(normalizedRole) || AREA_SCOPE_DASHBOARDS.has(String(dashboardView || ''));

  const {
    data: context,
    isLoading,
    error
  } = useQuery({
    queryKey: ['budgetPlanningContext', period.month, dailyStatsDate],
    queryFn: () => base44.budgets.getPlanningContext({ month: period.month, date: dailyStatsDate }),
    enabled: !permissionsLoading && (can('view_budget') || canManageBudget)
  });

  const sites = useMemo(() => Array.isArray(context?.sites) ? context.sites : [], [context?.sites]);
  const budgets = useMemo(() => Array.isArray(context?.budgets) ? context.budgets : [], [context?.budgets]);
  const siteSummaries = useMemo(() => Array.isArray(context?.site_summaries) ? context.site_summaries : [], [context?.site_summaries]);
  const siteMap = useMemo(() => new Map(sites.map((site) => [String(site.id), site])), [sites]);
  const children = useMemo(() => buildChildren(sites), [sites]);

  const areaOptions = useMemo(() => sites
    .filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.AREA)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))), [sites]);
  const projectOptions = useMemo(() => sites
    .filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))), [sites]);

  const areaProjectOptions = useMemo(() => {
    if (!selectedAreaId) return [];
    const areaIds = collectDescendantIds(selectedAreaId, children);
    return projectOptions.filter((site) => areaIds.has(String(site.id)));
  }, [children, projectOptions, selectedAreaId]);

  useEffect(() => {
    if (!canUseAreaScope && scope === 'area') {
      setScope('project');
    }
  }, [canUseAreaScope, scope]);

  useEffect(() => {
    if (!selectedAreaId && areaOptions.length > 0) {
      setSelectedAreaId(areaOptions[0].id);
    } else if (selectedAreaId && !areaOptions.some((site) => String(site.id) === String(selectedAreaId))) {
      setSelectedAreaId(areaOptions[0]?.id || '');
    }
  }, [areaOptions, selectedAreaId]);

  useEffect(() => {
    const currentAssigned = currentUser?.site_id && projectOptions.some((site) => String(site.id) === String(currentUser.site_id))
      ? String(currentUser.site_id)
      : '';
    if (!selectedProjectId && (currentAssigned || projectOptions.length > 0)) {
      setSelectedProjectId(currentAssigned || projectOptions[0].id);
    } else if (selectedProjectId && !projectOptions.some((site) => String(site.id) === String(selectedProjectId))) {
      setSelectedProjectId(projectOptions[0]?.id || '');
    }
  }, [currentUser?.site_id, projectOptions, selectedProjectId]);

  useEffect(() => {
    if (selectedAreaSiteId !== 'all' && !areaProjectOptions.some((site) => String(site.id) === String(selectedAreaSiteId))) {
      setSelectedAreaSiteId('all');
    }
  }, [areaProjectOptions, selectedAreaSiteId]);

  useEffect(() => {
    if (scope === 'project' && projectOptions.length === 0 && canUseAreaScope && areaOptions.length > 0) {
      setScope('area');
    }
  }, [areaOptions.length, canUseAreaScope, projectOptions.length, scope]);

  const budgetTarget = useMemo(() => {
    if (scope === 'area') {
      if (selectedAreaSiteId === 'all') {
        const area = siteMap.get(String(selectedAreaId));
        return area ? { id: String(area.id), name: area.name || 'Selected area', level: 'area' } : null;
      }
      const site = siteMap.get(String(selectedAreaSiteId));
      return site ? { id: String(site.id), name: site.name || 'Selected site', level: 'project' } : null;
    }
    const site = siteMap.get(String(selectedProjectId));
    return site ? { id: String(site.id), name: site.name || 'Selected project', level: 'project' } : null;
  }, [scope, selectedAreaId, selectedAreaSiteId, selectedProjectId, siteMap]);

  const selectedSummarySiteIds = useMemo(() => {
    if (scope === 'area' && selectedAreaSiteId === 'all') {
      return areaProjectOptions.map((site) => String(site.id));
    }
    return budgetTarget?.level === 'project' ? [budgetTarget.id] : [];
  }, [areaProjectOptions, budgetTarget, scope, selectedAreaSiteId]);

  const selectedStats = useMemo(
    () => aggregateSiteSummaries(siteSummaries, selectedSummarySiteIds),
    [selectedSummarySiteIds, siteSummaries]
  );

  const ownBudgetSummary = useMemo(() => (
    budgetTarget ? summarizeBudgets(budgets, [budgetTarget.id], period) : summarizeBudgets([], [], period)
  ), [budgetTarget, budgets, period]);

  const childBudgetSummary = useMemo(() => (
    summarizeBudgets(budgets, selectedSummarySiteIds, period)
  ), [budgets, period, selectedSummarySiteIds]);

  const selectedBudgetSummary = scope === 'area' && selectedAreaSiteId === 'all' && ownBudgetSummary.monthly_budget <= 0
    ? childBudgetSummary
    : ownBudgetSummary;

  const currentPlanningBudgetRecords = useMemo(() => (
    budgetTarget
      ? getPlanningBudgetRecords(budgets, {
        siteId: budgetTarget.id,
        budgetLevel: budgetTarget.level,
        period
      })
      : []
  ), [budgetTarget, budgets, period]);

  const planningBudgetKey = useMemo(() => (
    currentPlanningBudgetRecords
      .map((record) => `${record.id}:${record.budget_key}:${record.status}:${record.budget_amount}:${record.daily_budget_amount}:${record.monthly_budget_amount}`)
      .join('|')
  ), [currentPlanningBudgetRecords]);

  useEffect(() => {
    if (!budgetTarget) return;
    const records = currentPlanningBudgetRecords;
    const mealValues = { ...emptyMealBudgetValues };
    MEAL_BUDGETS.forEach((meal) => {
      const record = getBudgetByKey(records, `${BUDGET_SOURCE_MODULE}:project:${budgetTarget.id}:${period.month}:meal:${meal.key}`);
      mealValues[meal.key] = record ? String(toNumber(record.budget_amount, 0)) : '';
    });
    setMealBudgetValues(mealValues);

    const dailyRecord = getBudgetByKey(records, `${BUDGET_SOURCE_MODULE}:${budgetTarget.level}:${budgetTarget.id}:${period.month}:daily:all`);
    const monthlyRecord = getBudgetByKey(records, `${BUDGET_SOURCE_MODULE}:${budgetTarget.level}:${budgetTarget.id}:${period.month}:monthly:all`);
    setDailyBudgetValue(dailyRecord ? String(toNumber(dailyRecord.budget_amount, 0)) : '');
    setMonthlyBudgetValue(monthlyRecord ? String(toNumber(monthlyRecord.budget_amount, 0)) : '');

    const activeRecord = monthlyRecord || dailyRecord;
    setAreaDailyBudgetValue(activeRecord
      ? String(toNumber(activeRecord.daily_budget_amount, isDailyBudget(activeRecord)
        ? activeRecord.budget_amount
        : toNumber(activeRecord.budget_amount, 0) / Math.max(1, period.daysInMonth)))
      : '');
    setAreaMonthlyBudgetValue(activeRecord
      ? String(toNumber(activeRecord.monthly_budget_amount, isDailyBudget(activeRecord)
        ? toNumber(activeRecord.budget_amount, 0) * period.daysInMonth
        : activeRecord.budget_amount))
      : '');
  }, [budgetTarget, currentPlanningBudgetRecords, period.daysInMonth, period.month, planningBudgetKey]);

  const saveBudgetMutation = useMutation({
    mutationFn: async () => {
      if (!budgetTarget) {
        throw new Error('Select an area or project before saving a budget.');
      }
      if (!canManageBudget) {
        throw new Error('You do not have permission to manage budgets.');
      }

      let nextRecords = [];
      if (scope === 'project') {
        if (projectBudgetMode === 'meal') {
          nextRecords = MEAL_BUDGETS
            .map((meal) => ({
              meal,
              amount: normalizeAmountInput(mealBudgetValues[meal.key])
            }))
            .filter((entry) => entry.amount > 0)
            .map(({ meal, amount }) => buildBudgetRecord({
              target: budgetTarget,
              period,
              mode: 'meal',
              mealType: meal.key,
              amount,
              note: `${meal.label} daily informational food budget. This does not block production.`
            }));
        } else if (projectBudgetMode === 'daily') {
          const amount = normalizeAmountInput(dailyBudgetValue);
          if (amount > 0) {
            nextRecords = [buildBudgetRecord({
              target: budgetTarget,
              period,
              mode: 'daily',
              amount,
              note: 'Daily informational project food budget. This does not block production.'
            })];
          }
        } else {
          const amount = normalizeAmountInput(monthlyBudgetValue);
          if (amount > 0) {
            nextRecords = [buildBudgetRecord({
              target: budgetTarget,
              period,
              mode: 'monthly',
              amount,
              note: 'Monthly informational project food budget. This does not block production.'
            })];
          }
        }
      } else {
        const dailyAmount = normalizeAmountInput(areaDailyBudgetValue);
        const monthlyAmount = normalizeAmountInput(areaMonthlyBudgetValue);
        const mode = monthlyAmount > 0 ? 'monthly' : 'daily';
        const amount = mode === 'monthly' ? monthlyAmount : dailyAmount;
        if (amount > 0) {
          nextRecords = [buildBudgetRecord({
            target: budgetTarget,
            period,
            mode,
            amount,
            dailyAmount: mode === 'monthly' ? monthlyAmount / Math.max(1, period.daysInMonth) : dailyAmount,
            monthlyAmount: mode === 'monthly' ? monthlyAmount : dailyAmount * period.daysInMonth,
            note: `${budgetTarget.level === 'area' ? 'Area' : 'Site'} informational food budget. This does not block production.`
          })];
        }
      }

      if (!nextRecords.length) {
        throw new Error('Enter at least one budget amount before saving.');
      }

      const nextKeys = new Set(nextRecords.map((record) => record.budget_key));
      const updates = [];
      for (const record of currentPlanningBudgetRecords) {
        if (!nextKeys.has(String(record.budget_key || '')) && isActiveBudget(record)) {
          updates.push(base44.entities.Budget.update(record.id, { status: 'inactive' }));
        }
      }

      for (const record of nextRecords) {
        const existing = currentPlanningBudgetRecords.find((item) => String(item.budget_key || '') === record.budget_key);
        if (existing) {
          updates.push(base44.entities.Budget.update(existing.id, record));
        } else {
          updates.push(base44.entities.Budget.create(record));
        }
      }

      await Promise.all(updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgetPlanningContext'] });
      queryClient.invalidateQueries({ queryKey: ['entity:Budget'] });
      toast({
        title: 'Budget saved',
        description: 'The informational budget is available for reporting and dashboards.'
      });
    },
    onError: (mutationError) => {
      toast({
        title: 'Budget was not saved',
        description: mutationError.message || 'Please review the budget inputs and try again.',
        variant: 'destructive'
      });
    }
  });

  if (permissionsLoading || isLoading) {
    return <AsyncStatePanel variant="loading" title="Loading budget planning" description="Preparing scoped budget, cost, and waste information." />;
  }

  if (error) {
    return <AsyncStatePanel variant="error" title="Unable to load budgets" description={error.message || 'Budget planning data is unavailable.'} />;
  }

  if (!can('view_budget') && !canManageBudget) {
    return <AsyncStatePanel variant="error" title="Access restricted" description="You do not have permission to access budget planning." />;
  }

  const selectedAreaName = siteMap.get(String(selectedAreaId))?.name || 'Selected area';
  const selectedStatsLabel = scope === 'area'
    ? selectedAreaSiteId === 'all'
      ? selectedAreaName
      : budgetTarget?.name || 'Selected site'
    : budgetTarget?.name || 'Selected project';
  const budgetUsage = selectedBudgetSummary.monthly_budget > 0
    ? Math.round((selectedStats.monthly_food_cost / selectedBudgetSummary.monthly_budget) * 100)
    : 0;
  const wasteShare = selectedStats.monthly_food_cost > 0
    ? ((selectedStats.monthly_wastage_cost / selectedStats.monthly_food_cost) * 100)
    : 0;
  const projectedVariance = selectedBudgetSummary.monthly_budget - selectedStats.monthly_food_cost;

  const renderProjectBudgetMode = () => {
    if (projectBudgetMode === 'daily') {
      const dailyAmount = normalizeAmountInput(dailyBudgetValue);
      return (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="grid gap-4 md:grid-cols-[1fr_220px] md:items-end">
            <div>
              <Badge variant="outline" className="bg-white">Daily total budget</Badge>
              <h3 className="mt-3 text-lg font-semibold text-slate-900">Daily project food budget</h3>
              <p className="mt-1 text-sm text-slate-500">
                Applies one daily amount to every day in {formatMonthLabel(period.month)} and remains informational only.
              </p>
            </div>
            <div>
              <Label htmlFor="dailyBudgetValue">Daily budget</Label>
              <Input
                id="dailyBudgetValue"
                type="number"
                min="0"
                step="0.01"
                className="mt-2 bg-white text-right text-lg font-semibold"
                value={dailyBudgetValue}
                onChange={(event) => setDailyBudgetValue(event.target.value)}
                disabled={!canManageBudget}
                placeholder="0.00"
              />
              <p className="mt-2 text-right text-xs text-slate-500">
                Monthly equivalent: {formatCurrency(dailyAmount * period.daysInMonth)}
              </p>
            </div>
          </div>
        </div>
      );
    }

    if (projectBudgetMode === 'monthly') {
      const monthlyAmount = normalizeAmountInput(monthlyBudgetValue);
      return (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="grid gap-4 md:grid-cols-[1fr_220px] md:items-end">
            <div>
              <Badge variant="outline" className="bg-white">Monthly budget</Badge>
              <h3 className="mt-3 text-lg font-semibold text-slate-900">Monthly project food budget</h3>
              <p className="mt-1 text-sm text-slate-500">
                Use this when finance provides a single monthly cap. Daily reporting is derived automatically.
              </p>
            </div>
            <div>
              <Label htmlFor="monthlyBudgetValue">Monthly budget</Label>
              <Input
                id="monthlyBudgetValue"
                type="number"
                min="0"
                step="0.01"
                className="mt-2 bg-white text-right text-lg font-semibold"
                value={monthlyBudgetValue}
                onChange={(event) => setMonthlyBudgetValue(event.target.value)}
                disabled={!canManageBudget}
                placeholder="0.00"
              />
              <p className="mt-2 text-right text-xs text-slate-500">
                Daily equivalent: {formatCurrency(monthlyAmount / Math.max(1, period.daysInMonth))}
              </p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead>Meal</TableHead>
              <TableHead className="text-right">Daily budget</TableHead>
              <TableHead className="text-right">Monthly total</TableHead>
              <TableHead className="text-right">Daily food cost</TableHead>
              <TableHead className="text-right">Daily wastage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MEAL_BUDGETS.map((meal) => {
              const dailyBudget = normalizeAmountInput(mealBudgetValues[meal.key]);
              const mealStats = selectedStats.meal_stats?.[meal.key] || {};
              return (
                <TableRow key={meal.key}>
                  <TableCell>
                    <div className="font-medium text-slate-900">{meal.label}</div>
                    <div className="text-xs text-slate-500">{meal.note}</div>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="ml-auto max-w-[150px] bg-white text-right font-semibold"
                      value={mealBudgetValues[meal.key]}
                      onChange={(event) => setMealBudgetValues((current) => ({
                        ...current,
                        [meal.key]: event.target.value
                      }))}
                      disabled={!canManageBudget}
                      placeholder="0.00"
                      aria-label={`${meal.label} daily budget`}
                    />
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(dailyBudget * period.daysInMonth)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(mealStats.daily_food_cost || 0)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(mealStats.daily_wastage_cost || 0)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  };

  const renderAreaBudgetEntry = () => {
    const dailyAmount = normalizeAmountInput(areaDailyBudgetValue);
    const monthlyAmount = normalizeAmountInput(areaMonthlyBudgetValue);
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {selectedAreaSiteId === 'all'
            ? 'Area selected only: this view summarizes by site totals. It does not show menu type, meal type, recipe, or dish details.'
            : 'Area plus site selected: this maintains the selected site budget while keeping the view tied to the parent area.'}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <Label htmlFor="areaDailyBudgetValue">
              {budgetTarget?.level === 'area' ? 'Area daily total budget' : 'Site daily total budget'}
            </Label>
            <Input
              id="areaDailyBudgetValue"
              type="number"
              min="0"
              step="0.01"
              className="mt-2 bg-white text-right text-lg font-semibold"
              value={areaDailyBudgetValue}
              onChange={(event) => setAreaDailyBudgetValue(event.target.value)}
              disabled={!canManageBudget}
              placeholder="0.00"
            />
            <p className="mt-2 text-xs text-slate-500">
              Monthly equivalent: {formatCurrency(dailyAmount * period.daysInMonth)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <Label htmlFor="areaMonthlyBudgetValue">
              {budgetTarget?.level === 'area' ? 'Area monthly budget' : 'Site monthly budget'}
            </Label>
            <Input
              id="areaMonthlyBudgetValue"
              type="number"
              min="0"
              step="0.01"
              className="mt-2 bg-white text-right text-lg font-semibold"
              value={areaMonthlyBudgetValue}
              onChange={(event) => setAreaMonthlyBudgetValue(event.target.value)}
              disabled={!canManageBudget}
              placeholder="0.00"
            />
            <p className="mt-2 text-xs text-slate-500">
              Daily equivalent: {formatCurrency(monthlyAmount / Math.max(1, period.daysInMonth))}
            </p>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Enter either a daily or monthly total. If both are entered, the monthly total is used and the daily value is derived for reporting.
        </p>

        {selectedAreaSiteId === 'all' ? (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead>Site</TableHead>
                  <TableHead className="text-right">Daily budget</TableHead>
                  <TableHead className="text-right">Monthly budget</TableHead>
                  <TableHead className="text-right">Daily food cost</TableHead>
                  <TableHead className="text-right">Monthly food cost</TableHead>
                  <TableHead className="text-right">Daily wastage</TableHead>
                  <TableHead className="text-right">Monthly wastage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {areaProjectOptions.length > 0 ? areaProjectOptions.map((site) => {
                  const summary = aggregateSiteSummaries(siteSummaries, [site.id]);
                  const siteBudget = summarizeBudgets(budgets, [site.id], period);
                  return (
                    <TableRow key={site.id}>
                      <TableCell>
                        <div className="font-medium text-slate-900">{site.name}</div>
                        <div className="text-xs text-slate-500">{site.project_code || 'Project site'}</div>
                      </TableCell>
                      <TableCell className="text-right">{formatCurrency(siteBudget.daily_budget)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(siteBudget.monthly_budget)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(summary.daily_food_cost)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(summary.monthly_food_cost)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(summary.daily_wastage_cost)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(summary.monthly_wastage_cost)}</TableCell>
                    </TableRow>
                  );
                }) : (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                      No project sites are available under this area.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead>Budget control</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="text-right">Food cost</TableHead>
                  <TableHead className="text-right">Wastage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Daily total</TableCell>
                  <TableCell className="text-right">{formatCurrency(selectedBudgetSummary.daily_budget)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(selectedStats.daily_food_cost)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(selectedStats.daily_wastage_cost)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Monthly total</TableCell>
                  <TableCell className="text-right">{formatCurrency(selectedBudgetSummary.monthly_budget)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(selectedStats.monthly_food_cost)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(selectedStats.monthly_wastage_cost)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <PageHeader
        title="Budget Planning"
        description="Informational food budgets for projects, sites, and areas. Budgets support reporting and dashboards but never stop production."
      >
        <Badge variant="outline" className="bg-white">
          {canManageBudget ? 'Budget manager' : 'View only'}
        </Badge>
      </PageHeader>

      <div className="mb-6 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <Label htmlFor="budgetMonth">Budget period</Label>
            <Input
              id="budgetMonth"
              type="month"
              className="mt-2 bg-white"
              value={month}
              onChange={(event) => setMonth(event.target.value || defaultMonthToken())}
            />
          </div>
          {scope === 'project' ? (
            <div className="md:col-span-2">
              <Label>Project / site</Label>
              <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger className="mt-2 bg-white">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projectOptions.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <div>
                <Label>Area</Label>
                <Select value={selectedAreaId} onValueChange={(value) => {
                  setSelectedAreaId(value);
                  setSelectedAreaSiteId('all');
                }}>
                  <SelectTrigger className="mt-2 bg-white">
                    <SelectValue placeholder="Select area" />
                  </SelectTrigger>
                  <SelectContent>
                    {areaOptions.map((area) => (
                      <SelectItem key={area.id} value={area.id}>
                        {area.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Site</Label>
                <Select value={selectedAreaSiteId} onValueChange={setSelectedAreaSiteId}>
                  <SelectTrigger className="mt-2 bg-white">
                    <SelectValue placeholder="All sites in selected area" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sites in selected area</SelectItem>
                    {areaProjectOptions.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>

        {canUseAreaScope ? (
          <div className="flex rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            <Button
              type="button"
              variant={scope === 'project' ? 'default' : 'ghost'}
              onClick={() => setScope('project')}
              className="rounded-xl"
            >
              Project / site
            </Button>
            <Button
              type="button"
              variant={scope === 'area' ? 'default' : 'ghost'}
              onClick={() => setScope('area')}
              className="rounded-xl"
            >
              Area
            </Button>
          </div>
        ) : null}
      </div>

      {!budgetTarget && (
        <AsyncStatePanel
          variant="empty"
          title="No budget scope available"
          description="No authorized project or area was found for your role."
        />
      )}

      {budgetTarget ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]">
          <Card className="border-slate-100 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    {scope === 'area' ? <MapPinned className="h-5 w-5 text-blue-600" /> : <Landmark className="h-5 w-5 text-emerald-600" />}
                    {scope === 'area' && selectedAreaSiteId === 'all' ? 'Area budget setup' : 'Project budget setup'}
                  </CardTitle>
                  <p className="mt-1 text-sm text-slate-500">
                    {scope === 'area' && selectedAreaSiteId === 'all'
                      ? 'Set daily or monthly budget for the selected area and review site-level totals only.'
                      : 'Set meal-wise, daily, or monthly budget for the selected project/site.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="bg-white">{formatMonthLabel(period.month)}</Badge>
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-700">
                    Informational only
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className={`grid gap-3 ${scope === 'area' ? 'md:grid-cols-3' : 'md:grid-cols-4'}`}>
                <StatTile label="Monthly budget" value={formatCurrency(selectedBudgetSummary.monthly_budget)} hint={selectedBudgetSummary.monthly_budget > 0 ? 'Available in reporting' : 'No active budget yet'} icon={CalendarDays} />
                <StatTile label="Daily budget" value={formatCurrency(selectedBudgetSummary.daily_budget)} hint="Derived from active budget" icon={TrendingUp} />
                <StatTile label="Monthly food cost" value={formatCurrency(selectedStats.monthly_food_cost)} hint={selectedStatsLabel} icon={Building2} />
                {scope !== 'area' ? (
                  <StatTile label="Daily food cost" value={formatCurrency(selectedStats.daily_food_cost)} hint={context?.daily_date || dailyStatsDate} icon={BarChart3} />
                ) : null}
              </div>

              {scope === 'project' ? (
                <>
                  <div className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-100 p-1 md:grid-cols-3">
                    {PROJECT_BUDGET_MODES.map((mode) => (
                      <Button
                        key={mode.value}
                        type="button"
                        variant={projectBudgetMode === mode.value ? 'default' : 'ghost'}
                        onClick={() => setProjectBudgetMode(mode.value)}
                        className="rounded-xl"
                      >
                        {mode.label}
                      </Button>
                    ))}
                  </div>
                  {renderProjectBudgetMode()}
                </>
              ) : renderAreaBudgetEntry()}

              <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2 text-sm text-slate-500">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                  <span>Budget is informational. It appears in reports and dashboards, but it does not block production approval, start, or completion.</span>
                </div>
                <Button
                  type="button"
                  onClick={() => saveBudgetMutation.mutate()}
                  disabled={!canManageBudget || saveBudgetMutation.isPending}
                >
                  <Save className="mr-2 h-4 w-4" />
                  {saveBudgetMutation.isPending ? 'Saving...' : 'Save budget'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <aside className="space-y-4">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Food cost stats</CardTitle>
                <p className="text-sm text-slate-500">For {selectedStatsLabel}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <StatTile label="Monthly food cost" value={formatCurrency(selectedStats.monthly_food_cost)} hint={`Selected period: ${formatMonthLabel(period.month)}`} icon={BarChart3} />
                <StatTile label="Daily food cost" value={formatCurrency(selectedStats.daily_food_cost)} hint={`Selected date: ${context?.daily_date || dailyStatsDate}`} icon={TrendingUp} />
                <StatTile
                  label={projectedVariance >= 0 ? 'Remaining budget' : 'Over budget'}
                  value={formatCurrency(projectedVariance)}
                  hint={selectedBudgetSummary.monthly_budget > 0 ? `${Math.max(0, budgetUsage)}% of budget used` : 'Set a budget to compare'}
                  tone={projectedVariance >= 0 ? 'green' : 'red'}
                  icon={CheckCircle2}
                />
                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-500">
                    <span>Budget used</span>
                    <span>{selectedBudgetSummary.monthly_budget > 0 ? `${Math.max(0, budgetUsage)}%` : '—'}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${budgetUsage > 100 ? 'bg-red-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, Math.max(0, budgetUsage))}%` }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-100 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Food wastage stats</CardTitle>
                <p className="text-sm text-slate-500">For {selectedStatsLabel}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <StatTile
                  label="Monthly wastage"
                  value={formatCurrency(selectedStats.monthly_wastage_cost)}
                  hint={`${formatNumber(selectedStats.monthly_wastage_grams / 1000, 1)} kg recorded`}
                  tone="amber"
                  icon={BarChart3}
                />
                <StatTile
                  label="Daily wastage"
                  value={formatCurrency(selectedStats.daily_wastage_cost)}
                  hint={`${formatNumber(selectedStats.daily_wastage_grams / 1000, 1)} kg on ${context?.daily_date || dailyStatsDate}`}
                  tone="amber"
                  icon={TrendingUp}
                />
                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-500">
                    <span>Waste as food cost %</span>
                    <span>{formatNumber(wasteShare, 1)}%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-amber-500"
                      style={{ width: `${Math.min(100, Math.max(0, wasteShare))}%` }}
                    />
                  </div>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                  Stats are calculated from the selected site or area only, using scoped production and food waste records.
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
