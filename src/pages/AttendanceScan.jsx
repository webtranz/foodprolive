import React, { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import jsQR from 'jsqr';
import { CheckCircle2, XCircle, Clock, Loader2, HardHat, GraduationCap, Briefcase, Camera, CameraOff } from 'lucide-react';
import { format } from 'date-fns';

const CATEGORIES = [
  { value: 'labor',  label: 'Labor',  icon: HardHat,       bg: 'bg-blue-600',   light: 'bg-blue-50',   text: 'text-blue-700'   },
  { value: 'junior', label: 'Junior', icon: GraduationCap, bg: 'bg-purple-600', light: 'bg-purple-50', text: 'text-purple-700' },
  { value: 'senior', label: 'Senior', icon: Briefcase,     bg: 'bg-amber-500',  light: 'bg-amber-50',  text: 'text-amber-700'  },
];

const MEAL_META = {
  breakfast: { label: 'Breakfast', color: 'text-orange-500' },
  lunch:     { label: 'Lunch',     color: 'text-green-600'  },
  dinner:    { label: 'Dinner',    color: 'text-indigo-600' },
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

export default function AttendanceScan() {
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [activeMeal, setActiveMeal] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [recentScans, setRecentScans] = useState([]);
  const [cameraPhase, setCameraPhase] = useState('idle');

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const cooldownRef = useRef(false);
  const lastTokenRef = useRef('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    if (!sessionId) { setPhase('error'); setErrorMsg('No session found in URL.'); return; }
    loadSession(sessionId);
  }, []);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      const meal = getActiveMeal(session);
      setActiveMeal(meal);
      if (!meal && phase === 'scanning') { setPhase('no_meal'); stopCamera(); }
    }, 30000);
    return () => clearInterval(interval);
  }, [session, phase]);

  const loadSession = async (id) => {
    try {
      const sessions = await base44.entities.CategoryQRSession.list('-from_date', 200);
      const s = sessions.find(s => s.id === id);
      if (!s) { setPhase('error'); setErrorMsg('Session not found.'); return; }
      setSession(s);
      if (s.status === 'closed') { setPhase('expired'); return; }
      const meal = getActiveMeal(s);
      setActiveMeal(meal);
      setPhase(meal ? 'select_category' : 'no_meal');
    } catch { setPhase('error'); setErrorMsg('Failed to load session.'); }
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
          handleQRScan(code.data);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleQRScan = async (rawToken) => {
    if (cooldownRef.current || !session || !selectedCat) return;
    cooldownRef.current = true;
    try {
      let payload;
      try { payload = JSON.parse(atob(rawToken)); } catch { throw new Error('Not a valid QR code'); }
      if (payload.type !== 'attendance_v3') throw new Error('Not an attendance QR code');
      if (payload.sid !== session.id) throw new Error('QR code is for a different session');

      const meal = getActiveMeal(session);
      if (!meal) throw new Error('No active meal window right now');

      const now = new Date();
      const today = now.toISOString().split('T')[0];
      await base44.entities.AttendanceRecord.create({
        session_id: session.id,
        session_name: session.title,
        session_date: today,
        meal_type: meal.meal_type,
        attendee_id: `scan-${Date.now()}`,
        category: selectedCat.value,
        marked_at: now.toISOString(),
        scan_method: 'qr_scan'
      });

      const counts = { ...(session.scan_counts || { breakfast: { labor: 0, junior: 0, senior: 0 }, lunch: { labor: 0, junior: 0, senior: 0 }, dinner: { labor: 0, junior: 0, senior: 0 } }) };
      if (!counts[meal.meal_type]) counts[meal.meal_type] = { labor: 0, junior: 0, senior: 0 };
      counts[meal.meal_type][selectedCat.value] = (counts[meal.meal_type][selectedCat.value] || 0) + 1;
      await base44.entities.CategoryQRSession.update(session.id, { scan_counts: counts });
      setSession(s => ({ ...s, scan_counts: counts }));

      const entry = { cat: selectedCat, meal: MEAL_META[meal.meal_type], time: format(now, 'HH:mm:ss'), id: Date.now() };
      setRecentScans(prev => [entry, ...prev].slice(0, 8));
      setPhase('success');
      setTimeout(() => { setPhase('scanning'); setSelectedCat(null); lastTokenRef.current = ''; cooldownRef.current = false; }, 3000);
    } catch (err) {
      setErrorMsg(err.message);
      setPhase('scan_error');
      setTimeout(() => { setPhase('scanning'); setErrorMsg(''); lastTokenRef.current = ''; cooldownRef.current = false; }, 2500);
    }
  };

  const handleCategorySelect = (cat) => {
    setSelectedCat(cat);
    setPhase('scanning');
    startCamera();
  };

  if (phase === 'loading') return <Screen dark><Loader2 className="w-10 h-10 text-white/30 animate-spin" /><p className="text-white/50 mt-3">Loading…</p></Screen>;
  if (phase === 'error') return <Screen dark><XCircle className="w-14 h-14 text-red-400" /><p className="text-white font-bold text-xl mt-4">Error</p><p className="text-white/50 mt-2 text-center">{errorMsg}</p></Screen>;
  if (phase === 'expired') return <Screen dark><XCircle className="w-14 h-14 text-red-400" /><p className="text-white font-bold text-xl mt-4">{session?.title}</p><p className="text-white/50 mt-2">This session is closed</p></Screen>;

  if (phase === 'no_meal') return (
    <Screen dark>
      <Clock className="w-16 h-16 text-yellow-400" />
      <p className="text-white font-bold text-xl mt-4 text-center">{session?.title}</p>
      <p className="text-white/60 mt-1 text-sm text-center">{session?.from_date} → {session?.to_date || session?.from_date}</p>
      <p className="text-white/50 mt-2 text-center">No active meal window right now</p>
      <div className="mt-5 space-y-2 w-full max-w-xs">
        {(session?.meals || []).filter(m => m.enabled).map(m => {
          const meta = MEAL_META[m.meal_type];
          return (
            <div key={m.meal_type} className="bg-white/5 rounded-xl px-4 py-2 flex justify-between text-sm">
              <span className={`font-medium ${meta?.color}`}>{meta?.label}</span>
              <span className="text-white/60 font-mono">{m.from_time} – {m.to_time}</span>
            </div>
          );
        })}
      </div>
      <button onClick={() => loadSession(session?.id)} className="mt-5 text-white/40 text-sm hover:text-white/70">↻ Refresh</button>
    </Screen>
  );

  if (phase === 'select_category') {
    return (
      <Screen dark>
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center">
            <h1 className="text-white font-bold text-2xl">{session?.title}</h1>
            <p className="text-white/40 text-xs mt-0.5">{session?.from_date} → {session?.to_date}</p>
            {activeMeal && <p className={`mt-1 font-medium ${MEAL_META[activeMeal.meal_type]?.color}`}>{MEAL_META[activeMeal.meal_type]?.label} • {activeMeal.from_time} – {activeMeal.to_time}</p>}
            <p className="text-white/50 text-sm mt-2">Select your category</p>
          </div>
          <div className="space-y-3">
            {CATEGORIES.map(cat => {
              const Icon = cat.icon;
              return (
                <button key={cat.value} onClick={() => handleCategorySelect(cat)}
                  className={`w-full flex items-center gap-4 px-6 py-5 rounded-2xl ${cat.bg} text-white font-semibold text-lg transition-all active:scale-95 shadow-lg hover:opacity-90`}>
                  <Icon className="w-7 h-7" /> {cat.label}
                </button>
              );
            })}
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div>
          <h1 className="text-white font-bold text-sm">{session?.title}</h1>
          <p className="text-white/40 text-xs">{session?.from_date} → {session?.to_date}</p>
        </div>
        <div className="flex items-center gap-3">
          {activeMeal && <p className={`text-xs ${MEAL_META[activeMeal.meal_type]?.color}`}>{MEAL_META[activeMeal.meal_type]?.label}</p>}
          {selectedCat && (
            <div className={`flex items-center gap-1.5 ${selectedCat.light} rounded-full px-3 py-1`}>
              {React.createElement(selectedCat.icon, { className: `w-4 h-4 ${selectedCat.text}` })}
              <span className={`text-sm font-semibold ${selectedCat.text}`}>{selectedCat.label}</span>
            </div>
          )}
          <button onClick={() => { stopCamera(); setPhase('select_category'); setSelectedCat(null); }}
            className="text-white/40 text-xs border border-white/20 rounded-lg px-2 py-1 hover:text-white/70">Change</button>
        </div>
      </div>

      <div className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
        {cameraPhase !== 'active' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20 space-y-3">
            {cameraPhase === 'denied' ? (
              <><CameraOff className="w-14 h-14 text-red-400" /><p className="text-white font-medium">Camera access denied</p></>
            ) : cameraPhase === 'starting' ? (
              <><Loader2 className="w-10 h-10 text-white/40 animate-spin" /><p className="text-white/60">Starting camera…</p></>
            ) : (
              <><Camera className="w-14 h-14 text-white/20" />
                <button onClick={startCamera} className="bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-8 py-3 rounded-2xl">Restart Camera</button></>
            )}
          </div>
        )}
        <video ref={videoRef} className={`w-full h-full object-cover ${cameraPhase === 'active' ? 'opacity-100' : 'opacity-0'}`} playsInline muted />
        <canvas ref={canvasRef} className="hidden" />

        {cameraPhase === 'active' && phase === 'scanning' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="w-60 h-60 relative">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-emerald-400 rounded-tl-xl" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-emerald-400 rounded-tr-xl" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-emerald-400 rounded-bl-xl" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-emerald-400 rounded-br-xl" />
              <div className="absolute top-1/2 left-4 right-4 h-px bg-emerald-400/60 animate-pulse" />
            </div>
            <p className="absolute bottom-24 text-white/70 text-sm">Present QR code to camera</p>
          </div>
        )}

        {phase === 'success' && selectedCat && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center z-30 ${selectedCat.bg}`}>
            <CheckCircle2 className="w-24 h-24 text-white mb-3" />
            <div className="flex items-center gap-3">
              {React.createElement(selectedCat.icon, { className: 'w-8 h-8 text-white' })}
              <p className="text-5xl font-black text-white">{selectedCat.label}</p>
            </div>
            <p className="text-white/80 text-xl mt-2 font-semibold">✓ Attendance Recorded</p>
            {activeMeal && <p className="text-white/60 mt-1">{MEAL_META[activeMeal.meal_type]?.label}</p>}
            <p className="text-white/50 font-mono mt-1">{format(new Date(), 'HH:mm:ss')}</p>
          </div>
        )}

        {phase === 'scan_error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-30 bg-red-950/95">
            <XCircle className="w-20 h-20 text-red-400 mb-3" />
            <p className="text-white font-bold text-xl">Scan Failed</p>
            <p className="text-red-200 text-center mt-2 max-w-xs px-4">{errorMsg}</p>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 bg-gray-900 px-4 py-3 space-y-2">
        {recentScans.length > 0 && (
          <div>
            <p className="text-white/30 text-xs mb-1.5 uppercase tracking-wider">Recent</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {recentScans.map(scan => (
                <div key={scan.id} className={`flex-shrink-0 rounded-xl px-3 py-1.5 ${scan.cat.light} flex items-center gap-1.5`}>
                  {React.createElement(scan.cat.icon, { className: `w-3.5 h-3.5 ${scan.cat.text}` })}
                  <span className={`text-xs font-semibold ${scan.cat.text}`}>{scan.cat.label}</span>
                  <span className={`text-xs ${scan.meal?.color}`}>{scan.meal?.label}</span>
                  <span className="text-xs text-slate-500 font-mono">{scan.time}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <button onClick={stopCamera} className="w-full border border-white/10 text-white/40 rounded-xl py-2 text-xs hover:bg-white/5 flex items-center justify-center gap-2">
          <CameraOff className="w-3.5 h-3.5" /> Stop Camera
        </button>
      </div>
    </div>
  );
}

function Screen({ dark, children }) {
  return (
    <div className={`min-h-screen flex flex-col items-center justify-center p-6 gap-2 ${dark ? 'bg-gray-950' : 'bg-slate-50'}`}>
      {children}
    </div>
  );
}