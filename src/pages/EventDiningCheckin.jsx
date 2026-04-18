import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, PartyPopper, User } from 'lucide-react';
import { format } from 'date-fns';

export default function EventDiningCheckin() {
  const [idNumber, setIdNumber] = useState('');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [category, setCategory] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const queryClient = useQueryClient();

  const { data: allEvents = [] } = useQuery({
    queryKey: ['diningHallEvents'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 50)
  });

  const events = allEvents.filter(e => e.event_name && e.service_style === 'dining_hall');
  const selectedEvent = events.find(e => e.id === selectedEventId);

  const submitMutation = useMutation({
    mutationFn: () =>
      base44.entities.DinerScan.create({
        event_id: selectedEventId,
        event_name: selectedEvent?.event_name || '',
        event_qr_token: selectedEvent?.qr_token || '',
        site_id: selectedEvent?.site_id || '',
        site_name: selectedEvent?.site_name || '',
        plan_date: selectedEvent?.plan_date || format(new Date(), 'yyyy-MM-dd'),
        meal_type: selectedEvent?.meals?.[0]?.meal_type || 'dinner',
        scanned_at: new Date().toISOString(),
        guest_token: `${idNumber}-${selectedEventId}-${Date.now()}`,
        scan_method: 'qr_scan'
      }),
    onSuccess: () => {
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ['dinerScans'] });
    }
  });

  const handleReset = () => {
    setIdNumber(''); setSelectedEventId(''); setCategory(''); setSubmitted(false);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-purple-100 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center">
          <div className="w-24 h-24 bg-violet-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-violet-200">
            <CheckCircle2 className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-3xl font-bold text-slate-800 mb-2">Enjoy the Event!</h2>
          <p className="text-slate-500 mb-6">You're checked in. Welcome to the dining experience.</p>
          <div className="bg-white rounded-2xl p-5 mb-6 text-left shadow-sm space-y-3 border border-violet-100">
            <div className="flex justify-between"><span className="text-slate-400 text-sm">ID Number</span><span className="font-semibold">{idNumber}</span></div>
            <div className="flex justify-between"><span className="text-slate-400 text-sm">Event</span><span className="font-semibold">{selectedEvent?.event_name}</span></div>
            <div className="flex justify-between"><span className="text-slate-400 text-sm">Category</span><span className="font-semibold capitalize">{category}</span></div>
          </div>
          <Button onClick={handleReset} className="w-full bg-violet-600 hover:bg-violet-700 h-12 text-base rounded-xl">
            New Check-In
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-purple-100 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-violet-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-violet-200">
            <PartyPopper className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Event Dining Check-In</h1>
          <p className="text-slate-500 text-sm mt-1">Select your event and check in</p>
        </div>

        <Card className="border-0 shadow-xl shadow-slate-200 rounded-2xl">
          <CardContent className="p-6 space-y-5">
            <div>
              <Label className="text-sm font-medium text-slate-700 mb-2 block">ID Number <span className="text-red-500">*</span></Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input value={idNumber} onChange={e => setIdNumber(e.target.value)}
                  placeholder="Enter your ID number" className="pl-9 h-11 rounded-xl" />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-2 block">Select Event <span className="text-red-500">*</span></Label>
              <Select value={selectedEventId} onValueChange={setSelectedEventId}>
                <SelectTrigger className="h-11 rounded-xl"><SelectValue placeholder="Choose your event…" /></SelectTrigger>
                <SelectContent>
                  {events.length === 0 && <SelectItem value="_none" disabled>No dining events available</SelectItem>}
                  {events.map(e => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.event_name} {e.plan_date ? `— ${e.plan_date}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-2 block">Category <span className="text-red-500">*</span></Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-11 rounded-xl"><SelectValue placeholder="Select your category…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="labor">👷 Labor</SelectItem>
                  <SelectItem value="junior">🎓 Junior</SelectItem>
                  <SelectItem value="senior">⭐ Senior</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={() => submitMutation.mutate()}
              className="w-full bg-violet-600 hover:bg-violet-700 h-12 text-base rounded-xl"
              disabled={!idNumber || !selectedEventId || !category || submitMutation.isPending}
            >
              {submitMutation.isPending ? 'Submitting…' : '✓ Check In to Event'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}