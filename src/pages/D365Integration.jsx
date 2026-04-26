import React, { useMemo, useState } from 'react';
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
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldAlert
} from 'lucide-react';
import { downloadCSV, downloadExcel } from '@/components/utils/exportData';

const moduleDefinitions = [
  { key: 'purchase_orders', label: 'Purchase Orders', description: 'Export approved and open purchase orders to ERP procurement.' },
  { key: 'supplier_invoices', label: 'Supplier Invoices', description: 'Send supplier invoices into the accounting payable workflow.' },
  { key: 'inventory_valuation', label: 'Inventory Valuation', description: 'Share FIFO and weighted-average inventory valuation snapshots.' },
  { key: 'food_cost_summary', label: 'Food Cost Summary', description: 'Publish production and cost-per-serving summaries for finance.' },
  { key: 'waste_cost_summary', label: 'Waste Cost Summary', description: 'Push waste-value rollups into operational and finance tools.' }
];

const emptyConfig = {
  provider_name: '',
  api_endpoint: '',
  api_key: '',
  sync_schedule: 'manual',
  data_mapping: JSON.stringify({
    purchase_orders: {
      external_po_number: 'po_number',
      supplierName: 'supplier_name',
      totalValue: 'total_amount',
      siteCode: 'site_name'
    },
    supplier_invoices: {
      invoiceNo: 'invoice_number',
      vendorName: 'supplier_name',
      amount: 'total_amount',
      invoiceDate: 'invoice_date'
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

export default function D365Integration() {
  const queryClient = useQueryClient();
  const { role, can, isAdmin, isManager, loading: permLoading } = usePermissions();
  const [activeTab, setActiveTab] = useState('exports');
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [previewDialog, setPreviewDialog] = useState({ open: false, rows: [], moduleKey: '' });
  const [message, setMessage] = useState('');
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
    enabled: can('view_reports')
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['erpLogs'],
    queryFn: () => base44.erp.listLogs(),
    enabled: can('view_reports')
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
    enabled: can('view_reports')
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list(),
    enabled: can('view_reports')
  });

  const activeConfig = useMemo(() => configs.find((config) => config.is_active !== false) || configs[0] || null, [configs]);
  const categories = useMemo(() => [...new Set(recipes.map((recipe) => recipe.category).filter(Boolean))].sort(), [recipes]);
  const failedLogs = useMemo(() => logs.filter((log) => log.status === 'failed').slice(0, 5), [logs]);

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
        data_mapping: JSON.stringify(activeConfig.data_mapping || {}, null, 2),
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

  const stats = {
    configured: activeConfig ? 'Configured' : 'Not Configured',
    logs: logs.length,
    failed: logs.filter((log) => log.status === 'failed').length,
    schedule: activeConfig?.sync_schedule || 'manual'
  };

  if (permLoading) {
    return <div className="p-8 text-slate-500">Loading integration workspace...</div>;
  }

  if (!isAdmin && !isManager) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <Card className="max-w-sm w-full text-center p-8">
          <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500 mt-2">Only managers and administrators can access ERP and accounting integrations.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <PageHeader
          title="ERP & Accounting Integration"
          description="Sync purchase orders, invoices, inventory valuation, food cost, and waste summaries to external ERP and accounting platforms"
        >
          {isAdmin ? (
            <Button onClick={openSettings} className="bg-indigo-600 hover:bg-indigo-700">
              <Settings className="w-4 h-4 mr-2" />
              Integration Settings
            </Button>
          ) : null}
        </PageHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-600">Provider</p><p className="text-lg font-semibold text-slate-900">{activeConfig?.provider_name || 'Not set'}</p></div><Database className="w-8 h-8 text-indigo-600" /></div></CardContent></Card>
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
            <CardTitle>Export Filters</CardTitle>
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
                <Select value={filters.locationId} onValueChange={(value) => setFilters((current) => ({ ...current, locationId: value }))}>
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
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="exports">Exports</TabsTrigger>
            <TabsTrigger value="logs">Integration Logs</TabsTrigger>
            <TabsTrigger value="settings">Settings & Mapping</TabsTrigger>
          </TabsList>

          <TabsContent value="exports" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {moduleDefinitions.map((module) => (
                <Card key={module.key} className="border-slate-200 shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-base">{module.label}</CardTitle>
                    <p className="text-sm text-slate-500">{module.description}</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
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
                      <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" onClick={() => triggerExport(module.key, 'api')} disabled={exportMutation.isPending || !activeConfig?.api_endpoint}>
                        <Cable className="w-4 h-4 mr-2" />
                        API Sync
                      </Button>
                    </div>
                    <div className="text-xs text-slate-500">
                      Mapping applied from active configuration. Sync schedule: <span className="font-medium text-slate-700">{stats.schedule}</span>
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
                      <TableHead>Status</TableHead>
                      <TableHead>Records</TableHead>
                      <TableHead>Attempted</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Retry</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{log.provider_name || '-'}</TableCell>
                        <TableCell>{String(log.module_key || '').replace(/_/g, ' ')}</TableCell>
                        <TableCell>{String(log.transport || '').toUpperCase()}</TableCell>
                        <TableCell><Badge className={statusTone(log.status)}>{log.status}</Badge></TableCell>
                        <TableCell>{log.records_count || 0}</TableCell>
                        <TableCell>{log.attempted_at ? format(new Date(log.attempted_at), 'MMM d, yyyy HH:mm') : '-'}</TableCell>
                        <TableCell className="max-w-xs truncate">{log.message || '-'}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => retryMutation.mutate(log.id)}
                            disabled={retryMutation.isPending || log.status !== 'failed'}
                          >
                            <RotateCcw className="w-4 h-4 mr-2" />
                            Retry
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {logs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-10 text-center text-slate-500">
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
                    <p className="mt-2 font-semibold text-slate-900 break-all">{activeConfig?.api_endpoint || 'Not configured'}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Sync Schedule</p>
                  <p className="mt-2 font-semibold text-slate-900">{activeConfig?.sync_schedule || 'manual'}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Data Mapping</p>
                  <pre className="mt-2 overflow-x-auto text-xs text-slate-700 whitespace-pre-wrap">
                    {JSON.stringify(activeConfig?.data_mapping || {}, null, 2)}
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
      </div>
    </div>
  );
}
