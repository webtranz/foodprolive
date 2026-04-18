import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, QrCode, Clock, Download, RefreshCw, Copy, Users, CheckCircle2, XCircle } from 'lucide-react';
import { createPageUrl } from '@/utils';

const CATEGORIES = [
  { value: 'labor', label: 'Labor', color: 'bg-blue-100 text-blue-800', qrColor: '#1d4ed8', border: 'border-blue-300' },
  { value: 'junior', label: 'Junior', color: 'bg-purple-100 text-purple-800', qrColor: '#7c3aed', border: 'border-purple-300' },
  { value: 'senior', label: 'Senior', color: 'bg-amber-100 text-amber-800', qrColor: '#d97706', border: 'border-amber-300' }
];

function generateToken(sessionId, category) {
  return btoa(JSON.stringify({
    type: 'category_attendance',
    sid: sessionId,
    cat: category,
    rand: Math.random().toString(36).slice(2, 10)
  }));
}

function QRDisplay({ session, cat }) {
  const scanUrl = `${window.location.origin}${createPageUrl('CategoryQRScan')}?token=${cat.token}`;
  const svgId = `cat-qr-${session.id}-${cat.category}`;
  const c = CATEGORIES.find(c => c.value === cat.category);

  const downloadQR = () => {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 400, 400);
      const a = document.createElement('a');
      a.download = `${session.title}-${cat.category}-qr.png`;
      a.href = canvas.toDataURL();
      a.click();
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(scanUrl);
    alert('QR link copied!');
  };

  return (
    <div className={`border-2 ${c.border} rounded-2xl p-4 bg-white text-center space-y-3`}>
      <Badge className={`${c.color} text-sm px-3 py-1`}>{cat.label || c.label}</Badge>
      <div className="flex justify-center">
        <QRCodeSVG
          id={svgId}
          value={scanUrl}
          size={160}
          level="H"
          includeMargin
          fgColor={c.qrColor}
        />
      </div>
      <div className="flex items-center justify-center gap-1 text-sm font-semibold text-slate-700">
        <Users className="w-4 h-4" />
        <span>{cat.scan_count || 0} scans</span>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={copyUrl}>
          <Copy className="w-3 h-3 mr-1" /> Copy Link
        </Button>
        <Button size="sm" className="flex-1 bg-slate-800 hover:bg-slate-900" onClick={downloadQR}>
          <Download className="w-3 h-3 mr-1" /> Download
        </Button>
      </div>
    </div>
  );
}

export default function CategoryQRManager() {
  const [showCreate, setShowCreate] = useState(false);
  const [viewSession, setViewSession] = useState(null);
  const [form, setForm] = useState({
    title: '',
    site_id: '',
    session_date: new Date().toISOString().split('T')[0],
    start_time: '07:00',
    end_time: '09:00',
    selected_categories: ['labor', 'junior', 'senior'],
    notes: ''
  });

  const queryClient = useQueryClient();
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['categoryQRSessions'],
    queryFn: () => base44.entities.CategoryQRSession.list('-session_date', 100)
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      const tempId = Date.now().toString();
      const categories = data.selected_categories.map(cat => {
        const c = CATEGORIES.find(c => c.value === cat);
        return {
          category: cat,
          label: c.label,
          token: generateToken(tempId, cat),
          scan_count: 0
        };
      });
      const site = sites.find(s => s.id === data.site_id);
      return base44.entities.CategoryQRSession.create({
        title: data.title,
        site_id: data.site_id,
        site_name: site?.name || '',
        session_date: data.session_date,
        start_time: data.start_time,
        end_time: data.end_time,
        categories,
        status: 'active',
        notes: data.notes
      });
    },
    onSuccess: (newSession) => {
      queryClient.invalidateQueries({ queryKey: ['categoryQRSessions'] });
      setShowCreate(false);
      setViewSession(newSession);
      setForm({ title: '', site_id: '', session_date: new Date().toISOString().split('T')[0], start_time: '07:00', end_time: '09:00', selected_categories: ['labor', 'junior', 'senior'], notes: '' });
    }
  });

  const closeMutation = useMutation({
    mutationFn: (id) => base44.entities.CategoryQRSession.update(id, { status: 'closed' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categoryQRSessions'] })
  });

  const regenerateMutation = useMutation({
    mutationFn: async (session) => {
      const categories = session.categories.map(cat => ({
        ...cat,
        token: generateToken(session.id, cat.category),
        scan_count: 0
      }));
      return base44.entities.CategoryQRSession.update(session.id, { categories });
    },
    onSuccess: (_, session) => {
      queryClient.invalidateQueries({ queryKey: ['categoryQRSessions'] });
      // refresh viewSession
      if (viewSession?.id === session.id) {
        base44.entities.CategoryQRSession.filter({ id: session.id }).then(r => r[0] && setViewSession(r[0]));
      }
    }
  });

  const toggleCategory = (cat) => {
    setForm(f => ({
      ...f,
      selected_categories: f.selected_categories.includes(cat)
        ? f.selected_categories.filter(c => c !== cat)
        : [...f.selected_categories, cat]
    }));
  };

  const isSessionActive = (session) => {
    if (session.status === 'closed') return false;
    const now = new Date();
    const dateStr = session.session_date;
    const start = new Date(`${dateStr}T${session.start_time}:00`);
    const end = new Date(`${dateStr}T${session.end_time}:00`);
    return now >= start && now <= end;
  };

  const getStatusLabel = (session) => {
    if (session.status === 'closed') return { label: 'Closed', color: 'bg-slate-100 text-slate-600' };
    const now = new Date();
    const dateStr = session.session_date;
    const start = new Date(`${dateStr}T${session.start_time}:00`);
    const end = new Date(`${dateStr}T${session.end_time}:00`);
    if (now < start) return { label: 'Upcoming', color: 'bg-blue-100 text-blue-700' };
    if (now > end) return { label: 'Expired', color: 'bg-red-100 text-red-700' };
    return { label: 'Active', color: 'bg-emerald-100 text-emerald-700' };
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Category QR Attendance</h2>
          <p className="text-sm text-slate-500">Generate time-restricted QR codes per category (Labor / Junior / Senior)</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="w-4 h-4 mr-2" /> New Session
        </Button>
      </div>

      {/* Sessions */}
      {isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <QrCode className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No sessions yet</p>
          <p className="text-sm">Create a session to generate category QR codes</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sessions.map(session => {
            const st = getStatusLabel(session);
            const totalScans = session.categories?.reduce((s, c) => s + (c.scan_count || 0), 0) || 0;
            return (
              <Card key={session.id} className={`border-2 ${session.status === 'active' && isSessionActive(session) ? 'border-emerald-300' : 'border-slate-200'}`}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-base">{session.title}</CardTitle>
                      <p className="text-xs text-slate-500 mt-0.5">{session.site_name} • {session.session_date}</p>
                    </div>
                    <Badge className={st.color}>{st.label}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <Clock className="w-4 h-4 text-slate-400" />
                    <span>{session.start_time} – {session.end_time}</span>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {session.categories?.map(c => {
                      const meta = CATEGORIES.find(m => m.value === c.category);
                      return (
                        <Badge key={c.category} className={`${meta?.color} text-xs`}>
                          {c.label}: {c.scan_count || 0}
                        </Badge>
                      );
                    })}
                  </div>
                  <p className="text-xs text-slate-500">{totalScans} total scans</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setViewSession(session)}>
                      <QrCode className="w-3 h-3 mr-1" /> View QR Codes
                    </Button>
                    {session.status === 'active' && (
                      <Button variant="outline" size="sm" className="text-red-600 border-red-300" onClick={() => closeMutation.mutate(session.id)}>
                        Close
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><QrCode className="w-5 h-5" /> Create Category QR Session</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Session Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g., Lunch Break — Camp A" className="mt-1" />
            </div>
            <div>
              <Label>Site</Label>
              <Select value={form.site_id} onValueChange={v => setForm(f => ({ ...f, site_id: v }))}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select site" /></SelectTrigger>
                <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Date</Label>
              <Input type="date" value={form.session_date} onChange={e => setForm(f => ({ ...f, session_date: e.target.value }))} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Start Time</Label>
                <Input type="time" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>End Time</Label>
                <Input type="time" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} className="mt-1" />
              </div>
            </div>
            <div>
              <Label className="mb-2 block">Categories *</Label>
              <div className="flex gap-2">
                {CATEGORIES.map(c => (
                  <button key={c.value} onClick={() => toggleCategory(c.value)}
                    className={`flex-1 py-2 rounded-xl border-2 text-sm font-medium transition-all ${form.selected_categories.includes(c.value) ? `${c.border} ${c.color}` : 'border-slate-200 text-slate-400'}`}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              disabled={!form.title || form.selected_categories.length === 0 || createMutation.isPending}
              onClick={() => createMutation.mutate(form)}
            >
              {createMutation.isPending ? 'Generating...' : 'Generate QR Codes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* View QR Codes Dialog */}
      <Dialog open={!!viewSession} onOpenChange={() => setViewSession(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewSession?.title}</DialogTitle>
          </DialogHeader>
          {viewSession && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2 items-center text-sm text-slate-600">
                <Clock className="w-4 h-4" />
                <span>{viewSession.start_time} – {viewSession.end_time}</span>
                <span>•</span>
                <span>{viewSession.session_date}</span>
                {viewSession.site_name && <><span>•</span><span>{viewSession.site_name}</span></>}
              </div>

              {/* Status banner */}
              {(() => {
                const st = getStatusLabel(viewSession);
                return (
                  <div className={`rounded-xl px-4 py-2 text-sm font-medium flex items-center gap-2 ${st.color}`}>
                    {st.label === 'Active' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    QR codes are {st.label === 'Active' ? 'currently active and scannable' : `${st.label.toLowerCase()} — scans will be rejected`}
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {viewSession.categories?.map(cat => (
                  <QRDisplay key={cat.category} session={viewSession} cat={cat} />
                ))}
              </div>

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => regenerateMutation.mutate(viewSession)} disabled={regenerateMutation.isPending}>
                  <RefreshCw className="w-4 h-4 mr-2" /> Regenerate All Tokens
                </Button>
              </div>
              <p className="text-xs text-slate-400 text-center">QR codes only accept scans between {viewSession.start_time} and {viewSession.end_time} on {viewSession.session_date}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}