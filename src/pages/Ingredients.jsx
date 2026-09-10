import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import IngredientForm from '@/components/ingredients/IngredientForm';
import IngredientCard from '@/components/ingredients/IngredientCard';
import IngredientSearchCombobox from '@/components/ingredients/IngredientSearchCombobox';
import InventoryAlerts from '@/components/inventory/InventoryAlerts';
import InventoryTransactionDialog from '@/components/inventory/InventoryTransactionDialog';
import InventoryEditDialog from '@/components/inventory/InventoryEditDialog';
import InventoryHistory from '@/components/inventory/InventoryHistory';
import StockChangeLog from '@/components/inventory/StockChangeLog';
import { usePermissions } from '@/components/auth/usePermissions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import StatCard from '@/components/ui/StatCard';
import { Plus, Search, Package, LayoutGrid, List, Download, AlertTriangle, PlusCircle, MinusCircle, Edit, History, Flame, Beef, Droplet, Candy, ShieldAlert, Trash2 } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { format } from 'date-fns';
import { formatCurrency } from '@/lib/currency';
import { getItemCode, getItemCodeFromRecords, putItemCodeAndNameFirst } from '../../shared/itemCode.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';
import { getInventoryQuantities } from '@/lib/inventoryAvailability';
import { DEFAULT_SOURCE_NAME, SOURCE_NAME_OPTIONS, normalizeSourceName } from '../../shared/sourceNames.js';

const CATEGORY_COLORS = {
  proteins_meat: 'bg-red-100 text-red-700',
  proteins_poultry: 'bg-orange-100 text-orange-700',
  proteins_seafood: 'bg-blue-100 text-blue-700',
  proteins_plant: 'bg-green-100 text-green-700',
  vegetables: 'bg-emerald-100 text-emerald-700',
  fruits: 'bg-yellow-100 text-yellow-700',
  grains_cereals: 'bg-amber-100 text-amber-700',
  dairy: 'bg-sky-100 text-sky-700',
  oils_fats: 'bg-lime-100 text-lime-700',
  herbs_spices: 'bg-purple-100 text-purple-700',
  sauces_condiments: 'bg-pink-100 text-pink-700',
  sweeteners: 'bg-rose-100 text-rose-700',
  beverages: 'bg-cyan-100 text-cyan-700',
  other: 'bg-slate-100 text-slate-700'
};

const STATUS_COLORS = {
  in_stock: 'bg-emerald-100 text-emerald-700',
  low_stock: 'bg-amber-100 text-amber-700',
  out_of_stock: 'bg-red-100 text-red-700',
  expired: 'bg-purple-100 text-purple-700'
};

const formatQuantity = (value) => Number(value || 0).toLocaleString(undefined, {
  maximumFractionDigits: 3
});

const normalizeCategoryKey = (value) => String(value || 'other')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '') || 'other';

const formatCategoryLabel = (value) => String(value || 'Other')
  .replace(/_/g, ' ');

function DeleteImpactDetails({ impact, loading, error }) {
  if (loading) {
    return <p className="text-sm text-slate-500">Checking linked records before deletion...</p>;
  }
  if (error) {
    return <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{error}</p>;
  }
  if (!impact) return null;
  if (!impact.has_linkages) {
    return (
      <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        No obvious linked records were found. The server will check again before deleting.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">
        Linked records were found. Deletion may be blocked to protect recipes, inventory history, production, and reports.
      </p>
      <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3">
        {(impact.linkages || []).map((linkage) => (
          <div key={linkage.area} className="text-sm">
            <p className="font-semibold text-slate-800">{linkage.area}: {linkage.count}</p>
            {Array.isArray(linkage.examples) && linkage.examples.length > 0 ? (
              <p className="text-xs text-slate-500">{linkage.examples.join(', ')}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Ingredients() {
  const { can, isAdmin } = usePermissions();
  const canManageIngredients = can('manage_ingredients');
  const canManageInventory = can('manage_inventory');
  const canDeleteRecords = isAdmin;
  const [activeTab, setActiveTab] = useState('ingredients');

  // Ingredients state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedSourceName, setSelectedSourceName] = useState('all');
  const [viewMode, setViewMode] = useState('list');
  const [formOpen, setFormOpen] = useState(false);
  const [editingIngredient, setEditingIngredient] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [ingredientToDelete, setIngredientToDelete] = useState(null);
  const [ingredientDeleteImpact, setIngredientDeleteImpact] = useState(null);
  const [ingredientDeleteError, setIngredientDeleteError] = useState('');
  const [ingredientDeleteLoading, setIngredientDeleteLoading] = useState(false);

  // Inventory state
  const [invSearch, setInvSearch] = useState('');
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedInventorySourceName, setSelectedInventorySourceName] = useState('all');
  const [stockFormOpen, setStockFormOpen] = useState(false);
  const [transactionDialog, setTransactionDialog] = useState({ open: false, item: null, type: 'addition' });
  const [editDialog, setEditDialog] = useState({ open: false, item: null });
  const [historyDialog, setHistoryDialog] = useState({ open: false, item: null });
  const [inventoryDeleteDialog, setInventoryDeleteDialog] = useState({ open: false, item: null, impact: null, error: '', loading: false });
  const [stockForm, setStockForm] = useState({
    site_id: '',
    ingredient_id: '',
    quantity: '',
    unit_cost: '',
    batch_number: '',
    stock_date: format(new Date(), 'yyyy-MM-dd'),
    expiry_date: '',
    min_stock_level: '',
    max_stock_level: '',
    valuation_method: 'fifo',
    source_name: DEFAULT_SOURCE_NAME
  });
  const [selectedStockIngredient, setSelectedStockIngredient] = useState(null);

  const queryClient = useQueryClient();

  const { data: ingredients = [], isLoading: ingLoading } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });
  const stockSites = sites.filter((site) => (
    site.is_active !== false
    && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
  ));

  const { data: inventory = [], isLoading: invLoading } = useQuery({
    queryKey: ['inventory', 'stock-on-hand'],
    queryFn: () => base44.inventory.getStockOnHand()
  });

  useEffect(() => {
    const unsub = base44.entities.Inventory.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['ingredients'] });
    });
    return unsub;
  }, [queryClient]);

  // Ingredient mutations
  const invalidateIngredientQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['ingredients'] });
    queryClient.invalidateQueries({ queryKey: ['ingredient-search'] });
    queryClient.invalidateQueries({ queryKey: ['recipes'] });
  };

  const createIngMutation = useMutation({
    mutationFn: (data) => base44.entities.Ingredient.create(data),
    onSuccess: () => { invalidateIngredientQueries(); setFormOpen(false); }
  });
  const updateIngMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Ingredient.update(id, data),
    onSuccess: () => { invalidateIngredientQueries(); setFormOpen(false); setEditingIngredient(null); }
  });
  const deleteIngMutation = useMutation({
    mutationFn: (id) => base44.entities.Ingredient.delete(id),
    onSuccess: () => {
      invalidateIngredientQueries();
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setDeleteDialogOpen(false);
      setIngredientToDelete(null);
      setIngredientDeleteImpact(null);
      setIngredientDeleteError('');
      setIngredientDeleteLoading(false);
    },
    onError: (error) => setIngredientDeleteError(error.message || 'Ingredient could not be deleted.')
  });

  // Inventory mutations
  const receiveInvMutation = useMutation({
    mutationFn: (data) => base44.inventory.receive(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['inventory'] }); setStockFormOpen(false); resetStockForm(); }
  });
  const deleteInvMutation = useMutation({
    mutationFn: (id) => base44.entities.Inventory.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['ingredients'] });
      setInventoryDeleteDialog({ open: false, item: null, impact: null, error: '', loading: false });
    },
    onError: (error) => setInventoryDeleteDialog((current) => ({
      ...current,
      error: error.message || 'Inventory record could not be deleted.'
    }))
  });

  const resetStockForm = () => {
    setStockForm({
      site_id: '',
      ingredient_id: '',
      quantity: '',
      unit_cost: '',
      batch_number: '',
      stock_date: format(new Date(), 'yyyy-MM-dd'),
      expiry_date: '',
      min_stock_level: '',
      max_stock_level: '',
      valuation_method: 'fifo',
      source_name: DEFAULT_SOURCE_NAME
    });
    setSelectedStockIngredient(null);
  };

  const stockSummaryByIngredient = inventory.reduce((summary, item) => {
    const ingredientId = String(item.ingredient_id || '');
    if (!ingredientId) return summary;
    const quantities = getInventoryQuantities(item);
    const existing = summary[ingredientId] || {
      on_hand_quantity: 0,
      reserved_quantity: 0,
      available_quantity: 0,
      total_value: 0,
      site_count: 0,
      sites: new Set(),
      unit: item.unit || ''
    };
    existing.on_hand_quantity += Number(quantities.on_hand_quantity || 0);
    existing.reserved_quantity += Number(quantities.reserved_quantity || 0);
    existing.available_quantity += Number(quantities.available_quantity || 0);
    existing.total_value += Number(item.total_value || 0);
    existing.unit = existing.unit || item.unit || '';
    if (item.site_id) existing.sites.add(String(item.site_id));
    existing.site_count = existing.sites.size;
    summary[ingredientId] = existing;
    return summary;
  }, {});

  const ingredientsWithStock = ingredients.map((ingredient) => {
    const stock = stockSummaryByIngredient[String(ingredient.id)] || null;
    return {
      ...ingredient,
      stock_summary: stock ? {
        ...stock,
        on_hand_quantity: Number(stock.on_hand_quantity.toFixed(6)),
        reserved_quantity: Number(stock.reserved_quantity.toFixed(6)),
        available_quantity: Number(stock.available_quantity.toFixed(6)),
        total_value: Number(stock.total_value.toFixed(2)),
        sites: undefined
      } : {
        on_hand_quantity: 0,
        reserved_quantity: 0,
        available_quantity: 0,
        total_value: 0,
        site_count: 0,
        unit: ingredient.unit || ''
      }
    };
  });

  const categoryOptions = useMemo(() => {
    const options = new Map();
    ingredients.forEach((ingredient) => {
      const value = ingredient.category;
      const key = normalizeCategoryKey(value);
      if (key && value) options.set(key, formatCategoryLabel(value));
    });
    inventory.forEach((item) => {
      const ingredient = ingredients.find((candidate) => String(candidate.id) === String(item.ingredient_id));
      const value = ingredient?.category || item.category;
      const key = normalizeCategoryKey(value);
      if (key && value) options.set(key, formatCategoryLabel(value));
    });
    return [
      { value: 'all', label: 'All Categories' },
      ...Array.from(options.entries())
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label))
    ];
  }, [ingredients, inventory]);

  // Filtered data
  const filteredIngredients = ingredientsWithStock.filter(ing => {
    const normalizedSearch = searchQuery.toLowerCase();
    const matchesSearch = ing.name?.toLowerCase().includes(normalizedSearch) ||
      getItemCode(ing, '').toLowerCase().includes(normalizedSearch);
    const matchesCategory = selectedCategory === 'all' || normalizeCategoryKey(ing.category) === selectedCategory;
    const matchesSource = selectedSourceName === 'all' || normalizeSourceName(ing.source_name) === selectedSourceName;
    return matchesSearch && matchesCategory && matchesSource;
  });

  // Inventory enriched with ingredient nutritional data
  const enrichedInventory = inventory
    .map(item => {
      const ing = ingredients.find(i => i.id === item.ingredient_id);
      return {
        ...item,
        ...getInventoryQuantities(item),
        _ing: ing,
        item_code: getItemCodeFromRecords([ing, item]),
        category: ing?.category || item.category || 'other',
        ingredient_item_code: getItemCode(ing, ''),
        inventory_item_code: getItemCode(item, '')
      };
    })
    .filter(item => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSource = selectedInventorySourceName === 'all' || normalizeSourceName(item.source_name) === selectedInventorySourceName;
      const normalizedSearch = invSearch.toLowerCase();
      const matchesSearch = item.ingredient_name?.toLowerCase().includes(normalizedSearch) ||
        item.item_code.toLowerCase().includes(normalizedSearch);
      return matchesSite && matchesSearch && matchesSource;
    });

  const lowStock = enrichedInventory.filter(i => i.status === 'low_stock').length;
  const outOfStock = enrichedInventory.filter(i => i.status === 'out_of_stock').length;

  const handleIngSubmit = (data) => {
    if (editingIngredient) {
      updateIngMutation.mutate({ id: editingIngredient.id, data });
    } else {
      createIngMutation.mutate(data);
    }
  };

  const openIngredientDeleteDialog = async (ingredient) => {
    if (!canDeleteRecords) return;
    setIngredientToDelete(ingredient);
    setDeleteDialogOpen(true);
    setIngredientDeleteImpact(null);
    setIngredientDeleteError('');
    setIngredientDeleteLoading(true);
    try {
      const impact = await base44.entities.Ingredient.deleteImpact(ingredient.id);
      setIngredientDeleteImpact(impact);
    } catch (error) {
      setIngredientDeleteError(error.message || 'Could not load deletion warning details.');
    } finally {
      setIngredientDeleteLoading(false);
    }
  };

  const openInventoryDeleteDialog = async (item) => {
    if (!canDeleteRecords) return;
    setInventoryDeleteDialog({ open: true, item, impact: null, error: '', loading: true });
    try {
      const impact = await base44.entities.Inventory.deleteImpact(item.id);
      setInventoryDeleteDialog({ open: true, item, impact, error: '', loading: false });
    } catch (error) {
      setInventoryDeleteDialog({
        open: true,
        item,
        impact: null,
        error: error.message || 'Could not load deletion warning details.',
        loading: false
      });
    }
  };

  const handleStockSubmit = (e) => {
    e.preventDefault();
    const site = stockSites.find(s => s.id === stockForm.site_id);
    const ing = selectedStockIngredient || ingredients.find(i => i.id === stockForm.ingredient_id);
    const qty = parseFloat(stockForm.quantity) || 0;
    const min = parseFloat(stockForm.min_stock_level) || 0;
    if (!site || !ing || qty <= 0 || !stockForm.stock_date) return;
    receiveInvMutation.mutate({
      site_id: stockForm.site_id,
      site_name: site?.name || '',
      ingredient_id: stockForm.ingredient_id,
      ingredient_name: ing?.name || '',
      quantity: qty,
      unit: ing?.unit || 'kg',
      unit_cost: parseFloat(stockForm.unit_cost) || 0,
      source_name: stockForm.source_name,
      batch_number: stockForm.batch_number,
      stock_date: stockForm.stock_date,
      received_date: stockForm.stock_date,
      transaction_date: stockForm.stock_date,
      min_stock_level: min,
      max_stock_level: parseFloat(stockForm.max_stock_level) || null,
      valuation_method: stockForm.valuation_method,
      expiry_date: stockForm.expiry_date || null,
      reference_type: 'manual',
      reason_code: 'manual_receipt',
      notes: 'Stock received from Ingredients & Inventory'
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader
          title="Ingredients & Inventory"
          description="Unified ingredient master data with real-time on-hand, production-reserved, and available stock."
        >
          {activeTab === 'ingredients' ? (
            <>
              <Button variant="outline" onClick={() => downloadCSV(
                filteredIngredients.map((ingredient) => putItemCodeAndNameFirst(ingredient, { outputNameKey: 'item_name' })),
                'ingredients'
              )}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              {canManageIngredients ? (
                <Button onClick={() => { setEditingIngredient(null); setFormOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
                  <Plus className="w-4 h-4 mr-2" /> Add Ingredient
                </Button>
              ) : null}
            </>
          ) : activeTab === 'inventory' ? (
            <>
              <Button variant="outline" onClick={() => downloadCSV(
                enrichedInventory.map((item) => putItemCodeAndNameFirst(item, {
                  nameKey: 'ingredient_name',
                  outputNameKey: 'ingredient_name',
                  itemCode: item.item_code
                })),
                'inventory'
              )}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              {canManageInventory ? (
                <Button onClick={() => setStockFormOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                  <Plus className="w-4 h-4 mr-2" /> Add Stock
                </Button>
              ) : null}
            </>
          ) : null}
        </PageHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList className="mb-6">
            <TabsTrigger value="ingredients">
              <Package className="w-4 h-4 mr-2" /> Ingredients ({ingredients.length})
            </TabsTrigger>
            <TabsTrigger value="inventory">
              <AlertTriangle className="w-4 h-4 mr-2" /> Inventory ({inventory.length})
            </TabsTrigger>
            <TabsTrigger value="stock-change-log">
              <History className="w-4 h-4 mr-2" /> Stock Change Log
            </TabsTrigger>
          </TabsList>

          {/* ── INGREDIENTS TAB ── */}
          <TabsContent value="ingredients">
            {/* Filters */}
            <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search by name or item code..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                  <SelectTrigger className="w-full sm:w-[200px]">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map(cat => (
                      <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={selectedSourceName} onValueChange={setSelectedSourceName}>
                  <SelectTrigger className="w-full sm:w-[160px]">
                    <SelectValue placeholder="Source Name" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sources</SelectItem>
                    {SOURCE_NAME_OPTIONS.map((source) => (
                      <SelectItem key={source} value={source}>{source}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                  <Button variant={viewMode === 'grid' ? 'default' : 'ghost'} size="icon"
                    onClick={() => setViewMode('grid')} className={viewMode === 'grid' ? 'bg-white shadow-sm' : ''}>
                    <LayoutGrid className="w-4 h-4" />
                  </Button>
                  <Button variant={viewMode === 'list' ? 'default' : 'ghost'} size="icon"
                    onClick={() => setViewMode('list')} className={viewMode === 'list' ? 'bg-white shadow-sm' : ''}>
                    <List className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            {ingLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
              </div>
            ) : filteredIngredients.length === 0 ? (
              <EmptyState icon={Package} title="No ingredients found"
                description={canManageIngredients ? 'Add your first ingredient to get started' : 'No ingredient records match the current filters'}
                {...(canManageIngredients ? {
                  actionLabel: 'Add Ingredient',
                  onAction: () => setFormOpen(true)
                } : {})} />
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredIngredients.map(ing => (
                  <IngredientCard key={ing.id} ingredient={ing}
                    onEdit={canManageIngredients ? (i) => { setEditingIngredient(i); setFormOpen(true); } : undefined}
                    onDelete={canDeleteRecords ? openIngredientDeleteDialog : undefined} />
                ))}
              </div>
            ) : (
              <Card className="border-slate-100">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Source Name</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead className="text-right">On Hand</TableHead>
                        <TableHead className="text-right">Available</TableHead>
                        <TableHead>Conversion Unit</TableHead>
                        <TableHead className="text-center">Cal/100g</TableHead>
                        <TableHead className="text-center">Protein</TableHead>
                        <TableHead className="text-center">Fat</TableHead>
                        <TableHead className="text-center">Carbs</TableHead>
                        <TableHead className="text-center">Sodium</TableHead>
                        <TableHead className="text-center">Sugar</TableHead>
                        <TableHead>Allergens</TableHead>
                        <TableHead>Cost/Unit</TableHead>
                        <TableHead>Yield %</TableHead>
                        {canManageIngredients || canDeleteRecords ? <TableHead className="w-[120px]">Actions</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredIngredients.map(ing => (
                        <TableRow key={ing.id}>
                          <TableCell className="text-slate-500 text-sm">{getItemCode(ing)}</TableCell>
                          <TableCell className="font-medium">{ing.name}</TableCell>
                          <TableCell>
                            <Badge className={CATEGORY_COLORS[ing.category] || 'bg-slate-100 text-slate-700'}>
                              {ing.category?.replace(/_/g, ' ') || '-'}
                            </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
                                {normalizeSourceName(ing.source_name)}
                              </Badge>
                            </TableCell>
                            <TableCell>{ing.unit}</TableCell>
                          <TableCell className="text-right">
                            <span className="font-semibold text-slate-900">
                              {formatQuantity(ing.stock_summary?.on_hand_quantity)}
                            </span>
                            <span className="ml-1 text-xs text-slate-500">{ing.stock_summary?.unit || ing.unit || ''}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="font-semibold text-cyan-800">
                              {formatQuantity(ing.stock_summary?.available_quantity)}
                            </span>
                            <span className="ml-1 text-xs text-slate-500">{ing.stock_summary?.unit || ing.unit || ''}</span>
                          </TableCell>
                          <TableCell>{ing.conversion_unit || '-'}</TableCell>
                          <TableCell className="text-center">
                            <span className="inline-flex items-center gap-1 text-orange-600 font-medium">
                              <Flame className="w-3 h-3" />{ing.calories_per_100g ?? '-'}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <Beef className="w-3 h-3" />{ing.protein_per_100g != null ? `${ing.protein_per_100g}g` : '-'}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="inline-flex items-center gap-1 text-yellow-600">
                              <Droplet className="w-3 h-3" />{ing.fat_per_100g != null ? `${ing.fat_per_100g}g` : '-'}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">{ing.carbs_per_100g != null ? `${ing.carbs_per_100g}g` : '-'}</TableCell>
                          <TableCell className="text-center">{ing.sodium_per_100g != null ? `${ing.sodium_per_100g}mg` : '-'}</TableCell>
                          <TableCell className="text-center">
                            <span className="inline-flex items-center gap-1 text-pink-600">
                              <Candy className="w-3 h-3" />{ing.sugar_per_100g != null ? `${ing.sugar_per_100g}g` : '-'}
                            </span>
                          </TableCell>
                          <TableCell>
                            {Array.isArray(ing.allergens) && ing.allergens.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {ing.allergens.slice(0, 3).map((allergen) => (
                                  <Badge key={allergen} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                                    {allergen}
                                  </Badge>
                                ))}
                                {ing.allergens.length > 3 ? (
                                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
                                    +{ing.allergens.length - 3}
                                  </Badge>
                                ) : null}
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                                <ShieldAlert className="h-3 w-3" />
                                none
                              </span>
                            )}
                          </TableCell>
                          <TableCell>{ing.cost_per_unit != null ? formatCurrency(ing.cost_per_unit) : '-'}</TableCell>
                          <TableCell>{ing.cooking_yield_percent ? `${ing.cooking_yield_percent}%` : '-'}</TableCell>
                          {canManageIngredients || canDeleteRecords ? (
                            <TableCell>
                              <div className="flex gap-1">
                                {canManageIngredients ? (
                                  <Button variant="ghost" size="sm" onClick={() => { setEditingIngredient(ing); setFormOpen(true); }}>Edit</Button>
                                ) : null}
                                {canDeleteRecords ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                                    onClick={() => openIngredientDeleteDialog(ing)}
                                  >
                                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                                    Delete
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── INVENTORY TAB ── */}
          <TabsContent value="inventory">
            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <StatCard title="Total Items" value={enrichedInventory.length} icon={Package} iconBg="bg-blue-50" iconColor="text-blue-600" />
              <StatCard title="Low Stock" value={lowStock} icon={AlertTriangle} iconBg="bg-amber-50" iconColor="text-amber-600" />
              <StatCard title="Out of Stock" value={outOfStock} icon={Package} iconBg="bg-red-50" iconColor="text-red-600" />
            </div>

            <div className="mb-6">
              <InventoryAlerts inventory={enrichedInventory} upcomingNeeds={[]} />
            </div>

            {/* Filters */}
            <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input placeholder="Search inventory..." value={invSearch}
                    onChange={(e) => setInvSearch(e.target.value)} className="pl-10" />
                </div>
                <Select value={selectedSite} onValueChange={setSelectedSite}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sites</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={selectedInventorySourceName} onValueChange={setSelectedInventorySourceName}>
                  <SelectTrigger className="w-full sm:w-[160px]">
                    <SelectValue placeholder="Source Name" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sources</SelectItem>
                    {SOURCE_NAME_OPTIONS.map((source) => (
                      <SelectItem key={source} value={source}>{source}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {invLoading ? (
              <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
            ) : enrichedInventory.length === 0 ? (
              <EmptyState icon={Package} title="No inventory records"
                description={canManageInventory ? 'Start tracking your ingredient stock' : 'No inventory records match the current filters'}
                {...(canManageInventory ? {
                  actionLabel: 'Add Stock',
                  onAction: () => setStockFormOpen(true)
                } : {})} />
            ) : (
              <Card className="border-slate-100">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Site</TableHead>
                        <TableHead>Source Name</TableHead>
                        <TableHead>On Hand</TableHead>
                        <TableHead>Reserved</TableHead>
                        <TableHead>Available</TableHead>
                        <TableHead className="text-center">Cal/100g</TableHead>
                        <TableHead className="text-center">Total Cal</TableHead>
                        <TableHead className="text-center">Protein</TableHead>
                        <TableHead className="text-center">Fat</TableHead>
                        <TableHead>Stock Level</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Next Expiry</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {enrichedInventory.map(item => {
                        const ing = item._ing;
                        const stockPct = item.max_stock_level ? Math.min(100, (item.available_quantity / item.max_stock_level) * 100) : 50;
                        // Total calories: qty in kg * 1000g/kg * cal_per_100g / 100
                        const totalCal = ing?.calories_per_100g && item.on_hand_quantity
                          ? Math.round((item.on_hand_quantity * 1000 * ing.calories_per_100g) / 100)
                          : null;
                        return (
                          <TableRow key={item.id}>
                            <TableCell className="text-sm font-medium text-slate-600">{item.item_code}</TableCell>
                            <TableCell className="font-medium">{item.ingredient_name}</TableCell>
                            <TableCell>
                              <Badge className={CATEGORY_COLORS[normalizeCategoryKey(item.category)] || 'bg-slate-100 text-slate-700'}>
                                {formatCategoryLabel(item.category)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-slate-500 text-sm">{item.site_name}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
                                {normalizeSourceName(item.source_name)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <span className="font-semibold">{item.on_hand_quantity}</span> <span className="text-slate-500 text-xs">{item.unit}</span>
                            </TableCell>
                            <TableCell>
                              <span className="font-semibold text-violet-700">{item.reserved_quantity}</span> <span className="text-slate-500 text-xs">{item.unit}</span>
                            </TableCell>
                            <TableCell>
                              <span className="font-semibold text-cyan-800">{item.available_quantity}</span> <span className="text-slate-500 text-xs">{item.unit}</span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-orange-600 font-medium">
                                <Flame className="w-3 h-3" />{ing?.calories_per_100g ?? '-'}
                              </span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="text-orange-700 font-medium">{totalCal != null ? totalCal.toLocaleString() : '-'}</span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-red-600">
                                <Beef className="w-3 h-3" />{ing?.protein_per_100g != null ? `${ing.protein_per_100g}g` : '-'}
                              </span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-yellow-600">
                                <Droplet className="w-3 h-3" />{ing?.fat_per_100g != null ? `${ing.fat_per_100g}g` : '-'}
                              </span>
                            </TableCell>
                            <TableCell className="w-32">
                              <Progress value={stockPct} className="h-2" />
                              <p className="text-xs text-slate-500 mt-1">Min: {item.min_stock_level || 0}</p>
                            </TableCell>
                            <TableCell>
                              <Badge className={STATUS_COLORS[item.status]}>
                                {item.status?.replace(/_/g, ' ')}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <p>{(item.next_expiry_date || item.expiry_date) ? format(new Date(item.next_expiry_date || item.expiry_date), 'MMM d, yyyy') : '-'}</p>
                              <p className="text-xs text-slate-500">{item.available_batch_count || 0} available batches</p>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1 justify-end">
                                {canManageInventory ? (
                                  <>
                                    <Button variant="outline" size="sm" onClick={() => setTransactionDialog({ open: true, item, type: 'addition' })} title="Add Stock"><PlusCircle className="w-4 h-4" /></Button>
                                    <Button variant="outline" size="sm" onClick={() => setTransactionDialog({ open: true, item, type: 'issuance' })} title="Issue Stock"><MinusCircle className="w-4 h-4" /></Button>
                                    <Button variant="outline" size="sm" onClick={() => setEditDialog({ open: true, item })} title="Edit"><Edit className="w-4 h-4" /></Button>
                                  </>
                                ) : null}
                                {canDeleteRecords ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                                    onClick={() => openInventoryDeleteDialog(item)}
                                    title="Delete"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                ) : null}
                                <Button variant="outline" size="sm" onClick={() => setHistoryDialog({ open: true, item })} title="History"><History className="w-4 h-4" /></Button>
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
          </TabsContent>

          <TabsContent value="stock-change-log">
            <StockChangeLog
              title="Ingredient Stock Change Log"
              description="Review stock changes for linked ingredients, including bulk uploads, manual receipts, production use, corrections, and transfers."
              sites={stockSites}
              ingredients={ingredients}
            />
          </TabsContent>
        </Tabs>

        {/* Ingredient Form */}
        <IngredientForm
          open={canManageIngredients && formOpen}
          onClose={() => { setFormOpen(false); setEditingIngredient(null); }}
          onSubmit={handleIngSubmit}
          ingredient={editingIngredient}
          isLoading={createIngMutation.isPending || updateIngMutation.isPending}
        />

        {/* Delete Ingredient */}
        <AlertDialog open={canDeleteRecords && deleteDialogOpen} onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setIngredientToDelete(null);
            setIngredientDeleteImpact(null);
            setIngredientDeleteError('');
            setIngredientDeleteLoading(false);
          }
        }}>
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Ingredient</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    Delete "{getItemCode(ingredientToDelete)} · {ingredientToDelete?.name || '—'}"? This action cannot be undone.
                  </p>
                  <DeleteImpactDetails
                    impact={ingredientDeleteImpact}
                    loading={ingredientDeleteLoading}
                    error={ingredientDeleteError}
                  />
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => ingredientToDelete?.id && deleteIngMutation.mutate(ingredientToDelete.id)}
                disabled={deleteIngMutation.isPending || ingredientDeleteLoading || !ingredientToDelete?.id}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteIngMutation.isPending ? 'Deleting...' : 'Delete Ingredient'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={canDeleteRecords && inventoryDeleteDialog.open} onOpenChange={(open) => {
          setInventoryDeleteDialog((current) => ({
            ...current,
            open,
            ...(open ? {} : { item: null, impact: null, error: '', loading: false })
          }));
        }}>
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Inventory Record</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    Delete "{getItemCodeFromRecords([inventoryDeleteDialog.item?._ing, inventoryDeleteDialog.item])} · {inventoryDeleteDialog.item?.ingredient_name || '—'}" for {inventoryDeleteDialog.item?.site_name || 'this site'}?
                  </p>
                  <p className="text-xs text-slate-500">
                    Inventory with stock, batches, reservations, or transactions should normally be cleared through stock movements. This delete is for admin cleanup of empty/unlinked records only.
                  </p>
                  <DeleteImpactDetails
                    impact={inventoryDeleteDialog.impact}
                    loading={inventoryDeleteDialog.loading}
                    error={inventoryDeleteDialog.error}
                  />
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => inventoryDeleteDialog.item?.id && deleteInvMutation.mutate(inventoryDeleteDialog.item.id)}
                disabled={deleteInvMutation.isPending || inventoryDeleteDialog.loading || !inventoryDeleteDialog.item?.id}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteInvMutation.isPending ? 'Deleting...' : 'Delete Inventory'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Stock Form */}
        <Dialog open={canManageInventory && stockFormOpen} onOpenChange={setStockFormOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Add Inventory Stock</DialogTitle></DialogHeader>
            <form onSubmit={handleStockSubmit} className="space-y-4">
              <div>
                <Label>Site *</Label>
                <Select value={stockForm.site_id} onValueChange={(v) => setStockForm({ ...stockForm, site_id: v })}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Select site" /></SelectTrigger>
                  <SelectContent>{stockSites.map(s => <SelectItem key={s.id} value={s.id}>{s.hierarchy_path || s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
                <div>
                  <Label>Ingredient *</Label>
                  <IngredientSearchCombobox
                    className="mt-1"
                    value={stockForm.ingredient_id}
                    selectedIngredient={selectedStockIngredient || ingredients.find((item) => item.id === stockForm.ingredient_id)}
                    siteId={stockForm.site_id}
                    onValueChange={(value, ingredient) => {
                      setSelectedStockIngredient(ingredient);
                      setStockForm((current) => ({
                        ...current,
                        ingredient_id: value,
                        unit_cost: current.unit_cost || String(ingredient?.last_cost ?? ingredient?.cost_per_unit ?? '')
                      }));
                    }}
                  />
                </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Source Name *</Label>
                  <Select value={stockForm.source_name} onValueChange={(value) => setStockForm({ ...stockForm, source_name: value })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select source" /></SelectTrigger>
                    <SelectContent>
                      {SOURCE_NAME_OPTIONS.map((source) => (
                        <SelectItem key={source} value={source}>{source}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Quantity *</Label>
                  <Input type="number" min="0.001" step="0.001" value={stockForm.quantity} onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })} className="mt-1" required />
                </div>
                <div>
                  <Label>Unit Cost</Label>
                  <Input type="number" min="0" step="0.01" value={stockForm.unit_cost} onChange={(e) => setStockForm({ ...stockForm, unit_cost: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label>Batch / Lot</Label>
                  <Input value={stockForm.batch_number} onChange={(e) => setStockForm({ ...stockForm, batch_number: e.target.value })} className="mt-1" placeholder="Generated automatically when blank" />
                </div>
                <div>
                  <Label>Stock Date *</Label>
                  <Input type="date" required value={stockForm.stock_date} onChange={(e) => setStockForm({ ...stockForm, stock_date: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label>Expiry Date</Label>
                  <Input type="date" min={stockForm.stock_date || undefined} value={stockForm.expiry_date} onChange={(e) => setStockForm({ ...stockForm, expiry_date: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label>Valuation Method</Label>
                  <Select value={stockForm.valuation_method} onValueChange={(value) => setStockForm({ ...stockForm, valuation_method: value })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fifo">FIFO</SelectItem>
                      <SelectItem value="weighted_average">Weighted Average</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Min Level</Label>
                  <Input type="number" min="0" step="0.1" value={stockForm.min_stock_level} onChange={(e) => setStockForm({ ...stockForm, min_stock_level: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label>Max Level</Label>
                  <Input type="number" min="0" step="0.1" value={stockForm.max_stock_level} onChange={(e) => setStockForm({ ...stockForm, max_stock_level: e.target.value })} className="mt-1" />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setStockFormOpen(false); resetStockForm(); }}>Cancel</Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={receiveInvMutation.isPending}>
                  {receiveInvMutation.isPending ? 'Adding...' : 'Add Stock'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Inventory dialogs */}
        <InventoryTransactionDialog
          open={canManageInventory && transactionDialog.open}
          onOpenChange={(open) => setTransactionDialog({ ...transactionDialog, open })}
          inventoryItem={transactionDialog.item}
          transactionType={transactionDialog.type}
        />
        <InventoryEditDialog
          open={canManageInventory && editDialog.open}
          onOpenChange={(open) => setEditDialog({ ...editDialog, open })}
          inventoryItem={editDialog.item}
        />
        <Dialog open={historyDialog.open} onOpenChange={(open) => setHistoryDialog({ ...historyDialog, open })}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                Transaction History — {getItemCodeFromRecords([historyDialog.item?._ing, historyDialog.item])} · {historyDialog.item?.ingredient_name || '—'}
              </DialogTitle>
            </DialogHeader>
            {historyDialog.item && (
              <InventoryHistory ingredientId={historyDialog.item.ingredient_id} siteId={historyDialog.item.site_id} />
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
