import React, { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, XCircle, QrCode, Scan, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import jsQR from 'jsqr';
import { getDinerScanHeadcount } from '@/lib/mealServiceAttendance';

export default function DiningScanner() {
  const [selectedEventId, setSelectedEventId] = useState('');
  const [scanResult, setScanResult] = useState(null); // 'success' | 'duplicate' | 'invalid'
  const [manualToken, setManualToken] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const queryClient = useQueryClient();
  const { data: allEvents = [] } = useQuery({
    queryKey: ['eventPlans'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 100)
  });

  // Show all dining_hall events (not just today) so staff can select any active event
  const todayEvents = allEvents.filter(e => e.event_name && e.service_style === 'dining_hall');
  const selectedEvent = allEvents.find(e => e.id === selectedEventId);

  const { data: scans = [], refetch: refetchScans } = useQuery({
    queryKey: ['dinerScans', selectedEventId],
    queryFn: () => base44.entities.DinerScan.filter({ event_id: selectedEventId }),
    enabled: !!selectedEventId,
    refetchInterval: 5000
  });

  const scanMutation = useMutation({
    mutationFn: async (token) => {
      if (!selectedEvent?.qr_token) throw new Error('no_token');
      // Accept if scanned token matches event token exactly OR starts with it
      if (token !== selectedEvent.qr_token && !token.startsWith(selectedEvent.qr_token)) throw new Error('invalid');

      // Check for duplicate guest token
      const guestToken = token;
      const isDuplicate = scans.some(s => s.guest_token === guestToken);
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
        guest_token: guestToken,
        scan_method: 'qr_scan'
      });
    },
    onSuccess: () => {
      setScanResult('success');
      setScanCount(c => c + 1);
      queryClient.invalidateQueries({ queryKey: ['dinerScans'] });
      queryClient.invalidateQueries({ queryKey: ['eventPlans'] });
      setTimeout(() => setScanResult(null), 2000);
    },
    onError: (err) => {
      if (err.message === 'duplicate') setScanResult('duplicate');
      else setScanResult('invalid');
      setTimeout(() => setScanResult(null), 2500);
    }
  });

  const manualScanMutation = useMutation({
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
    onSuccess: () => {
      setScanResult('success');
      setScanCount(c => c + 1);
      setManualToken('');
      queryClient.invalidateQueries({ queryKey: ['dinerScans'] });
      setTimeout(() => setScanResult(null), 2000);
    },
    onError: (err) => {
      setScanResult(err.message === 'duplicate' ? 'duplicate' : 'invalid');
      setTimeout(() => setScanResult(null), 2500);
    }
  });

  // Camera QR scanning
  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play();
    }
    setCameraActive(true);
    scanIntervalRef.current = setInterval(scanFrame, 400);
  };

  const stopCamera = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    setCameraActive(false);
  };

  const scanFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== 4) return;
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (code?.data) {
      scanMutation.mutate(code.data);
    }
  };

  useEffect(() => () => stopCamera(), []);

  const plannedCovers = selectedEvent ? (selectedEvent.total_expected_servings || 0) : 0;
  const actualDiners = getDinerScanHeadcount(scans);
  const noShows = Math.max(0, plannedCovers - actualDiners);
  const consumptionG = selectedEvent?.consumption_per_person_g || 550;
  const wasteEstimateKg = ((noShows * consumptionG) / 1000).toFixed(1);
  const attendanceRate = plannedCovers > 0 ? Math.round((actualDiners / plannedCovers) * 100) : 0;

  return (
    <div className="min-h-screen bg-slate-900 p-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-500/30">
            <Scan className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Dining Hall Scanner</h1>
          <p className="text-slate-400 text-sm mt-1">{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>

        {/* Event Selector */}
        <Card className="bg-slate-800 border-slate-700 mb-4">
          <CardContent className="p-4">
            <label className="text-slate-300 text-sm font-medium block mb-2">Select Today's Event</label>
            <Select value={selectedEventId} onValueChange={setSelectedEventId}>
              <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                <SelectValue placeholder="Choose dining hall event…" />
              </SelectTrigger>
              <SelectContent>
                {todayEvents.length === 0 && (
                  <SelectItem value="_none" disabled>No dining hall events found</SelectItem>
                )}
                {todayEvents.map(e => (
                  <SelectItem key={e.id} value={e.id}>{e.event_name} — {e.site_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {todayEvents.length === 0 && (
              <p className="text-amber-400 text-xs mt-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Create a Dining Hall event in Event Planning first
              </p>
            )}
          </CardContent>
        </Card>

        {selectedEvent && (
          <>
            {/* Live Stats */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Card className="bg-slate-800 border-slate-700">
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold text-white">{plannedCovers}</p>
                  <p className="text-xs text-slate-400 mt-1">Planned</p>
                </CardContent>
              </Card>
              <Card className="bg-emerald-900 border-emerald-700">
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-300">{actualDiners}</p>
                  <p className="text-xs text-emerald-400 mt-1">Scanned In</p>
                </CardContent>
              </Card>
              <Card className="bg-slate-800 border-slate-700">
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold text-amber-400">{attendanceRate}%</p>
                  <p className="text-xs text-slate-400 mt-1">Attendance</p>
                </CardContent>
              </Card>
            </div>

            {/* Waste Estimate */}
            {noShows > 0 && (
              <Card className="bg-orange-900/40 border-orange-700 mb-4">
                <CardContent className="p-3 flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-orange-400 flex-shrink-0" />
                  <div>
                    <p className="text-orange-200 text-sm font-medium">Estimated Waste: {wasteEstimateKg} kg</p>
                    <p className="text-orange-400 text-xs">{noShows} no-shows × {consumptionG}g/person</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Scan Feedback */}
            {scanResult && (
              <div className={`mb-4 rounded-xl p-4 flex items-center justify-center gap-3 text-lg font-bold ${
                scanResult === 'success' ? 'bg-emerald-500 text-white' :
                scanResult === 'duplicate' ? 'bg-amber-500 text-white' :
                'bg-red-500 text-white'
              }`}>
                {scanResult === 'success' && <><CheckCircle2 className="w-6 h-6" /> Guest Checked In!</>}
                {scanResult === 'duplicate' && <><AlertTriangle className="w-6 h-6" /> Already Scanned</>}
                {scanResult === 'invalid' && <><XCircle className="w-6 h-6" /> Invalid QR Code</>}
              </div>
            )}

            {/* Camera View */}
            <Card className="bg-slate-800 border-slate-700 mb-4">
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
                  <Button onClick={stopCamera} variant="outline" className="w-full mt-2 border-slate-600 text-slate-300">
                    Stop Camera
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Manual Entry */}
            <Card className="bg-slate-800 border-slate-700 mb-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-slate-300 text-sm">Manual Check-In</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex gap-2">
                  <Input
                    value={manualToken}
                    onChange={e => setManualToken(e.target.value)}
                    placeholder="Guest ID or token…"
                    className="bg-slate-700 border-slate-600 text-white placeholder-slate-500"
                    onKeyDown={e => e.key === 'Enter' && manualScanMutation.mutate()}
                  />
                  <Button
                    onClick={() => manualScanMutation.mutate()}
                    className="bg-blue-600 hover:bg-blue-700"
                    disabled={!manualToken || manualScanMutation.isPending}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Progress Bar */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="flex justify-between text-sm text-slate-400 mb-2">
                <span>Attendance Progress</span>
                <span>{actualDiners} / {plannedCovers}</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-3">
                <div
                  className="bg-emerald-500 h-3 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, attendanceRate)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>0%</span>
                <span className={attendanceRate >= 90 ? 'text-emerald-400' : 'text-amber-400'}>{attendanceRate}% attendance</span>
                <span>100%</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
