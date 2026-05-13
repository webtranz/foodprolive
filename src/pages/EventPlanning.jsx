import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChefHat,
  Download,
  ExternalLink,
  Pencil,
  Plus,
  QrCode,
  Scale,
  Users,
  XCircle
} from 'lucide-react';
import { format } from 'date-fns';
import { QRCodeSVG } from 'qrcode.react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { downloadCSV } from '../components/utils/exportData';
import { formatCurrency } from '@/lib/currency';
import { usePermissions } from '@/components/auth/usePermissions';

const SERVICE_STYLES = ['buffet', 'packed_meal', 'dining_hall'];
const AUDIENCE_PROFILES = ['adult', 'mixed', 'high_appetite'];
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const DEFAULT_CONSUMPTION_G = 550;

const statusStyles = {
  draft: 'bg-slate-100 text-slate-700',
  pending_approval: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-500'
};

const initialForm = {
  id: null,
  event_name: '',
  site_id: '',
  date: format(new Date(), 'yyyy-MM-dd'),
  meal_types: [],
  covers: '',
  estimated_cost: '',
  budget_id: '',
  qr_token: '',
  event_duration_hours: '1',
  audience_profile: 'adult',
  service_style: 'buffet',
  consumption_per_person_g: DEFAULT_CONSUMPTION_G,
  buffer_percent: 10,
  notes: ''
};

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapEventToForm(event) {
  return {
    id: event.id,
    event_name: event.event_name || '',
    site_id: event.site_id || '',
    date: event.event_date || event.plan_date || format(new Date(), 'yyyy-MM-dd'),
    meal_types: Array.isArray(event.meals) ? [...new Set(event.meals.map((meal) => meal.meal_type).filter(Boolean))] : [],
    covers: String(event.expected_participants ?? event.total_expected_servings ?? ''),
    estimated_cost: String(event.estimated_cost ?? event.total_planned_cost ?? ''),
    budget_id: event.budget_id || '',
    qr_token: event.qr_token || '',
    event_duration_hours: String(event.event_duration_hours ?? 1),
    audience_profile: event.audience_profile || 'adult',
    service_style: event.service_style || 'buffet',
    consumption_per_person_g: String(event.consumption_per_person_g ?? DEFAULT_CONSUMPTION_G),
    buffer_percent: String(event.buffer_percent ?? 10),
    notes: event.notes || ''
  };
}

function buildEventPayload(formData, siteName) {
  const covers = toNumber(formData.covers, 0);
  const estimatedCost = toNumber(formData.estimated_cost, 0);
  const consumptionG = toNumber(formData.consumption_per_person_g, DEFAULT_CONSUMPTION_G);
  const buffer = toNumber(formData.buffer_percent, 10);
  const totalFoodKg = ((covers * consumptionG) / 1000) * (1 + (buffer / 100));

  return {
    event_name: formData.event_name.trim(),
    site_id: formData.site_id,
    site_name: siteName || '',
    event_date: formData.date,
    plan_date: formData.date,
    meal_types: formData.meal_types,
    expected_participants: covers,
    total_expected_servings: covers,
    estimated_cost: estimatedCost,
    total_planned_cost: estimatedCost,
    budget_id: formData.budget_id || null,
    audience_profile: formData.audience_profile,
    service_style: formData.service_style,
    event_duration_hours: toNumber(formData.event_duration_hours, 1),
    consumption_per_person_g: consumptionG,
    buffer_percent: buffer,
    total_food_kg: Number(totalFoodKg.toFixed(2)),
    notes: formData.notes,
    qr_token: formData.service_style === 'dining_hall'
      ? (formData.qr_token || `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`)
      : null
  };
}

export default function EventPlanning() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const [formOpen, setFormOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  const [approvalNote, setApprovalNote] = useState('');
  const [approvalAction, setApprovalAction] = useState('approve');
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [formData, setFormData] = useState(initialForm);
  const [qrEvent, setQrEvent] = useState(null);

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['specialEvents'],
    queryFn: () => base44.specialEvents.list(300)
  });

  const selectedSite = sites.find((site) => site.id === formData.site_id);
  const covers = toNumber(formData.covers, 0);
  const consumptionG = toNumber(formData.consumption_per_person_g, DEFAULT_CONSUMPTION_G);
  const buffer = toNumber(formData.buffer_percent, 10);
  const baseFoodKg = (covers * consumptionG) / 1000;
  const finalFoodKg = baseFoodKg * (1 + buffer / 100);
  const estimatedCost = toNumber(formData.estimated_cost, 0);

  const { data: budgetContext } = useQuery({
    queryKey: ['specialEventBudgetContext', formData.site_id, formData.date, formData.event_name, formData.budget_id, estimatedCost],
    queryFn: () => base44.specialEvents.getBudgetContext(
      formData.site_id,
      formData.date,
      formData.event_name,
      formData.budget_id,
      estimatedCost
    ),
    enabled: formOpen && Boolean(formData.site_id && formData.date && formData.event_name.trim())
  });

  useEffect(() => {
    if (!formOpen || formData.budget_id || !budgetContext?.linked_budget?.id) {
      return;
    }
    setFormData((current) => ({
      ...current,
      budget_id: budgetContext.linked_budget.id
    }));
  }, [formOpen, formData.budget_id, budgetContext?.linked_budget?.id]);

  const sortedEvents = useMemo(
    () => [...events].sort((left, right) => String(right.event_date || right.plan_date).localeCompare(String(left.event_date || left.plan_date))),
    [events]
  );

  const resetForm = () => {
    setFormData(initialForm);
    setFormError('');
  };

  const openCreateForm = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEditForm = (event) => {
    setFormData(mapEventToForm(event));
    setFormError('');
    setFormOpen(true);
  };

  const createOrUpdateMutation = useMutation({
    mutationFn: async (payload) => {
      if (formData.id) {
        return base44.specialEvents.update(formData.id, payload);
      }
      return base44.specialEvents.create(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['specialEvents'] });
      setFormOpen(false);
      resetForm();
    },
    onError: (error) => setFormError(error.message || 'Unable to save the special event.')
  });

  const submitMutation = useMutation({
    mutationFn: ({ id, note }) => base44.specialEvents.submit(id, note),
    onSuccess: () => {
      setActionError('');
      queryClient.invalidateQueries({ queryKey: ['specialEvents'] });
    },
    onError: (error) => setActionError(error.message || 'Unable to submit the special event.')
  });

  const approveMutation = useMutation({
    mutationFn: ({ id, note }) => base44.specialEvents.approve(id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['specialEvents'] });
      setApprovalOpen(false);
      setSelectedEvent(null);
      setApprovalNote('');
      setActionError('');
    },
    onError: (error) => setActionError(error.message || 'Unable to approve the special event.')
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }) => base44.specialEvents.reject(id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['specialEvents'] });
      setApprovalOpen(false);
      setSelectedEvent(null);
      setApprovalNote('');
      setActionError('');
    },
    onError: (error) => setActionError(error.message || 'Unable to reject the special event.')
  });

  const toggleMealType = (type) => {
    setFormData((prev) => ({
      ...prev,
      meal_types: prev.meal_types.includes(type)
        ? prev.meal_types.filter((item) => item !== type)
        : [...prev.meal_types, type]
    }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setFormError('');

    if (!formData.meal_types.length) {
      setFormError('Select at least one meal type.');
      return;
    }

    const payload = buildEventPayload(formData, selectedSite?.name);
    createOrUpdateMutation.mutate(payload);
  };

  const openApprovalDialog = (eventRecord, action) => {
    setSelectedEvent(eventRecord);
    setApprovalAction(action);
    setApprovalNote('');
    setApprovalOpen(true);
  };

  const budgetComparison = budgetContext?.budget_comparison || {
    planned_cost: estimatedCost,
    budget_amount: 0,
    remaining_budget: 0,
    exceeded_amount: 0,
    is_over_budget: false
  };

  const budgetCandidates = budgetContext?.budget_candidates || [];
  const linkedBudget = budgetContext?.linked_budget || null;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader title="Event & Meal Planning" description="Create special event requests, link them to budgets, and route them for approval">
          <Button variant="outline" onClick={() => downloadCSV(sortedEvents, 'special_events')}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
          {can('create_special_event') && (
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={openCreateForm}>
              <Plus className="w-4 h-4 mr-2" /> New Event Request
            </Button>
          )}
        </PageHeader>

        {sortedEvents.length === 0 && !isLoading ? (
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-16 text-center">
              <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-700 mb-2">No Special Event Requests</h3>
              <p className="text-slate-500 mb-6">Create an event request to track approvals, budgets, and operational planning.</p>
              {can('create_special_event') && (
                <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={openCreateForm}>
                  <Plus className="w-4 h-4 mr-2" /> Create Event Request
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {actionError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {actionError}
              </div>
            )}
            {sortedEvents.map((eventRecord) => {
              const foodKg = toNumber(eventRecord.total_food_kg, 0);
              const participants = toNumber(eventRecord.expected_participants ?? eventRecord.total_expected_servings, 0);
              const comparison = eventRecord.budget_comparison || {};
              const isDiningHall = eventRecord.service_style === 'dining_hall';
              const approvalHistory = Array.isArray(eventRecord.approval_history) ? eventRecord.approval_history : [];
              const latestHistory = approvalHistory.at(-1);

              return (
                <Card key={eventRecord.id} className="border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                  <CardContent className="p-6">
                    <div className="flex flex-col gap-4 xl:flex-row xl:justify-between xl:items-start">
                      <div className="flex gap-4">
                        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                          <ChefHat className="w-6 h-6 text-blue-600" />
                        </div>
                        <div className="space-y-2">
                          <div>
                            <h3 className="font-semibold text-slate-900 text-lg">{eventRecord.event_name}</h3>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <Badge className="bg-blue-100 text-blue-700">{eventRecord.event_date || eventRecord.plan_date}</Badge>
                              <Badge variant="outline">{eventRecord.site_name}</Badge>
                              {eventRecord.service_style && (
                                <Badge variant="outline" className="capitalize">
                                  {String(eventRecord.service_style).replace(/_/g, ' ')}
                                </Badge>
                              )}
                              <Badge className={statusStyles[eventRecord.status] || statusStyles.draft}>
                                {String(eventRecord.status || 'draft').replace(/_/g, ' ')}
                              </Badge>
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-1">
                            {[...new Set((eventRecord.meals || []).map((meal) => meal.meal_type).filter(Boolean))].map((type) => (
                              <Badge key={type} className="bg-emerald-100 text-emerald-700 capitalize text-xs">
                                {type}
                              </Badge>
                            ))}
                          </div>

                          <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
                            <p><span className="font-medium text-slate-800">Expected participants:</span> {participants}</p>
                            <p><span className="font-medium text-slate-800">Estimated cost:</span> {formatCurrency(eventRecord.estimated_cost ?? eventRecord.total_planned_cost ?? 0)}</p>
                            <p><span className="font-medium text-slate-800">Budget:</span> {eventRecord.linked_budget?.name || eventRecord.budget_name || 'Not linked'}</p>
                            <p className={comparison.is_over_budget ? 'text-rose-600 font-medium' : ''}>
                              <span className="font-medium text-slate-800">Budget status:</span>{' '}
                              {comparison.is_over_budget
                                ? `Exceeded by ${formatCurrency(comparison.exceeded_amount)}`
                                : `Remaining ${formatCurrency(comparison.remaining_budget)}`}
                            </p>
                          </div>

                          {latestHistory && (
                            <p className="text-xs text-slate-500">
                              Last action: {latestHistory.action} by {latestHistory.actor_name || latestHistory.actor_email || 'system'} on {format(new Date(latestHistory.timestamp), 'PPP p')}
                            </p>
                          )}

                          {approvalHistory.length > 0 && (
                            <div className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approval History</p>
                              {approvalHistory.slice(-3).reverse().map((entry, index) => (
                                <p key={`${entry.timestamp || 'history'}-${index}`} className="text-xs text-slate-600">
                                  <span className="font-medium text-slate-800">{String(entry.action || '').replace(/_/g, ' ')}</span>
                                  {' '}by {entry.actor_name || entry.actor_email || 'system'}
                                  {entry.note ? ` · ${entry.note}` : ''}
                                </p>
                              ))}
                            </div>
                          )}

                          {isDiningHall && eventRecord.qr_token && (
                            <div className="flex gap-2 pt-1">
                              <Button size="sm" variant="outline" className="text-xs" onClick={() => setQrEvent(eventRecord)}>
                                <QrCode className="w-3 h-3 mr-1" /> View QR Code
                              </Button>
                              <Link to={createPageUrl('DiningScanner')}>
                                <Button size="sm" variant="outline" className="text-xs text-emerald-700 border-emerald-300">
                                  <ExternalLink className="w-3 h-3 mr-1" /> Open Scanner
                                </Button>
                              </Link>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 xl:min-w-[420px] xl:grid-cols-4">
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-center">
                          <p className="text-2xl font-bold text-slate-900">{participants}</p>
                          <p className="text-xs text-slate-500 flex items-center justify-center gap-1"><Users className="w-3 h-3" /> Participants</p>
                        </div>
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-center">
                          <p className="text-2xl font-bold text-emerald-600">{foodKg.toFixed(1)}</p>
                          <p className="text-xs text-slate-500 flex items-center justify-center gap-1"><Scale className="w-3 h-3" /> Total kg</p>
                        </div>
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-center">
                          <p className={`text-2xl font-bold ${comparison.is_over_budget ? 'text-rose-600' : 'text-blue-600'}`}>
                            {formatCurrency(eventRecord.total_planned_cost || eventRecord.estimated_cost || 0)}
                          </p>
                          <p className="text-xs text-slate-500">Estimated Cost</p>
                        </div>
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-center">
                          <p className={`text-2xl font-bold ${comparison.is_over_budget ? 'text-rose-600' : 'text-orange-600'}`}>
                            {comparison.is_over_budget ? formatCurrency(comparison.exceeded_amount) : formatCurrency(comparison.remaining_budget)}
                          </p>
                          <p className="text-xs text-slate-500">{comparison.is_over_budget ? 'Over Budget' : 'Remaining Budget'}</p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                      {can('edit_special_event') && ['draft', 'rejected'].includes(String(eventRecord.status || '').toLowerCase()) && (
                        <Button size="sm" variant="outline" onClick={() => openEditForm(eventRecord)}>
                          <Pencil className="w-3 h-3 mr-1" /> Edit Request
                        </Button>
                      )}

                      {can('submit_special_event') && ['draft', 'rejected'].includes(String(eventRecord.status || '').toLowerCase()) && (
                        <Button
                          size="sm"
                          className="bg-amber-600 hover:bg-amber-700"
                          onClick={() => submitMutation.mutate({ id: eventRecord.id, note: '' })}
                          disabled={submitMutation.isPending}
                        >
                          Submit for Approval
                        </Button>
                      )}

                      {can('approve_special_event') && eventRecord.status === 'pending_approval' && (
                        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => openApprovalDialog(eventRecord, 'approve')}>
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
                        </Button>
                      )}

                      {can('reject_special_event') && eventRecord.status === 'pending_approval' && (
                        <Button size="sm" variant="outline" className="border-rose-300 text-rose-700" onClick={() => openApprovalDialog(eventRecord, 'reject')}>
                          <XCircle className="w-3 h-3 mr-1" /> Reject
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <Dialog open={!!qrEvent} onOpenChange={() => setQrEvent(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><QrCode className="w-5 h-5 text-emerald-600" /> Event QR Code</DialogTitle>
            </DialogHeader>
            {qrEvent && (
              <div className="text-center space-y-4">
                <div className="bg-white border-2 border-slate-200 rounded-xl p-6 inline-block">
                  <QRCodeSVG value={qrEvent.qr_token} size={200} level="H" />
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{qrEvent.event_name}</p>
                  <p className="text-sm text-slate-500">{qrEvent.site_name} · {qrEvent.event_date || qrEvent.plan_date}</p>
                  <p className="text-xs text-slate-400 mt-2 font-mono bg-slate-50 px-3 py-1 rounded">{qrEvent.qr_token}</p>
                </div>
                <p className="text-xs text-slate-500">Staff scan this QR at the dining hall entrance to check guests in via the Scanner page.</p>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{approvalAction === 'approve' ? 'Approve Special Event' : 'Reject Special Event'}</DialogTitle>
            </DialogHeader>
            {selectedEvent && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
                  <p className="font-semibold text-slate-900">{selectedEvent.event_name}</p>
                  <p className="text-slate-600 mt-1">{selectedEvent.site_name} · {selectedEvent.event_date || selectedEvent.plan_date}</p>
                  <p className="text-slate-600 mt-1">Estimated cost: {formatCurrency(selectedEvent.total_planned_cost || selectedEvent.estimated_cost || 0)}</p>
                </div>
                <div>
                  <Label>{approvalAction === 'approve' ? 'Approval note' : 'Rejection reason *'}</Label>
                  <Textarea
                    value={approvalNote}
                    onChange={(event) => setApprovalNote(event.target.value)}
                    className="mt-1"
                    rows={4}
                    placeholder={approvalAction === 'approve' ? 'Add optional approval guidance...' : 'Explain why this request is being rejected'}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setApprovalOpen(false)}>Cancel</Button>
                  {approvalAction === 'approve' ? (
                    <Button
                      className="bg-emerald-600 hover:bg-emerald-700"
                      onClick={() => approveMutation.mutate({ id: selectedEvent.id, note: approvalNote })}
                      disabled={approveMutation.isPending}
                    >
                      {approveMutation.isPending ? 'Approving...' : 'Approve Event'}
                    </Button>
                  ) : (
                    <Button
                      className="bg-rose-600 hover:bg-rose-700"
                      onClick={() => rejectMutation.mutate({ id: selectedEvent.id, note: approvalNote })}
                      disabled={!approvalNote.trim() || rejectMutation.isPending}
                    >
                      {rejectMutation.isPending ? 'Rejecting...' : 'Reject Event'}
                    </Button>
                  )}
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ChefHat className="w-5 h-5 text-emerald-600" />
                {formData.id ? 'Edit Special Event Request' : 'Create Special Event Request'}
              </DialogTitle>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <Label>Event Name *</Label>
                  <Input
                    value={formData.event_name}
                    onChange={(event) => setFormData({ ...formData, event_name: event.target.value })}
                    placeholder="e.g. Ramadan Iftar Dinner"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label>Project / Unit *</Label>
                  <Select value={formData.site_id} onValueChange={(value) => setFormData({ ...formData, site_id: value })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select site" /></SelectTrigger>
                    <SelectContent>
                      {sites.map((site) => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Event Date *</Label>
                  <Input
                    type="date"
                    value={formData.date}
                    onChange={(event) => setFormData({ ...formData, date: event.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label>Expected Participants *</Label>
                  <Input
                    type="number"
                    min="1"
                    value={formData.covers}
                    onChange={(event) => setFormData({ ...formData, covers: event.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label>Estimated Cost *</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.estimated_cost}
                    onChange={(event) => setFormData({ ...formData, estimated_cost: event.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label>Duration (hours)</Label>
                  <Input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={formData.event_duration_hours}
                    onChange={(event) => setFormData({ ...formData, event_duration_hours: event.target.value })}
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label>Service Style</Label>
                  <Select value={formData.service_style} onValueChange={(value) => setFormData({ ...formData, service_style: value })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SERVICE_STYLES.map((style) => (
                        <SelectItem key={style} value={style}>{style.replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Audience Profile</Label>
                  <Select value={formData.audience_profile} onValueChange={(value) => setFormData({ ...formData, audience_profile: value })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AUDIENCE_PROFILES.map((profile) => (
                        <SelectItem key={profile} value={profile}>{profile.replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="mb-2 block">Meal Types Included</Label>
                <div className="flex flex-wrap gap-2">
                  {MEAL_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleMealType(type)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all capitalize ${
                        formData.meal_types.includes(type)
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:border-emerald-400'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <Label>Consumption per person (g)</Label>
                  <Input
                    type="number"
                    value={formData.consumption_per_person_g}
                    onChange={(event) => setFormData({ ...formData, consumption_per_person_g: event.target.value })}
                    className="mt-1"
                  />
                  <p className="text-xs text-slate-500 mt-1">Default: 550g/person</p>
                </div>
                <div>
                  <Label>Buffer % (safety stock)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="50"
                    value={formData.buffer_percent}
                    onChange={(event) => setFormData({ ...formData, buffer_percent: event.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              {covers > 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <h4 className="font-semibold text-emerald-900 mb-3 flex items-center gap-2">
                    <Scale className="w-4 h-4" /> Auto-Calculated Food Requirement
                  </h4>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="bg-white rounded-lg p-3">
                      <p className="text-xl font-bold text-slate-900">{covers}</p>
                      <p className="text-xs text-slate-500">Guests</p>
                    </div>
                    <div className="bg-white rounded-lg p-3">
                      <p className="text-xl font-bold text-blue-600">{baseFoodKg.toFixed(1)} kg</p>
                      <p className="text-xs text-slate-500">Base food</p>
                    </div>
                    <div className="bg-white rounded-lg p-3">
                      <p className="text-xl font-bold text-emerald-600">{finalFoodKg.toFixed(1)} kg</p>
                      <p className="text-xs text-slate-500">With {buffer}% buffer</p>
                    </div>
                  </div>
                </div>
              )}

              <Card className="border-slate-200">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Budget Validation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label>Linked Budget</Label>
                    <Select value={formData.budget_id || '__none'} onValueChange={(value) => setFormData({ ...formData, budget_id: value === '__none' ? '' : value })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Select budget" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">No budget selected</SelectItem>
                        {budgetCandidates.map((budget) => (
                          <SelectItem key={budget.id} value={budget.id}>
                            {budget.name} · {formatCurrency(budget.budget_amount)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Budget</p>
                      <p className="mt-1 font-semibold text-slate-900">{linkedBudget?.name || 'No linked budget'}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Budget Amount</p>
                      <p className="mt-1 font-semibold text-slate-900">{formatCurrency(budgetComparison.budget_amount)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Planned Cost</p>
                      <p className={`mt-1 font-semibold ${budgetComparison.is_over_budget ? 'text-rose-600' : 'text-slate-900'}`}>
                        {formatCurrency(budgetComparison.planned_cost)}
                      </p>
                    </div>
                    <div className={`rounded-xl border p-3 ${budgetComparison.is_over_budget ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}>
                      <p className="text-xs uppercase tracking-wide text-slate-500">{budgetComparison.is_over_budget ? 'Exceeded' : 'Remaining'}</p>
                      <p className={`mt-1 font-semibold ${budgetComparison.is_over_budget ? 'text-rose-600' : 'text-emerald-700'}`}>
                        {formatCurrency(budgetComparison.is_over_budget ? budgetComparison.exceeded_amount : budgetComparison.remaining_budget)}
                      </p>
                    </div>
                  </div>

                  {budgetComparison.is_over_budget && (
                    <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                      <AlertTriangle className="w-4 h-4 mt-0.5" />
                      <p>This event is over budget and cannot be approved until the estimated cost is reduced or a larger budget is linked.</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <div>
                <Label>Notes</Label>
                <Textarea
                  value={formData.notes}
                  onChange={(event) => setFormData({ ...formData, notes: event.target.value })}
                  className="mt-1"
                  rows={3}
                  placeholder="Special requirements, service notes, or dietary expectations..."
                />
              </div>

              {formError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {formError}
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); }}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={createOrUpdateMutation.isPending}>
                  {createOrUpdateMutation.isPending ? 'Saving...' : formData.id ? 'Update Event Request' : 'Create Event Request'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
