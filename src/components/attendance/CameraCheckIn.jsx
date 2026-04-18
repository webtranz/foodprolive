import React, { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import jsQR from 'jsqr';
import { CheckCircle2, XCircle, Camera, CameraOff, Loader2, HardHat, GraduationCap, Briefcase } from 'lucide-react';
import { format } from 'date-fns';
import { useQuery } from '@tanstack/react-query';

const CATEGORIES = [
  { value: 'labor',  label: 'Labor',  icon: HardHat,       bg: 'bg-blue-600',   light: 'bg-blue-50',   text: 'text-blue-700'   },
  { value: 'junior', label: 'Junior', icon: GraduationCap, bg: 'bg-purple-600', light: 'bg-purple-50', text: 'text-purple-700' },
  { value: 'senior', label: 'Senior', icon: Briefcase,     bg: 'bg-amber-500',  light: 'bg-amber-50',  text: 'text-amber-700'  },
];

const MEAL_META = {
  breakfast: { label: 'Breakfast', color: 'text-orange-500', badge: 'bg-orange-100 text-orange-700' },
  lunch:     { label: 'Lunch',     color: 'text-green-600',  badge: 'bg-green-100 text-green-700'   },
  dinner:    { label: 'Dinner',    color: 'text-indigo-600', badge: 'bg-indigo-100 text-indigo-700' },
};

function getActiveMeal(session) {
  if (!session?.meals) return null;
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const from = session.from_date || session.session_date;
  const to = session.to_date || session.session_date;
  if (today < from || today > to) return null;
  return session.meals.find(m => {
    if (!m.enabled) return false;
    const start = new Date(`${today}T${m.from_time}:00`);
    const end = new Date(`${today}T${m.to_time}:00`);
    return now >= start && now <= end;
  }) || null;
}

export default function CameraCheckIn() {
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraPhase, setCameraPhase] = useState('idle'); // idle | starting | active | denied
  const [scanFlash, setScanFlash] = useState(null); // { cat, meal, time, success } | null
  const [recentScans, setRecentScans] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const cooldownRef = useRef(false);
  const lastTokenRef = useRef('');

  const { data: sessions = [] } = useQuery({
    queryKey: ['categoryQRSessions'],
    queryFn: () => base44.entities.CategoryQRSession.list('-from_date', 100)
  });

  const findSessionByToken = (token) => {
    try {
      const payload = JSON.parse(atob(token));
      if (payload.type !== 'attendance_v3') return null;
      return sessions.find(s => s.id === payload.sid) || null;
    } catch { return null; }
  };

  const startCamera = async () => {
    setCameraPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCameraPhase('active');
      scanLoop();
    } catch { setCameraPhase('denied'); }
  };

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setCameraPhase('idle');
    setCameraOn(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const scanLoop = () => {
    const tick = () => {
      const video = videoRef.current; const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data && code.data !== lastTokenRef.current && !cooldownRef.current) {
          lastTokenRef.current = code.data;
          handleQRDetected(code.data);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleQRDetected = async (rawToken) => {
    if (cooldownRef.current) return;
    cooldownRef.current = true;

    const session = findSessionByToken(rawToken);
    if (!session) {
      showError('QR code not recognized');
      return;
    }
    if (session.status === 'closed') { showError('Session is closed'); return; }

    const meal = getActiveMeal(session);
    if (!meal) { showError('No active meal window right now'); return; }

    // Need category — try to get from token payload
    let payload;
    try { payload = JSON.parse(atob(rawToken)); } catch { showError('Invalid QR code'); return; }
    const cat = CATEGORIES.find(c => c.value === payload.cat);
    if (!cat) { showError('Unknown category in QR code'); return; }

    try {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      await base44.entities.AttendanceRecord.create({
        session_id: session.id,
        session_name: session.title,
        session_date: today,
        meal_type: meal.meal_type,
        attendee_id: `scan-${Date.now()}`,
        category: cat.value,
        marked_at: now.toISOString(),
        scan_method: 'qr_scan'
      });

      const counts = { ...(session.scan_counts || { breakfast: { labor: 0, junior: 0, senior: 0 }, lunch: { labor: 0, junior: 0, senior: 0 }, dinner: { labor: 0, junior: 0, senior: 0 } }) };
      if (!counts[meal.meal_type]) counts[meal.meal_type] = { labor: 0, junior: 0, senior: 0 };
      counts[meal.meal_type][cat.value] = (counts[meal.meal_type][cat.value] || 0) + 1;
      await base44.entities.CategoryQRSession.update(session.id, { scan_counts: counts });

      const entry = { cat, mealLabel: MEAL_META[meal.meal_type]?.label, time: format(now, 'HH:mm:ss'), id: Date.now() };
      setRecentScans(prev => [entry, ...prev].slice(0, 8));
      setScanFlash({ ...entry, success: true });
      setErrorMsg('');
      setTimeout(() => { setScanFlash(null); lastTokenRef.current = ''; cooldownRef.current = false; }, 2500);
    } catch {
      showError('Failed to record. Try again.');
    }
  };

  const showError = (msg) => {
    setErrorMsg(msg);
    setScanFlash({ success: false, msg });
    setTimeout(() => { setScanFlash(null); setErrorMsg(''); lastTokenRef.current = ''; cooldownRef.current = false; }, 2500);
  };

  const handleToggleCamera = () => {
    if (cameraOn) { stopCamera(); }
    else { setCameraOn(true); startCamera(); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-semibold text-slate-800">Camera Check-In</h3>
          <p className="text-sm text-slate-500">Scan staff QR codes with the system camera to record attendance</p>
        </div>
        <button onClick={handleToggleCamera}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all ${cameraOn ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}>
          {cameraOn ? <><CameraOff className="w-4 h-4" /> Stop Camera</> : <><Camera className="w-4 h-4" /> Start Camera</>}
        </button>
      </div>

      {/* Camera viewport */}
      <div className="relative w-full rounded-2xl overflow-hidden bg-gray-900" style={{ aspectRatio: '16/9', maxHeight: 480 }}>

        {/* Idle / denied state */}
        {!cameraOn && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center space-y-3 z-10">
            <Camera className="w-14 h-14 text-white/20" />
            <p className="text-white/50 font-medium">Camera is off</p>
            <p className="text-white/30 text-sm">Click "Start Camera" to begin scanning</p>
          </div>
        )}
        {cameraPhase === 'denied' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-gray-900 space-y-2">
            <CameraOff className="w-12 h-12 text-red-400" />
            <p className="text-white font-medium">Camera access denied</p>
            <p className="text-white/50 text-sm">Allow camera permission in your browser settings</p>
          </div>
        )}
        {cameraPhase === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20 space-y-2">
            <Loader2 className="w-10 h-10 text-white/40 animate-spin" />
            <p className="text-white/50">Starting camera…</p>
          </div>
        )}

        <video ref={videoRef} className={`w-full h-full object-cover ${cameraPhase === 'active' ? 'opacity-100' : 'opacity-0'}`} playsInline muted />
        <canvas ref={canvasRef} className="hidden" />

        {/* Scan frame overlay */}
        {cameraPhase === 'active' && !scanFlash && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="w-52 h-52 relative">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-emerald-400 rounded-tl-xl" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-emerald-400 rounded-tr-xl" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-emerald-400 rounded-bl-xl" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-emerald-400 rounded-br-xl" />
              <div className="absolute top-1/2 left-4 right-4 h-px bg-emerald-400/60 animate-pulse" />
            </div>
            <p className="absolute bottom-4 text-white/60 text-sm">Point camera at QR code</p>
          </div>
        )}

        {/* Success flash */}
        {scanFlash?.success && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center z-30 ${scanFlash.cat?.bg || 'bg-emerald-600'} bg-opacity-95`}>
            <CheckCircle2 className="w-20 h-20 text-white mb-2" />
            <div className="flex items-center gap-2">
              {scanFlash.cat && React.createElement(scanFlash.cat.icon, { className: 'w-7 h-7 text-white' })}
              <p className="text-4xl font-black text-white">{scanFlash.cat?.label}</p>
            </div>
            <p className="text-white/80 text-lg mt-2 font-semibold">✓ Recorded</p>
            <p className="text-white/60 font-mono">{scanFlash.mealLabel} • {scanFlash.time}</p>
          </div>
        )}

        {/* Error flash */}
        {scanFlash && !scanFlash.success && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-30 bg-red-950/95">
            <XCircle className="w-16 h-16 text-red-300 mb-2" />
            <p className="text-white font-bold text-lg">Scan Failed</p>
            <p className="text-red-200 text-sm mt-1 text-center px-4">{scanFlash.msg}</p>
          </div>
        )}
      </div>

      {/* Recent scans */}
      {recentScans.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Recent Scans</p>
          <div className="space-y-1.5">
            {recentScans.map(scan => (
              <div key={scan.id} className={`flex items-center gap-3 px-3 py-2 rounded-xl ${scan.cat.light}`}>
                {React.createElement(scan.cat.icon, { className: `w-4 h-4 ${scan.cat.text}` })}
                <span className={`font-semibold text-sm ${scan.cat.text}`}>{scan.cat.label}</span>
                <span className="text-xs text-slate-500">{scan.mealLabel}</span>
                <span className="ml-auto text-xs font-mono text-slate-500">{scan.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}