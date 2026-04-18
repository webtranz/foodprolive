import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, AlertTriangle, Camera, CameraOff, RefreshCw, User } from 'lucide-react';
import { format } from 'date-fns';

const RESULT_CONFIG = {
  success:      { icon: CheckCircle2, color: 'text-green-600',  bg: 'bg-green-50 border-green-400',  label: '✅ Attendance Marked!' },
  duplicate:    { icon: AlertTriangle,color: 'text-amber-600',  bg: 'bg-amber-50 border-amber-400',  label: '⚠️ Already Scanned!' },
  expired:      { icon: XCircle,      color: 'text-red-600',    bg: 'bg-red-50 border-red-400',      label: '❌ QR Code Expired' },
  invalid:      { icon: XCircle,      color: 'text-red-600',    bg: 'bg-red-50 border-red-400',      label: '❌ Invalid QR Code' },
  not_registered:{ icon: XCircle,     color: 'text-orange-600', bg: 'bg-orange-50 border-orange-400',label: '❌ User Not Registered' },
  session_closed:{ icon: XCircle,     color: 'text-slate-600',  bg: 'bg-slate-50 border-slate-400',  label: '❌ Session Closed' }
};

const CAT_COLORS = {
  labor: 'bg-blue-100 text-blue-800', junior: 'bg-purple-100 text-purple-800', senior: 'bg-amber-100 text-amber-800'
};

export default function UnifiedQRScanner() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [lastToken, setLastToken] = useState(null);
  const queryClient = useQueryClient();

  const { data: sessions = [] } = useQuery({
    queryKey: ['attendanceSessions'],
    queryFn: () => base44.entities.AttendanceSession.list('-session_date', 100)
  });

  const markMutation = useMutation({
    mutationFn: async (token) => {
      let payload;
      try { payload = JSON.parse(atob(token)); } catch { return { state: 'invalid' }; }

      // Check expiry
      if (payload.exp && new Date(payload.exp) < new Date()) return { state: 'expired', exp: payload.exp };

      // Find matching session
      const session = sessions.find(s =>
        s.registered_users?.some(u => u.qr_token === token) && s.status === 'active'
      );
      if (!session) {
        // Try closed session
        const closedSession = sessions.find(s => s.registered_users?.some(u => u.qr_token === token));
        if (closedSession) return { state: 'session_closed' };
        return { state: 'not_registered' };
      }

      // Find the specific user
      const userIdx = session.registered_users.findIndex(u => u.qr_token === token);
      const user = session.registered_users[userIdx];
      if (!user) return { state: 'not_registered' };

      // Check duplicate
      if (user.has_scanned) return { state: 'duplicate', user, session };

      // Mark as scanned
      const updatedUsers = [...session.registered_users];
      updatedUsers[userIdx] = { ...user, has_scanned: true, scanned_at: new Date().toISOString() };

      const catField = `actual_${user.category}`;
      await base44.entities.AttendanceSession.update(session.id, {
        registered_users: updatedUsers,
        [catField]: (session[catField] || 0) + 1
      });

      // Create attendance record
      const currentUser = await base44.auth.me();
      await base44.entities.AttendanceRecord.create({
        session_id: session.id,
        session_name: session.session_name,
        site_id: session.site_id,
        site_name: session.site_name,
        session_date: session.session_date,
        meal_type: session.meal_type,
        attendee_id: user.user_id,
        attendee_name: user.name,
        category: user.category,
        marked_at: new Date().toISOString(),
        scan_method: 'qr_scan'
      });

      return { state: 'success', user, session };
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
      setResult({ state: 'invalid', message: 'Camera access denied' });
    }
  };

  const stopCamera = () => {
    videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    cancelAnimationFrame(animRef.current);
    setScanning(false);
  };

  const scanLoop = () => {
    animRef.current = requestAnimationFrame(async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) { scanLoop(); return; }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data !== lastToken) {
        setLastToken(code.data);
        stopCamera();
        const res = await markMutation.mutateAsync(code.data);
        setResult(res);
        return;
      }
      scanLoop();
    });
  };

  useEffect(() => () => stopCamera(), []);

  const reset = () => { setResult(null); setLastToken(null); };
  const cfg = result ? RESULT_CONFIG[result.state] || RESULT_CONFIG.invalid : null;

  // Today's session summary
  const today = new Date().toISOString().split('T')[0];
  const todaySessions = sessions.filter(s => s.session_date === today);
  const totalScanned = todaySessions.reduce((sum, s) => sum + (s.registered_users?.filter(u => u.has_scanned).length || 0), 0);
  const totalRegistered = todaySessions.reduce((sum, s) => sum + (s.registered_users?.length || 0), 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Scanner */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <Camera className="w-5 h-5" /> QR Scanner
          </h3>

          {/* Camera viewport */}
          <div className="relative bg-slate-900 rounded-xl overflow-hidden aspect-[4/3]">
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            <canvas ref={canvasRef} className="hidden" />
            {!scanning && !result && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                <CameraOff className="w-12 h-12 mb-2 opacity-40" />
                <p className="text-sm opacity-60">Press Start to scan</p>
              </div>
            )}
            {scanning && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-52 h-52 relative">
                  <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-emerald-400 rounded-tl-xl" />
                  <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-emerald-400 rounded-tr-xl" />
                  <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-emerald-400 rounded-bl-xl" />
                  <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-emerald-400 rounded-br-xl" />
                  <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-emerald-400 opacity-70 animate-pulse" />
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            {!scanning ? (
              <Button onClick={startCamera} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                <Camera className="w-4 h-4 mr-2" /> Start Scanner
              </Button>
            ) : (
              <Button onClick={stopCamera} variant="outline" className="flex-1">
                <CameraOff className="w-4 h-4 mr-2" /> Stop
              </Button>
            )}
            {result && <Button variant="outline" onClick={reset}><RefreshCw className="w-4 h-4" /></Button>}
          </div>

          {/* Result */}
          {result && cfg && (() => {
            const Icon = cfg.icon;
            return (
              <div className={`border-2 rounded-xl p-4 ${cfg.bg}`}>
                <div className="flex items-center gap-3">
                  <Icon className={`w-10 h-10 flex-shrink-0 ${cfg.color}`} />
                  <div className="flex-1">
                    <p className={`text-lg font-bold ${cfg.color}`}>{cfg.label}</p>
                    {result.user && (
                      <div className="mt-1 space-y-0.5">
                        <p className="text-sm font-medium flex items-center gap-1">
                          <User className="w-3 h-3" /> {result.user.name}
                        </p>
                        <Badge className={`text-xs ${CAT_COLORS[result.user.category]}`}>{result.user.category}</Badge>
                      </div>
                    )}
                    {result.session && (
                      <p className="text-xs text-slate-600 mt-1">Session: {result.session.session_name}</p>
                    )}
                    {result.exp && <p className="text-xs text-slate-500 mt-1">Expired at: {format(new Date(result.exp), 'HH:mm')}</p>}
                    {result.message && <p className="text-xs text-slate-600 mt-1">{result.message}</p>}
                    <p className="text-xs text-slate-400 mt-1">{format(new Date(), 'HH:mm:ss')}</p>
                  </div>
                </div>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Today's summary */}
      <div className="space-y-4">
        <Card>
          <CardContent className="p-6">
            <h3 className="font-semibold mb-4">Today's Progress</h3>
            <div className="text-center mb-4">
              <p className="text-4xl font-bold text-emerald-600">{totalScanned}</p>
              <p className="text-sm text-slate-500">of {totalRegistered} registered</p>
              {totalRegistered > 0 && (
                <div className="mt-2">
                  <div className="w-full bg-slate-200 rounded-full h-3 mt-2">
                    <div className="bg-emerald-500 h-3 rounded-full transition-all" style={{ width: `${(totalScanned / totalRegistered) * 100}%` }} />
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{Math.round((totalScanned / totalRegistered) * 100)}% attendance</p>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {todaySessions.map(session => {
                const scanned = session.registered_users?.filter(u => u.has_scanned).length || 0;
                const total = session.registered_users?.length || 0;
                return (
                  <div key={session.id} className="bg-slate-50 rounded-lg p-3">
                    <div className="flex justify-between items-center mb-1">
                      <p className="text-sm font-medium">{session.session_name}</p>
                      <Badge variant="outline" className="text-xs">{scanned}/{total}</Badge>
                    </div>
                    <div className="flex gap-2 text-xs text-slate-500">
                      <span>L: {session.actual_labor || 0}</span>
                      <span>J: {session.actual_junior || 0}</span>
                      <span>S: {session.actual_senior || 0}</span>
                    </div>
                  </div>
                );
              })}
              {todaySessions.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No sessions today</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}