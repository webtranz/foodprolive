import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { QrCode, Send, Camera, TrendingDown, XCircle } from 'lucide-react';
import { format, subDays } from 'date-fns';
import { downloadCSV } from '@/components/utils/exportData';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

const CATEGORY_COLORS = {
  food_item: '#10b981', table: '#3b82f6', event: '#8b5cf6',
  promotion: '#f59e0b', waste_tracking: '#ef4444', attendance: '#06b6d4', custom: '#64748b'
};

export default function QRDashboard() {
  const { data: qrCodes = [] } = useQuery({ queryKey: ['qrCodes'], queryFn: () => base44.entities.QRCode.list() });
  const { data: deliveries = [] } = useQuery({ queryKey: ['qrDeliveries'], queryFn: () => base44.entities.QRDelivery.list() });
  const { data: wasteLogs = [] } = useQuery({ queryKey: ['wasteDetectionLogs'], queryFn: () => base44.entities.WasteDetectionLog.list('-detected_at', 200) });

  const activeQRs = qrCodes.filter(q => q.status === 'active');
  const expiredQRs = qrCodes.filter(q => q.status === 'expired' || (q.expiry_date && new Date(q.expiry_date) < new Date()));
  const oneTimeUsed = qrCodes.filter(q => q.is_one_time && q.scan_count >= 1);
  const sentDeliveries = deliveries.filter(d => d.status === 'sent');

  // Category distribution
  const catData = Object.entries(
    qrCodes.reduce((acc, q) => { acc[q.category] = (acc[q.category] || 0) + 1; return acc; }, {})
  ).map(([cat, count]) => ({ name: cat.replace('_', ' '), value: count, color: CATEGORY_COLORS[cat] || '#64748b' }));

  // Waste trend last 7 days
  const wasteTrend = Array.from({ length: 7 }, (_, i) => {
    const date = subDays(new Date(), 6 - i);
    const dateStr = date.toISOString().split('T')[0];
    const dayLogs = wasteLogs.filter(l => l.detected_at?.startsWith(dateStr));
    return {
      date: format(date, 'EEE'),
      waste_g: dayLogs.reduce((sum, l) => sum + (l.estimated_waste_grams || 0), 0),
      detections: dayLogs.length
    };
  });

  const totalWasteG = wasteLogs.reduce((sum, l) => sum + (l.estimated_waste_grams || 0), 0);
  const totalWasteCost = wasteLogs.reduce((sum, l) => sum + (l.cost_estimate || 0), 0);
  const avgWastePct = wasteLogs.length > 0 ? wasteLogs.reduce((sum, l) => sum + (l.waste_percentage || 0), 0) / wasteLogs.length : 0;

  const stats = [
    { label: 'Active QR Codes', value: activeQRs.length, icon: QrCode, color: 'text-indigo-600', bg: 'bg-indigo-50' },
    { label: 'Expired / Used', value: expiredQRs.length + oneTimeUsed.length, icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
    { label: 'Deliveries Sent', value: sentDeliveries.length, icon: Send, color: 'text-green-600', bg: 'bg-green-50' },
    { label: 'Waste Detections', value: wasteLogs.length, icon: Camera, color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Total Waste', value: `${(totalWasteG / 1000).toFixed(1)} kg`, icon: TrendingDown, color: 'text-red-600', bg: 'bg-red-50' },
    { label: 'Waste Cost', value: `$${totalWasteCost.toFixed(0)}`, icon: TrendingDown, color: 'text-orange-600', bg: 'bg-orange-50' }
  ];

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <div className={`w-9 h-9 rounded-xl ${bg} flex items-center justify-center mb-3`}>
                <Icon className={`w-4 h-4 ${color}`} />
              </div>
              <p className="text-xl font-bold">{value}</p>
              <p className="text-xs text-slate-500 mt-1">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* QR Category Distribution */}
        <Card>
          <CardHeader><CardTitle className="text-base">QR by Category</CardTitle></CardHeader>
          <CardContent>
            {catData.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No QR codes yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={catData} cx="50%" cy="50%" outerRadius={75} dataKey="value" label={({ name, value }) => `${value}`}>
                    {catData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v, n]} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Waste Trend */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle className="text-base">Food Waste Trend (7 Days)</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => downloadCSV(wasteLogs, 'waste_detections')}>
                <Download className="w-3 h-3 mr-1" /> Export
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 mb-4 text-center">
              <div className="flex-1 bg-red-50 rounded-lg p-2">
                <p className="text-lg font-bold text-red-700">{avgWastePct.toFixed(0)}%</p>
                <p className="text-xs text-red-600">Avg Waste %</p>
              </div>
              <div className="flex-1 bg-amber-50 rounded-lg p-2">
                <p className="text-lg font-bold text-amber-700">{(totalWasteG / 1000).toFixed(2)} kg</p>
                <p className="text-xs text-amber-600">Total Waste</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={wasteTrend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="waste_g" fill="#ef4444" name="Waste (g)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Delivery Status */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-base">Recent Deliveries</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => downloadCSV(deliveries, 'qr_deliveries')}>
              <Download className="w-3 h-3 mr-1" /> Export
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {deliveries.slice(0, 10).map(d => (
              <div key={d.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-medium">{d.qr_code_title}</span>
                  <Badge variant="outline" className="text-xs">{d.delivery_method}</Badge>
                </div>
                <div className="flex items-center gap-2 text-slate-500 text-xs">
                  <span>{d.recipients?.length || 0} recipients</span>
                  <Badge className={d.status === 'sent' ? 'bg-green-600' : d.status === 'scheduled' ? 'bg-blue-600' : 'bg-slate-400'}>
                    {d.status}
                  </Badge>
                </div>
              </div>
            ))}
            {deliveries.length === 0 && <p className="text-slate-400 text-sm text-center py-4">No deliveries yet</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}