import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Utensils, XCircle } from 'lucide-react';
import { toBusinessDateTimeParts } from '../../shared/businessDate.js';

const MEALS = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' }
];

function currentDateAndTime() {
  const now = new Date();
  return toBusinessDateTimeParts(now) || {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16)
  };
}

function isMealActive(window) {
  if (!window?.start_time || !window?.end_time) return false;
  const { time } = currentDateAndTime();
  return time >= window.start_time && time <= window.end_time;
}

async function publicRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export default function EmployeeMealQRScan() {
  const [token, setToken] = useState('');
  const [qr, setQr] = useState(null);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [submittingMeal, setSubmittingMeal] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qrToken = params.get('token') || '';
    setToken(qrToken);
    if (!qrToken) {
      setStatus('error');
      setMessage('QR token is missing.');
      return;
    }
    publicRequest(`/api/staff-meal-qr/public/${encodeURIComponent(qrToken)}`)
      .then((payload) => {
        setQr(payload);
        setStatus('ready');
      })
      .catch((error) => {
        setStatus('error');
        setMessage(error.message || 'QR code could not be loaded.');
      });
  }, []);

  const scanKeys = useMemo(() => {
    return new Set((qr?.scan_history || []).map((scan) => scan.scan_key || `${scan.session_date}:${scan.meal_type}`));
  }, [qr]);

  const hasScannedMeal = (mealType) => {
    const { date } = currentDateAndTime();
    return scanKeys.has(`${date}:${mealType}`);
  };

  const submitScan = async (mealType) => {
    setSubmittingMeal(mealType);
    setMessage('');
    try {
      const result = await publicRequest(`/api/staff-meal-qr/public/${encodeURIComponent(token)}/scan`, {
        method: 'POST',
        body: JSON.stringify({ meal_type: mealType })
      });
      setQr(result.qr);
      setStatus('success');
      setMessage(result.message || 'Attendance recorded.');
    } catch (error) {
      setStatus('ready');
      setMessage(error.message || 'Attendance could not be recorded.');
    } finally {
      setSubmittingMeal('');
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" />
        Loading QR...
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
        <Card className="w-full max-w-md border-red-200">
          <CardContent className="p-8 text-center">
            <XCircle className="mx-auto h-14 w-14 text-red-500" />
            <h1 className="mt-4 text-2xl font-bold text-slate-900">QR Not Available</h1>
            <p className="mt-2 text-sm text-slate-600">{message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-white">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center space-y-4">
        <div className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500">
            <Utensils className="h-8 w-8" />
          </div>
          <h1 className="mt-4 text-2xl font-bold">Employee Meal Scan</h1>
          <p className="mt-1 text-sm text-white/60">One scan is allowed for each meal per day.</p>
        </div>

        <Card className="border-slate-800 bg-white text-slate-900">
          <CardContent className="space-y-4 p-5">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-lg font-bold">{qr?.employee_name}</p>
              <p className="text-sm text-slate-500">Company ID: {qr?.company_id_number}</p>
            </div>

            {message && (
              <div className={`flex gap-2 rounded-xl border p-3 text-sm ${
                status === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}>
                {status === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                <span>{message}</span>
              </div>
            )}

            <div className="space-y-3">
              {MEALS.map((meal) => {
                const window = qr?.meal_windows?.[meal.value];
                const active = isMealActive(window);
                const alreadyScanned = hasScannedMeal(meal.value);
                return (
                  <div key={meal.value} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold">{meal.label}</p>
                        <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                          <Clock className="h-3.5 w-3.5" />
                          {window?.start_time || '--:--'} to {window?.end_time || '--:--'}
                        </p>
                      </div>
                      <Badge className={alreadyScanned ? 'bg-slate-100 text-slate-700' : active ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                        {alreadyScanned ? 'Used today' : active ? 'Open now' : 'Closed'}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      className="mt-3 w-full bg-emerald-600 hover:bg-emerald-700"
                      disabled={!active || alreadyScanned || Boolean(submittingMeal)}
                      onClick={() => submitScan(meal.value)}
                    >
                      {submittingMeal === meal.value ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                      Record {meal.label}
                    </Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
