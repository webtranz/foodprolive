import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarDays, Check, CheckCircle2, CircleDollarSign, ClipboardCheck,
  Factory, Link2, MapPin, PackagePlus, Pencil, Plus, Send, ShoppingCart, Trash2,
  Users, XCircle
} from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import AsyncStatePanel from '@/components/ui/AsyncStatePanel';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency, formatNumber } from '@/lib/currency';

const MEAL_PERIODS = ['breakfast', 'lunch', 'dinner', 'snack'];
const SERVICE_TYPES = ['buffet', 'plated_service', 'packed_meal', 'dining_hall'];
const STATUS_STYLE = {
  draft: 'bg-slate-100 text-slate-700',
  pending_approval: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800'
};

const emptyForm = () => ({
  id: null,
  event_name: '',
  event_date: format(new Date(), 'yyyy-MM-dd'),
  site_id: '',
  event_location: '',
  expected_participants: '100',
  meal_period: 'lunch',
  service_style: 'buffet',
  event_budget: '',
  selling_price_per_guest: '',
  budget_id: '',
  menu_package_name: 'Custom menu package',
  prep_start_date: '',
  kitchen_assignment: '',
  notes: '',
  linked_recipes: []
});

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function label(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formFromEvent(event = {}) {
  return {
    ...emptyForm(),
    id: event.id,
    event_name: event.event_name || '',
    event_date: event.event_date || event.plan_date || '',
    site_id: event.site_id || '',
    event_location: event.event_location || '',
    expected_participants: String(event.expected_participants || ''),
    meal_period: event.meal_period || event.meals?.[0]?.meal_type || 'lunch',
    service_style: event.service_style || 'buffet',
    event_budget: String(event.event_budget || event.budget_amount || ''),
    selling_price_per_guest: String(event.selling_price_per_guest || ''),
    budget_id: event.budget_id || '',
    menu_package_name: event.menu_package_name || 'Custom menu package',
    prep_start_date: event.prep_start_date || '',
    kitchen_assignment: event.kitchen_assignment || '',
    notes: event.notes || '',
    linked_recipes: (event.linked_recipes || []).map((recipe) => ({
      recipe_id: recipe.recipe_id,
      recipe_name: recipe.recipe_name,
      course_name: recipe.course_name || recipe.recipe_name,
      portion_requirement: number(recipe.portion_requirement, 1),
      meal_period: recipe.meal_period || event.meal_period || 'lunch',
      kitchen_station: recipe.kitchen_station || 'Unassigned'
    }))
  };
}

function buildPayload(form, sites) {
  const site = sites.find((item) => String(item.id) === String(form.site_id));
  return {
    event_name: form.event_name.trim(),
    event_date: form.event_date,
    plan_date: form.event_date,
    site_id: form.site_id,
    site_name: site?.name || '',
    event_location: form.event_location.trim(),
    expected_participants: number(form.expected_participants),
    total_expected_servings: number(form.expected_participants),
    meal_period: form.meal_period,
    meal_types: [form.meal_period],
    service_style: form.service_style,
    event_budget: number(form.event_budget),
    selling_price_per_guest: number(form.selling_price_per_guest),
    budget_id: form.budget_id || null,
    menu_package_name: form.menu_package_name.trim() || 'Custom menu package',
    prep_start_date: form.prep_start_date || null,
    kitchen_assignment: form.kitchen_assignment.trim(),
    notes: form.notes,
    estimated_cost: 0,
    linked_recipes: form.linked_recipes
  };
}

function CheckItem({ complete, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-slate-600">{children}</span>
      {complete ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
    </div>
  );
}

function SummaryMetric({ title, value, tone = 'slate' }) {
  const tones = { slate: 'text-slate-900', emerald: 'text-emerald-700', rose: 'text-rose-700', blue: 'text-blue-700' };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
      <p className={`mt-1 text-lg font-bold ${tones[tone]}`}>{value}</p>
    </div>
  );
}

export default function EventPlanning() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const [selectedId, setSelectedId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [formData, setFormData] = useState(emptyForm());
  const [recipeToAdd, setRecipeToAdd] = useState('');
  const [actionError, setActionError] = useState('');
  const [approval, setApproval] = useState(null);
  const [approvalNote, setApprovalNote] = useState('');

  const eventsQuery = useQuery({ queryKey: ['specialEvents'], queryFn: () => base44.specialEvents.list(300, false) });
  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list('name', 1000) });
  const recipesQuery = useQuery({
    queryKey: ['recipes', 'event-planning', formData.site_id],
    queryFn: () => base44.specialEvents.listRecipes(formData.site_id),
    placeholderData: (previousData) => previousData,
    refetchInterval: formOpen ? 30000 : false
  });
  const events = eventsQuery.data || [];
  const sites = sitesQuery.data || [];
  const recipes = (recipesQuery.data || []).filter((recipe) => recipe.is_active !== false);

  useEffect(() => {
    if (!selectedId && events[0]?.id) setSelectedId(events[0].id);
    if (selectedId && events.length && !events.some((event) => event.id === selectedId)) setSelectedId(events[0].id);
  }, [events, selectedId]);

  const selectedSummary = events.find((event) => event.id === selectedId) || events[0] || null;
  const eventDetailQuery = useQuery({
    queryKey: ['specialEvent', selectedSummary?.id],
    queryFn: () => base44.specialEvents.get(selectedSummary.id),
    enabled: Boolean(selectedSummary?.id),
    refetchInterval: 30000
  });
  const selected = eventDetailQuery.data || selectedSummary;
  const selectedSite = sites.find((site) => site.id === formData.site_id);
  const budgetContextQuery = useQuery({
    queryKey: ['specialEventBudgetContext', formData.site_id, formData.event_date, formData.event_name, formData.budget_id],
    queryFn: () => base44.specialEvents.getBudgetContext(formData.site_id, formData.event_date, formData.event_name, formData.budget_id, 0),
    enabled: formOpen && Boolean(formData.site_id && formData.event_date && formData.event_name.trim())
  });
  const budgetCandidates = budgetContextQuery.data?.budget_candidates || [];
  const packageTemplates = events.filter((event) => Array.isArray(event.linked_recipes) && event.linked_recipes.length > 0);
  const formPreviewRows = formData.linked_recipes.map((link) => {
    const recipe = recipes.find((item) => item.id === link.recipe_id);
    const itemCost = recipe?.cost_per_serving ?? null;
    const portions = number(formData.expected_participants) * number(link.portion_requirement, 1);
    return { ...link, item_cost: itemCost, preview_portions: portions, preview_line_cost: itemCost === null ? null : itemCost * portions };
  });
  const formPreviewComplete = formPreviewRows.length > 0 && formPreviewRows.every((row) => row.preview_line_cost !== null);
  const formPreviewTotal = formPreviewComplete ? formPreviewRows.reduce((sum, row) => sum + row.preview_line_cost, 0) : null;

  const invalidate = async (id) => {
    await queryClient.invalidateQueries({ queryKey: ['specialEvents'] });
    await queryClient.invalidateQueries({ queryKey: ['specialEvent'] });
    if (id) setSelectedId(id);
    setActionError('');
  };

  const saveMutation = useMutation({
    mutationFn: (payload) => formData.id ? base44.specialEvents.update(formData.id, payload) : base44.specialEvents.create(payload),
    onSuccess: async (event) => { setFormOpen(false); await invalidate(event.id); },
    onError: (error) => setActionError(error.message)
  });
  const productionMutation = useMutation({
    mutationFn: (event) => base44.specialEvents.generateProduction(event.id, { prep_start_date: event.prep_start_date }),
    onSuccess: (result) => invalidate(result.event?.id || selectedId),
    onError: (error) => setActionError(error.message)
  });
  const procurementMutation = useMutation({
    mutationFn: (event) => base44.specialEvents.createPurchaseRequest(event.id),
    onSuccess: (result) => invalidate(result.event?.id || selectedId),
    onError: (error) => setActionError(error.message)
  });
  const submitMutation = useMutation({
    mutationFn: (event) => base44.specialEvents.submit(event.id, ''),
    onSuccess: (event) => invalidate(event.id),
    onError: (error) => setActionError(error.message)
  });
  const decisionMutation = useMutation({
    mutationFn: ({ event, type, note }) => type === 'approve'
      ? base44.specialEvents.approve(event.id, note)
      : base44.specialEvents.reject(event.id, note),
    onSuccess: async (event) => { setApproval(null); setApprovalNote(''); await invalidate(event.id); },
    onError: (error) => setActionError(error.message)
  });

  const openCreate = () => { setFormData(emptyForm()); setRecipeToAdd(''); setFormOpen(true); };
  const openEdit = (event) => { setFormData(formFromEvent(event)); setRecipeToAdd(''); setFormOpen(true); };
  const addRecipe = () => {
    const recipe = recipes.find((item) => item.id === recipeToAdd);
    if (!recipe || formData.linked_recipes.some((item) => item.recipe_id === recipe.id)) return;
    setFormData((current) => ({
      ...current,
      linked_recipes: [...current.linked_recipes, {
        recipe_id: recipe.id,
        recipe_name: recipe.name,
        course_name: recipe.name,
        portion_requirement: 1,
        meal_period: current.meal_period,
        kitchen_station: recipe.kitchen_station || recipe.station || 'Unassigned'
      }]
    }));
    setRecipeToAdd('');
  };
  const updateLinkedRecipe = (index, patch) => setFormData((current) => ({
    ...current,
    linked_recipes: current.linked_recipes.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)
  }));

  const submitForm = (event) => {
    event.preventDefault();
    if (!formData.linked_recipes.length) {
      setActionError('Link at least one recipe before saving the event plan.');
      return;
    }
    saveMutation.mutate(buildPayload(formData, sites));
  };

  const linkedRecipes = selected?.linked_recipes || [];
  const shortages = selected?.shortage_items || [];
  const checklist = selected?.approval_checklist || {};
  const canGenerateProduction = can('edit_special_event') || can('manage_production') || can('create_production_request');
  const canCreatePR = can('edit_special_event') || can('manage_procurement') || can('create_material_request');
  const loading = eventsQuery.isLoading || sitesQuery.isLoading || recipesQuery.isLoading || (selectedSummary && eventDetailQuery.isLoading);
  const loadError = eventsQuery.error || sitesQuery.error || recipesQuery.error || eventDetailQuery.error;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1800px]">
        <PageHeader title="Event & Meal Planning" description="Connected menu, costing, production, procurement, and approval planning">
          {can('create_special_event') && <Button className="bg-teal-700 hover:bg-teal-800" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New Event</Button>}
        </PageHeader>

        {actionError && <div className="mb-4 flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{actionError}</span><button onClick={() => setActionError('')}><XCircle className="h-4 w-4" /></button></div>}

        {loadError ? <AsyncStatePanel variant="error" title="Event workspace could not load" description={loadError.message} /> : loading ? (
          <AsyncStatePanel variant="loading" title="Loading event planning" description="Connecting events with recipes, current costs, inventory, and approvals." />
        ) : !selected ? (
          <Card><CardContent className="p-16 text-center"><CalendarDays className="mx-auto mb-4 h-14 w-14 text-slate-300" /><h2 className="text-lg font-semibold">No event plans yet</h2><p className="mt-2 text-slate-500">Create the first linked event and meal plan.</p></CardContent></Card>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
            <aside className="space-y-2">
              <p className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Event requests</p>
              {events.map((event) => (
                <button key={event.id} onClick={() => setSelectedId(event.id)} className={`w-full rounded-xl border p-3 text-left transition ${event.id === selected.id ? 'border-teal-500 bg-teal-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                  <div className="flex items-start justify-between gap-2"><p className="font-semibold text-slate-900">{event.event_name}</p><Badge className={STATUS_STYLE[event.status] || STATUS_STYLE.draft}>{label(event.status)}</Badge></div>
                  <p className="mt-2 text-xs text-slate-500">{event.event_date || event.plan_date} · {event.site_name}</p>
                  <p className="mt-1 text-xs text-slate-500">{formatNumber(event.expected_participants)} guests · {event.linked_recipes?.length || 0} recipes</p>
                </button>
              ))}
            </aside>

            <main className="min-w-0 space-y-5">
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-bold text-slate-950">{selected.event_name}</h2><Badge className={STATUS_STYLE[selected.status] || STATUS_STYLE.draft}>{label(selected.status)}</Badge></div>
                      <div className="mt-4 grid gap-x-8 gap-y-3 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
                        <span className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-teal-700" />{selected.event_date || selected.plan_date}</span>
                        <span className="flex items-center gap-2"><Users className="h-4 w-4 text-teal-700" />{formatNumber(selected.expected_participants)} guests</span>
                        <span className="flex items-center gap-2"><MapPin className="h-4 w-4 text-teal-700" />{selected.event_location || selected.site_name}</span>
                        <span><b>Project:</b> {selected.site_name}</span><span><b>Meal:</b> {label(selected.meal_period)}</span><span><b>Service:</b> {label(selected.service_style)}</span>
                      </div>
                    </div>
                    {can('edit_special_event') && ['draft', 'rejected'].includes(selected.status) && <Button variant="outline" onClick={() => openEdit(selected)}><Pencil className="mr-2 h-4 w-4" />Edit Event</Button>}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 pb-4"><div className="flex items-center justify-between"><CardTitle className="flex items-center gap-2 text-lg"><Link2 className="h-5 w-5 text-teal-700" />Linked Menu</CardTitle><Badge variant="outline">{linkedRecipes.length} recipes</Badge></div><p className="text-sm text-slate-500">{selected.menu_package_name || 'Custom menu package'} · costs refresh from current recipe ingredients</p></CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[840px] text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="p-3">Course / item</th><th className="p-3">Portions</th><th className="p-3">Portion size</th><th className="p-3">Item cost</th><th className="p-3">Line cost</th><th className="p-3">Station</th><th className="p-3">Production</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {linkedRecipes.map((recipe) => <tr key={recipe.recipe_id}><td className="p-3"><p className="font-semibold text-slate-900">{recipe.course_name || recipe.recipe_name}</p><p className="text-xs text-slate-500">{label(recipe.meal_period)}</p></td><td className="p-3">{formatNumber(recipe.required_portions, 0)}</td><td className="p-3">{recipe.portion_size}</td><td className="p-3">{recipe.item_cost === null ? <span className="text-rose-600">Missing cost</span> : formatCurrency(recipe.item_cost)}</td><td className="p-3 font-semibold">{recipe.line_cost === null ? '—' : formatCurrency(recipe.line_cost)}</td><td className="p-3">{recipe.kitchen_station}</td><td className="p-3"><Badge className={recipe.production_status === 'planned' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}>{label(recipe.production_status)}</Badge></td></tr>)}
                        {!linkedRecipes.length && <tr><td colSpan="7" className="p-8 text-center text-slate-500">No recipes linked. Edit the event to build its menu.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 pb-4"><CardTitle className="flex items-center gap-2 text-lg"><ShoppingCart className="h-5 w-5 text-teal-700" />Procurement Impact</CardTitle></CardHeader>
                <CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="p-3">Ingredient</th><th className="p-3">Required</th><th className="p-3">Available</th><th className="p-3">Shortage</th><th className="p-3">Estimated spend</th></tr></thead><tbody className="divide-y divide-slate-100">{(selected.ingredient_requirements || []).map((item) => <tr key={item.ingredient_id} className={item.shortage_quantity > 0 ? 'bg-rose-50/50' : ''}><td className="p-3 font-medium">{item.ingredient_name}</td><td className="p-3">{formatNumber(item.required_quantity, 2)} {item.unit}</td><td className="p-3">{formatNumber(item.available_stock, 2)} {item.unit}</td><td className={`p-3 font-semibold ${item.shortage_quantity > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatNumber(item.shortage_quantity, 2)} {item.unit}</td><td className="p-3">{formatCurrency(item.estimated_procurement_spend)}</td></tr>)}</tbody></table></div></CardContent>
              </Card>

              <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4">
                {canGenerateProduction && <Button variant="outline" onClick={() => productionMutation.mutate(selected)} disabled={productionMutation.isPending || selected.production_plan_status === 'generated'}><Factory className="mr-2 h-4 w-4" />{selected.production_plan_status === 'generated' ? 'Production Plan Generated' : 'Generate Production Plan'}</Button>}
                {canCreatePR && <Button variant="outline" onClick={() => procurementMutation.mutate(selected)} disabled={procurementMutation.isPending || Boolean(selected.procurement_pr_id)}><PackagePlus className="mr-2 h-4 w-4" />{selected.procurement_pr_id ? `PR ${selected.procurement_pr_number || 'Created'}` : 'Create PR'}</Button>}
                {can('submit_special_event') && ['draft', 'rejected'].includes(selected.status) && <Button className="bg-teal-700 hover:bg-teal-800" onClick={() => submitMutation.mutate(selected)} disabled={submitMutation.isPending || !selected.ready_to_submit}><Send className="mr-2 h-4 w-4" />Submit for Approval</Button>}
                {can('approve_special_event') && selected.status === 'pending_approval' && <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setApproval('approve')}><Check className="mr-2 h-4 w-4" />Approve</Button>}
                {can('reject_special_event') && selected.status === 'pending_approval' && <Button variant="outline" className="border-rose-300 text-rose-700" onClick={() => setApproval('reject')}><XCircle className="mr-2 h-4 w-4" />Reject</Button>}
              </div>
            </main>

            <aside className="space-y-4">
              <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><CircleDollarSign className="h-5 w-5 text-teal-700" />Event Cost Summary</CardTitle></CardHeader><CardContent className="grid gap-3"><SummaryMetric title="Total event cost" value={formatCurrency(selected.total_event_cost)} tone="blue" /><SummaryMetric title="Cost per guest" value={`${formatCurrency(selected.cost_per_guest)} / guest`} /><SummaryMetric title="Average item cost" value={formatCurrency(selected.average_item_cost)} /><SummaryMetric title="Budget remaining" value={formatCurrency(selected.budget_remaining)} tone={selected.budget_comparison?.is_over_budget ? 'rose' : 'emerald'} />{selected.food_cost_percent !== null && selected.food_cost_percent !== undefined && <SummaryMetric title="Food cost" value={`${formatNumber(selected.food_cost_percent, 2)}%`} />}{selected.margin_per_guest !== null && selected.margin_per_guest !== undefined && <SummaryMetric title="Margin / guest" value={formatCurrency(selected.margin_per_guest)} tone={selected.margin_per_guest < 0 ? 'rose' : 'emerald'} />}{selected.budget_comparison?.is_over_budget && <div className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><AlertTriangle className="h-4 w-4 shrink-0" />Budget overrun must be resolved before approval.</div>}</CardContent></Card>
              <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><ShoppingCart className="h-5 w-5 text-teal-700" />Procurement</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex justify-between"><span>Shortage items</span><b className={shortages.length ? 'text-rose-700' : 'text-emerald-700'}>{shortages.length}</b></div><div className="flex justify-between"><span>Estimated spend</span><b>{formatCurrency(selected.estimated_procurement_spend)}</b></div><div className="flex justify-between"><span>PR status</span><Badge variant="outline">{label(selected.procurement_pr_status)}</Badge></div></CardContent></Card>
              <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Factory className="h-5 w-5 text-teal-700" />Production Handoff</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex justify-between"><span>Plan status</span><Badge variant="outline">{label(selected.production_plan_status)}</Badge></div><div className="flex justify-between"><span>Prep start</span><b>{selected.prep_start_date || 'Not set'}</b></div><div className="flex justify-between"><span>Kitchen</span><b>{selected.kitchen_assignment || 'Recipe stations'}</b></div></CardContent></Card>
              <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="h-5 w-5 text-teal-700" />Approval Checklist</CardTitle></CardHeader><CardContent className="divide-y divide-slate-100"><CheckItem complete={checklist.event_details}>Event details</CheckItem><CheckItem complete={checklist.menu_and_costing}>Menu and costing</CheckItem><CheckItem complete={checklist.budget_check}>Budget check</CheckItem><CheckItem complete={checklist.procurement_plan || selected.procurement_pr_status === 'not_required'}>Procurement plan</CheckItem><CheckItem complete={checklist.production_plan}>Production plan</CheckItem><div className="flex items-center justify-between pt-3 text-sm font-semibold"><span>Overall status</span><Badge className={STATUS_STYLE[selected.status] || STATUS_STYLE.draft}>{label(selected.status)}</Badge></div></CardContent></Card>
              {selected.notes && <Card><CardHeader className="pb-2"><CardTitle className="text-base">Plan Notes</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm text-slate-600">{selected.notes}</p></CardContent></Card>}
            </aside>
          </div>
        )}

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
            <DialogHeader><DialogTitle>{formData.id ? 'Edit Event & Meal Plan' : 'Create Event & Meal Plan'}</DialogTitle></DialogHeader>
            <form onSubmit={submitForm} className="space-y-6">
              <section><h3 className="mb-3 font-semibold text-slate-900">1. Event Details</h3><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="lg:col-span-2"><Label>Event name *</Label><Input className="mt-1" value={formData.event_name} onChange={(event) => setFormData({ ...formData, event_name: event.target.value })} required /></div>
                <div><Label>Date *</Label><Input type="date" className="mt-1" value={formData.event_date} onChange={(event) => setFormData({ ...formData, event_date: event.target.value })} required /></div>
                <div><Label>Project *</Label><Select value={formData.site_id} onValueChange={(value) => setFormData({ ...formData, site_id: value })}><SelectTrigger className="mt-1"><SelectValue placeholder="Select project" /></SelectTrigger><SelectContent>{sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Location *</Label><Input className="mt-1" value={formData.event_location} onChange={(event) => setFormData({ ...formData, event_location: event.target.value })} placeholder={selectedSite?.name || 'Event venue'} required /></div>
                <div><Label>Guest count *</Label><Input type="number" min="1" className="mt-1" value={formData.expected_participants} onChange={(event) => setFormData({ ...formData, expected_participants: event.target.value })} required /></div>
                <div><Label>Meal period</Label><Select value={formData.meal_period} onValueChange={(value) => setFormData({ ...formData, meal_period: value })}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent>{MEAL_PERIODS.map((item) => <SelectItem key={item} value={item}>{label(item)}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Service type</Label><Select value={formData.service_style} onValueChange={(value) => setFormData({ ...formData, service_style: value })}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent>{SERVICE_TYPES.map((item) => <SelectItem key={item} value={item}>{label(item)}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Event budget (﷼) *</Label><Input type="number" min="0" step="0.01" className="mt-1" value={formData.event_budget} onChange={(event) => setFormData({ ...formData, event_budget: event.target.value })} required /></div>
                <div><Label>Selling price / guest (﷼)</Label><Input type="number" min="0" step="0.01" className="mt-1" value={formData.selling_price_per_guest} onChange={(event) => setFormData({ ...formData, selling_price_per_guest: event.target.value })} /></div>
                <div><Label>Linked approval budget</Label><Select value={formData.budget_id || '__none'} onValueChange={(value) => setFormData({ ...formData, budget_id: value === '__none' ? '' : value })}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none">No linked budget</SelectItem>{budgetCandidates.map((budget) => <SelectItem key={budget.id} value={budget.id}>{budget.name} · {formatCurrency(budget.budget_amount)}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Prep start date</Label><Input type="date" className="mt-1" value={formData.prep_start_date} onChange={(event) => setFormData({ ...formData, prep_start_date: event.target.value })} /></div>
                <div><Label>Kitchen assignment</Label><Input className="mt-1" value={formData.kitchen_assignment} onChange={(event) => setFormData({ ...formData, kitchen_assignment: event.target.value })} placeholder="Central Kitchen" /></div>
              </div></section>

              <section><div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="font-semibold text-slate-900">2. Linked Menu</h3><p className="text-sm text-slate-500">Every linked recipe is scaled automatically when guest count changes.</p></div><Badge variant="outline">{formData.linked_recipes.length} linked</Badge></div>
                <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto]"><div><Label>Menu package selector</Label><Select onValueChange={(eventId) => { const template = packageTemplates.find((item) => item.id === eventId); if (template) setFormData((current) => ({ ...current, menu_package_name: template.menu_package_name || `${template.event_name} menu`, linked_recipes: formFromEvent(template).linked_recipes })); }}><SelectTrigger className="mt-1"><SelectValue placeholder="Load a saved package" /></SelectTrigger><SelectContent>{packageTemplates.map((event) => <SelectItem key={event.id} value={event.id}>{event.menu_package_name || `${event.event_name} menu`}</SelectItem>)}</SelectContent></Select></div><div><Label>Package name</Label><Input className="mt-1" value={formData.menu_package_name} onChange={(event) => setFormData({ ...formData, menu_package_name: event.target.value })} /></div><div><Label>Add individual recipe</Label><Select value={recipeToAdd} onValueChange={setRecipeToAdd}><SelectTrigger className="mt-1"><SelectValue placeholder="Search/select recipe" /></SelectTrigger><SelectContent>{recipes.filter((recipe) => !formData.linked_recipes.some((item) => item.recipe_id === recipe.id)).map((recipe) => <SelectItem key={recipe.id} value={recipe.id}>{recipe.name}</SelectItem>)}</SelectContent></Select></div><Button type="button" variant="outline" className="self-end" onClick={addRecipe} disabled={!recipeToAdd}><Plus className="mr-2 h-4 w-4" />Add</Button></div>
                <div className="space-y-3">{formPreviewRows.map((recipe, index) => <div key={recipe.recipe_id} className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1.2fr_120px_130px_1fr_auto]"><div><Label>Course / item</Label><Input className="mt-1 bg-white" value={recipe.course_name} onChange={(event) => updateLinkedRecipe(index, { course_name: event.target.value })} /><p className="mt-1 text-xs text-slate-500">{recipe.recipe_name} · {formatNumber(recipe.preview_portions)} portions · {recipe.item_cost === null ? 'cost incomplete' : `${formatCurrency(recipe.item_cost)} each / ${formatCurrency(recipe.preview_line_cost)} line`}</p></div><div><Label>Per guest</Label><Input type="number" min="0.01" step="0.01" className="mt-1 bg-white" value={recipe.portion_requirement} onChange={(event) => updateLinkedRecipe(index, { portion_requirement: number(event.target.value, 1) })} /></div><div><Label>Meal</Label><Select value={recipe.meal_period} onValueChange={(value) => updateLinkedRecipe(index, { meal_period: value })}><SelectTrigger className="mt-1 bg-white"><SelectValue /></SelectTrigger><SelectContent>{MEAL_PERIODS.map((item) => <SelectItem key={item} value={item}>{label(item)}</SelectItem>)}</SelectContent></Select></div><div><Label>Kitchen station</Label><Input className="mt-1 bg-white" value={recipe.kitchen_station} onChange={(event) => updateLinkedRecipe(index, { kitchen_station: event.target.value })} /></div><Button type="button" variant="ghost" size="icon" className="self-center text-rose-600" onClick={() => setFormData((current) => ({ ...current, linked_recipes: current.linked_recipes.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 className="h-4 w-4" /></Button></div>)}</div>
                {formData.linked_recipes.length > 0 && <div className={`mt-4 grid gap-3 rounded-xl border p-4 sm:grid-cols-3 ${formPreviewTotal !== null && number(formData.event_budget) > 0 && formPreviewTotal > number(formData.event_budget) ? 'border-rose-200 bg-rose-50' : 'border-teal-200 bg-teal-50'}`}><div><p className="text-xs uppercase text-slate-500">Live event cost</p><p className="font-bold text-slate-900">{formPreviewTotal === null ? 'Complete recipe costs first' : formatCurrency(formPreviewTotal)}</p></div><div><p className="text-xs uppercase text-slate-500">Cost per guest</p><p className="font-bold text-slate-900">{formPreviewTotal === null || number(formData.expected_participants) <= 0 ? '—' : formatCurrency(formPreviewTotal / number(formData.expected_participants))}</p></div><div><p className="text-xs uppercase text-slate-500">Budget variance</p><p className={`font-bold ${formPreviewTotal !== null && formPreviewTotal > number(formData.event_budget) ? 'text-rose-700' : 'text-emerald-700'}`}>{formPreviewTotal === null ? '—' : formatCurrency(number(formData.event_budget) - formPreviewTotal)}</p></div></div>}
              </section>

              <div><Label>Plan notes</Label><Textarea className="mt-1" rows={3} value={formData.notes} onChange={(event) => setFormData({ ...formData, notes: event.target.value })} /></div>
              <DialogFooter><Button type="button" variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button><Button type="submit" className="bg-teal-700 hover:bg-teal-800" disabled={saveMutation.isPending || !formData.linked_recipes.length}>{saveMutation.isPending ? 'Saving & costing…' : 'Save Linked Event Plan'}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(approval)} onOpenChange={() => setApproval(null)}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>{approval === 'approve' ? 'Approve Event Plan' : 'Reject Event Plan'}</DialogTitle></DialogHeader><div className="space-y-4"><p className="text-sm text-slate-600">{approval === 'approve' ? 'Confirm the linked menu, current cost, budget, production, and procurement details.' : 'Provide a reason so the planner can correct the event.'}</p><Textarea rows={4} value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder={approval === 'reject' ? 'Rejection reason (required)' : 'Approval note (optional)'} /><DialogFooter><Button variant="outline" onClick={() => setApproval(null)}>Cancel</Button><Button className={approval === 'approve' ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-rose-700 hover:bg-rose-800'} disabled={decisionMutation.isPending || (approval === 'reject' && !approvalNote.trim())} onClick={() => decisionMutation.mutate({ event: selected, type: approval, note: approvalNote })}>{approval === 'approve' ? 'Approve Event' : 'Reject Event'}</Button></DialogFooter></div></DialogContent></Dialog>
      </div>
    </div>
  );
}
