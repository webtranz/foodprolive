import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import AsyncStatePanel from '@/components/ui/AsyncStatePanel';
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
import { downloadCSV, downloadExcel, downloadPDF } from '@/components/utils/exportData';
import { formatCurrency } from '@/lib/currency';
import { calculateIngredientCost } from '../../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';
import { getItemCodeFromRecords } from '../../shared/itemCode.js';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  Download,
  ImagePlus,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
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
const MEAL_TYPE_OPTIONS = ['breakfast', 'lunch', 'dinner'];
const BATCH_OVERPRODUCTION_CATEGORY = 'batch_overproduction';

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

function isMealServiceLeftover(item = {}) {
  return item.auto_generated === true && item.source_type === 'meal_service_leftover';
}

function isBatchOverproductionWasteRecord(item = {}) {
  return item.source_type === 'batch_overproduction'
    || item.waste_category === BATCH_OVERPRODUCTION_CATEGORY;
}

function getWasteSourceLabel(item = {}) {
  if (isMealServiceLeftover(item)) return 'Meal Service Leftover';
  return titleCase(item.source_type || 'manual_entry');
}

function formatWasteQuantity(item = {}) {
  if (isMealServiceLeftover(item)) {
    const exactWeightGrams = Number(item.wasted_weight_grams);
    if (Number.isFinite(exactWeightGrams) && exactWeightGrams >= 0) {
      if (exactWeightGrams >= 1000) return `${Number((exactWeightGrams / 1000).toFixed(3))} kg`;
      return `${Number(exactWeightGrams.toFixed(3))} g`;
    }
  }
  return `${safeNumber(item.quantity).toFixed(2)} ${item.unit}`;
}

function getWasteWeightGrams(item = {}) {
  const explicitWeight = [
    item.wasted_weight_grams,
    item.waste_weight_grams,
    item.quantity_grams,
    item.weight_grams
  ].find((value) => Number.isFinite(Number(value)));
  if (typeof explicitWeight !== 'undefined') return Math.max(0, safeNumber(explicitWeight));
  const quantity = safeNumber(item.quantity);
  const unit = String(item.unit || '').trim().toLowerCase();
  if (unit === 'kg') return quantity * 1000;
  if (['g', 'gram', 'grams'].includes(unit)) return quantity;
  return 0;
}

function getWasteQuantityKg(item = {}) {
  return getWasteWeightGrams(item) / 1000;
}

function firstPositiveSafeNumber(values = []) {
  for (const value of values) {
    const numeric = safeNumber(value);
    if (numeric > 0) return numeric;
  }
  return 0;
}

function getProductionOutputCost(record = {}) {
  return firstPositiveSafeNumber([
    record.total_cost,
    record.estimated_total_cost,
    record.yield_total_cost,
    record.planned_total_cost,
    record.estimated_cost,
    record.production_cost
  ]);
}

function getProductionOutputWeightGrams(record = {}) {
  return firstPositiveSafeNumber([
    record.produced_weight_grams,
    record.actual_finished_weight_grams,
    record.expected_finished_weight_grams,
    record.finished_weight_grams,
    record.yielded_weight_grams
  ]);
}

function getWasteCost(item = {}, productionMap = new Map()) {
  const explicitCost = firstPositiveSafeNumber([
    item.estimated_cost,
    item.waste_cost,
    item.total_cost,
    item.meal_service_adjustment_cost
  ]);
  if (explicitCost > 0) return explicitCost;

  const weightGrams = getWasteWeightGrams(item);
  if (weightGrams <= 0) return 0;

  const linkedProduction = item.production_id ? productionMap.get(item.production_id) : null;
  const productionCost = getProductionOutputCost(linkedProduction || {});
  const productionWeightGrams = firstPositiveSafeNumber([
    item.produced_weight_grams,
    getProductionOutputWeightGrams(linkedProduction || {})
  ]);
  if (productionCost > 0 && productionWeightGrams > 0) {
    return Number(((weightGrams / productionWeightGrams) * productionCost).toFixed(4));
  }

  const costPerGram = firstPositiveSafeNumber([
    item.estimated_cost_per_gram,
    item.cost_per_gram
  ]);
  return Number((weightGrams * costPerGram).toFixed(4));
}

function formatWeightGrams(value) {
  const grams = safeNumber(value);
  if (grams >= 1000) return `${Number((grams / 1000).toFixed(3))} kg`;
  return `${Number(grams.toFixed(3))} g`;
}

function normalizeGramEntry(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^\d+(\.\d{0,3})?$/.test(text)) return null;
  return text;
}

function sumRecipeIngredientCost(recipe, recipeMap, ingredientMap) {
  const expandedIngredients = expandRecipeIngredients(
    recipe,
    [...recipeMap.values()],
    [...ingredientMap.values()],
    { aggregate: true }
  ).ingredients;
  return expandedIngredients.reduce((total, item) => {
    const ingredient = ingredientMap.get(item.ingredient_id);
    return total + calculateIngredientCost(item.quantity, item.unit, ingredient);
  }, 0);
}

function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function createDefaultWasteForm() {
  return {
    site_id: '',
    waste_date: format(new Date(), 'yyyy-MM-dd'),
    meal_type: 'breakfast',
    waste_category: 'plate_waste',
    reason_code: 'overproduction',
    waste_scope: 'recipe',
    ingredient_id: 'none',
    recipe_id: 'none',
    production_id: 'none',
    batch_reference: '',
    quantity: '',
    unit: 'kg',
    preventable: true,
    evidence_image_url: '',
    notes: ''
  };
}

export default function FoodWaste() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const wasteImageInputRef = useRef(null);
  const [formOpen, setFormOpen] = useState(false);
  const [targetDialogOpen, setTargetDialogOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    wasteCategory: 'all',
    reasonCode: 'all',
    scope: 'all',
    mealType: 'all'
  });
  const [editingWasteId, setEditingWasteId] = useState(null);
  const [formData, setFormData] = useState(createDefaultWasteForm);
  const [dishWasteGramsByRecipe, setDishWasteGramsByRecipe] = useState({});
  const [wasteImageFile, setWasteImageFile] = useState(null);
  const [wasteImagePreview, setWasteImagePreview] = useState('');
  const [wasteImageUploading, setWasteImageUploading] = useState(false);
  const [targetForm, setTargetForm] = useState({
    site_id: '',
    target_percentage: '',
    target_cost: '',
    target_month: format(new Date(), 'yyyy-MM'),
    notes: ''
  });

  const {
    data: sites = [],
    isLoading: sitesLoading,
    error: sitesError
  } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const {
    data: ingredients = [],
    isLoading: ingredientsLoading,
    error: ingredientsError
  } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const {
    data: recipes = [],
    isLoading: recipesLoading,
    error: recipesError
  } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const {
    data: productions = [],
    isLoading: productionsLoading,
    error: productionsError
  } = useQuery({
    queryKey: ['productionsForWaste'],
    queryFn: () => base44.entities.Production.list('-production_date', 1000)
  });

  const {
    data: foodWaste = [],
    isLoading: foodWasteLoading,
    error: foodWasteError
  } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.foodWaste.list()
  });

  const {
    data: wasteContext = null,
    isLoading: wasteContextLoading,
    error: wasteContextError
  } = useQuery({
    queryKey: ['foodWasteContext', formData.site_id, formData.waste_date, formData.meal_type],
    enabled: Boolean(formData.site_id && formData.waste_date && formData.meal_type),
    queryFn: () => base44.foodWaste.getContext(formData.site_id, formData.waste_date, formData.meal_type)
  });

  const {
    data: wasteTargets = [],
    isLoading: wasteTargetsLoading,
    error: wasteTargetsError
  } = useQuery({
    queryKey: ['wasteTargets'],
    queryFn: () => base44.entities.WasteTarget.list('-target_month', 500)
  });

  const ingredientMap = useMemo(() => new Map(ingredients.map((item) => [item.id, item])), [ingredients]);
  const recipeMap = useMemo(() => new Map(recipes.map((item) => [item.id, item])), [recipes]);
  const productionMap = useMemo(() => new Map(productions.map((item) => [item.id, item])), [productions]);
  const siteMap = useMemo(() => new Map(sites.map((item) => [item.id, item])), [sites]);
  const isBatchOverproduction = formData.waste_category === BATCH_OVERPRODUCTION_CATEGORY;
  const batchOverproductionDishes = useMemo(() => (
    wasteContext?.batch_overproduction_dishes
    || wasteContext?.produced_dishes
    || []
  ), [wasteContext]);
  const batchWasteRows = useMemo(() => (
    batchOverproductionDishes.map((dish) => ({
      ...dish,
      waste_grams: safeNumber(dishWasteGramsByRecipe[dish.recipe_id])
    }))
  ), [batchOverproductionDishes, dishWasteGramsByRecipe]);
  const batchWasteTotalGrams = batchWasteRows.reduce((sum, row) => sum + row.waste_grams, 0);
  const bootstrapLoading = sitesLoading || ingredientsLoading || recipesLoading || productionsLoading || foodWasteLoading || wasteTargetsLoading;
  const bootstrapError = sitesError || ingredientsError || recipesError || productionsError || foodWasteError || wasteTargetsError;

  useEffect(() => {
    if (formData.production_id === 'none') {
      return;
    }

    const production = productionMap.get(formData.production_id);
    if (!production) {
      return;
    }

    setFormData((current) => ({
      ...current,
      site_id: production.site_id || current.site_id,
      waste_date: production.production_date || current.waste_date,
      meal_type: String(production.meal_type || current.meal_type || 'breakfast').toLowerCase(),
      recipe_id: production.recipe_id || current.recipe_id,
      batch_reference: current.batch_reference || production.id || ''
    }));
  }, [formData.production_id, productionMap]);

  useEffect(() => {
    if (!isBatchOverproduction) {
      return;
    }
    setDishWasteGramsByRecipe((current) => {
      const next = Object.fromEntries(
        batchOverproductionDishes.map((dish) => [
          dish.recipe_id,
          Object.prototype.hasOwnProperty.call(current, dish.recipe_id) ? current[dish.recipe_id] : ''
        ])
      );
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [batchOverproductionDishes, isBatchOverproduction]);

  useEffect(() => {
    if (!isBatchOverproduction) {
      return;
    }
    const nextQuantity = batchWasteTotalGrams > 0 ? String(Number(batchWasteTotalGrams.toFixed(3))) : '';
    setFormData((current) => {
      if (
        current.waste_scope === 'batch'
        && current.unit === 'g'
        && current.ingredient_id === 'none'
        && current.recipe_id === 'none'
        && current.quantity === nextQuantity
      ) {
        return current;
      }
      return {
        ...current,
        waste_scope: 'batch',
        ingredient_id: 'none',
        recipe_id: 'none',
        unit: 'g',
        quantity: nextQuantity
      };
    });
  }, [batchWasteTotalGrams, isBatchOverproduction]);

  const createWasteMutation = useMutation({
    mutationFn: async (payload) => {
      if (!Array.isArray(payload)) {
        return base44.foodWaste.create(payload);
      }
      const results = [];
      for (const entry of payload) {
        results.push(await base44.foodWaste.create(entry));
      }
      return results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodWaste'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['foodWasteContext'] });
      queryClient.invalidateQueries({ queryKey: ['mealServiceAvailability'] });
      queryClient.invalidateQueries({ queryKey: ['mealServiceHistory'] });
      setFormOpen(false);
      setEditingWasteId(null);
      setMessage('Waste record saved.');
      setFormData(createDefaultWasteForm());
      setDishWasteGramsByRecipe({});
      setWasteImageFile(null);
      setWasteImagePreview('');
    },
    onError: (error) => setMessage(error.message || 'Failed to save waste record')
  });

  const updateWasteMutation = useMutation({
    mutationFn: ({ id, payload }) => base44.foodWaste.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodWaste'] });
      setFormOpen(false);
      setEditingWasteId(null);
      setMessage('Waste record updated.');
      setFormData(createDefaultWasteForm());
      setDishWasteGramsByRecipe({});
      setWasteImageFile(null);
      setWasteImagePreview('');
    },
    onError: (error) => setMessage(error.message || 'Failed to update waste record')
  });

  const approvalMutation = useMutation({
    mutationFn: ({ id, approval_status }) => base44.foodWaste.update(id, {
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
      if (filters.mealType !== 'all' && String(item.meal_type || '').toLowerCase() !== filters.mealType) return false;
      return true;
    })
  ), [foodWaste, filters]);
  const analyticsWaste = useMemo(
    () => filteredWaste.filter((item) => String(item.status || '').toLowerCase() !== 'reversed'),
    [filteredWaste]
  );

  const filteredProductions = productions.filter((item) => {
    if (!matchesDate(item.production_date, filters.startDate, filters.endDate)) return false;
    if (filters.locationId !== 'all' && item.site_id !== filters.locationId) return false;
    return true;
  });
  const totalProductionOutput = filteredProductions.reduce((sum, item) => sum + safeNumber(item.actual_servings || item.target_servings), 0);

  const totalWasteQuantity = analyticsWaste.reduce((sum, item) => sum + getWasteQuantityKg(item), 0);
  const totalWasteCost = analyticsWaste.reduce((sum, item) => sum + getWasteCost(item, productionMap), 0);
  const avoidableCost = analyticsWaste
    .filter((item) => item.avoidable_type === 'avoidable' || item.preventable)
    .reduce((sum, item) => sum + getWasteCost(item, productionMap), 0);
  const unavoidableCost = analyticsWaste
    .filter((item) => item.avoidable_type === 'unavoidable' && !item.preventable)
    .reduce((sum, item) => sum + getWasteCost(item, productionMap), 0);
  const wastePercentVsProduction = totalProductionOutput > 0
    ? Number(((totalWasteQuantity / totalProductionOutput) * 100).toFixed(2))
    : 0;

  const wasteTrendByLocation = useMemo(() => {
    const grouped = new Map();
    analyticsWaste.forEach((item) => {
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
      row.total_quantity += getWasteQuantityKg(item);
      row.total_cost += getWasteCost(item, productionMap);
    });
    return [...grouped.values()].sort((left, right) => `${left.waste_date}-${left.site_name}`.localeCompare(`${right.waste_date}-${right.site_name}`));
  }, [analyticsWaste, productionMap]);

  const topWastedIngredients = useMemo(() => {
    const grouped = new Map();
    analyticsWaste.forEach((item) => {
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
      row.quantity += getWasteQuantityKg(item);
      row.estimated_cost += getWasteCost(item, productionMap);
      row.waste_count += 1;
    });
    return [...grouped.values()]
      .map((item) => ({ ...item, estimated_cost: Number(item.estimated_cost.toFixed(2)), quantity: Number(item.quantity.toFixed(2)) }))
      .sort((left, right) => right.estimated_cost - left.estimated_cost)
      .slice(0, 8);
  }, [analyticsWaste, productionMap]);

  const wasteByReason = useMemo(() => {
    const grouped = new Map();
    analyticsWaste.forEach((item) => {
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
      row.quantity += getWasteQuantityKg(item);
      row.estimated_cost += getWasteCost(item, productionMap);
    });
    return [...grouped.values()].sort((left, right) => right.estimated_cost - left.estimated_cost);
  }, [analyticsWaste, productionMap]);

  const wasteByLocation = useMemo(() => {
    const grouped = new Map();
    analyticsWaste.forEach((item) => {
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
      row.total_quantity += getWasteQuantityKg(item);
      row.total_cost += getWasteCost(item, productionMap);
      if (item.avoidable_type === 'unavoidable' && !item.preventable) {
        row.unavoidable_cost += getWasteCost(item, productionMap);
      } else {
        row.avoidable_cost += getWasteCost(item, productionMap);
      }
    });
    return [...grouped.values()].map((row) => ({
      ...row,
      total_quantity: Number(row.total_quantity.toFixed(2)),
      total_cost: Number(row.total_cost.toFixed(2)),
      avoidable_cost: Number(row.avoidable_cost.toFixed(2)),
      unavoidable_cost: Number(row.unavoidable_cost.toFixed(2))
    })).sort((left, right) => right.total_cost - left.total_cost);
  }, [analyticsWaste, productionMap]);

  const dailyWasteReport = useMemo(() => {
    const grouped = new Map();
    analyticsWaste.forEach((item) => {
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
      row.total_quantity += getWasteQuantityKg(item);
      row.total_cost += getWasteCost(item, productionMap);
      row.records += 1;
    });
    return [...grouped.values()].map((row) => ({
      ...row,
      total_quantity: Number(row.total_quantity.toFixed(2)),
      total_cost: Number(row.total_cost.toFixed(2))
    })).sort((left, right) => right.waste_date.localeCompare(left.waste_date));
  }, [analyticsWaste, productionMap]);

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

  const pendingApprovalWaste = analyticsWaste.filter((item) => item.approval_status === 'pending');

  const wasteReductionInsights = useMemo(() => {
    const productionRecipeStats = new Map();
    filteredProductions.forEach((production) => {
      const key = `${production.site_id || 'unknown'}::${production.recipe_id || 'unknown'}::${production.meal_type || 'unspecified'}`;
      if (!productionRecipeStats.has(key)) {
        productionRecipeStats.set(key, {
          key,
          site_id: production.site_id,
          site_name: production.site_name || 'Unknown',
          recipe_id: production.recipe_id,
          recipe_name: production.recipe_name || 'Unknown recipe',
          meal_type: production.meal_type || 'unspecified',
          produced_servings: 0,
          production_batches: 0,
          production_cost: 0,
          waste_servings: 0,
          waste_cost: 0,
          avoidable_cost: 0,
          shortage_count: 0
        });
      }
      const row = productionRecipeStats.get(key);
      const servings = safeNumber(production.actual_servings || production.target_servings);
      row.produced_servings += servings;
      row.production_batches += 1;
      row.production_cost += safeNumber(production.total_cost || production.estimated_total_cost);
    });

    analyticsWaste.forEach((entry) => {
      const linkedProduction = entry.production_id ? productionMap.get(entry.production_id) : null;
      const recipeId = entry.recipe_id || linkedProduction?.recipe_id;
      const recipeName = entry.recipe_name || linkedProduction?.recipe_name || recipeMap.get(recipeId)?.name || 'Unknown recipe';
      const siteId = entry.site_id || linkedProduction?.site_id || 'unknown';
      const siteName = entry.site_name || linkedProduction?.site_name || siteMap.get(siteId)?.name || 'Unknown';
      const mealType = linkedProduction?.meal_type || entry.meal_type || 'unspecified';
      const key = `${siteId}::${recipeId || 'unknown'}::${mealType}`;
      if (!productionRecipeStats.has(key)) {
        productionRecipeStats.set(key, {
          key,
          site_id: siteId,
          site_name: siteName,
          recipe_id: recipeId,
          recipe_name: recipeName,
          meal_type: mealType,
          produced_servings: 0,
          production_batches: 0,
          production_cost: 0,
          waste_servings: 0,
          waste_cost: 0,
          avoidable_cost: 0,
          shortage_count: 0
        });
      }
      const row = productionRecipeStats.get(key);
      const wasteCost = getWasteCost(entry, productionMap);
      row.waste_servings += getWasteQuantityKg(entry);
      row.waste_cost += wasteCost;
      if (entry.avoidable_type === 'avoidable' || entry.preventable) {
        row.avoidable_cost += wasteCost;
      }
      if (['poor_forecast', 'overproduction'].includes(entry.reason_code)) {
        row.shortage_count += 1;
      }
    });

    const recipeActions = [...productionRecipeStats.values()]
      .map((item) => {
        const wasteRate = item.produced_servings > 0 ? (item.waste_servings / item.produced_servings) * 100 : 0;
        const costPerServing = item.produced_servings > 0 ? item.production_cost / item.produced_servings : 0;
        let action = 'Monitor';
        let suggestedChange = 0;
        let rationale = 'Waste and production are within the expected range.';
        if (wasteRate >= 12 || item.avoidable_cost >= 75) {
          action = 'Reduce production';
          suggestedChange = -Math.min(25, Math.max(10, Math.round(wasteRate)));
          rationale = `Avoidable waste is ${wasteRate.toFixed(1)}% of produced servings with ${formatCurrency(item.avoidable_cost)} avoidable cost.`;
        } else if (item.produced_servings >= 50 && wasteRate <= 2 && item.waste_cost <= 15) {
          action = 'Increase production';
          suggestedChange = 5;
          rationale = `This recipe is moving cleanly with only ${wasteRate.toFixed(1)}% waste and ${formatCurrency(item.waste_cost)} waste cost.`;
        }
        return {
          ...item,
          waste_rate: Number(wasteRate.toFixed(2)),
          cost_per_serving: Number(costPerServing.toFixed(2)),
          suggested_change_percent: suggestedChange,
          action,
          rationale
        };
      })
      .filter((item) => item.production_batches > 0 || item.waste_cost > 0)
      .sort((left, right) => {
        const weight = { 'Reduce production': 3, Monitor: 2, 'Increase production': 1 };
        return (weight[right.action] - weight[left.action]) || (right.waste_cost - left.waste_cost);
      });

    const ingredientActions = topWastedIngredients.slice(0, 8).map((item) => {
      const averageCostPerRecord = item.waste_count > 0 ? item.estimated_cost / item.waste_count : 0;
      const action = averageCostPerRecord > 20 || item.estimated_cost > 100 ? 'Reduce purchasing / MR' : 'Monitor usage';
      return {
        item_name: item.item_name,
        waste_count: item.waste_count,
        quantity: item.quantity,
        estimated_cost: item.estimated_cost,
        action,
        recommendation: action === 'Reduce purchasing / MR'
          ? `Trim material requests and replenish in smaller batches for ${item.item_name}.`
          : `Keep ${item.item_name} under watch and confirm issue/portion discipline.`
      };
    });

    const materialRequestActions = ingredientActions
      .filter((item) => item.action === 'Reduce purchasing / MR')
      .map((item) => ({
        item_name: item.item_name,
        recommendation: `Lower MR quantity or increase transfer use for ${item.item_name} until waste stabilizes.`,
        waste_cost: item.estimated_cost
      }));

    const mealTypeCostRows = Object.values(filteredProductions.reduce((accumulator, production) => {
      const key = production.meal_type || 'unspecified';
      if (!accumulator[key]) {
        accumulator[key] = {
          meal_type: key,
          servings: 0,
          production_cost: 0,
          waste_cost: 0
        };
      }
      accumulator[key].servings += safeNumber(production.actual_servings || production.target_servings);
      accumulator[key].production_cost += safeNumber(production.total_cost || production.estimated_total_cost);
      return accumulator;
    }, {})).map((entry) => {
      const relatedWasteCost = analyticsWaste.reduce((sum, wasteRow) => {
        const linkedProduction = wasteRow.production_id ? productionMap.get(wasteRow.production_id) : null;
        return (linkedProduction?.meal_type || wasteRow.meal_type) === entry.meal_type
          ? sum + getWasteCost(wasteRow, productionMap)
          : sum;
      }, 0);
      return {
        ...entry,
        waste_cost: Number(relatedWasteCost.toFixed(2)),
        cost_per_serving: Number((entry.servings > 0 ? entry.production_cost / entry.servings : 0).toFixed(2))
      };
    }).sort((left, right) => right.waste_cost - left.waste_cost);

    return {
      recipeActions,
      ingredientActions,
      materialRequestActions,
      mealTypeCostRows
    };
  }, [filteredProductions, analyticsWaste, productionMap, recipeMap, siteMap, topWastedIngredients]);

  const handleAutoCostPreview = () => {
    if (isBatchOverproduction) {
      return Number(batchWasteRows.reduce((sum, row) => (
        sum + (row.waste_grams * safeNumber(row.estimated_cost_per_gram))
      ), 0).toFixed(2));
    }

    const quantity = safeNumber(formData.quantity);
    if (!quantity) return 0;

    if (formData.waste_scope === 'ingredient' && formData.ingredient_id !== 'none') {
      const ingredient = ingredientMap.get(formData.ingredient_id);
      return Number(calculateIngredientCost(quantity, formData.unit, ingredient).toFixed(2));
    }

    if (formData.waste_scope === 'recipe' && formData.recipe_id !== 'none') {
      const recipe = recipeMap.get(formData.recipe_id);
      const servings = Math.max(1, safeNumber(recipe?.servings, 1));
      const totalRecipeCost = sumRecipeIngredientCost(recipe, recipeMap, ingredientMap);
      return Number(((totalRecipeCost / servings) * quantity).toFixed(2));
    }

    if ((formData.waste_scope === 'batch' || formData.production_id !== 'none') && formData.production_id !== 'none') {
      const production = productionMap.get(formData.production_id);
      const recipe = recipeMap.get(production?.recipe_id);
      const servings = Math.max(1, safeNumber(production?.actual_servings || production?.target_servings || recipe?.servings, 1));
      const totalRecipeCost = sumRecipeIngredientCost(recipe, recipeMap, ingredientMap);
      return Number(((totalRecipeCost / servings) * quantity).toFixed(2));
    }

    return 0;
  };

  const handleWasteCategoryChange = (value) => {
    if (value === BATCH_OVERPRODUCTION_CATEGORY) {
      setFormData((current) => ({
        ...current,
        waste_category: value,
        reason_code: 'overproduction',
        preventable: true,
        waste_scope: 'batch',
        ingredient_id: 'none',
        recipe_id: 'none',
        production_id: 'none',
        unit: 'g'
      }));
      return;
    }

    setDishWasteGramsByRecipe({});
    setFormData((current) => ({
      ...current,
      waste_category: value,
      quantity: current.waste_category === BATCH_OVERPRODUCTION_CATEGORY ? '' : current.quantity,
      waste_scope: current.production_id !== 'none' ? 'batch' : 'recipe',
      unit: current.unit === 'g' && current.waste_category === BATCH_OVERPRODUCTION_CATEGORY ? 'kg' : current.unit
    }));
  };

  const handleDishWasteGramsChange = (recipeId, value) => {
    const normalizedValue = normalizeGramEntry(value);
    if (normalizedValue === null) return;
    setDishWasteGramsByRecipe((current) => ({
      ...current,
      [recipeId]: normalizedValue
    }));
  };

  const handleWasteSubmit = (event) => {
    event.preventDefault();
    const site = siteMap.get(formData.site_id);
    const ingredient = formData.ingredient_id !== 'none' ? ingredientMap.get(formData.ingredient_id) : null;
    const recipe = formData.recipe_id !== 'none' ? recipeMap.get(formData.recipe_id) : null;
    const production = formData.production_id !== 'none' ? productionMap.get(formData.production_id) : null;
    const reason = getReasonMeta(formData.reason_code);
    const selectedBatchWasteRows = batchWasteRows.filter((row) => row.waste_grams > 0);
    if (!formData.site_id) {
      setMessage('Select the location for this waste record.');
      return;
    }
    if (isBatchOverproduction) {
      if (editingWasteId) {
        setMessage('Batch Overproduction waste should be corrected by recording a new dish-wise entry.');
        return;
      }
      if (!formData.waste_date || !formData.meal_type) {
        setMessage('Select the waste date and meal type before recording batch overproduction waste.');
        return;
      }
      if (wasteContextLoading) {
        setMessage('Production summary is still loading. Wait a moment and try again.');
        return;
      }
      if (!batchOverproductionDishes.length) {
        setMessage('No completed production output was found for this date, location, and meal type.');
        return;
      }
      if (!selectedBatchWasteRows.length) {
        setMessage('Enter recorded food waste in grams for at least one produced dish.');
        return;
      }
      const excessiveRow = selectedBatchWasteRows.find((row) => row.waste_grams > safeNumber(row.available_weight_grams));
      if (excessiveRow) {
        setMessage(`${excessiveRow.recipe_name} has only ${formatWeightGrams(excessiveRow.available_weight_grams)} available to record as waste.`);
        return;
      }
    }
    if (!wasteImageFile && !formData.evidence_image_url) {
      setMessage('Add a waste picture before saving this record.');
      return;
    }

    const saveWasteRecord = async () => {
      let evidenceImageUrl = String(formData.evidence_image_url || '').trim();
      if (wasteImageFile) {
        setWasteImageUploading(true);
        const uploadResult = await base44.integrations.Core.UploadWasteImage({ file: wasteImageFile });
        evidenceImageUrl = uploadResult.public_file_url || uploadResult.file_url || '';
        setWasteImageUploading(false);
      }

      const buildPayload = ({ row = null, estimatedCost = handleAutoCostPreview() } = {}) => {
        const approvalStatus = estimatedCost >= APPROVAL_THRESHOLD ? 'pending' : 'approved';
        const rowBatches = row?.batches || [];
        const rowProductionId = rowBatches[0]?.production_id || null;
        const rowBatchReference = rowBatches.map((batch) => batch.batch_number).filter(Boolean).join(', ');
        return {
          site_id: formData.site_id,
          site_name: site?.name || '',
          waste_date: formData.waste_date,
          meal_type: formData.meal_type,
          waste_category: formData.waste_category,
          reason_code: formData.reason_code,
          reason: reason?.label || formData.reason_code,
          avoidable_type: reason?.avoidableType || (formData.preventable ? 'avoidable' : 'unavoidable'),
          preventable: formData.preventable,
          waste_scope: row ? 'batch' : (production?.id ? 'batch' : 'recipe'),
          ingredient_id: row ? null : ingredient?.id || null,
          ingredient_name: row ? null : ingredient?.name || null,
          recipe_id: row?.recipe_id || recipe?.id || production?.recipe_id || null,
          recipe_name: row?.recipe_name || recipe?.name || production?.recipe_name || null,
          production_id: rowProductionId || production?.id || null,
          production_name: row
            ? row.recipe_name
            : production ? `${production.recipe_name} - ${production.production_date}` : null,
          batch_reference: row
            ? (formData.batch_reference || rowBatchReference || null)
            : formData.batch_reference || production?.id || null,
          quantity: row ? row.waste_grams : safeNumber(formData.quantity),
          unit: row ? 'g' : formData.unit,
          wasted_weight_grams: row ? row.waste_grams : null,
          produced_weight_grams: row ? safeNumber(row.produced_weight_grams) : null,
          available_weight_grams_before: row ? safeNumber(row.available_weight_grams) : null,
          estimated_cost: estimatedCost,
          approval_status: approvalStatus,
          status: approvalStatus === 'pending' ? 'pending_review' : 'logged',
          high_value: estimatedCost >= APPROVAL_THRESHOLD,
          evidence_image_url: evidenceImageUrl,
          image_url: evidenceImageUrl,
          notes: formData.notes
        };
      };

      if (isBatchOverproduction) {
        createWasteMutation.mutate(selectedBatchWasteRows.map((row) => (
          buildPayload({
            row,
            estimatedCost: Number((row.waste_grams * safeNumber(row.estimated_cost_per_gram)).toFixed(2))
          })
        )));
        return;
      }

      const payload = buildPayload();

      if (editingWasteId) {
        updateWasteMutation.mutate({ id: editingWasteId, payload });
        return;
      }

      createWasteMutation.mutate(payload);
    };

    saveWasteRecord().catch((error) => {
      setWasteImageUploading(false);
      setMessage(error.message || 'Failed to upload waste picture');
    });
  };

  const handleOpenCreateDialog = () => {
    setEditingWasteId(null);
    setFormData(createDefaultWasteForm());
    setDishWasteGramsByRecipe({});
    setWasteImageFile(null);
    setWasteImagePreview('');
    setFormOpen(true);
  };

  const handleOpenEditDialog = (record) => {
    if (isMealServiceLeftover(record)) {
      setMessage('Meal Service Leftover records are system managed. Correct them by reversing the related Meal Service request.');
      return;
    }
    if (isBatchOverproductionWasteRecord(record)) {
      setMessage('Batch Overproduction waste is dish-wise. Correct it by recording a new dish entry.');
      return;
    }
    setEditingWasteId(record.id);
    setFormData({
      site_id: record.site_id || '',
      waste_date: record.waste_date || format(new Date(), 'yyyy-MM-dd'),
      meal_type: String(record.meal_type || 'breakfast').toLowerCase(),
      waste_category: record.waste_category || 'plate_waste',
      reason_code: record.reason_code || 'overproduction',
      waste_scope: ['recipe', 'batch'].includes(record.waste_scope) ? record.waste_scope : 'recipe',
      ingredient_id: record.ingredient_id || 'none',
      recipe_id: record.recipe_id || 'none',
      production_id: record.production_id || 'none',
      batch_reference: record.batch_reference || '',
      quantity: String(record.quantity ?? ''),
      unit: record.unit || 'kg',
      preventable: record.avoidable_type !== 'unavoidable' || Boolean(record.preventable),
      evidence_image_url: record.evidence_image_url || record.image_url || '',
      notes: record.notes || ''
    });
    setWasteImageFile(null);
    setWasteImagePreview(record.evidence_image_url || record.image_url || '');
    setFormOpen(true);
  };

  const handleWasteImageChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type?.startsWith('image/')) {
      setMessage('Waste evidence must be an image file.');
      return;
    }
    setWasteImageFile(file);
    setWasteImagePreview(URL.createObjectURL(file));
  };

  const exportWastePackage = (type = 'csv') => {
    const wasteRows = analyticsWaste.map((item) => ({
      item_code: getItemCodeFromRecords([
        ingredientMap.get(item.ingredient_id),
        item,
        { item_code: recipeMap.get(item.recipe_id || productionMap.get(item.production_id)?.recipe_id)?.recipe_code }
      ]),
      item_name: item.ingredient_name || item.recipe_name || item.batch_reference || 'Waste Record',
      waste_date: item.waste_date,
      meal_type: titleCase(item.meal_type),
      site_name: item.site_name,
      waste_category: item.waste_category,
      reason: item.reason,
      source: getWasteSourceLabel(item),
      avoidable_type: item.avoidable_type,
      recipe_name: item.recipe_name,
      batch_reference: item.batch_reference,
      quantity: item.quantity,
      unit: item.unit,
      estimated_cost: Number(getWasteCost(item, productionMap).toFixed(2)),
      approval_status: item.approval_status,
      record_status: item.status
    }));
    const recommendationRows = wasteReductionInsights.recipeActions.map((item) => ({
      site_name: item.site_name,
      meal_type: titleCase(item.meal_type),
      recipe_name: item.recipe_name,
      produced_servings: Number(item.produced_servings.toFixed(2)),
      waste_rate_percent: item.waste_rate,
      waste_cost: Number(item.waste_cost.toFixed(2)),
      action: item.action,
      suggested_change_percent: item.suggested_change_percent,
      rationale: item.rationale
    }));
    const rows = [...wasteRows, ...recommendationRows];

    if (type === 'excel') {
      downloadExcel(rows, 'food_waste_analytics', 'Waste Analytics');
      return;
    }
    if (type === 'pdf') {
      downloadPDF({
        title: 'Food Waste Analytics',
        subtitle: `Date: ${filters.startDate} to ${filters.endDate} | Location: ${filters.locationId === 'all' ? 'All Locations' : (siteMap.get(filters.locationId)?.name || filters.locationId)}`,
        sections: [
          {
            heading: 'Waste Summary',
            lines: [
              `Total waste quantity: ${totalWasteQuantity.toFixed(2)} kg`,
              `Total waste cost: ${formatCurrency(totalWasteCost)}`,
              `Avoidable waste cost: ${formatCurrency(avoidableCost)}`,
              `Waste vs production: ${wastePercentVsProduction}%`
            ]
          },
          {
            heading: 'Recipe Reduction Recommendations',
            lines: wasteReductionInsights.recipeActions.slice(0, 8).map((item) => (
              `${item.site_name} | ${titleCase(item.meal_type)} | ${item.recipe_name}: ${item.action} ${item.suggested_change_percent ? `(${item.suggested_change_percent}%)` : ''} - ${item.rationale}`
            ))
          },
          {
            heading: 'Material Request Actions',
            lines: wasteReductionInsights.materialRequestActions.length
              ? wasteReductionInsights.materialRequestActions.map((item) => `${item.item_name}: ${item.recommendation} (${formatCurrency(item.waste_cost)} waste cost)`)
              : ['No MR reduction actions identified in the selected range.']
          }
        ],
        filename: 'food_waste_analytics'
      });
      return;
    }
    downloadCSV(rows, 'food_waste_analytics');
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1680px] mx-auto space-y-6">
        <PageHeader
          title="Food Waste Management"
          description="Track waste by ingredient, recipe, batch, and location with approval control, reduction targets, and operational waste reporting"
        >
          <Button variant="outline" onClick={() => exportWastePackage('csv')}>
            <Download className="w-4 h-4 mr-2" />
            CSV
          </Button>
          <Button variant="outline" onClick={() => exportWastePackage('excel')}>
            <Download className="w-4 h-4 mr-2" />
            Excel
          </Button>
          <Button variant="outline" onClick={() => exportWastePackage('pdf')}>
            <Download className="w-4 h-4 mr-2" />
            PDF
          </Button>
          {can('manage_waste') ? (
            <Button variant="outline" onClick={() => setTargetDialogOpen(true)}>
              <Target className="w-4 h-4 mr-2" />
              Waste Targets
            </Button>
          ) : null}
          {can('manage_waste') ? (
            <Button onClick={handleOpenCreateDialog} className="bg-red-600 hover:bg-red-700">
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

        {bootstrapError ? (
          <AsyncStatePanel
            variant="error"
            title="Food Waste Workspace Could Not Load"
            description={bootstrapError.message || 'Core food waste data could not be loaded. Retry the page and confirm your access to waste, production, recipe, and site records.'}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ['sites'] });
                  queryClient.invalidateQueries({ queryKey: ['ingredients'] });
                  queryClient.invalidateQueries({ queryKey: ['recipes'] });
                  queryClient.invalidateQueries({ queryKey: ['productionsForWaste'] });
                  queryClient.invalidateQueries({ queryKey: ['foodWaste'] });
                  queryClient.invalidateQueries({ queryKey: ['wasteTargets'] });
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry Loading
              </Button>
            }
          />
        ) : null}

        {!bootstrapError && bootstrapLoading ? (
          <AsyncStatePanel
            variant="loading"
            title="Loading Food Waste Recording"
            description="Fetching units, recipes, ingredients, production batches, recording windows, and previously logged waste records."
          />
        ) : null}

        {!bootstrapError && !bootstrapLoading && sites.length === 0 ? (
          <AsyncStatePanel
            variant="empty"
            title="No Projects Or Units Available"
            description="Food waste recording needs at least one visible project or unit. Add or assign a location first, then return to log meal waste."
          />
        ) : null}

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
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
                <Label>Meal Type</Label>
                <Select value={filters.mealType} onValueChange={(value) => setFilters((current) => ({ ...current, mealType: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Meals</SelectItem>
                    {MEAL_TYPE_OPTIONS.map((item) => (
                      <SelectItem key={item} value={item}>{titleCase(item)}</SelectItem>
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
                    <SelectItem value="recipe">Recipe</SelectItem>
                    <SelectItem value="batch">Batch</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
          <StatCard title="Total Waste Quantity" value={`${totalWasteQuantity.toFixed(2)} kg`} icon={Trash2} iconBg="bg-red-50" iconColor="text-red-600" />
          <StatCard title="Waste Cost" value={formatCurrency(totalWasteCost)} icon={CircleDollarSign} iconBg="bg-amber-50" iconColor="text-amber-600" />
          <StatCard title="Avoidable Waste" value={formatCurrency(avoidableCost)} subtitle={`${analyticsWaste.filter((item) => item.avoidable_type === 'avoidable' || item.preventable).length} records`} icon={AlertTriangle} iconBg="bg-orange-50" iconColor="text-orange-600" />
          <StatCard title="Waste vs Production" value={`${wastePercentVsProduction}%`} subtitle={`${totalProductionOutput.toFixed(0)} production output`} icon={TrendingDown} iconBg="bg-purple-50" iconColor="text-purple-600" />
          <StatCard title="Pending Approvals" value={pendingApprovalWaste.length} subtitle={`Threshold ${formatCurrency(APPROVAL_THRESHOLD)}`} icon={CheckCircle2} iconBg="bg-blue-50" iconColor="text-blue-600" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Brain className="w-5 h-5 text-amber-600" />
                Waste Reduction Intelligence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {wasteReductionInsights.recipeActions.length === 0 ? (
                <p className="py-12 text-center text-sm text-slate-500">Not enough production and waste history yet to generate recipe guidance.</p>
              ) : wasteReductionInsights.recipeActions.slice(0, 6).map((item) => (
                <div key={item.key} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{item.recipe_name}</p>
                      <p className="text-xs text-slate-500">{item.site_name} • {titleCase(item.meal_type)}</p>
                    </div>
                    <Badge className={
                      item.action === 'Reduce production'
                        ? 'bg-red-100 text-red-700'
                        : item.action === 'Increase production'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-700'
                    }>
                      {item.action}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-4">
                    <div className="rounded-lg bg-white px-3 py-2">
                      <p className="text-xs text-slate-500">Produced</p>
                      <p className="font-semibold text-slate-900">{item.produced_servings.toFixed(0)} servings</p>
                    </div>
                    <div className="rounded-lg bg-white px-3 py-2">
                      <p className="text-xs text-slate-500">Waste Rate</p>
                      <p className="font-semibold text-slate-900">{item.waste_rate}%</p>
                    </div>
                    <div className="rounded-lg bg-white px-3 py-2">
                      <p className="text-xs text-slate-500">Waste Cost</p>
                      <p className="font-semibold text-slate-900">{formatCurrency(item.waste_cost)}</p>
                    </div>
                    <div className="rounded-lg bg-white px-3 py-2">
                      <p className="text-xs text-slate-500">Cost / Serving</p>
                      <p className="font-semibold text-slate-900">{formatCurrency(item.cost_per_serving)}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-600">{item.rationale}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <PackageCheck className="w-5 h-5 text-blue-600" />
                Recipe, Ingredient, MR Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-900">Material Request Guidance</p>
                <div className="mt-2 space-y-2">
                  {wasteReductionInsights.materialRequestActions.length === 0 ? (
                    <p className="text-sm text-slate-500">No MR reduction actions identified.</p>
                  ) : wasteReductionInsights.materialRequestActions.slice(0, 4).map((item) => (
                    <div key={item.item_name} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                      <p className="font-medium text-slate-900">{item.item_name}</p>
                      <p>{item.recommendation}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-900">Ingredient Focus</p>
                <div className="mt-2 space-y-2">
                  {wasteReductionInsights.ingredientActions.slice(0, 4).map((item) => (
                    <div key={item.item_name} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-slate-900">{item.item_name}</span>
                        <Badge variant="outline">{item.action}</Badge>
                      </div>
                      <p className="mt-1 text-slate-600">{item.recommendation}</p>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Food Cost Impact by Meal Type</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Meal Type</TableHead>
                  <TableHead>Produced Servings</TableHead>
                  <TableHead>Production Cost</TableHead>
                  <TableHead>Waste Cost</TableHead>
                  <TableHead>Cost / Serving</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wasteReductionInsights.mealTypeCostRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-slate-500">No food cost impact rows available for this range.</TableCell>
                  </TableRow>
                ) : wasteReductionInsights.mealTypeCostRows.map((item) => (
                  <TableRow key={item.meal_type}>
                    <TableCell className="font-medium">{titleCase(item.meal_type)}</TableCell>
                    <TableCell>{item.servings.toFixed(0)}</TableCell>
                    <TableCell>{formatCurrency(item.production_cost)}</TableCell>
                    <TableCell>{formatCurrency(item.waste_cost)}</TableCell>
                    <TableCell>{formatCurrency(item.cost_per_serving)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

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
                      <p className="text-xs text-slate-500">{item.site_name} • {item.waste_date} • {formatCurrency(getWasteCost(item, productionMap))}</p>
                    </div>
                    <Badge className={APPROVAL_TONES.pending}>pending</Badge>
                  </div>
                  {can('approve_waste') ? (
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
                  <TableHead>Item Code</TableHead>
                  <TableHead>Item Name</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Meal</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Picture</TableHead>
                  <TableHead>Recording Window</TableHead>
                  <TableHead>Approval</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredWaste.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={14} className="py-10 text-center text-slate-500">No waste records found for the selected filters.</TableCell>
                  </TableRow>
                ) : filteredWaste.slice(0, 30).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs text-slate-600">
                      {getItemCodeFromRecords([
                        ingredientMap.get(item.ingredient_id),
                        item,
                        { item_code: recipeMap.get(item.recipe_id || productionMap.get(item.production_id)?.recipe_id)?.recipe_code }
                      ])}
                    </TableCell>
                    <TableCell>{item.ingredient_name || item.recipe_name || item.batch_reference || '-'}</TableCell>
                    <TableCell className="font-medium">{item.waste_date}</TableCell>
                    <TableCell>{titleCase(item.meal_type || '-')}</TableCell>
                    <TableCell>{item.site_name}</TableCell>
                    <TableCell>
                      <Badge className={CATEGORY_BADGES[item.waste_category] || 'bg-slate-100 text-slate-700'}>
                        {getCategoryMeta(item.waste_category)?.label || item.waste_category}
                      </Badge>
                    </TableCell>
                    <TableCell>{item.reason || getReasonMeta(item.reason_code)?.label || '-'}</TableCell>
                    <TableCell>
                      <Badge className={isMealServiceLeftover(item) ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}>
                        {getWasteSourceLabel(item)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatWasteQuantity(item)}</TableCell>
                    <TableCell>{formatCurrency(getWasteCost(item, productionMap))}</TableCell>
                    <TableCell>
                      {item.evidence_image_url || item.image_url ? (
                        <a className="text-sm font-medium text-emerald-700 hover:underline" href={item.evidence_image_url || item.image_url} target="_blank" rel="noreferrer">
                          View
                        </a>
                      ) : isMealServiceLeftover(item) ? (
                        <Badge className="bg-slate-100 text-slate-700">System generated</Badge>
                      ) : (
                        <Badge className="bg-red-100 text-red-700">Missing</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={
                        item.is_within_recording_window
                          ? 'bg-emerald-100 text-emerald-700'
                          : item.window_status === 'before_production'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-slate-200 text-slate-700'
                      }>
                        {item.window_status === 'open'
                          ? 'Open'
                          : item.window_status === 'before_production'
                            ? 'Before production'
                            : item.window_status === 'future_date'
                              ? 'Future date'
                            : 'Closed'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={String(item.status || '').toLowerCase() === 'reversed'
                        ? 'bg-slate-200 text-slate-700'
                        : APPROVAL_TONES[item.approval_status] || 'bg-slate-100 text-slate-700'}>
                        {String(item.status || '').toLowerCase() === 'reversed' ? 'reversed' : item.approval_status || 'approved'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {isMealServiceLeftover(item) ? (
                        <Badge
                          className="bg-slate-100 text-slate-700"
                          title="System managed. Reverse the related Meal Service request to correct this record."
                        >
                          System managed
                        </Badge>
                      ) : isBatchOverproductionWasteRecord(item) ? (
                        <Badge
                          className="bg-amber-100 text-amber-700"
                          title="Dish-wise batch overproduction waste should be corrected by recording a new dish entry."
                        >
                          Dish-wise
                        </Badge>
                      ) : can('manage_waste') ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!item.can_edit || String(item.status || '').toLowerCase() === 'reversed'}
                          onClick={() => handleOpenEditDialog(item)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) {
              setEditingWasteId(null);
              setFormData(createDefaultWasteForm());
              setDishWasteGramsByRecipe({});
              setWasteImageFile(null);
              setWasteImagePreview('');
            }
          }}
        >
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingWasteId ? 'Edit Food Waste Record' : 'Record Food Waste'}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleWasteSubmit} className="space-y-4">
              {wasteContext ? (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                  wasteContext.is_within_recording_window
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : wasteContext.window_status === 'before_production'
                      ? 'border-blue-200 bg-blue-50 text-blue-800'
                      : 'border-red-200 bg-red-50 text-red-800'
                }`}>
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    <Clock3 className="h-4 w-4" />
                    <span>{wasteContext.message}</span>
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <p>
                      <span className="font-medium">
                        {wasteContext.recording_window_basis === 'admin_month' ? 'Admin window:' : 'Production completed:'}
                      </span>{' '}
                      {wasteContext.recording_window_basis === 'admin_month'
                        ? 'Current month'
                        : wasteContext.production_completed_at
                          ? new Date(wasteContext.production_completed_at).toLocaleString()
                          : 'No successful production found'}
                    </p>
                    <p>
                      <span className="font-medium">
                        {wasteContext.recording_window_basis === 'admin_month' ? 'Month closes:' : 'Recording deadline:'}
                      </span>{' '}
                      {wasteContext.recording_deadline_at ? new Date(wasteContext.recording_deadline_at).toLocaleString() : 'Unavailable'}
                    </p>
                  </div>
                  {wasteContext.menu_plan ? (
                    <div className="mt-3 rounded-lg border border-white/70 bg-white/70 px-3 py-2 text-slate-700">
                      <p className="font-medium text-slate-900">Planned menu for {titleCase(wasteContext.meal_type)}</p>
                      <p className="mt-1 text-sm">
                        {wasteContext.planned_menu_items.length
                          ? wasteContext.planned_menu_items.map((item) => `${item.recipe_name} (${item.expected_servings} servings)`).join(', ')
                          : 'No planned recipes found for this meal.'}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Location</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData((current) => ({ ...current, site_id: value }))}
                  >
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
                  <Label>Meal Type</Label>
                  <Select value={formData.meal_type} onValueChange={(value) => setFormData((current) => ({ ...current, meal_type: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MEAL_TYPE_OPTIONS.map((item) => (
                        <SelectItem key={item} value={item}>{titleCase(item)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Waste Category</Label>
                  <Select value={formData.waste_category} onValueChange={handleWasteCategoryChange}>
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
                {!isBatchOverproduction ? (
                  <div>
                    <Label>Production Batch</Label>
                    <Select value={formData.production_id} onValueChange={(value) => setFormData((current) => ({ ...current, production_id: value }))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No linked batch</SelectItem>
                        {(wasteContext?.production_options || productions
                          .filter((item) => !formData.site_id || item.site_id === formData.site_id)
                          .filter((item) => !formData.meal_type || String(item.meal_type || '').toLowerCase() === formData.meal_type)
                          .filter((item) => !formData.waste_date || item.production_date === formData.waste_date))
                          .map((item) => (
                            <SelectItem key={item.id} value={item.id}>{item.recipe_name} - {item.production_date} - {item.site_name}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div>
                  <Label>Batch Reference</Label>
                  <Input className="mt-1" value={formData.batch_reference} onChange={(event) => setFormData((current) => ({ ...current, batch_reference: event.target.value }))} placeholder="Optional manual batch / lot ref" />
                </div>
                <div>
                  <Label>Quantity</Label>
                  <Input
                    type="number"
                    min="0"
                    step={isBatchOverproduction ? '0.001' : '0.01'}
                    className="mt-1"
                    value={formData.quantity}
                    readOnly={isBatchOverproduction}
                    placeholder={isBatchOverproduction ? 'Total from dish rows' : ''}
                    onChange={(event) => setFormData((current) => ({ ...current, quantity: event.target.value }))}
                  />
                  {formData.waste_category === 'plate_waste' ? (
                    <p className="mt-2 text-sm font-medium leading-snug text-red-600">
                      This weight will be deducted from the consumed amount under Meal Service Menu.
                    </p>
                  ) : null}
                </div>
                <div>
                  <Label>Unit</Label>
                  <Select value={formData.unit} disabled={isBatchOverproduction} onValueChange={(value) => setFormData((current) => ({ ...current, unit: value }))}>
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

              {isBatchOverproduction ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">Batch Overproduction Production Summary</p>
                      <p className="mt-1 text-xs text-slate-600">
                        Enter recorded food waste in grams against each produced dish. Quantity stays visible and totals these dish rows.
                      </p>
                    </div>
                    <Badge className="bg-white text-amber-700 border border-amber-200">
                      Total: {formatWeightGrams(batchWasteTotalGrams)}
                    </Badge>
                  </div>

                  {!formData.site_id || !formData.waste_date || !formData.meal_type ? (
                    <p className="mt-4 rounded-lg border border-dashed border-amber-200 bg-white/70 px-3 py-3 text-sm text-slate-600">
                      Select a location, waste date, and meal type to load the production summary.
                    </p>
                  ) : wasteContextLoading ? (
                    <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-100 bg-white/70 px-3 py-3 text-sm text-slate-600">
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Loading produced dishes…
                    </div>
                  ) : wasteContextError ? (
                    <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                      {wasteContextError.message || 'Unable to load the production summary.'}
                    </p>
                  ) : batchWasteRows.length ? (
                    <div className="mt-4 overflow-x-auto rounded-lg border border-amber-100 bg-white">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Dish Name</TableHead>
                            <TableHead>Produced Quantity</TableHead>
                            <TableHead>Recorded Food Waste (g)</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {batchWasteRows.map((row) => {
                            const isOverAvailable = row.waste_grams > safeNumber(row.available_weight_grams);
                            return (
                              <TableRow key={row.recipe_id}>
                                <TableCell className="min-w-[220px]">
                                  <div className="font-medium text-slate-900">{row.recipe_name}</div>
                                  <div className="text-xs text-slate-500">
                                    {row.batch_count} {row.batch_count === 1 ? 'batch' : 'batches'}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <div className="font-medium text-slate-900">{formatWeightGrams(row.produced_weight_grams)}</div>
                                  <div className="text-xs text-slate-500">
                                    Available: {formatWeightGrams(row.available_weight_grams)}
                                  </div>
                                </TableCell>
                                <TableCell className="min-w-[220px]">
                                  <Input
                                    type="number"
                                    min="0"
                                    step="0.001"
                                    max={safeNumber(row.available_weight_grams) || undefined}
                                    value={dishWasteGramsByRecipe[row.recipe_id] ?? ''}
                                    onChange={(event) => handleDishWasteGramsChange(row.recipe_id, event.target.value)}
                                    className={isOverAvailable ? 'border-red-300 focus-visible:ring-red-500' : ''}
                                    placeholder="0"
                                  />
                                  {isOverAvailable ? (
                                    <p className="mt-1 text-xs text-red-600">
                                      Available waste balance is {formatWeightGrams(row.available_weight_grams)}.
                                    </p>
                                  ) : null}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="mt-4 rounded-lg border border-dashed border-amber-200 bg-white/70 px-3 py-3 text-sm text-slate-600">
                      No completed production output was found for this date, location, and meal type.
                    </p>
                  )}
                </div>
              ) : null}

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

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Label>Waste Picture <span className="text-red-600">*</span></Label>
                    <p className="mt-1 text-xs text-slate-500">Photo evidence is required before this waste can be saved.</p>
                  </div>
                  <Button type="button" variant="outline" onClick={() => wasteImageInputRef.current?.click()}>
                    <ImagePlus className="mr-2 h-4 w-4" />
                    {wasteImagePreview ? 'Change Picture' : 'Add Picture'}
                  </Button>
                </div>
                <input
                  ref={wasteImageInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handleWasteImageChange}
                />
                {wasteImagePreview ? (
                  <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                    <img src={wasteImagePreview} alt="Waste evidence preview" className="h-48 w-full object-cover" />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => wasteImageInputRef.current?.click()}
                    className="mt-3 flex h-32 w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm font-medium text-slate-500"
                  >
                    Add required waste picture
                  </button>
                )}
              </div>

              <div>
                <Label>Notes</Label>
                <Textarea rows={4} className="mt-1" value={formData.notes} onChange={(event) => setFormData((current) => ({ ...current, notes: event.target.value }))} placeholder="Corrective action, observed issue, or additional waste details" />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => {
                  setFormOpen(false);
                  setEditingWasteId(null);
                  setFormData(createDefaultWasteForm());
                }}>Cancel</Button>
                <Button
                  type="submit"
                  className="bg-red-600 hover:bg-red-700"
                  disabled={
                    createWasteMutation.isPending
                    || updateWasteMutation.isPending
                    || wasteImageUploading
                    || !formData.site_id
                    || !formData.quantity
                    || (!wasteImageFile && !formData.evidence_image_url)
                    || !formData.meal_type
                    || !wasteContext?.is_within_recording_window
                  }
                >
                  {createWasteMutation.isPending || updateWasteMutation.isPending || wasteImageUploading
                    ? 'Saving...'
                    : editingWasteId ? 'Update Waste Record' : 'Save Waste Record'}
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
