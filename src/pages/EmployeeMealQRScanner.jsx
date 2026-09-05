import React, { useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, Camera, CameraOff, CheckCircle2, Clock, Loader2, QrCode, XCircle } from 'lucide-react';
import { BUSINESS_TIME_ZONE } from '../../shared/businessDate.js';
import {
  getMenuCategoryOptions,
  MENU_CUISINE_OPTIONS
} from '../../shared/menuCategories.js';

const MEAL_PERIODS = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' }
];

function formatLabel(value) {
  return String(value || '-')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseScopeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    service_date: params.get('service_date') || '',
    site_id: params.get('site_id') || '',
    site_name: params.get('site_name') || '',
    menu_type: params.get('menu_type') || 'general',
    menu_category: params.get('menu_category') || 'senior',
    meal_type: params.get('meal_type') || 'lunch'
  };
}

function extractToken(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('token') || value;
  } catch {
    const tokenMatch = value.match(/[?&]token=([^&]+)/);
    return tokenMatch ? decodeURIComponent(tokenMatch[1]) : value;
  }
}

export default function EmployeeMealQRScanner() {
  const [scope] = useState(parseScopeFromUrl);
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [recentScans, setRecentScans] = useState([]);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const cooldownRef = useRef(false);
  const lastTokenRef = useRef('');

  const menuTypeLabel = useMemo(
    () => MENU_CUISINE_OPTIONS.find((option) => option.value === scope.menu_type)?.label || formatLabel(scope.menu_type),
    [scope.menu_type]
  );
  const menuCategoryLabel = useMemo(
    () => getMenuCategoryOptions(scope.menu_type).find((option) => option.value === scope.menu_category)?.label || formatLabel(scope.menu_category),
    [scope.menu_category, scope.menu_type]
  );
  const mealLabel = useMemo(
    () => MEAL_PERIODS.find((option) => option.value === scope.meal_type)?.label || formatLabel(scope.meal_type),
    [scope.meal_type]
  );
  const scopeComplete = Boolean(scope.service_date && scope.site_id && scope.menu_type && scope.menu_category && scope.meal_type);

  const stopCamera = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setPhase((current) => (current === 'scanning' ? 'idle' : current));
  };

  useEffect(() => () => stopCamera(), []);

  const handleScan = async (rawValue) => {
    if (cooldownRef.current || !scopeComplete) return;
    const token = extractToken(rawValue);
    if (!token || token === lastTokenRef.current) return;
    cooldownRef.current = true;
    lastTokenRef.current = token;
    setPhase('submitting');
    setMessage('');
    try {
      const result = await base44.staffMealQr.scan({
        token,
        service_date: scope.service_date,
        site_id: scope.site_id,
        menu_type: scope.menu_type,
        menu_category: scope.menu_category,
        meal_type: scope.meal_type
      });
      const attendance = result.attendance || {};
      setRecentScans((current) => [
        {
          id: `${attendance.id || token}-${Date.now()}`,
          employee: attendance.attendee_name || 'Employee',
          companyId: attendance.attendee_id || '',
          time: new Date().toLocaleTimeString(undefined, {
            timeZone: BUSINESS_TIME_ZONE,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          })
        },
        ...current
      ].slice(0, 8));
      setPhase('success');
      setMessage(result.message || 'Attendance recorded.');
      window.setTimeout(() => {
        cooldownRef.current = false;
        lastTokenRef.current = '';
        setPhase('scanning');
        setMessage('');
      }, 1800);
    } catch (error) {
      setPhase('error');
      setMessage(error.message || 'QR scan could not be recorded.');
      window.setTimeout(() => {
        cooldownRef.current = false;
        lastTokenRef.current = '';
        setPhase('scanning');
      }, 2500);
    }
  };

  const scanLoop = () => {
    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) handleScan(code.data);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const startCamera = async () => {
    if (!scopeComplete) {
      setPhase('error');
      setMessage('Date, project, menu type, menu category, and meal period are required before scanning.');
      return;
    }
    setPhase('starting');
    setMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase('scanning');
      scanLoop();
    } catch {
      setPhase('camera_denied');
      setMessage('Camera access is required to scan employee meal QR codes.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-white">
      <div className="mx-auto grid min-h-screen max-w-6xl content-center gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden border-slate-800 bg-slate-900 text-white">
          <CardHeader className="border-b border-white/10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <QrCode className="h-5 w-5 text-emerald-300" />
                  Employee Meal QR Scanner
                </CardTitle>
                <p className="mt-1 text-sm text-white/55">Scan employee QR images into the selected Food Consumption scope.</p>
              </div>
              <Badge className="bg-emerald-500/15 text-emerald-200">{mealLabel}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <ContextChip label="Date" value={scope.service_date || 'Not selected'} />
              <ContextChip label="Project" value={scope.site_name || scope.site_id || 'Not selected'} />
              <ContextChip label="Menu Type" value={menuTypeLabel} />
              <ContextChip label="Menu Category" value={menuCategoryLabel} />
              <ContextChip label="Meal Period" value={mealLabel} />
            </div>

            <div className="relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black">
              <video ref={videoRef} className={`h-full min-h-[420px] w-full object-cover ${phase === 'scanning' || phase === 'submitting' ? 'opacity-100' : 'opacity-30'}`} playsInline muted />
              <canvas ref={canvasRef} className="hidden" />
              {(phase === 'idle' || phase === 'starting' || phase === 'camera_denied') && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center">
                  {phase === 'starting' ? <Loader2 className="h-10 w-10 animate-spin text-white/70" /> : phase === 'camera_denied' ? <CameraOff className="h-12 w-12 text-red-300" /> : <Camera className="h-12 w-12 text-white/40" />}
                  <p className="max-w-sm text-sm text-white/65">{message || 'Start the camera and point it at the employee QR image.'}</p>
                  <Button type="button" className="bg-emerald-600 hover:bg-emerald-700" onClick={startCamera} disabled={phase === 'starting'}>
                    {phase === 'starting' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                    Start Scanner
                  </Button>
                </div>
              )}
              {phase === 'scanning' && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <div className="relative h-64 w-64">
                    <div className="absolute left-0 top-0 h-10 w-10 rounded-tl-xl border-l-4 border-t-4 border-emerald-300" />
                    <div className="absolute right-0 top-0 h-10 w-10 rounded-tr-xl border-r-4 border-t-4 border-emerald-300" />
                    <div className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-xl border-b-4 border-l-4 border-emerald-300" />
                    <div className="absolute bottom-0 right-0 h-10 w-10 rounded-br-xl border-b-4 border-r-4 border-emerald-300" />
                  </div>
                  <p className="mt-5 rounded-full bg-black/60 px-4 py-2 text-sm text-white/80">Present employee QR code</p>
                </div>
              )}
              {phase === 'submitting' && (
                <StatusOverlay tone="neutral" icon={<Loader2 className="h-14 w-14 animate-spin" />} text="Recording attendance..." />
              )}
              {phase === 'success' && (
                <StatusOverlay tone="success" icon={<CheckCircle2 className="h-16 w-16" />} text={message} />
              )}
              {phase === 'error' && (
                <StatusOverlay tone="error" icon={<XCircle className="h-16 w-16" />} text={message} />
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="border-white/20 bg-white/5 text-white hover:bg-white/10" onClick={startCamera}>
                <Camera className="mr-2 h-4 w-4" />
                Restart Camera
              </Button>
              <Button type="button" variant="outline" className="border-white/20 bg-white/5 text-white hover:bg-white/10" onClick={stopCamera}>
                <CameraOff className="mr-2 h-4 w-4" />
                Stop Camera
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-white text-slate-900">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="h-5 w-5 text-emerald-600" />
              Recent Scans
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentScans.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
                No employee QR scans recorded in this scanner session.
              </div>
            ) : (
              <div className="space-y-2">
                {recentScans.map((scan) => (
                  <div key={scan.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="font-semibold text-slate-900">{scan.employee}</p>
                    <p className="mt-1 text-xs text-slate-500">{scan.companyId} · {scan.time}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Each employee QR is accepted once for this meal period and date.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ContextChip({ label, value }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 truncate font-semibold text-white">{value}</p>
    </div>
  );
}

function StatusOverlay({ tone, icon, text }) {
  const toneClass = tone === 'success'
    ? 'bg-emerald-600/95 text-white'
    : tone === 'error'
      ? 'bg-red-950/95 text-red-100'
      : 'bg-slate-950/90 text-white';
  return (
    <div className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-6 text-center ${toneClass}`}>
      {icon}
      <p className="max-w-sm text-xl font-bold">{text}</p>
    </div>
  );
}
