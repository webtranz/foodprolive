import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  RotateCcw,
  Settings,
  ShieldAlert
} from 'lucide-react';
import { downloadCSV, downloadExcel } from '@/components/utils/exportData';

const moduleDefinitions = [
  {
    key: 'po_api',
    label: 'PO API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: 'PurchTable, PurchLine, LogisticsPostalAddressBaseEntity, VendPackingSlipJour, InventDim, ReleasedProduct',
    description: 'Fetch updated and confirmed purchase orders by PO date and optional PurchID.',
    trigger: 'Date parameters pull PO header, line, delivery, and item details from D365.'
  },
  {
    key: 'warehouse_project_api',
    label: 'Warehouse and Project API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: 'InventLocation, ProjTable',
    description: 'Synchronize activated warehouses and projects into FoodPro master data.',
    trigger: 'Runs as a scheduled batch job at a configured interval.'
  },
  {
    key: 'movement_api',
    label: 'Movement / Issuance API',
    direction: 'App -> D365',
    method: 'POST',
    entities: 'InventJournalTable, InventJournalTrans',
    description: 'Post movement and issuance transactions so D365 can create inventory journals.',
    trigger: 'Sent when FoodPro finalizes movement, issuance, production consumption, or transfer activity.'
  },
  {
    key: 'inventory_sync_api',
    label: 'Inventory Sync API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: 'InventSum / InventOnHand',
    description: 'Keep available, ordered, and reserved inventory figures aligned.',
    trigger: 'Triggered by D365 inventory updates and before FoodPro transactional posting.'
  },
  {
    key: 'uom_api',
    label: 'Unit of Measure API',
    direction: 'D365 -> App',
    method: 'GET',
    entities: 'UnitOfMeasureConversionStandard',
    description: 'Synchronize D365 item-level unit conversion factors.',
    trigger: 'Triggered whenever D365 UOM conversion data changes.'
  }
];

const fieldSpecs = {
  po_api: [
    ['Input', 'Date (PO Date)', 'PurchTable.TransDate', 'Date', 'Yes'],
    ['Input', 'PurchID (PO Number)', 'PurchTable.PurchId', 'String', 'Optional'],
    ['Header', 'PO Number', 'PurchTable.PurchId', 'String', 'Yes'],
    ['Header', 'Vendor Account', 'PurchTable.OrderAccount', 'String', 'Yes'],
    ['Header', 'PO Created DateTime', 'PurchTable.CreatedDateTime', 'DateTime', 'Yes'],
    ['Header', 'PO Modified DateTime', 'PurchTable.ModifiedDateTime', 'DateTime', 'Yes'],
    ['Header', 'PO Status', 'enum2Str(PurchTable.DocumentState)', 'Enum -> String', 'Yes'],
    ['Line', 'Inventory Dimension ID', 'PurchLine.InventDimId', 'String', 'Yes'],
    ['Line', 'Item ID', 'PurchLine.ItemId', 'String', 'Yes'],
    ['Line', 'Delivery Date', 'PurchLine.DeliveryDate', 'Date', 'Yes'],
    ['Line', 'Purchase Unit', 'PurchLine.PurchUnit', 'String', 'Yes'],
    ['Line', 'Quantity Ordered', 'PurchLine.QtyOrdered', 'Decimal', 'Yes'],
    ['Line', 'Item Name', 'PurchLine.Name', 'String', 'Yes']
  ],
  warehouse_project_api: [
    ['Warehouse', 'Site ID', 'InventLocation.InventSiteId', 'String', 'Yes'],
    ['Warehouse', 'Warehouse ID', 'InventLocation.InventLocationId', 'String', 'Yes'],
    ['Warehouse', 'Warehouse Name', 'InventLocation.Name', 'String', 'Yes'],
    ['Project', 'Project ID', 'ProjTable.ProjID', 'String', 'Yes'],
    ['Project', 'Project Name', 'ProjTable.Name', 'String', 'Yes']
  ],
  movement_api: [
    ['Common', 'Date & Time', 'InventJournalTrans.TransDate', 'DateTime', 'Yes'],
    ['Common', 'Item ID', 'InventJournalTrans.ItemId', 'String', 'Yes'],
    ['Common', 'Quantity', 'InventJournalTrans.Qty', 'Decimal', 'Yes'],
    ['Common', 'Movement Direction', 'Derived issue / return', 'String', 'Yes'],
    ['Common', 'Unit', 'InventJournalTrans.UnitId', 'String', 'Yes'],
    ['Audit', 'Transaction Type', 'FoodPro inventory transaction', 'String', 'Yes'],
    ['Audit', 'Source', 'FoodPro source system', 'String', 'Yes'],
    ['Audit', 'Source Type', 'FoodPro movement source', 'String', 'Yes'],
    ['Audit', 'Reason Code', 'FoodPro movement reason', 'String', 'Optional'],
    ['Value', 'Unit Cost', 'FoodPro accounting unit cost', 'Decimal', 'Yes'],
    ['Value', 'Total Cost', 'FoodPro accounting movement value', 'Decimal', 'Yes'],
    ['Common', 'Originating Warehouse', 'InventDim.InventLocationId', 'String', 'Yes'],
    ['Common', 'D365 Project Code', 'InventJournalTrans.ProjId', 'String', 'Yes'],
    ['Common', 'Activity', 'InventJournalTrans.ActivityNumber', 'Enum/String', 'Yes'],
    ['Movement Only', 'Destination Warehouse', 'InventDim.InventLocationId (To)', 'String', 'Yes'],
    ['Response', 'Confirmation / Error', 'D365 response', 'String', 'Always']
  ],
  inventory_sync_api: [
    ['Required', 'Item ID', 'InventSum.ItemId', 'String', 'Yes'],
    ['Required', 'Item Name', 'InventTable.NameAlias / ItemName', 'String', 'Yes'],
    ['Required', 'Warehouse ID', 'InventDim.InventLocationId', 'String', 'Yes'],
    ['Required', 'Available Quantity', 'InventSum.AvailPhysical', 'Decimal', 'Yes'],
    ['Required', 'Unit', 'InventTableModule.UnitId', 'String', 'Yes'],
    ['Batch', 'Batch Number', 'InventDim.InventBatchId', 'String', 'Optional - generated when blank'],
    ['Batch', 'Stock Date', 'InventBatch / receipt date', 'Date', 'Yes - import default allowed'],
    ['Batch', 'Expiry Date', 'InventBatch.ExpiryDate', 'Date', 'Optional'],
    ['Cost', 'Unit Cost', 'InventItemPrice / receipt cost', 'Decimal', 'Optional'],
    ['Optional', 'Ordered in Total', 'InventSum.Ordered', 'Decimal', 'Optional'],
    ['Optional', 'On Order (Reserved)', 'InventSum.OnOrder', 'Decimal', 'Optional']
  ],
  uom_api: [
    ['Required', 'Item ID', 'Item', 'String', 'Yes'],
    ['Required', 'Unit1', 'From unit', 'String', 'Yes'],
    ['Required', 'Unit2', 'To unit', 'String', 'Yes'],
    ['Required', 'Factor', 'Conversion factor', 'Decimal', 'Yes'],
    ['Required', 'Numerator', 'Initial unit figure', 'Decimal', 'Yes'],
    ['Required', 'Denominator', 'Second unit figure', 'Decimal', 'Yes']
  ]
};

const emptyConfig = {
  provider_name: 'Dynamics 365 Finance & Operations',
  api_endpoint: '',
  api_key: '',
  sync_schedule: 'manual',
  data_mapping: JSON.stringify({
    po_api: {
      'PO Number': 'po_number',
      'Vendor Account': 'vendor_account',
      'PO Created DateTime': 'po_created_datetime',
      'PO Modified DateTime': 'po_modified_datetime',
      'PO Status': 'po_status',
      'Inventory Dimension ID': 'inventory_dimension_id',
      'Item ID': 'item_id',
      'Delivery Date': 'delivery_date',
      'Purchase Unit': 'purchase_unit',
      'Quantity Ordered': 'quantity_ordered',
      'Item Name': 'item_name'
    },
    warehouse_project_api: {
      'Record Type': 'record_type',
      'Site ID': 'site_id',
      'Warehouse ID': 'warehouse_id',
      'Warehouse Name': 'warehouse_name',
      'Project ID': 'project_id',
      'Project Name': 'project_name'
    },
    movement_api: {
      'Date & Time': 'date_time',
      'Item ID': 'item_id',
      Quantity: 'quantity',
      'Movement Direction': 'movement_direction',
      Unit: 'unit',
      'Transaction Type': 'transaction_type',
      Source: 'source',
      'Source Type': 'source_type',
      'Reason Code': 'reason_code',
      'Unit Cost': 'unit_cost',
      'Total Cost': 'total_cost',
      'Originating Warehouse': 'originating_warehouse',
      'D365 Project Code': 'd365_project_code',
      Activity: 'activity',
      'Destination Warehouse': 'destination_warehouse',
      'Confirmation / Error': 'confirmation_or_error'
    },
    inventory_sync_api: {
      'Item ID': 'item_id',
      'Item Name': 'item_name',
      'Warehouse ID': 'warehouse_id',
      'Available Quantity': 'available_quantity',
      Unit: 'unit',
      'Batch Number': 'batch_number',
      'Stock Date': 'stock_date',
      'Expiry Date': 'expiry_date',
      'Unit Cost': 'unit_cost',
      'External Event ID': 'external_event_id',
      'External Line ID': 'external_line_id',
      'Ordered in Total': 'ordered_in_total',
      'On Order (Reserved)': 'on_order_reserved'
    },
    uom_api: {
      'Item ID': 'item_id',
      Unit1: 'unit1',
      Unit2: 'unit2',
      Factor: 'factor',
      Numerator: 'numerator',
      Denominator: 'denominator'
    }
  }, null, 2),
  error_notes: '',
  is_active: true
};

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success' || normalized === 'retried') return 'bg-emerald-100 text-emerald-700';
  if (normalized === 'failed') return 'bg-red-100 text-red-700';
  return 'bg-amber-100 text-amber-700';
}

function normalizeRows(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || result?.items || result?.results || result?.reconciliation_rows || result?.data || [];
}

function getLogRows(log, details) {
  const direct = normalizeRows(details);
  if (direct.length > 0) return direct;
  const sources = [log?.line_results, log?.reconciliation_rows, log?.response_payload, log?.request_payload];
  for (const source of sources) {
    const rows = normalizeRows(source);
    if (rows.length > 0) return rows;
  }
  return [];
}

function logDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : format(parsed, 'MMM d, yyyy HH:mm');
}

const LOG_DETAIL_PAGE_SIZE = 100;

export default function D365Integration() {
  const queryClient = useQueryClient();
  const { can, isAdmin, loading: permLoading } = usePermissions();
  const [activeTab, setActiveTab] = useState('imports');
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [previewDialog, setPreviewDialog] = useState({ open: false, rows: [], moduleKey: '' });
  const [message, setMessage] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [logDetailPage, setLogDetailPage] = useState(1);
  const [importForm, setImportForm] = useState({
    sync_mode: 'receipt',
    warehouse_id: '',
    batch_number: '',
    stock_date: format(new Date(), 'yyyy-MM-dd'),
    expiry_date: '',
    unit_cost: '',
    notes: ''
  });
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    category: 'all'
  });
  const [configForm, setConfigForm] = useState(emptyConfig);

  const { data: configs = [] } = useQuery({
    queryKey: ['erpConfigs'],
    queryFn: () => base44.entities.ERPIntegrationConfig.list('-updated_date', 100),
    enabled: can('manage_erp')
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['erpLogs'],
    queryFn: () => base44.erp.listLogs(),
    enabled: can('manage_erp')
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
    enabled: can('manage_erp')
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list(),
    enabled: can('manage_erp')
  });

  const activeConfig = useMemo(() => configs.find((config) => config.is_active !== false) || configs[0] || null, [configs]);
  const categories = useMemo(() => [...new Set(recipes.map((recipe) => recipe.category).filter(Boolean))].sort(), [recipes]);
  const failedLogs = useMemo(() => logs.filter((log) => log.status === 'failed').slice(0, 5), [logs]);
  const inboundModules = useMemo(() => moduleDefinitions.filter((module) => module.direction.startsWith('D365')), []);
  const outboundModules = useMemo(() => moduleDefinitions.filter((module) => !module.direction.startsWith('D365')), []);
  const importPreviewRows = useMemo(() => normalizeRows(importPreview), [importPreview]);
  const effectiveMapping = useMemo(() => ({
    ...JSON.parse(emptyConfig.data_mapping),
    ...(activeConfig?.data_mapping || {})
  }), [activeConfig]);
  const canPreviewInventoryImport = typeof base44.erp.previewInventoryImport === 'function';
  const canImportInventory = typeof base44.erp.importInventory === 'function';
  const canGetLogDetails = typeof base44.erp.getLogDetails === 'function';
  const canManageErp = can('manage_erp');
  const canManageInventory = can('manage_inventory');
  const canRunInventoryImport = canManageErp && canManageInventory;

  const {
    data: selectedLogDetails = null,
    isLoading: logDetailsLoading,
    isFetching: logDetailsFetching,
    isError: logDetailsFailed,
    error: logDetailsError
  } = useQuery({
    queryKey: ['erpLogDetails', selectedLog?.id, logDetailPage],
    queryFn: () => base44.erp.getLogDetails(selectedLog.id, {
      include_lines: true,
      page: logDetailPage,
      limit: LOG_DETAIL_PAGE_SIZE
    }),
    enabled: Boolean(selectedLog?.id && canGetLogDetails)
  });
  const selectedLogRows = useMemo(
    () => (selectedLogDetails ? normalizeRows(selectedLogDetails) : getLogRows(selectedLog, null)),
    [selectedLog, selectedLogDetails]
  );
  const selectedLogTotalCount = selectedLogDetails
    ? Number(selectedLogDetails.total_count ?? selectedLogRows.length)
    : selectedLogRows.length;
  const selectedLogCurrentPage = Number(selectedLogDetails?.page || logDetailPage);
  const selectedLogPageSize = Number(selectedLogDetails?.limit || LOG_DETAIL_PAGE_SIZE);
  const selectedLogTotalPages = Math.max(
    1,
    Number(selectedLogDetails?.total_pages)
      || Math.ceil(selectedLogTotalCount / selectedLogPageSize)
      || 1
  );
  const selectedLogFirstRow = selectedLogTotalCount > 0
    ? ((selectedLogCurrentPage - 1) * selectedLogPageSize) + 1
    : 0;
  const selectedLogLastRow = Math.min(
    selectedLogTotalCount,
    selectedLogFirstRow + selectedLogRows.length - 1
  );

  useEffect(() => {
    const unsubscribe = base44.entities.ERPIntegrationLog?.subscribe?.(() => {
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
    });
    return () => unsubscribe?.();
  }, [queryClient]);

  useEffect(() => {
    setImportPreview(null);
  }, [
    activeConfig?.id,
    activeConfig?.updated_date,
    filters.startDate,
    filters.endDate,
    filters.locationId,
    importForm.sync_mode,
    importForm.warehouse_id,
    importForm.batch_number,
    importForm.stock_date,
    importForm.expiry_date,
    importForm.unit_cost,
    importForm.notes
  ]);

  const configMutation = useMutation({
    mutationFn: async (payload) => {
      const body = {
        provider_name: payload.provider_name,
        api_endpoint: payload.api_endpoint,
        api_key: payload.api_key,
        sync_schedule: payload.sync_schedule,
        data_mapping: JSON.parse(payload.data_mapping || '{}'),
        error_notes: payload.error_notes,
        is_active: payload.is_active
      };
      if (activeConfig) {
        return base44.entities.ERPIntegrationConfig.update(activeConfig.id, body);
      }
      return base44.entities.ERPIntegrationConfig.create(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['erpConfigs'] });
      setConfigDialogOpen(false);
      setMessage('ERP settings saved.');
    },
    onError: (error) => {
      setMessage(error.message || 'Failed to save ERP settings');
    }
  });

  const exportMutation = useMutation({
    mutationFn: (payload) => base44.erp.export(payload),
    onSuccess: (result, variables) => {
      setMessage(`Export completed for ${variables.module_key.replace(/_/g, ' ')}.`);
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });

      if (variables.transport === 'csv') {
        downloadCSV(result.rows || [], result.filename || variables.module_key);
      }
      if (variables.transport === 'excel') {
        downloadExcel(result.rows || [], result.filename || variables.module_key, variables.module_key.slice(0, 28));
      }
      if (variables.transport === 'preview') {
        setPreviewDialog({ open: true, rows: result.rows || [], moduleKey: variables.module_key });
      }
    },
    onError: (error) => {
      setMessage(error.message || 'ERP export failed');
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
    }
  });

  const previewImportMutation = useMutation({
    mutationFn: (payload) => {
      if (!canPreviewInventoryImport) throw new Error('Inventory import preview is not available on this server yet.');
      return base44.erp.previewInventoryImport(payload);
    },
    onSuccess: (result) => {
      setImportPreview(result || { rows: [] });
      setMessage(`D365 inventory preview completed: ${normalizeRows(result).length} rows returned.`);
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
    },
    onError: (error) => {
      setMessage(error.message || 'D365 inventory preview failed');
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
    }
  });

  const inventoryImportMutation = useMutation({
    mutationFn: (payload) => {
      if (!canImportInventory) throw new Error('Inventory import is not available on this server yet.');
      return base44.erp.importInventory(payload);
    },
    onSuccess: (result) => {
      const imported = result?.imported ?? result?.processed ?? result?.records_count ?? normalizeRows(result).length;
      setMessage(`D365 inventory import completed: ${imported || 0} rows reconciled.`);
      setImportPreview(null);
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => {
      setMessage(error.message || 'D365 inventory import failed');
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
    }
  });

  const retryMutation = useMutation({
    mutationFn: (id) => base44.erp.retryLog(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
      setMessage('Retry completed successfully.');
    },
    onError: (error) => {
      setMessage(error.message || 'Retry failed');
      queryClient.invalidateQueries({ queryKey: ['erpLogs'] });
    }
  });

  const openSettings = () => {
    if (activeConfig) {
      setConfigForm({
        provider_name: activeConfig.provider_name || '',
        api_endpoint: activeConfig.api_endpoint || '',
        api_key: activeConfig.api_key || '',
        sync_schedule: activeConfig.sync_schedule || 'manual',
        data_mapping: JSON.stringify(effectiveMapping, null, 2),
        error_notes: activeConfig.error_notes || '',
        is_active: activeConfig.is_active !== false
      });
    } else {
      setConfigForm(emptyConfig);
    }
    setConfigDialogOpen(true);
  };

  const triggerExport = (moduleKey, transport) => {
    exportMutation.mutate({
      config_id: activeConfig?.id || null,
      module_key: moduleKey,
      transport,
      start_date: filters.startDate,
      end_date: filters.endDate,
      location_id: filters.locationId === 'all' ? '' : filters.locationId,
      category: filters.category === 'all' ? '' : filters.category
    });
  };

  const inventoryImportPayload = (dryRun = false) => ({
    config_id: activeConfig?.id || null,
    module_key: 'inventory_sync_api',
    sync_mode: importForm.sync_mode,
    quantity_semantics: importForm.sync_mode,
    warehouse_id: importForm.warehouse_id.trim(),
    location_id: filters.locationId === 'all' ? '' : filters.locationId,
    batch_number: importForm.batch_number.trim() || null,
    stock_date: importForm.stock_date,
    expiry_date: importForm.expiry_date || null,
    unit_cost: importForm.unit_cost === '' ? null : Number(importForm.unit_cost),
    notes: importForm.notes.trim(),
    start_date: filters.startDate,
    end_date: filters.endDate,
    dry_run: dryRun
  });

  const stats = {
    configured: activeConfig ? 'Configured' : 'Not Configured',
    logs: logs.length,
    failed: logs.filter((log) => log.status === 'failed').length,
    schedule: activeConfig?.sync_schedule || 'manual'
  };

  if (permLoading) {
    return <div className="p-8 text-slate-500">Loading integration workspace...</div>;
  }

  if (!canManageErp) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <Card className="max-w-sm w-full text-center p-8">
          <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500 mt-2">Your role does not include ERP integration management permission.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <PageHeader
          title="D365 Integration"
          description="Map FoodPro data to the Dynamics 365 Finance & Operations APIs for purchase orders, warehouses, projects, movement journals, inventory, and units of measure"
        >
          {isAdmin ? (
            <Button onClick={openSettings} className="bg-indigo-600 hover:bg-indigo-700">
              <Settings className="w-4 h-4 mr-2" />
              Integration Settings
            </Button>
          ) : null}
        </PageHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-600">Provider</p><p className="text-lg font-semibold text-slate-900">{activeConfig?.provider_name || 'Dynamics 365 F&O'}</p></div><Database className="w-8 h-8 text-indigo-600" /></div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-600">Status</p><p className="text-lg font-semibold text-slate-900">{stats.configured}</p></div><CheckCircle2 className="w-8 h-8 text-emerald-600" /></div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-600">Integration Logs</p><p className="text-lg font-semibold text-slate-900">{stats.logs}</p></div><Cable className="w-8 h-8 text-blue-600" /></div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-600">Failed Syncs</p><p className="text-lg font-semibold text-slate-900">{stats.failed}</p></div><AlertTriangle className="w-8 h-8 text-amber-600" /></div></CardContent></Card>
        </div>

        {message ? (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            {message}
          </div>
        ) : null}

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>D365 Sync Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div>
                <Label>Start Date</Label>
                <Input type="date" className="mt-1" value={filters.startDate} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))} />
              </div>
              <div>
                <Label>End Date</Label>
                <Input type="date" className="mt-1" value={filters.endDate} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))} />
              </div>
              <div>
                <Label>Location</Label>
                <Select value={filters.locationId} onValueChange={(value) => {
                  setFilters((current) => ({ ...current, locationId: value }));
                  const site = sites.find((entry) => entry.id === value);
                  if (site) {
                    setImportForm((current) => ({
                      ...current,
                      warehouse_id: site.d365_warehouse_id || ''
                    }));
                  }
                }}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select value={filters.category} onValueChange={(value) => setFilters((current) => ({ ...current, category: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-4">
            <TabsTrigger value="imports">Inbound Imports / Pull</TabsTrigger>
            <TabsTrigger value="exports">Outbound Exports</TabsTrigger>
            <TabsTrigger value="logs">Integration Logs</TabsTrigger>
            <TabsTrigger value="settings">Settings & Mapping</TabsTrigger>
          </TabsList>

          <TabsContent value="imports" className="space-y-4">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>D365 Inventory Import & Reconciliation</CardTitle>
                    <p className="mt-1 text-sm text-slate-500">Pull stock into the correct FoodPro store, preview every change, then post auditable batch receipts or snapshot adjustments.</p>
                  </div>
                  <Badge className="bg-emerald-100 text-emerald-700">D365 → FoodPro</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                {!canRunInventoryImport ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Inventory imports require both ERP integration and inventory-management permission. You can still review integration logs and mappings.
                  </div>
                ) : !canPreviewInventoryImport || !canImportInventory ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    The connected server does not yet expose the full inbound inventory import API. Contract details and controls remain visible; Preview and Apply are disabled until both endpoints are available.
                  </div>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <Label>Import Mode</Label>
                    <Select value={importForm.sync_mode} onValueChange={(value) => {
                      setImportForm((current) => ({ ...current, sync_mode: value }));
                      setImportPreview(null);
                    }}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="receipt">Receipt — add incoming stock</SelectItem>
                        <SelectItem value="snapshot">Snapshot — reconcile to D365 balance</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Warehouse ID *</Label>
                    <Input
                      className="mt-1"
                      required
                      value={importForm.warehouse_id}
                      onChange={(event) => {
                        setImportForm((current) => ({ ...current, warehouse_id: event.target.value }));
                        setImportPreview(null);
                      }}
                      placeholder="D365 InventLocationId"
                    />
                  </div>
                  <div>
                    <Label>Batch Number</Label>
                    <Input
                      className="mt-1"
                      value={importForm.batch_number}
                      onChange={(event) => setImportForm((current) => ({ ...current, batch_number: event.target.value }))}
                      placeholder="Generated per row when blank"
                    />
                  </div>
                  <div>
                    <Label>Stock Date *</Label>
                    <Input type="date" className="mt-1" required value={importForm.stock_date} onChange={(event) => setImportForm((current) => ({ ...current, stock_date: event.target.value }))} />
                  </div>
                  <div>
                    <Label>Expiry Date</Label>
                    <Input type="date" min={importForm.stock_date || undefined} className="mt-1" value={importForm.expiry_date} onChange={(event) => setImportForm((current) => ({ ...current, expiry_date: event.target.value }))} />
                  </div>
                  <div>
                    <Label>Unit Cost</Label>
                    <Input type="number" min="0" step="0.01" className="mt-1" value={importForm.unit_cost} onChange={(event) => setImportForm((current) => ({ ...current, unit_cost: event.target.value }))} placeholder="Use D365 cost when blank" />
                  </div>
                  <div className="md:col-span-2">
                    <Label>Import Notes</Label>
                    <Input className="mt-1" value={importForm.notes} onChange={(event) => setImportForm((current) => ({ ...current, notes: event.target.value }))} placeholder="GRN, stock-take, or reconciliation note" />
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className={`rounded-xl border p-4 ${importForm.sync_mode === 'receipt' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
                    <p className="font-medium text-slate-900">Receipt mode</p>
                    <p className="mt-1 text-sm text-slate-600">Adds the incoming quantity as a new dated batch. Existing stock is preserved and never overwritten.</p>
                    <p className="mt-2 text-xs text-slate-500">D365 should provide External Event ID and External Line ID when two legitimate receipts can have identical item, quantity, date, batch, and cost values.</p>
                  </div>
                  <div className={`rounded-xl border p-4 ${importForm.sync_mode === 'snapshot' ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}`}>
                    <p className="font-medium text-slate-900">Snapshot mode</p>
                    <p className="mt-1 text-sm text-slate-600">Compares D365 on-hand with FoodPro, then posts only the auditable difference as an adjustment.</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => previewImportMutation.mutate(inventoryImportPayload(true))}
                    disabled={!canRunInventoryImport || !canPreviewInventoryImport || !importForm.warehouse_id.trim() || !importForm.stock_date || previewImportMutation.isPending || inventoryImportMutation.isPending}
                  >
                    <Database className="mr-2 h-4 w-4" />
                    {previewImportMutation.isPending ? 'Pulling Preview...' : 'Pull & Preview'}
                  </Button>
                  <Button
                    type="button"
                    className="bg-emerald-600 hover:bg-emerald-700"
                    onClick={() => inventoryImportMutation.mutate({
                      ...inventoryImportPayload(false),
                      ...(importPreview?.import_payload || {}),
                      preview_fingerprint: importPreview?.preview_fingerprint
                        || importPreview?.import_payload?.preview_fingerprint
                    })}
                    disabled={!canRunInventoryImport
                      || !canImportInventory
                      || !importPreview
                      || Number(importPreview?.summary?.failed_rows || 0) > 0
                      || !importForm.warehouse_id.trim()
                      || inventoryImportMutation.isPending
                      || previewImportMutation.isPending}
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    {inventoryImportMutation.isPending ? 'Applying...' : `Apply ${importForm.sync_mode === 'receipt' ? 'Receipts' : 'Reconciliation'}`}
                  </Button>
                </div>

                {importPreview ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      {[
                        ['Rows', importPreview.total_count ?? importPreviewRows.length],
                        ['Ready', importPreview.summary?.ready_rows ?? importPreview.summary?.applied_rows ?? importPreview.matched ?? 0],
                        ['Increases', importPreviewRows.filter((row) => Number(row.adjustment_quantity ?? row.delta_quantity ?? row.delta ?? 0) > 0).length],
                        ['Decreases', importPreviewRows.filter((row) => Number(row.adjustment_quantity ?? row.delta_quantity ?? row.delta ?? 0) < 0).length],
                        ['Errors', importPreview.summary?.failed_rows ?? importPreview.summary?.errors ?? importPreview.errors_count ?? 0]
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">{label}</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <Table className="min-w-[1700px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Item Code</TableHead>
                            <TableHead>Item Name</TableHead>
                            <TableHead>Warehouse ID</TableHead>
                            <TableHead>FoodPro Location</TableHead>
                            <TableHead>Existing</TableHead>
                            <TableHead>Incoming / Snapshot</TableHead>
                            <TableHead>Delta</TableHead>
                            <TableHead>Resulting</TableHead>
                            <TableHead>Batch</TableHead>
                            <TableHead>Stock Date</TableHead>
                            <TableHead>Expiry</TableHead>
                            <TableHead>Unit Cost</TableHead>
                            <TableHead>Action</TableHead>
                            <TableHead>Status / Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {importPreviewRows.length === 0 ? (
                            <TableRow><TableCell colSpan={14} className="py-8 text-center text-slate-500">No inventory rows returned by D365.</TableCell></TableRow>
                          ) : importPreviewRows.map((row, index) => (
                            <TableRow key={row.id || `${row.item_code || row.item_id}-${index}`}>
                              <TableCell className="font-medium text-slate-600">{row.item_code || row.item_id || row.sku || '-'}</TableCell>
                              <TableCell>{row.item_name || row.ingredient_name || '-'}</TableCell>
                              <TableCell>{row.warehouse_id || importForm.warehouse_id}</TableCell>
                              <TableCell>{row.site_name || row.location_name || '-'}</TableCell>
                              <TableCell>{row.before_quantity ?? row.existing_quantity ?? row.current_quantity ?? 0} {row.unit || ''}</TableCell>
                              <TableCell>{row.incoming_quantity ?? row.available_quantity ?? row.snapshot_quantity ?? 0} {row.unit || ''}</TableCell>
                              <TableCell className={Number(row.adjustment_quantity ?? row.delta_quantity ?? row.delta ?? 0) < 0 ? 'text-rose-700' : 'text-emerald-700'}>{row.adjustment_quantity ?? row.delta_quantity ?? row.delta ?? 0} {row.unit || ''}</TableCell>
                              <TableCell className="font-medium">{row.projected_quantity ?? row.resulting_quantity ?? row.final_quantity ?? row.after_quantity ?? row.quantity_after ?? '-'}</TableCell>
                              <TableCell>{row.batch_number || row.lot_number || importForm.batch_number || 'Auto-generated'}</TableCell>
                              <TableCell>{row.stock_date || importForm.stock_date}</TableCell>
                              <TableCell>{row.expiry_date || importForm.expiry_date || '-'}</TableCell>
                              <TableCell>{row.unit_cost ?? row.input?.unit_cost ?? (importForm.unit_cost === '' ? '-' : importForm.unit_cost)}</TableCell>
                              <TableCell className="capitalize">{String(row.action || importForm.sync_mode).replace(/_/g, ' ')}</TableCell>
                              <TableCell className={row.error ? 'text-rose-700' : 'text-slate-600'}>{row.error || row.message || row.status || 'Ready'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {inboundModules.map((module) => (
                <Card key={module.key} className="border-slate-200 shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-base">{module.label}</CardTitle>
                    <Badge className="w-fit bg-emerald-100 text-emerald-700">Inbound Contract</Badge>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs text-slate-600">
                    <p>{module.description}</p>
                    <p><span className="font-medium text-slate-800">D365 entities:</span> {module.entities}</p>
                    <p><span className="font-medium text-slate-800">Fields:</span> {(fieldSpecs[module.key] || []).map((entry) => entry[1]).join(', ') || 'Configured mapping'}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="exports" className="space-y-4">
            <Card className="border-violet-200 bg-violet-50 shadow-none">
              <CardContent className="p-4 text-sm text-violet-800">Outbound posting sends finalized FoodPro movements to D365. Inbound stock pulls are managed separately in the Inbound Imports tab.</CardContent>
            </Card>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {outboundModules.map((module) => (
                <Card key={module.key} className="border-slate-200 shadow-sm">
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <CardTitle className="text-base">{module.label}</CardTitle>
                      <div className="flex gap-2">
                        <Badge className="bg-blue-100 text-blue-700">{module.method}</Badge>
                        <Badge className={module.direction.startsWith('D365') ? 'bg-emerald-100 text-emerald-700' : 'bg-violet-100 text-violet-700'}>
                          {module.direction}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-sm text-slate-500">{module.description}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      <p><span className="font-medium text-slate-800">D365 entities:</span> {module.entities}</p>
                      <p className="mt-1"><span className="font-medium text-slate-800">Workflow:</span> {module.trigger}</p>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Group</TableHead>
                            <TableHead>Column</TableHead>
                            <TableHead>D365 Field</TableHead>
                            <TableHead>Required</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(fieldSpecs[module.key] || []).map(([group, column, path, , required]) => (
                            <TableRow key={`${module.key}-${group}-${column}`}>
                              <TableCell className="text-xs">{group}</TableCell>
                              <TableCell className="text-xs font-medium">{column}</TableCell>
                              <TableCell className="text-xs text-slate-600">{path}</TableCell>
                              <TableCell className="text-xs">{required}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => triggerExport(module.key, 'preview')} disabled={exportMutation.isPending}>
                        <FileText className="w-4 h-4 mr-2" />
                        Preview
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => triggerExport(module.key, 'csv')} disabled={exportMutation.isPending}>
                        <Download className="w-4 h-4 mr-2" />
                        CSV
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => triggerExport(module.key, 'excel')} disabled={exportMutation.isPending}>
                        <FileSpreadsheet className="w-4 h-4 mr-2" />
                        Excel
                      </Button>
                      <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" onClick={() => triggerExport(module.key, 'api')} disabled={exportMutation.isPending || !(activeConfig?.api_endpoint || activeConfig?.api_endpoint_configured)}>
                        <Cable className="w-4 h-4 mr-2" />
                        API Sync
                      </Button>
                    </div>
                    <div className="text-xs text-slate-500">
                      Workbook mapping applied from active configuration. Sync schedule: <span className="font-medium text-slate-700">{stats.schedule}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="logs">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle>Integration Logs and Retry Queue</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Module</TableHead>
                      <TableHead>Transport</TableHead>
                      <TableHead>Mode / Warehouse</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Records</TableHead>
                      <TableHead>Attempted</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{log.provider_name || '-'}</TableCell>
                        <TableCell>{String(log.module_key || '').replace(/_/g, ' ')}</TableCell>
                        <TableCell>{String(log.transport || '').toUpperCase()}</TableCell>
                        <TableCell>
                          <p className="capitalize">{String(log.quantity_semantics || log.sync_mode || log.mode || log.request_payload?.quantity_semantics || '-').replace(/_/g, ' ')}</p>
                          <p className="text-xs text-slate-500">{log.warehouse_id || log.location_name || '-'}</p>
                        </TableCell>
                        <TableCell><Badge className={statusTone(log.status)}>{log.status}</Badge></TableCell>
                        <TableCell>{log.records_count || 0}</TableCell>
                        <TableCell>{log.attempted_at ? format(new Date(log.attempted_at), 'MMM d, yyyy HH:mm') : '-'}</TableCell>
                        <TableCell className="max-w-xs truncate">{log.message || '-'}</TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setLogDetailPage(1);
                                setSelectedLog(log);
                              }}
                            >
                              Details
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => retryMutation.mutate(log.id)}
                              disabled={retryMutation.isPending || log.status !== 'failed'}
                            >
                              <RotateCcw className="w-4 h-4 mr-2" />
                              Retry
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {logs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-10 text-center text-slate-500">
                          No integration logs recorded yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>ERP Provider Settings</CardTitle>
                  <p className="text-sm text-slate-500 mt-1">Provider name, endpoint, sync schedule, mapping rules, and error notes.</p>
                </div>
                {isAdmin ? (
                  <Button onClick={openSettings} className="bg-indigo-600 hover:bg-indigo-700">
                    <Settings className="w-4 h-4 mr-2" />
                    Edit Settings
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">ERP Provider</p>
                    <p className="mt-2 font-semibold text-slate-900">{activeConfig?.provider_name || 'Not configured'}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">API Endpoint</p>
                    <p className="mt-2 font-semibold text-slate-900 break-all">{activeConfig?.api_endpoint || (activeConfig?.api_endpoint_configured ? 'Configured (administrator-managed)' : 'Not configured')}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Sync Schedule</p>
                  <p className="mt-2 font-semibold text-slate-900">{activeConfig?.sync_schedule || 'manual'}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Data Mapping</p>
                  <pre className="mt-2 overflow-x-auto text-xs text-slate-700 whitespace-pre-wrap">
                    {JSON.stringify(effectiveMapping, null, 2)}
                  </pre>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Error Notes</p>
                  <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">{activeConfig?.error_notes || 'No error notes saved.'}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-slate-500">Recent Error Logs</p>
                      <p className="mt-1 text-xs text-slate-500">Latest failed sync attempts across ERP and accounting exports.</p>
                    </div>
                    <Badge className="bg-red-100 text-red-700">{failedLogs.length}</Badge>
                  </div>
                  <div className="mt-3 space-y-3">
                    {failedLogs.length === 0 ? (
                      <p className="text-sm text-slate-600">No failed syncs recorded recently.</p>
                    ) : failedLogs.map((log) => (
                      <div key={log.id} className="rounded-lg border border-red-100 bg-white p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-slate-900">{String(log.module_key || '').replace(/_/g, ' ')}</p>
                          <span className="text-xs text-slate-500">{log.attempted_at ? format(new Date(log.attempted_at), 'MMM d, yyyy HH:mm') : '-'}</span>
                        </div>
                        <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">{String(log.transport || '').toUpperCase()} • {log.provider_name || 'Unconfigured provider'}</p>
                        <p className="mt-2 text-sm text-slate-700">{log.message || 'No error details captured.'}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>ERP and Accounting Settings</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>ERP Provider Name</Label>
                  <Input className="mt-1" value={configForm.provider_name} onChange={(event) => setConfigForm((current) => ({ ...current, provider_name: event.target.value }))} placeholder="SAP Business One / Oracle NetSuite / Dynamics 365" />
                </div>
                <div>
                  <Label>Sync Schedule</Label>
                  <Select value={configForm.sync_schedule} onValueChange={(value) => setConfigForm((current) => ({ ...current, sync_schedule: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>API Endpoint</Label>
                <Input className="mt-1" value={configForm.api_endpoint} onChange={(event) => setConfigForm((current) => ({ ...current, api_endpoint: event.target.value }))} placeholder="https://erp.example.com/api/foodpro/sync" />
              </div>
              <div>
                <Label>API Key</Label>
                <Input className="mt-1" value={configForm.api_key} onChange={(event) => setConfigForm((current) => ({ ...current, api_key: event.target.value }))} placeholder="Bearer token or secret key" />
              </div>
              <div>
                <Label>Data Mapping (JSON)</Label>
                <Textarea className="mt-1 font-mono text-xs" rows={12} value={configForm.data_mapping} onChange={(event) => setConfigForm((current) => ({ ...current, data_mapping: event.target.value }))} />
              </div>
              <div>
                <Label>Error Logs / Notes</Label>
                <Textarea className="mt-1" rows={4} value={configForm.error_notes} onChange={(event) => setConfigForm((current) => ({ ...current, error_notes: event.target.value }))} placeholder="Known API issues, auth notes, fallback instructions" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfigDialogOpen(false)}>Cancel</Button>
              <Button type="button" className="bg-indigo-600 hover:bg-indigo-700" onClick={() => configMutation.mutate(configForm)} disabled={configMutation.isPending}>
                {configMutation.isPending ? 'Saving...' : 'Save Settings'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={previewDialog.open} onOpenChange={(open) => setPreviewDialog((current) => ({ ...current, open }))}>
          <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Preview - {String(previewDialog.moduleKey || '').replace(/_/g, ' ')}</DialogTitle>
            </DialogHeader>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {(previewDialog.rows[0] ? Object.keys(previewDialog.rows[0]) : []).map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewDialog.rows.length === 0 ? (
                    <TableRow>
                      <TableCell className="py-10 text-center text-slate-500">No rows available for preview.</TableCell>
                    </TableRow>
                  ) : previewDialog.rows.slice(0, 30).map((row, index) => (
                    <TableRow key={index}>
                      {Object.keys(previewDialog.rows[0]).map((column) => (
                        <TableCell key={column}>{String(row[column] ?? '')}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreviewDialog({ open: false, rows: [], moduleKey: '' })}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(selectedLog)} onOpenChange={(open) => {
          if (!open) {
            setSelectedLog(null);
            setLogDetailPage(1);
          }
        }}>
          <DialogContent className="max-h-[90vh] max-w-7xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Integration Log Details — {String(selectedLog?.module_key || '').replace(/_/g, ' ')}</DialogTitle>
            </DialogHeader>
            {selectedLog ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                  {[
                    ['Status', selectedLog.status || '-'],
                    ['Transport', String(selectedLog.transport || '-').toUpperCase()],
                    ['Mode', String(selectedLog.quantity_semantics || selectedLog.sync_mode || selectedLog.mode || selectedLog.request_payload?.quantity_semantics || '-').replace(/_/g, ' ')],
                    ['Warehouse', selectedLog.warehouse_id || '-'],
                    ['Records', selectedLog.records_count ?? selectedLogRows.length],
                    ['Attempted', logDate(selectedLog.attempted_at)]
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">{label}</p>
                      <p className="mt-1 break-words text-sm font-medium capitalize text-slate-900">{value}</p>
                    </div>
                  ))}
                </div>

                {logDetailsLoading ? (
                  <p className="py-8 text-center text-sm text-slate-500">Loading line-level details...</p>
                ) : logDetailsFailed ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                    {logDetailsError?.message || 'Line-level integration details could not be loaded.'}
                  </div>
                ) : selectedLogRows.length > 0 ? (
                  <div className="rounded-xl border border-slate-200">
                    <div className="overflow-x-auto">
                      <Table className="min-w-[1700px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Item Code</TableHead>
                            <TableHead>Item Name</TableHead>
                            <TableHead>Warehouse</TableHead>
                            <TableHead>Location</TableHead>
                            <TableHead>Before</TableHead>
                            <TableHead>Incoming / Snapshot</TableHead>
                            <TableHead>Delta</TableHead>
                            <TableHead>After</TableHead>
                            <TableHead>Batch</TableHead>
                            <TableHead>Stock Date</TableHead>
                            <TableHead>Expiry</TableHead>
                            <TableHead>Unit Cost</TableHead>
                            <TableHead>Action</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedLogRows.map((row, index) => (
                            <TableRow key={row.id || `${row.item_code || row.item_id}-${selectedLogCurrentPage}-${index}`}>
                              <TableCell className="font-medium text-slate-600">{row.item_code || row.item_id || row.sku || '-'}</TableCell>
                              <TableCell>{row.item_name || row.ingredient_name || '-'}</TableCell>
                              <TableCell>{row.warehouse_id || selectedLog.warehouse_id || '-'}</TableCell>
                              <TableCell>{row.site_name || row.location_name || '-'}</TableCell>
                              <TableCell>{row.before_quantity ?? row.existing_quantity ?? row.quantity_before ?? '-'}</TableCell>
                              <TableCell>{row.incoming_quantity ?? row.available_quantity ?? row.snapshot_quantity ?? '-'}</TableCell>
                              <TableCell className={Number(row.adjustment_quantity ?? row.delta_quantity ?? row.delta ?? 0) < 0 ? 'text-rose-700' : 'text-emerald-700'}>{row.adjustment_quantity ?? row.delta_quantity ?? row.delta ?? '-'}</TableCell>
                              <TableCell className="font-medium">{row.after_quantity ?? row.projected_quantity ?? row.resulting_quantity ?? row.quantity_after ?? row.final_quantity ?? '-'}</TableCell>
                              <TableCell>{row.batch_number || row.lot_number || '-'}</TableCell>
                              <TableCell>{row.stock_date || row.received_date || '-'}</TableCell>
                              <TableCell>{row.expiry_date || '-'}</TableCell>
                              <TableCell>{row.unit_cost ?? '-'}</TableCell>
                              <TableCell className="capitalize">{String(row.action || row.transaction_type || '-').replace(/_/g, ' ')}</TableCell>
                              <TableCell><Badge className={statusTone(row.status || (row.error ? 'failed' : 'success'))}>{row.status || (row.error ? 'failed' : 'success')}</Badge></TableCell>
                              <TableCell className="max-w-xs text-rose-700">{row.error || row.error_message || '-'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {selectedLogDetails ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
                        <p className="text-sm text-slate-600">
                          Showing {selectedLogFirstRow.toLocaleString()}–{selectedLogLastRow.toLocaleString()} of {selectedLogTotalCount.toLocaleString()} rows
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={logDetailsFetching || selectedLogCurrentPage <= 1}
                            onClick={() => setLogDetailPage((page) => Math.max(1, page - 1))}
                          >
                            Previous
                          </Button>
                          <span className="min-w-24 text-center text-sm text-slate-600">
                            Page {selectedLogCurrentPage} of {selectedLogTotalPages}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={logDetailsFetching || !selectedLogDetails.has_more || selectedLogCurrentPage >= selectedLogTotalPages}
                            onClick={() => setLogDetailPage((page) => Math.min(selectedLogTotalPages, page + 1))}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    {canGetLogDetails ? 'No line-level reconciliation rows were recorded for this run.' : 'Line-detail endpoint is unavailable; showing the summary payload captured on the log.'}
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-medium text-slate-900">Request / Import Context</p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-600">{JSON.stringify(selectedLog.request_payload || selectedLog.filters || {}, null, 2)}</pre>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-medium text-slate-900">Response / Reconciliation Summary</p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-600">{JSON.stringify(selectedLogDetails || selectedLog.response_payload || { message: selectedLog.message }, null, 2)}</pre>
                  </div>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setSelectedLog(null);
                setLogDetailPage(1);
              }}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
