import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { format } from 'date-fns';
import { formatCurrency } from '@/lib/currency';

export default function InventoryTrendChart({ transactions, inventory }) {
  const chartData = useMemo(() => {
    const dataByDate = {};
    
    transactions.forEach(t => {
      const date = format(new Date(t.transaction_date), 'MMM dd');
      if (!dataByDate[date]) {
        dataByDate[date] = {
          date,
          additions: 0,
          issuances: 0,
          additionValue: 0,
          issuanceValue: 0
        };
      }
      const quantity = Number(t.quantity || 0);
      const explicitTotalCost = Number(t.total_cost);
      const calculatedTotalCost = Math.abs(quantity) * Math.abs(Number(t.unit_cost || 0));
      const movementValue = Math.abs(Number.isFinite(explicitTotalCost) ? explicitTotalCost : calculatedTotalCost);
      
      if ([
        'addition',
        'receipt',
        'transfer_in',
        'production_return',
        'production_release',
        'opening_balance'
      ].includes(t.transaction_type) && Number(t.quantity || 0) > 0) {
        dataByDate[date].additions += Math.abs(quantity);
        dataByDate[date].additionValue += movementValue;
      } else if ([
        'issuance',
        'production_use',
        'production_commitment',
        'pos_sale',
        'transfer_out',
        'waste',
        'adjustment'
      ].includes(t.transaction_type) && Number(t.quantity || 0) < 0) {
        dataByDate[date].issuances += Math.abs(quantity);
        dataByDate[date].issuanceValue += movementValue;
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
            <YAxis yAxisId="value" orientation="right" tickFormatter={(value) => formatCurrency(value, { maximumFractionDigits: 0 })} />
            <Tooltip formatter={(value, name) => (
              String(name).includes('Value') ? formatCurrency(value) : Number(value).toLocaleString()
            )} />
            <Legend />
            <Line type="monotone" dataKey="additions" stroke="#10b981" strokeWidth={2} name="Stock Added" />
            <Line type="monotone" dataKey="issuances" stroke="#ef4444" strokeWidth={2} name="Stock Issued" />
            <Line yAxisId="value" type="monotone" dataKey="additionValue" stroke="#047857" strokeDasharray="4 3" name="Added Value" />
            <Line yAxisId="value" type="monotone" dataKey="issuanceValue" stroke="#be123c" strokeDasharray="4 3" name="Issued Value" />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
