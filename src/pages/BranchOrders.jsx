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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';

const STATUS_COLORS = {
  pending: 'bg-amber-500',
  approved: 'bg-blue-500',
  in_production: 'bg-indigo-500',
  ready: 'bg-green-500',
  dispatched: 'bg-purple-500',
  delivered: 'bg-emerald-600',
  cancelled: 'bg-red-600'
};

const PRIORITY_COLORS = {
  low: 'bg-slate-500',
  medium: 'bg-blue-500',
  high: 'bg-orange-500',
  urgent: 'bg-red-600'
};

export default function BranchOrders() {
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [orderForm, setOrderForm] = useState({
    branch_id: '',
    required_date: '',
    items: [],
    priority: 'medium',
    notes: ''
  });
  const [selectedRecipe, setSelectedRecipe] = useState('');
  const [quantity, setQuantity] = useState('');

  const queryClient = useQueryClient();

  const { data: orders = [] } = useQuery({
    queryKey: ['branchOrders'],
    queryFn: () => base44.entities.BranchOrder.list('-order_date', 100)
  });

  const { data: branches = [] } = useQuery({
    queryKey: ['branches'],
    queryFn: async () => {
      const sites = await base44.entities.Site.list();
      return sites.filter(s => s.type === 'branch' || s.type === 'camp');
    }
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const createOrderMutation = useMutation({
    mutationFn: async (data) => {
      const orderNumber = `BO-${Date.now()}`;
      return base44.entities.BranchOrder.create({
        ...data,
        order_number: orderNumber,
        order_date: new Date().toISOString(),
        status: 'pending'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branchOrders'] });
      setShowOrderDialog(false);
      resetForm();
    }
  });

  const updateOrderMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.BranchOrder.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branchOrders'] });
    }
  });

  const resetForm = () => {
    setOrderForm({
      branch_id: '',
      required_date: '',
      items: [],
      priority: 'medium',
      notes: ''
    });
    setSelectedRecipe('');
    setQuantity('');
  };

  const addItem = () => {
    if (selectedRecipe && quantity) {
      const recipe = recipes.find(r => r.id === selectedRecipe);
      setOrderForm({
        ...orderForm,
        items: [
          ...orderForm.items,
          {
            recipe_id: selectedRecipe,
            recipe_name: recipe.name,
            quantity: parseFloat(quantity),
            unit: 'servings'
          }
        ]
      });
      setSelectedRecipe('');
      setQuantity('');
    }
  };

  const removeItem = (index) => {
    setOrderForm({
      ...orderForm,
      items: orderForm.items.filter((_, i) => i !== index)
    });
  };

  const handleCreateOrder = () => {
    const branch = branches.find(b => b.id === orderForm.branch_id);
    createOrderMutation.mutate({
      ...orderForm,
      branch_name: branch?.name
    });
  };

  const approveOrder = async (order) => {
    const user = await base44.auth.me();
    updateOrderMutation.mutate({
      id: order.id,
      data: {
        status: 'approved',
        approved_by: user.email,
        approved_at: new Date().toISOString()
      }
    });
  };

  const stats = {
    pending: orders.filter(o => o.status === 'pending').length,
    inProduction: orders.filter(o => o.status === 'in_production').length,
    ready: orders.filter(o => o.status === 'ready').length
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader 
          title="Branch Orders" 
          description="Manage orders from restaurant branches"
        >
          <Button onClick={() => setShowOrderDialog(true)} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" />
            New Order
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Pending Orders</p>
                  <p className="text-2xl font-bold text-amber-600">{stats.pending}</p>
                </div>
                <AlertCircle className="w-8 h-8 text-amber-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">In Production</p>
                  <p className="text-2xl font-bold text-indigo-600">{stats.inProduction}</p>
                </div>
                <Clock className="w-8 h-8 text-indigo-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Ready for Dispatch</p>
                  <p className="text-2xl font-bold text-green-600">{stats.ready}</p>
                </div>
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Orders Table */}
        <Card>
          <CardHeader>
            <CardTitle>All Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Required Date</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map(order => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">{order.order_number}</TableCell>
                    <TableCell>{order.branch_name}</TableCell>
                    <TableCell>{order.items?.length || 0} items</TableCell>
                    <TableCell>{format(new Date(order.required_date), 'MMM d, yyyy')}</TableCell>
                    <TableCell>
                      <Badge className={PRIORITY_COLORS[order.priority]}>
                        {order.priority}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={STATUS_COLORS[order.status]}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {order.status === 'pending' && (
                        <Button size="sm" onClick={() => approveOrder(order)}>
                          Approve
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-500 py-8">
                      No orders yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Create Order Dialog */}
        <Dialog open={showOrderDialog} onOpenChange={setShowOrderDialog}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Branch Order</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Branch *</Label>
                  <Select
                    value={orderForm.branch_id}
                    onValueChange={(value) => setOrderForm({ ...orderForm, branch_id: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map(branch => (
                        <SelectItem key={branch.id} value={branch.id}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Required Date *</Label>
                  <Input
                    type="date"
                    value={orderForm.required_date}
                    onChange={(e) => setOrderForm({ ...orderForm, required_date: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label>Priority</Label>
                <Select
                  value={orderForm.priority}
                  onValueChange={(value) => setOrderForm({ ...orderForm, priority: value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Add Items</Label>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <Select value={selectedRecipe} onValueChange={setSelectedRecipe}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select recipe" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipes.map(recipe => (
                        <SelectItem key={recipe.id} value={recipe.id}>
                          {recipe.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="Quantity"
                  />
                  <Button onClick={addItem} disabled={!selectedRecipe || !quantity}>
                    Add
                  </Button>
                </div>
              </div>

              {orderForm.items.length > 0 && (
                <div className="border rounded-lg p-4">
                  <Label className="mb-2 block">Order Items</Label>
                  <div className="space-y-2">
                    {orderForm.items.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded">
                        <span className="text-sm">
                          {item.recipe_name} - {item.quantity} {item.unit}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => removeItem(idx)}>
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <Label>Notes</Label>
                <Textarea
                  value={orderForm.notes}
                  onChange={(e) => setOrderForm({ ...orderForm, notes: e.target.value })}
                  placeholder="Additional notes..."
                  className="mt-1"
                  rows={3}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowOrderDialog(false); resetForm(); }}>
                Cancel
              </Button>
              <Button 
                onClick={handleCreateOrder}
                disabled={!orderForm.branch_id || !orderForm.required_date || orderForm.items.length === 0 || createOrderMutation.isPending}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                Create Order
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}