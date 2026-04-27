import React, { useMemo, useState } from 'react';
import { format, subDays } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import StatCard from '@/components/ui/StatCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV } from '@/components/utils/exportData';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Download,
  Factory,
  Plus,
  Target,
  Trash2,
  TrendingDown,
  XCircle
} from 'lucide-react';

const WASTE_CATEGORIES = [
  { value: 'ingredient_loss', label: 'Ingredient Loss', color: '#ef4444' },
  { value: 'recipe_return', label: 'Recipe Return', color: '#f97316' },
  { value: 'batch_overproduction', label: 'Batch Overproduction', color: '#eab308' },
  { value: 'plate_waste', label: 'Plate Waste', color: '#22c55e' },
  { value: 'expired_stock', label: 'Expired Stock', color: '#8b5cf6' },
  { value: 'storage_damage', label: 'Storage Damage', color: '#6366f1' },
  { value: 'prep_trim', label: 'Prep Trim', color: '#ec4899' }
];

const WASTE_REASONS = [
  { value: 'overproduction', label: 'Overproduction', avoidableType: 'avoidable' },
  { value: 'poor_forecast', label: 'Poor Forecast', avoidableType: 'avoidable' },
  { value: 'quality_reject', label: 'Quality Reject', avoidableType: 'avoidable' },
  { value: 'portioning_error', label: 'Portioning Error', avoidableType: 'avoidable' },
  { value: 'damaged_storage', label: 'Damaged in Storage', avoidableType: 'avoidable' },
  { value: 'expired_inventory', label: 'Expired Inventory', avoidableType: 'avoidable' },
  { value: 'trim_loss', label: 'Trim / Peel Loss', avoidableType: 'unavoidable' },
  { value: 'bone_and_shell', label: 'Bone / Shell Waste', avoidableType: 'unavoidable' },
  { value: 'cooking_evaporation', label: 'Cooking Evaporation', avoidableType: 'unavoidable' },
  { value: 'sampling', label: 'Sampling / QA', avoidableType: 'unavoidable' }
];

const APPROVAL_THRESHOLD = 100;

const CATEGORY_BADGES = Object.fromEntries(
  WASTE_CATEGORIES.map((item) => [item.value, `bg-white text-slate-700 border border-slate-200`])
);

const APPROVAL_TONES = {
  approved: 'bg-emerald-100 text-emerald-700',
  pending: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-700'
};

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatCurrency(value) {
  return `$${safeNumber(value).toFixed(2)}`;
}

function matchesDate(dateValue, startDate, endDate) {
  if (!dateValue) return false;
  return dateValue >= startDate && dateValue <= endDate;
}

function getReasonMeta(reasonCode) {
  return WASTE_REASONS.find((item) => item.value === reasonCode) || null;
}

function getCategoryMeta(categoryCode) {
  return WASTE_CATEGORIES.find((item) => item.value === categoryCode) || null;
}

function sumRecipeIngredientCost(recipe, ingredientMap) {
  const ingredients = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
  return ingredients.reduce((total, item) => {
    const ingredient = ingredientMap.get(item.ingredient_id);
    return total + (safeNumber(ingredient?.cost_per_unit) * safeNumber(item.quantity));
  }, 0);
}

export default function FoodWaste() {
  const queryClient = useQueryClient();
  const { isAdmin, isManager } = usePermissions();
  const [formOpen, setFormOpen] = useState(false);
  const [targetDialogOpen, setTargetDialogOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    wasteCategory: 'all',
    reasonCode: 'all',
    scope: 'all'
  });
  const [formData, setFormData] = useState({
    site_id: '',
    waste_date: format(new Date(), 'yyyy-MM-dd'),
    waste_category: 'plate_waste',
    reason_code: 'overproduction',
    waste_scope: 'ingredient',
    ingredient_id: 'none',
    recipe_id: 'none',
    production_id: 'none',
    batch_reference: '',
    quantity: '',
    unit: 'kg',
    preventable: true,
    notes: ''
  });
  const [targetForm, setTargetForm] = useState({
    site_id: '',
    target_percentage: '',
    target_cost: '',
    target_month: format(new Date(), 'yyyy-MM'),
    notes: ''
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: productions = [] } = useQuery({
    queryKey: ['productionsForWaste'],
    queryFn: () => base44.entities.Production.list('-production_date', 1000)
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 1000)
  });

  const { data: wasteTargets = [] } = useQuery({
    queryKey: ['wasteTargets'],
    queryFn: () => base44.entities.WasteTarget.list('-target_month', 500)
  });

  const ingredientMap = useMemo(() => new Map(ingredients.map((item) => [item.id, item])), [ingredients]);
  const recipeMap = useMemo(() => new Map(recipes.map((item) => [item.id, item])), [recipes]);
  const productionMap = useMemo(() => new Map(productions.map((item) => [item.id, item])), [productions]);
  const siteMap = useMemo(() => new Map(sites.map((item) => [item.id, item])), [sites]);

  const createWasteMutation = useMutation({
    mutationFn: (payload) => base44.entities.FoodWaste.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodWaste'] });
      setFormOpen(false);
      setMessage('Waste record saved.');
      setFormData({
        site_id: '',
        waste_date: format(new Date(), 'yyyy-MM-dd'),
        waste_category: 'plate_waste',
        reason_code: 'overproduction',
        waste_scope: 'ingredient',
        ingredient_id: 'none',
        recipe_id: 'none',
        production_id: 'none',
        batch_reference: '',
        quantity: '',
        unit: 'kg',
        preventable: true,
        notes: ''
      });
    },
    onError: (error) => setMessage(error.message || 'Failed to save waste record')
  });

  const approvalMutation = useMutation({
    mutationFn: ({ id, approval_status }) => base44.entities.FoodWaste.update(id, {
      approval_status,
      approved_by: approval_status === 'approved' ? 'manager' : null,
      approved_at: approval_status === 'approved' ? new Date().toISOString() : null
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodWaste'] });
      setMessage('Waste approval updated.');
    },
    onError: (error) => setMessage(error.message || 'Failed to update approval')
  });

  const targetMutation = useMutation({
    mutationFn: async (payload) => {
      const site = siteMap.get(payload.site_id);
      const record = wasteTargets.find((item) => item.site_id === payload.site_id && item.target_month === payload.target_month);
      const body = {
        site_id: payload.site_id,
        site_name: site?.name || '',
        target_percentage: safeNumber(payload.target_percentage),
        target_cost: safeNumber(payload.target_cost),
        target_month: payload.target_month,
        notes: payload.notes
      };
      if (record) {
        return base44.entities.WasteTarget.update(record.id, body);
      }
      return base44.entities.WasteTarget.create(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wasteTargets'] });
      setTargetDialogOpen(false);
      setMessage('Waste reduction target saved.');
    },
    onError: (error) => setMessage(error.message || 'Failed to save target')
  });

  const filteredWaste = useMemo(() => (
    foodWaste.filter((item) => {
      if (!matchesDate(item.waste_date, filters.startDate, filters.endDate)) return false;
      if (filters.locationId !== 'all' && item.site_id !== filters.locationId) return false;
      if (filters.wasteCategory !== 'all' && item.waste_category !== filters.wasteCategory) return false;
      if (filters.reasonCode !== 'all' && item.reason_code !== filters.reasonCode) return false;
      if (filters.scope !== 'all' && item.waste_scope !== filters.scope) return false;
      return true;
    })
  ), [foodWaste, filters]);

  const linkedProductionIds = new Set(
    filteredWaste.map((item) => item.production_id).filter(Boolean)
  );
  const filteredProductions = productions.filter((item) => {
    if (!matchesDate(item.production_date, filters.startDate, filters.endDate)) return false;
    if (filters.locationId !== 'all' && item.site_id !== filters.locationId) return false;
    return true;
  });
  const totalProductionOutput = filteredProductions.reduce((sum, item) => sum + safeNumber(item.actual_servings || item.target_servings), 0);

  const totalWasteQuantity = filteredWaste.reduce((sum, item) => sum + safeNumber(item.quantity), 0);
  const totalWasteCost = filteredWaste.reduce((sum, item) => sum + safeNumber(item.estimated_cost), 0);
  const avoidableCost = filteredWaste
    .filter((item) => item.avoidable_type === 'avoidable' || item.preventable)
    .reduce((sum, item) => sum + safeNumber(item.estimated_cost), 0);
  const unavoidableCost = filteredWaste
    .filter((item) => item.avoidable_type === 'unavoidable' && !item.preventable)
    .reduce((sum, item) => sum + safeNumber(item.estimated_cost), 0);
  const wastePercentVsProduction = totalProductionOutput > 0
    ? Number(((totalWasteQuantity / totalProductionOutput) * 100).toFixed(2))
    : 0;

  const wasteTrendByLocation = useMemo(() => {
    const grouped = new Map();
    filteredWaste.forEach((item) => {
      const key = `${item.waste_date}-${item.site_id || 'unknown'}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          waste_date: item.waste_date,
          site_name: item.site_name || 'Unknown',
          total_quantity: 0,
          total_cost: 0
        });
      }
      const row = grouped.get(key);
      row.total_quantity += safeNumber(item.quantity);
      row.total_cost += safeNumber(item.estimated_cost);
    });
    return [...grouped.values()].sort((left, right) => `${left.waste_date}-${left.site_name}`.localeCompare(`${right.waste_date}-${right.site_name}`));
  }, [filteredWaste]);

  const topWastedIngredients = useMemo(() => {
    const grouped = new Map();
    filteredWaste.forEach((item) => {
      const key = item.ingredient_name || item.recipe_name || item.batch_reference || 'Unknown';
      if (!grouped.has(key)) {
        grouped.set(key, {
          item_name: key,
          quantity: 0,
          estimated_cost: 0,
          waste_count: 0
        });
      }
      const row = grouped.get(key);
      row.quantity += safeNumber(item.quantity);
      row.estimated_cost += safeNumber(item.estimated_cost);
      row.waste_count += 1;
    });
    return [...grouped.values()]
      .map((item) => ({ ...item, estimated_cost: Number(item.estimated_cost.toFixed(2)), quantity: Number(item.quantity.toFixed(2)) }))
      .sort((left, right) => right.estimated_cost - left.estimated_cost)
      .slice(0, 8);
  }, [filteredWaste]);

  const wasteByReason = useMemo(() => {
    const grouped = new Map();
    filteredWaste.forEach((item) => {
      const key = item.reason_code || 'unspecified';
      if (!grouped.has(key)) {
        grouped.set(key, {
          reason_code: key,
          label: getReasonMeta(key)?.label || key.replace(/_/g, ' '),
          avoidable_type: item.avoidable_type || getReasonMeta(key)?.avoidableType || 'avoidable',
          quantity: 0,
          estimated_cost: 0
        });
      }
      const row = grouped.get(key);
      row.quantity += safeNumber(item.quantity);
      row.estimated_cost += safeNumber(item.estimated_cost);
    });
    return [...grouped.values()].sort((left, right) => right.estimated_cost - left.estimated_cost);
  }, [filteredWaste]);

  const wasteByLocation = useMemo(() => {
    const grouped = new Map();
    filteredWaste.forEach((item) => {
      const key = item.site_id || 'unknown';
      if (!grouped.has(key)) {
        grouped.set(key, {
          site_id: key,
          site_name: item.site_name || 'Unknown',
          total_quantity: 0,
          total_cost: 0,
          avoidable_cost: 0,
          unavoidable_cost: 0
        });
      }
      const row = grouped.get(key);
      row.total_quantity += safeNumber(item.quantity);
      row.total_cost += safeNumber(item.estimated_cost);
      if (item.avoidable_type === 'unavoidable' && !item.preventable) {
        row.unavoidable_cost += safeNumber(item.estimated_cost);
      } else {
        row.avoidable_cost += safeNumber(item.estimated_cost);
      }
    });
    return [...grouped.values()].map((row) => ({
      ...row,
      total_quantity: Number(row.total_quantity.toFixed(2)),
      total_cost: Number(row.total_cost.toFixed(2)),
      avoidable_cost: Number(row.avoidable_cost.toFixed(2)),
      unavoidable_cost: Number(row.unavoidable_cost.toFixed(2))
    })).sort((left, right) => right.total_cost - left.total_cost);
  }, [filteredWaste]);

  const dailyWasteReport = useMemo(() => {
    const grouped = new Map();
    filteredWaste.forEach((item) => {
      const key = item.waste_date;
      if (!grouped.has(key)) {
        grouped.set(key, {
          waste_date: item.waste_date,
          total_quantity: 0,
          total_cost: 0,
          records: 0
        });
      }
      const row = grouped.get(key);
      row.total_quantity += safeNumber(item.quantity);
      row.total_cost += safeNumber(item.estimated_cost);
      row.records += 1;
    });
    return [...grouped.values()].map((row) => ({
      ...row,
      total_quantity: Number(row.total_quantity.toFixed(2)),
      total_cost: Number(row.total_cost.toFixed(2))
    })).sort((left, right) => right.waste_date.localeCompare(left.waste_date));
  }, [filteredWaste]);

  const monthlyTargets = useMemo(() => (
    wasteTargets.filter((item) => {
      if (filters.locationId !== 'all' && item.site_id !== filters.locationId) return false;
      return true;
    })
  ), [wasteTargets, filters.locationId]);

  const avoidableVsUnavoidable = [
    { name: 'Avoidable', value: Number(avoidableCost.toFixed(2)), color: '#ef4444' },
    { name: 'Unavoidable', value: Number(unavoidableCost.toFixed(2)), color: '#22c55e' }
  ].filter((item) => item.value > 0);

  const pendingApprovalWaste = filteredWaste.filter((item) => item.approval_status === 'pending');

  const handleAutoCostPreview = () => {
    const quantity = safeNumber(formData.quantity);
    if (!quantity) return 0;

    if (formData.waste_scope === 'ingredient' && formData.ingredient_id !== 'none') {
      const ingredient = ingredientMap.get(formData.ingredient_id);
      return Number((safeNumber(ingredient?.cost_per_unit) * quantity).toFixed(2));
    }

    if (formData.waste_scope === 'recipe' && formData.recipe_id !== 'none') {
      const recipe = recipeMap.get(formData.recipe_id);
      const servings = Math.max(1, safeNumber(recipe?.servings, 1));
      const totalRecipeCost = sumRecipeIngredientCost(recipe, ingredientMap);
      return Number(((totalRecipeCost / servings) * quantity).toFixed(2));
    }

    if ((formData.waste_scope === 'batch' || formData.production_id !== 'none') && formData.production_id !== 'none') {
      const production = productionMap.get(formData.production_id);
      const recipe = recipeMap.get(production?.recipe_id);
      const servings = Math.max(1, safeNumber(production?.actual_servings || production?.target_servings || recipe?.servings, 1));
      const totalRecipeCost = sumRecipeIngredientCost(recipe, ingredientMap);
      return Number(((totalRecipeCost / servings) * quantity).toFixed(2));
    }

    return 0;
  };

  const handleWasteSubmit = (event) => {
    event.preventDefault();
    const site = siteMap.get(formData.site_id);
    const ingredient = formData.ingredient_id !== 'none' ? ingredientMap.get(formData.ingredient_id) : null;
    const recipe = formData.recipe_id !== 'none' ? recipeMap.get(formData.recipe_id) : null;
    const production = formData.production_id !== 'none' ? productionMap.get(formData.production_id) : null;
    const reason = getReasonMeta(formData.reason_code);
    const estimatedCost = handleAutoCostPreview();
    const approvalStatus = estimatedCost >= APPROVAL_THRESHOLD ? 'pending' : 'approved';

    createWasteMutation.mutate({
      site_id: formData.site_id,
      site_name: site?.name || '',
      waste_date: formData.waste_date,
      waste_category: formData.waste_category,
      reason_code: formData.reason_code,
      reason: reason?.label || formData.reason_code,
      avoidable_type: reason?.avoidableType || (formData.preventable ? 'avoidable' : 'unavoidable'),
      preventable: formData.preventable,
      waste_scope: formData.waste_scope,
      ingredient_id: ingredient?.id || null,
      ingredient_name: ingredient?.name || null,
      recipe_id: recipe?.id || production?.recipe_id || null,
      recipe_name: recipe?.name || production?.recipe_name || null,
      production_id: production?.id || null,
      production_name: production ? `${production.recipe_name} - ${production.production_date}` : null,
      batch_reference: formData.batch_reference || production?.id || null,
      quantity: safeNumber(formData.quantity),
      unit: formData.unit,
      estimated_cost: estimatedCost,
      approval_status: approvalStatus,
      status: approvalStatus === 'pending' ? 'pending_review' : 'logged',
      high_value: estimatedCost >= APPROVAL_THRESHOLD,
      notes: formData.notes
    });
  };

  const exportWastePackage = () => {
    const rows = filteredWaste.map((item) => ({
      waste_date: item.waste_date,
      site_name: item.site_name,
      waste_category: item.waste_category,
      reason: item.reason,
      avoidable_type: item.avoidable_type,
      ingredient_name: item.ingredient_name,
      recipe_name: item.recipe_name,
      batch_reference: item.batch_reference,
      quantity: item.quantity,
      unit: item.unit,
      estimated_cost: item.estimated_cost,
      approval_status: item.approval_status
    }));
    downloadCSV(rows, 'food_waste_analytics');
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1680px] mx-auto space-y-6">
        <PageHeader
          title="Food Waste Management"
          description="Track waste by ingredient, recipe, batch, and location with approval control, reduction targets, and operational waste reporting"
        >
          <Button variant="outline" onClick={exportWastePackage}>
            <Download className="w-4 h-4 mr-2" />
            Export Reports
          </Button>
          {isManager ? (
            <Button variant="outline" onClick={() => setTargetDialogOpen(true)}>
              <Target className="w-4 h-4 mr-2" />
              Waste Targets
            </Button>
          ) : null}
          {isManager ? (
            <Button onClick={() => setFormOpen(true)} className="bg-red-600 hover:bg-red-700">
              <Plus className="w-4 h-4 mr-2" />
              Record Waste
            </Button>
          ) : null}
        </PageHeader>

        {message ? (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            {message}
          </div>
        ) : null}

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
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
                <Label>Waste Category</Label>
                <Select value={filters.wasteCategory} onValueChange={(value) => setFilters((current) => ({ ...current, wasteCategory: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {WASTE_CATEGORIES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Waste Scope</Label>
                <Select value={filters.scope} onValueChange={(value) => setFilters((current) => ({ ...current, scope: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Scopes</SelectItem>
                    <SelectItem value="ingredient">Ingredient</SelectItem>
                    <SelectItem value="recipe">Recipe</SelectItem>
                    <SelectItem value="batch">Batch</SelectItem>
                    <SelectItem value="location">Location</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
          <StatCard title="Total Waste Quantity" value={`${totalWasteQuantity.toFixed(2)} kg`} icon={Trash2} iconBg="bg-red-50" iconColor="text-red-600" />
          <StatCard title="Waste Cost" value={formatCurrency(totalWasteCost)} icon={CircleDollarSign} iconBg="bg-amber-50" iconColor="text-amber-600" />
          <StatCard title="Avoidable Waste" value={formatCurrency(avoidableCost)} subtitle={`${filteredWaste.filter((item) => item.avoidable_type === 'avoidable' || item.preventable).length} records`} icon={AlertTriangle} iconBg="bg-orange-50" iconColor="text-orange-600" />
          <StatCard title="Waste vs Production" value={`${wastePercentVsProduction}%`} subtitle={`${totalProductionOutput.toFixed(0)} production output`} icon={TrendingDown} iconBg="bg-purple-50" iconColor="text-purple-600" />
          <StatCard title="Pending Approvals" value={pendingApprovalWaste.length} subtitle={`Threshold ${formatCurrency(APPROVAL_THRESHOLD)}`} icon={CheckCircle2} iconBg="bg-blue-50" iconColor="text-blue-600" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Waste Trend by Location</CardTitle>
            </CardHeader>
            <CardContent>
              {wasteTrendByLocation.length === 0 ? (
                <p className="py-16 text-center text-sm text-slate-500">No waste trend data in the selected range.</p>
              ) : (
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={wasteTrendByLocation}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="waste_date" stroke="#64748b" />
                      <YAxis stroke="#64748b" />
                      <Tooltip />
                      <Area type="monotone" dataKey="total_cost" stroke="#ef4444" fill="#fecaca" name="Waste Cost" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Avoidable vs Unavoidable Waste</CardTitle>
            </CardHeader>
            <CardContent>
              {avoidableVsUnavoidable.length === 0 ? (
                <p className="py-16 text-center text-sm text-slate-500">No avoidable split available yet.</p>
              ) : (
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={avoidableVsUnavoidable} dataKey="value" nameKey="name" innerRadius={70} outerRadius={105} paddingAngle={2}>
                        {avoidableVsUnavoidable.map((item) => (
                          <Cell key={item.name} fill={item.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatCurrency(value)} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="mt-4 space-y-2">
                    {avoidableVsUnavoidable.map((item) => (
                      <div key={item.name} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="text-sm text-slate-700">{item.name}</span>
                        </div>
                        <span className="text-sm font-medium text-slate-900">{formatCurrency(item.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Top Wasted Ingredients / Recipes</CardTitle>
            </CardHeader>
            <CardContent>
              {topWastedIngredients.length === 0 ? (
                <p className="py-16 text-center text-sm text-slate-500">No waste ranking data available.</p>
              ) : (
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topWastedIngredients} layout="vertical" margin={{ left: 20, right: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis type="number" stroke="#64748b" />
                      <YAxis dataKey="item_name" type="category" width={150} stroke="#64748b" />
                      <Tooltip formatter={(value, name) => name === 'estimated_cost' ? formatCurrency(value) : value} />
                      <Bar dataKey="estimated_cost" fill="#dc2626" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Waste Reduction Targets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {monthlyTargets.length === 0 ? (
                <p className="py-16 text-center text-sm text-slate-500">No waste reduction targets configured for this selection.</p>
              ) : monthlyTargets.slice(0, 8).map((target) => {
                const actualLocationCost = wasteByLocation.find((item) => item.site_id === target.site_id)?.total_cost || 0;
                const targetMet = actualLocationCost <= safeNumber(target.target_cost) || (wastePercentVsProduction <= safeNumber(target.target_percentage));
                return (
                  <div key={target.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">{target.site_name}</p>
                        <p className="text-xs text-slate-500">{target.target_month}</p>
                      </div>
                      <Badge className={targetMet ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                        {targetMet ? 'On target' : 'Needs action'}
                      </Badge>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg bg-white px-3 py-2">
                        <p className="text-xs text-slate-500">Target Cost</p>
                        <p className="font-semibold text-slate-900">{formatCurrency(target.target_cost)}</p>
                      </div>
                      <div className="rounded-lg bg-white px-3 py-2">
                        <p className="text-xs text-slate-500">Target %</p>
                        <p className="font-semibold text-slate-900">{safeNumber(target.target_percentage).toFixed(2)}%</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Waste by Reason</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reason</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wasteByReason.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-slate-500">No waste by reason data.</TableCell>
                    </TableRow>
                  ) : wasteByReason.map((item) => (
                    <TableRow key={item.reason_code}>
                      <TableCell className="font-medium">{item.label}</TableCell>
                      <TableCell>
                        <Badge className={item.avoidable_type === 'avoidable' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}>
                          {item.avoidable_type}
                        </Badge>
                      </TableCell>
                      <TableCell>{item.quantity.toFixed(2)} kg</TableCell>
                      <TableCell>{formatCurrency(item.estimated_cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Waste by Location</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Total Cost</TableHead>
                    <TableHead>Avoidable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wasteByLocation.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-slate-500">No waste by location data.</TableCell>
                    </TableRow>
                  ) : wasteByLocation.map((item) => (
                    <TableRow key={item.site_id}>
                      <TableCell className="font-medium">{item.site_name}</TableCell>
                      <TableCell>{item.total_quantity.toFixed(2)} kg</TableCell>
                      <TableCell>{formatCurrency(item.total_cost)}</TableCell>
                      <TableCell>{formatCurrency(item.avoidable_cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Daily Waste Report</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Waste Quantity</TableHead>
                    <TableHead>Waste Cost</TableHead>
                    <TableHead>Records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dailyWasteReport.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-slate-500">No daily waste records.</TableCell>
                    </TableRow>
                  ) : dailyWasteReport.map((item) => (
                    <TableRow key={item.waste_date}>
                      <TableCell className="font-medium">{item.waste_date}</TableCell>
                      <TableCell>{item.total_quantity.toFixed(2)} kg</TableCell>
                      <TableCell>{formatCurrency(item.total_cost)}</TableCell>
                      <TableCell>{item.records}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">High-Value Waste Approval</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingApprovalWaste.length === 0 ? (
                <p className="py-16 text-center text-sm text-slate-500">No high-value waste approvals pending.</p>
              ) : pendingApprovalWaste.map((item) => (
                <div key={item.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{item.ingredient_name || item.recipe_name || item.batch_reference || 'Waste Record'}</p>
                      <p className="text-xs text-slate-500">{item.site_name} • {item.waste_date} • {formatCurrency(item.estimated_cost)}</p>
                    </div>
                    <Badge className={APPROVAL_TONES.pending}>pending</Badge>
                  </div>
                  {isManager ? (
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => approvalMutation.mutate({ id: item.id, approval_status: 'approved' })}>
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => approvalMutation.mutate({ id: item.id, approval_status: 'rejected' })}>
                        <XCircle className="w-4 h-4 mr-2" />
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Waste Records</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Item / Batch</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Approval</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredWaste.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-10 text-center text-slate-500">No waste records found for the selected filters.</TableCell>
                  </TableRow>
                ) : filteredWaste.slice(0, 30).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.waste_date}</TableCell>
                    <TableCell>{item.site_name}</TableCell>
                    <TableCell>
                      <Badge className={CATEGORY_BADGES[item.waste_category] || 'bg-slate-100 text-slate-700'}>
                        {getCategoryMeta(item.waste_category)?.label || item.waste_category}
                      </Badge>
                    </TableCell>
                    <TableCell>{item.reason || getReasonMeta(item.reason_code)?.label || '-'}</TableCell>
                    <TableCell>{item.ingredient_name || item.recipe_name || item.batch_reference || '-'}</TableCell>
                    <TableCell>{safeNumber(item.quantity).toFixed(2)} {item.unit}</TableCell>
                    <TableCell>{formatCurrency(item.estimated_cost)}</TableCell>
                    <TableCell>
                      <Badge className={APPROVAL_TONES[item.approval_status] || 'bg-slate-100 text-slate-700'}>
                        {item.approval_status || 'approved'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Record Food Waste</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleWasteSubmit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Location</Label>
                  <Select value={formData.site_id} onValueChange={(value) => setFormData((current) => ({ ...current, site_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select location" /></SelectTrigger>
                    <SelectContent>
                      {sites.map((site) => (
                        <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Waste Date</Label>
                  <Input type="date" className="mt-1" value={formData.waste_date} onChange={(event) => setFormData((current) => ({ ...current, waste_date: event.target.value }))} />
                </div>
                <div>
                  <Label>Waste Category</Label>
                  <Select value={formData.waste_category} onValueChange={(value) => setFormData((current) => ({ ...current, waste_category: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {WASTE_CATEGORIES.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Reason Category</Label>
                  <Select
                    value={formData.reason_code}
                    onValueChange={(value) => {
                      const reason = getReasonMeta(value);
                      setFormData((current) => ({
                        ...current,
                        reason_code: value,
                        preventable: reason?.avoidableType !== 'unavoidable'
                      }));
                    }}
                  >
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {WASTE_REASONS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Waste Scope</Label>
                  <Select value={formData.waste_scope} onValueChange={(value) => setFormData((current) => ({ ...current, waste_scope: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ingredient">Ingredient</SelectItem>
                      <SelectItem value="recipe">Recipe</SelectItem>
                      <SelectItem value="batch">Batch</SelectItem>
                      <SelectItem value="location">Location</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Production Batch</Label>
                  <Select value={formData.production_id} onValueChange={(value) => setFormData((current) => ({ ...current, production_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No linked batch</SelectItem>
                      {productions
                        .filter((item) => !formData.site_id || item.site_id === formData.site_id)
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id}>{item.recipe_name} - {item.production_date} - {item.site_name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Ingredient</Label>
                  <Select value={formData.ingredient_id} onValueChange={(value) => setFormData((current) => ({ ...current, ingredient_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No ingredient</SelectItem>
                      {ingredients.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Recipe</Label>
                  <Select value={formData.recipe_id} onValueChange={(value) => setFormData((current) => ({ ...current, recipe_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No recipe</SelectItem>
                      {recipes.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Batch Reference</Label>
                  <Input className="mt-1" value={formData.batch_reference} onChange={(event) => setFormData((current) => ({ ...current, batch_reference: event.target.value }))} placeholder="Optional manual batch / lot ref" />
                </div>
                <div>
                  <Label>Quantity</Label>
                  <Input type="number" step="0.01" className="mt-1" value={formData.quantity} onChange={(event) => setFormData((current) => ({ ...current, quantity: event.target.value }))} />
                </div>
                <div>
                  <Label>Unit</Label>
                  <Select value={formData.unit} onValueChange={(value) => setFormData((current) => ({ ...current, unit: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="kg">kg</SelectItem>
                      <SelectItem value="g">g</SelectItem>
                      <SelectItem value="l">l</SelectItem>
                      <SelectItem value="pieces">pieces</SelectItem>
                      <SelectItem value="servings">servings</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <Switch checked={formData.preventable} onCheckedChange={(checked) => setFormData((current) => ({ ...current, preventable: checked }))} />
                <div>
                  <p className="text-sm font-medium text-slate-900">Mark as avoidable waste</p>
                  <p className="text-xs text-slate-500">This record will count toward avoidable waste reduction targets.</p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Automatic waste cost</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(handleAutoCostPreview())}</p>
                <p className="mt-1 text-xs text-slate-500">Calculated from ingredient unit cost, recipe cost per serving, or linked production batch cost.</p>
              </div>

              <div>
                <Label>Notes</Label>
                <Textarea rows={4} className="mt-1" value={formData.notes} onChange={(event) => setFormData((current) => ({ ...current, notes: event.target.value }))} placeholder="Corrective action, observed issue, or additional waste details" />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-red-600 hover:bg-red-700" disabled={createWasteMutation.isPending || !formData.site_id || !formData.quantity}>
                  {createWasteMutation.isPending ? 'Saving...' : 'Save Waste Record'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={targetDialogOpen} onOpenChange={setTargetDialogOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Waste Reduction Target</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Location</Label>
                <Select value={targetForm.site_id} onValueChange={(value) => setTargetForm((current) => ({ ...current, site_id: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Select location" /></SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Target Waste %</Label>
                  <Input type="number" step="0.01" className="mt-1" value={targetForm.target_percentage} onChange={(event) => setTargetForm((current) => ({ ...current, target_percentage: event.target.value }))} />
                </div>
                <div>
                  <Label>Target Waste Cost</Label>
                  <Input type="number" step="0.01" className="mt-1" value={targetForm.target_cost} onChange={(event) => setTargetForm((current) => ({ ...current, target_cost: event.target.value }))} />
                </div>
              </div>
              <div>
                <Label>Target Month</Label>
                <Input type="month" className="mt-1" value={targetForm.target_month} onChange={(event) => setTargetForm((current) => ({ ...current, target_month: event.target.value }))} />
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea rows={3} className="mt-1" value={targetForm.notes} onChange={(event) => setTargetForm((current) => ({ ...current, notes: event.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setTargetDialogOpen(false)}>Cancel</Button>
              <Button type="button" onClick={() => targetMutation.mutate(targetForm)} disabled={targetMutation.isPending || !targetForm.site_id}>
                {targetMutation.isPending ? 'Saving...' : 'Save Target'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
