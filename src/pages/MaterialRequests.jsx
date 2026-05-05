import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, ClipboardList, FileText, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

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

  const { data: materialRequests = [] } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list()
  });

  const visibleRequests = materialRequests.filter((request) =>
    String(request.status || '').toLowerCase() !== 'awaiting_production_approval'
  );

  const acknowledgeMutation = useMutation({
    mutationFn: ({ id, notes: procurementNotes }) => base44.materialRequests.acknowledge(id, { notes: procurementNotes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      setSelectedRequest(null);
      setNotes('');
    }
  });

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <PageHeader
          title="Material Requests"
          description="Track production-related material requests from chef submission through procurement acknowledgement."
        />

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
                        <p className="text-2xl font-bold text-slate-900">${Number(request.total_estimated_cost || 0).toFixed(2)}</p>
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
                      <div className="space-y-2">
                        {(request.items || []).map((item, index) => (
                          <div key={`${request.id}-item-${index}`} className="flex flex-col gap-1 rounded-xl bg-slate-50 px-3 py-2 text-sm md:flex-row md:items-center md:justify-between">
                            <span className="font-medium text-slate-900">{item.ingredient_name}</span>
                            <div className="flex flex-wrap items-center gap-3 text-slate-600">
                              <span>Required: {Number(item.required_quantity || 0).toFixed(2)} {item.unit}</span>
                              <span>Stock: {Number(item.current_stock || 0).toFixed(2)} {item.unit}</span>
                              <span>Request: {Number(item.request_quantity || 0).toFixed(2)} {item.unit}</span>
                            </div>
                          </div>
                        ))}
                      </div>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge Material Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <p><span className="font-medium text-slate-900">Request:</span> {selectedRequest?.request_number}</p>
              <p><span className="font-medium text-slate-900">Production:</span> {selectedRequest?.source_production_name || '-'}</p>
              <p><span className="font-medium text-slate-900">Project:</span> {selectedRequest?.site_name || '-'}</p>
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
