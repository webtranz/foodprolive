import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  CalendarClock,
  Download,
  Edit,
  History,
  Package,
  Plus,
  PlusCircle,
  Search,
  SlidersHorizontal,
  TrendingDown,
  Wallet
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import InventoryAlerts from '@/components/inventory/InventoryAlerts';
import InventoryTransactionDialog from '@/components/inventory/InventoryTransactionDialog';
import InventoryEditDialog from '@/components/inventory/InventoryEditDialog';
import InventoryHistory from '@/components/inventory/InventoryHistory';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import StatCard from '@/components/ui/StatCard';
import { downloadCSV } from '../components/utils/exportData';

const STATUS_COLORS = {
  in_stock: 'bg-emerald-100 text-emerald-700',
  low_stock: 'bg-amber-100 text-amber-700',
  out_of_stock: 'bg-red-100 text-red-700',
  expired: 'bg-rose-100 text-rose-700'
};

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function formatQuantity(value) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2
  });
}

function InventoryTransferDialog({
  open,
  onOpenChange,
  sites,
  inventory,
  onSubmit,
  isPending
}) {
  const [formData, setFormData] = useState({
    from_site_id: '',
    to_site_id: '',
    transfer_date: format(new Date(), 'yyyy-MM-dd'),
    notes: ''
  });
  const [items, setItems] = useState([{ ingredient_id: '', quantity: '', ingredient_name: '', unit: '' }]);

  useEffect(() => {
    if (!open) {
      setFormData({
        from_site_id: '',
        to_site_id: '',
        transfer_date: format(new Date(), 'yyyy-MM-dd'),
        notes: ''
      });
      setItems([{ ingredient_id: '', quantity: '', ingredient_name: '', unit: '' }]);
    }
  }, [open]);

  const warehouseSites = sites.filter((site) => ['warehouse', 'store'].includes(String(site.type || '').toLowerCase()));
  const stockSites = warehouseSites.length > 0 ? warehouseSites : sites;
  const availableInventory = inventory.filter((item) => item.site_id === formData.from_site_id && Number(item.quantity || 0) > 0);

  const updateItem = (index, field, value) => {
    setItems((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const nextItem = { ...item, [field]: value };
      if (field === 'ingredient_id') {
        const match = availableInventory.find((entry) => entry.ingredient_id === value);
        nextItem.ingredient_name = match?.ingredient_name || '';
        nextItem.unit = match?.unit || '';
      }
      return nextItem;
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const fromSite = sites.find((site) => site.id === formData.from_site_id);
    const toSite = sites.find((site) => site.id === formData.to_site_id);
    const payloadItems = items
      .filter((item) => item.ingredient_id && Number(item.quantity) > 0)
      .map((item) => ({
        ingredient_id: item.ingredient_id,
        ingredient_name: item.ingredient_name,
        quantity: Number(item.quantity),
        unit: item.unit || 'kg'
      }));

    if (!fromSite || !toSite || payloadItems.length === 0) return;

    await onSubmit({
      from_site_id: fromSite.id,
      from_site_name: fromSite.name,
      to_site_id: toSite.id,
      to_site_name: toSite.name,
      transfer_date: formData.transfer_date,
      notes: formData.notes,
      items: payloadItems
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Transfer Stock Between Locations</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>From Warehouse</Label>
              <Select value={formData.from_site_id} onValueChange={(value) => setFormData((current) => ({ ...current, from_site_id: value }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select source warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {stockSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>To Warehouse</Label>
              <Select value={formData.to_site_id} onValueChange={(value) => setFormData((current) => ({ ...current, to_site_id: value }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select destination warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {stockSites.filter((site) => site.id !== formData.from_site_id).map((site) => (
                    <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <div>
              <Label>Transfer Date</Label>
              <Input
                type="date"
                className="mt-1"
                value={formData.transfer_date}
                onChange={(event) => setFormData((current) => ({ ...current, transfer_date: event.target.value }))}
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                className="mt-1"
                rows={3}
                value={formData.notes}
                onChange={(event) => setFormData((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Driver, dispatch note, reason for transfer"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Transfer Items</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItems((current) => [...current, { ingredient_id: '', quantity: '', ingredient_name: '', unit: '' }])}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Line
              </Button>
            </div>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ingredient</TableHead>
                    <TableHead>Available</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead className="text-right">Remove</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item, index) => {
                    const selectedInventory = availableInventory.find((entry) => entry.ingredient_id === item.ingredient_id);
                    return (
                      <TableRow key={`${item.ingredient_id}-${index}`}>
                        <TableCell>
                          <Select value={item.ingredient_id} onValueChange={(value) => updateItem(index, 'ingredient_id', value)}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select ingredient" />
                            </SelectTrigger>
                            <SelectContent>
                              {availableInventory.map((entry) => (
                                <SelectItem key={entry.ingredient_id} value={entry.ingredient_id}>
                                  {entry.ingredient_name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-sm text-slate-600">
                          {selectedInventory ? `${formatQuantity(selectedInventory.quantity)} ${selectedInventory.unit}` : '-'}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.quantity}
                            onChange={(event) => updateItem(index, 'quantity', event.target.value)}
                          />
                        </TableCell>
                        <TableCell>{item.unit || '-'}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                            disabled={items.length === 1}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Transferring...' : 'Post Transfer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Inventory() {
  const { isManager } = usePermissions();
  const [selectedSite, setSelectedSite] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [stockDialogOpen, setStockDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transactionDialog, setTransactionDialog] = useState({ open: false, item: null, type: 'addition' });
  const [editDialog, setEditDialog] = useState({ open: false, item: null });
  const [historyDialog, setHistoryDialog] = useState({ open: false, item: null });
  const [stockForm, setStockForm] = useState({
    site_id: '',
    ingredient_id: '',
    quantity: '',
    unit_cost: '',
    batch_number: '',
    expiry_date: '',
    min_stock_level: '',
    max_stock_level: '',
    valuation_method: 'fifo',
    notes: ''
  });

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const warehouseSites = useMemo(() => (
    sites.filter((site) => ['warehouse', 'store'].includes(String(site.type || '').toLowerCase()))
  ), [sites]);
  const stockSites = warehouseSites.length > 0 ? warehouseSites : sites;

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: productions = [] } = useQuery({
    queryKey: ['productions'],
    queryFn: () => base44.entities.Production.list('-production_date', 100)
  });

  const { data: stockOnHand = [], isLoading } = useQuery({
    queryKey: ['inventory', 'stock-on-hand'],
    queryFn: () => base44.inventory.getStockOnHand()
  });

  const { data: movementReport = [] } = useQuery({
    queryKey: ['inventory', 'movements', selectedSite, dateFrom, dateTo],
    queryFn: () => base44.inventory.getMovements({
      site_id: selectedSite === 'all' ? '' : selectedSite,
      date_from: dateFrom,
      date_to: dateTo
    })
  });

  const { data: expiryReport = [] } = useQuery({
    queryKey: ['inventory', 'expiry'],
    queryFn: () => base44.inventory.getExpiryReport({ threshold_days: 30 })
  });

  const { data: valuationReport = [] } = useQuery({
    queryKey: ['inventory', 'valuation'],
    queryFn: () => base44.inventory.getValuation()
  });

  const { data: velocityReport = { fast_moving: [], slow_moving: [] } } = useQuery({
    queryKey: ['inventory', 'velocity'],
    queryFn: () => base44.inventory.getVelocity({ days: 30 })
  });

  const { data: lots = [] } = useQuery({
    queryKey: ['inventory', 'lots'],
    queryFn: () => base44.inventory.listLots({ include_empty: false })
  });

  useEffect(() => {
    const unsubscribeInventory = base44.entities.Inventory.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    });
    const unsubscribeLots = base44.entities.InventoryLot.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    });
    const unsubscribeTransactions = base44.entities.InventoryTransaction.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    });

    return () => {
      unsubscribeInventory();
      unsubscribeLots();
      unsubscribeTransactions();
    };
  }, [queryClient]);

  const upcomingNeeds = useMemo(() => {
    const needs = [];
    const today = new Date().toISOString().split('T')[0];
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    productions
      .filter((production) => production.production_date >= today && production.production_date <= nextWeekStr && production.status === 'planned')
      .forEach((production) => {
        (production.ingredients_used || []).forEach((ingredient) => {
          const existing = needs.find((item) => item.ingredient_id === ingredient.ingredient_id && item.site_id === production.site_id);
          if (existing) {
            existing.required_quantity += ingredient.planned_quantity || 0;
            return;
          }
          needs.push({
            ingredient_id: ingredient.ingredient_id,
            ingredient_name: ingredient.ingredient_name,
            site_id: production.site_id,
            site_name: production.site_name,
            required_quantity: ingredient.planned_quantity || 0,
            unit: ingredient.unit,
            production_date: production.production_date
          });
        });
      });

    return needs;
  }, [productions]);

  const filteredInventory = useMemo(() => {
    return stockOnHand.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${item.ingredient_name} ${item.site_name}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [searchQuery, selectedSite, stockOnHand]);

  const filteredExpiry = useMemo(() => {
    return expiryReport.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${item.ingredient_name} ${item.site_name} ${item.batch_number || ''}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [expiryReport, searchQuery, selectedSite]);

  const filteredValuation = useMemo(() => {
    return valuationReport.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${item.ingredient_name} ${item.site_name}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [valuationReport, searchQuery, selectedSite]);

  const filteredLots = useMemo(() => {
    return lots.filter((lot) => {
      const matchesSite = selectedSite === 'all' || lot.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${lot.ingredient_name} ${lot.site_name} ${lot.batch_number || ''}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [lots, searchQuery, selectedSite]);

  const inventorySummary = useMemo(() => {
    const totalQuantity = filteredInventory.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const totalValue = filteredInventory.reduce((sum, item) => sum + Number(item.total_value || 0), 0);
    const lowStockItems = filteredInventory.filter((item) => item.status === 'low_stock' || item.status === 'out_of_stock').length;
    const expiredLots = filteredInventory.reduce((sum, item) => sum + Number(item.expired_lot_count || 0), 0);
    const nearExpiryLots = filteredInventory.reduce((sum, item) => sum + Number(item.near_expiry_count || 0), 0);
    const totalBatches = filteredInventory.reduce((sum, item) => sum + Number(item.batch_count || 0), 0);
    return {
      totalQuantity,
      totalValue,
      lowStockItems,
      expiredLots,
      nearExpiryLots,
      totalBatches
    };
  }, [filteredInventory]);

  const receiveStockMutation = useMutation({
    mutationFn: (payload) => base44.inventory.receive(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setStockDialogOpen(false);
      setStockForm({
        site_id: '',
        ingredient_id: '',
        quantity: '',
        unit_cost: '',
        batch_number: '',
        expiry_date: '',
        min_stock_level: '',
        max_stock_level: '',
        valuation_method: 'fifo',
        notes: ''
      });
    }
  });

  const transferStockMutation = useMutation({
    mutationFn: (payload) => base44.inventory.transfer(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setTransferDialogOpen(false);
    }
  });

  const selectedIngredient = ingredients.find((ingredient) => ingredient.id === stockForm.ingredient_id);

  const handleReceiveStock = (event) => {
    event.preventDefault();
    const site = sites.find((entry) => entry.id === stockForm.site_id);
    const ingredient = ingredients.find((entry) => entry.id === stockForm.ingredient_id);
    if (!site || !ingredient) return;

    receiveStockMutation.mutate({
      site_id: site.id,
      site_name: site.name,
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: Number(stockForm.quantity || 0),
      unit: ingredient.unit || 'kg',
      unit_cost: Number(stockForm.unit_cost || 0),
      batch_number: stockForm.batch_number,
      expiry_date: stockForm.expiry_date || null,
      min_stock_level: Number(stockForm.min_stock_level || 0),
      max_stock_level: stockForm.max_stock_level ? Number(stockForm.max_stock_level) : null,
      valuation_method: stockForm.valuation_method,
      notes: stockForm.notes,
      reason_code: 'manual_receipt'
    });
  };

  const movementSummary = useMemo(() => {
    return movementReport.reduce((summary, movement) => {
      const quantity = Number(movement.quantity || 0);
      if (quantity >= 0) {
        summary.inbound += quantity;
      } else {
        summary.outbound += Math.abs(quantity);
      }
      return summary;
    }, { inbound: 0, outbound: 0 });
  }, [movementReport]);

  const filteredFastMoving = useMemo(() => {
    return (velocityReport.fast_moving || []).filter((item) => selectedSite === 'all' || item.site_id === selectedSite);
  }, [selectedSite, velocityReport.fast_moving]);

  const filteredSlowMoving = useMemo(() => {
    return (velocityReport.slow_moving || []).filter((item) => selectedSite === 'all' || item.site_id === selectedSite);
  }, [selectedSite, velocityReport.slow_moving]);

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px]">
        <PageHeader
          title="Inventory Control"
          description="Warehouse-based stock control with lots, expiry, valuation, transfers, movement reporting, and site-scoped access."
        >
          <Button variant="outline" onClick={() => downloadCSV(filteredInventory, 'inventory-stock-on-hand')}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          {isManager ? (
            <>
              <Button variant="outline" onClick={() => setTransferDialogOpen(true)}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                Transfer Stock
              </Button>
              <Button onClick={() => setStockDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                <Plus className="mr-2 h-4 w-4" />
                Receive Stock
              </Button>
            </>
          ) : null}
        </PageHeader>

        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
          <StatCard title="Warehouses" value={stockSites.length} icon={Boxes} iconBg="bg-slate-100" iconColor="text-slate-700" />
          <StatCard title="Stock On Hand" value={formatQuantity(inventorySummary.totalQuantity)} icon={Boxes} iconBg="bg-blue-50" iconColor="text-blue-600" />
          <StatCard title="Inventory Value" value={CURRENCY.format(inventorySummary.totalValue)} icon={Wallet} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Low Stock Items" value={inventorySummary.lowStockItems} icon={TrendingDown} iconBg="bg-amber-50" iconColor="text-amber-600" />
          <StatCard title="Expired Lots" value={inventorySummary.expiredLots} icon={AlertTriangle} iconBg="bg-rose-50" iconColor="text-rose-600" />
          <StatCard title="Near Expiry" value={inventorySummary.nearExpiryLots} icon={CalendarClock} iconBg="bg-orange-50" iconColor="text-orange-600" />
          <StatCard title="Active Batches" value={inventorySummary.totalBatches} icon={Package} iconBg="bg-violet-50" iconColor="text-violet-600" />
        </div>

        <div className="mb-6">
          <InventoryAlerts inventory={filteredInventory} upcomingNeeds={upcomingNeeds} />
        </div>

        <Card className="mb-6 border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_260px_180px_180px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-10"
                  placeholder="Search ingredient, location, or batch"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
              <Select value={selectedSite} onValueChange={setSelectedSite}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Warehouses</SelectItem>
                  {stockSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
              <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : filteredInventory.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No inventory records found"
            description="Receive your first stock delivery or widen the selected filters."
            actionLabel="Receive Stock"
            onAction={isManager ? () => setStockDialogOpen(true) : undefined}
          />
        ) : (
          <Tabs defaultValue="stock" className="space-y-4">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
              <TabsTrigger value="stock">Stock On Hand</TabsTrigger>
              <TabsTrigger value="movements">Movement Ledger</TabsTrigger>
              <TabsTrigger value="expiry">Expiry & Lots</TabsTrigger>
              <TabsTrigger value="valuation">Valuation</TabsTrigger>
              <TabsTrigger value="velocity">Velocity</TabsTrigger>
            </TabsList>

            <TabsContent value="stock">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100">
                  <CardTitle className="text-lg">Stock On Hand Report</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Available</TableHead>
                        <TableHead>Min / Max</TableHead>
                        <TableHead>Valuation</TableHead>
                        <TableHead>Expiry</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredInventory.map((item) => {
                        const stockPercent = item.max_stock_level
                          ? Math.min(100, (Number(item.quantity || 0) / Number(item.max_stock_level || 1)) * 100)
                          : Math.min(100, ((Number(item.quantity || 0) / Math.max(Number(item.min_stock_level || 1), 1)) * 100));

                        return (
                          <TableRow key={item.id}>
                            <TableCell>
                              <div>
                                <p className="font-medium">{item.ingredient_name}</p>
                                <p className="text-xs text-slate-500">{item.batch_count || 0} active batches</p>
                              </div>
                            </TableCell>
                            <TableCell>{item.site_name}</TableCell>
                            <TableCell>
                              <p className="font-semibold">{formatQuantity(item.quantity)} {item.unit}</p>
                              <Progress value={stockPercent} className="mt-2 h-2 max-w-28" />
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              <div>Min: {formatQuantity(item.min_stock_level)} {item.unit}</div>
                              <div>Max: {item.max_stock_level ? `${formatQuantity(item.max_stock_level)} ${item.unit}` : '-'}</div>
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              <div>{CURRENCY.format(Number(item.total_value || 0))}</div>
                              <div className="text-xs text-slate-500">
                                {item.valuation_method === 'weighted_average' ? 'Weighted avg' : 'FIFO'} • {CURRENCY.format(Number(item.average_unit_cost || 0))}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              <div>{item.next_expiry_date || '-'}</div>
                              <div className="text-xs text-slate-500">
                                Expired: {item.expired_lot_count || 0} • Near: {item.near_expiry_count || 0}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge className={STATUS_COLORS[item.status] || 'bg-slate-100 text-slate-700'}>
                                {String(item.status || 'in_stock').replace(/_/g, ' ')}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                <Button size="sm" variant="outline" onClick={() => setTransactionDialog({ open: true, item, type: 'addition' })}>
                                  <PlusCircle className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setTransactionDialog({ open: true, item, type: 'issuance' })}>
                                  <TrendingDown className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setTransactionDialog({ open: true, item, type: 'adjustment' })}>
                                  <SlidersHorizontal className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setEditDialog({ open: true, item })}>
                                  <Edit className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setHistoryDialog({ open: true, item })}>
                                  <History className="h-4 w-4" />
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
            </TabsContent>

            <TabsContent value="movements">
              <div className="mb-4 grid gap-4 md:grid-cols-2">
                <Card className="border-slate-200">
                  <CardContent className="p-5">
                    <p className="text-sm text-slate-500">Inbound Quantity</p>
                    <p className="mt-2 text-2xl font-semibold text-emerald-700">{formatQuantity(movementSummary.inbound)}</p>
                  </CardContent>
                </Card>
                <Card className="border-slate-200">
                  <CardContent className="p-5">
                    <p className="text-sm text-slate-500">Outbound Quantity</p>
                    <p className="mt-2 text-2xl font-semibold text-rose-700">{formatQuantity(movementSummary.outbound)}</p>
                  </CardContent>
                </Card>
              </div>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100">
                  <CardTitle className="text-lg">Stock Movement Ledger</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Batch</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {movementReport.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="py-8 text-center text-slate-500">
                            No stock movements in the selected period.
                          </TableCell>
                        </TableRow>
                      ) : movementReport.map((movement) => (
                        <TableRow key={movement.id}>
                          <TableCell>{movement.transaction_date || '-'}</TableCell>
                          <TableCell>{movement.ingredient_name}</TableCell>
                          <TableCell>{movement.site_name}</TableCell>
                          <TableCell className="capitalize">{String(movement.transaction_type || '').replace(/_/g, ' ')}</TableCell>
                          <TableCell>{movement.batch_number || '-'}</TableCell>
                          <TableCell className={Number(movement.quantity || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                            {Number(movement.quantity || 0) >= 0 ? '+' : ''}{formatQuantity(movement.quantity)} {movement.unit}
                          </TableCell>
                          <TableCell>{CURRENCY.format(Number(movement.total_cost || 0))}</TableCell>
                          <TableCell className="max-w-xs truncate">{movement.notes || movement.reason_code || '-'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="expiry">
              <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-lg">Expiry Report</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ingredient</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Batch</TableHead>
                          <TableHead>Expiry</TableHead>
                          <TableHead>Days</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredExpiry.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                              No near-expiry or expired lots found.
                            </TableCell>
                          </TableRow>
                        ) : filteredExpiry.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell>{item.ingredient_name}</TableCell>
                            <TableCell>{item.site_name}</TableCell>
                            <TableCell>{item.batch_number || '-'}</TableCell>
                            <TableCell>{item.expiry_date || '-'}</TableCell>
                            <TableCell>{item.days_until_expiry ?? '-'}</TableCell>
                            <TableCell>
                              <Badge className={
                                item.expiry_status === 'expired'
                                  ? 'bg-rose-100 text-rose-700'
                                  : item.expiry_status === 'near_expiry'
                                    ? 'bg-orange-100 text-orange-700'
                                    : 'bg-slate-100 text-slate-700'
                              }>
                                {String(item.expiry_status || 'unknown').replace(/_/g, ' ')}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-lg">Batch / Lot Tracking</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4">
                    {filteredLots.length === 0 ? (
                      <p className="py-6 text-center text-sm text-slate-500">No active lots found.</p>
                    ) : filteredLots.slice(0, 12).map((lot) => (
                      <div key={lot.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-slate-900">{lot.ingredient_name}</p>
                            <p className="text-sm text-slate-500">{lot.site_name}</p>
                          </div>
                          <Badge variant="outline">{lot.batch_number || lot.lot_number || 'Lot'}</Badge>
                        </div>
                        <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
                          <p>Remaining: {formatQuantity(lot.remaining_quantity)} {lot.unit}</p>
                          <p>Received: {lot.received_date || '-'}</p>
                          <p>Expiry: {lot.expiry_date || '-'}</p>
                          <p>Unit Cost: {CURRENCY.format(Number(lot.unit_cost || 0))}</p>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="valuation">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100">
                  <CardTitle className="text-lg">Inventory Valuation Report</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Average Cost</TableHead>
                        <TableHead>FIFO Value</TableHead>
                        <TableHead>Weighted Avg Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredValuation.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.ingredient_name}</TableCell>
                          <TableCell>{item.site_name}</TableCell>
                          <TableCell>{item.valuation_method === 'weighted_average' ? 'Weighted Average' : 'FIFO'}</TableCell>
                          <TableCell>{formatQuantity(item.quantity)} {item.unit}</TableCell>
                          <TableCell>{CURRENCY.format(Number(item.average_unit_cost || 0))}</TableCell>
                          <TableCell>{CURRENCY.format(Number(item.fifo_value || 0))}</TableCell>
                          <TableCell>{CURRENCY.format(Number(item.weighted_average_value || 0))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="velocity">
              <div className="grid gap-4 xl:grid-cols-2">
                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-lg">Fast-Moving Items</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4">
                    {filteredFastMoving.length === 0 ? (
                      <p className="py-8 text-center text-sm text-slate-500">No movement data available yet.</p>
                    ) : filteredFastMoving.slice(0, 10).map((item) => (
                      <div key={`${item.site_id}-${item.ingredient_id}`} className="rounded-xl border border-slate-200 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">{item.ingredient_name}</p>
                            <p className="text-sm text-slate-500">{item.site_name}</p>
                          </div>
                          <Badge className="bg-emerald-100 text-emerald-700">
                            {formatQuantity(item.total_moved)}
                          </Badge>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">{item.movement_count} consumption movements in the last 30 days</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-lg">Slow-Moving Items</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4">
                    {filteredSlowMoving.length === 0 ? (
                      <p className="py-8 text-center text-sm text-slate-500">No slow-moving data available yet.</p>
                    ) : filteredSlowMoving.slice(0, 10).map((item) => (
                      <div key={`${item.site_id}-${item.ingredient_id}`} className="rounded-xl border border-slate-200 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">{item.ingredient_name}</p>
                            <p className="text-sm text-slate-500">{item.site_name}</p>
                          </div>
                          <Badge variant="outline">{formatQuantity(item.total_moved)}</Badge>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">{item.movement_count} consumption movements in the last 30 days</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        )}

        <InventoryTransactionDialog
          open={transactionDialog.open}
          onOpenChange={(open) => setTransactionDialog((current) => ({ ...current, open }))}
          inventoryItem={transactionDialog.item}
          transactionType={transactionDialog.type}
        />

        <InventoryEditDialog
          open={editDialog.open}
          onOpenChange={(open) => setEditDialog((current) => ({ ...current, open }))}
          inventoryItem={editDialog.item}
        />

        <Dialog open={historyDialog.open} onOpenChange={(open) => setHistoryDialog((current) => ({ ...current, open }))}>
          <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Movement History - {historyDialog.item?.ingredient_name}</DialogTitle>
            </DialogHeader>
            {historyDialog.item ? (
              <InventoryHistory ingredientId={historyDialog.item.ingredient_id} siteId={historyDialog.item.site_id} />
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={stockDialogOpen} onOpenChange={setStockDialogOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Receive Inventory Stock</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleReceiveStock} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Warehouse</Label>
                  <Select value={stockForm.site_id} onValueChange={(value) => setStockForm((current) => ({ ...current, site_id: value }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select warehouse" />
                    </SelectTrigger>
                    <SelectContent>
                      {stockSites.map((site) => (
                        <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Ingredient</Label>
                  <Select value={stockForm.ingredient_id} onValueChange={(value) => setStockForm((current) => ({ ...current, ingredient_id: value }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select ingredient" />
                    </SelectTrigger>
                    <SelectContent>
                      {ingredients.map((ingredient) => (
                        <SelectItem key={ingredient.id} value={ingredient.id}>{ingredient.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <div>
                  <Label>Quantity</Label>
                  <Input type="number" step="0.01" min="0" className="mt-1" value={stockForm.quantity} onChange={(event) => setStockForm((current) => ({ ...current, quantity: event.target.value }))} />
                </div>
                <div>
                  <Label>Unit</Label>
                  <Input className="mt-1" disabled value={selectedIngredient?.unit || ''} />
                </div>
                <div>
                  <Label>Unit Cost</Label>
                  <Input type="number" step="0.01" min="0" className="mt-1" value={stockForm.unit_cost} onChange={(event) => setStockForm((current) => ({ ...current, unit_cost: event.target.value }))} />
                </div>
                <div>
                  <Label>Batch / Lot</Label>
                  <Input className="mt-1" value={stockForm.batch_number} onChange={(event) => setStockForm((current) => ({ ...current, batch_number: event.target.value }))} />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <div>
                  <Label>Expiry Date</Label>
                  <Input type="date" className="mt-1" value={stockForm.expiry_date} onChange={(event) => setStockForm((current) => ({ ...current, expiry_date: event.target.value }))} />
                </div>
                <div>
                  <Label>Min Level</Label>
                  <Input type="number" step="0.01" min="0" className="mt-1" value={stockForm.min_stock_level} onChange={(event) => setStockForm((current) => ({ ...current, min_stock_level: event.target.value }))} />
                </div>
                <div>
                  <Label>Max Level</Label>
                  <Input type="number" step="0.01" min="0" className="mt-1" value={stockForm.max_stock_level} onChange={(event) => setStockForm((current) => ({ ...current, max_stock_level: event.target.value }))} />
                </div>
                <div>
                  <Label>Valuation Method</Label>
                  <Select value={stockForm.valuation_method} onValueChange={(value) => setStockForm((current) => ({ ...current, valuation_method: value }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fifo">FIFO</SelectItem>
                      <SelectItem value="weighted_average">Weighted Average</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label>Notes</Label>
                <Textarea
                  className="mt-1"
                  rows={3}
                  value={stockForm.notes}
                  onChange={(event) => setStockForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="GRN number, supplier, receiving notes"
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setStockDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={receiveStockMutation.isPending}>
                  {receiveStockMutation.isPending ? 'Receiving...' : 'Receive Stock'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <InventoryTransferDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          sites={stockSites}
          inventory={stockOnHand}
          onSubmit={(payload) => transferStockMutation.mutateAsync(payload)}
          isPending={transferStockMutation.isPending}
        />
      </div>
    </div>
  );
}
