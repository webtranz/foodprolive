import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, CheckCircle2, ClipboardList, FileText, Loader2, Wrench } from 'lucide-react';
import { format } from 'date-fns';
import { formatCurrency } from '@/lib/currency';
import { getItemCode } from '../../shared/itemCode.js';

const STATUS_CONFIG = {
  awaiting_production_approval: { color: 'bg-slate-100 text-slate-700', label: 'Awaiting Production Approval' },
  pending_procurement_ack: { color: 'bg-amber-100 text-amber-700', label: 'Pending Procurement Acknowledgement' },
  acknowledged: { color: 'bg-emerald-100 text-emerald-700', label: 'Acknowledged' },
  cancelled: { color: 'bg-red-100 text-red-700', label: 'Cancelled' },
  rejected: { color: 'bg-rose-100 text-rose-700', label: 'Rejected' }
};

export default function MaterialRequests() {
  const queryClient = useQueryClient();
  const { can, isAdmin } = usePermissions();
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [notes, setNotes] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const canAcknowledge = can('acknowledge_material_request');

  const { data: materialRequests = [], isLoading, error: requestsError } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list(),
    refetchInterval: 60000
  });

  useEffect(() => {
    const unsubscribe = base44.entities.MaterialRequest.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
    });
    return unsubscribe;
  }, [queryClient]);

  const resolveRequestItemCode = (item) => getItemCode(item);

  const filteredBaseRequests = materialRequests.filter((request) =>
    String(request.status || '').toLowerCase() !== 'awaiting_production_approval'
  );

  const projectOptions = useMemo(() => {
    const uniqueProjects = new Map();
    filteredBaseRequests.forEach((request) => {
      const projectId = request.requesting_site_id || request.site_id;
      const projectName = request.requesting_site_name || request.site_name;
      if (projectId && projectName && !uniqueProjects.has(projectId)) {
        uniqueProjects.set(projectId, projectName);
      }
    });
    return Array.from(uniqueProjects, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredBaseRequests]);

  const visibleRequests = useMemo(() => {
    return filteredBaseRequests.filter((request) => {
      const matchesDate = !dateFilter || String(request.request_date || '').slice(0, 10) === dateFilter;
      const matchesProject = projectFilter === 'all'
        || (request.requesting_site_id || request.site_id) === projectFilter;
      const matchesStatus = statusFilter === 'all' || request.status === statusFilter;
      return matchesDate && matchesProject && matchesStatus;
    });
  }, [dateFilter, filteredBaseRequests, projectFilter, statusFilter]);

  const acknowledgeMutation = useMutation({
    mutationFn: ({ id, notes: procurementNotes }) => base44.materialRequests.acknowledge(id, { notes: procurementNotes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      setSelectedRequest(null);
      setNotes('');
      setActionError('');
    },
    onError: (error) => {
      setActionNotice('');
      setActionError(error.message || 'Unable to acknowledge this material request.');
    }
  });

  const repairIssuesMutation = useMutation({
    mutationFn: ({ id, ingredientId = null }) => base44.materialRequests.repairIssues(id, ingredientId ? { ingredient_id: ingredientId } : {}),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      if (result?.material_request) setSelectedRequest(result.material_request);
      setActionError('');
      setActionNotice(result?.message || 'Repair completed. Try acknowledgement again.');
    },
    onError: (error) => {
      setActionNotice('');
      setActionError(error.message || 'Unable to repair this material request row.');
    }
  });

  const aggregateRequestItems = (items = []) => {
    const grouped = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const unit = item.unit || '';
      const key = `${item.ingredient_id || item.item_code || item.ingredient_name || 'item'}::${unit}`;
      const existing = grouped.get(key) || {
        ...item,
        required_quantity: 0,
        request_quantity: 0,
        current_stock: 0,
        live_reservable_quantity: 0,
        live_shortage_quantity: 0,
        source_line_count: 0,
        validation_issues: []
      };
      const itemIssues = Array.isArray(item.validation_issues) ? item.validation_issues : [];
      existing.required_quantity += Number(item.required_quantity || 0);
      existing.request_quantity += Number(item.request_quantity ?? item.required_quantity ?? 0);
      existing.current_stock = Math.max(existing.current_stock, Number(item.current_stock || 0));
      existing.live_reservable_quantity = Math.max(
        existing.live_reservable_quantity,
        Number(item.live_reservable_quantity ?? item.current_stock ?? 0)
      );
      existing.live_shortage_quantity = Math.max(0, existing.request_quantity - existing.live_reservable_quantity);
      existing.source_line_count += 1;
      const issueMap = new Map((existing.validation_issues || []).map((issue) => [`${issue.code}:${issue.message}`, issue]));
      itemIssues.forEach((issue) => issueMap.set(`${issue.code}:${issue.message}`, issue));
      existing.validation_issues = [...issueMap.values()];
      existing.validation_status = existing.validation_issues.some((issue) => issue.severity === 'error')
        ? 'error'
        : existing.validation_issues.length > 0 ? 'warning' : 'ok';
      existing.repairable_issue_count = existing.validation_issues.filter((issue) => issue.repairable).length;
      grouped.set(key, existing);
    });
    return [...grouped.values()];
  };

  const formatRequestQuantity = (value, unit) => `${Number(value || 0).toFixed(2)} ${unit || ''}`.trim();

  const renderRequestItemsTable = (request, { allowAdminRepair = false } = {}) => {
    const items = aggregateRequestItems(request?.items || []);
    const hasIssues = items.some((item) => (item.validation_issues || []).length > 0);
    const showIssueColumn = hasIssues || allowAdminRepair;
    const showRepairColumn = allowAdminRepair && hasIssues;
    const columnCount = 6 + (showIssueColumn ? 1 : 0) + (showRepairColumn ? 1 : 0);
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item Code</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Snapshot Stock</TableHead>
              <TableHead>Live Reservable</TableHead>
              <TableHead>Request Quantity</TableHead>
              {showIssueColumn ? <TableHead>Row Issue</TableHead> : null}
              {showRepairColumn ? <TableHead>Admin Fix</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => {
              const issues = Array.isArray(item.validation_issues) ? item.validation_issues : [];
              const hasError = issues.some((issue) => issue.severity === 'error');
              const hasRepair = issues.some((issue) => issue.repairable);
              return (
              <TableRow
                key={`${request.id}-item-${item.id || index}`}
                className={hasError ? 'bg-red-50/80' : issues.length > 0 ? 'bg-amber-50/70' : ''}
              >
                <TableCell className={`font-mono text-xs ${hasError ? 'text-red-700' : 'text-slate-600'}`}>{resolveRequestItemCode(item)}</TableCell>
                <TableCell className="font-medium text-slate-900">
                  {item.ingredient_name}
                  {item.source_line_count > 1 ? (
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {item.source_line_count} lines combined
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{formatRequestQuantity(item.required_quantity, item.unit)}</TableCell>
                <TableCell>{formatRequestQuantity(item.current_stock, item.unit)}</TableCell>
                <TableCell>
                  <div className={item.live_shortage_quantity > 0 ? 'font-semibold text-red-600' : 'text-emerald-700'}>
                    {formatRequestQuantity(item.live_reservable_quantity, item.unit)}
                  </div>
                  {item.live_shortage_quantity > 0 ? (
                    <div className="mt-1 text-xs text-red-600">
                      Short {formatRequestQuantity(item.live_shortage_quantity, item.unit)}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>{formatRequestQuantity(item.request_quantity, item.unit)}</TableCell>
                {showIssueColumn ? (
                  <TableCell className="min-w-[220px]">
                    {issues.length > 0 ? (
                      <div className={hasError ? 'text-red-700' : 'text-amber-700'}>
                        <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {hasError ? 'Error' : 'Warning'}
                        </div>
                        <ul className="space-y-1 text-xs">
                          {issues.map((issue, issueIndex) => (
                            <li key={`${issue.code}-${issueIndex}`}>{issue.message}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <span className="text-xs text-emerald-700">OK</span>
                    )}
                  </TableCell>
                ) : null}
                {showRepairColumn ? (
                  <TableCell>
                    {hasRepair ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={repairIssuesMutation.isPending}
                        onClick={() => repairIssuesMutation.mutate({ id: request.id, ingredientId: item.ingredient_id })}
                        className="border-amber-300 text-amber-700 hover:bg-amber-50"
                      >
                        {repairIssuesMutation.isPending ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="mr-2 h-3.5 w-3.5" />
                        )}
                        Resolve
                      </Button>
                    ) : issues.length > 0 ? (
                      <span className="text-xs text-slate-500">Manual review</span>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
              );
            })}
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="py-6 text-center text-sm text-slate-500">No request items recorded.</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        {items.some((item) => item.live_stock_check_date) ? (
          <p className="mt-2 text-xs text-slate-500">
            Live reservable stock is calculated from active, unreserved inventory lots for today, or for the future production date when applicable.
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <PageHeader
          title="Material Requests"
          description="Track production-related material requests from chef submission through procurement acknowledgement."
        />

        <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
          <CardContent className="grid gap-4 p-4 md:grid-cols-3">
            <div>
              <Label>Request Date</Label>
              <Input
                type="date"
                className="mt-1"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value)}
              />
            </div>
            <div>
              <Label>Project</Label>
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projectOptions.map((project) => (
                    <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(STATUS_CONFIG)
                    .filter(([statusKey]) => statusKey !== 'awaiting_production_approval')
                    .map(([statusKey, config]) => (
                    <SelectItem key={statusKey} value={statusKey}>{config.label}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {requestsError ? (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="py-8 text-center text-sm text-red-700">
              {requestsError.message || 'Unable to load material requests. Please try again.'}
            </CardContent>
          </Card>
        ) : isLoading ? (
          <Card className="border-slate-200 bg-white">
            <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading material requests...
            </CardContent>
          </Card>
        ) : visibleRequests.length === 0 ? (
          <Card className="border-dashed border-slate-300 bg-white">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <ClipboardList className="mb-4 h-10 w-10 text-slate-400" />
              <h3 className="text-lg font-semibold text-slate-900">No material requests yet</h3>
              <p className="mt-2 max-w-xl text-sm text-slate-500">
                Approved production requests will appear here once the linked material request is released to procurement for acknowledgement.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {visibleRequests.map((request) => {
              const statusConfig = STATUS_CONFIG[request.status] || { color: 'bg-slate-100 text-slate-700', label: request.status || 'Unknown' };
              const totalItems = Array.isArray(request.items) ? request.items.length : 0;
              return (
                <Card key={request.id} className="border-0 shadow-sm ring-1 ring-slate-200/70">
                  <CardHeader>
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-3 text-lg">
                          <FileText className="h-5 w-5 text-indigo-600" />
                          {request.request_number}
                          <Badge className={statusConfig.color}>{statusConfig.label}</Badge>
                        </CardTitle>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                          <span>Project: {request.requesting_site_name || request.site_name || 'Unassigned'}</span>
                          <span>•</span>
                          <span>Store: {request.fulfillment_store_name || request.site_name || 'Unassigned'}</span>
                          <span>•</span>
                          <span>{request.source_production_name || 'Manual request'}</span>
                          {request.request_date ? (
                            <>
                              <span>•</span>
                              <span>{format(new Date(request.request_date), 'MMM d, yyyy')}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-slate-900">{formatCurrency(Number(request.total_estimated_cost || 0))}</p>
                        <p className="text-xs text-slate-500">{totalItems} item(s)</p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Chef Created By</p>
                        <p className="mt-1 text-sm font-medium text-slate-900">{request.created_by_name || request.created_by || '-'}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Production Date</p>
                        <p className="mt-1 text-sm font-medium text-slate-900">{request.period_start || '-'}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Procurement Ack By</p>
                        <p className="mt-1 text-sm font-medium text-slate-900">{request.acknowledged_by_name || '-'}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Procurement Ack At</p>
                        <p className="mt-1 text-sm font-medium text-slate-900">{request.acknowledged_at ? format(new Date(request.acknowledged_at), 'MMM d, yyyy p') : '-'}</p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="mb-3 text-sm font-semibold text-slate-800">Requested Items</p>
                      {renderRequestItemsTable(request)}
                    </div>

                    {request.notes ? (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                        <span className="font-medium text-slate-900">Chef Notes:</span> {request.notes}
                      </div>
                    ) : null}

                    {request.procurement_notes ? (
                      <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
                        <span className="font-medium text-indigo-900">Procurement Notes:</span> {request.procurement_notes}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      {request.status === 'pending_procurement_ack' && canAcknowledge ? (
                        <Button
                          className="bg-emerald-600 hover:bg-emerald-700"
                          onClick={() => {
                            setSelectedRequest(request);
                            setNotes(request.procurement_notes || '');
                            setActionError('');
                            setActionNotice('');
                          }}
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          Acknowledge Request
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={Boolean(selectedRequest)} onOpenChange={(open) => {
        if (!open) {
          setSelectedRequest(null);
          setActionError('');
          setActionNotice('');
        }
      }}>
        <DialogContent className="flex max-h-[92vh] max-w-5xl flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-slate-200 px-6 py-4">
            <DialogTitle>Acknowledge Material Request</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
            ) : null}
            {actionNotice ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{actionNotice}</div>
            ) : null}
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p><span className="font-medium text-slate-900">Request:</span> {selectedRequest?.request_number}</p>
                <p><span className="font-medium text-slate-900">Production:</span> {selectedRequest?.source_production_name || '-'}</p>
                <p><span className="font-medium text-slate-900">Project:</span> {selectedRequest?.requesting_site_name || selectedRequest?.site_name || '-'}</p>
                <p><span className="font-medium text-slate-900">Fulfillment Store:</span> {selectedRequest?.fulfillment_store_name || selectedRequest?.site_name || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">Requested Items</p>
                  {isAdmin && aggregateRequestItems(selectedRequest?.items || []).some((item) => Number(item.repairable_issue_count || 0) > 0) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={repairIssuesMutation.isPending}
                      onClick={() => repairIssuesMutation.mutate({ id: selectedRequest.id })}
                      className="border-amber-300 text-amber-700 hover:bg-amber-50"
                    >
                      {repairIssuesMutation.isPending ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Wrench className="mr-2 h-3.5 w-3.5" />
                      )}
                      Resolve all safe issues
                    </Button>
                  ) : null}
                </div>
                <div className="max-h-[45vh] overflow-y-auto">
                  {renderRequestItemsTable(selectedRequest, { allowAdminRepair: isAdmin })}
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Procurement Notes</label>
                <Textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Add acknowledgement notes, sourcing notes, or next action details..."
                  rows={3}
                />
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-slate-200 bg-white px-6 py-4">
            <Button variant="outline" onClick={() => setSelectedRequest(null)}>Cancel</Button>
            <Button
              onClick={() => {
                setActionNotice('');
                acknowledgeMutation.mutate({ id: selectedRequest.id, notes });
              }}
              disabled={acknowledgeMutation.isPending || repairIssuesMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {acknowledgeMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Confirm Acknowledgement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
