import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Factory } from 'lucide-react';
import { format } from 'date-fns';

export default function ProductionReportChart({ productions }) {
  const chartData = useMemo(() => {
    const dataByDate = {};
    
    productions.forEach(p => {
      const date = format(new Date(p.production_date), 'MMM dd');
      if (!dataByDate[date]) {
        dataByDate[date] = { date, servings: 0, completed: 0, planned: 0 };
      }
      
      dataByDate[date].servings += p.target_servings || 0;
      if (p.status === 'completed') dataByDate[date].completed++;
      if (p.status === 'planned') dataByDate[date].planned++;
    });

    return Object.values(dataByDate).slice(-14);
  }, [productions]);

  const totalServings = productions.reduce((sum, p) => sum + (p.target_servings || 0), 0);
  const completedCount = productions.filter(p => p.status === 'completed').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Factory className="w-5 h-5 text-emerald-600" />
          Production Report
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-emerald-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Total Servings Produced</p>
            <p className="text-2xl font-bold text-emerald-700">{totalServings}</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Completed Productions</p>
            <p className="text-2xl font-bold text-blue-700">{completedCount}</p>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="servings" fill="#10b981" name="Servings Produced" />
            <Bar dataKey="completed" fill="#3b82f6" name="Completed" />
            <Bar dataKey="planned" fill="#f59e0b" name="Planned" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}