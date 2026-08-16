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
import { AlertCircle, CheckCircle2, XCircle, Brain } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { format } from 'date-fns';
import { usePermissions } from '@/components/auth/usePermissions';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { formatCurrency } from '@/lib/currency';
import { buildProductionPlanExportRows } from '@/lib/productionPlanning';
import {
  calculateIngredientCost,
  convertIngredientQuantity
} from '../../shared/ingredientUnits.js';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';

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

export default function Production() {
  const { can } = usePermissions();
  const { allowedSiteIds, isAdmin, siteId: assignedSiteId } = useSiteContext();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [formData, setFormData] = useState({
    site_id: '',
    production_date: format(new Date(), 'yyyy-MM-dd'),
    meal_type: 'lunch',
    recipe_id: '',
    target_servings: '',
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
    queryKey: ['productions', selectedSite, selectedDate],
    queryFn: () => base44.entities.Production.filter({
      production_date: selectedDate,
      ...(selectedSite && selectedSite !== 'all' ? { site_id: selectedSite } : {})
    }, '-production_date'),
    enabled: Boolean(selectedDate),
    refetchInterval: 30000
  });

  const { data: productionHistory = [] } = useQuery({
    queryKey: ['productionHistoryForWasteInsights'],
    queryFn: () => base44.entities.Production.list('-production_date', 1000)
  });

  const { data: materialRequests = [], error: materialRequestsError } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list(),
    refetchInterval: 30000
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWasteForProduction'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 1000)
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
    queryFn: () => base44.entities.Inventory.list(),
    refetchInterval: 30000
  });

  const visibleSites = useMemo(() => (
    isAdmin
      ? sites
      : sites.filter((site) => allowedSiteIds.includes(site.id))
  ), [allowedSiteIds, isAdmin, sites]);

  useEffect(() => {
    if (isAdmin) {
      return;
    }

    const fallbackSiteId = assignedSiteId || visibleSites[0]?.id || '';
    setSelectedSite((current) => (current === 'all' || !current ? fallbackSiteId : current));
    setFormData((current) => ({
      ...current,
      site_id: current.site_id || fallbackSiteId
    }));
  }, [isAdmin, assignedSiteId, visibleSites]);

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }) => {
      if (status === 'completed') {
        await base44.inventory.completeProduction(id);
        return;
      }

      await base44.entities.Production.update(id, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      setActionError('');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to update production status');
    }
  });

  const resetForm = () => {
    setFormData({
      site_id: isAdmin ? '' : (assignedSiteId || visibleSites[0]?.id || ''),
      production_date: format(new Date(), 'yyyy-MM-dd'),
      meal_type: 'lunch',
      recipe_id: '',
      target_servings: '',
      kitchen_station: '',
      notes: ''
    });
    setEditingProduction(null);
    setCalculatedIngredients([]);
    setInventoryCheck([]);
    setEstimatedBatchCost(0);
    setEstimatedCostPerServing(0);
  };

  // Calculate required ingredients and check inventory when recipe or servings change
  useEffect(() => {
    if (formData.recipe_id && formData.target_servings && formData.site_id) {
      const recipe = recipes.find(r => r.id === formData.recipe_id);
      const hasRecipeComponents = recipe
        && ((Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0)
          || (Array.isArray(recipe.sub_recipes) && recipe.sub_recipes.length > 0));
      if (hasRecipeComponents) {
        const multiplier = recipe.servings > 0
          ? parseFloat(formData.target_servings) / recipe.servings
          : parseFloat(formData.target_servings) || 1;
        const siteInventory = inventory.filter(i => i.site_id === formData.site_id);
        const expandedRecipe = expandRecipeIngredients(
          recipe,
          recipes,
          ingredients,
          { multiplier, aggregate: true }
        );
        
        const calculated = expandedRecipe.ingredients.map(ing => {
          const ingredientData = ingredients.find(i => i.id === ing.ingredient_id);
          const plannedQty = ing.quantity || 0;
          const shrinkage = ingredientData?.shrinkage_percent || 0;
          const adjustedQty = plannedQty * (1 + shrinkage / 100);
          
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
          const currentStock = invItem?.quantity || 0;
          const shortage = Math.max(0, requiredInventoryQty - currentStock);
          const unitCost = toNumber(ingredientData?.cost_per_unit, 0);
          const estimatedCost = calculateIngredientCost(adjustedQty, ing.unit, ingredientData, unitCost);
          
          return {
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            source_recipe_names: ing.source_recipe_names || [],
            planned_quantity: Math.round(plannedQty * 100) / 100,
            adjusted_quantity: Math.round(adjustedQty * 100) / 100,
            current_stock: Math.round(currentStock * 100) / 100,
            shortage: Math.round(shortage * 100) / 100,
            unit: ing.unit,
            inventory_unit: inventoryUnit,
            cost_quantity: Number(costQuantity.toFixed(4)),
            cost_unit: costUnit,
            shrinkage_percent: shrinkage,
            sufficient: currentStock >= requiredInventoryQty,
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
  }, [formData.recipe_id, formData.target_servings, formData.site_id, recipes, ingredients, inventory]);

  const filteredProductions = productions.filter(p => {
    const matchesSite = selectedSite === 'all' || p.site_id === selectedSite;
    const matchesDate = p.production_date === selectedDate;
    return matchesSite && matchesDate;
  });

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
    const recipe = recipes.find(r => r.id === formData.recipe_id);

    return {
      ...formData,
      site_name: site?.name || '',
      recipe_name: recipe?.name || '',
      target_servings: parseInt(formData.target_servings) || 0,
      ingredients_used: calculatedIngredients.map(ing => ({
        ingredient_id: ing.ingredient_id,
        ingredient_name: ing.ingredient_name,
        source_recipe_names: ing.source_recipe_names,
        planned_quantity: ing.adjusted_quantity,
        actual_quantity: null,
        unit: ing.unit,
        cost_quantity: ing.cost_quantity,
        cost_unit: ing.cost_unit,
        unit_cost: ing.unit_cost,
        estimated_cost: ing.estimated_cost
      })),
      total_calories: recipe?.calories_per_serving 
        ? recipe.calories_per_serving * parseInt(formData.target_servings)
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
    if (!formData.site_id || !formData.production_date || !formData.recipe_id || !formData.kitchen_station.trim()) {
      setActionError('Complete the site, production date, recipe, servings, and kitchen station before saving.');
      return;
    }
    setActionError('');
    createMutation.mutate(buildSubmitData(status));
  };

  const handleReview = async (action) => {
    if (!selectedProduction) return;

    try {
      const status = action === 'approve'
        ? 'approved'
        : action === 'request_changes'
          ? 'changes_requested'
          : 'rejected';
      await base44.entities.Production.update(selectedProduction.id, {
        status,
        review_notes: reviewNotes || null,
        reviewed_at: new Date().toISOString()
      });
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      setShowApprovalDialog(false);
      setSelectedProduction(null);
      setReviewNotes('');
      setActionError('');
    } catch (error) {
      setActionError(error.message || 'Unable to review the production request.');
    }
  };

  const openApprovalDialog = (production) => {
    const siteInventory = inventory.filter(i => i.site_id === production.site_id);
    
    const check = production.ingredients_used?.map(ing => {
      const invItem = siteInventory.find(i => i.ingredient_id === ing.ingredient_id);
      const ingredientData = ingredients.find((ingredient) => ingredient.id === ing.ingredient_id);
      const inventoryUnit = invItem?.unit || ingredientData?.unit || ing.unit;
      const requiredQuantity = convertIngredientQuantity(
        ing.actual_quantity ?? ing.planned_quantity ?? ing.adjusted_quantity ?? 0,
        ing.unit || inventoryUnit,
        inventoryUnit,
        ingredientData
      );
      const currentStock = toNumber(invItem?.quantity, 0);
      const shortage = Math.max(0, requiredQuantity - currentStock);
      
      return {
        ingredient_id: ing.ingredient_id,
        ingredient_name: ing.ingredient_name,
        adjusted_quantity: Math.round(requiredQuantity * 100) / 100,
        current_stock: Math.round(currentStock * 100) / 100,
        shortage: Math.round(shortage * 100) / 100,
        unit: inventoryUnit,
        inventory_unit: inventoryUnit,
        sufficient: currentStock >= requiredQuantity
      };
    }) || [];
    
    setInventoryCheck(check);
    setActionError('');
    setSelectedProduction(production);
    setReviewNotes(production.review_notes || '');
    setShowApprovalDialog(true);
  };

  const openEditDialog = (production) => {
    setActionError('');
    setEditingProduction(production);
    setFormData({
      site_id: production.site_id || '',
      production_date: production.production_date || format(new Date(), 'yyyy-MM-dd'),
      meal_type: production.meal_type || 'lunch',
      recipe_id: production.recipe_id || '',
      target_servings: String(production.target_servings || ''),
      kitchen_station: production.kitchen_station || production.assigned_station || production.station || '',
      notes: production.notes || ''
    });
    setFormOpen(true);
  };

  const canStartWithMaterialRequest = (linkedMaterialRequest) => {
    if (!linkedMaterialRequest) return false;
    return String(linkedMaterialRequest.status || '').toLowerCase() === 'acknowledged';
  };

  const renderProductionActions = (production, linkedMaterialRequest) => (
    <div className="flex flex-wrap gap-2">
      {['draft', 'changes_requested'].includes(production.status) && can('edit_production_request') ? (
        <Button size="sm" variant="outline" onClick={() => openEditDialog(production)}>
          Edit Request
        </Button>
      ) : null}
      {['draft', 'changes_requested'].includes(production.status) && can('submit_production_request') ? (
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
          Submit for Approval
        </Button>
      ) : null}
      {production.status === 'pending_approval' && can('review_production_request') ? (
        <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => openApprovalDialog(production)}>
          Review Request
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
          disabled={!canStartWithMaterialRequest(linkedMaterialRequest) || updateStatusMutation.isPending}
        >
          Start Production
        </Button>
      ) : null}
      {production.status === 'in_progress' && can('complete_production') ? (
        <Button
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700"
          onClick={() => updateStatusMutation.mutate({
            id: production.id,
            status: 'completed',
            production
          })}
          disabled={updateStatusMutation.isPending}
        >
          {updateStatusMutation.isPending ? 'Completing...' : 'Complete'}
        </Button>
      ) : null}
    </div>
  );

  const loadError = actionError
    || productionsError?.message
    || sitesError?.message
    || recipesError?.message
    || ingredientsError?.message
    || inventoryError?.message
    || materialRequestsError?.message
    || '';
  const siteOptions = isAdmin
    ? [{ id: 'all', name: 'All Sites' }, ...visibleSites]
    : visibleSites;

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
            site_id: selectedSite === 'all' ? '' : selectedSite
          }));
          setFormOpen(true);
        }}
        onExport={(dashboard) => downloadCSV(
          buildProductionPlanExportRows(dashboard),
          `production_plan_${selectedDate}`
        )}
        onPrint={() => window.print()}
        renderActions={renderProductionActions}
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
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
                  <Label htmlFor="site">Project / Site *</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData({ ...formData, site_id: value })}
                  >
                    <SelectTrigger id="site" className="mt-1">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {visibleSites.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  <Input
                    id="servings"
                    type="number"
                    min="1"
                    value={formData.target_servings}
                    onChange={(e) => setFormData({ ...formData, target_servings: e.target.value })}
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
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Required</TableHead>
                        <TableHead>Unit Cost</TableHead>
                        <TableHead>Est. Cost</TableHead>
                        <TableHead>In Stock</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {calculatedIngredients.map((ing, idx) => (
                        <TableRow key={idx}>
                          <TableCell>{ing.ingredient_name}</TableCell>
                          <TableCell className="font-medium">{ing.adjusted_quantity} {ing.unit}</TableCell>
                          <TableCell>{formatCurrency(toNumber(ing.unit_cost, 0))} / {ing.cost_unit}</TableCell>
                          <TableCell>{formatCurrency(toNumber(ing.estimated_cost, 0))}</TableCell>
                          <TableCell>{ing.current_stock} {ing.inventory_unit}</TableCell>
                          <TableCell>
                            {ing.sufficient ? (
                              <Badge className="bg-green-600">Sufficient</Badge>
                            ) : (
                              <Badge className="bg-red-600">Short {ing.shortage} {ing.inventory_unit}</Badge>
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
            setShowApprovalDialog(open);
            if (!open) setActionError('');
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review Production Request</DialogTitle>
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
                  <p>Servings: {selectedProduction?.target_servings}</p>
                </div>
              </div>

              <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
                <h4 className="font-medium text-blue-900 mb-3">Inventory Check</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ingredient</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>In Stock</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventoryCheck.map((ing, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{ing.ingredient_name}</TableCell>
                        <TableCell>{ing.adjusted_quantity} {ing.unit}</TableCell>
                        <TableCell>{ing.current_stock} {ing.inventory_unit}</TableCell>
                        <TableCell>
                          {ing.sufficient ? (
                            <Badge className="bg-green-600">✓ OK</Badge>
                          ) : (
                            <Badge className="bg-red-600">Short {ing.shortage} {ing.inventory_unit}</Badge>
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
                      <p className="font-medium text-amber-900">Material Request Required After Approval</p>
                      <p className="text-sm text-amber-700 mt-1">
                        Once the manager approves this production request, the linked material request moves to procurement for acknowledgement. After procurement acknowledges it, the chef can start production.
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
                <Button 
                  variant="outline" 
                  onClick={() => handleReview('request_changes')}
                  className="border-amber-300 text-amber-700 hover:bg-amber-50"
                >
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Request Changes
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => handleReview('reject')}
                  className="border-red-300 text-red-700 hover:bg-red-50"
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  Reject
                </Button>
                <Button 
                  onClick={() => handleReview('approve')}
                  className="bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Approve Request
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
    </>
  );
}
