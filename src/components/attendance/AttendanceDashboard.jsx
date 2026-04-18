import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { Users, TrendingUp, Calendar, Clock } from 'lucide-react';
import { format, subDays, startOfWeek } from 'date-fns';

const CAT_COLORS = { labor: '#3b82f6', junior: '#8b5cf6', senior: '#f59e0b' };

export default function AttendanceDashboard() {
  const { data: records = [] } = useQuery({
    queryKey: ['attendanceRecords'],
    queryFn: () => base44.entities.AttendanceRecord.list('-marked_at', 500)
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ['attendanceSessions'],
    queryFn: () => base44.entities.AttendanceSession.list('-session_date', 100)
  });

  const today = new Date().toISOString().split('T')[0];

  const todayRecords = records.filter(r => r.session_date === today);
  const weekStart = startOfWeek(new Date());
  const weekRecords = records.filter(r => new Date(r.session_date) >= weekStart);

  // Last 7 days chart data
  const dailyData = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = subDays(new Date(), 6 - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayRecords = records.filter(r => r.session_date === dateStr);
      return {
        date: format(date, 'EEE'),
        labor: dayRecords.filter(r => r.category === 'labor').length,
        junior: dayRecords.filter(r => r.category === 'junior').length,
        senior: dayRecords.filter(r => r.category === 'senior').length,
        total: dayRecords.length
      };
    });
  }, [records]);

  // Pie chart data for today
  const pieData = [
    { name: 'Labor', value: todayRecords.filter(r => r.category === 'labor').length },
    { name: 'Junior', value: todayRecords.filter(r => r.category === 'junior').length },
    { name: 'Senior', value: todayRecords.filter(r => r.category === 'senior').length }
  ].filter(d => d.value > 0);

  // Meal-wise today
  const mealData = ['breakfast', 'lunch', 'dinner', 'snack'].map(meal => ({
    meal,
    count: todayRecords.filter(r => r.meal_type === meal).length
  })).filter(m => m.count > 0);

  const activeSessions = sessions.filter(s => s.status === 'active').length;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Today's Attendance", value: todayRecords.length, icon: Users, color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: 'This Week', value: weekRecords.length, icon: Calendar, color: 'text-blue-600', bg: 'bg-blue-50' },
          { label: 'Active Sessions', value: activeSessions, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
          { label: 'Total Records', value: records.length, icon: TrendingUp, color: 'text-purple-600', bg: 'bg-purple-50' }
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">{label}</p>
                  <p className="text-2xl font-bold mt-1">{value}</p>
                </div>
                <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Today category breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {['labor', 'junior', 'senior'].map(cat => {
          const count = todayRecords.filter(r => r.category === cat).length;
          const sessions_today = sessions.filter(s => s.session_date === today);
          const expected = sessions_today.reduce((sum, s) => sum + (s[`expected_${cat}`] || 0), 0);
          const pct = expected > 0 ? Math.min(100, Math.round((count / expected) * 100)) : 0;
          return (
            <Card key={cat}>
              <CardContent className="pt-5">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <p className="text-sm text-slate-500 capitalize">{cat}</p>
                    <p className="text-3xl font-bold mt-1">{count}</p>
                  </div>
                  {expected > 0 && <Badge variant="outline">Expected: {expected}</Badge>}
                </div>
                {expected > 0 && (
                  <div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: CAT_COLORS[cat] }} />
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{pct}% of expected</p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">7-Day Attendance Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="labor" fill={CAT_COLORS.labor} name="Labor" />
                <Bar dataKey="junior" fill={CAT_COLORS.junior} name="Junior" />
                <Bar dataKey="senior" fill={CAT_COLORS.senior} name="Senior" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today's Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-slate-400">No data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={75} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={Object.values(CAT_COLORS)[i]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Total trend line */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Total Attendance Trend (Last 7 Days)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="total" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} name="Total" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}