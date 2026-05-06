import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { formatCurrency, SAR_SYMBOL } from '@/lib/currency';

const COLORS = ['#ef4444', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#10b981'];

export default function WasteAnalysisChart({ waste }) {
  const wasteByCategory = useMemo(() => {
    const byCategory = {};
    waste.forEach(w => {
      const cat = w.waste_category || 'other';
      if (!byCategory[cat]) {
        byCategory[cat] = { category: cat.replace(/_/g, ' '), quantity: 0, cost: 0 };
      }
      byCategory[cat].quantity += w.quantity || 0;
      byCategory[cat].cost += w.estimated_cost || 0;
    });
    return Object.values(byCategory);
  }, [waste]);

  const totalWaste = waste.reduce((sum, w) => sum + (w.quantity || 0), 0);
  const totalCost = waste.reduce((sum, w) => sum + (w.estimated_cost || 0), 0);
  const preventableWaste = waste.filter(w => w.preventable).reduce((sum, w) => sum + (w.quantity || 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600" />
          Waste Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-red-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Total Waste</p>
            <p className="text-2xl font-bold text-red-700">{totalWaste.toFixed(1)} kg</p>
          </div>
          <div className="bg-orange-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Estimated Cost</p>
            <p className="text-2xl font-bold text-orange-700">{formatCurrency(totalCost)}</p>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Preventable Waste</p>
            <p className="text-2xl font-bold text-purple-700">{preventableWaste.toFixed(1)} kg</p>
          </div>
        </div>

        <h4 className="font-medium mb-4">Waste by Category</h4>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={wasteByCategory}
              dataKey="quantity"
              nameKey="category"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label
            >
              {wasteByCategory.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>

        <h4 className="font-medium mb-4 mt-6">Waste Cost Breakdown</h4>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={wasteByCategory}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="category" angle={-45} textAnchor="end" height={100} />
            <YAxis />
            <Tooltip formatter={(value) => formatCurrency(value)} />
            <Bar dataKey="cost" fill="#ef4444" name={`Cost (${SAR_SYMBOL})`} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
