import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

const WASTE_COLORS = {
  raw_waste: '#ef4444',
  cooking_loss: '#f97316',
  plate_waste: '#eab308',
  expired: '#8b5cf6',
  storage_loss: '#6366f1',
  preparation_waste: '#ec4899'
};

const WASTE_LABELS = {
  raw_waste: 'Raw Waste',
  cooking_loss: 'Cooking Loss',
  plate_waste: 'Plate Waste',
  expired: 'Expired',
  storage_loss: 'Storage Loss',
  preparation_waste: 'Prep Waste'
};

export default function WasteBreakdown({ data }) {
  const chartData = data || [
    { name: 'Raw Waste', value: 25, category: 'raw_waste' },
    { name: 'Cooking Loss', value: 35, category: 'cooking_loss' },
    { name: 'Plate Waste', value: 20, category: 'plate_waste' },
    { name: 'Expired', value: 10, category: 'expired' },
    { name: 'Prep Waste', value: 10, category: 'preparation_waste' },
  ];

  return (
    <Card className="border-slate-100 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-slate-900">
          Waste Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
              >
                {chartData.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`} 
                    fill={WASTE_COLORS[entry.category] || '#94a3b8'} 
                  />
                ))}
              </Pie>
              <Tooltip 
                formatter={(value) => `${value}%`}
                contentStyle={{ 
                  borderRadius: '12px', 
                  border: '1px solid #e2e8f0',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                }}
              />
              <Legend 
                verticalAlign="bottom" 
                height={36}
                formatter={(value) => <span className="text-sm text-slate-600">{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}