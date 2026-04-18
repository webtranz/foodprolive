import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, XCircle, AlertTriangle, Camera, CameraOff, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';

const RESULT_STATES = {
  success: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50 border-green-300', label: 'Attendance Marked!' },
  duplicate: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-300', label: 'Already Marked!' },
  expired: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50 border-red-300', label: 'QR Code Expired' },
  invalid: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50 border-red-300', label: 'Invalid QR Code' },
  error: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50 border-red-300', label: 'Error recording attendance' }
};

export default function QRScanner() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [category, setCategory] = useState('labor');
  const [lastScan, setLastScan] = useState(null);
  const queryClient = useQueryClient();

  const { data: sessions = [] } = useQuery({
    queryKey: ['attendanceSessions'],
    queryFn: () => base44.entities.AttendanceSession.list('-session_date', 50)
  });

  const { data: records = [] } = useQuery({
    queryKey: ['attendanceRecords'],
    queryFn: () => base44.entities.AttendanceRecord.list('-marked_at', 200)
  });

  const markMutation = useMutation({
    mutationFn: async ({ session, category: cat }) => {
      const user = await base44.auth.me();
      const sessionId = session.id;
      const userId = user.email;

      // Check for duplicate
      const duplicate = records.find(r => r.session_id === sessionId && r.attendee_id === userId);
      if (duplicate) return { status: 'duplicate' };

      await base44.entities.AttendanceRecord.create({
        session_id: sessionId,
        session_name: session.session_name,
        site_id: session.site_id,
        site_name: session.site_name,
        session_date: session.session_date,
        meal_type: session.meal_type,
        attendee_id: userId,
        attendee_name: user.full_name || user.email,
        category: cat,
        marked_at: new Date().toISOString(),
        scan_method: 'qr_scan'
      });

      // Update session counts
      const updatedField = `actual_${cat}`;
      await base44.entities.AttendanceSession.update(sessionId, {
        [updatedField]: (session[updatedField] || 0) + 1
      });

      return { status: 'success' };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendanceSessions'] });
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
    }
  });

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScanning(true);
      setResult(null);
      scanLoop();
    } catch {
      setResult({ state: 'error', message: 'Camera access denied. Please allow camera permissions.' });
    }
  };

  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    cancelAnimationFrame(animRef.current);
    setScanning(false);
  };

  const scanLoop = () => {
    animRef.current = requestAnimationFrame(async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        scanLoop();
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });

      if (code && code.data !== lastScan) {
        setLastScan(code.data);
        stopCamera();
        await processQR(code.data);
        return;
      }
      scanLoop();
    });
  };

  const processQR = async (data) => {
    try {
      const payload = JSON.parse(atob(data));
      // Check expiry
      if (new Date(payload.exp) < new Date()) {
        setResult({ state: 'expired', message: `This QR code expired at ${format(new Date(payload.exp), 'HH:mm')}` });
        return;
      }
      // Find matching session
      const session = sessions.find(s => s.qr_token === data && s.status === 'active');
      if (!session) {
        setResult({ state: 'invalid', message: 'No active session found for this QR code' });
        return;
      }
      const res = await markMutation.mutateAsync({ session, category });
      setResult({ state: res.status, session, markedAt: new Date() });
    } catch {
      setResult({ state: 'invalid', message: 'This QR code is not valid for this system' });
    }
  };

  // Manual scan for testing
  const manualMark = async (session) => {
    const res = await markMutation.mutateAsync({ session, category });
    setResult({ state: res.status, session, markedAt: new Date() });
  };

  useEffect(() => () => stopCamera(), []);

  const activeSessions = sessions.filter(s => s.status === 'active' && new Date(s.qr_expiry) > new Date());
  const todayRecords = records.filter(r => r.session_date === new Date().toISOString().split('T')[0]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Scanner */}
        <Card>
          <CardContent className="p-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  <Camera className="w-5 h-5" /> QR Scanner
                </h3>
                <div>
                  <Label className="text-xs mr-2">Category</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="w-28 h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="labor">Labor</SelectItem>
                      <SelectItem value="junior">Junior</SelectItem>
                      <SelectItem value="senior">Senior</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Video Preview */}
              <div className="relative bg-slate-900 rounded-xl overflow-hidden aspect-[4/3]">
                <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
                <canvas ref={canvasRef} className="hidden" />
                {!scanning && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                    <CameraOff className="w-12 h-12 mb-3 opacity-50" />
                    <p className="text-sm opacity-70">Camera inactive</p>
                  </div>
                )}
                {scanning && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-48 h-48 border-2 border-emerald-400 rounded-xl shadow-lg">
                      <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl-lg" />
                      <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr-lg" />
                      <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl-lg" />
                      <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br-lg" />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                {!scanning ? (
                  <Button onClick={startCamera} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                    <Camera className="w-4 h-4 mr-2" /> Start Scanning
                  </Button>
                ) : (
                  <Button onClick={stopCamera} variant="outline" className="flex-1">
                    <CameraOff className="w-4 h-4 mr-2" /> Stop
                  </Button>
                )}
                {result && (
                  <Button variant="outline" onClick={() => { setResult(null); setLastScan(null); }}>
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                )}
              </div>

              {/* Result Banner */}
              {result && (() => {
                const cfg = RESULT_STATES[result.state];
                const Icon = cfg.icon;
                return (
                  <div className={`border-2 rounded-xl p-4 text-center ${cfg.bg}`}>
                    <Icon className={`w-10 h-10 mx-auto mb-2 ${cfg.color}`} />
                    <p className={`text-lg font-bold ${cfg.color}`}>{cfg.label}</p>
                    {result.session && <p className="text-sm text-slate-600 mt-1">{result.session.session_name}</p>}
                    {result.markedAt && <p className="text-xs text-slate-500 mt-1">{format(result.markedAt, 'HH:mm:ss')}</p>}
                    {result.message && <p className="text-sm text-slate-600 mt-1">{result.message}</p>}
                  </div>
                );
              })()}
            </div>
          </CardContent>
        </Card>

        {/* Active Sessions & Manual Mark */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-4">Active Sessions (Manual Mark)</h3>
              {activeSessions.length === 0 ? (
                <p className="text-slate-500 text-sm">No active sessions right now</p>
              ) : (
                <div className="space-y-3">
                  {activeSessions.map(session => (
                    <div key={session.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                      <div>
                        <p className="font-medium text-sm">{session.session_name}</p>
                        <p className="text-xs text-slate-500">{session.site_name} • {session.meal_type}</p>
                      </div>
                      <Button size="sm" onClick={() => manualMark(session)} disabled={markMutation.isPending}
                        className="bg-indigo-600 hover:bg-indigo-700">
                        Mark
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-4">Today's Attendance</h3>
              <div className="grid grid-cols-3 gap-3 text-center">
                {[['Labor', 'labor', 'bg-blue-100 text-blue-800'], ['Junior', 'junior', 'bg-purple-100 text-purple-800'], ['Senior', 'senior', 'bg-amber-100 text-amber-800']].map(([label, cat, cls]) => (
                  <div key={cat} className={`rounded-xl p-3 ${cls}`}>
                    <p className="text-2xl font-bold">{todayRecords.filter(r => r.category === cat).length}</p>
                    <p className="text-xs font-medium mt-1">{label}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-center">
                <p className="text-3xl font-bold text-slate-900">{todayRecords.length}</p>
                <p className="text-sm text-slate-500">Total Today</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}