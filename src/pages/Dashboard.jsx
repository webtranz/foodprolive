import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import QuickStats from '@/components/dashboard/QuickStats';
import ProductionChart from '@/components/dashboard/ProductionChart';
import WasteBreakdown from '@/components/dashboard/WasteBreakdown';
import RecentActivity from '@/components/dashboard/RecentActivity';
import SiteOverview from '@/components/dashboard/SiteOverview';
import InventoryAlerts from '@/components/inventory/InventoryAlerts';
import LiveDinersPanel from '@/components/dashboard/LiveDinersPanel';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadCSV } from '../components/utils/exportData';

export default function Dashboard() {
  const [selectedSite, setSelectedSite] = useState('all');

  const { data: sites = [], isLoading: sitesLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: productions = [], isLoading: productionsLoading } = useQuery({
    queryKey: ['productions'],
    queryFn: () => base44.entities.Production.list('-production_date', 50)
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 100)
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: menuPlans = [] } = useQuery({
    queryKey: ['menuPlans'],
    queryFn: () => base44.entities.MenuPlan.list()
  });

  // Calculate upcoming ingredient needs from menu plans and productions
  const upcomingNeeds = React.useMemo(() => {
    const needs = [];
    const today = new Date().toISOString().split('T')[0];
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    // From scheduled productions
    const upcomingProductions = productions.filter(
      p => p.production_date >= today && 
           p.production_date <= nextWeekStr && 
           p.status === 'planned'
    );

    upcomingProductions.forEach(prod => {
      prod.ingredients_used?.forEach(ing => {
        const existing = needs.find(
          n => n.ingredient_id === ing.ingredient_id && n.site_id === prod.site_id
        );
        if (existing) {
          existing.required_quantity += ing.planned_quantity || 0;
        } else {
          needs.push({
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            site_id: prod.site_id,
            site_name: prod.site_name,
            required_quantity: ing.planned_quantity || 0,
            unit: ing.unit,
            production_date: prod.production_date
          });
        }
      });
    });

    return needs;
  }, [productions]);

  // Calculate stats
  const activeSites = sites.filter(s => s.is_active !== false).length;
  const todayProduction = productions
    .filter(p => p.production_date === new Date().toISOString().split('T')[0])
    .reduce((sum, p) => sum + (p.target_servings || 0), 0);
  
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weeklyWaste = foodWaste
    .filter(w => new Date(w.waste_date) >= weekAgo)
    .reduce((sum, w) => sum + (w.quantity || 0), 0);

  const avgCalories = recipes.length > 0 
    ? Math.round(recipes.reduce((sum, r) => sum + (r.calories_per_serving || 0), 0) / recipes.length)
    : 0;

  const stats = {
    activeSites,
    todayProduction,
    totalRecipes: recipes.length,
    weeklyWaste: weeklyWaste.toFixed(1),
    avgCalories,
    efficiency: 87
  };

  // Calculate waste breakdown
  const wasteByCategory = foodWaste.reduce((acc, w) => {
    if (!acc[w.waste_category]) {
      acc[w.waste_category] = 0;
    }
    acc[w.waste_category] += w.quantity || 0;
    return acc;
  }, {});

  const totalWaste = Object.values(wasteByCategory).reduce((a, b) => a + b, 0);
  const wasteChartData = Object.entries(wasteByCategory).map(([category, value]) => ({
    name: category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    value: totalWaste > 0 ? Math.round((value / totalWaste) * 100) : 0,
    category
  }));

  const isLoading = sitesLoading || productionsLoading;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Dashboard" 
          description="Overview of your food production operations"
        >
          <Button 
            variant="outline"
            onClick={() => downloadCSV(productions, 'dashboard_productions')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[180px] bg-white">
              <SelectValue placeholder="Select site" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sites</SelectItem>
              {sites.map(site => (
                <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Link to={createPageUrl('Production')}>
            <Button className="bg-emerald-600 hover:bg-emerald-700">
              <Plus className="w-4 h-4 mr-2" />
              New Production
            </Button>
          </Link>
        </PageHeader>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : (
          <div className="mb-8">
            <QuickStats stats={stats} />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2">
            <ProductionChart />
          </div>
          <div>
            <WasteBreakdown data={wasteChartData.length > 0 ? wasteChartData : undefined} />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <RecentActivity />
          </div>
          <div className="space-y-6">
            <LiveDinersPanel />
            <InventoryAlerts 
              inventory={inventory} 
              upcomingNeeds={upcomingNeeds}
            />
          </div>
        </div>

        <div className="mt-6">
          <SiteOverview sites={sites.slice(0, 5).map(s => ({
            name: s.name,
            type: s.type,
            capacity: s.capacity || 100,
            currentLoad: Math.floor((s.capacity || 100) * 0.8),
            efficiency: Math.floor(Math.random() * 15 + 80)
          }))} />
        </div>
      </div>
    </div>
  );
}