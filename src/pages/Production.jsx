import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ProductionPlanningDashboard from '@/components/production/ProductionPlanningDashboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertCircle, CheckCircle2, XCircle, Brain, FileText, History } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { format } from 'date-fns';
import { usePermissions } from '@/components/auth/usePermissions';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { formatCurrency } from '@/lib/currency';
import StandardDecimalInput from '@/components/recipes/StandardDecimalInput';
import { buildProductionPlanExportRows } from '@/lib/productionPlanning';
import {
  getInventoryQuantities,
  getProductionInventoryState
} from '@/lib/inventoryAvailability';
import {
  calculateIngredientCost,
  convertIngredientQuantity
} from '../../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';
import { calculateYieldAdjustedQuantity } from '../../shared/ingredientYield.js';
import { formatRecipeQuantity, getRecipeQuantityPrecision, roundStandardDecimal } from '../../shared/recipeNumbers.js';
import { getItemCode } from '../../shared/itemCode.js';
import {
  canStartApprovedProduction,
  getPendingAreaApprovalProductions,
  getProductionApprovalHistory,
  getProductionRejectionReturnStatus,
  getProductionStartBlockReason,
  getProductionStatusLabel,
  requiresAreaProductionApproval
} from '../../shared/productionWorkflow.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';

const MEAL_TYPES = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' }
];

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isAreaApprovalReview(production) {
  return requiresAreaProductionApproval(production);
}

function formatWorkflowTimestamp(value) {
  if (!value) return 'Date and time not recorded';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return String(value);
  return format(timestamp, 'dd MMM yyyy, hh:mm a');
}

function ApprovalHistoryList({ production, emptyMessage = 'No approval actions have been recorded yet.' }) {
  const history = getProductionApprovalHistory(production);
  if (history.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>;
  }

  return (
    <ol className="space-y-2">
      {history.map((entry) => {
        const actor = entry.actor_name || entry.actor_email || 'System';
        const transition = entry.from_status || entry.to_status
          ? `${getProductionStatusLabel(entry.from_status || 'draft')} → ${getProductionStatusLabel(entry.to_status || entry.from_status)}`
          : '';
        return (
          <li key={entry.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">{entry.action_label}</p>
                <p className="text-xs text-slate-600">By {actor}</p>
              </div>
              <time className="text-xs text-slate-500" dateTime={entry.timestamp || undefined}>
                {formatWorkflowTimestamp(entry.timestamp)}
              </time>
            </div>
            {transition ? <p className="mt-1 text-xs text-slate-500">{transition}</p> : null}
            {entry.reason ? (
              <p className="mt-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
                <span className="font-medium">Reason / notes:</span> {entry.reason}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function Production() {
  const { can, role: currentRole } = usePermissions();
  const { allowedSiteIds, isAdmin, siteId: assignedSiteId } = useSiteContext();
  const canReviewAreaApprovals = can('approve_production')
    || can('reject_area_production')
    || can('request_changes_area_production');
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [formData, setFormData] = useState({
    site_id: '',
    fulfillment_store_id: '',
    production_date: format(new Date(), 'yyyy-MM-dd'),
    meal_type: 'lunch',
    recipe_id: '',
    target_servings: null,
    kitchen_station: '',
    notes: ''
  });
  const [calculatedIngredients, setCalculatedIngredients] = useState([]);
  const [inventoryCheck, setInventoryCheck] = useState([]);
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [selectedProduction, setSelectedProduction] = useState(null);
  const [editingProduction, setEditingProduction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [estimatedBatchCost, setEstimatedBatchCost] = useState(0);
  const [estimatedCostPerServing, setEstimatedCostPerServing] = useState(0);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewAction, setReviewAction] = useState('');
  const [reviewFulfillmentStoreId, setReviewFulfillmentStoreId] = useState('');
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionProduction, setCompletionProduction] = useState(null);
  const [completionQuantities, setCompletionQuantities] = useState([]);
  const [completionFulfillmentStoreId, setCompletionFulfillmentStoreId] = useState('');
  const [selectedConsumptionReport, setSelectedConsumptionReport] = useState(null);
  const [reportLoadingId, setReportLoadingId] = useState('');
  const [historyProduction, setHistoryProduction] = useState(null);
  const [inventoryAction, setInventoryAction] = useState(null);
  const [inventoryActionMode, setInventoryActionMode] = useState('adjust');
  const [inventoryActionServings, setInventoryActionServings] = useState(null);
  const [inventoryActionReason, setInventoryActionReason] = useState('');

  const queryClient = useQueryClient();

  const { data: sites = [], error: sitesError } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: recipes = [], error: recipesError } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [], error: ingredientsError } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: productions = [], isLoading, error: productionsError } = useQuery({
    queryKey: ['productions', selectedDate],
    queryFn: () => base44.entities.Production.filter({
      production_date: selectedDate
    }, '-production_date'),
    enabled: Boolean(selectedDate),
    refetchInterval: 300000
  });

  const {
    data: areaApprovalCandidates = [],
    isLoading: isAreaApprovalQueueLoading,
    error: areaApprovalQueueError
  } = useQuery({
    queryKey: ['productionAreaApprovalQueue'],
    queryFn: async () => {
      const [pending, legacyApproved] = await Promise.all([
        base44.entities.Production.filter({ status: 'pending_production' }, 'production_date', 5000),
        base44.entities.Production.filter({ status: 'approved' }, 'production_date', 5000)
      ]);
      const records = [...pending, ...legacyApproved];
      return [...new Map(records.map((record) => [String(record.id), record])).values()];
    },
    enabled: canReviewAreaApprovals,
    refetchInterval: 300000
  });

  const { data: productionHistory = [] } = useQuery({
    queryKey: ['productionHistoryForWasteInsights'],
    queryFn: () => base44.entities.Production.list('-production_date', 1000)
  });

  const { data: materialRequests = [], error: materialRequestsError } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list(),
    enabled: can('view_material_request') || can('acknowledge_material_request') || can('manage_procurement') || can('approve_procurement'),
    refetchInterval: 300000
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWasteForProduction'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 1000),
    enabled: can('manage_waste')
  });

  const createMutation = useMutation({
    mutationFn: (data) => (
      editingProduction
        ? base44.entities.Production.update(editingProduction.id, data)
        : base44.entities.Production.create(data)
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      setFormOpen(false);
      setEditingProduction(null);
      setActionError('');
      resetForm();
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to create production plan');
    }
  });

  const { data: inventory = [], error: inventoryError } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.inventory.getStockOnHand(),
    refetchInterval: 300000
  });

  useEffect(() => {
    const unsubscribeProduction = base44.entities.Production.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'] });
    });
    const unsubscribeRequests = base44.entities.MaterialRequest.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
    });
    const unsubscribeInventory = base44.entities.Inventory.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    });
    return () => {
      unsubscribeProduction();
      unsubscribeRequests();
      unsubscribeInventory();
    };
  }, [queryClient]);

  const visibleSites = useMemo(() => (
    isAdmin
      ? sites
      : sites.filter((site) => allowedSiteIds.includes(site.id))
  ), [allowedSiteIds, isAdmin, sites]);
  const productionSiteOptions = useMemo(() => visibleSites.filter((site) => (
    site.is_active !== false
    && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT
  )), [visibleSites]);
  const selectedProductionSite = useMemo(() => (
    sites.find((site) => String(site.id) === String(formData.site_id)) || null
  ), [formData.site_id, sites]);
  const fulfillmentStoreOptions = useMemo(() => {
    if (!selectedProductionSite) return [];
    return visibleSites.filter((site) => (
      site.is_active !== false
      &&
      normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
      && String(site.parent_site_id || '') === String(selectedProductionSite.id)
    ));
  }, [selectedProductionSite, visibleSites]);
  const canViewAllAccessibleSites = isAdmin || [
    'general_manager',
    'assistant_general_manager',
    'area_manager'
  ].includes(currentRole);

  useEffect(() => {
    if (canViewAllAccessibleSites) {
      return;
    }

    const assignedProductionSite = productionSiteOptions.find(
      (site) => String(site.id) === String(assignedSiteId || '')
    );
    const fallbackSiteId = assignedProductionSite?.id || productionSiteOptions[0]?.id || '';
    setSelectedSite((current) => (current === 'all' || !current ? fallbackSiteId : current));
    setFormData((current) => ({
      ...current,
      site_id: current.site_id || fallbackSiteId
    }));
  }, [canViewAllAccessibleSites, assignedSiteId, productionSiteOptions]);

  useEffect(() => {
    if (!formData.site_id) return;
    const currentStoreIsValid = fulfillmentStoreOptions.some(
      (store) => String(store.id) === String(formData.fulfillment_store_id)
    );
    const nextStoreId = currentStoreIsValid
      ? formData.fulfillment_store_id
      : fulfillmentStoreOptions.length === 1
        ? fulfillmentStoreOptions[0].id
        : '';
    if (nextStoreId !== formData.fulfillment_store_id) {
      setFormData((current) => ({ ...current, fulfillment_store_id: nextStoreId }));
    }
  }, [formData.fulfillment_store_id, formData.site_id, fulfillmentStoreOptions]);

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status, ingredientQuantities = [], fulfillmentStoreId = '' }) => {
      if (status === 'completed') {
        await base44.inventory.completeProduction(id, {
          ingredient_quantities: ingredientQuantities,
          fulfillment_store_id: fulfillmentStoreId || undefined
        });
        return;
      }

      if (status === 'in_progress') {
        await base44.productionWorkflow.start(id);
        return;
      }

      await base44.entities.Production.update(id, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'] });
      queryClient.invalidateQueries({ queryKey: ['productionConsumptionReports'] });
      setCompletionOpen(false);
      setCompletionProduction(null);
      setCompletionQuantities([]);
      setCompletionFulfillmentStoreId('');
      setActionError('');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to update production status');
    }
  });

  const inventoryCommitmentMutation = useMutation({
    mutationFn: async ({ production, mode, targetServings, reason }) => {
      if (mode === 'cancel') {
        return base44.productionWorkflow.cancel(production.id, { reason });
      }
      return base44.productionWorkflow.adjustApprovedQuantity(production.id, {
        target_servings: Number(targetServings),
        expected_revision: Number(production.inventory_commitment_revision || 0),
        reason
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'] });
      setInventoryAction(null);
      setInventoryActionReason('');
      setInventoryActionServings(null);
      setActionError('');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to reconcile the approved production inventory reservation.');
    }
  });

  const resetForm = () => {
    setFormData({
      site_id: isAdmin
        ? ''
        : (productionSiteOptions.find((site) => String(site.id) === String(assignedSiteId || ''))?.id
          || productionSiteOptions[0]?.id
          || ''),
      fulfillment_store_id: '',
      production_date: format(new Date(), 'yyyy-MM-dd'),
      meal_type: 'lunch',
      recipe_id: '',
      target_servings: null,
      kitchen_station: '',
      notes: ''
    });
    setEditingProduction(null);
    setCalculatedIngredients([]);
    setInventoryCheck([]);
    setEstimatedBatchCost(0);
    setEstimatedCostPerServing(0);
    setReviewFulfillmentStoreId('');
    setCompletionFulfillmentStoreId('');
  };

  // Calculate required ingredients and check inventory when recipe or servings change
  useEffect(() => {
    if (
      formData.recipe_id
      && formData.target_servings
      && formData.site_id
      && formData.fulfillment_store_id
    ) {
      const recipe = recipes.find(r => r.id === formData.recipe_id);
      const hasRecipeComponents = recipe
        && ((Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0)
          || (Array.isArray(recipe.sub_recipes) && recipe.sub_recipes.length > 0));
      if (hasRecipeComponents) {
        const multiplier = recipe.servings > 0
          ? Number(formData.target_servings) / recipe.servings
          : Number(formData.target_servings) || 1;
        const inventorySiteId = formData.fulfillment_store_id || formData.site_id;
        const siteInventory = inventory.filter(i => i.site_id === inventorySiteId);
        const expandedRecipe = expandRecipeIngredients(
          recipe,
          recipes,
          ingredients,
          { multiplier, aggregate: true }
        );
        
        const calculated = expandedRecipe.ingredients.map(ing => {
          const ingredientData = ingredients.find(i => i.id === ing.ingredient_id);
          const plannedQty = ing.quantity || 0;
          const yieldAdjustment = calculateYieldAdjustedQuantity(plannedQty, ingredientData);
          const adjustedQty = yieldAdjustment.required_raw_quantity;
          
          const invItem = siteInventory.find(i => i.ingredient_id === ing.ingredient_id);
          const inventoryUnit = invItem?.unit || ingredientData?.unit || ing.unit;
          const costUnit = ingredientData?.unit || inventoryUnit;
          const requiredInventoryQty = convertIngredientQuantity(
            adjustedQty,
            ing.unit,
            inventoryUnit,
            ingredientData
          );
          const costQuantity = convertIngredientQuantity(
            adjustedQty,
            ing.unit,
            costUnit,
            ingredientData
          );
          const stockQuantities = getInventoryQuantities(invItem);
          const availableStock = stockQuantities.available_quantity;
          const shortage = Math.max(0, requiredInventoryQty - availableStock);
          const unitCost = toNumber(ingredientData?.cost_per_unit, 0);
          const estimatedCost = calculateIngredientCost(adjustedQty, ing.unit, ingredientData, unitCost);
          
          return {
            item_code: getItemCode(ingredientData, getItemCode(ing)),
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            source_recipe_names: ing.source_recipe_names || [],
            planned_quantity: roundStandardDecimal(plannedQty, getRecipeQuantityPrecision(ing.unit)),
            adjusted_quantity: roundStandardDecimal(adjustedQty, getRecipeQuantityPrecision(ing.unit)),
            on_hand_stock: roundStandardDecimal(stockQuantities.on_hand_quantity, getRecipeQuantityPrecision(inventoryUnit)),
            reserved_stock: roundStandardDecimal(stockQuantities.reserved_quantity, getRecipeQuantityPrecision(inventoryUnit)),
            available_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
            current_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
            shortage: roundStandardDecimal(shortage, getRecipeQuantityPrecision(inventoryUnit)),
            unit: ing.unit,
            inventory_unit: inventoryUnit,
            cost_quantity: Number(costQuantity.toFixed(4)),
            cost_unit: costUnit,
            yield_multiplier: Number(yieldAdjustment.yield_multiplier.toFixed(6)),
            yield_percent: Number(yieldAdjustment.yield_percent.toFixed(2)),
            yield_source: yieldAdjustment.yield_source,
            shrinkage_percent: toNumber(ingredientData?.shrinkage_percent, 0),
            sufficient: availableStock >= requiredInventoryQty,
            unit_cost: Number(unitCost.toFixed(2)),
            estimated_cost: Number(estimatedCost.toFixed(2))
          };
        });
        setCalculatedIngredients(calculated);
        setInventoryCheck(calculated);
        const totalCost = calculated.reduce((sum, ingredient) => sum + toNumber(ingredient.estimated_cost, 0), 0);
        const servings = Math.max(1, toNumber(formData.target_servings, 0));
        setEstimatedBatchCost(Number(totalCost.toFixed(2)));
        setEstimatedCostPerServing(Number((totalCost / servings).toFixed(2)));
      }
    } else {
      setCalculatedIngredients([]);
      setInventoryCheck([]);
      setEstimatedBatchCost(0);
      setEstimatedCostPerServing(0);
    }
  }, [
    formData.fulfillment_store_id,
    formData.recipe_id,
    formData.target_servings,
    formData.site_id,
    recipes,
    ingredients,
    inventory
  ]);

  const filteredProductions = productions.filter(p => {
    const matchesSite = selectedSite === 'all'
      || p.site_id === selectedSite
      || p.fulfillment_store_id === selectedSite;
    const matchesDate = p.production_date === selectedDate;
    return matchesSite && matchesDate;
  });
  const areaApprovalQueue = getPendingAreaApprovalProductions(
    areaApprovalCandidates,
    isAdmin ? [] : allowedSiteIds
  );

  const materialRequestMap = materialRequests.reduce((map, request) => {
    if (request?.source_production_id && !map[request.source_production_id]) {
      map[request.source_production_id] = request;
    }
    return map;
  }, {});

  const recipeWasteInsights = useMemo(() => {
    const insights = new Map();

    productionHistory.forEach((production) => {
      const key = `${production.site_id || 'unknown'}::${production.recipe_id || 'unknown'}::${production.meal_type || 'unspecified'}`;
      if (!insights.has(key)) {
        insights.set(key, {
          key,
          recipe_id: production.recipe_id,
          recipe_name: production.recipe_name || 'Unknown recipe',
          site_id: production.site_id,
          meal_type: production.meal_type || 'unspecified',
          produced_servings: 0,
          waste_servings: 0,
          waste_cost: 0,
          avoidable_cost: 0
        });
      }
      const row = insights.get(key);
      row.produced_servings += toNumber(production.actual_servings || production.target_servings);
    });

    foodWaste.forEach((waste) => {
      const relatedProduction = waste.production_id
        ? productionHistory.find((production) => production.id === waste.production_id)
        : null;
      const siteId = waste.site_id || relatedProduction?.site_id || 'unknown';
      const recipeId = waste.recipe_id || relatedProduction?.recipe_id || 'unknown';
      const mealType = relatedProduction?.meal_type || 'unspecified';
      const key = `${siteId}::${recipeId}::${mealType}`;
      if (!insights.has(key)) {
        insights.set(key, {
          key,
          recipe_id: recipeId,
          recipe_name: waste.recipe_name || relatedProduction?.recipe_name || 'Unknown recipe',
          site_id: siteId,
          meal_type: mealType,
          produced_servings: 0,
          waste_servings: 0,
          waste_cost: 0,
          avoidable_cost: 0
        });
      }
      const row = insights.get(key);
      row.waste_servings += toNumber(waste.quantity);
      row.waste_cost += toNumber(waste.estimated_cost);
      if (waste.avoidable_type === 'avoidable' || waste.preventable) {
        row.avoidable_cost += toNumber(waste.estimated_cost);
      }
    });

    return insights;
  }, [foodWaste, productionHistory]);

  const selectedRecipeInsight = useMemo(() => {
    if (!formData.recipe_id || !formData.site_id) return null;
    const selectedRecipe = recipes.find((recipe) => recipe.id === formData.recipe_id);
    const key = `${formData.site_id}::${formData.recipe_id}::${formData.meal_type || 'unspecified'}`;
    const row = recipeWasteInsights.get(key);
    if (!row) {
      return {
        key,
        recipe_id: formData.recipe_id,
        recipe_name: selectedRecipe?.name || 'Selected recipe',
        site_id: formData.site_id,
        meal_type: formData.meal_type || 'unspecified',
        waste_servings: 0,
        waste_cost: 0,
        wasteRate: 0,
        recommendation: 'No waste history exists for this recipe at this project yet. Start with the planned serving count, monitor returns closely, and post waste after service so the system can build future reduction guidance.',
        actionTone: 'bg-sky-50 border-sky-200 text-sky-800'
      };
    }
    const wasteRate = row.produced_servings > 0 ? (row.waste_servings / row.produced_servings) * 100 : 0;
    let recommendation = 'Stable output. Maintain current production level.';
    let actionTone = 'bg-emerald-50 border-emerald-200 text-emerald-800';
    if (wasteRate >= 12 || row.avoidable_cost >= 75) {
      recommendation = `Reduce planned servings by 10-20% or split production into smaller batches. Historical waste is ${wasteRate.toFixed(1)}% with ${formatCurrency(row.waste_cost)} waste cost.`;
      actionTone = 'bg-red-50 border-red-200 text-red-800';
    } else if (row.produced_servings >= 50 && wasteRate <= 2 && row.waste_cost <= 15) {
      recommendation = `This recipe is running cleanly. Consider a small increase if demand is rising. Historical waste is only ${wasteRate.toFixed(1)}%.`;
      actionTone = 'bg-emerald-50 border-emerald-200 text-emerald-800';
    } else {
      recommendation = `Monitor this recipe closely. Historical waste is ${wasteRate.toFixed(1)}% with ${formatCurrency(row.waste_cost)} waste cost.`;
      actionTone = 'bg-amber-50 border-amber-200 text-amber-800';
    }
    return {
      ...row,
      wasteRate: Number(wasteRate.toFixed(2)),
      recommendation,
      actionTone
    };
  }, [formData.meal_type, formData.recipe_id, formData.site_id, recipeWasteInsights, recipes]);

  const buildSubmitData = (status) => {
    const site = visibleSites.find((s) => s.id === formData.site_id) || sites.find((s) => s.id === formData.site_id);
    const fulfillmentStore = sites.find((s) => s.id === formData.fulfillment_store_id);
    const recipe = recipes.find(r => r.id === formData.recipe_id);

    return {
      ...formData,
      site_name: site?.name || '',
      fulfillment_store_id: fulfillmentStore?.id || '',
      fulfillment_store_name: fulfillmentStore?.name || '',
      recipe_name: recipe?.name || '',
      target_servings: Number(formData.target_servings) || 0,
      ingredients_used: calculatedIngredients.map(ing => ({
        item_code: ing.item_code === '—' ? '' : ing.item_code,
        ingredient_id: ing.ingredient_id,
        ingredient_name: ing.ingredient_name,
        source_recipe_names: ing.source_recipe_names,
        net_quantity: ing.planned_quantity,
        planned_quantity: ing.adjusted_quantity,
        required_quantity: ing.adjusted_quantity,
        yield_adjusted_quantity: ing.adjusted_quantity,
        yield_multiplier: ing.yield_multiplier,
        yield_percent: ing.yield_percent,
        yield_source: ing.yield_source,
        actual_quantity: null,
        unit: ing.unit,
        cost_quantity: ing.cost_quantity,
        cost_unit: ing.cost_unit,
        unit_cost: ing.unit_cost,
        estimated_cost: ing.estimated_cost
      })),
      total_calories: recipe?.calories_per_serving 
        ? recipe.calories_per_serving * Number(formData.target_servings)
        : 0,
      estimated_batch_cost: estimatedBatchCost,
      estimated_cost_per_serving: estimatedCostPerServing,
      status
    };
  };

  const handleSubmit = (e, status = 'draft') => {
    e.preventDefault();
    const form = e.currentTarget?.form || e.currentTarget;
    if (typeof form?.checkValidity === 'function' && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (
      !formData.site_id
      || !formData.fulfillment_store_id
      || !formData.production_date
      || !formData.recipe_id
      || !formData.kitchen_station.trim()
    ) {
      setActionError('Complete the project/site, fulfillment store, production date, recipe, servings, and kitchen station before saving.');
      return;
    }
    if (normalizeSiteType(selectedProductionSite?.type) !== SITE_HIERARCHY_TYPES.PROJECT) {
      setActionError('Select a Project first, then choose its fulfillment Store.');
      return;
    }
    setActionError('');
    createMutation.mutate(buildSubmitData(status));
  };

  const getProductionStoreOptions = (production) => {
    const productionSite = sites.find((site) => String(site.id) === String(production?.site_id || ''));
    if (!productionSite) return [];
    if (normalizeSiteType(productionSite.type) === SITE_HIERARCHY_TYPES.STORE) {
      return productionSite.is_active === false ? [] : [productionSite];
    }
    return visibleSites.filter((site) => (
      site.is_active !== false
      && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
      && String(site.parent_site_id || '') === String(productionSite.id)
    ));
  };

  const buildProductionInventoryCheck = (production, fulfillmentStoreId = '') => {
    const inventorySiteId = fulfillmentStoreId || production?.fulfillment_store_id;
    if (!inventorySiteId) return [];
    const siteInventory = inventory.filter((item) => String(item.site_id) === String(inventorySiteId || ''));

    return production?.ingredients_used?.map((line) => {
      const inventoryItem = siteInventory.find((item) => item.ingredient_id === line.ingredient_id);
      const ingredientData = ingredients.find((ingredient) => ingredient.id === line.ingredient_id);
      const inventoryUnit = inventoryItem?.unit || ingredientData?.unit || line.unit;
      const requiredQuantity = convertIngredientQuantity(
        line.required_quantity
          ?? line.yield_adjusted_quantity
          ?? line.planned_quantity
          ?? line.adjusted_quantity
          ?? line.actual_quantity
          ?? 0,
        line.unit || inventoryUnit,
        inventoryUnit,
        ingredientData
      );
      const stockQuantities = getInventoryQuantities(inventoryItem);
      const availableStock = stockQuantities.available_quantity;
      const shortage = Math.max(0, requiredQuantity - availableStock);

      return {
        item_code: getItemCode(ingredientData, getItemCode(line)),
        ingredient_id: line.ingredient_id,
        ingredient_name: line.ingredient_name,
        adjusted_quantity: roundStandardDecimal(requiredQuantity, getRecipeQuantityPrecision(inventoryUnit)),
        on_hand_stock: roundStandardDecimal(stockQuantities.on_hand_quantity, getRecipeQuantityPrecision(inventoryUnit)),
        reserved_stock: roundStandardDecimal(stockQuantities.reserved_quantity, getRecipeQuantityPrecision(inventoryUnit)),
        available_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
        current_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
        shortage: roundStandardDecimal(shortage, getRecipeQuantityPrecision(inventoryUnit)),
        unit: inventoryUnit,
        inventory_unit: inventoryUnit,
        sufficient: availableStock >= requiredQuantity
      };
    }) || [];
  };

  const buildApprovedReservationPreview = (production, targetServings) => {
    const revisedServings = Number(targetServings);
    const currentServings = Number(production?.target_servings);
    const inventorySiteId = production?.fulfillment_store_id;
    if (
      !production
      || !inventorySiteId
      || !Number.isFinite(revisedServings)
      || revisedServings <= 0
      || !Number.isFinite(currentServings)
      || currentServings <= 0
    ) {
      return [];
    }

    const state = getProductionInventoryState(production);
    const siteInventory = inventory.filter((item) => String(item.site_id) === String(inventorySiteId));
    const sourceLines = state.lines.length > 0 ? state.lines : (production.ingredients_used || []);
    const servingFactor = revisedServings / currentServings;

    return sourceLines.map((line) => {
      const ingredientData = ingredients.find((ingredient) => String(ingredient.id) === String(line.ingredient_id));
      const inventoryItem = siteInventory.find((item) => String(item.ingredient_id) === String(line.ingredient_id));
      const inventoryUnit = inventoryItem?.unit || line.inventory_unit || ingredientData?.unit || line.unit || 'unit';
      const sourceUnit = line.inventory_unit || line.unit || inventoryUnit;
      const currentRequired = convertIngredientQuantity(
        line.desired_quantity
          ?? line.required_quantity
          ?? line.yield_adjusted_quantity
          ?? line.planned_quantity
          ?? line.adjusted_quantity
          ?? line.actual_quantity
          ?? 0,
        sourceUnit,
        inventoryUnit,
        ingredientData
      );
      const ownReserved = state.is_reserved
        ? convertIngredientQuantity(
          line.reserved_quantity ?? line.committed_quantity ?? 0,
          sourceUnit,
          inventoryUnit,
          ingredientData
        )
        : 0;
      const stock = getInventoryQuantities(inventoryItem);
      const revisedRequired = Math.max(0, currentRequired * servingFactor);
      // Aggregate availability excludes every active reservation. Add this
      // production's reservation back when evaluating its revised capacity.
      const totalCapacity = stock.available_quantity + ownReserved;
      const shortage = Math.max(0, revisedRequired - totalCapacity);
      const additionalReservation = Math.max(0, revisedRequired - ownReserved);
      const releaseQuantity = Math.max(0, ownReserved - revisedRequired);
      const precision = getRecipeQuantityPrecision(inventoryUnit);

      return {
        ingredient_id: line.ingredient_id,
        item_code: getItemCode(ingredientData, getItemCode(line)),
        ingredient_name: line.ingredient_name || ingredientData?.name || 'Ingredient',
        unit: inventoryUnit,
        revised_required: roundStandardDecimal(revisedRequired, precision),
        own_reserved: roundStandardDecimal(ownReserved, precision),
        free_available: roundStandardDecimal(stock.available_quantity, precision),
        total_capacity: roundStandardDecimal(totalCapacity, precision),
        additional_reservation: roundStandardDecimal(additionalReservation, precision),
        release_quantity: roundStandardDecimal(releaseQuantity, precision),
        shortage: roundStandardDecimal(shortage, precision),
        sufficient: shortage <= 0
      };
    });
  };

  const handleReview = async (action) => {
    if (!selectedProduction || reviewAction) return;

    if (action !== 'approve' && !reviewNotes.trim()) {
      setActionError('Review notes are required when requesting changes or rejecting production.');
      return;
    }
    if (action === 'approve' && !reviewFulfillmentStoreId) {
      setActionError('Select the fulfillment Store before approving this production request.');
      return;
    }

    setReviewAction(action);
    try {
      const areaReview = isAreaApprovalReview(selectedProduction);
      if (action === 'approve' && areaReview) {
        await base44.productionWorkflow.approveForArea(selectedProduction.id, {
          notes: reviewNotes || null,
          fulfillment_store_id: reviewFulfillmentStoreId
        });
      } else {
        const status = action === 'approve'
          ? 'pending_procurement'
          : action === 'request_changes'
            ? 'changes_requested'
            : getProductionRejectionReturnStatus(selectedProduction.status);
        if (!status) {
          throw new Error('This production request cannot be returned from its current stage.');
        }
        await base44.entities.Production.update(selectedProduction.id, {
          status,
          review_notes: reviewNotes || null,
          review_action: action === 'approve'
            ? 'approved'
            : action === 'reject'
              ? 'rejected'
              : 'changes_requested',
          ...(action === 'reject' ? { rejection_reason: reviewNotes.trim() } : {}),
          ...(action === 'approve' ? { fulfillment_store_id: reviewFulfillmentStoreId } : {})
        });
      }
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'] });
      setShowApprovalDialog(false);
      setSelectedProduction(null);
      setReviewNotes('');
      setReviewFulfillmentStoreId('');
      setActionError('');
    } catch (error) {
      setActionError(error.message || 'Unable to review the production request.');
    } finally {
      setReviewAction('');
    }
  };

  const openApprovalDialog = (production) => {
    const storeOptions = getProductionStoreOptions(production);
    const fulfillmentStoreId = storeOptions.some(
      (store) => String(store.id) === String(production.fulfillment_store_id || '')
    )
      ? production.fulfillment_store_id
      : storeOptions.length === 1
        ? storeOptions[0].id
        : '';

    setReviewFulfillmentStoreId(fulfillmentStoreId);
    setInventoryCheck(buildProductionInventoryCheck(production, fulfillmentStoreId));
    setActionError('');
    setSelectedProduction(production);
    setReviewNotes('');
    setReviewAction('');
    setShowApprovalDialog(true);
  };

  const openEditDialog = (production) => {
    setActionError('');
    setEditingProduction(production);
    setFormData({
      site_id: production.site_id || '',
      fulfillment_store_id: production.fulfillment_store_id || '',
      production_date: production.production_date || format(new Date(), 'yyyy-MM-dd'),
      meal_type: production.meal_type || 'lunch',
      recipe_id: production.recipe_id || '',
      target_servings: Number(production.target_servings) || null,
      kitchen_station: production.kitchen_station || production.assigned_station || production.station || '',
      notes: production.notes || ''
    });
    setFormOpen(true);
  };

  const openCompletionDialog = (production) => {
    const storeOptions = getProductionStoreOptions(production);
    const fulfillmentStoreId = storeOptions.some(
      (store) => String(store.id) === String(production.fulfillment_store_id || '')
    )
      ? production.fulfillment_store_id
      : storeOptions.length === 1
        ? storeOptions[0].id
        : '';
    setCompletionProduction(production);
    setCompletionFulfillmentStoreId(fulfillmentStoreId);
    setCompletionQuantities((production.ingredients_used || []).map((line) => ({
      ingredient_id: line.ingredient_id,
      item_code: line.item_code || getItemCode(ingredients.find((item) => item.id === line.ingredient_id), ''),
      ingredient_name: line.ingredient_name,
      actual_quantity: Number(line.actual_quantity ?? line.planned_quantity ?? line.adjusted_quantity ?? 0),
      planned_quantity: Number(line.planned_quantity ?? line.adjusted_quantity ?? 0),
      unit: line.unit || 'unit'
    })));
    setActionError('');
    setCompletionOpen(true);
  };

  const openConsumptionReport = async (production) => {
    const reportId = production.consumption_report_id;
    if (!reportId || reportLoadingId) return;
    setReportLoadingId(String(production.id));
    setActionError('');
    try {
      const report = await base44.entities.ProductionConsumptionReport.get(reportId);
      setSelectedConsumptionReport(report);
    } catch (error) {
      setActionError(error.message || 'Unable to load the production consumption report.');
    } finally {
      setReportLoadingId('');
    }
  };

  const openInventoryAction = (production, mode) => {
    setInventoryAction(production);
    setInventoryActionMode(mode);
    setInventoryActionServings(Number(production.target_servings) || null);
    setInventoryActionReason('');
    setActionError('');
  };

  const isStatusActionPending = (production, status) => (
    updateStatusMutation.isPending
    && String(updateStatusMutation.variables?.id || '') === String(production.id)
    && updateStatusMutation.variables?.status === status
  );

  const renderProductionActions = (production) => {
    const approvalHistory = getProductionApprovalHistory(production);
    const startBlockReason = getProductionStartBlockReason(production);
    const productionInventoryState = getProductionInventoryState(production);
    const startActionLabel = productionInventoryState.is_legacy_consumption
      ? 'Start Production (Legacy Stock Already Deducted)'
      : productionInventoryState.is_reserved
        ? 'Start Production & Consume Reserved Stock'
        : 'Start Production & Consume Stock';
    return (
      <div className="flex flex-wrap gap-2">
      {['draft', 'planned', 'changes_requested'].includes(production.status) && can('edit_production_request') ? (
        <Button size="sm" variant="outline" onClick={() => openEditDialog(production)}>
          Edit Request
        </Button>
      ) : null}
      {['draft', 'planned', 'changes_requested'].includes(production.status) && can('submit_production_request') ? (
        <Button
          size="sm"
          className="bg-amber-600 hover:bg-amber-700"
          onClick={() => updateStatusMutation.mutate({
            id: production.id,
            status: 'pending_approval',
            production
          })}
          disabled={updateStatusMutation.isPending}
        >
          Submit to Project Manager
        </Button>
      ) : null}
      {production.status === 'pending_approval'
        && can('review_production_request')
        && (can('approve_production_request') || can('request_changes_production') || can('reject_production_request')) ? (
        <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => openApprovalDialog(production)}>
          Review Request
        </Button>
      ) : null}
      {isAreaApprovalReview(production) && canReviewAreaApprovals ? (
        <Button size="sm" className="bg-purple-700 hover:bg-purple-800" onClick={() => openApprovalDialog(production)}>
          Area Manager Review
        </Button>
      ) : null}
      {production.status === 'pending_production' && can('start_production') ? (
        <Button size="sm" variant="outline" disabled title={startBlockReason}>
          Area Approval Required
        </Button>
      ) : null}
      {production.status === 'approved' && can('start_production') ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateStatusMutation.mutate({
            id: production.id,
            status: 'in_progress',
            production
          })}
          disabled={!canStartApprovedProduction(production) || isStatusActionPending(production, 'in_progress')}
          title={!canStartApprovedProduction(production) ? startBlockReason : undefined}
        >
          {isStatusActionPending(production, 'in_progress') ? 'Starting & Consuming...' : startActionLabel}
        </Button>
      ) : null}
      {production.status === 'approved' && (can('adjust_approved_production') || can('approve_production')) ? (
        <Button size="sm" variant="outline" onClick={() => openInventoryAction(production, 'adjust')}>
          Adjust Approved Quantity
        </Button>
      ) : null}
      {production.status === 'approved' && can('cancel_production') ? (
        <Button
          size="sm"
          variant="outline"
          className="border-red-200 text-red-700 hover:bg-red-50"
          onClick={() => openInventoryAction(production, 'cancel')}
        >
          Cancel & Release Reservation
        </Button>
      ) : null}
      {production.status === 'in_progress' && can('complete_production') ? (
        <Button
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700"
          onClick={() => openCompletionDialog(production)}
          disabled={isStatusActionPending(production, 'completed')}
        >
          {isStatusActionPending(production, 'completed') ? 'Completing...' : 'Reconcile & Complete'}
        </Button>
      ) : null}
      {production.status === 'completed' && production.consumption_report_id ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openConsumptionReport(production)}
          disabled={Boolean(reportLoadingId)}
        >
          <FileText className="mr-1.5 h-4 w-4" />
          {reportLoadingId === String(production.id) ? 'Loading Report...' : 'Consumption Report'}
        </Button>
      ) : null}
      {approvalHistory.length > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => setHistoryProduction(production)}>
          <History className="mr-1.5 h-4 w-4" />
          Approval History
        </Button>
      ) : null}
      </div>
    );
  };

  const loadError = actionError
    || productionsError?.message
    || sitesError?.message
    || recipesError?.message
    || ingredientsError?.message
    || inventoryError?.message
    || materialRequestsError?.message
    || '';
  const selectedIsAreaReview = isAreaApprovalReview(selectedProduction);
  const inventoryActionState = getProductionInventoryState(inventoryAction || {});
  const inventoryActionPreview = inventoryActionMode === 'adjust'
    ? buildApprovedReservationPreview(inventoryAction, inventoryActionServings)
    : [];
  const inventoryActionHasShortage = inventoryActionPreview.some((line) => !line.sufficient);
  const inventoryActionReservedLineCount = inventoryActionState.lines.filter(
    (line) => Number(line.reserved_quantity ?? line.committed_quantity ?? 0) > 0
  ).length;
  const selectedReviewStoreOptions = selectedProduction
    ? getProductionStoreOptions(selectedProduction)
    : [];
  const completionStoreOptions = completionProduction
    ? getProductionStoreOptions(completionProduction)
    : [];
  const canRequestSelectedChanges = selectedIsAreaReview
    ? can('request_changes_area_production')
    : can('review_production_request') && can('request_changes_production');
  const canRejectSelected = selectedIsAreaReview
    ? can('reject_area_production')
    : can('review_production_request') && can('reject_production_request');
  const canApproveSelected = selectedIsAreaReview
    ? can('approve_production')
    : can('review_production_request') && can('approve_production_request');
  const siteOptions = canViewAllAccessibleSites
    ? [{ id: 'all', name: 'All Sites' }, ...productionSiteOptions]
    : productionSiteOptions;

  return (
    <>
      <ProductionPlanningDashboard
        productions={filteredProductions}
        recipes={recipes}
        ingredients={ingredients}
        inventory={inventory}
        sites={siteOptions}
        selectedDate={selectedDate}
        selectedSite={selectedSite}
        onDateChange={setSelectedDate}
        onSiteChange={setSelectedSite}
        materialRequestMap={materialRequestMap}
        isLoading={isLoading}
        errorMessage={loadError}
        canCreate={can('create_production_request')}
        onNewProduction={() => {
          resetForm();
          setActionError('');
          setFormData((current) => ({
            ...current,
            production_date: selectedDate,
            site_id: selectedSite === 'all' ? '' : selectedSite,
            fulfillment_store_id: ''
          }));
          setFormOpen(true);
        }}
        onExport={(dashboard) => downloadCSV(
          buildProductionPlanExportRows(dashboard),
          `production_plan_${selectedDate}`
        )}
        onPrint={() => window.print()}
        renderActions={renderProductionActions}
        showAreaApprovalQueue={canReviewAreaApprovals}
        areaApprovalQueue={areaApprovalQueue}
        isAreaApprovalQueueLoading={isAreaApprovalQueueLoading}
        areaApprovalQueueError={areaApprovalQueueError?.message || ''}
        onReviewAreaApproval={openApprovalDialog}
        onViewApprovalHistory={setHistoryProduction}
      />

        {/* Form Dialog */}
        <Dialog
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) {
              resetForm();
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingProduction ? 'Edit Production Request' : 'Plan New Production'}</DialogTitle>
            </DialogHeader>
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </div>
            ) : null}
            <form onSubmit={(event) => handleSubmit(event, editingProduction ? editingProduction.status || 'draft' : 'draft')} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="site">Project / Production Site *</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData({
                      ...formData,
                      site_id: value,
                      fulfillment_store_id: ''
                    })}
                  >
                    <SelectTrigger id="site" className="mt-1">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {productionSiteOptions.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="fulfillment_store">Fulfillment Store *</Label>
                  <Select
                    value={formData.fulfillment_store_id}
                    onValueChange={(value) => setFormData({ ...formData, fulfillment_store_id: value })}
                    disabled={!formData.site_id || fulfillmentStoreOptions.length === 0}
                  >
                    <SelectTrigger id="fulfillment_store" className="mt-1">
                      <SelectValue placeholder={
                        !formData.site_id
                          ? 'Select a project first'
                          : fulfillmentStoreOptions.length === 0
                            ? 'No store configured under this project'
                            : 'Select fulfillment store'
                      } />
                    </SelectTrigger>
                    <SelectContent>
                      {fulfillmentStoreOptions.map((store) => (
                        <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formData.site_id && fulfillmentStoreOptions.length === 0 ? (
                    <p className="mt-1 text-xs text-red-600">
                      Add a Store under this Project before creating production.
                    </p>
                  ) : null}
                </div>

                <div>
                  <Label htmlFor="date">Production Date *</Label>
                  <Input
                    id="date"
                    type="date"
                    value={formData.production_date}
                    onChange={(e) => setFormData({ ...formData, production_date: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="meal_type">Meal Type *</Label>
                  <Select
                    value={formData.meal_type}
                    onValueChange={(value) => setFormData({ ...formData, meal_type: value })}
                  >
                    <SelectTrigger id="meal_type" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEAL_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="recipe">Recipe *</Label>
                  <Select
                    value={formData.recipe_id}
                    onValueChange={(value) => {
                      const selectedRecipe = recipes.find((recipe) => recipe.id === value);
                      setFormData({
                        ...formData,
                        recipe_id: value,
                        kitchen_station: formData.kitchen_station
                          || selectedRecipe?.kitchen_station
                          || selectedRecipe?.station
                          || ''
                      });
                    }}
                  >
                    <SelectTrigger id="recipe" className="mt-1">
                      <SelectValue placeholder="Select recipe" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipes.map(recipe => (
                        <SelectItem key={recipe.id} value={recipe.id}>
                          {recipe.name}{recipe.recipe_code ? ` (${recipe.recipe_code})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="servings">Target Servings *</Label>
                  <StandardDecimalInput
                    id="servings"
                    value={formData.target_servings}
                    unit="servings"
                    precision={0}
                    min={0}
                    allowZero={false}
                    allowEmpty={false}
                    label="Target servings"
                    onValueChange={(value) => setFormData((current) => ({ ...current, target_servings: value }))}
                    placeholder="Number of servings to produce"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="kitchen_station">Kitchen Station *</Label>
                  <Input
                    id="kitchen_station"
                    value={formData.kitchen_station}
                    onChange={(event) => setFormData({ ...formData, kitchen_station: event.target.value })}
                    placeholder="e.g. Hot Line, Grill, Cold Prep"
                    className="mt-1"
                    required
                  />
                </div>
              </div>

              {selectedRecipeInsight ? (
                <div className={`rounded-lg border px-4 py-3 ${selectedRecipeInsight.actionTone}`}>
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4" />
                    <p className="font-medium">Waste Reduction Intelligence</p>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg bg-white/80 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Historical Waste Rate</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{selectedRecipeInsight.wasteRate}%</p>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Wasted Servings</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{selectedRecipeInsight.waste_servings.toFixed(1)}</p>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Waste Cost</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{formatCurrency(selectedRecipeInsight.waste_cost)}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm">{selectedRecipeInsight.recommendation}</p>
                </div>
              ) : null}

              {/* Calculated Ingredients with Inventory Check */}
              {calculatedIngredients.length > 0 && (
                <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-5 h-5 text-blue-600" />
                    <h4 className="font-medium text-blue-900">Required Ingredients & Inventory Check</h4>
                  </div>
                  <div className="mb-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg bg-white px-4 py-3 border border-blue-100">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Estimated Batch Cost</p>
                      <p className="mt-1 text-2xl font-bold text-emerald-700">{formatCurrency(estimatedBatchCost)}</p>
                    </div>
                    <div className="rounded-lg bg-white px-4 py-3 border border-blue-100">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Estimated Cost / Serving</p>
                      <p className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(estimatedCostPerServing)}</p>
                    </div>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Net Recipe Qty</TableHead>
                        <TableHead>Yield</TableHead>
                        <TableHead>Raw Required</TableHead>
                        <TableHead>Unit Cost</TableHead>
                        <TableHead>Est. Cost</TableHead>
                        <TableHead>On Hand</TableHead>
                        <TableHead>Reserved</TableHead>
                        <TableHead>Available</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {calculatedIngredients.map((ing, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-xs text-slate-600">{ing.item_code}</TableCell>
                          <TableCell>{ing.ingredient_name}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.planned_quantity, ing.unit)} {ing.unit}</TableCell>
                          <TableCell>{ing.yield_percent.toFixed(2)}%</TableCell>
                          <TableCell className="font-medium">{formatRecipeQuantity(ing.adjusted_quantity, ing.unit)} {ing.unit}</TableCell>
                          <TableCell>{formatCurrency(toNumber(ing.unit_cost, 0))} / {ing.cost_unit}</TableCell>
                          <TableCell>{formatCurrency(toNumber(ing.estimated_cost, 0))}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.on_hand_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.reserved_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.available_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                          <TableCell>
                            {ing.sufficient ? (
                              <Badge className="bg-green-600">Sufficient</Badge>
                            ) : (
                              <Badge className="bg-red-600">Short {formatRecipeQuantity(ing.shortage, ing.inventory_unit)} {ing.inventory_unit}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {calculatedIngredients.some(ing => !ing.sufficient) && (
                    <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-sm text-amber-800">
                        <strong>Note:</strong> A linked material request will be created with this production request and released to procurement after approval.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Additional notes..."
                  className="mt-1"
                  rows={3}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); }}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="border-slate-300"
                  disabled={createMutation.isPending}
                  onClick={(event) => handleSubmit(event, 'draft')}
                >
                  {createMutation.isPending ? 'Saving...' : editingProduction ? 'Save Draft' : 'Create Draft'}
                </Button>
                <Button 
                  type="button" 
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={createMutation.isPending}
                  onClick={(event) => handleSubmit(event, 'pending_approval')}
                >
                  {createMutation.isPending ? 'Submitting...' : editingProduction ? 'Save & Submit' : 'Create & Submit'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Approval Dialog */}
        <Dialog
          open={showApprovalDialog}
          onOpenChange={(open) => {
            if (reviewAction) return;
            setShowApprovalDialog(open);
            if (!open) setActionError('');
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {isAreaApprovalReview(selectedProduction)
                  ? 'Area Manager Production Approval'
                  : 'Project Manager Production Review'}
              </DialogTitle>
            </DialogHeader>
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </div>
            ) : null}
            <div className="space-y-4">
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm font-medium mb-2">Production Details</p>
                <div className="space-y-1 text-sm text-slate-600">
                  <p>Recipe: {selectedProduction?.recipe_name}</p>
                  <p>Site: {selectedProduction?.site_name}</p>
                  <p>Date: {selectedProduction?.production_date}</p>
                  <p>Servings: {formatRecipeQuantity(selectedProduction?.target_servings, 'servings')}</p>
                  <p>Stage: {getProductionStatusLabel(selectedProduction?.status)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-900">
                  <History className="h-4 w-4" aria-hidden="true" />
                  Approval History
                </h4>
                <ApprovalHistoryList production={selectedProduction} />
              </div>

              <div>
                <Label htmlFor="review_fulfillment_store">Fulfillment Store (required for approval)</Label>
                <Select
                  value={reviewFulfillmentStoreId}
                  onValueChange={(value) => {
                    setReviewFulfillmentStoreId(value);
                    setInventoryCheck(buildProductionInventoryCheck(selectedProduction, value));
                    setActionError('');
                  }}
                  disabled={Boolean(selectedProduction?.fulfillment_store_id) || selectedReviewStoreOptions.length === 0}
                >
                  <SelectTrigger id="review_fulfillment_store" className="mt-1">
                    <SelectValue placeholder={selectedReviewStoreOptions.length ? 'Select fulfillment store' : 'No accessible Store under this Project'} />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedReviewStoreOptions.map((store) => (
                      <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {canApproveSelected && !reviewFulfillmentStoreId ? (
                  <p className="mt-1 text-xs text-amber-700">Select a fulfillment Store to approve. You can still return or reject the request with a reason.</p>
                ) : null}
              </div>

              <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
                <h4 className="font-medium text-blue-900 mb-3">Inventory Check</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>On Hand</TableHead>
                      <TableHead>Reserved</TableHead>
                      <TableHead>Available to Reserve</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventoryCheck.map((ing, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs text-slate-600">{ing.item_code}</TableCell>
                        <TableCell>{ing.ingredient_name}</TableCell>
                        <TableCell>{formatRecipeQuantity(ing.adjusted_quantity, ing.unit)} {ing.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(ing.on_hand_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(ing.reserved_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(ing.available_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                        <TableCell>
                          {ing.sufficient ? (
                            <Badge className="bg-green-600">✓ OK</Badge>
                          ) : (
                            <Badge className="bg-red-600">Short {formatRecipeQuantity(ing.shortage, ing.inventory_unit)} {ing.inventory_unit}</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {inventoryCheck.some(ing => !ing.sufficient) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-900">
                        {isAreaApprovalReview(selectedProduction)
                          ? 'Shortage Review Before Final Approval'
                          : 'Store / Procurement Action Required After PM Approval'}
                      </p>
                      <p className="text-sm text-amber-700 mt-1">
                        {isAreaApprovalReview(selectedProduction)
                          ? 'Final approval is blocked until the Store receives or corrects the remaining shortage. Approval reserves the yield-adjusted quantities; physical stock is deducted only when production starts.'
                          : 'After PM approval, the linked material request moves to the Store Keeper / Procurement Officer. Production then waits for Area Manager approval before it can start.'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor="reviewNotes">Review Notes</Label>
                <Textarea
                  id="reviewNotes"
                  value={reviewNotes}
                  onChange={(event) => setReviewNotes(event.target.value)}
                  placeholder="Add approval notes, rejection reasons, or requested changes..."
                  className="mt-1"
                  rows={3}
                />
              </div>

              <DialogFooter>
                {canRequestSelectedChanges ? (
                    <Button
                      variant="outline"
                      onClick={() => handleReview('request_changes')}
                      className="border-amber-300 text-amber-700 hover:bg-amber-50"
                      disabled={Boolean(reviewAction) || !reviewNotes.trim()}
                    >
                      <AlertCircle className="w-4 h-4 mr-2" />
                      Request Changes
                    </Button>
                ) : null}
                {canRejectSelected ? (
                    <Button
                      variant="outline"
                      onClick={() => handleReview('reject')}
                      className="border-red-300 text-red-700 hover:bg-red-50"
                      disabled={Boolean(reviewAction) || !reviewNotes.trim()}
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      Reject
                    </Button>
                ) : null}
                {canApproveSelected ? (
                  <Button
                    onClick={() => handleReview('approve')}
                    className="bg-green-600 hover:bg-green-700"
                    disabled={
                      Boolean(reviewAction)
                      || !reviewFulfillmentStoreId
                      || (selectedIsAreaReview && inventoryCheck.some((ingredient) => !ingredient.sufficient))
                    }
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    {reviewAction === 'approve'
                      ? 'Approving...'
                      : selectedIsAreaReview
                        ? 'Approve, Reserve Inventory & Mark Ready'
                        : 'Approve & Send to Store / Procurement'}
                  </Button>
                ) : null}
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(historyProduction)}
          onOpenChange={(open) => {
            if (!open) setHistoryProduction(null);
          }}
        >
          <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <History className="h-5 w-5" aria-hidden="true" />
                Production Approval History
              </DialogTitle>
            </DialogHeader>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <p className="font-medium text-slate-900">
                {historyProduction?.recipe_name || historyProduction?.name || 'Production request'}
              </p>
              <p className="mt-0.5 text-xs">
                {historyProduction?.site_name || 'Site not named'} · {historyProduction?.production_date || 'Date not set'}
              </p>
            </div>
            <ApprovalHistoryList production={historyProduction} />
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(inventoryAction)}
          onOpenChange={(open) => {
            if (!open) {
              setInventoryAction(null);
              setInventoryActionReason('');
              setInventoryActionServings(null);
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {inventoryActionMode === 'cancel'
                  ? 'Cancel Production & Release Reservation'
                  : 'Adjust Approved Production Reservation'}
              </DialogTitle>
            </DialogHeader>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              Area Manager approval reserves inventory without deducting physical stock. Before production starts, quantity changes adjust only the reservation and preserve the selected batch, stock-date, expiry, and cost trail.
            </div>
            {inventoryAction ? (
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <p className="font-semibold text-slate-900">{inventoryAction.recipe_name || 'Production request'}</p>
                <p className="text-slate-600">
                  Current approved quantity: {formatRecipeQuantity(inventoryAction.target_servings || 0, 'serving')} servings
                </p>
                <p className="text-xs text-slate-500">
                  Reservation revision {inventoryActionState.revision} · {inventoryActionState.label}
                </p>
              </div>
            ) : null}
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
            ) : null}
            {inventoryActionMode === 'adjust' ? (
              <div>
                <Label htmlFor="approved_target_servings">Revised production servings *</Label>
                <StandardDecimalInput
                  id="approved_target_servings"
                  value={inventoryActionServings}
                  min={0.001}
                  allowZero={false}
                  allowEmpty={false}
                  label="Revised production servings"
                  onValueChange={setInventoryActionServings}
                />
                <p className="mt-1 text-xs text-slate-500">
                  An increase reserves only the additional yield-adjusted ingredients; a reduction releases the difference back to available stock.
                </p>
                {inventoryActionPreview.length > 0 ? (
                  <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ingredient</TableHead>
                          <TableHead>Revised Required</TableHead>
                          <TableHead>Own Reservation</TableHead>
                          <TableHead>Free Available</TableHead>
                          <TableHead>Total Capacity</TableHead>
                          <TableHead>Reservation Change</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inventoryActionPreview.map((line) => (
                          <TableRow key={line.ingredient_id}>
                            <TableCell>
                              <p className="font-medium text-slate-900">{line.ingredient_name}</p>
                              <p className="font-mono text-xs text-slate-500">{line.item_code}</p>
                            </TableCell>
                            <TableCell>{formatRecipeQuantity(line.revised_required, line.unit)} {line.unit}</TableCell>
                            <TableCell className="text-violet-700">
                              {formatRecipeQuantity(line.own_reserved, line.unit)} {line.unit}
                            </TableCell>
                            <TableCell className="text-cyan-700">
                              {formatRecipeQuantity(line.free_available, line.unit)} {line.unit}
                            </TableCell>
                            <TableCell className="font-medium">
                              {formatRecipeQuantity(line.total_capacity, line.unit)} {line.unit}
                            </TableCell>
                            <TableCell>
                              {!line.sufficient ? (
                                <Badge className="bg-red-100 text-red-700">
                                  Short {formatRecipeQuantity(line.shortage, line.unit)} {line.unit}
                                </Badge>
                              ) : line.release_quantity > 0 ? (
                                <Badge className="bg-cyan-100 text-cyan-800">
                                  Release {formatRecipeQuantity(line.release_quantity, line.unit)} {line.unit}
                                </Badge>
                              ) : line.additional_reservation > 0 ? (
                                <Badge className="bg-violet-100 text-violet-800">
                                  Reserve {formatRecipeQuantity(line.additional_reservation, line.unit)} {line.unit}
                                </Badge>
                              ) : (
                                <Badge className="bg-slate-100 text-slate-700">No change</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
                {inventoryActionHasShortage ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                    The revised quantity exceeds free stock plus this production's own reservation. The request will remain blocked from starting until the shortage is reserved.
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                This cancels the request and releases all inventory reserved by this approval
                {inventoryActionReservedLineCount > 0 ? ` across ${inventoryActionReservedLineCount} ingredient line${inventoryActionReservedLineCount === 1 ? '' : 's'}` : ''}.
                {' '}No physical consumption is posted before production starts, and the release remains in the approval history.
              </div>
            )}
            <div>
              <Label htmlFor="inventory_action_reason">Reason *</Label>
              <Textarea
                id="inventory_action_reason"
                value={inventoryActionReason}
                onChange={(event) => setInventoryActionReason(event.target.value)}
                placeholder="Record why the approved quantity is changing"
                className="mt-1"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInventoryAction(null)}>Close</Button>
              <Button
                className={inventoryActionMode === 'cancel' ? 'bg-red-700 hover:bg-red-800' : 'bg-indigo-700 hover:bg-indigo-800'}
                disabled={
                  inventoryCommitmentMutation.isPending
                  || !inventoryActionReason.trim()
                  || (inventoryActionMode === 'adjust' && (!Number.isFinite(Number(inventoryActionServings)) || Number(inventoryActionServings) <= 0))
                }
                onClick={() => inventoryCommitmentMutation.mutate({
                  production: inventoryAction,
                  mode: inventoryActionMode,
                  targetServings: inventoryActionServings,
                  reason: inventoryActionReason.trim()
                })}
              >
                {inventoryCommitmentMutation.isPending
                  ? 'Reconciling...'
                  : inventoryActionMode === 'cancel'
                    ? 'Cancel & Release Reservation'
                    : 'Apply Quantity Change'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={completionOpen}
          onOpenChange={(open) => {
            setCompletionOpen(open);
            if (!open) {
              setCompletionProduction(null);
              setCompletionQuantities([]);
              setCompletionFulfillmentStoreId('');
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Complete Production & Reconcile Consumption</DialogTitle>
            </DialogHeader>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              Reserved inventory was physically deducted when production started. Confirm the actual raw quantity consumed for each ingredient; completion reconciles only the difference and creates one immutable Production Consumption Report without deducting the start quantity twice.
            </div>
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
            ) : null}
            <div>
              <Label htmlFor="completion_fulfillment_store">Inventory Fulfillment Store *</Label>
              <Select
                value={completionFulfillmentStoreId}
                onValueChange={(value) => {
                  setCompletionFulfillmentStoreId(value);
                  setActionError('');
                }}
                disabled={Boolean(completionProduction?.fulfillment_store_id) || completionStoreOptions.length === 0}
              >
                <SelectTrigger id="completion_fulfillment_store" className="mt-1">
                  <SelectValue placeholder={completionStoreOptions.length ? 'Select fulfillment store' : 'No accessible Store under this Project'} />
                </SelectTrigger>
                <SelectContent>
                  {completionStoreOptions.map((store) => (
                    <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!completionFulfillmentStoreId ? (
                <p className="mt-1 text-xs text-red-600">Select the Store whose inventory will be consumed.</p>
              ) : null}
            </div>
            <div className="rounded-lg border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item Code</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead>Yield-Adjusted Plan</TableHead>
                    <TableHead>Actual Consumed</TableHead>
                    <TableHead>Unit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {completionQuantities.map((line, index) => (
                    <TableRow key={line.ingredient_id || index}>
                      <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                      <TableCell className="font-medium">{line.ingredient_name}</TableCell>
                      <TableCell>{formatRecipeQuantity(line.planned_quantity, line.unit)} {line.unit}</TableCell>
                      <TableCell className="w-48">
                        <StandardDecimalInput
                          value={line.actual_quantity}
                          unit={line.unit}
                          min={0}
                          allowZero
                          allowEmpty={false}
                          label={`Actual consumption for ${line.ingredient_name}`}
                          onValueChange={(value) => setCompletionQuantities((current) => current.map((entry, entryIndex) => (
                            entryIndex === index ? { ...entry, actual_quantity: value } : entry
                          )))}
                        />
                      </TableCell>
                      <TableCell>{line.unit}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCompletionOpen(false)}>Cancel</Button>
              <Button
                className="bg-emerald-700 hover:bg-emerald-800"
                disabled={updateStatusMutation.isPending || !completionFulfillmentStoreId || completionQuantities.some((line) => !Number.isFinite(Number(line.actual_quantity)) || Number(line.actual_quantity) < 0)}
                onClick={() => updateStatusMutation.mutate({
                  id: completionProduction.id,
                  status: 'completed',
                  fulfillmentStoreId: completionFulfillmentStoreId,
                  ingredientQuantities: completionQuantities.map((line) => ({
                    ingredient_id: line.ingredient_id,
                    actual_quantity: Number(line.actual_quantity),
                    unit: line.unit
                  }))
                })}
              >
                {updateStatusMutation.isPending ? 'Posting...' : 'Post Consumption & Complete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(selectedConsumptionReport)}
          onOpenChange={(open) => {
            if (!open) setSelectedConsumptionReport(null);
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-emerald-700" />
                {selectedConsumptionReport?.report_name || 'Production Consumption Report'}
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="text-xs text-slate-500">Report Number</p><p className="font-semibold">{selectedConsumptionReport?.report_number}</p></div>
              <div><p className="text-xs text-slate-500">Project / Store</p><p className="font-semibold">{selectedConsumptionReport?.requesting_site_name || selectedConsumptionReport?.site_name} / {selectedConsumptionReport?.fulfillment_store_name || selectedConsumptionReport?.site_name}</p></div>
              <div><p className="text-xs text-slate-500">Completed By</p><p className="font-semibold">{selectedConsumptionReport?.completed_by_name || selectedConsumptionReport?.completed_by}</p></div>
              <div><p className="text-xs text-slate-500">Total Consumption Cost</p><p className="font-semibold text-emerald-700">{formatCurrency(selectedConsumptionReport?.total_consumption_cost || 0)}</p></div>
            </div>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Ingredient Consumption</h3>
              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Planned Raw</TableHead>
                      <TableHead>Actual Requested</TableHead>
                      <TableHead>Stock Issued</TableHead>
                      <TableHead>Shortage</TableHead>
                      <TableHead>Basis</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(selectedConsumptionReport?.ingredient_lines || []).map((line, index) => (
                      <TableRow key={`${line.ingredient_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell className="font-medium">{line.ingredient_name}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.planned_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.actual_requested_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.issued_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell className={Number(line.shortage_quantity) > 0 ? 'font-semibold text-red-600' : ''}>{formatRecipeQuantity(line.shortage_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{String(line.quantity_basis || '').replace(/_/g, ' ')}</TableCell>
                        <TableCell>{formatCurrency(line.posted_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Inventory Lots Consumed</h3>
              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Item Code</TableHead><TableHead>Item Name</TableHead><TableHead>Batch</TableHead><TableHead>Expiry</TableHead><TableHead>Quantity</TableHead><TableHead>Cost</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {((selectedConsumptionReport?.sections || []).find((section) => section.key === 'inventory_lot_usage')?.lines || []).map((line, index) => (
                      <TableRow key={`${line.inventory_lot_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell>{line.ingredient_name}</TableCell>
                        <TableCell>{line.batch_number || '—'}</TableCell>
                        <TableCell>{line.expiry_date || '—'}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatCurrency(line.total_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Shortages and Exceptions</h3>
              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Item Code</TableHead><TableHead>Item Name</TableHead><TableHead>Requested</TableHead><TableHead>Issued</TableHead><TableHead>Shortage</TableHead><TableHead>Estimated Shortage Cost</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {((selectedConsumptionReport?.sections || []).find((section) => section.key === 'shortages')?.lines || []).map((line, index) => (
                      <TableRow key={`${line.ingredient_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell>{line.ingredient_name}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.actual_requested_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.issued_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell className="font-semibold text-red-600">{formatRecipeQuantity(line.shortage_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatCurrency(line.estimated_shortage_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                    {((selectedConsumptionReport?.sections || []).find((section) => section.key === 'shortages')?.lines || []).length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-emerald-700">No shortages or consumption exceptions were posted.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </section>
          </DialogContent>
        </Dialog>
    </>
  );
}
