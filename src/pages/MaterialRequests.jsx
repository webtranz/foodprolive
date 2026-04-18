import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  FileText, 
  Plus, 
  CheckCircle2, 
  XCircle, 
  Send, 
  Loader2,
  AlertTriangle,
  ArrowRight
} from 'lucide-react';
import { format, addDays } from 'date-fns';

const STATUS_CONFIG = {
  draft: { color: 'bg-slate-500', label: 'Draft' },
  pending_chef_approval: { color: 'bg-amber-500', label: 'Pending Chef Approval' },
  chef_approved: { color: 'bg-green-500', label: 'Chef Approved' },
  chef_rejected: { color: 'bg-red-500', label: 'Chef Rejected' },
  pending_pm_approval: { color: 'bg-blue-500', label: 'Pending PM Approval' },
  pm_approved: { color: 'bg-green-600', label: 'PM Approved' },
  pm_rejected: { color: 'bg-red-600', label: 'PM Rejected' },
  sent_to_d365: { color: 'bg-indigo-500', label: 'Sent to D365' },
  d365_pr_created: { color: 'bg-purple-600', label: 'D365 PR Created' },
  completed: { color: 'bg-emerald-600', label: 'Completed' }
};

export default function MaterialRequests() {
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generationForm, setGenerationForm] = useState({
    siteId: '',
    periodStart: format(new Date(), 'yyyy-MM-dd'),
    periodEnd: format(addDays(new Date(), 7), 'yyyy-MM-dd')
  });
  const [approvalForm, setApprovalForm] = useState({
    action: 'approve',
    notes: ''
  });

  const queryClient = useQueryClient();

  const { data: materialRequests = [] } = useQuery({
    queryKey: ['materialRequests'],
    queryFn: () => base44.entities.MaterialRequest.list('-request_date', 100)
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: menuPlans = [] } = useQuery({
    queryKey: ['menuPlans'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 100)
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me()
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.MaterialRequest.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materialRequests'] });
      setShowGenerateDialog(false);
      setGenerating(false);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.MaterialRequest.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materialRequests'] });
      setShowApprovalDialog(false);
      setSelectedRequest(null);
    }
  });

  const generateRequest = async () => {
    setGenerating(true);
    try {
      const site = sites.find(s => s.id === generationForm.siteId);
      const startDate = new Date(generationForm.periodStart);
      const endDate = new Date(generationForm.periodEnd);

      // Get menu plans for the period
      const relevantMenus = menuPlans.filter(m => {
        const planDate = new Date(m.plan_date);
        return m.site_id === generationForm.siteId && 
               planDate >= startDate && 
               planDate <= endDate;
      });

      // Calculate required ingredients from menu plans
      const ingredientRequirements = {};
      
      relevantMenus.forEach(menu => {
        menu.meals?.forEach(meal => {
          const recipe = recipes.find(r => r.id === meal.recipe_id);
          if (recipe?.ingredients) {
            recipe.ingredients.forEach(ing => {
              const key = ing.ingredient_id;
              if (!ingredientRequirements[key]) {
                ingredientRequirements[key] = {
                  ingredient_id: ing.ingredient_id,
                  ingredient_name: ing.ingredient_name,
                  required_quantity: 0,
                  unit: ing.unit
                };
              }
              const multiplier = meal.expected_servings / recipe.servings;
              ingredientRequirements[key].required_quantity += ing.quantity * multiplier;
            });
          }
        });
      });

      // Get current stock
      const siteInventory = inventory.filter(i => i.site_id === generationForm.siteId);
      
      // Calculate request quantities
      const items = Object.values(ingredientRequirements).map(req => {
        const inv = siteInventory.find(i => i.ingredient_id === req.ingredient_id);
        const currentStock = inv?.quantity || 0;
        const requestQty = Math.max(0, req.required_quantity - currentStock);
        
        const ingredient = ingredients.find(i => i.id === req.ingredient_id);
        const estimatedCost = requestQty * (ingredient?.cost_per_unit || 0);

        return {
          ...req,
          current_stock: currentStock,
          request_quantity: requestQty,
          estimated_cost: estimatedCost,
          d365_item_code: `ITEM-${req.ingredient_id?.substring(0, 8)}`
        };
      }).filter(item => item.request_quantity > 0);

      const totalCost = items.reduce((sum, item) => sum + item.estimated_cost, 0);

      const newRequest = {
        request_number: `MR-${Date.now()}`,
        site_id: generationForm.siteId,
        site_name: site.name,
        request_date: format(new Date(), 'yyyy-MM-dd'),
        period_start: generationForm.periodStart,
        period_end: generationForm.periodEnd,
        menu_plan_ids: relevantMenus.map(m => m.id),
        items,
        total_estimated_cost: totalCost,
        status: 'pending_chef_approval'
      };

      await createMutation.mutateAsync(newRequest);
    } catch (err) {
      console.error('Generation error:', err);
    } finally {
      setGenerating(false);
    }
  };

  const handleApproval = async () => {
    if (!selectedRequest) return;

    const updates = {};
    const now = new Date().toISOString();

    if (selectedRequest.status === 'pending_chef_approval') {
      if (approvalForm.action === 'approve') {
        updates.status = 'pending_pm_approval';
        updates.chef_approved = true;
        updates.chef_approval_by = user?.email;
        updates.chef_approval_date = now;
        updates.chef_notes = approvalForm.notes;
      } else {
        updates.status = 'chef_rejected';
        updates.chef_notes = approvalForm.notes;
      }
    } else if (selectedRequest.status === 'pending_pm_approval') {
      if (approvalForm.action === 'approve') {
        updates.status = 'pm_approved';
        updates.pm_approval_by = user?.email;
        updates.pm_approval_date = now;
        updates.pm_notes = approvalForm.notes;
      } else {
        updates.status = 'pm_rejected';
        updates.pm_notes = approvalForm.notes;
      }
    }

    await updateMutation.mutateAsync({
      id: selectedRequest.id,
      data: updates
    });
  };

  const sendToD365 = async (request) => {
    await updateMutation.mutateAsync({
      id: request.id,
      data: {
        status: 'sent_to_d365',
        d365_sync_status: 'synced',
        d365_sync_date: new Date().toISOString(),
        d365_pr_number: `PR-D365-${Date.now()}`
      }
    });
  };

  const openApprovalDialog = (request) => {
    setSelectedRequest(request);
    setApprovalForm({ action: 'approve', notes: '' });
    setShowApprovalDialog(true);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Material Requests" 
          description="Generate and manage material requests with D365 integration"
        >
          <Button onClick={() => setShowGenerateDialog(true)} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" />
            Generate Request
          </Button>
        </PageHeader>

        <div className="grid gap-4">
          {materialRequests.map(request => (
            <Card key={request.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-3">
                      <FileText className="w-5 h-5 text-indigo-600" />
                      {request.request_number}
                      <Badge className={STATUS_CONFIG[request.status]?.color}>
                        {STATUS_CONFIG[request.status]?.label}
                      </Badge>
                    </CardTitle>
                    <p className="text-sm text-slate-600 mt-1">
                      {request.site_name} • {format(new Date(request.period_start), 'MMM d')} - {format(new Date(request.period_end), 'MMM d, yyyy')}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-slate-900">
                      ${request.total_estimated_cost?.toFixed(2)}
                    </p>
                    <p className="text-xs text-slate-500">{request.items?.length} items</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {/* Approval Timeline */}
                <div className="flex items-center gap-2 mb-4">
                  <div className={`flex items-center gap-2 ${request.chef_approval_date ? 'text-green-600' : 'text-slate-400'}`}>
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-xs font-medium">Chef Approval</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-300" />
                  <div className={`flex items-center gap-2 ${request.pm_approval_date ? 'text-green-600' : 'text-slate-400'}`}>
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-xs font-medium">PM Approval</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-300" />
                  <div className={`flex items-center gap-2 ${request.d365_pr_number ? 'text-purple-600' : 'text-slate-400'}`}>
                    <Send className="w-4 h-4" />
                    <span className="text-xs font-medium">D365 PR</span>
                  </div>
                </div>

                {/* Items Preview */}
                <div className="bg-slate-50 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-slate-700 mb-2">Top Items:</p>
                  <div className="space-y-1">
                    {request.items?.slice(0, 3).map((item, idx) => (
                      <div key={idx} className="flex justify-between text-xs">
                        <span className="text-slate-600">{item.ingredient_name}</span>
                        <span className="font-medium">{item.request_quantity} {item.unit}</span>
                      </div>
                    ))}
                    {request.items?.length > 3 && (
                      <p className="text-xs text-slate-500">+{request.items.length - 3} more items</p>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {(request.status === 'pending_chef_approval' || request.status === 'pending_pm_approval') && (
                    <Button 
                      size="sm" 
                      onClick={() => openApprovalDialog(request)}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Review & Approve
                    </Button>
                  )}
                  
                  {request.status === 'pm_approved' && !request.d365_pr_number && (
                    <Button 
                      size="sm"
                      onClick={() => sendToD365(request)}
                      disabled={updateMutation.isPending}
                      className="bg-indigo-600 hover:bg-indigo-700"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      Send to D365
                    </Button>
                  )}

                  {request.d365_pr_number && (
                    <Badge variant="outline" className="text-purple-600 border-purple-300">
                      D365 PR: {request.d365_pr_number}
                    </Badge>
                  )}
                </div>

                {/* Notes */}
                {(request.chef_notes || request.pm_notes) && (
                  <div className="mt-3 space-y-2">
                    {request.chef_notes && (
                      <Alert className="py-2">
                        <AlertDescription className="text-xs">
                          <span className="font-medium">Chef Notes:</span> {request.chef_notes}
                        </AlertDescription>
                      </Alert>
                    )}
                    {request.pm_notes && (
                      <Alert className="py-2">
                        <AlertDescription className="text-xs">
                          <span className="font-medium">PM Notes:</span> {request.pm_notes}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Generate Dialog */}
        <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Generate Material Request</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Site</Label>
                <Select 
                  value={generationForm.siteId} 
                  onValueChange={(v) => setGenerationForm({ ...generationForm, siteId: v })}
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Period Start</Label>
                  <Input
                    type="date"
                    value={generationForm.periodStart}
                    onChange={(e) => setGenerationForm({ ...generationForm, periodStart: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Period End</Label>
                  <Input
                    type="date"
                    value={generationForm.periodEnd}
                    onChange={(e) => setGenerationForm({ ...generationForm, periodEnd: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <Alert>
                <AlertTriangle className="w-4 h-4" />
                <AlertDescription>
                  This will analyze menu plans, calculate required ingredients, and evaluate current stock levels.
                </AlertDescription>
              </Alert>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={generateRequest}
                  disabled={!generationForm.siteId || generating}
                  className="bg-indigo-600 hover:bg-indigo-700"
                >
                  {generating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-2" />
                      Generate Request
                    </>
                  )}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Approval Dialog */}
        <Dialog open={showApprovalDialog} onOpenChange={setShowApprovalDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {selectedRequest?.status === 'pending_chef_approval' ? 'Chef Approval' : 'Project Manager Approval'}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm font-medium mb-2">Request Summary</p>
                <div className="space-y-1 text-sm text-slate-600">
                  <p>Request: {selectedRequest?.request_number}</p>
                  <p>Total Cost: ${selectedRequest?.total_estimated_cost?.toFixed(2)}</p>
                  <p>Items: {selectedRequest?.items?.length}</p>
                </div>
              </div>

              <div>
                <Label>Action</Label>
                <Select 
                  value={approvalForm.action} 
                  onValueChange={(v) => setApprovalForm({ ...approvalForm, action: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="approve">Approve</SelectItem>
                    <SelectItem value="reject">Reject</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Notes / Modifications</Label>
                <Textarea
                  value={approvalForm.notes}
                  onChange={(e) => setApprovalForm({ ...approvalForm, notes: e.target.value })}
                  placeholder="Add any notes or modifications..."
                  className="mt-1"
                  rows={3}
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowApprovalDialog(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleApproval}
                  disabled={updateMutation.isPending}
                  className={approvalForm.action === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : approvalForm.action === 'approve' ? (
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                  ) : (
                    <XCircle className="w-4 h-4 mr-2" />
                  )}
                  {approvalForm.action === 'approve' ? 'Approve' : 'Reject'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}