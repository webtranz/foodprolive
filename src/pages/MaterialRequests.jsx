import React, { useMemo, useState } from 'react';
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
import { CheckCircle2, ClipboardList, FileText, Loader2 } from 'lucide-react';
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
  const { can } = usePermissions();
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [notes, setNotes] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const { data: materialRequests = [] } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list()
  });

  const resolveRequestItemCode = (item) => getItemCode(item);

  const filteredBaseRequests = materialRequests.filter((request) =>
    String(request.status || '').toLowerCase() !== 'awaiting_production_approval'
  );

  const projectOptions = useMemo(() => {
    const uniqueProjects = new Map();
    filteredBaseRequests.forEach((request) => {
      if (request.site_id && request.site_name && !uniqueProjects.has(request.site_id)) {
        uniqueProjects.set(request.site_id, request.site_name);
      }
    });
    return Array.from(uniqueProjects, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredBaseRequests]);

  const visibleRequests = useMemo(() => {
    return filteredBaseRequests.filter((request) => {
      const matchesDate = !dateFilter || String(request.request_date || '').slice(0, 10) === dateFilter;
      const matchesProject = projectFilter === 'all' || request.site_id === projectFilter;
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
    }
  });

  const renderRequestItemsTable = (request) => {
    const items = request?.items || [];
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item Code</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Current Stock</TableHead>
              <TableHead>Request Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={`${request.id}-item-${item.id || index}`}>
                <TableCell className="font-mono text-xs text-slate-600">{resolveRequestItemCode(item)}</TableCell>
                <TableCell className="font-medium text-slate-900">{item.ingredient_name}</TableCell>
                <TableCell>{Number(item.required_quantity || 0).toFixed(2)} {item.unit}</TableCell>
                <TableCell>{Number(item.current_stock || 0).toFixed(2)} {item.unit}</TableCell>
                <TableCell>{Number(item.request_quantity || 0).toFixed(2)} {item.unit}</TableCell>
              </TableRow>
            ))}
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-slate-500">No request items recorded.</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
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
                  {Object.entries(STATUS_CONFIG).map(([statusKey, config]) => (
                    <SelectItem key={statusKey} value={statusKey}>{config.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {visibleRequests.length === 0 ? (
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
                          <span>{request.site_name || 'Unassigned project'}</span>
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
                      {request.status === 'pending_procurement_ack' && can('acknowledge_material_request') ? (
                        <Button
                          className="bg-emerald-600 hover:bg-emerald-700"
                          onClick={() => {
                            setSelectedRequest(request);
                            setNotes(request.procurement_notes || '');
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

      <Dialog open={Boolean(selectedRequest)} onOpenChange={(open) => !open && setSelectedRequest(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Acknowledge Material Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <p><span className="font-medium text-slate-900">Request:</span> {selectedRequest?.request_number}</p>
              <p><span className="font-medium text-slate-900">Production:</span> {selectedRequest?.source_production_name || '-'}</p>
              <p><span className="font-medium text-slate-900">Project:</span> {selectedRequest?.site_name || '-'}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="mb-2 text-sm font-semibold text-slate-900">Requested Items</p>
              {renderRequestItemsTable(selectedRequest)}
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">Procurement Notes</label>
              <Textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Add acknowledgement notes, sourcing notes, or next action details..."
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedRequest(null)}>Cancel</Button>
            <Button
              onClick={() => acknowledgeMutation.mutate({ id: selectedRequest.id, notes })}
              disabled={acknowledgeMutation.isPending}
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
