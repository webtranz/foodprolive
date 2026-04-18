import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Database, 
  RefreshCw, 
  CheckCircle2,
  Link as LinkIcon,
  AlertTriangle,
  Package
} from 'lucide-react';
import { format } from 'date-fns';

export default function D365Integration() {
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [linkForm, setLinkForm] = useState({
    ingredientId: '',
    d365ItemCode: '',
    d365ItemName: '',
    warehouseCode: '',
    projectCode: ''
  });

  const queryClient = useQueryClient();

  const { data: d365Masters = [] } = useQuery({
    queryKey: ['d365Masters'],
    queryFn: () => base44.entities.D365Master.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: materialRequests = [] } = useQuery({
    queryKey: ['materialRequests'],
    queryFn: () => base44.entities.MaterialRequest.list('-request_date', 50)
  });

  const createLinkMutation = useMutation({
    mutationFn: (data) => base44.entities.D365Master.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['d365Masters'] });
      setShowLinkDialog(false);
      setLinkForm({
        ingredientId: '',
        d365ItemCode: '',
        d365ItemName: '',
        warehouseCode: '',
        projectCode: ''
      });
    }
  });

  const syncFromD365 = async () => {
    setSyncing(true);
    // Simulate D365 sync
    await new Promise(resolve => setTimeout(resolve, 2000));
    queryClient.invalidateQueries({ queryKey: ['d365Masters'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    setSyncing(false);
  };

  const linkedIngredients = ingredients.filter(ing => 
    d365Masters.some(m => m.ingredient_id === ing.id)
  );

  const unlinkedIngredients = ingredients.filter(ing => 
    !d365Masters.some(m => m.ingredient_id === ing.id)
  );

  const pendingD365Requests = materialRequests.filter(r => 
    r.status === 'pm_approved' || r.status === 'sent_to_d365'
  );

  const stats = {
    linkedItems: linkedIngredients.length,
    totalItems: ingredients.length,
    pendingRequests: pendingD365Requests.length,
    lastSync: d365Masters[0]?.last_sync_date
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto">
        <PageHeader 
          title="D365 Integration" 
          description="Manage Dynamics 365 master data synchronization"
        >
          <Button 
            onClick={syncFromD365}
            disabled={syncing}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync from D365'}
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Linked Items</p>
                  <p className="text-2xl font-bold text-slate-900">{stats.linkedItems}/{stats.totalItems}</p>
                </div>
                <LinkIcon className="w-8 h-8 text-indigo-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Pending D365 PRs</p>
                  <p className="text-2xl font-bold text-slate-900">{stats.pendingRequests}</p>
                </div>
                <Package className="w-8 h-8 text-amber-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Sync Status</p>
                  <p className="text-sm font-medium text-green-600">Connected</p>
                </div>
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Last Sync</p>
                  <p className="text-sm font-medium text-slate-900">
                    {stats.lastSync ? format(new Date(stats.lastSync), 'MMM d, HH:mm') : 'Never'}
                  </p>
                </div>
                <Database className="w-8 h-8 text-blue-600" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Warnings */}
        {unlinkedIngredients.length > 0 && (
          <Alert className="mb-6 border-amber-200 bg-amber-50">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <AlertDescription>
              <span className="font-medium text-amber-900">
                {unlinkedIngredients.length} ingredients not linked to D365
              </span>
              <p className="text-sm text-amber-700 mt-1">
                Link ingredients to D365 items for automatic procurement integration
              </p>
            </AlertDescription>
          </Alert>
        )}

        {/* Linked Items */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>D365 Master Data Links</CardTitle>
              <Button 
                size="sm"
                onClick={() => setShowLinkDialog(true)}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                <LinkIcon className="w-4 h-4 mr-2" />
                Link Ingredient
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {d365Masters.map(master => {
                const ingredient = ingredients.find(i => i.id === master.ingredient_id);
                return (
                  <div key={master.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div>
                      <p className="font-medium text-sm">{ingredient?.name || 'Unknown'}</p>
                      <p className="text-xs text-slate-600">
                        D365: {master.d365_item_code} • Warehouse: {master.warehouse_code || 'N/A'} • Project: {master.project_code || 'N/A'}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-green-600 border-green-300">
                      Linked
                    </Badge>
                  </div>
                );
              })}
              {d365Masters.length === 0 && (
                <p className="text-center text-slate-500 py-8">No D365 links configured</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Pending D365 Requests */}
        {pendingD365Requests.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Pending D365 Purchase Requisitions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {pendingD365Requests.map(request => (
                  <div key={request.id} className="flex items-center justify-between p-3 bg-purple-50 rounded-lg border border-purple-200">
                    <div>
                      <p className="font-medium text-sm">{request.request_number}</p>
                      <p className="text-xs text-slate-600">
                        {request.site_name} • ${request.total_estimated_cost?.toFixed(2)} • {request.items?.length} items
                      </p>
                      {request.d365_pr_number && (
                        <p className="text-xs text-purple-600 font-medium mt-1">
                          D365 PR: {request.d365_pr_number}
                        </p>
                      )}
                    </div>
                    <Badge className="bg-purple-600">
                      {request.status === 'sent_to_d365' ? 'Sent to D365' : 'Ready to Send'}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Link Dialog */}
        <Dialog open={showLinkDialog} onOpenChange={setShowLinkDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link Ingredient to D365</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Ingredient</Label>
                <select
                  className="w-full mt-1 px-3 py-2 border rounded-md"
                  value={linkForm.ingredientId}
                  onChange={(e) => setLinkForm({ ...linkForm, ingredientId: e.target.value })}
                >
                  <option value="">Select ingredient</option>
                  {unlinkedIngredients.map(ing => (
                    <option key={ing.id} value={ing.id}>{ing.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <Label>D365 Item Code</Label>
                <Input
                  value={linkForm.d365ItemCode}
                  onChange={(e) => setLinkForm({ ...linkForm, d365ItemCode: e.target.value })}
                  placeholder="e.g., ITEM-001"
                  className="mt-1"
                />
              </div>

              <div>
                <Label>D365 Item Name</Label>
                <Input
                  value={linkForm.d365ItemName}
                  onChange={(e) => setLinkForm({ ...linkForm, d365ItemName: e.target.value })}
                  placeholder="Item name in D365"
                  className="mt-1"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Warehouse Code</Label>
                  <Input
                    value={linkForm.warehouseCode}
                    onChange={(e) => setLinkForm({ ...linkForm, warehouseCode: e.target.value })}
                    placeholder="WH-001"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Project Code</Label>
                  <Input
                    value={linkForm.projectCode}
                    onChange={(e) => setLinkForm({ ...linkForm, projectCode: e.target.value })}
                    placeholder="PRJ-001"
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowLinkDialog(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={() => createLinkMutation.mutate({
                    ...linkForm,
                    last_sync_date: new Date().toISOString(),
                    is_active: true
                  })}
                  disabled={!linkForm.ingredientId || !linkForm.d365ItemCode || createLinkMutation.isPending}
                  className="bg-indigo-600 hover:bg-indigo-700"
                >
                  <LinkIcon className="w-4 h-4 mr-2" />
                  Create Link
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}