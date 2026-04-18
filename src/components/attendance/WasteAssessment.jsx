import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkles, TrendingDown, TrendingUp, AlertTriangle, Lightbulb, RefreshCw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { subDays, format } from 'date-fns';

export default function WasteAssessment() {
  const [aiInsights, setAiInsights] = useState(null);
  const [loading, setLoading] = useState(false);

  const { data: records = [] } = useQuery({
    queryKey: ['attendanceRecords'],
    queryFn: () => base44.entities.AttendanceRecord.list('-marked_at', 500)
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ['attendanceSessions'],
    queryFn: () => base44.entities.AttendanceSession.list('-session_date', 100)
  });

  const { data: wasteRecords = [] } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 100)
  });

  // Build chart data for attendance vs waste
  const chartData = Array.from({ length: 7 }, (_, i) => {
    const date = subDays(new Date(), 6 - i);
    const dateStr = date.toISOString().split('T')[0];
    const dayAttendance = records.filter(r => r.session_date === dateStr).length;
    const dayWaste = wasteRecords.filter(w => w.waste_date === dateStr).reduce((sum, w) => sum + (w.quantity || 0), 0);
    return {
      date: format(date, 'EEE dd'),
      attendance: dayAttendance,
      waste_kg: Math.round(dayWaste * 10) / 10
    };
  });

  // Summarize attendance patterns for AI
  const buildContext = () => {
    const today = new Date().toISOString().split('T')[0];
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = subDays(new Date(), i).toISOString().split('T')[0];
      const dayRec = records.filter(r => r.session_date === date);
      return {
        date,
        total: dayRec.length,
        labor: dayRec.filter(r => r.category === 'labor').length,
        junior: dayRec.filter(r => r.category === 'junior').length,
        senior: dayRec.filter(r => r.category === 'senior').length
      };
    });
    const weekdayAvgs = {};
    records.forEach(r => {
      const day = new Date(r.session_date).toLocaleDateString('en-US', { weekday: 'long' });
      if (!weekdayAvgs[day]) weekdayAvgs[day] = { total: 0, days: new Set() };
      weekdayAvgs[day].total++;
      weekdayAvgs[day].days.add(r.session_date);
    });
    return { last7Days, weekdayAvgs };
  };

  const runAIAssessment = async () => {
    setLoading(true);
    const ctx = buildContext();
    const result = await base44.integrations.Core.InvokeLLM({
      prompt: `You are an AI food waste reduction expert for a central production kitchen. 
      
Analyze this attendance data and provide food waste insights:

Last 7 days attendance:
${JSON.stringify(ctx.last7Days, null, 2)}

Weekday averages (total per day of week):
${JSON.stringify(Object.entries(ctx.weekdayAvgs).map(([day, d]) => ({ day, avg: d.days.size > 0 ? Math.round(d.total / d.days.size) : 0 })), null, 2)}

Total food waste records available: ${wasteRecords.length}

Based on attendance trends, provide:
1. Estimated food quantity needed for tomorrow (assume 400g per labor, 350g per junior, 450g per senior)
2. 3 specific suggestions to reduce waste
3. A pattern observation (e.g., which day of week has lowest/highest attendance)
4. A percentage adjustment recommendation (increase/decrease production by X%)
5. Category-specific insights`,
      response_json_schema: {
        type: 'object',
        properties: {
          tomorrow_estimate: {
            type: 'object',
            properties: {
              labor_kg: { type: 'number' },
              junior_kg: { type: 'number' },
              senior_kg: { type: 'number' },
              total_kg: { type: 'number' },
              expected_attendance: { type: 'number' }
            }
          },
          adjustment_percent: { type: 'number' },
          adjustment_direction: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } },
          pattern_observation: { type: 'string' },
          category_insights: { type: 'array', items: { type: 'string' } },
          waste_risk: { type: 'string', enum: ['low', 'medium', 'high'] }
        }
      }
    });
    setAiInsights(result);
    setLoading(false);
  };

  const riskColors = { low: 'bg-green-100 text-green-800', medium: 'bg-amber-100 text-amber-800', high: 'bg-red-100 text-red-800' };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-600" /> AI Food Waste Assessment
        </h2>
        <Button onClick={runAIAssessment} disabled={loading} className="bg-indigo-600 hover:bg-indigo-700">
          {loading ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Analyzing...</> : <><Sparkles className="w-4 h-4 mr-2" /> Run AI Analysis</>}
        </Button>
      </div>

      {/* Charts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attendance vs Food Waste Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis yAxisId="left" />
              <YAxis yAxisId="right" orientation="right" />
              <Tooltip />
              <Legend />
              <Bar yAxisId="left" dataKey="attendance" fill="#10b981" name="Attendance" />
              <Bar yAxisId="right" dataKey="waste_kg" fill="#ef4444" name="Waste (kg)" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* AI Results */}
      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      )}

      {aiInsights && !loading && (
        <div className="space-y-4">
          {/* Risk + Tomorrow Estimate */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-indigo-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  Tomorrow's Food Estimate
                  {aiInsights.waste_risk && (
                    <Badge className={riskColors[aiInsights.waste_risk]}>
                      {aiInsights.waste_risk} risk
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {aiInsights.tomorrow_estimate && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      {[['Labor', 'labor_kg'], ['Junior', 'junior_kg'], ['Senior', 'senior_kg']].map(([label, key]) => (
                        <div key={key} className="bg-slate-50 rounded-lg p-3">
                          <p className="text-lg font-bold">{aiInsights.tomorrow_estimate[key]?.toFixed(1)} kg</p>
                          <p className="text-xs text-slate-500">{label}</p>
                        </div>
                      ))}
                    </div>
                    <div className="bg-indigo-50 rounded-lg p-3 flex items-center justify-between">
                      <span className="font-semibold text-indigo-800">Total Required</span>
                      <span className="text-xl font-bold text-indigo-700">{aiInsights.tomorrow_estimate.total_kg?.toFixed(1)} kg</span>
                    </div>
                    {aiInsights.adjustment_percent !== undefined && (
                      <div className={`flex items-center gap-2 p-3 rounded-lg ${aiInsights.adjustment_direction === 'reduce' ? 'bg-red-50' : 'bg-green-50'}`}>
                        {aiInsights.adjustment_direction === 'reduce' ? <TrendingDown className="w-4 h-4 text-red-600" /> : <TrendingUp className="w-4 h-4 text-green-600" />}
                        <span className="text-sm font-medium">
                          {aiInsights.adjustment_direction === 'reduce' ? 'Reduce' : 'Increase'} production by <strong>{Math.abs(aiInsights.adjustment_percent)}%</strong> tomorrow
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-amber-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" /> Pattern Observation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-700 leading-relaxed">{aiInsights.pattern_observation}</p>
              </CardContent>
            </Card>
          </div>

          {/* Suggestions */}
          {aiInsights.suggestions?.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-yellow-500" /> AI Recommendations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {aiInsights.suggestions.map((s, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                      <span className="w-6 h-6 rounded-full bg-yellow-400 text-white text-xs flex items-center justify-center font-bold flex-shrink-0 mt-0.5">{i + 1}</span>
                      <p className="text-sm text-slate-700">{s}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Category Insights */}
          {aiInsights.category_insights?.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Category-Specific Insights</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {aiInsights.category_insights.map((insight, i) => (
                    <div key={i} className="bg-slate-50 rounded-lg p-3 text-sm text-slate-700">{insight}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}