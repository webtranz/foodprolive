import React, { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, XCircle, QrCode, AlertTriangle } from 'lucide-react';
import jsQR from 'jsqr';
import { getDinerScanHeadcount } from '@/lib/mealServiceAttendance';

export default function DiningScannerContent() {
  const [selectedEventId, setSelectedEventId] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const [manualToken, setManualToken] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const queryClient = useQueryClient();
  const { data: allEvents = [] } = useQuery({
    queryKey: ['eventPlans'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 100)
  });

  const todayEvents = allEvents.filter(e => e.event_name && e.service_style === 'dining_hall');
  const selectedEvent = allEvents.find(e => e.id === selectedEventId);

  const { data: scans = [] } = useQuery({
    queryKey: ['dinerScans', selectedEventId],
    queryFn: () => base44.entities.DinerScan.filter({ event_id: selectedEventId }),
    enabled: !!selectedEventId,
    refetchInterval: 5000
  });

  const scanMutation = useMutation({
    mutationFn: async (token) => {
      if (!selectedEvent?.qr_token) throw new Error('no_token');
      if (token !== selectedEvent.qr_token && !token.startsWith(selectedEvent.qr_token)) throw new Error('invalid');
      const isDuplicate = scans.some(s => s.guest_token === token);
      if (isDuplicate) throw new Error('duplicate');
      return base44.entities.DinerScan.create({
        event_id: selectedEventId,
        event_name: selectedEvent.event_name,
        event_qr_token: selectedEvent.qr_token,
        site_id: selectedEvent.site_id,
        site_name: selectedEvent.site_name,
        plan_date: selectedEvent.plan_date,
        meal_type: selectedEvent.meals?.[0]?.meal_type || '',
        scanned_at: new Date().toISOString(),
        guest_token: token,
        scan_method: 'qr_scan'
      });
    },
    onSuccess: () => { setScanResult('success'); queryClient.invalidateQueries({ queryKey: ['dinerScans'] }); setTimeout(() => setScanResult(null), 2000); },
    onError: (err) => { setScanResult(err.message === 'duplicate' ? 'duplicate' : 'invalid'); setTimeout(() => setScanResult(null), 2500); }
  });

  const manualMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEvent) return;
      const isDuplicate = scans.some(s => s.guest_token === manualToken);
      if (isDuplicate) throw new Error('duplicate');
      return base44.entities.DinerScan.create({
        event_id: selectedEventId,
        event_name: selectedEvent.event_name,
        event_qr_token: selectedEvent.qr_token || '',
        site_id: selectedEvent.site_id,
        site_name: selectedEvent.site_name,
        plan_date: selectedEvent.plan_date,
        meal_type: selectedEvent.meals?.[0]?.meal_type || '',
        scanned_at: new Date().toISOString(),
        guest_token: manualToken || `MANUAL-${Date.now()}`,
        scan_method: 'manual'
      });
    },
    onSuccess: () => { setScanResult('success'); setManualToken(''); queryClient.invalidateQueries({ queryKey: ['dinerScans'] }); setTimeout(() => setScanResult(null), 2000); },
    onError: (err) => { setScanResult(err.message === 'duplicate' ? 'duplicate' : 'invalid'); setTimeout(() => setScanResult(null), 2500); }
  });

  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    streamRef.current = stream;
    if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
    setCameraActive(true);
    scanIntervalRef.current = setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== 4) return;
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) scanMutation.mutate(code.data);
    }, 400);
  };

  const stopCamera = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    setCameraActive(false);
  };

  useEffect(() => () => stopCamera(), []);

  const planned = selectedEvent ? (selectedEvent.total_expected_servings || 0) : 0;
  const actual = getDinerScanHeadcount(scans);
  const rate = planned > 0 ? Math.round((actual / planned) * 100) : 0;
  const noShows = Math.max(0, planned - actual);
  const wasteKg = ((noShows * (selectedEvent?.consumption_per_person_g || 550)) / 1000).toFixed(1);

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {/* Event Selector */}
      <Card>
        <CardContent className="p-4">
          <label className="text-slate-700 text-sm font-medium block mb-2">Select Today's Dining Hall Event</label>
          <Select value={selectedEventId} onValueChange={setSelectedEventId}>
            <SelectTrigger><SelectValue placeholder="Choose event…" /></SelectTrigger>
            <SelectContent>
              {todayEvents.length === 0 && <SelectItem value="_none" disabled>No dining hall events today</SelectItem>}
              {todayEvents.map(e => <SelectItem key={e.id} value={e.id}>{e.event_name} — {e.site_name}</SelectItem>)}
            </SelectContent>
          </Select>
          {todayEvents.length === 0 && (
            <p className="text-amber-600 text-xs mt-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Create a "Dining Hall" event in Event Planning first
            </p>
          )}
        </CardContent>
      </Card>

      {selectedEvent && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-slate-700">{planned}</p><p className="text-xs text-slate-400 mt-1">Planned</p></CardContent></Card>
            <Card className="bg-emerald-50 border-emerald-200"><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-emerald-600">{actual}</p><p className="text-xs text-emerald-500 mt-1">Scanned In</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-amber-500">{rate}%</p><p className="text-xs text-slate-400 mt-1">Attendance</p></CardContent></Card>
          </div>

          {noShows > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0" />
              <div>
                <p className="text-orange-700 text-sm font-medium">Est. Waste: {wasteKg} kg</p>
                <p className="text-orange-500 text-xs">{noShows} no-shows × {selectedEvent.consumption_per_person_g || 550}g/person</p>
              </div>
            </div>
          )}

          {/* Feedback */}
          {scanResult && (
            <div className={`rounded-xl p-4 flex items-center justify-center gap-3 text-lg font-bold ${
              scanResult === 'success' ? 'bg-emerald-500 text-white' :
              scanResult === 'duplicate' ? 'bg-amber-500 text-white' : 'bg-red-500 text-white'
            }`}>
              {scanResult === 'success' && <><CheckCircle2 className="w-6 h-6" /> Guest Checked In!</>}
              {scanResult === 'duplicate' && <><AlertTriangle className="w-6 h-6" /> Already Scanned</>}
              {scanResult === 'invalid' && <><XCircle className="w-6 h-6" /> Invalid QR Code</>}
            </div>
          )}

          {/* Camera */}
          <Card>
            <CardContent className="p-4">
              <div className="relative bg-black rounded-lg overflow-hidden" style={{ minHeight: cameraActive ? 240 : 0 }}>
                <video ref={videoRef} className={`w-full ${cameraActive ? 'block' : 'hidden'}`} muted playsInline />
                <canvas ref={canvasRef} className="hidden" />
                {cameraActive && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-48 h-48 border-2 border-emerald-400 rounded-xl opacity-70" />
                  </div>
                )}
              </div>
              {!cameraActive ? (
                <Button onClick={startCamera} className="w-full bg-emerald-600 hover:bg-emerald-700 mt-2">
                  <QrCode className="w-4 h-4 mr-2" /> Start Camera Scanner
                </Button>
              ) : (
                <Button onClick={stopCamera} variant="outline" className="w-full mt-2">Stop Camera</Button>
              )}
            </CardContent>
          </Card>

          {/* Manual */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-600">Manual Check-In</CardTitle></CardHeader>
            <CardContent className="pt-0">
              <div className="flex gap-2">
                <Input value={manualToken} onChange={e => setManualToken(e.target.value)} placeholder="Guest ID or token…"
                  onKeyDown={e => e.key === 'Enter' && manualMutation.mutate()} />
                <Button onClick={() => manualMutation.mutate()} className="bg-blue-600 hover:bg-blue-700" disabled={!manualToken || manualMutation.isPending}>
                  <CheckCircle2 className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Progress */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex justify-between text-sm text-slate-500 mb-2">
              <span>Attendance Progress</span><span>{actual} / {planned}</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-3">
              <div className="h-3 rounded-full transition-all duration-500 bg-emerald-500"
                style={{ width: `${Math.min(100, rate)}%` }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
