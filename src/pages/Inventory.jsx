import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import InventoryAlerts from '@/components/inventory/InventoryAlerts';
import InventoryTransactionDialog from '@/components/inventory/InventoryTransactionDialog';
import InventoryEditDialog from '@/components/inventory/InventoryEditDialog';
import InventoryHistory from '@/components/inventory/InventoryHistory';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Search, Package, AlertTriangle, Download, PlusCircle, MinusCircle, Edit, History } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { format } from 'date-fns';
import StatCard from '@/components/ui/StatCard';

const STATUS_COLORS = {
  in_stock: 'bg-emerald-100 text-emerald-700',
  low_stock: 'bg-amber-100 text-amber-700',
  out_of_stock: 'bg-red-100 text-red-700',
  expired: 'bg-purple-100 text-purple-700'
};

export default function Inventory() {
  const [selectedSite, setSelectedSite] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [transactionDialog, setTransactionDialog] = useState({ open: false, item: null, type: 'addition' });
  const [editDialog, setEditDialog] = useState({ open: false, item: null });
  const [historyDialog, setHistoryDialog] = useState({ open: false, item: null });
  const [formData, setFormData] = useState({
    site_id: '',
    ingredient_id: '',
    quantity: '',
    min_stock_level: '',
    max_stock_level: '',
    expiry_date: ''
  });

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: inventory = [], isLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  // Real-time updates
  useEffect(() => {
    const unsubscribe = base44.entities.Inventory.subscribe((event) => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    });
    return unsubscribe;
  }, [queryClient]);

  const { data: productions = [] } = useQuery({
    queryKey: ['productions'],
    queryFn: () => base44.entities.Production.list('-production_date', 100)
  });

  // Calculate upcoming ingredient needs
  const upcomingNeeds = React.useMemo(() => {
    const needs = [];
    const today = new Date().toISOString().split('T')[0];
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    const upcomingProductions = productions.filter(
      p => p.production_date >= today && 
           p.production_date <= nextWeekStr && 
           p.status === 'planned'
    );

    upcomingProductions.forEach(prod => {
      prod.ingredients_used?.forEach(ing => {
        const existing = needs.find(
          n => n.ingredient_id === ing.ingredient_id && n.site_id === prod.site_id
        );
        if (existing) {
          existing.required_quantity += ing.planned_quantity || 0;
        } else {
          needs.push({
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            site_id: prod.site_id,
            site_name: prod.site_name,
            required_quantity: ing.planned_quantity || 0,
            unit: ing.unit,
            production_date: prod.production_date
          });
        }
      });
    });

    return needs;
  }, [productions]);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Inventory.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setFormOpen(false);
      resetForm();
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Inventory.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    }
  });

  const resetForm = () => {
    setFormData({
      site_id: '',
      ingredient_id: '',
      quantity: '',
      min_stock_level: '',
      max_stock_level: '',
      expiry_date: ''
    });
  };

  const filteredInventory = inventory.filter(item => {
    const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
    const matchesSearch = item.ingredient_name?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSite && matchesSearch;
  });

  // Calculate stats
  const totalItems = filteredInventory.length;
  const lowStockItems = filteredInventory.filter(i => i.status === 'low_stock').length;
  const outOfStockItems = filteredInventory.filter(i => i.status === 'out_of_stock').length;
  const expiredItems = filteredInventory.filter(i => i.status === 'expired').length;

  const handleSubmit = (e) => {
    e.preventDefault();
    const site = sites.find(s => s.id === formData.site_id);
    const ingredient = ingredients.find(i => i.id === formData.ingredient_id);

    const quantity = parseFloat(formData.quantity) || 0;
    const minStock = parseFloat(formData.min_stock_level) || 0;
    
    let status = 'in_stock';
    if (quantity <= 0) status = 'out_of_stock';
    else if (quantity <= minStock) status = 'low_stock';

    const submitData = {
      site_id: formData.site_id,
      site_name: site?.name || '',
      ingredient_id: formData.ingredient_id,
      ingredient_name: ingredient?.name || '',
      quantity,
      unit: ingredient?.unit || 'kg',
      min_stock_level: minStock,
      max_stock_level: parseFloat(formData.max_stock_level) || null,
      expiry_date: formData.expiry_date || null,
      last_restocked: format(new Date(), 'yyyy-MM-dd'),
      status
    };

    createMutation.mutate(submitData);
  };

  const openTransaction = (item, type) => {
    setTransactionDialog({ open: true, item, type });
  };

  const openEdit = (item) => {
    setEditDialog({ open: true, item });
  };

  const openHistory = (item) => {
    setHistoryDialog({ open: true, item });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Inventory" 
          description="Track ingredient stock levels"
        >
          <Button 
            variant="outline"
            onClick={() => downloadCSV(filteredInventory, 'inventory')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            onClick={() => setFormOpen(true)}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Stock
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            title="Total Items"
            value={totalItems}
            icon={Package}
            iconBg="bg-blue-50"
            iconColor="text-blue-600"
          />
          <StatCard
            title="Low Stock"
            value={lowStockItems}
            icon={AlertTriangle}
            iconBg="bg-amber-50"
            iconColor="text-amber-600"
          />
          <StatCard
            title="Out of Stock"
            value={outOfStockItems}
            icon={Package}
            iconBg="bg-red-50"
            iconColor="text-red-600"
          />
          <StatCard
            title="Expired"
            value={expiredItems}
            icon={AlertTriangle}
            iconBg="bg-purple-50"
            iconColor="text-purple-600"
          />
        </div>

        {/* Alerts */}
        <div className="mb-6">
          <InventoryAlerts 
            inventory={filteredInventory} 
            upcomingNeeds={upcomingNeeds}
          />
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search ingredients..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={selectedSite} onValueChange={setSelectedSite}>
              <SelectTrigger className="w-full sm:w-[180px]">
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

        {/* Content */}
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
        ) : filteredInventory.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No inventory records"
            description="Start tracking your ingredient stock"
            actionLabel="Add Stock"
            onAction={() => setFormOpen(true)}
          />
        ) : (
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ingredient</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Stock Level</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInventory.map(item => {
                    const stockPercent = item.max_stock_level 
                      ? Math.min(100, (item.quantity / item.max_stock_level) * 100)
                      : 50;

                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">{item.ingredient_name}</TableCell>
                        <TableCell>{item.site_name}</TableCell>
                        <TableCell>
                          <span className="font-semibold">{item.quantity}</span> {item.unit}
                        </TableCell>
                        <TableCell className="w-32">
                          <Progress value={stockPercent} className="h-2" />
                          <p className="text-xs text-slate-500 mt-1">
                            Min: {item.min_stock_level || 0}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge className={STATUS_COLORS[item.status]}>
                            {item.status?.replace(/_/g, ' ')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {item.expiry_date ? format(new Date(item.expiry_date), 'MMM d, yyyy') : '-'}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 justify-end">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openTransaction(item, 'addition')}
                              title="Add Stock"
                            >
                              <PlusCircle className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openTransaction(item, 'issuance')}
                              title="Issue Stock"
                            >
                              <MinusCircle className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEdit(item)}
                              title="Edit Settings"
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openHistory(item)}
                              title="View History"
                            >
                              <History className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Transaction Dialogs */}
        <InventoryTransactionDialog
          open={transactionDialog.open}
          onOpenChange={(open) => setTransactionDialog({ ...transactionDialog, open })}
          inventoryItem={transactionDialog.item}
          transactionType={transactionDialog.type}
        />

        <InventoryEditDialog
          open={editDialog.open}
          onOpenChange={(open) => setEditDialog({ ...editDialog, open })}
          inventoryItem={editDialog.item}
        />

        {/* History Dialog */}
        <Dialog open={historyDialog.open} onOpenChange={(open) => setHistoryDialog({ ...historyDialog, open })}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                Transaction History - {historyDialog.item?.ingredient_name}
              </DialogTitle>
            </DialogHeader>
            {historyDialog.item && (
              <InventoryHistory 
                ingredientId={historyDialog.item.ingredient_id}
                siteId={historyDialog.item.site_id}
              />
            )}
          </DialogContent>
        </Dialog>

        {/* Form Dialog */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Inventory Stock</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label>Site *</Label>
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
                <Label>Ingredient *</Label>
                <Select
                  value={formData.ingredient_id}
                  onValueChange={(value) => setFormData({ ...formData, ingredient_id: value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select ingredient" />
                  </SelectTrigger>
                  <SelectContent>
                    {ingredients.map(ing => (
                      <SelectItem key={ing.id} value={ing.id}>{ing.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>Quantity *</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>
                <div>
                  <Label>Min Level</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={formData.min_stock_level}
                    onChange={(e) => setFormData({ ...formData, min_stock_level: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Max Level</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={formData.max_stock_level}
                    onChange={(e) => setFormData({ ...formData, max_stock_level: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label>Expiry Date</Label>
                <Input
                  type="date"
                  value={formData.expiry_date}
                  onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                  className="mt-1"
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
                  {createMutation.isPending ? 'Adding...' : 'Add Stock'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}