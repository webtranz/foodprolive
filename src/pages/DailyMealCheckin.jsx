import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, Utensils, User } from 'lucide-react';
import { format } from 'date-fns';

export default function DailyMealCheckin() {
  const [idNumber, setIdNumber] = useState('');
  const [mealType, setMealType] = useState('');
  const [category, setCategory] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const queryClient = useQueryClient();

  const submitMutation = useMutation({
    mutationFn: () =>
      base44.entities.AttendanceRecord.create({
        session_id: `DAILY-${format(new Date(), 'yyyy-MM-dd')}`,
        session_name: `Daily Meal Check-In — ${format(new Date(), 'dd MMM yyyy')}`,
        session_date: format(new Date(), 'yyyy-MM-dd'),
        meal_type: mealType,
        attendee_id: idNumber,
        attendee_name: idNumber,
        category: category,
        marked_at: new Date().toISOString(),
        scan_method: 'qr_scan'
      }),
    onSuccess: () => {
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
    }
  });

  const handleReset = () => {
    setIdNumber(''); setMealType(''); setCategory(''); setSubmitted(false);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-100 flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center">
          <div className="w-24 h-24 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-200">
            <CheckCircle2 className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-3xl font-bold text-slate-800 mb-2">Checked In!</h2>
          <p className="text-slate-500 mb-6">Your meal attendance has been recorded successfully.</p>
          <div className="bg-white rounded-2xl p-5 mb-6 text-left shadow-sm space-y-3 border border-emerald-100">
            <div className="flex justify-between"><span className="text-slate-400 text-sm">ID Number</span><span className="font-semibold">{idNumber}</span></div>
            <div className="flex justify-between"><span className="text-slate-400 text-sm">Meal</span><span className="font-semibold capitalize">{mealType}</span></div>
            <div className="flex justify-between"><span className="text-slate-400 text-sm">Category</span><span className="font-semibold capitalize">{category}</span></div>
            <div className="flex justify-between"><span className="text-slate-400 text-sm">Date</span><span className="font-semibold">{format(new Date(), 'dd MMM yyyy')}</span></div>
          </div>
          <Button onClick={handleReset} className="w-full bg-emerald-600 hover:bg-emerald-700 h-12 text-base rounded-xl">
            New Check-In
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-100 flex items-center justify-center p-4">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-200">
            <Utensils className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Daily Meal Check-In</h1>
          <p className="text-slate-500 text-sm mt-1">{format(new Date(), 'EEEE, dd MMMM yyyy')}</p>
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
              <Label className="text-sm font-medium text-slate-700 mb-2 block">Meal Type <span className="text-red-500">*</span></Label>
              <Select value={mealType} onValueChange={setMealType}>
                <SelectTrigger className="h-11 rounded-xl"><SelectValue placeholder="Select meal…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="breakfast">🌅 Breakfast</SelectItem>
                  <SelectItem value="lunch">☀️ Lunch</SelectItem>
                  <SelectItem value="dinner">🌙 Dinner</SelectItem>
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
              className="w-full bg-emerald-600 hover:bg-emerald-700 h-12 text-base rounded-xl"
              disabled={!idNumber || !mealType || !category || submitMutation.isPending}
            >
              {submitMutation.isPending ? 'Submitting…' : '✓ Check In Now'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}