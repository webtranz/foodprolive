import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  LayoutDashboard, QrCode, Plus, Download, Clock, RefreshCw,
  Trash2, CheckCircle2, HardHat, GraduationCap, Briefcase,
  Coffee, UtensilsCrossed, Moon, Scan, Camera
} from 'lucide-react';
import { format } from 'date-fns';
import { createPageUrl } from '@/utils';
import CameraCheckIn from '@/components/attendance/CameraCheckIn';

const CATEGORIES = [
  { value: 'labor',  label: 'Labor',  icon: HardHat,       bg: 'bg-blue-600',   light: 'bg-blue-50',   text: 'text-blue-700',   badge: 'bg-blue-100 text-blue-800' },
  { value: 'junior', label: 'Junior', icon: GraduationCap, bg: 'bg-purple-600', light: 'bg-purple-50', text: 'text-purple-700', badge: 'bg-purple-100 text-purple-800' },
  { value: 'senior', label: 'Senior', icon: Briefcase,     bg: 'bg-amber-500',  light: 'bg-amber-50',  text: 'text-amber-700',  badge: 'bg-amber-100 text-amber-800' },
];

const MEAL_META = {
  breakfast: { label: 'Breakfast', icon: Coffee,          color: 'bg-orange-100 text-orange-700', defaultFrom: '06:00', defaultTo: '09:00' },
  lunch:     { label: 'Lunch',     icon: UtensilsCrossed, color: 'bg-green-100 text-green-700',   defaultFrom: '11:30', defaultTo: '14:00' },
  dinner:    { label: 'Dinner',    icon: Moon,            color: 'bg-indigo-100 text-indigo-700', defaultFrom: '18:00', defaultTo: '20:30' },
};

function generateToken(sessionId) {
  return btoa(JSON.stringify({ type: 'attendance_v3', sid: sessionId, rand: Math.random().toString(36).slice(2, 10) }));
}

function defaultMeals() {
  return Object.entries(MEAL_META).map(([key, m]) => ({
    meal_type: key, label: m.label, from_time: m.defaultFrom, to_time: m.defaultTo, enabled: true
  }));
}

function defaultCounts() {
  return { breakfast: { labor: 0, junior: 0, senior: 0 }, lunch: { labor: 0, junior: 0, senior: 0 }, dinner: { labor: 0, junior: 0, senior: 0 } };
}

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

// ─── Dashboard ──────────────────────────────────────────────────────────────
function Dashboard() {
  const queryClient = useQueryClient();
  const { data: records = [], isLoading } = useQuery({
    queryKey: ['attendanceRecords'],
    queryFn: () => base44.entities.AttendanceRecord.list('-marked_at', 500)
  });
  useEffect(() => {
    const unsub = base44.entities.AttendanceRecord.subscribe(() => queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] }));
    return unsub;
  }, [queryClient]);

  const today = new Date().toISOString().split('T')[0];
  const todayRecs = records.filter(r => r.session_date === today);
  const countBy = (list, cat) => list.filter(r => r.category === cat).length;
  const mealRecs = (meal) => todayRecs.filter(r => r.meal_type === meal);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Today — {today}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="border-0 shadow-sm bg-white">
            <CardContent className="p-5 text-center">
              <p className="text-4xl font-bold text-slate-900">{todayRecs.length}</p>
              <p className="text-sm text-slate-400 mt-1">Total</p>
            </CardContent>
          </Card>
          {CATEGORIES.map(cat => {
            const Icon = cat.icon;
            return (
              <Card key={cat.value} className={`border-0 shadow-sm ${cat.light}`}>
                <CardContent className="p-5 text-center">
                  <Icon className={`w-5 h-5 mx-auto mb-1 ${cat.text}`} />
                  <p className={`text-4xl font-bold ${cat.text}`}>{countBy(todayRecs, cat.value)}</p>
                  <p className={`text-xs ${cat.text} mt-1`}>{cat.label}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Today by Meal</p>
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(MEAL_META).map(([key, meal]) => {
            const recs = mealRecs(key);
            const Icon = meal.icon;
            return (
              <Card key={key} className="border border-slate-100 shadow-sm">
                <CardContent className="p-4">
                  <Badge className={`${meal.color} mb-2`}><Icon className="w-3 h-3 mr-1" />{meal.label}</Badge>
                  <p className="text-2xl font-bold text-slate-800">{recs.length}</p>
                  <div className="mt-2 space-y-1">
                    {CATEGORIES.map(cat => (
                      <div key={cat.value} className="flex justify-between text-xs">
                        <span className={cat.text}>{cat.label}</span>
                        <span className="font-semibold text-slate-700">{countBy(recs, cat.value)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Recent Scans</p>
        <Card className="border-slate-100 shadow-sm">
          <CardContent className="p-0">
            {isLoading ? <p className="text-center py-8 text-slate-400 text-sm">Loading…</p>
              : records.length === 0 ? <p className="text-center py-12 text-slate-400 text-sm">No records yet</p>
              : (
                <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                  {records.slice(0, 100).map(r => {
                    const cat = CATEGORIES.find(c => c.value === r.category);
                    const Icon = cat?.icon || HardHat;
                    const meal = MEAL_META[r.meal_type];
                    return (
                      <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                        <div className={`w-8 h-8 rounded-full ${cat?.light || 'bg-slate-100'} flex items-center justify-center flex-shrink-0`}>
                          <Icon className={`w-4 h-4 ${cat?.text || 'text-slate-500'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge className={`text-xs ${cat?.badge || 'bg-slate-100 text-slate-600'}`}>{r.category}</Badge>
                            {meal && <Badge className={`text-xs ${meal.color}`}>{meal.label}</Badge>}
                            <span className="text-sm text-slate-500 truncate">{r.session_name}</span>
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">{r.session_date}</p>
                        </div>
                        <span className="text-sm font-mono text-slate-400 flex-shrink-0">
                          {r.marked_at ? format(new Date(r.marked_at), 'HH:mm:ss') : '-'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── QR Module ──────────────────────────────────────────────────────────────
function QRModule() {
  const [showCreate, setShowCreate] = useState(false);
  const [viewSession, setViewSession] = useState(null);
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    title: `Attendance — ${today}`,
    from_date: today,
    to_date: today,
    meals: defaultMeals()
  });
  const queryClient = useQueryClient();

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['categoryQRSessions'],
    queryFn: () => base44.entities.CategoryQRSession.list('-from_date', 100)
  });

  const updateMealTime = (idx, field, val) => {
    setForm(f => { const meals = [...f.meals]; meals[idx] = { ...meals[idx], [field]: val }; return { ...f, meals }; });
  };
  const toggleMeal = (idx) => {
    setForm(f => { const meals = [...f.meals]; meals[idx] = { ...meals[idx], enabled: !meals[idx].enabled }; return { ...f, meals }; });
  };

  const createMutation = useMutation({
    mutationFn: async (data) => {
      const session = await base44.entities.CategoryQRSession.create({
        title: data.title,
        from_date: data.from_date,
        to_date: data.to_date,
        session_date: data.from_date,
        meals: data.meals,
        scan_counts: defaultCounts(),
        status: 'active',
        qr_token: 'placeholder'
      });
      const token = generateToken(session.id);
      return base44.entities.CategoryQRSession.update(session.id, { qr_token: token });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['categoryQRSessions'] });
      setShowCreate(false);
      setViewSession(updated);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.CategoryQRSession.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categoryQRSessions'] })
  });

  const regenerateMutation = useMutation({
    mutationFn: async (session) => base44.entities.CategoryQRSession.update(session.id, { qr_token: generateToken(session.id) }),
    onSuccess: (updated) => { queryClient.invalidateQueries({ queryKey: ['categoryQRSessions'] }); setViewSession(updated); }
  });

  const getSessionStatus = (session) => {
    if (session.status === 'closed') return { label: 'Closed', cls: 'bg-slate-100 text-slate-600' };
    const activeMeal = getActiveMeal(session);
    if (activeMeal) return { label: `${MEAL_META[activeMeal.meal_type]?.label} Active`, cls: 'bg-emerald-100 text-emerald-700' };
    const today2 = new Date().toISOString().split('T')[0];
    const from = session.from_date || session.session_date;
    const to = session.to_date || session.session_date;
    if (today2 < from) return { label: 'Upcoming', cls: 'bg-blue-100 text-blue-700' };
    if (today2 > to) return { label: 'Expired', cls: 'bg-red-100 text-red-700' };
    return { label: 'Between Meals', cls: 'bg-yellow-100 text-yellow-700' };
  };

  const getScannerUrl = (session) => `${window.location.origin}${createPageUrl('AttendanceScan')}?session=${session.id}`;

  const downloadQR = (session) => {
    const svg = document.getElementById(`qr-${session.id}`);
    if (!svg) return;
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0,0,600,600); ctx.drawImage(img,0,0,600,600); const a = document.createElement('a'); a.download = `${session.title}-QR.png`; a.href = canvas.toDataURL(); a.click(); };
    img.src = 'data:image/svg+xml;base64,' + btoa(new XMLSerializer().serializeToString(svg));
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-semibold text-slate-800">QR Sessions</h3>
          <p className="text-sm text-slate-500">One QR code per session — valid across a date range, covers all 3 meals</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="w-4 h-4 mr-2" /> New Session
        </Button>
      </div>

      {isLoading ? <p className="text-center py-12 text-slate-400 text-sm">Loading…</p>
        : sessions.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <QrCode className="w-14 h-14 mx-auto mb-3 opacity-20" />
            <p className="font-medium text-slate-600">No sessions yet</p>
            <p className="text-sm">Create a session to generate one QR code for all meals</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sessions.map(session => {
              const st = getSessionStatus(session);
              const counts = session.scan_counts || defaultCounts();
              return (
                <Card key={session.id} className={`border-2 shadow-sm ${st.label.includes('Active') ? 'border-emerald-300' : 'border-slate-200'}`}>
                  <CardContent className="p-5 space-y-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-semibold text-slate-800">{session.title}</h4>
                        <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
                          <Clock className="w-3 h-3" />
                          <span>{session.from_date || session.session_date} → {session.to_date || session.session_date}</span>
                        </div>
                      </div>
                      <Badge className={st.cls}>{st.label}</Badge>
                    </div>

                    {/* Meal time windows */}
                    <div className="space-y-1">
                      {(session.meals || []).filter(m => m.enabled).map(m => {
                        const meta = MEAL_META[m.meal_type];
                        const Icon = meta?.icon;
                        return (
                          <div key={m.meal_type} className="flex items-center gap-2 text-xs text-slate-600">
                            <Badge className={`${meta?.color} text-xs`}>
                              {Icon && <Icon className="w-3 h-3 mr-0.5" />}{meta?.label}
                            </Badge>
                            <span className="font-mono">{m.from_time} – {m.to_time}</span>
                          </div>
                        );
                      })}
                    </div>

                    {/* QR preview */}
                    <div className="flex justify-center bg-white rounded-xl border border-slate-100 p-3 cursor-pointer" onClick={() => setViewSession(session)}>
                      <QRCodeSVG id={`qr-${session.id}`} value={getScannerUrl(session)} size={100} level="H" includeMargin fgColor="#1e1b4b" />
                    </div>

                    {/* Scan counts */}
                    <div className="flex gap-1.5">
                      {CATEGORIES.map(cat => {
                        const total = Object.values(counts).reduce((s, m) => s + (m[cat.value] || 0), 0);
                        return (
                          <div key={cat.value} className={`flex-1 rounded-lg ${cat.light} py-2 text-center`}>
                            <p className={`text-lg font-bold ${cat.text}`}>{total}</p>
                            <p className={`text-xs ${cat.text}`}>{cat.label}</p>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => setViewSession(session)}>
                        <QrCode className="w-3.5 h-3.5 mr-1" /> View QR
                      </Button>
                      <a href={getScannerUrl(session)} target="_blank" rel="noreferrer">
                        <Button size="sm" className={`${st.label.includes('Active') ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-600 hover:bg-slate-700'}`}>
                          <Scan className="w-3.5 h-3.5 mr-1" /> Scan
                        </Button>
                      </a>
                      <Button variant="outline" size="sm" className="text-red-500 border-red-200 hover:bg-red-50" onClick={() => deleteMutation.mutate(session.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><QrCode className="w-5 h-5" /> New Session</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div>
              <Label>Session Title</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="mt-1" />
            </div>
            {/* Date range */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>From Date *</Label>
                <Input type="date" value={form.from_date}
                  onChange={e => setForm(f => ({ ...f, from_date: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>To Date *</Label>
                <Input type="date" value={form.to_date}
                  onChange={e => setForm(f => ({ ...f, to_date: e.target.value }))} className="mt-1" />
              </div>
            </div>

            {/* Meal time windows */}
            <div className="space-y-3">
              <Label>Meal Time Windows (daily)</Label>
              {form.meals.map((m, idx) => {
                const meta = MEAL_META[m.meal_type];
                const Icon = meta.icon;
                return (
                  <div key={m.meal_type} className={`border rounded-xl p-3 space-y-2 ${m.enabled ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
                    <div className="flex items-center justify-between">
                      <Badge className={meta.color}><Icon className="w-3 h-3 mr-1" />{meta.label}</Badge>
                      <button onClick={() => toggleMeal(idx)}
                        className={`text-xs px-2 py-0.5 rounded-full border font-medium transition-all ${m.enabled ? 'border-emerald-300 text-emerald-700 bg-emerald-50' : 'border-slate-300 text-slate-500'}`}>
                        {m.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </div>
                    {m.enabled && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-xs text-slate-500 mb-1">From Time</p>
                          <Input type="time" value={m.from_time} onChange={e => updateMealTime(idx, 'from_time', e.target.value)} className="h-8 text-sm" />
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 mb-1">To Time</p>
                          <Input type="time" value={m.to_time} onChange={e => updateMealTime(idx, 'to_time', e.target.value)} className="h-8 text-sm" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              disabled={!form.title || !form.from_date || !form.to_date || createMutation.isPending}
              onClick={() => createMutation.mutate(form)}>
              {createMutation.isPending ? 'Generating…' : 'Generate QR Code'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* View QR Dialog */}
      {viewSession && (
        <Dialog open={!!viewSession} onOpenChange={() => setViewSession(null)}>
          <DialogContent className="max-w-sm text-center">
            <DialogHeader>
              <DialogTitle>{viewSession.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-2 text-sm text-slate-600 bg-slate-50 rounded-xl px-4 py-2">
                <Clock className="w-4 h-4 text-slate-400" />
                <span>{viewSession.from_date} → {viewSession.to_date || viewSession.from_date}</span>
              </div>

              {(() => {
                const st = getSessionStatus(viewSession);
                return (
                  <div className={`rounded-xl px-3 py-2 text-sm font-medium flex items-center justify-center gap-2 ${st.cls}`}>
                    {st.label.includes('Active') ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                    {st.label}
                  </div>
                );
              })()}

              <div className="space-y-1.5 text-left">
                {(viewSession.meals || []).filter(m => m.enabled).map(m => {
                  const meta = MEAL_META[m.meal_type];
                  const Icon = meta?.icon;
                  return (
                    <div key={m.meal_type} className="flex items-center gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
                      <Badge className={meta.color}>{Icon && <Icon className="w-3 h-3 mr-1" />}{meta.label}</Badge>
                      <span className="font-mono text-slate-600">{m.from_time} – {m.to_time}</span>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-center bg-white border-2 border-slate-100 rounded-2xl p-6">
                <QRCodeSVG id={`qr-view-${viewSession.id}`} value={getScannerUrl(viewSession)} size={200} level="H" includeMargin fgColor="#1e1b4b" />
              </div>
              <p className="text-xs text-slate-500">Single QR — valid {viewSession.from_date} to {viewSession.to_date || viewSession.from_date}, all 3 meals</p>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => downloadQR(viewSession)}>
                  <Download className="w-4 h-4 mr-2" /> Download
                </Button>
                <a className="flex-1" href={getScannerUrl(viewSession)} target="_blank" rel="noreferrer">
                  <Button className="w-full bg-emerald-600 hover:bg-emerald-700">
                    <Scan className="w-4 h-4 mr-2" /> Open Scanner
                  </Button>
                </a>
              </div>
              <Button variant="ghost" size="sm" className="w-full text-slate-400" onClick={() => regenerateMutation.mutate(viewSession)}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" /> Regenerate Token
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────
export default function Attendance() {
  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Attendance System</h1>
          <p className="text-slate-500 text-sm mt-1">One QR code • Date range • Breakfast, Lunch & Dinner • Camera check-in</p>
        </div>
        <Tabs defaultValue="dashboard">
          <TabsList className="mb-6 bg-white border border-slate-200 p-1 rounded-xl shadow-sm">
            <TabsTrigger value="dashboard" className="flex items-center gap-2 rounded-lg data-[state=active]:shadow-sm">
              <LayoutDashboard className="w-4 h-4" /> Dashboard
            </TabsTrigger>
            <TabsTrigger value="qr" className="flex items-center gap-2 rounded-lg data-[state=active]:shadow-sm">
              <QrCode className="w-4 h-4" /> QR Code Module
            </TabsTrigger>
            <TabsTrigger value="checkin" className="flex items-center gap-2 rounded-lg data-[state=active]:shadow-sm">
              <Camera className="w-4 h-4" /> Camera Check-In
            </TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard"><Dashboard /></TabsContent>
          <TabsContent value="qr"><QRModule /></TabsContent>
          <TabsContent value="checkin"><CameraCheckIn /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}