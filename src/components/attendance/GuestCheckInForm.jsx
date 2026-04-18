import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, QrCode, User } from 'lucide-react';
import { format } from 'date-fns';

export default function GuestCheckInForm() {
  const [idNumber, setIdNumber] = useState('');
  const [mealType, setMealType] = useState('');
  const [category, setCategory] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const queryClient = useQueryClient();

  const submitMutation = useMutation({
    mutationFn: () =>
      base44.entities.AttendanceRecord.create({
        session_id: `GUEST-${format(new Date(), 'yyyy-MM-dd')}`,
        session_name: `Guest Self Check-In — ${format(new Date(), 'dd MMM yyyy')}`,
        session_date: format(new Date(), 'yyyy-MM-dd'),
        meal_type: mealType,
        attendee_id: idNumber,
        attendee_name: idNumber,
        category: category,
        marked_at: new Date().toISOString(),
        scan_method: 'manual'
      }),
    onSuccess: () => {
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!idNumber || !mealType || !category) return;
    submitMutation.mutate();
  };

  const handleReset = () => {
    setIdNumber('');
    setMealType('');
    setCategory('');
    setSubmitted(false);
  };

  if (submitted) {
    return (
      <div className="max-w-md mx-auto mt-12 text-center">
        <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-10 h-10 text-emerald-600" />
        </div>
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Check-In Successful!</h2>
        <p className="text-slate-500 mb-6">Your meal attendance has been recorded.</p>
        <div className="bg-slate-50 rounded-xl p-4 mb-6 text-left space-y-2">
          <p className="text-sm"><span className="text-slate-500">ID:</span> <span className="font-semibold">{idNumber}</span></p>
          <p className="text-sm capitalize"><span className="text-slate-500">Meal:</span> <span className="font-semibold">{mealType}</span></p>
          <p className="text-sm capitalize"><span className="text-slate-500">Category:</span> <span className="font-semibold">{category}</span></p>
        </div>
        <Button onClick={handleReset} className="bg-emerald-600 hover:bg-emerald-700 w-full">
          New Check-In
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-6">
      <div className="text-center mb-6">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
          <QrCode className="w-8 h-8 text-emerald-600" />
        </div>
        <h2 className="text-xl font-bold text-slate-800">Meal Check-In</h2>
        <p className="text-slate-500 text-sm mt-1">Fill in your details to register your meal</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <Label htmlFor="id" className="text-sm font-medium text-slate-700 mb-1.5 block">
                ID Number <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  id="id"
                  value={idNumber}
                  onChange={e => setIdNumber(e.target.value)}
                  placeholder="Enter your ID number"
                  className="pl-9"
                  required
                />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">
                Meal Type <span className="text-red-500">*</span>
              </Label>
              <Select value={mealType} onValueChange={setMealType} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select meal…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="breakfast">🌅 Breakfast</SelectItem>
                  <SelectItem value="lunch">☀️ Lunch</SelectItem>
                  <SelectItem value="dinner">🌙 Dinner</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-sm font-medium text-slate-700 mb-1.5 block">
                Category <span className="text-red-500">*</span>
              </Label>
              <Select value={category} onValueChange={setCategory} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select your category…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="labor">👷 Labor</SelectItem>
                  <SelectItem value="junior">🎓 Junior</SelectItem>
                  <SelectItem value="senior">⭐ Senior</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-700 h-11 text-base"
              disabled={!idNumber || !mealType || !category || submitMutation.isPending}
            >
              {submitMutation.isPending ? 'Submitting…' : 'Check In'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}