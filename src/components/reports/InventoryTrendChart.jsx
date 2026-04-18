import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { format } from 'date-fns';

export default function InventoryTrendChart({ transactions, inventory }) {
  const chartData = useMemo(() => {
    const dataByDate = {};
    
    transactions.forEach(t => {
      const date = format(new Date(t.transaction_date), 'MMM dd');
      if (!dataByDate[date]) {
        dataByDate[date] = { date, additions: 0, issuances: 0, total: 0 };
      }
      
      if (t.transaction_type === 'addition') {
        dataByDate[date].additions += Math.abs(t.quantity || 0);
      } else if (t.transaction_type === 'issuance' || t.transaction_type === 'production_use') {
        dataByDate[date].issuances += Math.abs(t.quantity || 0);
      }
    });

    return Object.values(dataByDate).slice(-14);
  }, [transactions]);

  const currentStock = inventory.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const lowStockCount = inventory.filter(i => i.status === 'low_stock' || i.status === 'out_of_stock').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-blue-600" />
          Inventory Trend Analysis
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-blue-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Current Total Stock</p>
            <p className="text-2xl font-bold text-blue-700">{currentStock.toFixed(0)} units</p>
          </div>
          <div className="bg-amber-50 rounded-lg p-4">
            <p className="text-sm text-slate-600">Low Stock Items</p>
            <p className="text-2xl font-bold text-amber-700">{lowStockCount}</p>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="additions" stroke="#10b981" strokeWidth={2} name="Stock Added" />
            <Line type="monotone" dataKey="issuances" stroke="#ef4444" strokeWidth={2} name="Stock Issued" />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}