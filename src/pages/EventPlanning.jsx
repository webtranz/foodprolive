import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Calendar, Users, Scale, ChefHat, Download, QrCode, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { QRCodeSVG } from 'qrcode.react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { downloadCSV } from '../components/utils/exportData';

const SERVICE_STYLES = ['buffet', 'packed_meal', 'dining_hall'];
const AUDIENCE_PROFILES = ['adult', 'mixed', 'high_appetite'];
const DEFAULT_CONSUMPTION_G = 550;

const initialForm = {
  event_name: '',
  site_id: '',
  date: format(new Date(), 'yyyy-MM-dd'),
  meal_types: [],
  covers: '',
  event_duration_hours: '1',
  audience_profile: 'adult',
  service_style: 'buffet',
  consumption_per_person_g: DEFAULT_CONSUMPTION_G,
  buffer_percent: 10,
  notes: ''
};

export default function EventPlanning() {
  const [formOpen, setFormOpen] = useState(false);
  const [formData, setFormData] = useState(initialForm);
  const [qrEvent, setQrEvent] = useState(null);
  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: events = [], isLoading } = useQuery({ queryKey: ['eventPlans'], queryFn: () => base44.entities.MenuPlan.list('-plan_date', 200) });

  // Filter only event plans (those with event_name)
  const eventPlans = events.filter(e => e.event_name);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.MenuPlan.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['eventPlans'] });
      queryClient.invalidateQueries({ queryKey: ['menuPlans'] });
      setFormOpen(false);
      setFormData(initialForm);
    }
  });

  const toggleMealType = (type) => {
    setFormData(prev => ({
      ...prev,
      meal_types: prev.meal_types.includes(type)
        ? prev.meal_types.filter(t => t !== type)
        : [...prev.meal_types, type]
    }));
  };

  const covers = parseInt(formData.covers) || 0;
  const consumptionG = parseFloat(formData.consumption_per_person_g) || DEFAULT_CONSUMPTION_G;
  const buffer = parseFloat(formData.buffer_percent) || 10;
  const baseFoodKg = (covers * consumptionG) / 1000;
  const finalFoodKg = baseFoodKg * (1 + buffer / 100);

  const handleSubmit = (e) => {
    e.preventDefault();
    const site = sites.find(s => s.id === formData.site_id);
    const qrToken = `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const mealTypes = formData.meal_types.length > 0 ? formData.meal_types : ['lunch'];
    createMutation.mutate({
      event_name: formData.event_name,
      site_id: formData.site_id || 'no-site',
      site_name: site?.name || '',
      plan_date: formData.date,
      qr_token: qrToken,
      meals: mealTypes.map(type => ({
        meal_type: type,
        recipe_id: '',
        recipe_name: '',
        expected_servings: covers,
        calories_per_serving: 0
      })),
      total_expected_servings: covers,
      total_calories: 0,
      status: 'draft',
      audience_profile: formData.audience_profile,
      service_style: formData.service_style,
      event_duration_hours: parseFloat(formData.event_duration_hours),
      consumption_per_person_g: consumptionG,
      buffer_percent: buffer,
      total_food_kg: finalFoodKg,
      notes: formData.notes
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader title="Event & Meal Planning" description="Plan events, calculate food requirements, and manage catering production">
          <Button variant="outline" onClick={() => downloadCSV(eventPlans, 'event_plans')}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setFormOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> New Event Plan
          </Button>
        </PageHeader>

        {/* Event List */}
        {eventPlans.length === 0 ? (
          <Card className="border-slate-100 shadow-sm">
            <CardContent className="p-16 text-center">
              <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-700 mb-2">No Events Planned</h3>
              <p className="text-slate-500 mb-6">Create your first event plan to get food requirement calculations</p>
              <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setFormOpen(true)}>
                <Plus className="w-4 h-4 mr-2" /> Create Event Plan
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {eventPlans.map(event => {
              const foodKg = event.total_food_kg || 0;
              const covers = event.total_expected_servings || 0;
              const isDiningHall = event.service_style === 'dining_hall';
              return (
                <Card key={event.id} className="border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                  <CardContent className="p-6">
                    <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                      <div className="flex items-start gap-4">
                        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                          <ChefHat className="w-6 h-6 text-blue-600" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-slate-900 text-lg">{event.event_name}</h3>
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            <Badge className="bg-blue-100 text-blue-700">{event.plan_date}</Badge>
                            <Badge variant="outline">{event.site_name}</Badge>
                            {event.service_style && <Badge variant="outline" className="capitalize">{event.service_style?.replace(/_/g, ' ')}</Badge>}
                            {event.status && <Badge className="bg-slate-100 text-slate-700 capitalize">{event.status}</Badge>}
                          </div>
                          {event.meals && event.meals.length > 0 && (
                            <div className="flex gap-1 mt-2">
                              {[...new Set(event.meals.map(m => m.meal_type))].map(type => (
                                <Badge key={type} className="bg-emerald-100 text-emerald-700 capitalize text-xs">{type}</Badge>
                              ))}
                            </div>
                          )}
                          {isDiningHall && event.qr_token && (
                            <div className="flex gap-2 mt-3">
                              <Button size="sm" variant="outline" className="text-xs" onClick={() => setQrEvent(event)}>
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
                      <div className="grid grid-cols-3 gap-4 text-center">
                        <div>
                          <p className="text-2xl font-bold text-slate-900">{Math.round(covers)}</p>
                          <p className="text-xs text-slate-500 flex items-center justify-center gap-1"><Users className="w-3 h-3" /> Covers</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-emerald-600">{foodKg.toFixed(1)}</p>
                          <p className="text-xs text-slate-500 flex items-center justify-center gap-1"><Scale className="w-3 h-3" /> Total kg</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-orange-600">{event.buffer_percent || 10}%</p>
                          <p className="text-xs text-slate-500">Buffer</p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* QR Code Dialog */}
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
                  <p className="text-sm text-slate-500">{qrEvent.site_name} · {qrEvent.plan_date}</p>
                  <p className="text-xs text-slate-400 mt-2 font-mono bg-slate-50 px-3 py-1 rounded">{qrEvent.qr_token}</p>
                </div>
                <p className="text-xs text-slate-500">Staff scan this QR at the dining hall entrance to check guests in via the Scanner page.</p>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* New Event Dialog */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ChefHat className="w-5 h-5 text-emerald-600" /> Plan New Event
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label>Event Name *</Label>
                  <Input value={formData.event_name} onChange={e => setFormData({ ...formData, event_name: e.target.value })} placeholder="e.g. Ramadan Iftar Dinner" className="mt-1" required />
                </div>
                <div>
                  <Label>Site / Camp *</Label>
                  <Select value={formData.site_id} onValueChange={v => setFormData({ ...formData, site_id: v })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select site" /></SelectTrigger>
                    <SelectContent>
                      {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Event Date *</Label>
                  <Input type="date" value={formData.date} onChange={e => setFormData({ ...formData, date: e.target.value })} className="mt-1" required />
                </div>
                <div>
                  <Label>Number of Covers (Guests) *</Label>
                  <Input type="number" min="1" value={formData.covers} onChange={e => setFormData({ ...formData, covers: e.target.value })} placeholder="e.g. 500" className="mt-1" required />
                </div>
                <div>
                  <Label>Duration (hours)</Label>
                  <Input type="number" min="0.5" step="0.5" value={formData.event_duration_hours} onChange={e => setFormData({ ...formData, event_duration_hours: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label>Audience Profile</Label>
                  <Select value={formData.audience_profile} onValueChange={v => setFormData({ ...formData, audience_profile: v })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="adult">Adult</SelectItem>
                      <SelectItem value="mixed">Mixed</SelectItem>
                      <SelectItem value="high_appetite">High Appetite</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Service Style</Label>
                  <Select value={formData.service_style} onValueChange={v => setFormData({ ...formData, service_style: v })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buffet">Buffet</SelectItem>
                      <SelectItem value="packed_meal">Packed Meal</SelectItem>
                      <SelectItem value="dining_hall">Dining Hall</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Meal Types */}
              <div>
                <Label className="mb-2 block">Meal Types Included</Label>
                <div className="flex flex-wrap gap-2">
                  {['breakfast', 'lunch', 'dinner', 'snack'].map(type => (
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

              {/* Food Calculation */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Consumption per person (g)</Label>
                  <Input type="number" value={formData.consumption_per_person_g} onChange={e => setFormData({ ...formData, consumption_per_person_g: e.target.value })} className="mt-1" />
                  <p className="text-xs text-slate-500 mt-1">Default: 550g/person</p>
                </div>
                <div>
                  <Label>Buffer % (safety stock)</Label>
                  <Input type="number" min="0" max="50" value={formData.buffer_percent} onChange={e => setFormData({ ...formData, buffer_percent: e.target.value })} className="mt-1" />
                </div>
              </div>

              {/* Live Calculation Preview */}
              {covers > 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <h4 className="font-semibold text-emerald-900 mb-3 flex items-center gap-2">
                    <Scale className="w-4 h-4" /> Auto-Calculated Food Requirements
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
                  <p className="text-xs text-emerald-700 mt-2 text-center">
                    Formula: {covers} guests × {consumptionG}g = {baseFoodKg.toFixed(1)} kg × {(1 + buffer/100).toFixed(2)} = {finalFoodKg.toFixed(1)} kg
                  </p>
                </div>
              )}

              <div>
                <Label>Notes</Label>
                <Textarea value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} className="mt-1" rows={2} placeholder="Special requirements, dietary restrictions..." />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setFormOpen(false); setFormData(initialForm); }}>Cancel</Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating...' : 'Create Event Plan'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}