import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Utensils, PartyPopper, CalendarDays, Download, Copy, ExternalLink } from 'lucide-react';
import { createPageUrl } from '@/utils';

const QR_ITEMS = [
  {
    id: 'daily_meal',
    title: 'Daily Meal Check-In',
    description: 'Staff scan this QR code to check in for breakfast, lunch, or dinner each day.',
    page: 'DailyMealCheckin',
    icon: Utensils,
    color: 'emerald',
    badge: 'Daily',
    badgeColor: 'bg-emerald-100 text-emerald-700'
  },
  {
    id: 'event_dining',
    title: 'Event Dining Check-In',
    description: 'Guests scan to check in for a specific dining hall event.',
    page: 'EventDiningCheckin',
    icon: PartyPopper,
    color: 'violet',
    badge: 'Events',
    badgeColor: 'bg-violet-100 text-violet-700'
  },
  {
    id: 'event_inquiry',
    title: 'Event Booking & Inquiry',
    description: 'Customers scan to submit a catering booking request or general inquiry.',
    page: 'EventInquiry',
    icon: CalendarDays,
    color: 'amber',
    badge: 'Bookings',
    badgeColor: 'bg-amber-100 text-amber-700'
  }
];

const COLOR_MAP = {
  emerald: { bg: 'bg-emerald-50', border: 'border-emerald-200', btn: 'bg-emerald-600 hover:bg-emerald-700', icon: 'bg-emerald-100 text-emerald-600', qr: '#059669' },
  violet:  { bg: 'bg-violet-50',  border: 'border-violet-200',  btn: 'bg-violet-600 hover:bg-violet-700',  icon: 'bg-violet-100 text-violet-600',  qr: '#7c3aed' },
  amber:   { bg: 'bg-amber-50',   border: 'border-amber-200',   btn: 'bg-amber-600 hover:bg-amber-700',   icon: 'bg-amber-100 text-amber-600',   qr: '#d97706' }
};

function QRCard({ item }) {
  const [copied, setCopied] = useState(false);
  const c = COLOR_MAP[item.color];
  const Icon = item.icon;
  const url = `${window.location.origin}${createPageUrl(item.page)}`;

  const copyUrl = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadQR = () => {
    const svg = document.getElementById(`qr-svg-${item.id}`);
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, 400, 400); const a = document.createElement('a'); a.download = `${item.id}_qr.png`; a.href = canvas.toDataURL(); a.click(); };
    img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
  };

  return (
    <Card className={`border-2 ${c.border} ${c.bg} rounded-2xl overflow-hidden`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className={`w-12 h-12 rounded-xl ${c.icon} flex items-center justify-center`}>
            <Icon className="w-6 h-6" />
          </div>
          <Badge className={item.badgeColor}>{item.badge}</Badge>
        </div>
        <CardTitle className="text-lg mt-3">{item.title}</CardTitle>
        <p className="text-sm text-slate-500 leading-relaxed">{item.description}</p>
      </CardHeader>
      <CardContent className="pt-0">
        {/* QR Code */}
        <div className="bg-white rounded-xl p-4 flex items-center justify-center mb-4 border border-slate-100">
          <QRCodeSVG
            id={`qr-svg-${item.id}`}
            value={url}
            size={180}
            fgColor={c.qr}
            level="M"
            includeMargin={false}
          />
        </div>

        {/* URL */}
        <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-500 mb-3 font-mono break-all">
          {url}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button onClick={copyUrl} variant="outline" size="sm" className="flex-1 rounded-lg">
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            {copied ? 'Copied!' : 'Copy Link'}
          </Button>
          <Button onClick={downloadQR} size="sm" className={`flex-1 rounded-lg text-white ${c.btn}`}>
            <Download className="w-3.5 h-3.5 mr-1.5" /> Download QR
          </Button>
          <Button asChild size="sm" variant="ghost" className="rounded-lg px-2">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PublicQRManager() {
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-100 p-5">
        <h2 className="text-lg font-semibold text-slate-800">Public QR Codes</h2>
        <p className="text-sm text-slate-500 mt-1">
          Print or share these QR codes. Anyone who scans them will be taken to the public form — no login required.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {QR_ITEMS.map(item => <QRCard key={item.id} item={item} />)}
      </div>
    </div>
  );
}