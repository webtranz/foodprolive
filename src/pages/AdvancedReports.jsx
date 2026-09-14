import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isWithinInterval, parseISO, subDays } from 'date-fns';
import jsPDF from 'jspdf';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV, downloadExcel } from '../components/utils/exportData';
import { formatCurrency, replaceVisibleUSDCurrency } from '@/lib/currency';
import { calculateProductionIngredientCost } from '../../shared/ingredientUnits.js';
import {
  buildConfirmedFoodCostRows,
  groupFoodCostRows
} from '../../shared/foodCostReport.js';
import { canAccessAdvancedReport } from '../../shared/advancedReportAccess.js';
import { getItemCodeFromRecords } from '../../shared/itemCode.js';
import {
  CalendarClock,
  Download,
  FileSpreadsheet,
  FileText,
  Mail,
  ShieldAlert,
  TrendingUp
} from 'lucide-react';

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
}

function classifyMenuItem(popularity, margin, avgPopularity, avgMargin) {
  if (popularity >= avgPopularity && margin >= avgMargin) return 'Star';
  if (popularity >= avgPopularity && margin < avgMargin) return 'Plow Horse';
  if (popularity < avgPopularity && margin >= avgMargin) return 'Puzzle';
  return 'Dog';
}

function buildPdf(rows, title, filters) {
  const pdf = new jsPDF('l', 'mm', 'a4');
  const headers = rows.length ? Object.keys(rows[0]) : [];
  pdf.setFontSize(18);
  pdf.text(replaceVisibleUSDCurrency(title), 14, 16);
  pdf.setFontSize(9);
  pdf.text(`Date: ${filters.startDate} to ${filters.endDate}`, 14, 24);
  pdf.text(`Location: ${filters.locationId === 'all' ? 'All Locations' : filters.locationName}`, 14, 29);
  pdf.text(`Category: ${filters.category === 'all' ? 'All Categories' : filters.category}`, 14, 34);

  let y = 42;
  if (headers.length > 0) {
    pdf.setFont(undefined, 'bold');
    headers.slice(0, 6).forEach((header, index) => {
      pdf.text(String(header), 14 + (index * 45), y);
    });
    pdf.setFont(undefined, 'normal');
    y += 6;
  }

  rows.slice(0, 22).forEach((row) => {
    headers.slice(0, 6).forEach((header, index) => {
      pdf.text(String(row[header] ?? '').slice(0, 28), 14 + (index * 45), y);
    });
    y += 6;
    if (y > 190) {
      pdf.addPage();
      y = 18;
    }
  });

  pdf.save(`${title.toLowerCase().replace(/\s+/g, '_')}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.pdf`);
}

const reportAccess = {
  food_cost: ['admin', 'manager'],
  recipe_profitability: ['admin', 'manager'],
  menu_engineering: ['admin', 'manager'],
  waste_cost: ['admin', 'manager'],
  supplier_price_variance: ['admin'],
  purchase_order: ['admin', 'manager'],
  inventory_valuation: ['admin', 'manager'],
  production_efficiency: ['admin', 'manager'],
  location_comparison: ['admin', 'manager'],
  sales_vs_production: ['admin', 'manager'],
  forecasted_demand: ['admin', 'manager']
};

const reportDefinitions = [
  { key: 'food_cost', title: 'Food Cost Report', category: 'financial' },
  { key: 'recipe_profitability', title: 'Recipe Profitability Report', category: 'financial' },
  { key: 'menu_engineering', title: 'Menu Engineering Report', category: 'analytics' },
  { key: 'waste_cost', title: 'Waste Cost Report', category: 'operational' },
  { key: 'supplier_price_variance', title: 'Supplier Price Variance Report', category: 'procurement' },
  { key: 'purchase_order', title: 'Purchase Order Report', category: 'procurement' },
  { key: 'inventory_valuation', title: 'Inventory Valuation Report', category: 'inventory' },
  { key: 'production_efficiency', title: 'Production Efficiency Report', category: 'operations' },
  { key: 'location_comparison', title: 'Location Comparison Report', category: 'operations' },
  { key: 'sales_vs_production', title: 'Sales vs Production Report', category: 'analytics' },
  { key: 'forecasted_demand', title: 'Forecasted Demand Report', category: 'forecasting' }
];

const scheduleTemplate = {
  report_key: 'food_cost',
  recipients: '',
  frequency: 'weekly',
  format: 'pdf',
  location_id: 'all',
  category: 'all',
  notes: '',
  next_run_date: format(addDays(new Date(), 7), 'yyyy-MM-dd')
};

export default function AdvancedReports() {
  const { accessLevel, permissions, can, loading: permLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    locationId: 'all',
    category: 'all',
    mealType: 'all',
    foodCostView: 'detail'
  });
  const [activeReport, setActiveReport] = useState('food_cost');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleForm, setScheduleForm] = useState(scheduleTemplate);
  const [emailStatus, setEmailStatus] = useState('');

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: ingredients = [] } = useQuery({ queryKey: ['ingredients'], queryFn: () => base44.entities.Ingredient.list() });
  const { data: recipes = [] } = useQuery({ queryKey: ['recipes'], queryFn: () => base44.entities.Recipe.list() });
  const { data: productions = [] } = useQuery({ queryKey: ['productions'], queryFn: () => base44.entities.Production.list('-production_date', 500) });
  const { data: mealServiceConsumptions = [] } = useQuery({ queryKey: ['advancedMealServiceConsumptions'], queryFn: () => base44.entities.MealServiceConsumption.list('-service_date', 5000) });
  const { data: producedItemBatches = [] } = useQuery({ queryKey: ['advancedProducedItemBatches'], queryFn: () => base44.entities.ProducedItemBatch.list('-production_date', 5000) });
  const { data: waste = [] } = useQuery({ queryKey: ['foodWaste'], queryFn: () => base44.entities.FoodWaste.list('-waste_date', 500) });
  const { data: purchaseOrders = [] } = useQuery({ queryKey: ['procurementOrders'], queryFn: () => base44.procurement.listOrders() });
  const { data: inventoryValuation = [] } = useQuery({ queryKey: ['inventoryValuation'], queryFn: () => base44.inventory.getValuation() });
  const { data: salesSummary = [] } = useQuery({
    queryKey: ['salesSummary', filters.startDate, filters.endDate, filters.locationId],
    queryFn: () => base44.pos.getSalesSummary({
      start_date: filters.startDate,
      end_date: filters.endDate,
      location_id: filters.locationId === 'all' ? '' : filters.locationId
    })
  });
  const { data: salesVariance = [] } = useQuery({
    queryKey: ['salesVariance', filters.startDate, filters.endDate, filters.locationId],
    queryFn: () => base44.pos.getVarianceReport({
      start_date: filters.startDate,
      end_date: filters.endDate,
      location_id: filters.locationId === 'all' ? '' : filters.locationId
    })
  });
  const { data: schedules = [] } = useQuery({
    queryKey: ['advancedReportSchedules'],
    queryFn: () => base44.entities.AdvancedReportSchedule.list('-updated_date', 100),
    enabled: can('view_reports')
  });

  const scheduleMutation = useMutation({
    mutationFn: (payload) => base44.entities.AdvancedReportSchedule.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['advancedReportSchedules'] });
      setScheduleOpen(false);
      setScheduleForm(scheduleTemplate);
    }
  });

  const sendEmailMutation = useMutation({
    mutationFn: (payload) => base44.integrations.Core.SendEmail(payload),
    onSuccess: () => setEmailStatus('Report email sent successfully.'),
    onError: (error) => setEmailStatus(error.message || 'Failed to send report email')
  });

  const ingredientMap = useMemo(() => Object.fromEntries(ingredients.map((item) => [item.id, item])), [ingredients]);
  const siteMap = useMemo(() => Object.fromEntries(sites.map((item) => [item.id, item])), [sites]);
  const relatedLocationIds = useMemo(() => {
    if (filters.locationId === 'all') return null;
    const siteLookup = new Map(sites.map((site) => [String(site.id), site]));
    const related = new Set([String(filters.locationId)]);

    let selectedCursor = siteLookup.get(String(filters.locationId));
    while (selectedCursor?.parent_site_id) {
      related.add(String(selectedCursor.parent_site_id));
      selectedCursor = siteLookup.get(String(selectedCursor.parent_site_id));
    }

    sites.forEach((site) => {
      let cursor = site;
      while (cursor?.parent_site_id) {
        if (String(cursor.parent_site_id) === String(filters.locationId)) {
          related.add(String(site.id));
          break;
        }
        cursor = siteLookup.get(String(cursor.parent_site_id));
      }
    });

    return related;
  }, [filters.locationId, sites]);

  const availableReports = useMemo(
    () => reportDefinitions.filter((report) => canAccessAdvancedReport(
      { accessLevel, permissions },
      reportAccess[report.key] || []
    )),
    [accessLevel, permissions]
  );

  const categories = useMemo(() => {
    const values = new Set();
    recipes.forEach((recipe) => { if (recipe.category) values.add(recipe.category); });
    ingredients.forEach((ingredient) => { if (ingredient.category) values.add(ingredient.category); });
    productions.forEach((production) => { if (production.menu_category) values.add(production.menu_category); });
    mealServiceConsumptions.forEach((consumption) => { if (consumption.menu_category) values.add(consumption.menu_category); });
    return [...values].sort();
  }, [ingredients, mealServiceConsumptions, productions, recipes]);

  const filteredData = useMemo(() => {
    const start = parseISO(filters.startDate);
    const end = parseISO(filters.endDate);
    const matchesDate = (value) => {
      if (!value) return false;
      return isWithinInterval(parseISO(value), { start, end });
    };
    const matchesLocation = (siteId) => filters.locationId === 'all' || relatedLocationIds?.has(String(siteId || ''));
    const matchesCategory = (category) => filters.category === 'all' || category === filters.category;

    const matchesMealType = (mealType) => filters.mealType === 'all' || (mealType || 'unspecified') === filters.mealType;

    const filteredProductions = productions.filter((production) => {
      const recipe = recipes.find((item) => item.id === production.recipe_id);
      return matchesDate(production.production_date)
        && matchesLocation(production.site_id)
        && matchesCategory(production.menu_category || recipe?.category)
        && matchesMealType(production.meal_type);
    });
    const filteredMealServiceConsumptions = mealServiceConsumptions.filter((consumption) => {
      const recipe = recipes.find((item) => item.id === consumption.recipe_id);
      return matchesDate(consumption.service_date)
        && matchesLocation(consumption.site_id)
        && matchesCategory(consumption.menu_category || recipe?.category)
        && matchesMealType(consumption.meal_type);
    });

    const filteredWaste = waste.filter((entry) => matchesDate(entry.waste_date) && matchesLocation(entry.site_id) && matchesCategory(entry.category || ingredientMap[entry.ingredient_id]?.category));
    const filteredOrders = purchaseOrders.filter((order) => (!order.order_date || matchesDate(order.order_date)) && matchesLocation(order.site_id));
    const filteredValuation = inventoryValuation.filter((item) => matchesLocation(item.site_id) && matchesCategory(ingredientMap[item.ingredient_id]?.category));
    const filteredSalesSummary = salesSummary.filter((entry) => filters.locationId === 'all' || entry.site_id === filters.locationId || entry.location_id === filters.locationId);
    const filteredSalesVariance = salesVariance.filter((entry) => filters.locationId === 'all' || entry.site_id === filters.locationId);

    return {
      productions: filteredProductions,
      mealServiceConsumptions: filteredMealServiceConsumptions,
      waste: filteredWaste,
      orders: filteredOrders,
      valuation: filteredValuation,
      salesSummary: filteredSalesSummary,
      salesVariance: filteredSalesVariance
    };
  }, [filters, ingredientMap, inventoryValuation, mealServiceConsumptions, productions, purchaseOrders, recipes, relatedLocationIds, salesSummary, salesVariance, waste]);

  const reportRows = useMemo(() => {
    const productionCostRows = buildConfirmedFoodCostRows({
      consumptions: filteredData.mealServiceConsumptions,
      productions,
      producedItemBatches,
      recipes,
      ingredients
    });
    const foodCostRows = groupFoodCostRows(productionCostRows, filters.foodCostView);

    const groupedRecipeCosts = Object.values(productionCostRows.reduce((accumulator, row) => {
      const key = row.recipe;
      if (!accumulator[key]) {
        accumulator[key] = {
          recipe: row.recipe,
          location: row.location,
          category: row.category,
          total_servings: 0,
          total_cost: 0
        };
      }
      accumulator[key].total_servings += row.servings;
      accumulator[key].total_cost += row.total_cost;
      return accumulator;
    }, {})).map((entry) => {
      const costPerServing = entry.total_servings > 0 ? entry.total_cost / entry.total_servings : 0;
      const estimatedSalePrice = costPerServing * 1.8;
      const marginValue = estimatedSalePrice - costPerServing;
      return {
        recipe: entry.recipe,
        location: entry.location,
        category: entry.category,
        total_servings: entry.total_servings,
        total_cost: Number(entry.total_cost.toFixed(2)),
        estimated_sale_price: Number(estimatedSalePrice.toFixed(2)),
        margin_per_serving: Number(marginValue.toFixed(2)),
        margin_percent: Number((estimatedSalePrice > 0 ? (marginValue / estimatedSalePrice) * 100 : 0).toFixed(2))
      };
    });

    const menuEngineeringBase = Object.values(filteredData.salesSummary.reduce((accumulator, row) => {
      const itemName = row.pos_item_name || row.item_name || 'Unknown';
      const recipe = recipes.find((entry) => entry.name === itemName);
      const itemCode = String(row.pos_item_code || row.item_code || recipe?.recipe_code || '').trim() || '—';
      const key = `${row.location_name || row.site_name}::${itemCode === '—' ? itemName : itemCode}`;
      if (!accumulator[key]) {
        accumulator[key] = {
          item_code: itemCode,
          item_name: itemName,
          location: row.location_name || row.site_name || 'Unknown',
          quantity_sold: 0,
          revenue: 0
        };
      }
      accumulator[key].quantity_sold += safeNumber(row.total_quantity);
      accumulator[key].revenue += safeNumber(row.total_sales || row.total_price);
      return accumulator;
    }, {})).map((row) => {
      const recipeMatch = groupedRecipeCosts.find((entry) => entry.recipe === row.item_name);
      const marginPerServing = recipeMatch?.margin_per_serving || 0;
      return {
        ...row,
        margin_per_serving: Number(marginPerServing.toFixed(2)),
        popularity_score: row.quantity_sold
      };
    });

    const avgPopularity = average(menuEngineeringBase.map((row) => row.popularity_score));
    const avgMargin = average(menuEngineeringBase.map((row) => row.margin_per_serving));
    const menuEngineeringRows = menuEngineeringBase.map((row) => ({
      ...row,
      quadrant: classifyMenuItem(row.popularity_score, row.margin_per_serving, avgPopularity, avgMargin)
    }));

    const wasteCostRows = filteredData.waste.map((entry) => ({
      item_code: getItemCodeFromRecords([ingredientMap[entry.ingredient_id], entry]),
      item_name: entry.ingredient_name || entry.recipe_name || 'Waste Item',
      date: entry.waste_date,
      location: entry.site_name,
      category: entry.category || ingredientMap[entry.ingredient_id]?.category || '-',
      quantity: Number(safeNumber(entry.quantity).toFixed(2)),
      estimated_cost: Number(safeNumber(entry.estimated_cost).toFixed(2)),
      reason: entry.reason || entry.notes || '-'
    }));

    const supplierVarianceRows = Object.values(filteredData.orders.flatMap((order) => (order.items || []).map((item) => ({
      item_code: getItemCodeFromRecords([ingredientMap[item.ingredient_id], item]),
      item_name: item.ingredient_name || item.item_name || 'Unknown',
      supplier: order.supplier_name,
      location: order.site_name,
      unit_price: safeNumber(item.unit_price),
      quantity: safeNumber(item.quantity || item.ordered_quantity),
      po_number: order.po_number
    }))).reduce((accumulator, row) => {
      const key = `${row.item_code}::${row.item_name}`;
      if (!accumulator[key]) {
        accumulator[key] = {
          item_code: row.item_code,
          item_name: row.item_name,
          min_price: row.unit_price,
          max_price: row.unit_price,
          average_price: 0,
          price_points: [],
          supplier_count: 0
        };
      }
      accumulator[key].min_price = Math.min(accumulator[key].min_price, row.unit_price);
      accumulator[key].max_price = Math.max(accumulator[key].max_price, row.unit_price);
      accumulator[key].price_points.push(row.unit_price);
      accumulator[key].supplier_count += 1;
      return accumulator;
    }, {})).map((entry) => ({
      item_code: entry.item_code,
      item_name: entry.item_name,
      min_price: Number(entry.min_price.toFixed(2)),
      max_price: Number(entry.max_price.toFixed(2)),
      average_price: Number(average(entry.price_points).toFixed(2)),
      variance_percent: Number((entry.min_price > 0 ? ((entry.max_price - entry.min_price) / entry.min_price) * 100 : 0).toFixed(2)),
      supplier_count: entry.supplier_count
    }));

    const purchaseOrderRows = filteredData.orders.map((order) => ({
      po_number: order.po_number,
      supplier: order.supplier_name,
      location: order.site_name,
      order_date: order.order_date,
      expected_delivery: order.expected_delivery_date || '-',
      status: order.status,
      total_amount: Number(safeNumber(order.total_amount).toFixed(2)),
      item_count: Array.isArray(order.items) ? order.items.length : 0
    }));

    const inventoryValuationRows = filteredData.valuation.map((item) => ({
      item_code: getItemCodeFromRecords([ingredientMap[item.ingredient_id], item]),
      item_name: item.ingredient_name || ingredientMap[item.ingredient_id]?.name || 'Unnamed item',
      location: item.site_name,
      category: ingredientMap[item.ingredient_id]?.category || '-',
      quantity: Number(safeNumber(item.quantity).toFixed(2)),
      valuation_method: item.valuation_method === 'weighted_average' ? 'Weighted Average' : 'FIFO',
      fifo_value: Number(safeNumber(item.fifo_value).toFixed(2)),
      weighted_average_value: Number(safeNumber(item.weighted_average_value).toFixed(2))
    }));

    const productionEfficiencyRows = filteredData.productions.map((production) => {
      const target = safeNumber(production.target_servings);
      const actual = safeNumber(production.actual_servings || production.target_servings);
      return {
        date: production.production_date,
        location: production.site_name,
        recipe: production.recipe_name,
        status: production.status,
        target_servings: target,
        actual_servings: actual,
        efficiency_percent: Number((target > 0 ? (actual / target) * 100 : 0).toFixed(2))
      };
    });

    const locationComparisonRows = Object.values(filteredData.productions.reduce((accumulator, production) => {
      const key = production.site_id || production.site_name;
      if (!accumulator[key]) {
        accumulator[key] = {
          location: production.site_name,
          production_qty: 0,
          waste_cost: 0,
          food_cost: 0,
          efficiency_percent: []
        };
      }
      const target = safeNumber(production.target_servings);
      const actual = safeNumber(production.actual_servings || production.target_servings);
      accumulator[key].production_qty += actual;
      accumulator[key].food_cost += (production.ingredients_used || []).reduce((sum, ingredient) => {
        return sum + calculateProductionIngredientCost(
          ingredient,
          ingredientMap[ingredient.ingredient_id]
        );
      }, 0);
      accumulator[key].efficiency_percent.push(target > 0 ? (actual / target) * 100 : 0);
      return accumulator;
    }, {})).map((entry) => {
      const wasteCost = filteredData.waste
        .filter((item) => item.site_name === entry.location)
        .reduce((sum, item) => sum + safeNumber(item.estimated_cost), 0);
      return {
        location: entry.location,
        production_qty: Number(entry.production_qty.toFixed(2)),
        waste_cost: Number(wasteCost.toFixed(2)),
        food_cost: Number(entry.food_cost.toFixed(2)),
        efficiency_percent: Number(average(entry.efficiency_percent).toFixed(2))
      };
    });

    const salesVsProductionRows = filteredData.salesVariance.map((row) => ({
      item_code: String(row.pos_item_code || row.item_code || recipes.find((recipe) => recipe.name === row.item_name)?.recipe_code || '').trim() || '—',
      item_name: row.item_name || 'Unknown item',
      date: row.business_date,
      location: row.site_name,
      sales_qty: Number(safeNumber(row.sales_quantity).toFixed(2)),
      production_qty: Number(safeNumber(row.production_quantity).toFixed(2)),
      variance_qty: Number(safeNumber(row.variance_quantity).toFixed(2)),
      variance_percent: Number(safeNumber(row.variance_percent).toFixed(2))
    }));

    const forecastDemandRows = Object.values(filteredData.salesSummary.reduce((accumulator, row) => {
      const itemName = row.pos_item_name || row.item_name || 'Unknown';
      const recipe = recipes.find((entry) => entry.name === itemName);
      const itemCode = String(row.pos_item_code || row.item_code || recipe?.recipe_code || '').trim() || '—';
      const key = `${row.location_name || row.site_name}::${itemCode === '—' ? itemName : itemCode}`;
      if (!accumulator[key]) {
        accumulator[key] = {
          item_code: itemCode,
          item_name: itemName,
          location: row.location_name || row.site_name || 'Unknown',
          daily_sales: [],
          daily_production: []
        };
      }
      accumulator[key].daily_sales.push(safeNumber(row.total_quantity));
      const relatedVariance = filteredData.salesVariance.find((entry) => {
        if (entry.site_name !== (row.location_name || row.site_name)) return false;
        const varianceRecipe = recipes.find((recipe) => recipe.name === entry.item_name);
        const varianceCode = String(entry.pos_item_code || entry.item_code || varianceRecipe?.recipe_code || '').trim() || '—';
        if (itemCode !== '—') return varianceCode === itemCode;
        return varianceCode === '—' && entry.item_name === itemName;
      });
      if (relatedVariance) {
        accumulator[key].daily_production.push(safeNumber(relatedVariance.production_quantity));
      }
      return accumulator;
    }, {})).map((entry) => {
      const avgSales = average(entry.daily_sales);
      const avgProduction = average(entry.daily_production);
      const trendPercent = avgProduction > 0 ? ((avgSales - avgProduction) / avgProduction) * 100 : 0;
      return {
        item_code: entry.item_code,
        item_name: entry.item_name,
        location: entry.location,
        avg_daily_sales: Number(avgSales.toFixed(2)),
        avg_daily_production: Number(avgProduction.toFixed(2)),
        forecast_next_7_days: Number((avgSales * 7).toFixed(2)),
        demand_trend_percent: Number(trendPercent.toFixed(2))
      };
    });

    return {
      food_cost: foodCostRows,
      recipe_profitability: groupedRecipeCosts,
      menu_engineering: menuEngineeringRows,
      waste_cost: wasteCostRows,
      supplier_price_variance: supplierVarianceRows,
      purchase_order: purchaseOrderRows,
      inventory_valuation: inventoryValuationRows,
      production_efficiency: productionEfficiencyRows,
      location_comparison: locationComparisonRows,
      sales_vs_production: salesVsProductionRows,
      forecasted_demand: forecastDemandRows
    };
  }, [filteredData, filters.foodCostView, ingredientMap, ingredients, producedItemBatches, productions, recipes]);

  const currentRows = reportRows[activeReport] || [];
  const currentReport = reportDefinitions.find((report) => report.key === activeReport);
  const currentLocationName = sites.find((site) => site.id === filters.locationId)?.name || 'All Locations';

  const summaryCards = useMemo(() => [
    { title: 'Accessible Reports', value: availableReports.length, subtitle: 'Based on your role' },
    { title: 'Rows In Current Report', value: currentRows.length, subtitle: currentReport?.title || 'No report selected' },
    { title: 'Saved Email Schedules', value: schedules.length, subtitle: 'Recurring report definitions' }
  ], [availableReports.length, currentRows.length, currentReport?.title, schedules.length]);

  const handleExport = (type) => {
    if (!currentRows.length || !currentReport) return;
    if (type === 'csv') {
      downloadCSV(currentRows, currentReport.title.toLowerCase().replace(/\s+/g, '_'));
      return;
    }
    if (type === 'excel') {
      downloadExcel(currentRows, currentReport.title.toLowerCase().replace(/\s+/g, '_'), currentReport.title.slice(0, 28));
      return;
    }
    buildPdf(currentRows, currentReport.title, { ...filters, locationName: currentLocationName });
  };

  const sendCurrentReportEmail = (schedule) => {
    const report = reportDefinitions.find((item) => item.key === schedule.report_key);
    const rows = reportRows[schedule.report_key] || [];
    const previewRows = rows.slice(0, 8).map((row) => (
      `<tr>${Object.values(row).slice(0, 5).map((value) => `<td style="padding:6px;border:1px solid #ddd;">${String(value ?? '')}</td>`).join('')}</tr>`
    )).join('');

    sendEmailMutation.mutate({
      to: schedule.recipients,
      subject: `${replaceVisibleUSDCurrency(report?.title || 'FoodPro Report')} - ${format(new Date(), 'yyyy-MM-dd')}`,
      html: `
        <h2>${replaceVisibleUSDCurrency(report?.title || 'FoodPro Report')}</h2>
        <p>Frequency: ${schedule.frequency}</p>
        <p>Rows included: ${rows.length}</p>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">
          <tbody>${previewRows}</tbody>
        </table>
        <p style="margin-top:16px;">Generated from FoodPro Advanced Reports.</p>
      `
    });
  };

  if (permLoading) {
    return <div className="p-8 text-slate-500">Loading reports...</div>;
  }

  if (!can('view_reports')) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <Card className="max-w-sm w-full text-center p-8">
          <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500 mt-2">You do not have access to the advanced reporting workspace.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1680px] mx-auto space-y-6">
        <PageHeader
          title="Advanced Reports"
          description="Financial, operational, procurement, and forecasting reports with export and email scheduling"
        >
          <Button variant="outline" onClick={() => setScheduleOpen(true)}>
            <CalendarClock className="w-4 h-4 mr-2" />
            Schedule Email Report
          </Button>
        </PageHeader>

        <div className="grid gap-4 md:grid-cols-3">
          {summaryCards.map((card) => (
            <Card key={card.title} className="border-slate-200 shadow-sm">
              <CardContent className="p-5">
                <p className="text-sm text-slate-500">{card.title}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{card.value}</p>
                <p className="mt-1 text-xs text-slate-500">{card.subtitle}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Report Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
              <div>
                <Label>Start Date</Label>
                <Input type="date" className="mt-1" value={filters.startDate} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))} />
              </div>
              <div>
                <Label>End Date</Label>
                <Input type="date" className="mt-1" value={filters.endDate} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))} />
              </div>
              <div>
                <Label>Location</Label>
                <Select value={filters.locationId} onValueChange={(value) => setFilters((current) => ({ ...current, locationId: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select value={filters.category} onValueChange={(value) => setFilters((current) => ({ ...current, category: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Meal Type</Label>
                <Select value={filters.mealType} onValueChange={(value) => setFilters((current) => ({ ...current, mealType: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Meal Types</SelectItem>
                    <SelectItem value="breakfast">Breakfast</SelectItem>
                    <SelectItem value="lunch">Lunch</SelectItem>
                    <SelectItem value="dinner">Dinner</SelectItem>
                    <SelectItem value="snack">Snack</SelectItem>
                    <SelectItem value="unspecified">Unspecified</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Food Cost View</Label>
                <Select value={filters.foodCostView} onValueChange={(value) => setFilters((current) => ({ ...current, foodCostView: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="detail">Detailed</SelectItem>
                    <SelectItem value="daily">Daily Wise</SelectItem>
                    <SelectItem value="meal_type">Type Wise</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeReport} onValueChange={setActiveReport} className="space-y-4">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
            {availableReports.map((report) => (
              <TabsTrigger key={report.key} value={report.key}>{report.title}</TabsTrigger>
            ))}
          </TabsList>

          {availableReports.map((report) => {
            const rows = reportRows[report.key] || [];
            const columns = rows.length ? Object.keys(rows[0]) : [];
            return (
              <TabsContent key={report.key} value={report.key} className="space-y-4">
                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle>{report.title}</CardTitle>
                      <p className="text-sm text-slate-500 mt-1">
                        {rows.length} rows • Role access: {(reportAccess[report.key] || []).join(', ')}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => handleExport('csv')}>
                        <Download className="w-4 h-4 mr-2" />
                        CSV
                      </Button>
                      <Button variant="outline" onClick={() => handleExport('excel')}>
                        <FileSpreadsheet className="w-4 h-4 mr-2" />
                        Excel
                      </Button>
                      <Button variant="outline" onClick={() => handleExport('pdf')}>
                        <FileText className="w-4 h-4 mr-2" />
                        PDF
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      <TrendingUp className="w-4 h-4" />
                      {report.category} report view for {currentLocationName}
                    </div>
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {columns.map((column) => (
                              <TableHead key={column}>{column.replace(/_/g, ' ')}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={Math.max(columns.length, 1)} className="py-10 text-center text-slate-500">
                                No data available for this report and filter combination.
                              </TableCell>
                            </TableRow>
                          ) : rows.slice(0, 25).map((row, index) => (
                            <TableRow key={`${report.key}-${index}`}>
                              {columns.map((column) => (
                                <TableCell key={column}>
                                  {typeof row[column] === 'number' && (column.includes('cost') || column.includes('price') || column.includes('revenue') || column.includes('amount') || column.includes('value') || column.includes('margin'))
                                    ? formatCurrency(row[column])
                                    : row[column]}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            );
          })}
        </Tabs>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Scheduled Email Reports</CardTitle>
            <Badge variant="outline">{schedules.length} schedules</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {emailStatus ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                {emailStatus}
              </div>
            ) : null}
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Report</TableHead>
                    <TableHead>Recipients</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Next Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                        No scheduled report emails configured yet.
                      </TableCell>
                    </TableRow>
                  ) : schedules.map((schedule) => (
                    <TableRow key={schedule.id}>
                      <TableCell>{reportDefinitions.find((item) => item.key === schedule.report_key)?.title || schedule.report_key}</TableCell>
                      <TableCell>{schedule.recipients}</TableCell>
                      <TableCell>{schedule.frequency}</TableCell>
                      <TableCell>{schedule.format?.toUpperCase()}</TableCell>
                      <TableCell>{schedule.next_run_date || '-'}</TableCell>
                      <TableCell>
                        <Badge variant={schedule.status === 'active' ? 'default' : 'secondary'}>
                          {schedule.status || 'active'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => sendCurrentReportEmail(schedule)} disabled={sendEmailMutation.isPending}>
                          <Mail className="w-4 h-4 mr-2" />
                          Send Now
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Schedule Email Report</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Report</Label>
                <Select value={scheduleForm.report_key} onValueChange={(value) => setScheduleForm((current) => ({ ...current, report_key: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {availableReports.map((report) => <SelectItem key={report.key} value={report.key}>{report.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Recipients</Label>
                <Input className="mt-1" value={scheduleForm.recipients} onChange={(event) => setScheduleForm((current) => ({ ...current, recipients: event.target.value }))} placeholder="ops@example.com, finance@example.com" />
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <Label>Frequency</Label>
                  <Select value={scheduleForm.frequency} onValueChange={(value) => setScheduleForm((current) => ({ ...current, frequency: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Format</Label>
                  <Select value={scheduleForm.format} onValueChange={(value) => setScheduleForm((current) => ({ ...current, format: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pdf">PDF</SelectItem>
                      <SelectItem value="excel">Excel</SelectItem>
                      <SelectItem value="csv">CSV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Next Run</Label>
                  <Input type="date" className="mt-1" value={scheduleForm.next_run_date} onChange={(event) => setScheduleForm((current) => ({ ...current, next_run_date: event.target.value }))} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Location</Label>
                  <Select value={scheduleForm.location_id} onValueChange={(value) => setScheduleForm((current) => ({ ...current, location_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Locations</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Category</Label>
                  <Select value={scheduleForm.category} onValueChange={(value) => setScheduleForm((current) => ({ ...current, category: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea className="mt-1" rows={3} value={scheduleForm.notes} onChange={(event) => setScheduleForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Distribution instructions or business context" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setScheduleOpen(false)}>Cancel</Button>
              <Button
                onClick={() => scheduleMutation.mutate({ ...scheduleForm, status: 'active' })}
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={scheduleMutation.isPending}
              >
                {scheduleMutation.isPending ? 'Saving...' : 'Save Schedule'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
