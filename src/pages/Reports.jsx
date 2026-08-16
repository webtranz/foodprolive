import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Download, FileText, TrendingUp, Package, Trash2, Building2 } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import { format, subDays } from 'date-fns';
import { downloadCSV } from '../components/utils/exportData';
import { formatCurrency } from '@/lib/currency';
import { formatRecipeQuantity } from '../../shared/recipeNumbers.js';

export default function Reports() {
  const [selectedSite, setSelectedSite] = useState('all');
  const [dateRange, setDateRange] = useState('week');

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: productions = [] } = useQuery({
    queryKey: ['productions'],
    queryFn: () => base44.entities.Production.list('-production_date', 500)
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 500)
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  // Calculate date range
  const dateFilter = useMemo(() => {
    const today = new Date();
    if (dateRange === 'week') return subDays(today, 7);
    if (dateRange === 'month') return subDays(today, 30);
    if (dateRange === 'quarter') return subDays(today, 90);
    return subDays(today, 365);
  }, [dateRange]);

  // Filter data
  const filteredProductions = useMemo(() => {
    return productions.filter(p => {
      const matchesSite = selectedSite === 'all' || p.site_id === selectedSite;
      const matchesDate = new Date(p.production_date) >= dateFilter;
      return matchesSite && matchesDate;
    });
  }, [productions, selectedSite, dateFilter]);

  const filteredWaste = useMemo(() => {
    return foodWaste.filter(w => {
      const matchesSite = selectedSite === 'all' || w.site_id === selectedSite;
      const matchesDate = new Date(w.waste_date) >= dateFilter;
      return matchesSite && matchesDate;
    });
  }, [foodWaste, selectedSite, dateFilter]);

  // Calculate stats
  const totalServings = filteredProductions.reduce((sum, p) => sum + (Number(p.actual_servings ?? p.target_servings) || 0), 0);
  const totalWaste = filteredWaste.reduce((sum, w) => sum + (Number(w.quantity) || 0), 0);
  const totalWasteCost = filteredWaste.reduce((sum, w) => sum + (Number(w.estimated_cost) || 0), 0);
  const completedProductions = filteredProductions.filter(p => p.status === 'completed').length;

  // Production by day chart data
  const productionByDay = useMemo(() => {
    const grouped = {};
    filteredProductions.forEach(p => {
      const date = p.production_date;
      if (!grouped[date]) {
        grouped[date] = { date, servings: 0, count: 0 };
      }
      grouped[date].servings += Number(p.target_servings) || 0;
      grouped[date].count += 1;
    });
    return Object.values(grouped)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-14)
      .map(d => ({
        ...d,
        dateLabel: format(new Date(d.date), 'MMM d')
      }));
  }, [filteredProductions]);

  // Waste by category
  const wasteByCategory = useMemo(() => {
    const grouped = {};
    filteredWaste.forEach(w => {
      const cat = w.waste_category || 'other';
      if (!grouped[cat]) {
        grouped[cat] = { category: cat, quantity: 0, cost: 0 };
      }
      grouped[cat].quantity += Number(w.quantity) || 0;
      grouped[cat].cost += Number(w.estimated_cost) || 0;
    });
    return Object.values(grouped).map(g => ({
      ...g,
      label: g.category.replace(/_/g, ' '),
      quantity: Math.round(g.quantity * 10) / 10,
      cost: Math.round(g.cost * 100) / 100
    }));
  }, [filteredWaste]);

  // Ingredient usage
  const ingredientUsage = useMemo(() => {
    const usage = {};
    filteredProductions.forEach(p => {
      if (p.ingredients_used) {
        p.ingredients_used.forEach(ing => {
          if (!usage[ing.ingredient_id]) {
            usage[ing.ingredient_id] = {
              id: ing.ingredient_id,
              name: ing.ingredient_name,
              totalUsed: 0,
              unit: ing.unit
            };
          }
          usage[ing.ingredient_id].totalUsed += Number(ing.actual_quantity ?? ing.planned_quantity) || 0;
        });
      }
    });
    return Object.values(usage)
      .sort((a, b) => b.totalUsed - a.totalUsed)
      .slice(0, 10);
  }, [filteredProductions]);

  // Site performance
  const sitePerformance = useMemo(() => {
    const perf = {};
    filteredProductions.forEach(p => {
      if (!perf[p.site_id]) {
        perf[p.site_id] = {
          site_id: p.site_id,
          site_name: p.site_name,
          totalServings: 0,
          completedCount: 0,
          totalCount: 0
        };
      }
      perf[p.site_id].totalServings += Number(p.target_servings) || 0;
      perf[p.site_id].totalCount += 1;
      if (p.status === 'completed') perf[p.site_id].completedCount += 1;
    });

    filteredWaste.forEach(w => {
      if (perf[w.site_id]) {
        if (!perf[w.site_id].totalWaste) perf[w.site_id].totalWaste = 0;
        perf[w.site_id].totalWaste += Number(w.quantity) || 0;
      }
    });

    return Object.values(perf).map(s => ({
      ...s,
      efficiency: s.totalCount > 0 ? Math.round((s.completedCount / s.totalCount) * 100) : 0,
      totalWaste: Math.round((s.totalWaste || 0) * 10) / 10
    }));
  }, [filteredProductions, filteredWaste]);

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Reports & Analytics" 
          description="Insights into your food production operations"
        >
          <div className="flex gap-2">
            <Button 
              variant="outline"
              onClick={() => {
                const reportData = [
                  { section: 'Summary', total_servings: totalServings, completed_productions: completedProductions, total_waste_kg: totalWaste.toFixed(1), waste_cost: totalWasteCost.toFixed(2) },
                  ...filteredProductions.map(p => ({ type: 'Production', ...p })),
                  ...filteredWaste.map(w => ({ type: 'Waste', ...w }))
                ];
                downloadCSV(reportData, 'full_report');
              }}
            >
              <Download className="w-4 h-4 mr-2" />
              Export All
            </Button>
            <Select value={selectedSite} onValueChange={setSelectedSite}>
              <SelectTrigger className="w-[150px] bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sites</SelectItem>
                {sites.map(site => (
                  <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-[130px] bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="week">Last 7 days</SelectItem>
                <SelectItem value="month">Last 30 days</SelectItem>
                <SelectItem value="quarter">Last 90 days</SelectItem>
                <SelectItem value="year">Last year</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </PageHeader>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            title="Total Servings"
            value={totalServings.toLocaleString()}
            icon={TrendingUp}
            iconBg="bg-emerald-50"
            iconColor="text-emerald-600"
          />
          <StatCard
            title="Productions Completed"
            value={completedProductions}
            icon={FileText}
            iconBg="bg-blue-50"
            iconColor="text-blue-600"
          />
          <StatCard
            title="Total Waste"
            value={`${totalWaste.toFixed(1)} kg`}
            icon={Trash2}
            iconBg="bg-red-50"
            iconColor="text-red-600"
          />
          <StatCard
            title="Waste Cost"
            value={formatCurrency(totalWasteCost)}
            icon={Package}
            iconBg="bg-amber-50"
            iconColor="text-amber-600"
          />
        </div>

        <Tabs defaultValue="production" className="space-y-6">
          <TabsList className="bg-white border border-slate-200">
            <TabsTrigger value="production">Production</TabsTrigger>
            <TabsTrigger value="waste">Waste Analysis</TabsTrigger>
            <TabsTrigger value="ingredients">Ingredient Usage</TabsTrigger>
            <TabsTrigger value="sites">Site Performance</TabsTrigger>
          </TabsList>

          {/* Production Tab */}
          <TabsContent value="production">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle>Daily Production Volume</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={productionByDay}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="servings" fill="#10b981" radius={[4, 4, 0, 0]} name="Servings" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Waste Tab */}
          <TabsContent value="waste">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-slate-100 shadow-sm">
                <CardHeader>
                  <CardTitle>Waste by Category</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={wasteByCategory} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis type="number" tick={{ fontSize: 12 }} />
                        <YAxis dataKey="label" type="category" width={100} tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Bar dataKey="quantity" fill="#ef4444" radius={[0, 4, 4, 0]} name="Quantity (kg)" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-100 shadow-sm">
                <CardHeader>
                  <CardTitle>Waste Cost Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {wasteByCategory.map((cat, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-medium capitalize">{cat.label}</TableCell>
                          <TableCell>{formatRecipeQuantity(cat.quantity, 'kg')} kg</TableCell>
                          <TableCell>{formatCurrency(cat.cost)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Ingredients Tab */}
          <TabsContent value="ingredients">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle>Top 10 Ingredients by Usage</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Ingredient</TableHead>
                      <TableHead>Total Used</TableHead>
                      <TableHead>Unit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ingredientUsage.map((ing, idx) => (
                      <TableRow key={ing.id}>
                        <TableCell>
                          <Badge variant="outline">{idx + 1}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">{ing.name}</TableCell>
                        <TableCell>{formatRecipeQuantity(ing.totalUsed, ing.unit)}</TableCell>
                        <TableCell>{ing.unit}</TableCell>
                      </TableRow>
                    ))}
                    {ingredientUsage.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-slate-500 py-8">
                          No ingredient usage data for selected period
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Sites Tab */}
          <TabsContent value="sites">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle>Site Performance Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Site</TableHead>
                      <TableHead>Total Servings</TableHead>
                      <TableHead>Productions</TableHead>
                      <TableHead>Completion Rate</TableHead>
                      <TableHead>Waste</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sitePerformance.map(site => (
                      <TableRow key={site.site_id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-4 h-4 text-slate-400" />
                            {site.site_name}
                          </div>
                        </TableCell>
                        <TableCell>{site.totalServings.toLocaleString()}</TableCell>
                        <TableCell>{site.totalCount}</TableCell>
                        <TableCell>
                          <Badge className={site.efficiency >= 80 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                            {site.efficiency}%
                          </Badge>
                        </TableCell>
                        <TableCell>{formatRecipeQuantity(site.totalWaste, 'kg')} kg</TableCell>
                      </TableRow>
                    ))}
                    {sitePerformance.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                          No site data for selected period
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
