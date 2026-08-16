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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import IngredientSearchCombobox from '@/components/ingredients/IngredientSearchCombobox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, ArrowRight, Package, CheckCircle2, Truck, XCircle } from 'lucide-react';
import { format } from 'date-fns';

const STATUS_CONFIG = {
  pending: { color: 'bg-amber-500', label: 'Pending', icon: Package },
  in_transit: { color: 'bg-blue-500', label: 'In Transit', icon: Truck },
  completed: { color: 'bg-green-600', label: 'Completed', icon: CheckCircle2 },
  cancelled: { color: 'bg-red-600', label: 'Cancelled', icon: XCircle }
};

export default function ProductionTransfer() {
  const [showDialog, setShowDialog] = useState(false);
  const [formData, setFormData] = useState({
    from_site_id: '',
    to_site_id: '',
    transfer_date: format(new Date(), 'yyyy-MM-dd'),
    transfer_type: 'inventory',
    notes: ''
  });
  const [selectedItems, setSelectedItems] = useState([]);

  const queryClient = useQueryClient();

  const { data: transfers = [] } = useQuery({
    queryKey: ['productionTransfers'],
    queryFn: () => base44.entities.ProductionTransfer.list('-transfer_date', 100)
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me()
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.ProductionTransfer.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productionTransfers'] });
      setShowDialog(false);
      resetForm();
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, status, transfer }) => {
      const user = await base44.auth.me();
      const updates = { status };
      
      if (status === 'completed') {
        updates.received_by = user.email;
        await base44.inventory.transfer({
          from_site_id: transfer.from_site_id,
          from_site_name: transfer.from_site_name,
          to_site_id: transfer.to_site_id,
          to_site_name: transfer.to_site_name,
          items: transfer.items || [],
          transfer_date: transfer.transfer_date,
          reference_id: transfer.id,
          notes: transfer.notes || `Transfer from ${transfer.from_site_name} to ${transfer.to_site_name}`
        });
      }

      await base44.entities.ProductionTransfer.update(id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productionTransfers'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
    }
  });

  const resetForm = () => {
    setFormData({
      from_site_id: '',
      to_site_id: '',
      transfer_date: format(new Date(), 'yyyy-MM-dd'),
      transfer_type: 'inventory',
      notes: ''
    });
    setSelectedItems([]);
  };

  const addItem = () => {
    setSelectedItems([...selectedItems, { ingredient_id: '', ingredient_name: '', quantity: 0, unit: 'kg' }]);
  };

  const removeItem = (index) => {
    setSelectedItems(selectedItems.filter((_, i) => i !== index));
  };

  const updateItem = (index, field, value) => {
    const updated = [...selectedItems];
    updated[index][field] = value;
    if (field === 'ingredient_id') {
      const fromInv = inventory.find(i => 
        i.site_id === formData.from_site_id && 
        i.ingredient_id === value
      );
      updated[index].ingredient_name = fromInv?.ingredient_name || '';
      updated[index].unit = fromInv?.unit || 'kg';
    }
    setSelectedItems(updated);
  };

  const handleSubmit = async () => {
    const fromSite = sites.find(s => s.id === formData.from_site_id);
    const toSite = sites.find(s => s.id === formData.to_site_id);

    const transferData = {
      transfer_number: `TRF-${Date.now()}`,
      from_site_id: formData.from_site_id,
      from_site_name: fromSite?.name,
      to_site_id: formData.to_site_id,
      to_site_name: toSite?.name,
      transfer_date: formData.transfer_date,
      transfer_type: formData.transfer_type,
      items: selectedItems,
      notes: formData.notes,
      requested_by: user?.email,
      status: 'pending'
    };

    await createMutation.mutateAsync(transferData);
  };

  const availableInventory = inventory.filter(i => i.site_id === formData.from_site_id && i.quantity > 0);

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Production Transfer" 
          description="Transfer inventory and production between sites"
        >
          <Button onClick={() => setShowDialog(true)} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" />
            New Transfer
          </Button>
        </PageHeader>

        <div className="grid gap-4">
          {transfers.map(transfer => {
            const StatusIcon = STATUS_CONFIG[transfer.status]?.icon || Package;
            return (
              <Card key={transfer.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-3">
                        <Package className="w-5 h-5 text-indigo-600" />
                        {transfer.transfer_number}
                        <Badge className={STATUS_CONFIG[transfer.status]?.color}>
                          {STATUS_CONFIG[transfer.status]?.label}
                        </Badge>
                      </CardTitle>
                      <div className="flex items-center gap-3 mt-2 text-sm text-slate-600">
                        <span className="font-medium">{transfer.from_site_name}</span>
                        <ArrowRight className="w-4 h-4" />
                        <span className="font-medium">{transfer.to_site_name}</span>
                        <span>•</span>
                        <span>{format(new Date(transfer.transfer_date), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {transfer.status === 'pending' && (
                        <Button 
                          size="sm"
                          onClick={() => updateMutation.mutate({ id: transfer.id, status: 'in_transit', transfer })}
                          variant="outline"
                        >
                          <Truck className="w-4 h-4 mr-2" />
                          Start Transit
                        </Button>
                      )}
                      {transfer.status === 'in_transit' && (
                        <Button 
                          size="sm"
                          onClick={() => updateMutation.mutate({ id: transfer.id, status: 'completed', transfer })}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          Receive
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs font-medium text-slate-700 mb-2">Items ({transfer.items?.length || 0})</p>
                    <div className="space-y-1">
                      {transfer.items?.slice(0, 3).map((item, idx) => (
                        <div key={idx} className="flex justify-between text-xs">
                          <span className="text-slate-600">{item.ingredient_name}</span>
                          <span className="font-medium">{item.quantity} {item.unit}</span>
                        </div>
                      ))}
                      {transfer.items?.length > 3 && (
                        <p className="text-xs text-slate-500">+{transfer.items.length - 3} more items</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Transfer Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Transfer</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>From Site</Label>
                  <Select
                    value={formData.from_site_id}
                    onValueChange={(v) => setFormData({ ...formData, from_site_id: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select source site" />
                    </SelectTrigger>
                    <SelectContent>
                      {sites.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>To Site</Label>
                  <Select
                    value={formData.to_site_id}
                    onValueChange={(v) => setFormData({ ...formData, to_site_id: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select destination site" />
                    </SelectTrigger>
                    <SelectContent>
                      {sites.filter(s => s.id !== formData.from_site_id).map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label>Transfer Date</Label>
                <Input
                  type="date"
                  value={formData.transfer_date}
                  onChange={(e) => setFormData({ ...formData, transfer_date: e.target.value })}
                  className="mt-1"
                />
              </div>

              {/* Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Items to Transfer</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addItem}
                    disabled={!formData.from_site_id}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Item
                  </Button>
                </div>
                {selectedItems.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedItems.map((item, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <IngredientSearchCombobox
                              value={item.ingredient_id}
                              selectedIngredient={(() => {
                                const stock = availableInventory.find((entry) => entry.ingredient_id === item.ingredient_id);
                                return stock ? {
                                  id: stock.ingredient_id,
                                  name: stock.ingredient_name,
                                  unit: stock.unit,
                                  current_stock: stock.quantity
                                } : null;
                              })()}
                              siteId={formData.from_site_id}
                              stockOnly
                              onValueChange={(value) => updateItem(idx, 'ingredient_id', value)}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="0"
                              value={item.quantity}
                              onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value))}
                            />
                          </TableCell>
                          <TableCell>{item.unit}</TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeItem(idx)}
                            >
                              <XCircle className="w-4 h-4 text-red-600" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div>
                <Label>Notes</Label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Transfer notes..."
                  className="mt-1"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!formData.from_site_id || !formData.to_site_id || selectedItems.length === 0 || createMutation.isPending}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                Create Transfer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
