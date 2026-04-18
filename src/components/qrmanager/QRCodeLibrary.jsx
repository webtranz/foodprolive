import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Download, Send, Trash2, QrCode, Clock, CheckCircle2, Copy } from 'lucide-react';
import { format } from 'date-fns';

const CATEGORIES = [
  { value: 'food_item', label: '🍽️ Food Item' },
  { value: 'table', label: '🪑 Table' },
  { value: 'event', label: '🎉 Event' },
  { value: 'promotion', label: '🏷️ Promotion' },
  { value: 'waste_tracking', label: '♻️ Waste Tracking' },
  { value: 'attendance', label: '✅ Attendance' },
  { value: 'custom', label: '⚙️ Custom' }
];

const STATUS_STYLES = {
  active: 'bg-green-100 text-green-800',
  expired: 'bg-red-100 text-red-800',
  disabled: 'bg-slate-100 text-slate-600'
};

export default function QRCodeLibrary({ onSendQR }) {
  const [showCreate, setShowCreate] = useState(false);
  const [viewQR, setViewQR] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [form, setForm] = useState({
    title: '', category: 'custom', description: '', is_one_time: false,
    max_scans: 0, expiry_date: '', linked_item: ''
  });
  const [copied, setCopied] = useState(null);

  const queryClient = useQueryClient();

  const { data: qrCodes = [] } = useQuery({
    queryKey: ['qrCodes'],
    queryFn: () => base44.entities.QRCode.list('-created_date', 200)
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      const payload = {
        id: Math.random().toString(36).slice(2),
        cat: data.category,
        title: data.title,
        created: new Date().toISOString(),
        one_time: data.is_one_time,
        exp: data.expiry_date || null,
        rand: Math.random().toString(36).slice(2, 8)
      };
      const token = btoa(JSON.stringify(payload));
      return base44.entities.QRCode.create({
        ...data,
        token,
        scan_count: 0,
        status: 'active',
        max_scans: data.is_one_time ? 1 : parseInt(data.max_scans) || 0
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['qrCodes'] });
      setShowCreate(false);
      setForm({ title: '', category: 'custom', description: '', is_one_time: false, max_scans: 0, expiry_date: '', linked_item: '' });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.QRCode.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['qrCodes'] })
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.QRCode.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['qrCodes'] })
  });

  const downloadQR = (qr) => {
    const svg = document.getElementById(`lib-qr-${qr.id}`);
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${qr.title.replace(/\s+/g, '_')}.svg`;
    a.click();
  };

  const copyToken = (id, token) => {
    navigator.clipboard.writeText(token);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const filtered = qrCodes.filter(qr => {
    const matchSearch = qr.title?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchCat = filterCat === 'all' || qr.category === filterCat;
    return matchSearch && matchCat;
  });

  const isExpiredNow = (qr) => qr.expiry_date && new Date(qr.expiry_date) < new Date();

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex gap-2 flex-1">
          <Input placeholder="Search QR codes..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="max-w-xs" />
          <Select value={filterCat} onValueChange={setFilterCat}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowCreate(true)} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="w-4 h-4 mr-2" /> Generate QR
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map(qr => {
          const expired = isExpiredNow(qr) || qr.status !== 'active';
          const status = expired ? 'expired' : qr.status;
          return (
            <Card key={qr.id} className={`border-2 ${status === 'active' ? 'border-indigo-200' : 'border-slate-200 opacity-75'}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{qr.title}</p>
                    <p className="text-xs text-slate-500 capitalize">{qr.category?.replace('_', ' ')}</p>
                  </div>
                  <Badge className={STATUS_STYLES[status]}>{status}</Badge>
                </div>

                <div className="flex justify-center cursor-pointer" onClick={() => setViewQR(qr)}>
                  <div className={`p-2 rounded-xl border-2 ${status === 'active' ? 'border-indigo-200 bg-white' : 'border-slate-200 bg-slate-50 grayscale'}`}>
                    <QRCodeSVG id={`lib-qr-${qr.id}`} value={qr.token} size={120} level="H" includeMargin bgColor="#ffffff" fgColor="#1e1b4b" />
                  </div>
                </div>

                <div className="text-xs space-y-1 text-slate-600">
                  <div className="flex justify-between">
                    <span>Scans</span>
                    <span className="font-medium">{qr.scan_count || 0}{qr.max_scans > 0 ? ` / ${qr.max_scans}` : ''}</span>
                  </div>
                  {qr.is_one_time && <div className="flex items-center gap-1 text-amber-600"><Clock className="w-3 h-3" /> One-time use</div>}
                  {qr.expiry_date && <div className="text-slate-400">Exp: {format(new Date(qr.expiry_date), 'MMM d, HH:mm')}</div>}
                </div>

                <div className="flex gap-1">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => downloadQR(qr)}>
                    <Download className="w-3 h-3" />
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => copyToken(qr.id, qr.token)}>
                    {copied === qr.id ? <CheckCircle2 className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                  </Button>
                  {onSendQR && (
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => onSendQR(qr)}>
                      <Send className="w-3 h-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="text-red-500" onClick={() => deleteMutation.mutate(qr.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full text-center py-16 text-slate-400">
            <QrCode className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No QR codes found. Generate your first one.</p>
          </div>
        )}
      </div>

      {/* Fullscreen View */}
      <Dialog open={!!viewQR} onOpenChange={() => setViewQR(null)}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader><DialogTitle>{viewQR?.title}</DialogTitle></DialogHeader>
          <div className="flex justify-center py-4">
            {viewQR && <QRCodeSVG value={viewQR.token} size={260} level="H" includeMargin bgColor="#fff" fgColor="#1e1b4b" />}
          </div>
          <p className="text-xs text-slate-400 break-all">{viewQR?.token?.slice(0, 40)}...</p>
          {viewQR?.expiry_date && <p className="text-xs text-slate-500 mt-1">Expires: {format(new Date(viewQR.expiry_date), 'PPp')}</p>}
          <Button className="mt-2 w-full" onClick={() => downloadQR(viewQR)}>
            <Download className="w-4 h-4 mr-2" /> Download
          </Button>
        </DialogContent>
      </Dialog>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><QrCode className="w-5 h-5" /> Generate New QR Code</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label>Title *</Label>
                <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="QR code name" className="mt-1" />
              </div>
              <div>
                <Label>Category</Label>
                <Select value={form.category} onValueChange={v => setForm({ ...form, category: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Linked Item (optional)</Label>
                <Input value={form.linked_item} onChange={e => setForm({ ...form, linked_item: e.target.value })} placeholder="Table 5, Event A..." className="mt-1" />
              </div>
              <div>
                <Label>Expiry Date/Time</Label>
                <Input type="datetime-local" value={form.expiry_date} onChange={e => setForm({ ...form, expiry_date: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label>Max Scans (0 = unlimited)</Label>
                <Input type="number" value={form.max_scans} onChange={e => setForm({ ...form, max_scans: e.target.value })} className="mt-1" disabled={form.is_one_time} />
              </div>
              <div className="col-span-2">
                <Label>Description</Label>
                <Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="mt-1" rows={2} />
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
              <Switch checked={form.is_one_time} onCheckedChange={v => setForm({ ...form, is_one_time: v, max_scans: v ? 1 : 0 })} />
              <div>
                <p className="text-sm font-medium">One-Time Scan Only</p>
                <p className="text-xs text-slate-500">QR auto-expires after first successful scan</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={!form.title || createMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700">
              Generate QR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}