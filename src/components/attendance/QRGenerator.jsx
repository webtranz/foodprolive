import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, QrCode, Clock, Users, Download } from 'lucide-react';
import { format, addMinutes } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const MEAL_COLORS = {
  breakfast: 'bg-amber-500',
  lunch: 'bg-emerald-500',
  dinner: 'bg-indigo-500',
  snack: 'bg-purple-500'
};

export default function QRGenerator() {
  const [showCreate, setShowCreate] = useState(false);
  const [activeQR, setActiveQR] = useState(null);
  const [form, setForm] = useState({
    session_name: '',
    site_id: '',
    meal_type: 'lunch',
    session_date: new Date().toISOString().split('T')[0],
    expected_labor: 0,
    expected_junior: 0,
    expected_senior: 0,
    validity_minutes: 60
  });

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ['attendanceSessions'],
    queryFn: () => base44.entities.AttendanceSession.list('-session_date', 50)
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      const token = btoa(JSON.stringify({
        sid: `${data.site_id}-${data.meal_type}-${data.session_date}`,
        meal: data.meal_type,
        date: data.session_date,
        exp: addMinutes(new Date(), parseInt(data.validity_minutes)).toISOString(),
        rand: Math.random().toString(36).slice(2)
      }));
      const site = sites.find(s => s.id === data.site_id);
      return base44.entities.AttendanceSession.create({
        ...data,
        site_name: site?.name || '',
        qr_token: token,
        qr_expiry: addMinutes(new Date(), parseInt(data.validity_minutes)).toISOString(),
        status: 'active',
        actual_labor: 0,
        actual_junior: 0,
        actual_senior: 0
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendanceSessions'] });
      setShowCreate(false);
      setForm({ session_name: '', site_id: '', meal_type: 'lunch', session_date: new Date().toISOString().split('T')[0], expected_labor: 0, expected_junior: 0, expected_senior: 0, validity_minutes: 60 });
    }
  });

  const closeMutation = useMutation({
    mutationFn: (id) => base44.entities.AttendanceSession.update(id, { status: 'closed' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attendanceSessions'] })
  });

  const downloadQR = (sessionId) => {
    const svg = document.getElementById(`qr-${sessionId}`);
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qr-session-${sessionId}.svg`;
    a.click();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Active Sessions</h2>
        <Button onClick={() => setShowCreate(true)} className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="w-4 h-4 mr-2" /> New Session
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sessions.map(session => {
          const isExpired = session.qr_expiry && new Date(session.qr_expiry) < new Date();
          const displayStatus = isExpired && session.status === 'active' ? 'expired' : session.status;
          const total = (session.actual_labor || 0) + (session.actual_junior || 0) + (session.actual_senior || 0);

          return (
            <Card key={session.id} className={`border-2 ${displayStatus === 'active' ? 'border-emerald-300' : 'border-slate-200'}`}>
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-base">{session.session_name}</CardTitle>
                    <p className="text-sm text-slate-500">{session.site_name} • {format(new Date(session.session_date), 'MMM d, yyyy')}</p>
                  </div>
                  <div className="flex gap-1">
                    <Badge className={MEAL_COLORS[session.meal_type]}>{session.meal_type}</Badge>
                    <Badge variant="outline" className={displayStatus === 'active' ? 'text-green-600 border-green-300' : 'text-slate-500'}>
                      {displayStatus}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {displayStatus === 'active' && (
                  <div className="flex justify-center cursor-pointer" onClick={() => setActiveQR(session)}>
                    <QRCodeSVG
                      id={`qr-${session.id}`}
                      value={session.qr_token}
                      size={150}
                      level="H"
                      includeMargin
                      bgColor="#ffffff"
                      fgColor="#0f172a"
                    />
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  {[['Labor', session.actual_labor, session.expected_labor], ['Junior', session.actual_junior, session.expected_junior], ['Senior', session.actual_senior, session.expected_senior]].map(([cat, actual, expected]) => (
                    <div key={cat} className="bg-slate-50 rounded-lg p-2">
                      <p className="font-semibold text-slate-800">{actual}</p>
                      <p className="text-slate-500">{cat}</p>
                      {expected > 0 && <p className="text-slate-400">/{expected}</p>}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1 text-slate-600">
                    <Users className="w-3 h-3" /> Total: <strong>{total}</strong>
                  </span>
                  {session.qr_expiry && (
                    <span className="flex items-center gap-1 text-slate-500">
                      <Clock className="w-3 h-3" />
                      {displayStatus === 'active' ? `Expires ${format(new Date(session.qr_expiry), 'HH:mm')}` : 'Closed'}
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => downloadQR(session.id)}>
                    <Download className="w-3 h-3 mr-1" /> Download QR
                  </Button>
                  {session.status === 'active' && (
                    <Button variant="outline" size="sm" onClick={() => closeMutation.mutate(session.id)}
                      className="text-red-600 border-red-300 hover:bg-red-50">
                      Close
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Fullscreen QR Dialog */}
      <Dialog open={!!activeQR} onOpenChange={() => setActiveQR(null)}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader>
            <DialogTitle>{activeQR?.session_name}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-4">
            {activeQR && (
              <QRCodeSVG value={activeQR.qr_token} size={260} level="H" includeMargin bgColor="#fff" fgColor="#0f172a" />
            )}
          </div>
          <p className="text-sm text-slate-500">Scan to mark attendance</p>
          {activeQR?.qr_expiry && (
            <p className="text-xs text-slate-400">Expires: {format(new Date(activeQR.qr_expiry), 'HH:mm')}</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Session Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="w-5 h-5" /> Create Attendance Session
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label>Session Name *</Label>
                <Input value={form.session_name} onChange={e => setForm({ ...form, session_name: e.target.value })}
                  placeholder="e.g., Lunch - Block A" className="mt-1" />
              </div>
              <div>
                <Label>Site</Label>
                <Select value={form.site_id} onValueChange={v => setForm({ ...form, site_id: v })}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Select site" /></SelectTrigger>
                  <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Meal Type</Label>
                <Select value={form.meal_type} onValueChange={v => setForm({ ...form, meal_type: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['breakfast', 'lunch', 'dinner', 'snack'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Date</Label>
                <Input type="date" value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label>QR Valid (minutes)</Label>
                <Input type="number" value={form.validity_minutes} onChange={e => setForm({ ...form, validity_minutes: e.target.value })} className="mt-1" />
              </div>
            </div>
            <p className="text-sm font-medium text-slate-700">Expected Count (per category)</p>
            <div className="grid grid-cols-3 gap-3">
              {['labor', 'junior', 'senior'].map(cat => (
                <div key={cat}>
                  <Label className="capitalize text-xs">{cat}</Label>
                  <Input type="number" min="0" value={form[`expected_${cat}`]}
                    onChange={e => setForm({ ...form, [`expected_${cat}`]: parseInt(e.target.value) || 0 })}
                    className="mt-1" />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={!form.session_name || createMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700">
              Generate QR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}