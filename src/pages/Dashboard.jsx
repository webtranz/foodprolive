import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import {
  eachDayOfInterval,
  endOfDay,
  format,
  isWithinInterval,
  parseISO,
  startOfDay,
  subDays
} from 'date-fns';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import {
  AlertTriangle,
  Building2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
  Factory,
  Percent,
  ShoppingCart,
  Target,
  TrendingDown,
  TrendingUp,
  Warehouse
} from 'lucide-react';
import { calculateProductionIngredientCost } from '../../shared/ingredientUnits.js';
import PageHeader from '@/components/ui/PageHeader';
import StatCard from '@/components/ui/StatCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadCSV } from '../components/utils/exportData';
import { formatCurrency } from '@/lib/currency';
import { usePermissions } from '@/components/auth/usePermissions';
import ManagementDashboard, { getInitialManagementDateRange } from '@/components/dashboard/ManagementDashboard';
import {
  ADMIN_DASHBOARD_VIEW_ORDER,
  DASHBOARD_VIEWS
} from '../../shared/managementDashboardRoles.js';
import { getItemCodeFromRecords } from '../../shared/itemCode.js';

const STATUS_COLORS = {
  draft: '#94a3b8',
  pending_approval: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  planned: '#3b82f6',
  in_progress: '#8b5cf6',
  completed: '#10b981',
  cancelled: '#ef4444'
};

const MASTER_DATA_QUERY_OPTIONS = {
  staleTime: 10 * 60 * 1000,
  gcTime: 60 * 60 * 1000
};

const DASHBOARD_DATA_QUERY_OPTIONS = {
  staleTime: 60 * 1000,
  gcTime: 10 * 60 * 1000
};

const KPI_CARD_STYLES = [
  { iconBg: 'bg-emerald-50', iconColor: 'text-emerald-600' },
  { iconBg: 'bg-blue-50', iconColor: 'text-blue-600' },
  { iconBg: 'bg-amber-50', iconColor: 'text-amber-600' },
  { iconBg: 'bg-rose-50', iconColor: 'text-rose-600' },
  { iconBg: 'bg-violet-50', iconColor: 'text-violet-600' },
  { iconBg: 'bg-cyan-50', iconColor: 'text-cyan-600' },
  { iconBg: 'bg-orange-50', iconColor: 'text-orange-600' },
  { iconBg: 'bg-lime-50', iconColor: 'text-lime-600' },
  { iconBg: 'bg-fuchsia-50', iconColor: 'text-fuchsia-600' },
  { iconBg: 'bg-slate-100', iconColor: 'text-slate-700' }
];

const percent = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1
});

function formatDateLabel(value) {
  return format(parseISO(value), 'MMM d');
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getDateRangeOptions() {
  const today = format(new Date(), 'yyyy-MM-dd');
  return {
    startDate: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
    endDate: today
  };
}

function SectionCard({ title, subtitle, children, action }) {
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base text-slate-900">{title}</CardTitle>
          {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DefaultDashboard() {
  const defaults = useMemo(() => getDateRangeOptions(), []);
  const [filters, setFilters] = useState({
    startDate: defaults.startDate,
    endDate: defaults.endDate,
    location: 'all',
    kitchen: 'all',
    category: 'all',
    status: 'all'
  });

  const { data: sites = [], isLoading: sitesLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const { data: productions = [], isLoading: productionsLoading } = useQuery({
    queryKey: ['productions', 'dashboard', filters.startDate, filters.endDate],
    queryFn: () => base44.entities.Production.filter(
      {},
      '-production_date',
      1000,
      {
        rangeFilters: {
          production_date: {
            gte: filters.startDate,
            lte: filters.endDate
          }
        }
      }
    ),
    ...DASHBOARD_DATA_QUERY_OPTIONS
  });

  const { data: recipes = [], isLoading: recipesLoading } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const { data: foodWaste = [], isLoading: wasteLoading } = useQuery({
    queryKey: ['foodWaste', 'dashboard', filters.startDate, filters.endDate],
    queryFn: () => base44.entities.FoodWaste.filter(
      {},
      '-waste_date',
      1000,
      {
        rangeFilters: {
          waste_date: {
            gte: filters.startDate,
            lte: filters.endDate
          }
        }
      }
    ),
    ...DASHBOARD_DATA_QUERY_OPTIONS
  });

  const { data: inventory = [], isLoading: inventoryLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.inventory.getStockOnHand(),
    ...DASHBOARD_DATA_QUERY_OPTIONS
  });

  const { data: ingredients = [], isLoading: ingredientsLoading } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const { data: inventoryTransactions = [], isLoading: transactionsLoading } = useQuery({
    queryKey: ['inventoryTransactions', 'dashboard', filters.startDate, filters.endDate],
    queryFn: () => base44.entities.InventoryTransaction.filter(
      {},
      '-transaction_date',
      1000,
      {
        rangeFilters: {
          transaction_date: {
            gte: filters.startDate,
            lte: filters.endDate
          }
        }
      }
    ),
    ...DASHBOARD_DATA_QUERY_OPTIONS
  });

  const { data: purchaseOrders = [], isLoading: purchaseOrdersLoading } = useQuery({
    queryKey: ['purchaseOrders', 'dashboard', filters.startDate, filters.endDate],
    queryFn: () => base44.entities.PurchaseOrder.filter(
      {},
      '-order_date',
      500,
      {
        rangeFilters: {
          order_date: {
            gte: filters.startDate,
            lte: filters.endDate
          }
        }
      }
    ),
    ...DASHBOARD_DATA_QUERY_OPTIONS
  });

  const siteMap = useMemo(
    () => Object.fromEntries(sites.map((site) => [site.id, site])),
    [sites]
  );

  const recipeMap = useMemo(
    () => Object.fromEntries(recipes.map((recipe) => [recipe.id, recipe])),
    [recipes]
  );

  const ingredientMap = useMemo(
    () => Object.fromEntries(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients]
  );

  const rootLocations = useMemo(() => {
    const operational = sites.filter((site) => ['location', 'branch', 'camp', 'headquarters'].includes(site.type));
    return operational.length > 0 ? operational : sites.filter((site) => !site.parent_site_id);
  }, [sites]);

  const kitchens = useMemo(
    () => sites.filter((site) => site.type === 'kitchen'),
    [sites]
  );

  const categoryOptions = useMemo(() => {
    const categories = new Set();
    recipes.forEach((recipe) => {
      if (recipe.category) categories.add(recipe.category);
    });
    return [...categories].sort();
  }, [recipes]);

  const filteredKitchenOptions = useMemo(() => {
    if (filters.location === 'all') {
      return kitchens;
    }

    return kitchens.filter((kitchen) => kitchen.parent_site_id === filters.location || kitchen.id === filters.location);
  }, [filters.location, kitchens]);

  const dateInterval = useMemo(() => ({
    start: startOfDay(parseISO(filters.startDate)),
    end: endOfDay(parseISO(filters.endDate))
  }), [filters.endDate, filters.startDate]);

  const analytics = useMemo(() => {
    const intervalDays = eachDayOfInterval(dateInterval).map((date) => format(date, 'yyyy-MM-dd'));
    const filteredProductions = productions.filter((production) => {
      if (!production.production_date) return false;

      const productionDate = parseISO(production.production_date);
      if (!isWithinInterval(productionDate, dateInterval)) return false;

      const site = siteMap[production.site_id] || null;
      const recipe = recipeMap[production.recipe_id] || null;
      const locationId = site?.parent_site_id || site?.id || 'unknown';
      const kitchenId = site?.type === 'kitchen' ? site.id : site?.parent_site_id ? production.site_id : 'unknown';
      const category = production.menu_category || recipe?.category || 'uncategorized';

      if (filters.location !== 'all' && locationId !== filters.location && production.site_id !== filters.location) {
        return false;
      }

      if (filters.kitchen !== 'all' && kitchenId !== filters.kitchen && production.site_id !== filters.kitchen) {
        return false;
      }

      if (filters.category !== 'all' && category !== filters.category) {
        return false;
      }

      if (filters.status !== 'all' && (production.status || 'draft') !== filters.status) {
        return false;
      }

      return true;
    });

    const filteredWaste = foodWaste.filter((waste) => {
      if (!waste.waste_date) return false;
      const wasteDate = parseISO(waste.waste_date);
      if (!isWithinInterval(wasteDate, dateInterval)) return false;

      const site = siteMap[waste.site_id] || null;
      const locationId = site?.parent_site_id || site?.id || 'unknown';
      const kitchenId = site?.type === 'kitchen' ? site.id : site?.parent_site_id ? waste.site_id : 'unknown';

      if (filters.location !== 'all' && locationId !== filters.location && waste.site_id !== filters.location) {
        return false;
      }

      if (filters.kitchen !== 'all' && kitchenId !== filters.kitchen && waste.site_id !== filters.kitchen) {
        return false;
      }

      return true;
    });

    const filteredInventory = inventory.filter((item) => {
      const site = siteMap[item.site_id] || null;
      const locationId = site?.parent_site_id || site?.id || 'unknown';
      const kitchenId = site?.type === 'kitchen' ? site.id : site?.parent_site_id ? item.site_id : 'unknown';
      const ingredientCategory = ingredientMap[item.ingredient_id]?.category || 'uncategorized';

      if (filters.location !== 'all' && locationId !== filters.location && item.site_id !== filters.location) {
        return false;
      }

      if (filters.kitchen !== 'all' && kitchenId !== filters.kitchen && item.site_id !== filters.kitchen) {
        return false;
      }

      if (filters.category !== 'all' && ingredientCategory !== filters.category) {
        return false;
      }

      return true;
    });

    const filteredTransactions = inventoryTransactions.filter((transaction) => {
      if (!transaction.transaction_date) return false;
      const transactionDate = parseISO(transaction.transaction_date);
      if (!isWithinInterval(transactionDate, dateInterval)) return false;

      const site = siteMap[transaction.site_id] || null;
      const locationId = site?.parent_site_id || site?.id || 'unknown';
      const kitchenId = site?.type === 'kitchen' ? site.id : site?.parent_site_id ? transaction.site_id : 'unknown';
      const ingredientCategory = ingredientMap[transaction.ingredient_id]?.category || 'uncategorized';

      if (filters.location !== 'all' && locationId !== filters.location && transaction.site_id !== filters.location) {
        return false;
      }

      if (filters.kitchen !== 'all' && kitchenId !== filters.kitchen && transaction.site_id !== filters.kitchen) {
        return false;
      }

      if (filters.category !== 'all' && ingredientCategory !== filters.category) {
        return false;
      }

      return true;
    });

    const filteredPurchaseOrders = purchaseOrders.filter((po) => {
      if (!po.order_date) return true;
      const orderDate = parseISO(po.order_date);
      if (!isWithinInterval(orderDate, dateInterval)) return false;

      const site = siteMap[po.site_id] || null;
      const locationId = site?.parent_site_id || site?.id || 'unknown';
      const kitchenId = site?.type === 'kitchen' ? site.id : site?.parent_site_id ? po.site_id : 'unknown';

      if (filters.location !== 'all' && locationId !== filters.location && po.site_id !== filters.location) {
        return false;
      }

      if (filters.kitchen !== 'all' && kitchenId !== filters.kitchen && po.site_id !== filters.kitchen) {
        return false;
      }

      return true;
    });

    const completedProductions = filteredProductions.filter((production) => production.status === 'completed');

    const totalProductionQuantity = filteredProductions.reduce(
      (sum, production) => sum + safeNumber(production.actual_servings || production.target_servings),
      0
    );

    const totalCapacity = filteredProductions.reduce((sum, production) => {
      const site = siteMap[production.site_id];
      return sum + safeNumber(site?.capacity);
    }, 0);

    const totalActualServings = filteredProductions.reduce(
      (sum, production) => sum + safeNumber(production.actual_servings || production.target_servings),
      0
    );

    const totalTargetServings = filteredProductions.reduce(
      (sum, production) => sum + safeNumber(production.target_servings),
      0
    );

    const totalFoodCost = completedProductions.reduce((sum, production) => {
      const productionCost = (production.ingredients_used || []).reduce((ingredientSum, ingredient) => {
        return ingredientSum + calculateProductionIngredientCost(
          ingredient,
          ingredientMap[ingredient.ingredient_id]
        );
      }, 0);
      return sum + productionCost;
    }, 0);

    const totalWasteCost = filteredWaste.reduce((sum, waste) => sum + safeNumber(waste.estimated_cost), 0);

    const inventoryValue = filteredInventory.reduce((sum, item) => {
      const unitCost = safeNumber(ingredientMap[item.ingredient_id]?.cost_per_unit);
      return sum + (safeNumber(item.quantity) * unitCost);
    }, 0);

    const lowStockItems = filteredInventory.filter((item) => {
      const minimum = safeNumber(item.min_stock_level);
      const quantity = safeNumber(item.quantity);
      return item.status === 'low_stock' || item.status === 'out_of_stock' || (minimum > 0 && quantity <= minimum);
    });

    const pendingPurchaseOrders = filteredPurchaseOrders.filter((po) =>
      ['draft', 'sent', 'pending', 'open', 'approved'].includes((po.status || '').toLowerCase())
    );

    const efficiencyValue = totalTargetServings > 0 ? (totalActualServings / totalTargetServings) * 100 : 0;
    const capacityUsage = totalCapacity > 0 ? (totalActualServings / totalCapacity) * 100 : 0;
    const revenueEstimate = totalActualServings * 6.5;
    const profitMargin = revenueEstimate > 0 ? ((revenueEstimate - totalFoodCost - totalWasteCost) / revenueEstimate) * 100 : 0;

    const locationPerformanceMap = {};
    filteredProductions.forEach((production) => {
      const site = siteMap[production.site_id] || {};
      const locationId = site.parent_site_id || site.id || production.site_id || 'unknown';
      const locationSite = site.parent_site_id ? siteMap[site.parent_site_id] : site;
      const current = locationPerformanceMap[locationId] || {
        id: locationId,
        name: locationSite?.name || production.site_name || 'Unknown Location',
        servings: 0,
        target: 0,
        wasteCost: 0,
        foodCost: 0,
        capacity: 0,
        runs: 0
      };

      current.servings += safeNumber(production.actual_servings || production.target_servings);
      current.target += safeNumber(production.target_servings);
      current.capacity += safeNumber(site.capacity || locationSite?.capacity);
      current.runs += 1;
      current.foodCost += (production.ingredients_used || []).reduce((sum, ingredient) => {
        return sum + calculateProductionIngredientCost(
          ingredient,
          ingredientMap[ingredient.ingredient_id]
        );
      }, 0);

      locationPerformanceMap[locationId] = current;
    });

    filteredWaste.forEach((waste) => {
      const site = siteMap[waste.site_id] || {};
      const locationId = site.parent_site_id || site.id || waste.site_id || 'unknown';
      if (!locationPerformanceMap[locationId]) {
        const locationSite = site.parent_site_id ? siteMap[site.parent_site_id] : site;
        locationPerformanceMap[locationId] = {
          id: locationId,
          name: locationSite?.name || waste.site_name || 'Unknown Location',
          servings: 0,
          target: 0,
          wasteCost: 0,
          foodCost: 0,
          capacity: 0,
          runs: 0
        };
      }

      locationPerformanceMap[locationId].wasteCost += safeNumber(waste.estimated_cost);
    });

    const locationPerformance = Object.values(locationPerformanceMap)
      .map((location) => {
        const efficiency = location.target > 0 ? (location.servings / location.target) * 100 : 0;
        const capacityPercent = location.capacity > 0 ? (location.servings / location.capacity) * 100 : 0;
        const margin = location.servings > 0
          ? (((location.servings * 6.5) - location.foodCost - location.wasteCost) / (location.servings * 6.5)) * 100
          : 0;
        const score = (efficiency * 0.45) + (Math.min(100, capacityPercent) * 0.25) + (Math.max(0, margin) * 0.3);

        return {
          ...location,
          efficiency,
          capacityPercent,
          margin,
          score
        };
      })
      .sort((left, right) => right.score - left.score);

    const topLocation = locationPerformance[0];

    const productionVsCapacity = intervalDays.map((day) => {
      const dailyProductions = filteredProductions.filter((production) => production.production_date === day);
      const produced = dailyProductions.reduce(
        (sum, production) => sum + safeNumber(production.actual_servings || production.target_servings),
        0
      );
      const capacity = dailyProductions.reduce((sum, production) => {
        const site = siteMap[production.site_id];
        return sum + safeNumber(site?.capacity);
      }, 0);
      return {
        date: day,
        label: formatDateLabel(day),
        produced,
        capacity
      };
    });

    const wasteTrend = intervalDays.map((day) => {
      const dailyWaste = filteredWaste.filter((waste) => waste.waste_date === day);
      return {
        date: day,
        label: formatDateLabel(day),
        quantity: dailyWaste.reduce((sum, waste) => sum + safeNumber(waste.quantity), 0),
        cost: dailyWaste.reduce((sum, waste) => sum + safeNumber(waste.estimated_cost), 0)
      };
    });

    const costPerLocation = locationPerformance
      .map((location) => ({
        location: location.name,
        foodCost: Math.round(location.foodCost),
        wasteCost: Math.round(location.wasteCost),
        totalCost: Math.round(location.foodCost + location.wasteCost)
      }))
      .slice(0, 8);

    const inventoryConsumptionMap = {};
    filteredTransactions
      .filter((transaction) => safeNumber(transaction.quantity) < 0)
      .forEach((transaction) => {
        const day = transaction.transaction_date;
        if (!inventoryConsumptionMap[day]) {
          inventoryConsumptionMap[day] = {
            date: day,
            label: formatDateLabel(day),
            quantity: 0,
            value: 0
          };
        }

        const quantity = Math.abs(safeNumber(transaction.quantity));
        const unitCost = safeNumber(ingredientMap[transaction.ingredient_id]?.cost_per_unit);
        inventoryConsumptionMap[day].quantity += quantity;
        inventoryConsumptionMap[day].value += quantity * unitCost;
      });

    const inventoryConsumption = intervalDays.map((day) => ({
      date: day,
      label: formatDateLabel(day),
      quantity: inventoryConsumptionMap[day]?.quantity || 0,
      value: Math.round(inventoryConsumptionMap[day]?.value || 0)
    }));

    const topExpensiveRecipesMap = {};
    completedProductions.forEach((production) => {
      const key = production.recipe_id || production.recipe_name || production.id;
      const current = topExpensiveRecipesMap[key] || {
        name: production.recipe_name || recipeMap[production.recipe_id]?.name || 'Unknown Recipe',
        servings: 0,
        cost: 0,
        runs: 0
      };

      current.servings += safeNumber(production.actual_servings || production.target_servings);
      current.cost += (production.ingredients_used || []).reduce((sum, ingredient) => {
        return sum + calculateProductionIngredientCost(
          ingredient,
          ingredientMap[ingredient.ingredient_id]
        );
      }, 0);
      current.runs += 1;
      topExpensiveRecipesMap[key] = current;
    });

    const topExpensiveRecipes = Object.values(topExpensiveRecipesMap)
      .map((recipe) => ({
        ...recipe,
        costPerServing: recipe.servings > 0 ? recipe.cost / recipe.servings : 0
      }))
      .sort((left, right) => right.costPerServing - left.costPerServing)
      .slice(0, 8);

    const lowEfficiencyLocations = [...locationPerformance]
      .sort((left, right) => left.efficiency - right.efficiency)
      .slice(0, 6)
      .map((location) => ({
        location: location.name,
        efficiency: Number(location.efficiency.toFixed(1)),
        capacity: Number(location.capacityPercent.toFixed(1))
      }));

    return {
      filteredProductions,
      filteredWaste,
      filteredInventory,
      filteredTransactions,
      filteredPurchaseOrders,
      kpis: {
        totalProductionQuantity,
        capacityUsage,
        efficiencyValue,
        totalFoodCost,
        totalWasteCost,
        inventoryValue,
        pendingPurchaseOrders: pendingPurchaseOrders.length,
        lowStockItems: lowStockItems.length,
        profitMargin,
        topLocation
      },
      charts: {
        productionVsCapacity,
        wasteTrend,
        costPerLocation,
        inventoryConsumption,
        topExpensiveRecipes,
        lowEfficiencyLocations
      },
      tables: {
        lowStockItems: lowStockItems
          .map((item) => ({
            id: item.id,
            item_code: getItemCodeFromRecords([ingredientMap[item.ingredient_id], item]),
            ingredient: ingredientMap[item.ingredient_id]?.name || item.ingredient_name || 'Unknown Ingredient',
            site: siteMap[item.site_id]?.name || item.site_name || 'Unknown Site',
            quantity: safeNumber(item.quantity),
            minimum: safeNumber(item.min_stock_level),
            status: item.status || 'low_stock'
          }))
          .sort((left, right) => left.quantity - right.quantity)
          .slice(0, 8),
        ranking: locationPerformance.slice(0, 8)
      }
    };
  }, [
    dateInterval,
    filters.category,
    filters.kitchen,
    filters.location,
    filters.status,
    foodWaste,
    ingredientMap,
    inventory,
    inventoryTransactions,
    productions,
    purchaseOrders,
    recipeMap,
    siteMap
  ]);

  const isLoading = sitesLoading || productionsLoading || recipesLoading || wasteLoading || inventoryLoading || ingredientsLoading || transactionsLoading || purchaseOrdersLoading;

  const exportRows = analytics.filteredProductions.map((production) => ({
    production_date: production.production_date,
    site_name: production.site_name,
    recipe_name: production.recipe_name,
    status: production.status,
    target_servings: production.target_servings,
    actual_servings: production.actual_servings || production.target_servings
  }));

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1680px] space-y-6">
        <PageHeader
          title="Catering Analytics Dashboard"
          description="Enterprise-grade view of production, capacity, cost, waste, inventory, and location performance"
        >
          <Button variant="outline" onClick={() => downloadCSV(exportRows, 'catering_dashboard_export')}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </PageHeader>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Analytics Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
              <div className="space-y-2">
                <Label htmlFor="startDate">Date Range Start</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={filters.startDate}
                  max={filters.endDate}
                  onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">Date Range End</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={filters.endDate}
                  min={filters.startDate}
                  onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Location</Label>
                <Select
                  value={filters.location}
                  onValueChange={(value) => setFilters((current) => ({
                    ...current,
                    location: value,
                    kitchen: current.kitchen !== 'all' && !filteredKitchenOptions.find((site) => site.id === current.kitchen) ? 'all' : current.kitchen
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {rootLocations.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Kitchen</Label>
                <Select
                  value={filters.kitchen}
                  onValueChange={(value) => setFilters((current) => ({ ...current, kitchen: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Kitchens</SelectItem>
                    {filteredKitchenOptions.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Menu Category</Label>
                <Select
                  value={filters.category}
                  onValueChange={(value) => setFilters((current) => ({ ...current, category: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categoryOptions.map((category) => (
                      <SelectItem key={category} value={category}>{category.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Production Status</Label>
                <Select
                  value={filters.status}
                  onValueChange={(value) => setFilters((current) => ({ ...current, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    {Object.keys(STATUS_COLORS).map((status) => (
                      <SelectItem key={status} value={status}>{status.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
              {Array.from({ length: 10 }).map((_, index) => (
                <Skeleton key={index} className="h-32 rounded-2xl" />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-[360px] rounded-2xl" />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[
                {
                  title: 'Total Production Quantity',
                  value: analytics.kpis.totalProductionQuantity.toLocaleString(),
                  subtitle: `${analytics.filteredProductions.length} production runs`,
                  icon: Factory
                },
                {
                  title: 'Capacity Usage %',
                  value: `${percent.format(analytics.kpis.capacityUsage)}%`,
                  subtitle: 'Produced versus site capacity',
                  icon: Percent
                },
                {
                  title: 'Efficiency %',
                  value: `${percent.format(analytics.kpis.efficiencyValue)}%`,
                  subtitle: 'Actual servings versus target',
                  icon: Target
                },
                {
                  title: 'Total Food Cost',
                  value: formatCurrency(analytics.kpis.totalFoodCost, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                  subtitle: 'Ingredient cost for completed production',
                  icon: CircleDollarSign
                },
                {
                  title: 'Waste Cost',
                  value: formatCurrency(analytics.kpis.totalWasteCost, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                  subtitle: `${analytics.filteredWaste.length} waste records`,
                  icon: TrendingDown
                },
                {
                  title: 'Inventory Value',
                  value: formatCurrency(analytics.kpis.inventoryValue, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                  subtitle: `${analytics.filteredInventory.length} stocked items`,
                  icon: Warehouse
                },
                {
                  title: 'Pending Purchase Orders',
                  value: analytics.kpis.pendingPurchaseOrders.toLocaleString(),
                  subtitle: 'Open procurement commitments',
                  icon: ShoppingCart
                },
                {
                  title: 'Low Stock Items',
                  value: analytics.kpis.lowStockItems.toLocaleString(),
                  subtitle: 'Items below minimum stock threshold',
                  icon: AlertTriangle
                },
                {
                  title: 'Profit Margin %',
                  value: `${percent.format(analytics.kpis.profitMargin)}%`,
                  subtitle: 'Estimated catering margin after waste',
                  icon: TrendingUp
                },
                {
                  title: 'Location Performance Ranking',
                  value: analytics.kpis.topLocation?.name || 'No data',
                  subtitle: analytics.kpis.topLocation ? `Score ${percent.format(analytics.kpis.topLocation.score)}` : 'Awaiting production activity',
                  icon: Building2
                }
              ].map((card, index) => (
                <StatCard
                  key={card.title}
                  title={card.title}
                  value={card.value}
                  subtitle={card.subtitle}
                  icon={card.icon}
                  iconBg={KPI_CARD_STYLES[index].iconBg}
                  iconColor={KPI_CARD_STYLES[index].iconColor}
                />
              ))}
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <SectionCard title="Production vs Capacity" subtitle="Daily production output against available capacity within the selected range">
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={analytics.charts.productionVsCapacity}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="produced" name="Produced" fill="#10b981" radius={[6, 6, 0, 0]} />
                      <Line dataKey="capacity" name="Capacity" stroke="#1d4ed8" strokeWidth={3} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>

              <SectionCard title="Waste Trend" subtitle="Daily waste quantity and cost over the selected period">
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analytics.charts.wasteTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="quantity" name="Waste Qty" stroke="#ef4444" strokeWidth={3} dot={false} />
                      <Line yAxisId="right" type="monotone" dataKey="cost" name="Waste Cost" stroke="#f59e0b" strokeWidth={3} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>

              <SectionCard title="Cost Per Location" subtitle="Food and waste cost distribution by location">
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.charts.costPerLocation} layout="vertical" margin={{ left: 18 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis type="number" tick={{ fontSize: 12 }} />
                      <YAxis dataKey="location" type="category" width={120} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value) => formatCurrency(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} />
                      <Legend />
                      <Bar dataKey="foodCost" stackId="cost" name="Food Cost" fill="#2563eb" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="wasteCost" stackId="cost" name="Waste Cost" fill="#f97316" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>

              <SectionCard title="Inventory Consumption" subtitle="Stock usage volume and value derived from inventory transactions">
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analytics.charts.inventoryConsumption}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Area yAxisId="left" type="monotone" dataKey="quantity" name="Consumed Qty" stroke="#0f766e" fill="#99f6e4" fillOpacity={0.9} />
                      <Area yAxisId="right" type="monotone" dataKey="value" name="Consumed Value" stroke="#9333ea" fill="#e9d5ff" fillOpacity={0.6} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>

              <SectionCard title="Top Expensive Recipes" subtitle="Highest cost per serving across completed production runs">
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.charts.topExpensiveRecipes} layout="vertical" margin={{ left: 28 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis type="number" tick={{ fontSize: 12 }} />
                      <YAxis dataKey="name" type="category" width={130} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value) => formatCurrency(Number(value), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
                      <Bar dataKey="costPerServing" name="Cost / Serving" fill="#7c3aed" radius={[0, 6, 6, 0]}>
                        {analytics.charts.topExpensiveRecipes.map((entry, index) => (
                          <Cell key={entry.name} fill={index < 3 ? '#7c3aed' : '#c4b5fd'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>

              <SectionCard title="Low Efficiency Locations" subtitle="Locations falling furthest below target efficiency">
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.charts.lowEfficiencyLocations}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="location" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} />
                      <Legend />
                      <Bar dataKey="efficiency" name="Efficiency %" fill="#ef4444" radius={[6, 6, 0, 0]} />
                      <Bar dataKey="capacity" name="Capacity Usage %" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
              <SectionCard title="Location Performance Ranking" subtitle="Operational score based on efficiency, capacity utilization, and margin">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rank</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Output</TableHead>
                        <TableHead>Efficiency</TableHead>
                        <TableHead>Capacity</TableHead>
                        <TableHead>Margin</TableHead>
                        <TableHead>Score</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.tables.ranking.map((location, index) => (
                        <TableRow key={location.id}>
                          <TableCell>
                            <Badge className={index === 0 ? 'bg-emerald-600' : index === 1 ? 'bg-blue-600' : 'bg-slate-600'}>
                              #{index + 1}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-medium">{location.name}</TableCell>
                          <TableCell>{location.servings.toLocaleString()}</TableCell>
                          <TableCell>{percent.format(location.efficiency)}%</TableCell>
                          <TableCell>{percent.format(location.capacityPercent)}%</TableCell>
                          <TableCell>{percent.format(location.margin)}%</TableCell>
                          <TableCell className="font-semibold text-slate-900">{percent.format(location.score)}</TableCell>
                        </TableRow>
                      ))}
                      {analytics.tables.ranking.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-slate-500">No location activity found for the current filters.</TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </SectionCard>

              <SectionCard
                title="Low Stock Watchlist"
                subtitle="Items that need replenishment attention"
                action={<Badge variant="outline">{analytics.tables.lowStockItems.length} tracked</Badge>}
              >
                <div className="space-y-3">
                  {analytics.tables.lowStockItems.map((item) => (
                    <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.item_code}</p>
                          <p className="font-medium text-slate-900">{item.ingredient}</p>
                          <p className="text-sm text-slate-500">{item.site}</p>
                        </div>
                        <Badge className={item.status === 'out_of_stock' ? 'bg-red-600' : 'bg-amber-500'}>
                          {item.status.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
                        <span>Current: {item.quantity.toFixed(1)}</span>
                        <span>Minimum: {item.minimum.toFixed(1)}</span>
                      </div>
                    </div>
                  ))}
                  {analytics.tables.lowStockItems.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                      No low stock items under the selected filters.
                    </div>
                  ) : null}
                </div>
              </SectionCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const ADMIN_DASHBOARD_LABELS = {
  [DASHBOARD_VIEWS.DEFAULT]: 'Default Dashboard',
  [DASHBOARD_VIEWS.HEAD_OFFICE]: 'Head Office',
  [DASHBOARD_VIEWS.GENERAL_MANAGER]: 'Head Office',
  [DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER]: 'Head Office',
  [DASHBOARD_VIEWS.AREA_MANAGER]: 'Area Manager View',
  [DASHBOARD_VIEWS.PROJECT_MANAGER]: 'Project Manager View'
};

function normalizeAdminDashboardPreviewView(view) {
  if (view === DASHBOARD_VIEWS.GENERAL_MANAGER || view === DASHBOARD_VIEWS.ASSISTANT_GENERAL_MANAGER) {
    return DASHBOARD_VIEWS.HEAD_OFFICE;
  }
  return view;
}

const ADMIN_DASHBOARD_PREVIEW_ORDER = Array.from(new Set(
  ADMIN_DASHBOARD_VIEW_ORDER.map(normalizeAdminDashboardPreviewView)
));

function DashboardPermissionLoading() {
  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1680px] space-y-5">
        <Skeleton className="h-16 rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-[420px] rounded-2xl" />
      </div>
    </div>
  );
}

function AdminDashboardCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [managementDateRange, setManagementDateRange] = useState(getInitialManagementDateRange);
  const activeView = ADMIN_DASHBOARD_PREVIEW_ORDER[activeIndex];
  const move = (offset) => {
    setActiveIndex((current) => (
      (current + offset + ADMIN_DASHBOARD_PREVIEW_ORDER.length) % ADMIN_DASHBOARD_PREVIEW_ORDER.length
    ));
  };

  return (
    <section aria-label="Administrator dashboard perspectives" className="min-h-screen bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-slate-900 text-white hover:bg-slate-900">Administrator</Badge>
              <span className="text-sm font-semibold text-slate-900">Dashboard perspective</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Preview each role dashboard without changing your account permissions or location access.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10"
              aria-label="Show previous dashboard"
              onClick={() => move(-1)}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-[190px] rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-center" aria-live="polite">
              <p className="text-sm font-semibold text-slate-900">{ADMIN_DASHBOARD_LABELS[activeView]}</p>
              <p className="text-[11px] text-slate-500">{activeIndex + 1} of {ADMIN_DASHBOARD_PREVIEW_ORDER.length}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10"
              aria-label="Show next dashboard"
              onClick={() => move(1)}
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="mx-auto mt-3 flex max-w-[1680px] flex-wrap items-center justify-center gap-2" aria-label="Dashboard perspectives">
          {ADMIN_DASHBOARD_PREVIEW_ORDER.map((view, index) => (
            <button
              key={view}
              type="button"
              aria-pressed={index === activeIndex}
              className={`min-h-9 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                index === activeIndex
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700'
              }`}
              onClick={() => setActiveIndex(index)}
            >
              {ADMIN_DASHBOARD_LABELS[view]}
            </button>
          ))}
        </div>
      </div>

      {activeView === DASHBOARD_VIEWS.DEFAULT ? (
        <DefaultDashboard />
      ) : (
        <div className="mx-auto max-w-[1680px] p-4 sm:p-6 lg:p-8">
          <ManagementDashboard
            view={activeView}
            isAdminPreview
            dateRange={managementDateRange}
            onDateRangeChange={setManagementDateRange}
          />
        </div>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { dashboardView, isAdmin, loading } = usePermissions();

  if (loading) return <DashboardPermissionLoading />;
  if (isAdmin) return <AdminDashboardCarousel />;
  if (dashboardView) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-[1680px]">
          <ManagementDashboard view={dashboardView} />
        </div>
      </div>
    );
  }
  return <DefaultDashboard />;
}
