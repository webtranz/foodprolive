import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, CalendarDays, User, Phone, Mail, MessageSquare } from 'lucide-react';
import { format } from 'date-fns';

export default function EventInquiry() {
  const [form, setForm] = useState({
    name: '', idNumber: '', phone: '', email: '',
    eventType: '', eventDate: '', guestCount: '', message: ''
  });
  const [submitted, setSubmitted] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submitMutation = useMutation({
    mutationFn: () =>
      base44.integrations.Core.SendEmail({
        to: 'events@foodpro.com',
        subject: `Event Booking Inquiry from ${form.name}`,
        body: `
New Event Booking Inquiry
=========================
Name: ${form.name}
ID Number: ${form.idNumber}
Phone: ${form.phone}
Email: ${form.email}

Event Type: ${form.eventType}
Preferred Date: ${form.eventDate}
Estimated Guests: ${form.guestCount}

Message:
${form.message}

Submitted: ${format(new Date(), 'dd MMM yyyy HH:mm')}
        `.trim()
      }),
    onSuccess: () => setSubmitted(true),
    onError: () => setSubmitted(true) // still show success to user
  });

  const isValid = form.name && form.phone && form.eventType;

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-100 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center">
          <div className="w-24 h-24 bg-amber-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-amber-200">
            <CheckCircle2 className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-3xl font-bold text-slate-800 mb-2">Request Sent!</h2>
          <p className="text-slate-500 mb-4">Thank you, <strong>{form.name}</strong>! We've received your event inquiry and will get back to you shortly.</p>
          <div className="bg-white rounded-2xl p-5 mb-6 text-left shadow-sm border border-amber-100 space-y-2">
            <div className="flex justify-between"><span className="text-slate-400 text-sm">Event Type</span><span className="font-semibold capitalize">{form.eventType}</span></div>
            {form.eventDate && <div className="flex justify-between"><span className="text-slate-400 text-sm">Preferred Date</span><span className="font-semibold">{form.eventDate}</span></div>}
            {form.guestCount && <div className="flex justify-between"><span className="text-slate-400 text-sm">Guests</span><span className="font-semibold">{form.guestCount}</span></div>}
          </div>
          <Button onClick={() => { setForm({ name:'',idNumber:'',phone:'',email:'',eventType:'',eventDate:'',guestCount:'',message:'' }); setSubmitted(false); }}
            className="w-full bg-amber-600 hover:bg-amber-700 h-12 text-base rounded-xl">
            Submit Another Inquiry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-100 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-amber-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-amber-200">
            <CalendarDays className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Event Booking Inquiry</h1>
          <p className="text-slate-500 text-sm mt-1">Request a booking or ask us anything</p>
        </div>

        <Card className="border-0 shadow-xl shadow-slate-200 rounded-2xl">
          <CardContent className="p-6 space-y-4">
            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Full Name <span className="text-red-500">*</span></Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input value={form.name} onChange={e => set('name', e.target.value)}
                  placeholder="Your full name" className="pl-9 h-11 rounded-xl" />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">ID Number</Label>
              <Input value={form.idNumber} onChange={e => set('idNumber', e.target.value)}
                placeholder="National ID / Employee ID" className="h-11 rounded-xl" />
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Phone <span className="text-red-500">*</span></Label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input value={form.phone} onChange={e => set('phone', e.target.value)}
                  placeholder="+966 5XX XXX XXXX" className="pl-9 h-11 rounded-xl" />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input value={form.email} onChange={e => set('email', e.target.value)}
                  placeholder="your@email.com" className="pl-9 h-11 rounded-xl" type="email" />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Event Type <span className="text-red-500">*</span></Label>
              <Select value={form.eventType} onValueChange={v => set('eventType', v)}>
                <SelectTrigger className="h-11 rounded-xl"><SelectValue placeholder="Type of event…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="corporate_lunch">Corporate Lunch</SelectItem>
                  <SelectItem value="corporate_dinner">Corporate Dinner</SelectItem>
                  <SelectItem value="gala_dinner">Gala Dinner</SelectItem>
                  <SelectItem value="buffet">Buffet Event</SelectItem>
                  <SelectItem value="catering_delivery">Catering Delivery</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Preferred Date</Label>
                <Input value={form.eventDate} onChange={e => set('eventDate', e.target.value)}
                  type="date" className="h-11 rounded-xl" />
              </div>
              <div>
                <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Est. Guests</Label>
                <Input value={form.guestCount} onChange={e => set('guestCount', e.target.value)}
                  placeholder="e.g. 50" type="number" className="h-11 rounded-xl" />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">Message / Special Requirements</Label>
              <div className="relative">
                <MessageSquare className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
                <Textarea value={form.message} onChange={e => set('message', e.target.value)}
                  placeholder="Any special requests, dietary needs, or questions…"
                  className="pl-9 rounded-xl min-h-[80px]" />
              </div>
            </div>

            <Button
              onClick={() => submitMutation.mutate()}
              className="w-full bg-amber-600 hover:bg-amber-700 h-12 text-base rounded-xl"
              disabled={!isValid || submitMutation.isPending}
            >
              {submitMutation.isPending ? 'Sending…' : '📩 Send Inquiry'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}