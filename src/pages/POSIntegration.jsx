import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency, SAR_CODE, SAR_NAME } from '@/lib/currency';
import {
  ArrowUpDown,
  Cable,
  Database,
  Link2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Store,
  Trash2,
  Upload
} from 'lucide-react';

const emptySourceForm = {
  name: '',
  source_type: 'api',
  api_url: '',
  api_key: '',
  api_secret: '',
  sync_frequency: 'manual',
  default_site_id: '',
  is_active: true,
  settingsText: '{\n  "headers": {}\n}'
};

const emptyMappingForm = {
  source_id: 'all',
  pos_item_code: '',
  pos_item_name: '',
  recipe_id: '',
  servings_per_sale: '1',
  site_scope: 'global',
  site_id: '',
  auto_deduct: true,
  notes: ''
};

const defaultFilterState = {
  start_date: '',
  end_date: '',
  location_id: 'all'
};

function safeJsonParse(text) {
  if (!String(text || '').trim()) {
    return {};
  }
  return JSON.parse(text);
}

function formatNumber(value, digits = 0) {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(numeric);
}

function formatDateTime(value) {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Invalid date';
  return parsed.toLocaleString();
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function pickValue(row, aliases) {
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const matchKey = Object.keys(row).find((key) => normalizeHeader(key) === normalizedAlias);
    if (matchKey && row[matchKey] !== '' && row[matchKey] !== null && typeof row[matchKey] !== 'undefined') {
      return row[matchKey];
    }
  }
  return '';
}

function toSafeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function excelDateToIso(value) {
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    return parsed.toISOString();
  }
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function buildManualOrders(rows, sites = []) {
  const groupedOrders = new Map();

  rows.forEach((row, rowIndex) => {
    const externalOrderId = String(pickValue(row, ['external_order_id', 'order_id', 'ticket_id', 'check_id', 'invoice_id', 'transaction_id']) || '').trim();
    const orderNumber = String(pickValue(row, ['order_number', 'ticket_number', 'check_number', 'receipt_number', 'bill_no', 'invoice_number']) || externalOrderId || `ROW-${rowIndex + 1}`).trim();
    const soldAt = excelDateToIso(pickValue(row, ['sold_at', 'order_date', 'created_at', 'business_datetime', 'sale_time', 'transaction_time']));
    const businessDate = String(pickValue(row, ['business_date', 'date', 'sale_date', 'transaction_date']) || soldAt.slice(0, 10)).slice(0, 10);
    const siteId = String(pickValue(row, ['site_id', 'location_id', 'branch_id', 'store_id']) || '').trim();
    const locationName = String(pickValue(row, ['location_name', 'site_name', 'location', 'branch', 'branch_name', 'store_name', 'outlet']) || '').trim();
    const site = sites.find((entry) => entry.id === siteId || entry.name === locationName);
    const siteName = String(pickValue(row, ['site_name', 'branch_name', 'store_name', 'location_name']) || site?.name || locationName).trim();
    const itemCode = String(pickValue(row, ['pos_item_code', 'item_code', 'sku', 'menu_code', 'product_code', 'plu']) || '').trim();
    const itemName = String(pickValue(row, ['pos_item_name', 'item_name', 'menu_item', 'product_name', 'description', 'item']) || '').trim();
    const quantity = toSafeNumber(pickValue(row, ['quantity', 'qty', 'sold_qty', 'sales_qty', 'item_qty', 'count']), 0);
    const unitPrice = toSafeNumber(pickValue(row, ['unit_price', 'price', 'rate', 'avg_price']), 0);
    const totalPrice = toSafeNumber(pickValue(row, ['total_price', 'line_total', 'amount', 'net_amount', 'gross_amount', 'sales_amount']), quantity * unitPrice);

    if (!itemName || quantity <= 0) {
      return;
    }

    const key = `${externalOrderId || orderNumber}::${businessDate}::${siteId || siteName || 'na'}`;
    if (!groupedOrders.has(key)) {
      groupedOrders.set(key, {
        external_order_id: externalOrderId || orderNumber,
        order_number: orderNumber,
        site_id: siteId || site?.id || '',
        site_name: siteName || site?.name || '',
        location_name: locationName || siteName || site?.name || '',
        business_date: businessDate,
        sold_at: soldAt,
        currency: String(pickValue(row, ['currency']) || SAR_CODE).trim() || SAR_CODE,
        total_amount: 0,
        items: []
      });
    }

    const order = groupedOrders.get(key);
    order.items.push({
      external_item_id: String(pickValue(row, ['external_item_id', 'line_id']) || `${key}-${order.items.length + 1}`).trim(),
      pos_item_code: itemCode,
      pos_item_name: itemName,
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      site_id: order.site_id,
      site_name: order.site_name
    });
    order.total_amount += totalPrice;
  });

  return Array.from(groupedOrders.values());
}

function KPI({ title, value, subtitle, icon: Icon, accent }) {
  return (
    <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-500">{title}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
            <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
          </div>
          <div className={`rounded-2xl p-3 ${accent}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function POSIntegration() {
  const { can, isManager, loading: permLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('sources');
  const [filters, setFilters] = useState(defaultFilterState);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState(null);
  const [editingMapping, setEditingMapping] = useState(null);
  const [sourceForm, setSourceForm] = useState(emptySourceForm);
  const [mappingForm, setMappingForm] = useState(emptyMappingForm);
  const [sourceError, setSourceError] = useState('');
  const [mappingError, setMappingError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploadSummary, setUploadSummary] = useState(null);
  const [selectedSourceId, setSelectedSourceId] = useState('none');
  const [parsedRows, setParsedRows] = useState([]);
  const [parsedOrders, setParsedOrders] = useState([]);

  const { data: sources = [], isLoading: sourcesLoading } = useQuery({
    queryKey: ['posSources'],
    queryFn: () => base44.pos.listSources()
  });

  const { data: mappings = [], isLoading: mappingsLoading } = useQuery({
    queryKey: ['posMappings'],
    queryFn: () => base44.pos.listMappings(),
    enabled: isManager || can('manage_users')
  });

  const { data: logs = [], isLoading: logsLoading } = useQuery({
    queryKey: ['posSyncLogs'],
    queryFn: () => base44.pos.listSyncLogs(100),
    enabled: isManager || can('manage_users')
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: salesSummary = [], isLoading: salesLoading } = useQuery({
    queryKey: ['posSalesSummary', filters],
    queryFn: () => base44.pos.getSalesSummary({
      start_date: filters.start_date || undefined,
      end_date: filters.end_date || undefined,
      location_id: filters.location_id === 'all' ? undefined : filters.location_id
    }),
    enabled: isManager || can('manage_users')
  });

  const { data: varianceReport = [], isLoading: varianceLoading } = useQuery({
    queryKey: ['posVarianceReport', filters],
    queryFn: () => base44.pos.getVarianceReport({
      start_date: filters.start_date || undefined,
      end_date: filters.end_date || undefined,
      location_id: filters.location_id === 'all' ? undefined : filters.location_id
    }),
    enabled: isManager || can('manage_users')
  });

  const sourceMutation = useMutation({
    mutationFn: async (payload) => {
      const settings = safeJsonParse(payload.settingsText);
      const site = sites.find((entry) => entry.id === payload.default_site_id);
      const body = {
        name: payload.name.trim(),
        source_type: payload.source_type,
        api_url: payload.api_url.trim() || null,
        api_key: payload.api_key.trim() || null,
        api_secret: payload.api_secret.trim() || null,
        sync_frequency: payload.sync_frequency,
        default_site_id: payload.default_site_id || null,
        default_site_name: site?.name || null,
        is_active: payload.is_active,
        settings
      };

      if (editingSource) {
        return base44.pos.updateSource(editingSource.id, body);
      }
      return base44.pos.createSource(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posSources'] });
      setSourceDialogOpen(false);
      setEditingSource(null);
      setSourceForm(emptySourceForm);
      setSourceError('');
    },
    onError: (error) => {
      setSourceError(error.message || 'Failed to save POS source');
    }
  });

  const mappingMutation = useMutation({
    mutationFn: async (payload) => {
      const recipe = recipes.find((entry) => entry.id === payload.recipe_id);
      const body = {
        source_id: payload.source_id === 'all' ? null : payload.source_id,
        pos_item_code: payload.pos_item_code.trim() || null,
        pos_item_name: payload.pos_item_name.trim(),
        recipe_id: payload.recipe_id,
        recipe_name: recipe?.name || '',
        servings_per_sale: Number(payload.servings_per_sale || 1),
        site_scope: payload.site_scope,
        site_id: payload.site_scope === 'site' ? payload.site_id : null,
        auto_deduct: payload.auto_deduct,
        notes: payload.notes.trim() || null
      };

      if (editingMapping) {
        return base44.pos.updateMapping(editingMapping.id, body);
      }
      return base44.pos.createMapping(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posMappings'] });
      setMappingDialogOpen(false);
      setEditingMapping(null);
      setMappingForm(emptyMappingForm);
      setMappingError('');
    },
    onError: (error) => {
      setMappingError(error.message || 'Failed to save POS mapping');
    }
  });

  const syncMutation = useMutation({
    mutationFn: (sourceId) => base44.pos.syncSource(sourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posSyncLogs'] });
      queryClient.invalidateQueries({ queryKey: ['posSalesSummary'] });
      queryClient.invalidateQueries({ queryKey: ['posVarianceReport'] });
    }
  });

  const manualImportMutation = useMutation({
    mutationFn: (payload) => base44.pos.importManual(payload),
    onSuccess: (result) => {
      setUploadSummary(result);
      setUploadError('');
      setParsedRows([]);
      setParsedOrders([]);
      queryClient.invalidateQueries({ queryKey: ['posSyncLogs'] });
      queryClient.invalidateQueries({ queryKey: ['posSalesSummary'] });
      queryClient.invalidateQueries({ queryKey: ['posVarianceReport'] });
    },
    onError: (error) => {
      setUploadError(error.message || 'Failed to import POS file');
    }
  });

  const deleteSourceMutation = useMutation({
    mutationFn: (id) => base44.pos.deleteSource(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posSources'] });
    }
  });

  const deleteMappingMutation = useMutation({
    mutationFn: (id) => base44.pos.deleteMapping(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posMappings'] });
    }
  });

  const sourceMetrics = useMemo(() => {
    const activeCount = sources.filter((source) => source.is_active).length;
    const apiCount = sources.filter((source) => source.source_type === 'api').length;
    return {
      total: sources.length,
      active: activeCount,
      manual: sources.length - apiCount,
      mappedItems: mappings.length
    };
  }, [mappings.length, sources]);

  const varianceMetrics = useMemo(() => {
    const salesQty = salesSummary.reduce((sum, row) => sum + Number(row.total_quantity || 0), 0);
    const salesValue = salesSummary.reduce((sum, row) => sum + Number(row.total_value || 0), 0);
    const totalVariance = varianceReport.reduce((sum, row) => sum + Math.abs(Number(row.variance_quantity || 0)), 0);
    const matchedRows = varianceReport.filter((row) => Number(row.production_quantity || 0) > 0 || Number(row.sales_quantity || 0) > 0);
    return {
      salesQty,
      salesValue,
      totalVariance,
      matchRate: matchedRows.length ? ((matchedRows.length - varianceReport.filter((row) => Number(row.variance_quantity || 0) !== 0).length) / matchedRows.length) * 100 : 0
    };
  }, [salesSummary, varianceReport]);

  const lowCoverageItems = useMemo(
    () => varianceReport.filter((row) => Number(row.variance_quantity || 0) < 0).slice(0, 8),
    [varianceReport]
  );

  const openCreateSource = () => {
    setEditingSource(null);
    setSourceForm(emptySourceForm);
    setSourceError('');
    setSourceDialogOpen(true);
  };

  const openEditSource = (source) => {
    setEditingSource(source);
    setSourceForm({
      name: source.name || '',
      source_type: source.source_type || 'api',
      api_url: source.api_url || '',
      api_key: source.api_key || '',
      api_secret: source.api_secret || '',
      sync_frequency: source.sync_frequency || 'manual',
      default_site_id: source.default_site_id || '',
      is_active: source.is_active !== false,
      settingsText: JSON.stringify(source.settings || { headers: {} }, null, 2)
    });
    setSourceError('');
    setSourceDialogOpen(true);
  };

  const openCreateMapping = () => {
    setEditingMapping(null);
    setMappingForm(emptyMappingForm);
    setMappingError('');
    setMappingDialogOpen(true);
  };

  const openEditMapping = (mapping) => {
    setEditingMapping(mapping);
    setMappingForm({
      source_id: mapping.source_id || 'all',
      pos_item_code: mapping.pos_item_code || '',
      pos_item_name: mapping.pos_item_name || '',
      recipe_id: mapping.recipe_id || '',
      servings_per_sale: String(mapping.servings_per_sale || 1),
      site_scope: mapping.site_scope || 'global',
      site_id: mapping.site_id || '',
      auto_deduct: mapping.auto_deduct !== false,
      notes: mapping.notes || ''
    });
    setMappingError('');
    setMappingDialogOpen(true);
  };

  const handleSourceSubmit = (event) => {
    event.preventDefault();
    setSourceError('');
    if (!sourceForm.name.trim()) {
      setSourceError('Source name is required');
      return;
    }
    if (sourceForm.source_type === 'api' && !sourceForm.api_url.trim()) {
      setSourceError('API URL is required for API sources');
      return;
    }
    try {
      safeJsonParse(sourceForm.settingsText);
    } catch {
      setSourceError('Settings JSON is invalid');
      return;
    }
    sourceMutation.mutate(sourceForm);
  };

  const handleMappingSubmit = (event) => {
    event.preventDefault();
    setMappingError('');
    if (!mappingForm.pos_item_name.trim()) {
      setMappingError('POS item name is required');
      return;
    }
    if (!mappingForm.recipe_id) {
      setMappingError('Select a FoodPro recipe');
      return;
    }
    if (mappingForm.site_scope === 'site' && !mappingForm.site_id) {
      setMappingError('Select a site for site-specific mappings');
      return;
    }
    mappingMutation.mutate(mappingForm);
  };

  const handleManualFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setUploadError('');
    setUploadSummary(null);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      setParsedRows(rows.slice(0, 5));
      const orders = buildManualOrders(rows, sites);

      if (!orders.length) {
        setUploadError('The file loaded, but FoodPro could not group rows into valid POS orders. Check item name and quantity columns, then try again.');
        setParsedOrders([]);
        return;
      }

      setParsedOrders(orders);
    } catch (error) {
      setUploadError(error.message || 'Failed to parse the file');
      setParsedRows([]);
      setParsedOrders([]);
    } finally {
      event.target.value = '';
    }
  };

  const submitManualImport = () => {
    if (!parsedOrders.length) {
      setUploadError('Upload a CSV or Excel file before importing');
      return;
    }
    manualImportMutation.mutate({
      source_id: selectedSourceId === 'none' ? null : selectedSourceId,
      orders: parsedOrders
    });
  };

  if (permLoading || sourcesLoading) {
    return <div className="p-8 text-slate-500">Loading...</div>;
  }

  if (!isManager && !can('manage_users')) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <Card className="max-w-sm w-full text-center p-8">
          <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500 mt-2">Managers and administrators can access POS analytics. Source setup is limited to administrators.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <PageHeader
          title="POS Integration"
          description="Connect external POS feeds, upload sales files, map menu items to recipes, and track sales-to-production variance."
        >
          {can('manage_users') ? (
            <Button onClick={openCreateSource} className="bg-emerald-600 hover:bg-emerald-700">
              <Cable className="mr-2 h-4 w-4" />
              Add POS Source
            </Button>
          ) : null}
        </PageHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <KPI title="POS Sources" value={sourceMetrics.total} subtitle={`${sourceMetrics.active} active connections`} icon={Database} accent="bg-emerald-100 text-emerald-700" />
          <KPI title="Recipe Mappings" value={sourceMetrics.mappedItems} subtitle="Mapped POS items with recipe rules" icon={Link2} accent="bg-blue-100 text-blue-700" />
          <KPI title="Sold Quantity" value={formatNumber(varianceMetrics.salesQty)} subtitle="Units sold in selected period" icon={Store} accent="bg-amber-100 text-amber-700" />
          <KPI title="Variance Volume" value={formatNumber(varianceMetrics.totalVariance)} subtitle={`${formatNumber(varianceMetrics.matchRate, 1)}% matched sales and production`} icon={ArrowUpDown} accent="bg-rose-100 text-rose-700" />
        </div>

        <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Analytics Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <div>
                <Label>Start date</Label>
                <Input
                  type="date"
                  value={filters.start_date}
                  onChange={(event) => setFilters((current) => ({ ...current, start_date: event.target.value }))}
                />
              </div>
              <div>
                <Label>End date</Label>
                <Input
                  type="date"
                  value={filters.end_date}
                  onChange={(event) => setFilters((current) => ({ ...current, end_date: event.target.value }))}
                />
              </div>
              <div>
                <Label>Location</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={filters.location_id}
                  onChange={(event) => setFilters((current) => ({ ...current, location_id: event.target.value }))}
                >
                  <option value="all">All locations</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button variant="outline" className="w-full" onClick={() => setFilters(defaultFilterState)}>
                  Reset Filters
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
            <TabsTrigger value="sources">POS Sources</TabsTrigger>
            <TabsTrigger value="mapping">Recipe Mapping</TabsTrigger>
            <TabsTrigger value="upload">Manual Upload</TabsTrigger>
            <TabsTrigger value="analytics">Sales Analytics</TabsTrigger>
            <TabsTrigger value="logs">Sync Logs</TabsTrigger>
            <TabsTrigger value="api">API Endpoints</TabsTrigger>
          </TabsList>

          <TabsContent value="sources" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Configured POS Sources</CardTitle>
                  {can('manage_users') ? (
                    <Button onClick={openCreateSource} size="sm" className="bg-emerald-600 hover:bg-emerald-700">
                      Add Source
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-3">
                  {sources.map((source) => (
                    <div key={source.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-semibold text-slate-900">{source.name}</h3>
                            <Badge variant={source.is_active ? 'default' : 'secondary'}>
                              {source.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                            <Badge variant="outline">{source.source_type}</Badge>
                          </div>
                          <p className="text-sm text-slate-500">{source.api_url || 'Manual upload source'}</p>
                          <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                            <span>Frequency: {source.sync_frequency || 'manual'}</span>
                            <span>Default site: {source.default_site_name || 'Not assigned'}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {can('manage_users') ? (
                            <>
                              <Button variant="outline" size="sm" onClick={() => openEditSource(source)}>Edit</Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={syncMutation.isPending}
                                onClick={() => syncMutation.mutate(source.id)}
                              >
                                <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                                Sync
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700"
                                onClick={() => deleteSourceMutation.mutate(source.id)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                  {sources.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
                      No POS sources configured yet.
                    </p>
                  ) : null}
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Integration Guidance</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm text-slate-600">
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="font-medium text-slate-900">Recommended API payload</p>
                    <p className="mt-2 text-xs leading-6">
                      Each order should include an order id, business date, sold timestamp, site or location, and an item array with item code, item name, quantity, unit price, and total price.
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="font-medium text-slate-900">Auto-deduction behavior</p>
                    <p className="mt-2 text-xs leading-6">
                      When a POS item is mapped to a FoodPro recipe with auto deduction enabled, sales immediately reduce ingredient stock and post inventory transactions.
                    </p>
                  </div>
                  <div className="rounded-2xl bg-amber-50 p-4 text-amber-900">
                    <p className="font-medium">Manager access</p>
                    <p className="mt-2 text-xs leading-6">
                      Managers can view analytics and logs. Administrators can add sources, sync APIs, upload manual files, and manage mapping rules.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="mapping" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>POS Menu Item Mapping</CardTitle>
                {can('manage_users') ? (
                  <Button onClick={openCreateMapping} size="sm" className="bg-emerald-600 hover:bg-emerald-700">
                    Add Mapping
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                {mappingsLoading ? (
                  <div className="py-10 text-center text-sm text-slate-500">Loading mappings...</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Recipe</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Deduction</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {mappings.map((mapping) => (
                        <TableRow key={mapping.id}>
                          <TableCell className="font-mono text-xs text-slate-600">{mapping.pos_item_code || '—'}</TableCell>
                          <TableCell className="font-medium text-slate-900">{mapping.pos_item_name || '—'}</TableCell>
                          <TableCell>
                            <p className="font-medium text-slate-900">{mapping.recipe_name}</p>
                            <p className="text-xs text-slate-500">{formatNumber(mapping.servings_per_sale, 2)} serving(s) per sale</p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {mapping.site_scope === 'site'
                                ? `${sites.find((site) => site.id === mapping.site_id)?.name || 'Site specific'}`
                                : 'Global'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={mapping.auto_deduct ? 'default' : 'secondary'}>
                              {mapping.auto_deduct ? 'Auto deduct' : 'Manual review'}
                            </Badge>
                          </TableCell>
                          <TableCell>{sources.find((source) => source.id === mapping.source_id)?.name || 'All sources'}</TableCell>
                          <TableCell>
                            {can('manage_users') ? (
                              <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => openEditMapping(mapping)}>Edit</Button>
                                <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => deleteMappingMutation.mutate(mapping.id)}>
                                  Delete
                                </Button>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">View only</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {mappings.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                            No POS item mappings yet.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="upload" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_1fr]">
              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Manual POS Sales Upload</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <Label>Source</Label>
                      <select
                        className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                        value={selectedSourceId}
                        onChange={(event) => setSelectedSourceId(event.target.value)}
                      >
                        <option value="none">Manual upload only</option>
                        {sources.map((source) => (
                          <option key={source.id} value={source.id}>{source.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label>Upload CSV / Excel</Label>
                      <Input type="file" accept=".csv,.xlsx,.xls" onChange={handleManualFile} />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                    <p className="font-medium text-slate-900">Accepted columns</p>
                    <p className="mt-2 leading-6">
                      Use headers like <span className="font-medium">order_id</span>, <span className="font-medium">order_number</span>, <span className="font-medium">business_date</span>, <span className="font-medium">site_id</span>, <span className="font-medium">site_name</span>, <span className="font-medium">pos_item_code</span>, <span className="font-medium">pos_item_name</span>, <span className="font-medium">quantity</span>, <span className="font-medium">unit_price</span>, <span className="font-medium">total_price</span>, and <span className="font-medium">currency</span> using {SAR_CODE} for {SAR_NAME}.
                    </p>
                  </div>

                  {uploadError ? (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {uploadError}
                    </div>
                  ) : null}

                  {uploadSummary ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                      Imported {uploadSummary.records_imported} order(s), skipped {uploadSummary.records_skipped}, received {uploadSummary.records_received}.
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-3">
                    <Button onClick={submitManualImport} disabled={!can('manage_users') || !parsedOrders.length || manualImportMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
                      {manualImportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                      Import Orders
                    </Button>
                    <Badge variant="outline">{parsedOrders.length} parsed order(s)</Badge>
                    <Badge variant="outline">{parsedRows.length} preview row(s)</Badge>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Upload Preview</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {parsedRows.length ? (
                    <div className="overflow-x-auto rounded-2xl border border-slate-200">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {Object.keys(parsedRows[0]).slice(0, 6).map((header) => (
                              <TableHead key={header}>{header}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {parsedRows.map((row, rowIndex) => (
                            <TableRow key={`preview-${rowIndex}`}>
                              {Object.keys(parsedRows[0]).slice(0, 6).map((header) => (
                                <TableCell key={`${rowIndex}-${header}`} className="max-w-[180px] truncate">
                                  {String(row[header] ?? '')}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : null}

                  {parsedOrders.slice(0, 5).map((order) => (
                    <div key={`${order.external_order_id}-${order.business_date}`} className="rounded-2xl border border-slate-200 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-900">{order.order_number}</p>
                          <p className="text-xs text-slate-500">{order.site_name || order.location_name || 'Unknown location'} • {order.business_date}</p>
                        </div>
                        <Badge variant="outline">{order.items.length} item(s)</Badge>
                      </div>
                      <div className="mt-3 space-y-1 text-sm text-slate-600">
                        {order.items.slice(0, 4).map((item) => (
                          <div key={item.external_item_id} className="flex items-center justify-between gap-3">
                            <span>{item.pos_item_name}</span>
                            <span>{formatNumber(item.quantity, 2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {!parsedRows.length && !parsedOrders.length ? (
                    <div className="py-10 text-center text-sm text-slate-500">
                      Upload a file to preview POS rows and grouped orders.
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="analytics" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_1fr]">
              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Daily Sales Quantity by Item and Location</CardTitle>
                </CardHeader>
                <CardContent>
                  {salesLoading ? (
                    <div className="py-10 text-center text-sm text-slate-500">Loading sales summary...</div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item Code</TableHead>
                          <TableHead>Item Name</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Quantity</TableHead>
                          <TableHead>Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {salesSummary.map((row, index) => (
                          <TableRow key={`${row.business_date}-${row.location_name}-${row.pos_item_name}-${index}`}>
                            <TableCell className="font-mono text-xs text-slate-600">{row.pos_item_code || row.item_code || '—'}</TableCell>
                            <TableCell className="font-medium">{row.pos_item_name || row.item_name || '—'}</TableCell>
                            <TableCell>{row.business_date}</TableCell>
                            <TableCell>{row.location_name}</TableCell>
                            <TableCell>{formatNumber(row.total_quantity, 2)}</TableCell>
                            <TableCell>{formatCurrency(row.total_value)}</TableCell>
                          </TableRow>
                        ))}
                        {salesSummary.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
                              No sales data found for the selected filters.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                  <CardHeader>
                    <CardTitle>Variance Snapshot</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Sales value</p>
                      <p className="mt-1 text-2xl font-semibold text-slate-900">{formatCurrency(varianceMetrics.salesValue)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Variance volume</p>
                      <p className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(varianceMetrics.totalVariance, 2)}</p>
                    </div>
                    <div className="rounded-2xl bg-amber-50 p-4 text-amber-900">
                      <p className="text-sm font-medium">Low production coverage</p>
                      <p className="mt-1 text-xs leading-6">
                        {lowCoverageItems.length
                          ? `${lowCoverageItems.length} item/location combinations sold more than produced.`
                          : 'No underproduction gaps detected in the selected period.'}
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                  <CardHeader>
                    <CardTitle>Exception Watchlist</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {lowCoverageItems.map((row, index) => (
                      <div key={`${row.business_date}-${row.item_name}-${index}`} className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                        <p className="font-medium text-rose-900">{row.item_name}</p>
                        <p className="mt-1 text-xs text-rose-800">{row.site_name} • {row.business_date}</p>
                        <p className="mt-2 text-sm text-rose-800">
                          Sold {formatNumber(row.sales_quantity, 2)} vs produced {formatNumber(row.production_quantity, 2)}
                        </p>
                      </div>
                    ))}
                    {!lowCoverageItems.length ? (
                      <div className="py-6 text-center text-sm text-slate-500">
                        No exception items right now.
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </div>
            </div>

            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader>
                <CardTitle>Sales vs Production Variance Report</CardTitle>
              </CardHeader>
              <CardContent>
                {varianceLoading ? (
                  <div className="py-10 text-center text-sm text-slate-500">Loading variance report...</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Sales Qty</TableHead>
                        <TableHead>Production Qty</TableHead>
                        <TableHead>Variance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {varianceReport.map((row, index) => (
                        <TableRow key={`${row.business_date}-${row.item_key}-${index}`}>
                          <TableCell className="font-mono text-xs text-slate-600">{row.pos_item_code || row.item_code || '—'}</TableCell>
                          <TableCell className="font-medium">{row.item_name || '—'}</TableCell>
                          <TableCell>{row.business_date}</TableCell>
                          <TableCell>{row.site_name}</TableCell>
                          <TableCell>{formatNumber(row.sales_quantity, 2)}</TableCell>
                          <TableCell>{formatNumber(row.production_quantity, 2)}</TableCell>
                          <TableCell>
                            <span className={Number(row.variance_quantity) < 0 ? 'text-red-600' : 'text-slate-700'}>
                              {formatNumber(row.variance_quantity, 2)}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                      {varianceReport.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                            No variance data found for the selected filters.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="logs" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader>
                <CardTitle>POS Sync Logs</CardTitle>
              </CardHeader>
              <CardContent>
                {logsLoading ? (
                  <div className="py-10 text-center text-sm text-slate-500">Loading sync logs...</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Started</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Imported</TableHead>
                        <TableHead>Skipped</TableHead>
                        <TableHead>Message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell>{formatDateTime(log.started_at)}</TableCell>
                          <TableCell>{sources.find((source) => source.id === log.source_id)?.name || 'Manual Upload'}</TableCell>
                          <TableCell>{log.sync_type}</TableCell>
                          <TableCell>
                            <Badge variant={log.status === 'error' ? 'destructive' : (log.status === 'warning' ? 'secondary' : 'default')}>
                              {log.status}
                            </Badge>
                          </TableCell>
                          <TableCell>{formatNumber(log.records_imported)}</TableCell>
                          <TableCell>{formatNumber(log.records_skipped)}</TableCell>
                          <TableCell className="max-w-[320px] truncate">{log.message || '-'}</TableCell>
                        </TableRow>
                      ))}
                      {logs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                            No sync logs recorded yet.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="api" className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Available Endpoints</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {[
                    'GET /api/pos/sources',
                    'POST /api/pos/sources',
                    'PATCH /api/pos/sources/:id',
                    'POST /api/pos/sources/:id/sync',
                    'GET /api/pos/mappings',
                    'POST /api/pos/mappings',
                    'POST /api/pos/import/manual',
                    'GET /api/pos/sales-summary',
                    'GET /api/pos/variance-report',
                    'POST /api/pos/webhooks/:sourceId'
                  ].map((endpoint) => (
                    <div key={endpoint} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
                      {endpoint}
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Future Integration Notes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm text-slate-600">
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="font-medium text-slate-900">Recommended webhook contract</p>
                    <p className="mt-2 leading-6">
                      Send a JSON array or an <span className="font-medium">orders</span> array. Each order can include location info plus sold items. The webhook endpoint already routes those orders into the same import engine used by API sync and manual upload.
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <p className="font-medium text-slate-900">Authentication strategy</p>
                    <p className="mt-2 leading-6">
                      For production rollout, add source-level webhook secrets or HMAC verification on top of the current authenticated endpoint pattern.
                    </p>
                  </div>
                  <div className="rounded-2xl bg-blue-50 p-4 text-blue-900">
                    <p className="font-medium">Deployment readiness</p>
                    <p className="mt-2 leading-6">
                      The database tables, API routes, manual import flow, and variance analytics are ready in the repo for Dokploy deployment once the latest commit is redeployed.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={sourceDialogOpen} onOpenChange={(open) => { setSourceDialogOpen(open); if (!open) setSourceError(''); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingSource ? 'Edit POS Source' : 'Create POS Source'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSourceSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>Source name</Label>
                <Input value={sourceForm.name} onChange={(event) => setSourceForm((current) => ({ ...current, name: event.target.value }))} placeholder="Talabat POS" />
              </div>
              <div>
                <Label>Source type</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={sourceForm.source_type}
                  onChange={(event) => setSourceForm((current) => ({ ...current, source_type: event.target.value }))}
                >
                  <option value="api">API</option>
                  <option value="manual">Manual</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </div>
            </div>

            <div>
              <Label>API URL</Label>
              <Input value={sourceForm.api_url} onChange={(event) => setSourceForm((current) => ({ ...current, api_url: event.target.value }))} placeholder="https://partner.example.com/orders" />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>API key</Label>
                <Input value={sourceForm.api_key} onChange={(event) => setSourceForm((current) => ({ ...current, api_key: event.target.value }))} placeholder="Bearer token or partner key" />
              </div>
              <div>
                <Label>API secret</Label>
                <Input value={sourceForm.api_secret} onChange={(event) => setSourceForm((current) => ({ ...current, api_secret: event.target.value }))} placeholder="Optional shared secret" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>Sync frequency</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={sourceForm.sync_frequency}
                  onChange={(event) => setSourceForm((current) => ({ ...current, sync_frequency: event.target.value }))}
                >
                  <option value="manual">Manual</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="webhook">Webhook</option>
                </select>
              </div>
              <div>
                <Label>Default location</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={sourceForm.default_site_id || 'none'}
                  onChange={(event) => setSourceForm((current) => ({ ...current, default_site_id: event.target.value === 'none' ? '' : event.target.value }))}
                >
                  <option value="none">No default location</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <Label>Extra settings JSON</Label>
              <Textarea
                rows={7}
                value={sourceForm.settingsText}
                onChange={(event) => setSourceForm((current) => ({ ...current, settingsText: event.target.value }))}
                placeholder='{"headers":{"X-Store-Key":"value"}}'
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={sourceForm.is_active}
                onChange={(event) => setSourceForm((current) => ({ ...current, is_active: event.target.checked }))}
              />
              Source is active
            </label>

            {sourceError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {sourceError}
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSourceDialogOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={sourceMutation.isPending}>
                {sourceMutation.isPending ? 'Saving...' : editingSource ? 'Save Changes' : 'Create Source'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mappingDialogOpen} onOpenChange={(open) => { setMappingDialogOpen(open); if (!open) setMappingError(''); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingMapping ? 'Edit Recipe Mapping' : 'Create Recipe Mapping'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleMappingSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>POS source</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mappingForm.source_id}
                  onChange={(event) => setMappingForm((current) => ({ ...current, source_id: event.target.value }))}
                >
                  <option value="all">All sources</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>{source.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>FoodPro recipe</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mappingForm.recipe_id}
                  onChange={(event) => setMappingForm((current) => ({ ...current, recipe_id: event.target.value }))}
                >
                  <option value="">Select recipe</option>
                  {recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>POS item code</Label>
                <Input value={mappingForm.pos_item_code} onChange={(event) => setMappingForm((current) => ({ ...current, pos_item_code: event.target.value }))} placeholder="SKU-001" />
              </div>
              <div>
                <Label>POS item name</Label>
                <Input value={mappingForm.pos_item_name} onChange={(event) => setMappingForm((current) => ({ ...current, pos_item_name: event.target.value }))} placeholder="Chicken Biryani Meal" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label>Servings per sale</Label>
                <Input type="number" min="0.01" step="0.01" value={mappingForm.servings_per_sale} onChange={(event) => setMappingForm((current) => ({ ...current, servings_per_sale: event.target.value }))} />
              </div>
              <div>
                <Label>Scope</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mappingForm.site_scope}
                  onChange={(event) => setMappingForm((current) => ({ ...current, site_scope: event.target.value }))}
                >
                  <option value="global">Global</option>
                  <option value="site">Location specific</option>
                </select>
              </div>
              <div>
                <Label>Location</Label>
                <select
                  className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mappingForm.site_id || 'none'}
                  onChange={(event) => setMappingForm((current) => ({ ...current, site_id: event.target.value === 'none' ? '' : event.target.value }))}
                  disabled={mappingForm.site_scope !== 'site'}
                >
                  <option value="none">No location</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <Label>Mapping notes</Label>
              <Textarea rows={4} value={mappingForm.notes} onChange={(event) => setMappingForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Special logic for combo meal or garnish deductions" />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={mappingForm.auto_deduct}
                onChange={(event) => setMappingForm((current) => ({ ...current, auto_deduct: event.target.checked }))}
              />
              Deduct ingredients automatically after POS import
            </label>

            {mappingError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {mappingError}
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMappingDialogOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={mappingMutation.isPending}>
                {mappingMutation.isPending ? 'Saving...' : editingMapping ? 'Save Changes' : 'Create Mapping'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
