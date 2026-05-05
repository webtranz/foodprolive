import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Factory, AlertCircle, Download, CheckCircle2, XCircle } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';
import { usePermissions } from '@/components/auth/usePermissions';

const MEAL_TYPES = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' }
];

const STATUS_COLORS = {
  draft: 'bg-slate-100 text-slate-700',
  pending_approval: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  planned: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-purple-100 text-purple-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700'
};

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export default function Production() {
  const { can } = usePermissions();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [formData, setFormData] = useState({
    site_id: '',
    production_date: format(new Date(), 'yyyy-MM-dd'),
    meal_type: 'lunch',
    recipe_id: '',
    target_servings: '',
    notes: ''
  });
  const [calculatedIngredients, setCalculatedIngredients] = useState([]);
  const [inventoryCheck, setInventoryCheck] = useState([]);
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [selectedProduction, setSelectedProduction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [estimatedBatchCost, setEstimatedBatchCost] = useState(0);
  const [estimatedCostPerServing, setEstimatedCostPerServing] = useState(0);

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: productions = [], isLoading } = useQuery({
    queryKey: ['productions', selectedSite, selectedDate],
    queryFn: () => base44.entities.Production.list('-production_date', 100)
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Production.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      setFormOpen(false);
      setActionError('');
      resetForm();
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to create production plan');
    }
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status, production }) => {
      if (status === 'completed') {
        await base44.inventory.completeProduction(id);
        return;
      }

      await base44.entities.Production.update(id, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
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
      site_id: '',
      production_date: format(new Date(), 'yyyy-MM-dd'),
      meal_type: 'lunch',
      recipe_id: '',
      target_servings: '',
      notes: ''
    });
    setCalculatedIngredients([]);
  };

  // Calculate required ingredients and check inventory when recipe or servings change
  useEffect(() => {
    if (formData.recipe_id && formData.target_servings && formData.site_id) {
      const recipe = recipes.find(r => r.id === formData.recipe_id);
      if (recipe && recipe.ingredients && recipe.ingredients.length > 0) {
        const multiplier = recipe.servings > 0
          ? parseFloat(formData.target_servings) / recipe.servings
          : parseFloat(formData.target_servings) || 1;
        const siteInventory = inventory.filter(i => i.site_id === formData.site_id);
        
        const calculated = recipe.ingredients.map(ing => {
          const ingredientData = ingredients.find(i => i.id === ing.ingredient_id);
          const plannedQty = (ing.quantity || 0) * multiplier;
          const shrinkage = ingredientData?.shrinkage_percent || 0;
          const adjustedQty = plannedQty * (1 + shrinkage / 100);
          
          const invItem = siteInventory.find(i => i.ingredient_id === ing.ingredient_id);
          const currentStock = invItem?.quantity || 0;
          const shortage = Math.max(0, adjustedQty - currentStock);
          const unitCost = toNumber(ingredientData?.cost_per_unit, 0);
          const estimatedCost = adjustedQty * unitCost;
          
          return {
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            planned_quantity: Math.round(plannedQty * 100) / 100,
            adjusted_quantity: Math.round(adjustedQty * 100) / 100,
            current_stock: Math.round(currentStock * 100) / 100,
            shortage: Math.round(shortage * 100) / 100,
            unit: ing.unit,
            shrinkage_percent: shrinkage,
            sufficient: currentStock >= adjustedQty,
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

  const handleSubmit = (e) => {
    e.preventDefault();
    const site = sites.find(s => s.id === formData.site_id);
    const recipe = recipes.find(r => r.id === formData.recipe_id);
    
    const submitData = {
      ...formData,
      site_name: site?.name || '',
      recipe_name: recipe?.name || '',
      target_servings: parseInt(formData.target_servings) || 0,
      ingredients_used: calculatedIngredients.map(ing => ({
        ingredient_id: ing.ingredient_id,
        ingredient_name: ing.ingredient_name,
        planned_quantity: ing.adjusted_quantity,
        actual_quantity: null,
        unit: ing.unit,
        unit_cost: ing.unit_cost,
        estimated_cost: ing.estimated_cost
      })),
      total_calories: recipe?.calories_per_serving 
        ? recipe.calories_per_serving * parseInt(formData.target_servings)
        : 0,
      estimated_batch_cost: estimatedBatchCost,
      estimated_cost_per_serving: estimatedCostPerServing,
      status: 'pending_approval'
    };

    createMutation.mutate(submitData);
  };

  const handleApproval = async (approve) => {
    if (!selectedProduction) return;

    if (approve) {
      // Approve production
      await base44.entities.Production.update(selectedProduction.id, {
        status: 'approved'
      });

      // Check for shortages and create material request
      const shortages = inventoryCheck.filter(ing => !ing.sufficient);
      if (shortages.length > 0) {
        const site = sites.find(s => s.id === selectedProduction.site_id);
        
        const materialRequest = {
          request_number: `MR-PROD-${Date.now()}`,
          site_id: selectedProduction.site_id,
          site_name: site?.name,
          request_date: format(new Date(), 'yyyy-MM-dd'),
          period_start: selectedProduction.production_date,
          period_end: selectedProduction.production_date,
          items: shortages.map(ing => ({
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            required_quantity: ing.adjusted_quantity,
            current_stock: ing.current_stock,
            request_quantity: ing.shortage,
            unit: ing.unit,
            estimated_cost: 0,
            d365_item_code: `ITEM-${ing.ingredient_id?.substring(0, 8)}`
          })),
          total_estimated_cost: 0,
          status: 'pending_chef_approval',
          notes: `Auto-generated from production: ${selectedProduction.recipe_name}`
        };

        await base44.entities.MaterialRequest.create(materialRequest);
      }
    } else {
      // Reject production
      await base44.entities.Production.update(selectedProduction.id, {
        status: 'rejected'
      });
    }

    queryClient.invalidateQueries({ queryKey: ['productions'] });
    queryClient.invalidateQueries({ queryKey: ['materialRequests'] });
    setShowApprovalDialog(false);
    setSelectedProduction(null);
  };

  const openApprovalDialog = (production) => {
    const siteInventory = inventory.filter(i => i.site_id === production.site_id);
    
    const check = production.ingredients_used?.map(ing => {
      const invItem = siteInventory.find(i => i.ingredient_id === ing.ingredient_id);
      const currentStock = invItem?.quantity || 0;
      const shortage = Math.max(0, ing.planned_quantity - currentStock);
      
      return {
        ingredient_id: ing.ingredient_id,
        ingredient_name: ing.ingredient_name,
        adjusted_quantity: ing.planned_quantity,
        current_stock: Math.round(currentStock * 100) / 100,
        shortage: Math.round(shortage * 100) / 100,
        unit: ing.unit,
        sufficient: currentStock >= ing.planned_quantity
      };
    }) || [];
    
    setInventoryCheck(check);
    setSelectedProduction(production);
    setShowApprovalDialog(true);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Production" 
          description="Plan and track food production"
        >
          <Button 
            variant="outline"
            onClick={() => downloadCSV(filteredProductions, 'production')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            onClick={() => setFormOpen(true)}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Production
          </Button>
        </PageHeader>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div>
              <Label className="mb-1 block text-sm">Date</Label>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-[180px]"
              />
            </div>
            <div>
              <Label className="mb-1 block text-sm">Site</Label>
              <Select value={selectedSite} onValueChange={setSelectedSite}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sites</SelectItem>
                  {sites.map(site => (
                    <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Content */}
        {actionError ? (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {actionError}
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : filteredProductions.length === 0 ? (
          <EmptyState
            icon={Factory}
            title="No production planned"
            description="Start planning production for this date"
            actionLabel="New Production"
            onAction={() => setFormOpen(true)}
          />
        ) : (
          <div className="space-y-4">
            {filteredProductions.map(production => (
              <Card key={production.id} className="border-slate-100 shadow-sm">
                <CardContent className="p-6">
                  {(() => {
                    const totalCost = toNumber(
                      production.production_cost_total
                      ?? production.ingredient_cost_total
                      ?? production.estimated_batch_cost,
                      (production.ingredients_used || []).reduce((sum, ingredient) => sum + toNumber(ingredient.estimated_cost, 0), 0)
                    );
                    const servings = Math.max(1, toNumber(production.target_servings, 0));
                    const costPerServing = toNumber(
                      production.cost_per_serving ?? production.estimated_cost_per_serving,
                      totalCost / servings
                    );

                    return (
                      <>
                  <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center">
                        <Factory className="w-6 h-6 text-emerald-600" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-900">{production.recipe_name}</h3>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <Badge className={STATUS_COLORS[production.status]}>
                            {production.status?.replace(/_/g, ' ')}
                          </Badge>
                          <span className="text-sm text-slate-500">{production.site_name}</span>
                          <span className="text-sm text-slate-500">•</span>
                          <span className="text-sm text-slate-500 capitalize">{production.meal_type}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      <div className="text-center">
                        <p className="text-2xl font-bold text-slate-900">{production.target_servings}</p>
                        <p className="text-xs text-slate-500">Target</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-emerald-700">${totalCost.toFixed(2)}</p>
                        <p className="text-xs text-slate-500">{production.status === 'completed' ? 'Production Cost' : 'Est. Batch Cost'}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-slate-900">${costPerServing.toFixed(2)}</p>
                        <p className="text-xs text-slate-500">Cost / Serving</p>
                      </div>
                      {production.total_calories > 0 && (
                        <div className="text-center">
                          <p className="text-2xl font-bold text-orange-600">{production.total_calories}</p>
                          <p className="text-xs text-slate-500">Total Cal</p>
                        </div>
                      )}
                      <div className="flex gap-2">
                        {production.status === 'pending_approval' && can('approve_production') && (
                          <Button 
                            size="sm" 
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => openApprovalDialog(production)}
                          >
                            Review & Approve
                          </Button>
                        )}
                        {production.status === 'approved' && can('manage_production') && (
                          <Button 
                            size="sm" 
                            variant="outline"
                            onClick={() => updateStatusMutation.mutate({ 
                              id: production.id, 
                              status: 'in_progress',
                              production 
                            })}
                          >
                            Start Production
                          </Button>
                        )}
                        {['approved', 'in_progress'].includes(production.status) && can('complete_production') && (
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
                            {updateStatusMutation.isPending ? 'Completing...' : production.status === 'approved' ? 'Complete Batch' : 'Complete'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>

                  {production.ingredients_used && production.ingredients_used.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <p className="text-sm font-medium text-slate-700 mb-2">Required Ingredients:</p>
                      <div className="flex flex-wrap gap-2">
                        {production.ingredients_used.map((ing, idx) => (
                          <Badge key={idx} variant="outline" className="font-normal">
                            {ing.ingredient_name}: {ing.planned_quantity} {ing.unit} {toNumber(ing.estimated_cost, 0) > 0 ? `• $${toNumber(ing.estimated_cost, 0).toFixed(2)}` : ''}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                      </>
                    );
                  })()}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Form Dialog */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Plan New Production</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="site">Site *</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData({ ...formData, site_id: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {sites.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="date">Production Date *</Label>
                  <Input
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
                    <SelectTrigger className="mt-1">
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
                    onValueChange={(value) => setFormData({ ...formData, recipe_id: value })}
                  >
                    <SelectTrigger className="mt-1">
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

                <div className="col-span-2">
                  <Label htmlFor="servings">Target Servings *</Label>
                  <Input
                    type="number"
                    min="1"
                    value={formData.target_servings}
                    onChange={(e) => setFormData({ ...formData, target_servings: e.target.value })}
                    placeholder="Number of servings to produce"
                    className="mt-1"
                    required
                  />
                </div>
              </div>

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
                      <p className="mt-1 text-2xl font-bold text-emerald-700">${estimatedBatchCost.toFixed(2)}</p>
                    </div>
                    <div className="rounded-lg bg-white px-4 py-3 border border-blue-100">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Estimated Cost / Serving</p>
                      <p className="mt-1 text-2xl font-bold text-slate-900">${estimatedCostPerServing.toFixed(2)}</p>
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
                          <TableCell>${toNumber(ing.unit_cost, 0).toFixed(2)}</TableCell>
                          <TableCell>${toNumber(ing.estimated_cost, 0).toFixed(2)}</TableCell>
                          <TableCell>{ing.current_stock} {ing.unit}</TableCell>
                          <TableCell>
                            {ing.sufficient ? (
                              <Badge className="bg-green-600">Sufficient</Badge>
                            ) : (
                              <Badge className="bg-red-600">Short {ing.shortage} {ing.unit}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {calculatedIngredients.some(ing => !ing.sufficient) && (
                    <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-sm text-amber-800">
                        <strong>Note:</strong> Material request will be auto-generated after approval for insufficient items
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea
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
                  type="submit" 
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? 'Creating...' : 'Create Production'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Approval Dialog */}
        <Dialog open={showApprovalDialog} onOpenChange={setShowApprovalDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Approve Production Plan</DialogTitle>
            </DialogHeader>
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
                        <TableCell>{ing.current_stock} {ing.unit}</TableCell>
                        <TableCell>
                          {ing.sufficient ? (
                            <Badge className="bg-green-600">✓ OK</Badge>
                          ) : (
                            <Badge className="bg-red-600">Short {ing.shortage} {ing.unit}</Badge>
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
                      <p className="font-medium text-amber-900">Material Request Required</p>
                      <p className="text-sm text-amber-700 mt-1">
                        Upon approval, a material request will be automatically created for {inventoryCheck.filter(ing => !ing.sufficient).length} ingredient(s) and sent for procurement.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button 
                  variant="outline" 
                  onClick={() => handleApproval(false)}
                  className="border-red-300 text-red-700 hover:bg-red-50"
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  Reject
                </Button>
                <Button 
                  onClick={() => handleApproval(true)}
                  className="bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Approve & Create MR
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
