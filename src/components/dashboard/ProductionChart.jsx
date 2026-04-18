import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function ProductionChart({ data }) {
  const chartData = data || [
    { day: 'Mon', servings: 1200, target: 1000 },
    { day: 'Tue', servings: 980, target: 1000 },
    { day: 'Wed', servings: 1350, target: 1200 },
    { day: 'Thu', servings: 1100, target: 1100 },
    { day: 'Fri', servings: 1450, target: 1300 },
    { day: 'Sat', servings: 800, target: 800 },
    { day: 'Sun', servings: 650, target: 700 },
  ];

  return (
    <Card className="border-slate-100 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-slate-900">
          Weekly Production Overview
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="servingsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#059669" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis 
                dataKey="day" 
                axisLine={false} 
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 12 }}
              />
              <YAxis 
                axisLine={false} 
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 12 }}
              />
              <Tooltip 
                contentStyle={{ 
                  borderRadius: '12px', 
                  border: '1px solid #e2e8f0',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                }}
              />
              <Area 
                type="monotone" 
                dataKey="target" 
                stroke="#94a3b8" 
                strokeWidth={2}
                strokeDasharray="5 5"
                fill="none"
                name="Target"
              />
              <Area 
                type="monotone" 
                dataKey="servings" 
                stroke="#059669" 
                strokeWidth={2}
                fill="url(#servingsGradient)"
                name="Actual"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}