import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Clock, Users, TrendingUp, Award, Download } from 'lucide-react';
import { format, subDays } from 'date-fns';
import StatCard from '@/components/ui/StatCard';
import { downloadCSV } from '../components/utils/exportData';

const MASTER_DATA_QUERY_OPTIONS = {
  staleTime: 10 * 60 * 1000,
  gcTime: 60 * 60 * 1000
};

const REPORT_DATA_QUERY_OPTIONS = {
  staleTime: 60 * 1000,
  gcTime: 10 * 60 * 1000
};

export default function ProductivityTracking() {
  const [selectedSite, setSelectedSite] = useState('all');
  const [dateRange, setDateRange] = useState('month');

  const dateFilter = useMemo(() => {
    const today = new Date();
    if (dateRange === 'week') return subDays(today, 7);
    if (dateRange === 'month') return subDays(today, 30);
    if (dateRange === 'quarter') return subDays(today, 90);
    return subDays(today, 365);
  }, [dateRange]);
  const dateRangeFilters = useMemo(() => ({
    startDate: format(dateFilter, 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd')
  }), [dateFilter]);
  const scopedEntityFilters = useMemo(() => (
    selectedSite === 'all' ? {} : { site_id: selectedSite }
  ), [selectedSite]);

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });
  const { data: productions = [] } = useQuery({
    queryKey: ['productions', 'productivityTracking', scopedEntityFilters, dateRangeFilters],
    queryFn: () => base44.entities.Production.filter(
      scopedEntityFilters,
      '-production_date',
      1000,
      {
        rangeFilters: {
          production_date: {
            gte: dateRangeFilters.startDate,
            lte: dateRangeFilters.endDate
          }
        }
      }
    ),
    ...REPORT_DATA_QUERY_OPTIONS
  });

  const filteredProds = useMemo(() => productions.filter(p => {
    const matchesSite = selectedSite === 'all' || p.site_id === selectedSite;
    const matchesDate = new Date(p.production_date) >= dateFilter;
    return matchesSite && matchesDate && p.status === 'completed';
  }), [productions, selectedSite, dateFilter]);

  // Site productivity
  const siteProductivity = useMemo(() => {
    const siteMap = {};
    filteredProds.forEach(prod => {
      if (!siteMap[prod.site_id]) {
        siteMap[prod.site_id] = {
          site_id: prod.site_id,
          site_name: prod.site_name,
          totalServings: 0,
          totalProductions: 0,
          days: new Set()
        };
      }
      siteMap[prod.site_id].totalServings += prod.actual_servings || prod.target_servings || 0;
      siteMap[prod.site_id].totalProductions += 1;
      siteMap[prod.site_id].days.add(prod.production_date);
    });
    return Object.values(siteMap).map(s => ({
      ...s,
      activeDays: s.days.size,
      avgServingsPerDay: s.days.size > 0 ? Math.round(s.totalServings / s.days.size) : 0,
      avgServingsPerProduction: s.totalProductions > 0 ? Math.round(s.totalServings / s.totalProductions) : 0
    })).sort((a, b) => b.totalServings - a.totalServings);
  }, [filteredProds]);

  // Daily production trend
  const dailyTrend = useMemo(() => {
    const dayMap = {};
    filteredProds.forEach(prod => {
      const day = prod.production_date;
      if (!dayMap[day]) dayMap[day] = { date: day, servings: 0, productions: 0 };
      dayMap[day].servings += prod.actual_servings || prod.target_servings || 0;
      dayMap[day].productions += 1;
    });
    return Object.values(dayMap)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-14)
      .map(d => ({ ...d, dateLabel: format(new Date(d.date), 'MMM d') }));
  }, [filteredProds]);

  // Meal type breakdown
  const mealBreakdown = useMemo(() => {
    const map = {};
    filteredProds.forEach(p => {
      const type = p.meal_type || 'other';
      if (!map[type]) map[type] = { meal_type: type, servings: 0, count: 0 };
      map[type].servings += p.actual_servings || p.target_servings || 0;
      map[type].count += 1;
    });
    return Object.values(map).sort((a, b) => b.servings - a.servings);
  }, [filteredProds]);

  const totalServings = filteredProds.reduce((sum, p) => sum + (p.actual_servings || p.target_servings || 0), 0);
  const totalProductions = filteredProds.length;
  const uniqueDays = new Set(filteredProds.map(p => p.production_date)).size;
  const avgPerDay = uniqueDays > 0 ? Math.round(totalServings / uniqueDays) : 0;
  const topSite = siteProductivity[0];

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader title="Productivity Tracking" description="Monitor kitchen output, production rates, and operational efficiency">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[150px] bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sites</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[130px] bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="month">Last 30 days</SelectItem>
              <SelectItem value="quarter">Last 90 days</SelectItem>
              <SelectItem value="year">Last year</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => downloadCSV(siteProductivity, 'productivity')}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
        </PageHeader>

        {/* KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard title="Total Servings" value={totalServings.toLocaleString()} icon={Users} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Avg Servings/Day" value={avgPerDay.toLocaleString()} icon={TrendingUp} iconBg="bg-blue-50" iconColor="text-blue-600" />
          <StatCard title="Production Runs" value={totalProductions} icon={Clock} iconBg="bg-purple-50" iconColor="text-purple-600" />
          <StatCard title="Active Days" value={uniqueDays} icon={Award} iconBg="bg-amber-50" iconColor="text-amber-600" />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <Card className="border-slate-100 shadow-sm">
            <CardHeader><CardTitle>Daily Production Volume</CardTitle></CardHeader>
            <CardContent>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="servings" fill="#10b981" radius={[4, 4, 0, 0]} name="Servings" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-100 shadow-sm">
            <CardHeader><CardTitle>Meal Type Distribution</CardTitle></CardHeader>
            <CardContent>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={mealBreakdown} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis dataKey="meal_type" type="category" width={80} tick={{ fontSize: 11 }} className="capitalize" />
                    <Tooltip />
                    <Bar dataKey="servings" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Servings" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Site Leaderboard */}
        <Card className="border-slate-100 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Award className="w-5 h-5 text-amber-500" /> Site Productivity Leaderboard
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rank</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Total Servings</TableHead>
                  <TableHead>Productions</TableHead>
                  <TableHead>Active Days</TableHead>
                  <TableHead>Avg/Day</TableHead>
                  <TableHead>Avg/Production Run</TableHead>
                  <TableHead>Performance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteProductivity.map((site, idx) => (
                  <TableRow key={site.site_id}>
                    <TableCell>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        idx === 0 ? 'bg-amber-100 text-amber-700' :
                        idx === 1 ? 'bg-slate-100 text-slate-700' :
                        idx === 2 ? 'bg-orange-100 text-orange-700' :
                        'bg-slate-50 text-slate-500'
                      }`}>
                        {idx + 1}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">{site.site_name}</TableCell>
                    <TableCell className="font-semibold">{site.totalServings.toLocaleString()}</TableCell>
                    <TableCell>{site.totalProductions}</TableCell>
                    <TableCell>{site.activeDays}</TableCell>
                    <TableCell className="text-emerald-600 font-semibold">{site.avgServingsPerDay}</TableCell>
                    <TableCell>{site.avgServingsPerProduction}</TableCell>
                    <TableCell>
                      <Badge className={
                        site.avgServingsPerDay > 500 ? 'bg-emerald-100 text-emerald-700' :
                        site.avgServingsPerDay > 200 ? 'bg-blue-100 text-blue-700' :
                        'bg-amber-100 text-amber-700'
                      }>
                        {site.avgServingsPerDay > 500 ? '🏆 High' : site.avgServingsPerDay > 200 ? '📈 Medium' : '📊 Low'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {siteProductivity.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-slate-500 py-8">No completed productions in selected period</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
