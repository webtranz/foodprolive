import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  CalendarClock,
  Download,
  Edit,
  FileSpreadsheet,
  History,
  LockKeyhole,
  Package,
  PackageCheck,
  Plus,
  PlusCircle,
  Search,
  SlidersHorizontal,
  TrendingDown,
  Trash2,
  Upload,
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
import IngredientSearchCombobox from '@/components/ingredients/IngredientSearchCombobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import StatCard from '@/components/ui/StatCard';
import { downloadCSV } from '../components/utils/exportData';
import { formatCurrency } from '@/lib/currency';
import { getItemCode, getItemCodeFromRecords, putItemCodeAndNameFirst } from '../../shared/itemCode.js';
import { convertIngredientQuantity } from '../../shared/ingredientUnits.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';
import { DEFAULT_SOURCE_NAME, SOURCE_NAME_OPTIONS, normalizeSourceName } from '../../shared/sourceNames.js';
import {
  getAvailableInventoryQuantity,
  getInventoryQuantities,
  getProductionInventoryState
} from '@/lib/inventoryAvailability';

const STATUS_COLORS = {
  in_stock: 'bg-emerald-100 text-emerald-700',
  low_stock: 'bg-amber-100 text-amber-700',
  out_of_stock: 'bg-red-100 text-red-700',
  expired: 'bg-rose-100 text-rose-700'
};

const UNAVAILABLE_LOT_STATUSES = new Set([
  'blocked', 'quarantined', 'quarantine', 'hold', 'on_hold', 'recalled', 'expired'
]);

function getLotDisplayStatus(lot) {
  if (Number(lot?.remaining_quantity || 0) <= 0) return 'consumed';
  const persisted = String(lot?.status || 'active').trim().toLowerCase();
  if (lot?.expiry_date && lot.expiry_date < format(new Date(), 'yyyy-MM-dd')) return 'expired';
  if (UNAVAILABLE_LOT_STATUSES.has(persisted)) return persisted;
  return 'active';
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2
  });
}

function formatOptionalQuantity(value, unit = '') {
  if (value === null || typeof value === 'undefined' || value === '') return '-';
  const numeric = Number(value);
  const displayValue = Number.isFinite(numeric) ? formatQuantity(numeric) : String(value);
  return `${displayValue}${unit ? ` ${unit}` : ''}`;
}

function addUnitQuantity(summary, unit, quantity) {
  const key = String(unit || 'unit').trim() || 'unit';
  summary[key] = Number(summary[key] || 0) + Number(quantity || 0);
  return summary;
}

function formatUnitQuantities(summary = {}) {
  const entries = Object.entries(summary).filter(([, quantity]) => Math.abs(Number(quantity || 0)) > 0.000001);
  if (entries.length === 0) return '0';
  const visible = entries.slice(0, 4).map(([unit, quantity]) => `${formatQuantity(quantity)} ${unit}`);
  return `${visible.join(' · ')}${entries.length > 4 ? ` · +${entries.length - 4} units` : ''}`;
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`;
}

function formatDisplayDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

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
        Linked records were found. Deletion may be blocked to protect stock history, production, procurement, and reports.
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

function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase();
}

function toSafeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeHeader(value) {
  return normalizeLookup(value).replace(/[^a-z0-9]+/g, '_');
}

function pickValue(row, aliases) {
  for (const alias of aliases) {
    const aliasKey = normalizeHeader(alias);
    const matchKey = Object.keys(row).find((key) => normalizeHeader(key) === aliasKey);
    if (matchKey && row[matchKey] !== '' && row[matchKey] !== null && typeof row[matchKey] !== 'undefined') {
      return row[matchKey];
    }
  }
  return '';
}

function excelDateToDateOnly(value) {
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    return parsed.toISOString().slice(0, 10);
  }
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function getStockDate(record) {
  return record?.stock_date || record?.received_date || record?.receipt_date || record?.transaction_date || '';
}

function getLotAgeDays(record) {
  if (Number.isFinite(Number(record?.age_days))) return Number(record.age_days);
  const stockDate = getStockDate(record);
  if (!stockDate) return null;
  const parsed = new Date(`${stockDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000));
}

function getMovementSource(record) {
  return record?.source_label || record?.source || record?.movement_source || record?.reference_type || record?.reason_code || record?.transaction_type || '-';
}

function getReference(record) {
  return record?.reference_name || record?.reference_number || record?.reference_id || record?.external_reference || '-';
}

function getPostedDate(record) {
  return record?.created_date || record?.created_at || record?.updated_date || record?.transaction_date || '';
}

function getOpeningQuantity(record) {
  const value = record?.opening_quantity ?? record?.quantity_before ?? record?.opening_balance;
  return typeof value === 'undefined' || value === null ? null : Number(value);
}

function getClosingQuantity(record) {
  const value = record?.closing_quantity ?? record?.quantity_after ?? record?.running_balance ?? record?.closing_balance;
  return typeof value === 'undefined' || value === null ? null : Number(value);
}

function getAdditionQuantity(record) {
  if (record?.addition_quantity !== null && typeof record?.addition_quantity !== 'undefined') return Number(record.addition_quantity);
  const quantity = Number(record?.quantity || 0);
  return quantity > 0 ? quantity : 0;
}

function getConsumptionQuantity(record) {
  if (record?.consumption_quantity !== null && typeof record?.consumption_quantity !== 'undefined') return Math.abs(Number(record.consumption_quantity));
  const quantity = Number(record?.quantity || 0);
  return quantity < 0 ? Math.abs(quantity) : 0;
}

function getStockChangeQuantity(record) {
  const addition = getAdditionQuantity(record);
  if (addition > 0) return addition;
  const consumption = getConsumptionQuantity(record);
  if (consumption > 0) return -consumption;
  return Number(record?.quantity || 0);
}

function normalizeReportRows(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || result?.items || result?.lots || result?.data || [];
}

const STARTER_STOCK_BLUEPRINT = [
  ['Chicken Breast', 32, 5.8, 'fifo', 4],
  ['Basmati Rice', 90, 2.2, 'fifo', 90],
  ['Mixed Vegetables', 28, 1.9, 'fifo', 5],
  ['Arabic Flatbread', 180, 0.45, 'fifo', 3],
  ['Plain Yogurt', 18, 2.1, 'fifo', 6],
  ['Eggs', 240, 0.22, 'fifo', 8],
  ['Fresh Milk', 35, 1.4, 'fifo', 6],
  ['Tomato Sauce', 24, 1.8, 'weighted_average', 40],
  ['Penne Pasta', 30, 1.7, 'fifo', 120],
  ['Beef Mince', 20, 6.6, 'fifo', 4]
];

function resolveSiteByValue(sites, value, defaultSiteId = '') {
  const normalizedValue = normalizeLookup(value);
  const defaultSite = sites.find((site) => site.id === defaultSiteId) || null;
  if (!normalizedValue) return defaultSite;

  return sites.find((site) => (
    normalizeLookup(site.id) === normalizedValue ||
    normalizeLookup(site.name) === normalizedValue ||
    normalizeLookup(site.project_code) === normalizedValue ||
    normalizeLookup(site.hierarchy_path) === normalizedValue
  )) || null;
}

function resolveIngredientByValue(ingredients, value) {
  const normalizedValue = normalizeLookup(value);
  if (!normalizedValue) return null;

  return ingredients.find((ingredient) => (
    normalizeLookup(ingredient.id) === normalizedValue ||
    normalizeLookup(ingredient.name) === normalizedValue ||
    normalizeLookup(ingredient.item_code) === normalizedValue ||
    normalizeLookup(ingredient.ingredient_code) === normalizedValue ||
    normalizeLookup(ingredient.sku) === normalizedValue
  )) || null;
}

function withResolvedItemCode(record, ingredientById) {
  return {
    ...record,
    item_code: getItemCodeFromRecords([ingredientById.get(record?.ingredient_id), record])
  };
}

function buildBulkInventoryRows(rows, sites, ingredients, defaultSiteId = '') {
  const errors = [];
  const items = [];
  const previewRows = [];

  rows.forEach((row, index) => {
    const site = resolveSiteByValue(
      sites,
      pickValue(row, ['site_id', 'site_name', 'project', 'project_name', 'project_code', 'location', 'location_name', 'warehouse']),
      defaultSiteId
    );
    const ingredient = resolveIngredientByValue(
      ingredients,
      pickValue(row, ['item_code', 'ingredient_id', 'ingredient_name', 'ingredient', 'item_name', 'ingredient_code', 'sku'])
    );
    const quantity = toSafeNumber(pickValue(row, ['quantity', 'qty', 'opening_stock', 'stock_qty']), 0);
    const unitCost = toSafeNumber(pickValue(row, ['unit_cost', 'cost', 'avg_cost', 'cost_per_unit']), 0);
    const minStock = toSafeNumber(pickValue(row, ['min_stock_level', 'min_stock', 'minimum_level']), 0);
    const maxStockRaw = pickValue(row, ['max_stock_level', 'max_stock', 'maximum_level']);
    const maxStock = maxStockRaw === '' ? null : toSafeNumber(maxStockRaw, null);
    const valuationMethod = String(pickValue(row, ['valuation_method', 'cost_method']) || 'fifo').trim() || 'fifo';
    const batchNumber = String(pickValue(row, ['batch_number', 'batch', 'lot_number', 'lot']) || '').trim();
    const stockDate = excelDateToDateOnly(pickValue(row, ['stock_date', 'received_date', 'receipt_date'])) || format(new Date(), 'yyyy-MM-dd');
    const expiryDate = excelDateToDateOnly(pickValue(row, ['expiry_date', 'expiry', 'expiry_dt']));
    const notes = String(pickValue(row, ['notes', 'remarks', 'comment']) || '').trim();

    previewRows.push({
      row: index + 2,
      project: site?.name || '',
      item_code: getItemCode(ingredient),
      ingredient: ingredient?.name || '',
      quantity,
      unit_cost: unitCost,
      stock_date: stockDate,
      status: !site
        ? 'Project not found'
        : !ingredient
          ? 'Ingredient not found'
          : quantity <= 0
            ? 'Quantity must be greater than 0'
            : 'Ready'
    });

    if (!site) {
      errors.push(`Row ${index + 2}: project / site was not matched`);
      return;
    }

    if (!ingredient) {
      errors.push(`Row ${index + 2}: ingredient was not matched`);
      return;
    }

    if (quantity <= 0) {
      errors.push(`Row ${index + 2}: quantity must be greater than 0`);
      return;
    }

    items.push({
      item_code: getItemCode(ingredient),
      site_id: site.id,
      site_name: site.name,
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity,
      unit: ingredient.unit || 'kg',
      unit_cost: unitCost,
      batch_number: batchNumber || `BULK-${Date.now()}-${index + 1}`,
      stock_date: stockDate,
      received_date: stockDate,
      transaction_date: stockDate,
      expiry_date: expiryDate || null,
      min_stock_level: minStock,
      max_stock_level: typeof maxStock === 'number' ? maxStock : null,
      valuation_method: valuationMethod === 'weighted_average' ? 'weighted_average' : 'fifo',
      notes,
      reason_code: 'bulk_upload'
    });
  });

  return { items, errors, previewRows };
}

function buildStarterStockRows(site, ingredients) {
  if (!site) return [];

  return STARTER_STOCK_BLUEPRINT
    .map(([name, quantity, unitCost, valuationMethod, expiryDays], index) => {
      const ingredient = ingredients.find((entry) => normalizeLookup(entry.name) === normalizeLookup(name));
      if (!ingredient) return null;
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + expiryDays);
      const stockDate = format(new Date(), 'yyyy-MM-dd');

      return {
        site_id: site.id,
        site_name: site.name,
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name,
        quantity,
        unit: ingredient.unit || 'kg',
        unit_cost: unitCost,
        batch_number: `START-${String(site.project_code || site.name || 'SITE').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase()}-${String(index + 1).padStart(2, '0')}`,
        stock_date: stockDate,
        received_date: stockDate,
        transaction_date: stockDate,
        expiry_date: expiryDate.toISOString().slice(0, 10),
        min_stock_level: Math.max(1, Math.round(quantity * 0.25)),
        max_stock_level: Math.round(quantity * 1.8),
        valuation_method: valuationMethod,
        notes: 'Starter stock populated from Inventory module',
        reason_code: 'bulk_upload'
      };
    })
    .filter(Boolean);
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
  const availableInventory = inventory.filter((item) => (
    item.site_id === formData.from_site_id
    && getAvailableInventoryQuantity(item) > 0
  ));

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
          <DialogTitle>Transfer Stock Between Projects / Locations</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>From Project / Location</Label>
              <Select value={formData.from_site_id} onValueChange={(value) => setFormData((current) => ({ ...current, from_site_id: value }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select source project or location" />
                </SelectTrigger>
                <SelectContent>
                  {stockSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>To Project / Location</Label>
              <Select value={formData.to_site_id} onValueChange={(value) => setFormData((current) => ({ ...current, to_site_id: value }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select destination project or location" />
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
                    <TableHead>Item Code</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead>Available to Transfer</TableHead>
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
                        <TableCell className="text-sm font-medium text-slate-600">
                          {getItemCode(selectedInventory)}
                        </TableCell>
                        <TableCell>
                          <IngredientSearchCombobox
                            value={item.ingredient_id}
                            selectedIngredient={selectedInventory ? {
                              id: selectedInventory.ingredient_id,
                              name: selectedInventory.ingredient_name,
                              item_code: selectedInventory.item_code,
                              unit: selectedInventory.unit,
                              current_stock: getAvailableInventoryQuantity(selectedInventory)
                            } : null}
                            siteId={formData.from_site_id}
                            stockOnly
                            onValueChange={(value) => updateItem(index, 'ingredient_id', value)}
                          />
                        </TableCell>
                        <TableCell className="text-sm text-slate-600">
                          {selectedInventory ? `${formatQuantity(getAvailableInventoryQuantity(selectedInventory))} ${selectedInventory.unit}` : '-'}
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
  const { isAdmin, can } = usePermissions();
  const canManageInventory = can('manage_inventory');
  const canTransferInventory = can('transfer_inventory');
  const canDeleteInventory = isAdmin;
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedSourceName, setSelectedSourceName] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [lotStatus, setLotStatus] = useState('all');
  const [lotSort, setLotSort] = useState({ key: 'stock_date', direction: 'asc' });
  const [stockDialogOpen, setStockDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transactionDialog, setTransactionDialog] = useState({ open: false, item: null, type: 'addition' });
  const [editDialog, setEditDialog] = useState({ open: false, item: null });
  const [historyDialog, setHistoryDialog] = useState({ open: false, item: null });
  const [deleteDialog, setDeleteDialog] = useState({ open: false, item: null, impact: null, error: '', loading: false });
  const [bulkSiteId, setBulkSiteId] = useState('');
  const [bulkSourceName, setBulkSourceName] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkSummary, setBulkSummary] = useState(null);
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
    source_name: DEFAULT_SOURCE_NAME,
    notes: ''
  });
  const [selectedStockIngredient, setSelectedStockIngredient] = useState(null);

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const stockSites = useMemo(
    () => sites.filter((site) => (
      site.is_active !== false
      && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
    )),
    [sites]
  );

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

  const supportsLotValueReport = typeof base44.inventory.getValueReport === 'function';
  const { data: lotValueReportResult = [], isError: lotValueReportError } = useQuery({
    queryKey: ['inventory', 'value-report', selectedSite, dateFrom, dateTo],
    queryFn: () => base44.inventory.getValueReport({
      site_id: selectedSite === 'all' ? '' : selectedSite,
      date_from: dateFrom,
      date_to: dateTo,
      level: 'lot'
    }),
    enabled: supportsLotValueReport
  });

  const { data: velocityReport = { fast_moving: [], slow_moving: [] } } = useQuery({
    queryKey: ['inventory', 'velocity'],
    queryFn: () => base44.inventory.getVelocity({ days: 30 })
  });

  const { data: lots = [] } = useQuery({
    queryKey: ['inventory', 'lots'],
    queryFn: () => base44.inventory.listLots({ include_empty: true })
  });

  const ingredientById = useMemo(
    () => new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients]
  );
  const codedStockOnHand = useMemo(
    () => stockOnHand.map((record) => ({
      ...withResolvedItemCode(record, ingredientById),
      source_name: normalizeSourceName(record.source_name),
      ...getInventoryQuantities(record)
    })),
    [ingredientById, stockOnHand]
  );
  const codedMovementReport = useMemo(
    () => movementReport.map((record) => withResolvedItemCode(record, ingredientById)),
    [ingredientById, movementReport]
  );
  const codedExpiryReport = useMemo(
    () => expiryReport.map((record) => withResolvedItemCode(record, ingredientById)),
    [expiryReport, ingredientById]
  );
  const codedValuationReport = useMemo(
    () => valuationReport.map((record) => withResolvedItemCode(record, ingredientById)),
    [ingredientById, valuationReport]
  );
  const codedLots = useMemo(
    () => lots.map((record) => ({
      ...withResolvedItemCode(record, ingredientById),
      ...getInventoryQuantities(record)
    })),
    [ingredientById, lots]
  );
  const codedLotValueReport = useMemo(
    () => normalizeReportRows(lotValueReportResult).map((record) => withResolvedItemCode(record, ingredientById)),
    [ingredientById, lotValueReportResult]
  );

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

    const preStartStatuses = new Set([
      'draft', 'planned', 'pending_approval', 'pending_procurement', 'pending_production', 'approved'
    ]);
    productions
      .filter((production) => (
        production.production_date >= today
        && production.production_date <= nextWeekStr
        && preStartStatuses.has(String(production.status || '').toLowerCase())
      ))
      .forEach((production) => {
        const inventoryState = getProductionInventoryState(production);
        if (inventoryState.is_consumed) return;
        const demandLines = inventoryState.is_reserved && inventoryState.lines.length > 0
          ? inventoryState.lines
          : (production.ingredients_used || []);
        demandLines.forEach((ingredient) => {
          const stockSiteId = production.fulfillment_store_id || production.site_id;
          if (!stockSiteId) return;
          const ingredientData = ingredientById.get(ingredient.ingredient_id);
          const demandUnit = ingredientData?.unit || ingredient.inventory_unit || ingredient.unit || 'unit';
          const sourceUnit = ingredient.inventory_unit || ingredient.unit || demandUnit;
          const plannedQuantity = convertIngredientQuantity(
            ingredient.desired_quantity
            ?? ingredient.required_quantity
            ?? ingredient.yield_adjusted_quantity
            ?? ingredient.planned_quantity
            ?? ingredient.adjusted_quantity
            ?? ingredient.quantity
            ?? 0,
            sourceUnit,
            demandUnit,
            ingredientData
          );
          const activelyReservedQuantity = inventoryState.is_reserved
            ? convertIngredientQuantity(
              ingredient.reserved_quantity ?? ingredient.committed_quantity ?? 0,
              sourceUnit,
              demandUnit,
              ingredientData
            )
            : 0;
          const requiredQuantity = Math.max(
            0,
            plannedQuantity - activelyReservedQuantity
          );
          if (requiredQuantity <= 0) return;
          const existing = needs.find((item) => item.ingredient_id === ingredient.ingredient_id && item.site_id === stockSiteId);
          if (existing) {
            existing.required_quantity += requiredQuantity;
            return;
          }
          needs.push({
            ingredient_id: ingredient.ingredient_id,
            ingredient_name: ingredient.ingredient_name,
            item_code: getItemCodeFromRecords([ingredientById.get(ingredient.ingredient_id), ingredient]),
            site_id: stockSiteId,
            site_name: production.fulfillment_store_name || production.site_name,
            required_quantity: requiredQuantity,
            unit: demandUnit,
            production_date: production.production_date
          });
        });
      });

    return needs;
  }, [ingredientById, productions]);

  const filteredInventory = useMemo(() => {
    return codedStockOnHand.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSource = selectedSourceName === 'all' || normalizeSourceName(item.source_name) === selectedSourceName;
      const matchesSearch = !searchQuery || `${item.item_code} ${item.ingredient_name} ${item.site_name}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSource && matchesSearch;
    });
  }, [codedStockOnHand, searchQuery, selectedSite, selectedSourceName]);

  const filteredExpiry = useMemo(() => {
    return codedExpiryReport.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${item.item_code} ${item.ingredient_name} ${item.site_name} ${item.batch_number || ''}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [codedExpiryReport, searchQuery, selectedSite]);

  const filteredValuation = useMemo(() => {
    return codedValuationReport.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${item.item_code} ${item.ingredient_name} ${item.site_name}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [codedValuationReport, searchQuery, selectedSite]);

  const decoratedLots = useMemo(() => {
    const activeByItem = new Map();
    codedLots.forEach((lot) => {
      if (Number(lot.remaining_quantity ?? lot.quantity ?? 0) <= 0) return;
      const key = `${lot.site_id || ''}:${lot.ingredient_id || ''}`;
      const current = activeByItem.get(key) || [];
      current.push(lot);
      activeByItem.set(key, current);
    });

    const rotationById = new Map();
    activeByItem.forEach((itemLots) => {
      const ordered = [...itemLots].sort((left, right) => {
        const leftDate = getStockDate(left) || '9999-12-31';
        const rightDate = getStockDate(right) || '9999-12-31';
        return leftDate.localeCompare(rightDate);
      });
      if (ordered[0]) rotationById.set(ordered[0].id, 'oldest');
      if (ordered.length > 1 && ordered[ordered.length - 1]) rotationById.set(ordered[ordered.length - 1].id, 'newest');
      if (ordered.length === 1 && ordered[0]) rotationById.set(ordered[0].id, 'only');
    });

    return codedLots.map((lot) => ({
      ...lot,
      stock_date: getStockDate(lot),
      age_days: getLotAgeDays(lot),
      rotation_rank: lot.rotation_rank || rotationById.get(lot.id) || '',
      source_label: getMovementSource(lot),
      remaining_quantity: Number(lot.on_hand_quantity ?? lot.remaining_quantity ?? lot.quantity ?? 0),
      reserved_quantity: Number(lot.reserved_quantity || 0),
      available_quantity: Number(lot.available_quantity || 0)
    }));
  }, [codedLots]);

  const filteredLots = useMemo(() => {
    const filtered = decoratedLots.filter((lot) => {
      const matchesSite = selectedSite === 'all' || lot.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${lot.item_code} ${lot.ingredient_name} ${lot.site_name} ${lot.batch_number || ''}`.toLowerCase().includes(searchQuery.toLowerCase());
      const displayStatus = getLotDisplayStatus(lot);
      const matchesStatus = lotStatus === 'all'
        || (lotStatus === 'active' && displayStatus === 'active')
        || (lotStatus === 'consumed' && displayStatus === 'consumed');
      return matchesSite && matchesSearch && matchesStatus;
    });

    return filtered.sort((left, right) => {
      const leftValue = left[lotSort.key] ?? '';
      const rightValue = right[lotSort.key] ?? '';
      const numeric = ['remaining_quantity', 'age_days', 'unit_cost'].includes(lotSort.key);
      const comparison = numeric
        ? Number(leftValue || 0) - Number(rightValue || 0)
        : String(leftValue).localeCompare(String(rightValue));
      return lotSort.direction === 'asc' ? comparison : comparison * -1;
    });
  }, [decoratedLots, lotSort, lotStatus, searchQuery, selectedSite]);

  const filteredLotValueReport = useMemo(() => {
    const sourceRows = codedLotValueReport.length > 0 ? codedLotValueReport : decoratedLots;
    return sourceRows.filter((item) => {
      const matchesSite = selectedSite === 'all' || item.site_id === selectedSite;
      const matchesSearch = !searchQuery || `${item.item_code} ${item.ingredient_name} ${item.site_name} ${item.batch_number || ''}`.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSite && matchesSearch;
    });
  }, [codedLotValueReport, decoratedLots, searchQuery, selectedSite]);

  const lotValueActivitySummary = useMemo(() => filteredLotValueReport.reduce((summary, item) => {
    const closingQuantity = toSafeNumber(item.closing_quantity ?? item.remaining_quantity ?? item.quantity, 0);
    const unitCost = toSafeNumber(item.unit_cost ?? item.average_unit_cost, 0);
    summary.opening_value += toSafeNumber(item.opening_value, 0);
    summary.addition_value += toSafeNumber(item.addition_value, 0);
    summary.consumption_value += toSafeNumber(item.consumption_value, 0);
    summary.return_value += toSafeNumber(item.return_value, 0);
    summary.correction_value += toSafeNumber(item.correction_value, 0);
    summary.valuation_reallocation_value += toSafeNumber(item.valuation_reallocation_value, 0);
    summary.closing_value += toSafeNumber(
      item.closing_value ?? item.remaining_value,
      closingQuantity * unitCost
    );
    return summary;
  }, {
    opening_value: 0,
    addition_value: 0,
    consumption_value: 0,
    return_value: 0,
    correction_value: 0,
    valuation_reallocation_value: 0,
    closing_value: 0
  }), [filteredLotValueReport]);

  const inventorySummary = useMemo(() => {
    const reservedByUnit = filteredInventory.reduce(
      (summary, item) => addUnitQuantity(summary, item.unit, item.reserved_quantity),
      {}
    );
    const totalValue = filteredInventory.reduce((sum, item) => sum + Number(item.total_value || 0), 0);
    const lowStockItems = filteredInventory.filter((item) => item.status === 'low_stock' || item.status === 'out_of_stock').length;
    const expiredLots = filteredInventory.reduce((sum, item) => sum + Number(item.expired_lot_count || 0), 0);
    const nearExpiryLots = filteredInventory.reduce((sum, item) => sum + Number(item.near_expiry_count || 0), 0);
    const reservedItems = filteredInventory.filter((item) => Number(item.reserved_quantity || 0) > 0).length;
    const totalBatches = filteredInventory.reduce((sum, item) => sum + Number(
      item.batch_count
        ?? item.total_batch_count
        ?? item.available_batch_count
        ?? 0
    ), 0);
    return {
      reservedByUnit,
      totalValue,
      lowStockItems,
      expiredLots,
      nearExpiryLots,
      reservedItems,
      totalBatches
    };
  }, [filteredInventory]);

  const productionAvailabilitySummary = useMemo(() => {
    const demandByKey = new Map();
    upcomingNeeds
      .filter((need) => selectedSite === 'all' || need.site_id === selectedSite)
      .forEach((need) => {
        const key = `${need.site_id || ''}:${need.ingredient_id || ''}`;
        const current = demandByKey.get(key) || {
          site_id: need.site_id,
          ingredient_id: need.ingredient_id,
          ingredient_name: need.ingredient_name,
          required_quantity: 0,
          unit: need.unit
        };
        current.required_quantity += Number(need.required_quantity || 0);
        demandByKey.set(key, current);
      });

    const availableByKey = new Map();
    filteredInventory.forEach((item) => {
      const key = `${item.site_id || ''}:${item.ingredient_id || ''}`;
      availableByKey.set(key, Number(item.available_quantity || 0));
    });

    const demandLines = Array.from(demandByKey.values()).filter((need) => need.required_quantity > 0);
    const coveredLines = demandLines.filter((need) => (availableByKey.get(`${need.site_id || ''}:${need.ingredient_id || ''}`) || 0) + 0.000001 >= need.required_quantity).length;
    const requiredQuantity = demandLines.reduce((sum, need) => sum + need.required_quantity, 0);
    const coveredQuantity = demandLines.reduce((sum, need) => {
      const available = availableByKey.get(`${need.site_id || ''}:${need.ingredient_id || ''}`) || 0;
      return sum + Math.min(available, need.required_quantity);
    }, 0);
    const percent = requiredQuantity > 0 ? Math.min(100, (coveredQuantity / requiredQuantity) * 100) : 100;

    return {
      percent,
      demandLines: demandLines.length,
      coveredLines,
      shortageLines: Math.max(0, demandLines.length - coveredLines)
    };
  }, [filteredInventory, selectedSite, upcomingNeeds]);

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
        stock_date: format(new Date(), 'yyyy-MM-dd'),
        expiry_date: '',
        min_stock_level: '',
        max_stock_level: '',
        valuation_method: 'fifo',
        source_name: DEFAULT_SOURCE_NAME,
        notes: ''
      });
      setSelectedStockIngredient(null);
    }
  });

  const bulkReceiveMutation = useMutation({
    mutationFn: async (payloads) => {
      if (!isAdmin) {
        throw new Error('Only administrators can perform bulk uploads');
      }
      const worksheet = XLSX.utils.json_to_sheet(payloads);
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      const uploadFile = new File(
        [csv],
        `inventory-batch-${Date.now()}.csv`,
        { type: 'text/csv' }
      );
      return base44.utilities.submitBulkUpload({
        module: 'inventory',
        import_mode: 'keep_existing',
        file: uploadFile,
        site_id: bulkSiteId || '',
        site_name: stockSites.find((site) => site.id === bulkSiteId)?.name || '',
        source_name: bulkSourceName
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['bulk-upload-jobs'] });
      setBulkSummary({ job_id: result.job?.id || null, queued: true });
      setBulkError('');
      setBulkRows([]);
      setBulkFileName('');
    },
    onError: (error) => {
      setBulkError(error.message || 'Bulk upload failed');
    }
  });

  const transferStockMutation = useMutation({
    mutationFn: (payload) => base44.inventory.transfer(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setTransferDialogOpen(false);
    }
  });

  const deleteInventoryMutation = useMutation({
    mutationFn: (id) => base44.entities.Inventory.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['ingredients'] });
      setDeleteDialog({ open: false, item: null, impact: null, error: '', loading: false });
    },
    onError: (error) => {
      setDeleteDialog((current) => ({
        ...current,
        error: error.message || 'Inventory record could not be deleted.'
      }));
    }
  });

  const selectedIngredient = selectedStockIngredient || ingredients.find((ingredient) => ingredient.id === stockForm.ingredient_id);
  const parsedBulkImport = useMemo(
    () => buildBulkInventoryRows(bulkRows, stockSites, ingredients, bulkSiteId),
    [bulkRows, stockSites, ingredients, bulkSiteId]
  );

  const handleReceiveStock = (event) => {
    event.preventDefault();
    const site = sites.find((entry) => entry.id === stockForm.site_id);
    const ingredient = selectedIngredient;
    if (!site || !ingredient || Number(stockForm.quantity || 0) <= 0 || !stockForm.stock_date) return;

    receiveStockMutation.mutate({
      site_id: site.id,
      site_name: site.name,
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: Number(stockForm.quantity || 0),
      unit: ingredient.unit || 'kg',
      unit_cost: Number(stockForm.unit_cost || 0),
      source_name: stockForm.source_name,
      batch_number: stockForm.batch_number,
      stock_date: stockForm.stock_date,
      received_date: stockForm.stock_date,
      transaction_date: stockForm.stock_date,
      expiry_date: stockForm.expiry_date || null,
      min_stock_level: Number(stockForm.min_stock_level || 0),
      max_stock_level: stockForm.max_stock_level ? Number(stockForm.max_stock_level) : null,
      valuation_method: stockForm.valuation_method,
      notes: stockForm.notes,
      reason_code: 'manual_receipt'
    });
  };

  const openDeleteDialog = async (item) => {
    if (!canDeleteInventory) return;
    setDeleteDialog({ open: true, item, impact: null, error: '', loading: true });
    try {
      const impact = await base44.entities.Inventory.deleteImpact(item.id);
      setDeleteDialog({ open: true, item, impact, error: '', loading: false });
    } catch (error) {
      setDeleteDialog({
        open: true,
        item,
        impact: null,
        error: error.message || 'Could not load deletion warning details.',
        loading: false
      });
    }
  };

  const handleBulkFile = async (event) => {
    if (!isAdmin) {
      setBulkError('Only administrators can perform bulk uploads');
      event.target.value = '';
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      setBulkRows(rows);
      setBulkFileName(file.name);
      setBulkError('');
      setBulkSummary(null);
    } catch (error) {
      setBulkRows([]);
      setBulkFileName('');
      setBulkSummary(null);
      setBulkError(error.message || 'Could not read the inventory upload file');
    } finally {
      event.target.value = '';
    }
  };

  const handleDownloadInventoryTemplate = () => {
    const worksheet = XLSX.utils.json_to_sheet([
      {
        item_code: 'ITM-001',
        ingredient_name: 'Chicken Breast',
        project_code: 'PROJ-001',
        quantity: 25,
        unit_cost: 5.8,
        batch_number: 'BATCH-001',
        stock_date: format(new Date(), 'yyyy-MM-dd'),
        expiry_date: format(new Date(), 'yyyy-MM-dd'),
        min_stock_level: 8,
        max_stock_level: 40,
        valuation_method: 'fifo',
        notes: 'Opening stock'
      }
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory Upload');
    XLSX.writeFile(workbook, 'inventory_bulk_template.xlsx');
  };

  const handleSubmitBulkImport = () => {
    if (!isAdmin) {
      setBulkError('Only administrators can perform bulk uploads');
      return;
    }
    if (!parsedBulkImport.items.length) {
      setBulkError('Upload a valid CSV/Excel file before importing');
      return;
    }
    if (!bulkSourceName) {
      setBulkError('Select Source Name before importing inventory.');
      return;
    }
    bulkReceiveMutation.mutate(parsedBulkImport.items);
  };

  const handlePopulateStarterStock = () => {
    if (!isAdmin) {
      setBulkError('Only administrators can populate starter stock in bulk');
      return;
    }
    const targetSite = stockSites.find((site) => site.id === bulkSiteId)
      || stockSites.find((site) => site.id === stockForm.site_id)
      || stockSites.find((site) => site.id === selectedSite)
      || stockSites[0];

    if (!targetSite) {
      setBulkError('Create a project or location before populating starter stock');
      return;
    }
    if (!bulkSourceName) {
      setBulkError('Select Source Name before populating starter stock.');
      return;
    }

    const starterRows = buildStarterStockRows(targetSite, ingredients);
    if (!starterRows.length) {
      setBulkError('Starter stock could not be prepared because matching ingredients were not found');
      return;
    }

    setBulkSiteId(targetSite.id);
    bulkReceiveMutation.mutate(starterRows);
  };

  const movementSummary = useMemo(() => {
    return codedMovementReport.reduce((summary, movement) => {
      const quantity = Number(movement.quantity || 0);
      if (quantity >= 0) {
        addUnitQuantity(summary.inboundByUnit, movement.unit, quantity);
      } else {
        addUnitQuantity(summary.outboundByUnit, movement.unit, Math.abs(quantity));
      }
      return summary;
    }, { inboundByUnit: {}, outboundByUnit: {} });
  }, [codedMovementReport]);

  const filteredFastMoving = useMemo(() => {
    return (velocityReport.fast_moving || [])
      .map((record) => withResolvedItemCode(record, ingredientById))
      .filter((item) => selectedSite === 'all' || item.site_id === selectedSite);
  }, [ingredientById, selectedSite, velocityReport.fast_moving]);

  const filteredSlowMoving = useMemo(() => {
    return (velocityReport.slow_moving || [])
      .map((record) => withResolvedItemCode(record, ingredientById))
      .filter((item) => selectedSite === 'all' || item.site_id === selectedSite);
  }, [ingredientById, selectedSite, velocityReport.slow_moving]);

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px]">
        <PageHeader
          title="Inventory Control"
          description="Track physical on-hand, production-reserved, and available stock across Stores, with receipts, batches, expiry, valuation, and movement history."
        >
          <Button variant="outline" onClick={() => downloadCSV(
            filteredInventory.map((item) => putItemCodeAndNameFirst({
              ...item,
              on_hand_quantity: item.on_hand_quantity,
              reserved_quantity: item.reserved_quantity,
              available_quantity: item.available_quantity
            }, {
              nameKey: 'ingredient_name',
              outputNameKey: 'ingredient_name'
            })),
            'inventory-stock-on-hand'
          )}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button type="button" variant="outline" onClick={handleDownloadInventoryTemplate}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Download Template
          </Button>
          {isAdmin ? (
            <Button variant="outline" onClick={() => setBulkDialogOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Bulk Upload
            </Button>
          ) : null}
          {canTransferInventory ? (
              <Button variant="outline" onClick={() => setTransferDialogOpen(true)}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                Transfer Stock
              </Button>
          ) : null}
          {canManageInventory ? (
              <Button onClick={() => setStockDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                <Plus className="mr-2 h-4 w-4" />
                Add Inventory
              </Button>
          ) : null}
        </PageHeader>

        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard title="Projects / Locations" value={stockSites.length} icon={Boxes} iconBg="bg-slate-100" iconColor="text-slate-700" />
          <StatCard title="Stock On Hand" value={filteredInventory.length} subtitle="inventory item records" icon={Boxes} iconBg="bg-blue-50" iconColor="text-blue-600" />
          <StatCard
            title="Available for Production"
            value={formatPercent(productionAvailabilitySummary.percent)}
            subtitle={productionAvailabilitySummary.demandLines > 0
              ? `${productionAvailabilitySummary.coveredLines}/${productionAvailabilitySummary.demandLines} upcoming needs covered`
              : 'No upcoming production demand'}
            icon={PackageCheck}
            iconBg="bg-cyan-50"
            iconColor="text-cyan-700"
          />
          <StatCard title="Reserved Items" value={inventorySummary.reservedItems} subtitle={formatUnitQuantities(inventorySummary.reservedByUnit)} icon={LockKeyhole} iconBg="bg-violet-50" iconColor="text-violet-600" />
          <StatCard title="Inventory Value" value={formatCurrency(inventorySummary.totalValue)} subtitle={`${inventorySummary.totalBatches} active batches`} icon={Wallet} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Low Stock Items" value={inventorySummary.lowStockItems} icon={TrendingDown} iconBg="bg-amber-50" iconColor="text-amber-600" />
          <StatCard title="Expired Lots" value={inventorySummary.expiredLots} icon={AlertTriangle} iconBg="bg-rose-50" iconColor="text-rose-600" />
          <StatCard title="Near Expiry" value={inventorySummary.nearExpiryLots} icon={CalendarClock} iconBg="bg-orange-50" iconColor="text-orange-600" />
          <StatCard title="Production Gaps" value={productionAvailabilitySummary.shortageLines} subtitle="upcoming unmet item needs" icon={Package} iconBg="bg-violet-50" iconColor="text-violet-600" />
        </div>

        <div className="mb-6">
          <InventoryAlerts inventory={filteredInventory} upcomingNeeds={upcomingNeeds} />
        </div>

        <Card className="mb-6 border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_240px_160px_180px_180px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-10"
                  placeholder="Search ingredient, project, location, or batch"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
              <Select value={selectedSite} onValueChange={setSelectedSite}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects / Locations</SelectItem>
                  {stockSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedSourceName} onValueChange={setSelectedSourceName}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  {SOURCE_NAME_OPTIONS.map((source) => (
                    <SelectItem key={source} value={source}>{source}</SelectItem>
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
            onAction={canManageInventory ? () => setStockDialogOpen(true) : undefined}
          />
        ) : (
          <Tabs defaultValue="stock" className="space-y-4">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
              <TabsTrigger value="stock">Stock On Hand</TabsTrigger>
              <TabsTrigger value="movements">Stock Change Log</TabsTrigger>
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
                  <Table className="min-w-[1350px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Source Name</TableHead>
                        <TableHead>On Hand</TableHead>
                        <TableHead>Reserved</TableHead>
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
                          ? Math.min(100, (Number(item.available_quantity || 0) / Number(item.max_stock_level || 1)) * 100)
                          : Math.min(100, ((Number(item.available_quantity || 0) / Math.max(Number(item.min_stock_level || 1), 1)) * 100));

                        return (
                          <TableRow key={item.id}>
                            <TableCell className="text-sm font-medium text-slate-600">{item.item_code}</TableCell>
                            <TableCell>
                              <div>
                                <p className="font-medium">{item.ingredient_name}</p>
                                <p className="text-xs text-slate-500">
                                  {item.batch_count ?? item.total_batch_count ?? item.available_batch_count ?? 0} physical batches
                                  {' · '}{item.available_batch_count || 0} available
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>{item.site_name}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
                                {normalizeSourceName(item.source_name)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <p className="font-semibold">{formatQuantity(item.on_hand_quantity)} {item.unit}</p>
                            </TableCell>
                            <TableCell>
                              <p className="font-semibold text-violet-700">{formatQuantity(item.reserved_quantity)} {item.unit}</p>
                              <p className="text-xs text-slate-500">Approved production</p>
                            </TableCell>
                            <TableCell>
                              <p className="font-semibold text-cyan-800">{formatQuantity(item.available_quantity)} {item.unit}</p>
                              <Progress value={stockPercent} className="mt-2 h-2 max-w-28" />
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              <div>Min: {formatQuantity(item.min_stock_level)} {item.unit}</div>
                              <div>Max: {item.max_stock_level ? `${formatQuantity(item.max_stock_level)} ${item.unit}` : '-'}</div>
                            </TableCell>
                            <TableCell className="text-sm text-slate-600">
                              <div>{formatCurrency(Number(item.total_value || 0))}</div>
                              <div className="text-xs text-slate-500">
                                {item.valuation_method === 'weighted_average' ? 'Weighted avg' : 'FIFO'} • {formatCurrency(Number(item.average_unit_cost || 0))}
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
                                {canManageInventory ? (
                                  <>
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
                                  </>
                                ) : null}
                                <Button size="sm" variant="outline" onClick={() => setHistoryDialog({ open: true, item })}>
                                  <History className="h-4 w-4" />
                                </Button>
                                {canDeleteInventory ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                                    onClick={() => openDeleteDialog(item)}
                                    title="Delete inventory"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                ) : null}
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
                    <p className="mt-2 text-xl font-semibold text-emerald-700">{formatUnitQuantities(movementSummary.inboundByUnit)}</p>
                  </CardContent>
                </Card>
                <Card className="border-slate-200">
                  <CardContent className="p-5">
                    <p className="text-sm text-slate-500">Outbound Quantity</p>
                    <p className="mt-2 text-xl font-semibold text-rose-700">{formatUnitQuantities(movementSummary.outboundByUnit)}</p>
                  </CardContent>
                </Card>
              </div>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-slate-100">
                  <div>
                    <CardTitle className="text-lg">Stock Change Log</CardTitle>
                    <p className="mt-1 text-xs text-slate-500">Trace every receipt, production consumption, return, correction, transfer, and upload.</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => downloadCSV(codedMovementReport.map((movement) => ({
                      item_code: movement.item_code,
                      ingredient_name: movement.ingredient_name,
                      on_hand_stock: getOpeningQuantity(movement),
                      addition: getStockChangeQuantity(movement) > 0 ? getStockChangeQuantity(movement) : 0,
                      consumption: getStockChangeQuantity(movement) < 0 ? Math.abs(getStockChangeQuantity(movement)) : 0,
                      date_of_update: getPostedDate(movement),
                      total_now: getClosingQuantity(movement),
                      unit: movement.unit,
                    })), 'inventory-movement-ledger')}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export Ledger
                  </Button>
                </CardHeader>
                <CardContent className="overflow-x-auto p-0">
                  <Table className="min-w-[950px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>On Hand Stock</TableHead>
                        <TableHead>Addition</TableHead>
                        <TableHead>Consumption</TableHead>
                        <TableHead>Date of Update</TableHead>
                        <TableHead>Total Now</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {movementReport.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                            No stock movements in the selected period.
                          </TableCell>
                        </TableRow>
                      ) : codedMovementReport.map((movement) => (
                        <TableRow key={movement.id}>
                          <TableCell className="font-mono text-xs text-slate-600">{movement.item_code || '-'}</TableCell>
                          <TableCell className="font-medium">{movement.ingredient_name || '-'}</TableCell>
                          <TableCell>{getOpeningQuantity(movement) === null ? '-' : `${formatQuantity(getOpeningQuantity(movement))} ${movement.unit || ''}`}</TableCell>
                          <TableCell className="font-semibold text-emerald-700">
                            {getStockChangeQuantity(movement) > 0 ? `+${formatQuantity(getStockChangeQuantity(movement))} ${movement.unit || ''}` : '-'}
                          </TableCell>
                          <TableCell className="font-semibold text-rose-700">
                            {getStockChangeQuantity(movement) < 0 ? `-${formatQuantity(Math.abs(getStockChangeQuantity(movement)))} ${movement.unit || ''}` : '-'}
                          </TableCell>
                          <TableCell>{formatDisplayDate(getPostedDate(movement))}</TableCell>
                          <TableCell className="font-semibold text-slate-900">
                            {getClosingQuantity(movement) === null ? '-' : `${formatQuantity(getClosingQuantity(movement))} ${movement.unit || ''}`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="expiry">
              <div className="grid gap-4">
                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-lg">Expiry Report</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item Code</TableHead>
                          <TableHead>Item Name</TableHead>
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
                            <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                              No near-expiry or expired lots found.
                            </TableCell>
                          </TableRow>
                        ) : filteredExpiry.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell className="text-sm font-medium text-slate-600">{item.item_code}</TableCell>
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
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-slate-100">
                    <div>
                      <CardTitle className="text-lg">Batch / Lot Tracking</CardTitle>
                      <p className="mt-1 text-xs text-slate-500">Physical, reserved, and available quantities remain visible by batch, including fully consumed lots, for FIFO/FEFO and stock-age audit.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={lotStatus} onValueChange={setLotStatus}>
                        <SelectTrigger className="h-9 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Lots</SelectItem>
                          <SelectItem value="active">Active Lots</SelectItem>
                          <SelectItem value="consumed">Consumed Lots</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => downloadCSV(filteredLots.map((lot) => ({
                          item_code: lot.item_code,
                          ingredient_name: lot.ingredient_name,
                          location: lot.site_name,
                          batch_number: lot.batch_number || lot.lot_number,
                          stock_date: lot.stock_date,
                          age_days: lot.age_days,
                          rotation: lot.rotation_rank,
                          received_quantity: lot.quantity_received ?? lot.received_quantity ?? lot.quantity,
                          on_hand_quantity: lot.remaining_quantity,
                          reserved_quantity: lot.reserved_quantity,
                          available_quantity: lot.available_quantity,
                          unit: lot.unit,
                          expiry_date: lot.expiry_date,
                          unit_cost: lot.unit_cost,
                          remaining_value: Number(lot.remaining_quantity || 0) * Number(lot.unit_cost || 0),
                          source: lot.source_label,
                          reference: getReference(lot)
                        })), 'inventory-lot-register')}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        Export Lots
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="overflow-x-auto p-0">
                    {filteredLots.length === 0 ? (
                      <p className="py-8 text-center text-sm text-slate-500">No lots found for the selected filters.</p>
                    ) : (
                      <Table className="min-w-[1850px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Item Code</TableHead>
                            <TableHead>Item Name</TableHead>
                            <TableHead>Location</TableHead>
                            <TableHead>Batch / Lot</TableHead>
                            <TableHead>
                              <button type="button" className="font-medium hover:text-slate-900" onClick={() => setLotSort((current) => ({ key: 'stock_date', direction: current.key === 'stock_date' && current.direction === 'asc' ? 'desc' : 'asc' }))}>
                                Stock Date ↕
                              </button>
                            </TableHead>
                            <TableHead>
                              <button type="button" className="font-medium hover:text-slate-900" onClick={() => setLotSort((current) => ({ key: 'age_days', direction: current.key === 'age_days' && current.direction === 'asc' ? 'desc' : 'asc' }))}>
                                Age ↕
                              </button>
                            </TableHead>
                            <TableHead>Rotation</TableHead>
                            <TableHead>Received</TableHead>
                            <TableHead>
                              <button type="button" className="font-medium hover:text-slate-900" onClick={() => setLotSort((current) => ({ key: 'remaining_quantity', direction: current.key === 'remaining_quantity' && current.direction === 'asc' ? 'desc' : 'asc' }))}>
                                On Hand ↕
                              </button>
                            </TableHead>
                            <TableHead>Reserved</TableHead>
                            <TableHead>Available</TableHead>
                            <TableHead>Expiry</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Unit Cost</TableHead>
                            <TableHead>Remaining Value</TableHead>
                            <TableHead>Source</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredLots.map((lot) => {
                            const displayStatus = getLotDisplayStatus(lot);
                            const statusClass = displayStatus === 'active'
                              ? 'bg-emerald-100 text-emerald-700'
                              : displayStatus === 'consumed'
                                ? 'bg-slate-100 text-slate-700'
                                : displayStatus === 'expired'
                                  ? 'bg-rose-100 text-rose-700'
                                  : 'bg-amber-100 text-amber-800';
                            return (
                              <TableRow key={lot.id}>
                                <TableCell className="text-sm font-medium text-slate-600">{lot.item_code}</TableCell>
                                <TableCell>{lot.ingredient_name}</TableCell>
                                <TableCell>{lot.site_name}</TableCell>
                                <TableCell>{lot.batch_number || lot.lot_number || '-'}</TableCell>
                                <TableCell>{lot.stock_date || '-'}</TableCell>
                                <TableCell>{lot.age_days === null ? '-' : `${lot.age_days} days`}</TableCell>
                                <TableCell>
                                  {lot.rotation_rank ? (
                                    <Badge className={lot.rotation_rank === 'oldest' ? 'bg-amber-100 text-amber-800' : lot.rotation_rank === 'newest' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}>
                                      {lot.rotation_rank}
                                    </Badge>
                                  ) : '-'}
                                </TableCell>
                                <TableCell>{formatQuantity(lot.quantity_received ?? lot.received_quantity ?? lot.quantity)} {lot.unit}</TableCell>
                                <TableCell className="font-medium">{formatQuantity(lot.remaining_quantity)} {lot.unit}</TableCell>
                                <TableCell className="font-medium text-violet-700">{formatQuantity(lot.reserved_quantity)} {lot.unit}</TableCell>
                                <TableCell className="font-medium text-cyan-800">{formatQuantity(lot.available_quantity)} {lot.unit}</TableCell>
                                <TableCell>{lot.expiry_date || '-'}</TableCell>
                                <TableCell>
                                  <Badge className={statusClass}>
                                    {displayStatus.replace(/_/g, ' ')}
                                  </Badge>
                                </TableCell>
                                <TableCell>{formatCurrency(Number(lot.unit_cost || 0))}</TableCell>
                                <TableCell>{formatCurrency(Number(lot.remaining_quantity || 0) * Number(lot.unit_cost || 0))}</TableCell>
                                <TableCell className="capitalize">{String(lot.source_label || '-').replace(/_/g, ' ')}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
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
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
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
                          <TableCell className="text-sm font-medium text-slate-600">{item.item_code}</TableCell>
                          <TableCell>{item.ingredient_name}</TableCell>
                          <TableCell>{item.site_name}</TableCell>
                          <TableCell>{item.valuation_method === 'weighted_average' ? 'Weighted Average' : 'FIFO'}</TableCell>
                          <TableCell>{formatQuantity(item.quantity)} {item.unit}</TableCell>
                          <TableCell>{formatCurrency(Number(item.average_unit_cost || 0))}</TableCell>
                          <TableCell>{formatCurrency(Number(item.fifo_value || 0))}</TableCell>
                          <TableCell>{formatCurrency(Number(item.weighted_average_value || 0))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="mt-4 border-slate-200 shadow-sm">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-slate-100">
                  <div>
                    <CardTitle className="text-lg">Lot-Level Inventory Value Report</CardTitle>
                    <p className="mt-1 text-xs text-slate-500">
                      {supportsLotValueReport && !lotValueReportError
                        ? 'Period activity and closing value by stock date and batch.'
                        : 'Current lot snapshot. Period opening/addition/consumption fields will populate when the detailed value-report endpoint is available.'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => downloadCSV(filteredLotValueReport.map((item) => ({
                      item_code: item.item_code,
                      ingredient_name: item.ingredient_name,
                      location: item.site_name,
                      batch_number: item.batch_number || item.lot_number,
                      stock_date: getStockDate(item),
                      expiry_date: item.expiry_date,
                      opening_quantity: item.opening_quantity ?? item.quantity_before ?? '',
                      opening_value: item.opening_value ?? '',
                      additions: item.addition_quantity ?? item.additions ?? item.received_quantity ?? '',
                      addition_value: item.addition_value ?? '',
                      consumption: item.consumption_quantity ?? item.consumed_quantity ?? '',
                      consumption_value: item.consumption_value ?? '',
                      returns: item.return_quantity ?? item.returns_quantity ?? '',
                      return_value: item.return_value ?? '',
                      corrections: item.correction_quantity ?? item.adjustment_quantity ?? '',
                      correction_value: item.correction_value ?? '',
                      valuation_reallocation_value: item.valuation_reallocation_value ?? '',
                      closing_quantity: item.closing_quantity ?? item.remaining_quantity ?? item.quantity ?? 0,
                      unit: item.unit,
                      unit_cost: item.unit_cost ?? item.average_unit_cost ?? 0,
                      closing_value: item.closing_value ?? item.remaining_value ?? (Number(item.remaining_quantity ?? item.quantity ?? 0) * Number(item.unit_cost ?? item.average_unit_cost ?? 0)),
                      source: getMovementSource(item),
                      reference: getReference(item)
                    })), 'inventory-value-by-lot')}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export Lot Values
                  </Button>
                </CardHeader>
                <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                  {[
                    ['Opening Value', lotValueActivitySummary.opening_value, 'text-slate-900'],
                    ['Additions', lotValueActivitySummary.addition_value, 'text-emerald-700'],
                    ['Consumption', lotValueActivitySummary.consumption_value, 'text-rose-700'],
                    ['Returns', lotValueActivitySummary.return_value, 'text-blue-700'],
                    ['Corrections', lotValueActivitySummary.correction_value, 'text-amber-700'],
                    ['Valuation Reallocation', lotValueActivitySummary.valuation_reallocation_value, 'text-violet-700'],
                    ['Closing Value', lotValueActivitySummary.closing_value, 'text-slate-900']
                  ].map(([label, value, tone]) => (
                    <div key={label} className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs text-slate-500">{label}</p>
                      <p className={`mt-1 text-sm font-semibold ${tone}`}>{formatCurrency(value)}</p>
                    </div>
                  ))}
                </div>
                <CardContent className="overflow-x-auto p-0">
                  <Table className="min-w-[2500px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Batch</TableHead>
                        <TableHead>Stock Date</TableHead>
                        <TableHead>Expiry</TableHead>
                        <TableHead>Opening Qty</TableHead>
                        <TableHead>Opening Value</TableHead>
                        <TableHead>Addition Qty</TableHead>
                        <TableHead>Addition Value</TableHead>
                        <TableHead>Consumption Qty</TableHead>
                        <TableHead>Consumption Value</TableHead>
                        <TableHead>Return Qty</TableHead>
                        <TableHead>Return Value</TableHead>
                        <TableHead>Correction Qty</TableHead>
                        <TableHead>Correction Value</TableHead>
                        <TableHead>Valuation Reallocation</TableHead>
                        <TableHead>Closing Qty</TableHead>
                        <TableHead>Unit Cost</TableHead>
                        <TableHead>Closing Value</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredLotValueReport.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={21} className="py-8 text-center text-slate-500">No lot valuation records found.</TableCell>
                        </TableRow>
                      ) : filteredLotValueReport.map((item) => {
                        const closingQuantity = Number(item.closing_quantity ?? item.remaining_quantity ?? item.quantity ?? 0);
                        const unitCost = Number(item.unit_cost ?? item.average_unit_cost ?? 0);
                        return (
                          <TableRow key={item.id || `${item.site_id}-${item.ingredient_id}-${item.batch_number}`}>
                            <TableCell className="text-sm font-medium text-slate-600">{item.item_code}</TableCell>
                            <TableCell>{item.ingredient_name}</TableCell>
                            <TableCell>{item.site_name}</TableCell>
                            <TableCell>{item.batch_number || item.lot_number || '-'}</TableCell>
                            <TableCell>{getStockDate(item) || '-'}</TableCell>
                            <TableCell>{item.expiry_date || '-'}</TableCell>
                            <TableCell>{formatOptionalQuantity(item.opening_quantity ?? item.quantity_before, item.unit)}</TableCell>
                            <TableCell>{formatCurrency(Number(item.opening_value || 0))}</TableCell>
                            <TableCell className="text-emerald-700">{formatOptionalQuantity(item.addition_quantity ?? item.additions ?? item.received_quantity, item.unit)}</TableCell>
                            <TableCell className="text-emerald-700">{formatCurrency(Number(item.addition_value || 0))}</TableCell>
                            <TableCell className="text-rose-700">{formatOptionalQuantity(item.consumption_quantity ?? item.consumed_quantity, item.unit)}</TableCell>
                            <TableCell className="text-rose-700">{formatCurrency(Number(item.consumption_value || 0))}</TableCell>
                            <TableCell>{formatOptionalQuantity(item.return_quantity ?? item.returns_quantity, item.unit)}</TableCell>
                            <TableCell>{formatCurrency(Number(item.return_value || 0))}</TableCell>
                            <TableCell>{formatOptionalQuantity(item.correction_quantity ?? item.adjustment_quantity, item.unit)}</TableCell>
                            <TableCell>{formatCurrency(Number(item.correction_value || 0))}</TableCell>
                            <TableCell>{formatCurrency(Number(item.valuation_reallocation_value || 0))}</TableCell>
                            <TableCell className="font-medium">{formatQuantity(closingQuantity)} {item.unit}</TableCell>
                            <TableCell>{formatCurrency(unitCost)}</TableCell>
                            <TableCell>{formatCurrency(Number(item.closing_value ?? item.remaining_value ?? (closingQuantity * unitCost)))}</TableCell>
                            <TableCell className="capitalize">{String(getMovementSource(item)).replace(/_/g, ' ')}</TableCell>
                          </TableRow>
                        );
                      })}
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
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.item_code}</p>
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
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.item_code}</p>
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

        <AlertDialog open={canDeleteInventory && deleteDialog.open} onOpenChange={(open) => {
          setDeleteDialog((current) => ({
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
                    Delete "{getItemCodeFromRecords([deleteDialog.item?._ing, deleteDialog.item])} · {deleteDialog.item?.ingredient_name || '—'}" for {deleteDialog.item?.site_name || 'this site'}?
                  </p>
                  <p className="text-xs text-slate-500">
                    Inventory with stock, batches, reservations, or transactions should normally be cleared through stock movements. This delete is for admin cleanup of empty/unlinked records only.
                  </p>
                  <DeleteImpactDetails
                    impact={deleteDialog.impact}
                    loading={deleteDialog.loading}
                    error={deleteDialog.error}
                  />
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteDialog.item?.id && deleteInventoryMutation.mutate(deleteDialog.item.id)}
                disabled={deleteInventoryMutation.isPending || deleteDialog.loading || !deleteDialog.item?.id}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteInventoryMutation.isPending ? 'Deleting...' : 'Delete Inventory'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={historyDialog.open} onOpenChange={(open) => setHistoryDialog((current) => ({ ...current, open }))}>
          <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                Movement History — {getItemCode(historyDialog.item)} · {historyDialog.item?.ingredient_name || '—'}
              </DialogTitle>
            </DialogHeader>
            {historyDialog.item ? (
              <InventoryHistory ingredientId={historyDialog.item.ingredient_id} siteId={historyDialog.item.site_id} />
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={stockDialogOpen} onOpenChange={setStockDialogOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Add Inventory Manually</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleReceiveStock} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Project / Location</Label>
                  <Select value={stockForm.site_id} onValueChange={(value) => setStockForm((current) => ({ ...current, site_id: value }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select project or location" />
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
                  <IngredientSearchCombobox
                    className="mt-1"
                    value={stockForm.ingredient_id}
                    selectedIngredient={selectedIngredient}
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
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <div>
                  <Label>Source Name *</Label>
                  <Select value={stockForm.source_name} onValueChange={(value) => setStockForm((current) => ({ ...current, source_name: value }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_NAME_OPTIONS.map((source) => (
                        <SelectItem key={source} value={source}>{source}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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

              <div className="grid gap-4 md:grid-cols-5">
                <div>
                  <Label>Stock Date *</Label>
                  <Input type="date" required className="mt-1" value={stockForm.stock_date} onChange={(event) => setStockForm((current) => ({ ...current, stock_date: event.target.value }))} />
                </div>
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
                  {receiveStockMutation.isPending ? 'Saving...' : 'Add Inventory'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={isAdmin && bulkDialogOpen}
          onOpenChange={(open) => {
            if (open && !isAdmin) return;
            setBulkDialogOpen(open);
            if (!open) {
              setBulkError('');
              setBulkSummary(null);
            }
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Bulk Upload Inventory</DialogTitle>
            </DialogHeader>
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <Card className="border-slate-200 shadow-none">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-base">Upload CSV / Excel</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4 p-4">
                    <div>
                      <Label>Default Project / Location</Label>
                      <Select value={bulkSiteId || 'none'} onValueChange={(value) => setBulkSiteId(value === 'none' ? '' : value)}>
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Use row values or choose a default project" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Use project from uploaded rows</SelectItem>
                          {stockSites.map((site) => (
                            <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Source Name *</Label>
                      <Select value={bulkSourceName} onValueChange={setBulkSourceName}>
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Select source before upload" />
                        </SelectTrigger>
                        <SelectContent>
                          {SOURCE_NAME_OPTIONS.map((source) => (
                            <SelectItem key={source} value={source}>{source}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Upload file</Label>
                      <Input className="mt-1" type="file" accept=".csv,.xlsx,.xls" onChange={handleBulkFile} />
                      <p className="mt-2 text-xs text-slate-500">
                        Supported columns: item_code or ingredient_name, project_code or site_name, quantity, unit_cost, batch_number, stock_date, expiry_date, min_stock_level, max_stock_level, valuation_method, notes.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button type="button" variant="outline" onClick={handleDownloadInventoryTemplate}>
                        <FileSpreadsheet className="mr-2 h-4 w-4" />
                        Download Template
                      </Button>
                      <Button type="button" variant="outline" onClick={handlePopulateStarterStock} disabled={bulkReceiveMutation.isPending || stockSites.length === 0}>
                        <Plus className="mr-2 h-4 w-4" />
                        Populate Starter Stock
                      </Button>
                    </div>
                    {bulkFileName ? (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                        Loaded file: <span className="font-medium text-slate-900">{bulkFileName}</span>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="border-slate-200 shadow-none">
                  <CardHeader className="border-b border-slate-100">
                    <CardTitle className="text-base">Import Summary</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4 text-sm">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-slate-500">Ready rows</p>
                      <p className="mt-2 text-2xl font-semibold text-slate-900">{parsedBulkImport.items.length}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-slate-500">Row issues</p>
                      <p className="mt-2 text-2xl font-semibold text-amber-700">{parsedBulkImport.errors.length}</p>
                    </div>
                    {bulkSummary ? (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                        <p className="font-medium text-emerald-900">Last import result</p>
                        <p className="mt-2 text-sm text-emerald-800">
                          Background job {bulkSummary.job_id || ''} queued. You can continue working while rows are processed in batches.
                        </p>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </div>

              {bulkError ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {bulkError}
                </div>
              ) : null}

              <Card className="border-slate-200 shadow-none">
                <CardHeader className="border-b border-slate-100">
                  <CardTitle className="text-base">Preview</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Row</TableHead>
                        <TableHead>Project / Location</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Unit Cost</TableHead>
                        <TableHead>Stock Date</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsedBulkImport.previewRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="py-8 text-center text-slate-500">
                            Upload a file to preview bulk inventory rows.
                          </TableCell>
                        </TableRow>
                      ) : parsedBulkImport.previewRows.slice(0, 12).map((row) => (
                        <TableRow key={`preview-${row.row}`}>
                          <TableCell className="text-sm font-medium text-slate-600">{row.item_code}</TableCell>
                          <TableCell>{row.ingredient || '-'}</TableCell>
                          <TableCell>{row.row}</TableCell>
                          <TableCell>{row.project || '-'}</TableCell>
                          <TableCell>{formatQuantity(row.quantity)}</TableCell>
                          <TableCell>{formatCurrency(Number(row.unit_cost || 0))}</TableCell>
                          <TableCell>{row.stock_date || '-'}</TableCell>
                          <TableCell>
                            <Badge className={row.status === 'Ready' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                              {row.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setBulkDialogOpen(false)}>
                  Close
                </Button>
                <Button type="button" className="bg-emerald-600 hover:bg-emerald-700" disabled={bulkReceiveMutation.isPending} onClick={handleSubmitBulkImport}>
                  {bulkReceiveMutation.isPending ? 'Importing...' : 'Import Inventory'}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        <InventoryTransferDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          sites={stockSites}
          inventory={codedStockOnHand}
          onSubmit={(payload) => transferStockMutation.mutateAsync(payload)}
          isPending={transferStockMutation.isPending}
        />
      </div>
    </div>
  );
}
