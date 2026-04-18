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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, QrCode, Clock, Download, Eye, Mail, Copy, MessageSquare, Send, Phone } from 'lucide-react';
import { format, addMinutes } from 'date-fns';

const MEAL_COLORS = {
  breakfast: 'bg-amber-500', lunch: 'bg-emerald-500', dinner: 'bg-indigo-500', snack: 'bg-purple-500'
};

const CAT_COLORS = {
  labor: 'bg-blue-100 text-blue-800', junior: 'bg-purple-100 text-purple-800', senior: 'bg-amber-100 text-amber-800'
};

export default function SessionQRManager() {
  const [showCreate, setShowCreate] = useState(false);
  const [showUsersDialog, setShowUsersDialog] = useState(false);
  const [selectedSession, setSelectedSession] = useState(null);
  const [selectedUserQR, setSelectedUserQR] = useState(null);
  const [showBulkSend, setShowBulkSend] = useState(false);
  const [bulkSendSession, setBulkSendSession] = useState(null);
  const [bulkSendMethod, setBulkSendMethod] = useState('sms'); // sms | email | whatsapp
  const [bulkSendStatus, setBulkSendStatus] = useState(null); // null | sending | done

  const [form, setForm] = useState({
    session_name: '',
    site_id: '',
    meal_type: 'lunch',
    session_date: new Date().toISOString().split('T')[0],
    validity_minutes: 120,
    selected_groups: [],
    notes: ''
  });

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: groups = [] } = useQuery({ queryKey: ['userGroups'], queryFn: () => base44.entities.UserGroup.list() });
  const { data: sessions = [] } = useQuery({
    queryKey: ['attendanceSessions'],
    queryFn: () => base44.entities.AttendanceSession.list('-session_date', 100)
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      const expiry = addMinutes(new Date(), parseInt(data.validity_minutes));
      const site = sites.find(s => s.id === data.site_id);

      // Collect all members from selected groups
      const allMembers = [];
      data.selected_groups.forEach(gid => {
        const group = groups.find(g => g.id === gid);
        group?.members?.forEach(m => allMembers.push(m));
      });

      // Generate unique QR token per user
      const registeredUsers = allMembers.map((member, idx) => {
        const payload = {
          sid: `${data.session_name}-${data.session_date}-${data.meal_type}`,
          uid: member.user_id || `u${idx}`,
          name: member.name,
          cat: member.category,
          meal: data.meal_type,
          date: data.session_date,
          exp: expiry.toISOString(),
          rand: Math.random().toString(36).slice(2, 8)
        };
        return {
          ...member,
          qr_token: btoa(JSON.stringify(payload)),
          has_scanned: false
        };
      });

      return base44.entities.AttendanceSession.create({
        session_name: data.session_name,
        site_id: data.site_id,
        site_name: site?.name || '',
        meal_type: data.meal_type,
        session_date: data.session_date,
        qr_expiry: expiry.toISOString(),
        validity_minutes: parseInt(data.validity_minutes),
        status: 'active',
        user_group_ids: data.selected_groups,
        registered_users: registeredUsers,
        max_capacity: registeredUsers.length,
        actual_labor: 0,
        actual_junior: 0,
        actual_senior: 0,
        notes: data.notes
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendanceSessions'] });
      setShowCreate(false);
      setForm({ session_name: '', site_id: '', meal_type: 'lunch', session_date: new Date().toISOString().split('T')[0], validity_minutes: 120, selected_groups: [], notes: '' });
    }
  });

  const closeMutation = useMutation({
    mutationFn: (id) => base44.entities.AttendanceSession.update(id, { status: 'closed' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attendanceSessions'] })
  });

  const toggleGroup = (gid) => {
    setForm(f => ({
      ...f,
      selected_groups: f.selected_groups.includes(gid)
        ? f.selected_groups.filter(g => g !== gid)
        : [...f.selected_groups, gid]
    }));
  };

  const totalFromGroups = form.selected_groups.reduce((sum, gid) => {
    const g = groups.find(gr => gr.id === gid);
    return sum + (g?.total_members || 0);
  }, 0);

  const copyTokenToClipboard = (user) => {
    navigator.clipboard.writeText(user.qr_token || '');
    alert(`QR token for ${user.name} copied to clipboard!`);
  };

  const shareUserQR = (session, user) => {
    const text = buildMessage(session, user);
    navigator.clipboard.writeText(text);
    alert(`QR details for ${user.name} copied to clipboard!`);
  };

  const buildMessage = (session, user) =>
    `🍽️ *Attendance QR Code*\nHi ${user.name},\nYour QR token for *${session.session_name}*:\n📅 ${session.session_date} | 🕐 ${session.meal_type}\n👤 Category: ${user.category}\n\n🔑 Token:\n${user.qr_token}\n\n${session.qr_expiry ? `⏰ Expires: ${format(new Date(session.qr_expiry), 'PPp')}` : ''}`;

  const sendViaSMS = (user, session) => {
    const text = encodeURIComponent(buildMessage(session, user));
    const phone = user.phone?.replace(/\D/g, '');
    if (!phone) { alert(`No phone number for ${user.name}`); return; }
    window.open(`sms:${phone}?body=${text}`, '_blank');
  };

  const sendViaWhatsApp = (user, session) => {
    const text = encodeURIComponent(buildMessage(session, user));
    const phone = user.phone?.replace(/\D/g, '');
    if (!phone) { alert(`No phone number for ${user.name}`); return; }
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
  };

  const sendViaEmail = (user, session) => {
    if (!user.email) { alert(`No email for ${user.name}`); return; }
    const subject = encodeURIComponent(`Your QR Code — ${session.session_name}`);
    const body = encodeURIComponent(buildMessage(session, user));
    window.open(`mailto:${user.email}?subject=${subject}&body=${body}`, '_blank');
  };

  const openBulkSend = (session) => {
    setBulkSendSession(session);
    setBulkSendMethod('whatsapp');
    setBulkSendStatus(null);
    setShowBulkSend(true);
  };

  const handleBulkSend = (method) => {
    const users = bulkSendSession?.registered_users || [];
    setBulkSendStatus('sending');
    let sent = 0;
    users.forEach((user, idx) => {
      setTimeout(() => {
        if (method === 'sms') sendViaSMS(user, bulkSendSession);
        else if (method === 'whatsapp') sendViaWhatsApp(user, bulkSendSession);
        else if (method === 'email') sendViaEmail(user, bulkSendSession);
        if (idx === users.length - 1) setBulkSendStatus('done');
      }, idx * 400); // stagger to avoid popup blockers
    });
  };

  const downloadUserQR = (user, session) => {
    const svgEl = document.getElementById(`user-qr-${user.user_id}`);
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qr-${user.name?.replace(/\s/g, '_')}.svg`;
    a.click();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Sessions & User QR Codes</h2>
        <Button onClick={() => setShowCreate(true)} className="bg-emerald-600 hover:bg-emerald-700">
          <Plus className="w-4 h-4 mr-2" /> New Session
        </Button>
      </div>

      {/* Sessions Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sessions.map(session => {
          const isExpired = session.qr_expiry && new Date(session.qr_expiry) < new Date();
          const displayStatus = (isExpired && session.status === 'active') ? 'expired' : session.status;
          const scannedCount = session.registered_users?.filter(u => u.has_scanned).length || 0;
          const total = session.registered_users?.length || 0;

          return (
            <Card key={session.id} className={`border-2 ${displayStatus === 'active' ? 'border-emerald-300' : 'border-slate-200'}`}>
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-base">{session.session_name}</CardTitle>
                    <p className="text-xs text-slate-500">{session.site_name} • {session.session_date}</p>
                  </div>
                  <div className="flex gap-1 flex-wrap justify-end">
                    <Badge className={MEAL_COLORS[session.meal_type]}>{session.meal_type}</Badge>
                    <Badge variant="outline" className={displayStatus === 'active' ? 'text-green-600 border-green-300' : ''}>{displayStatus}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Capacity bar */}
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-600">Scanned: {scannedCount}/{total}</span>
                    <span className="text-slate-400">{total > 0 ? Math.round((scannedCount / total) * 100) : 0}%</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2">
                    <div className="bg-emerald-500 h-2 rounded-full" style={{ width: total > 0 ? `${(scannedCount / total) * 100}%` : '0%' }} />
                  </div>
                </div>

                {session.qr_expiry && (
                  <p className="text-xs text-slate-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {displayStatus === 'active' ? `Expires ${format(new Date(session.qr_expiry), 'HH:mm')}` : 'Session closed'}
                  </p>
                )}

                <div className="flex gap-2 flex-wrap">
                  <Button variant="outline" size="sm" className="flex-1"
                    onClick={() => { setSelectedSession(session); setShowUsersDialog(true); }}>
                    <Eye className="w-3 h-3 mr-1" /> View QRs ({total})
                  </Button>
                  <Button variant="outline" size="sm" className="text-indigo-600 border-indigo-300 hover:bg-indigo-50"
                    onClick={() => openBulkSend(session)}>
                    <Send className="w-3 h-3 mr-1" /> Send
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
        {sessions.length === 0 && (
          <div className="col-span-full text-center py-12 text-slate-400">
            <QrCode className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>No sessions yet. Create one linked to a user group.</p>
          </div>
        )}
      </div>

      {/* Create Session Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><QrCode className="w-5 h-5" /> Create Session with User QR Codes</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label>Session Name *</Label>
                <Input value={form.session_name} onChange={e => setForm(f => ({ ...f, session_name: e.target.value }))} placeholder="e.g., Lunch - Block A" className="mt-1" />
              </div>
              <div>
                <Label>Site</Label>
                <Select value={form.site_id} onValueChange={v => setForm(f => ({ ...f, site_id: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Select site" /></SelectTrigger>
                  <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Meal Type</Label>
                <Select value={form.meal_type} onValueChange={v => setForm(f => ({ ...f, meal_type: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['breakfast', 'lunch', 'dinner', 'snack'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Date</Label>
                <Input type="date" value={form.session_date} onChange={e => setForm(f => ({ ...f, session_date: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>QR Valid (minutes)</Label>
                <Input type="number" value={form.validity_minutes} onChange={e => setForm(f => ({ ...f, validity_minutes: e.target.value }))} className="mt-1" />
              </div>
            </div>

            {/* Group Selection */}
            <div>
              <Label className="mb-2 block">Select User Groups *</Label>
              {groups.length === 0 ? (
                <p className="text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">No user groups found. Create groups in the "User Groups" tab first.</p>
              ) : (
                <div className="space-y-2 border rounded-lg p-3 max-h-48 overflow-y-auto">
                  {groups.map(group => (
                    <label key={group.id} className="flex items-center gap-3 cursor-pointer hover:bg-slate-50 p-2 rounded">
                      <Checkbox
                        checked={form.selected_groups.includes(group.id)}
                        onCheckedChange={() => toggleGroup(group.id)}
                      />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{group.name}</p>
                        <p className="text-xs text-slate-500">{group.total_members || 0} members</p>
                      </div>
                      <div className="flex gap-1">
                        {group.labor_count > 0 && <Badge className="text-xs bg-blue-100 text-blue-800">L:{group.labor_count}</Badge>}
                        {group.junior_count > 0 && <Badge className="text-xs bg-purple-100 text-purple-800">J:{group.junior_count}</Badge>}
                        {group.senior_count > 0 && <Badge className="text-xs bg-amber-100 text-amber-800">S:{group.senior_count}</Badge>}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {totalFromGroups > 0 && (
                <p className="text-sm text-emerald-600 mt-2 font-medium">
                  ✓ {totalFromGroups} unique QR codes will be generated
                </p>
              )}
            </div>

            <div>
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate(form)}
              disabled={!form.session_name || form.selected_groups.length === 0 || createMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {createMutation.isPending ? 'Generating...' : `Generate ${totalFromGroups} QR Codes`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Users QR Codes Dialog */}
      <Dialog open={showUsersDialog} onOpenChange={setShowUsersDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>User QR Codes — {selectedSession?.session_name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <p className="text-sm text-slate-600">
                {selectedSession?.registered_users?.length || 0} unique QR codes • 
                {selectedSession?.registered_users?.filter(u => u.has_scanned).length || 0} scanned
              </p>
              <Button size="sm" variant="outline"
                onClick={() => {
                  const tokens = selectedSession?.registered_users?.map(u => `${u.name} (${u.category}): ${u.qr_token}`).join('\n');
                  navigator.clipboard.writeText(tokens || '');
                  alert('All tokens copied to clipboard!');
                }}>
                <Copy className="w-3 h-3 mr-1" /> Copy All Tokens
              </Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {selectedSession?.registered_users?.map((user) => (
                <div key={user.user_id}
                  className={`border-2 rounded-xl p-3 text-center space-y-2 ${user.has_scanned ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-white'}`}
                  onClick={() => setSelectedUserQR(user)}>
                  <div className="flex justify-center">
                    <QRCodeSVG
                      id={`user-qr-${user.user_id}`}
                      value={user.qr_token || 'invalid'}
                      size={90}
                      level="H"
                      includeMargin
                      bgColor={user.has_scanned ? '#f0fdf4' : '#ffffff'}
                      fgColor={user.has_scanned ? '#16a34a' : '#1e1b4b'}
                    />
                  </div>
                  <p className="text-xs font-semibold truncate">{user.name}</p>
                  <Badge className={`text-xs ${CAT_COLORS[user.category]}`}>{user.category}</Badge>
                  {user.has_scanned && <Badge className="text-xs bg-green-600 text-white w-full">✓ Scanned</Badge>}
                  <div className="flex gap-1 flex-wrap justify-center">
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Download QR"
                      onClick={e => { e.stopPropagation(); downloadUserQR(user, selectedSession); }}>
                      <Download className="w-2.5 h-2.5" />
                    </Button>
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs text-green-600 border-green-300" title="Send via WhatsApp"
                      onClick={e => { e.stopPropagation(); sendViaWhatsApp(user, selectedSession); }}>
                      <MessageSquare className="w-2.5 h-2.5" />
                    </Button>
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs text-blue-600 border-blue-300" title="Send via SMS"
                      onClick={e => { e.stopPropagation(); sendViaSMS(user, selectedSession); }}>
                      <Phone className="w-2.5 h-2.5" />
                    </Button>
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs text-indigo-600 border-indigo-300" title="Send via Email"
                      onClick={e => { e.stopPropagation(); sendViaEmail(user, selectedSession); }}>
                      <Mail className="w-2.5 h-2.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Send Dialog */}
      <Dialog open={showBulkSend} onOpenChange={setShowBulkSend}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5" /> Bulk Send QR Codes
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Session: <strong>{bulkSendSession?.session_name}</strong><br />
              Recipients: <strong>{bulkSendSession?.registered_users?.length || 0}</strong> users
            </p>

            <div>
              <Label className="mb-2 block">Send Method</Label>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => setBulkSendMethod('whatsapp')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 text-sm font-medium transition-all ${bulkSendMethod === 'whatsapp' ? 'border-green-500 bg-green-50 text-green-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  <MessageSquare className="w-6 h-6" />
                  WhatsApp
                </button>
                <button onClick={() => setBulkSendMethod('sms')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 text-sm font-medium transition-all ${bulkSendMethod === 'sms' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  <Phone className="w-6 h-6" />
                  SMS
                </button>
                <button onClick={() => setBulkSendMethod('email')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 text-sm font-medium transition-all ${bulkSendMethod === 'email' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  <Mail className="w-6 h-6" />
                  Email
                </button>
              </div>
            </div>

            {bulkSendMethod !== 'email' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                ⚠️ {bulkSendMethod === 'whatsapp' ? 'WhatsApp' : 'SMS'} will open a new tab/window for each user. Your browser may ask to allow popups. Make sure users have phone numbers saved in their group.
              </div>
            )}
            {bulkSendMethod === 'email' && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
                📧 Email will open your default mail client for each user. Make sure users have email addresses saved.
              </div>
            )}

            {bulkSendStatus === 'done' && (
              <div className="bg-green-50 border border-green-300 rounded-lg p-3 text-sm text-green-700 font-medium">
                ✅ Bulk send initiated for all {bulkSendSession?.registered_users?.length} users!
              </div>
            )}

            {/* Per-user summary */}
            <div className="border rounded-lg max-h-40 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left p-2">Name</th>
                    <th className="text-left p-2">Phone</th>
                    <th className="text-left p-2">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkSendSession?.registered_users?.map((u, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2">{u.name}</td>
                      <td className={`p-2 ${u.phone ? 'text-slate-700' : 'text-red-400'}`}>{u.phone || '—'}</td>
                      <td className={`p-2 ${u.email ? 'text-slate-700' : 'text-red-400'}`}>{u.email || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkSend(false)}>Cancel</Button>
            <Button
              onClick={() => handleBulkSend(bulkSendMethod)}
              disabled={bulkSendStatus === 'sending'}
              className={bulkSendMethod === 'whatsapp' ? 'bg-green-600 hover:bg-green-700' : bulkSendMethod === 'sms' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-indigo-600 hover:bg-indigo-700'}
            >
              {bulkSendStatus === 'sending' ? 'Sending...' : `Send via ${bulkSendMethod === 'whatsapp' ? 'WhatsApp' : bulkSendMethod === 'sms' ? 'SMS' : 'Email'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single User QR Fullscreen */}
      <Dialog open={!!selectedUserQR} onOpenChange={() => setSelectedUserQR(null)}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader><DialogTitle>{selectedUserQR?.name}</DialogTitle></DialogHeader>
          <Badge className={`mx-auto ${CAT_COLORS[selectedUserQR?.category]}`}>{selectedUserQR?.category}</Badge>
          <div className="flex justify-center py-4">
            {selectedUserQR && (
              <QRCodeSVG value={selectedUserQR.qr_token} size={240} level="H" includeMargin bgColor="#fff" fgColor="#1e1b4b" />
            )}
          </div>
          {selectedUserQR?.has_scanned && <Badge className="bg-green-600 text-white">✓ Already Scanned</Badge>}
          <Button className="w-full mt-2" onClick={() => downloadUserQR(selectedUserQR, {})}>
            <Download className="w-4 h-4 mr-2" /> Download QR
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}