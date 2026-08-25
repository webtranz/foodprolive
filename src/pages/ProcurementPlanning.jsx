import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ShoppingCart, Package, AlertTriangle, Download, CheckCircle2, Send } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { downloadCSV } from '../components/utils/exportData';
import StatCard from '@/components/ui/StatCard';
import { formatCurrency } from '@/lib/currency';
import { getInventoryQuantities, getProductionInventoryState } from '@/lib/inventoryAvailability';
import { convertIngredientQuantity } from '../../shared/ingredientUnits.js';
import { getItemCode } from '../../shared/itemCode.js';

const PROTEIN_CATEGORIES = ['proteins_meat', 'proteins_poultry', 'proteins_seafood', 'proteins_plant'];
const GRAIN_CATEGORIES = ['grains_cereals'];
const VEG_CATEGORIES = ['vegetables', 'fruits'];

export default function ProcurementPlanning() {
  const [selectedSite, setSelectedSite] = useState('all');
  const [planningDate, setPlanningDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [bufferPercent, setBufferPercent] = useState(10);
  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: productions = [] } = useQuery({ queryKey: ['productions'], queryFn: () => base44.entities.Production.list('-production_date', 200) });
  const { data: ingredients = [] } = useQuery({ queryKey: ['ingredients'], queryFn: () => base44.entities.Ingredient.list() });
  const { data: inventory = [] } = useQuery({ queryKey: ['inventory'], queryFn: () => base44.inventory.getStockOnHand() });
  const { data: materialRequests = [] } = useQuery({ queryKey: ['materialRequests'], queryFn: () => base44.entities.MaterialRequest.list('-request_date', 50) });

  const createMRMutation = useMutation({
    mutationFn: (data) => base44.entities.MaterialRequest.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['materialRequests'] })
  });

  // Aggregate ingredient needs from planned/approved productions for planning date
  const aggregatedNeeds = useMemo(() => {
    const nextWeek = addDays(new Date(planningDate), 7);
    const relevantProds = productions.filter(p => {
      const matchesSite = selectedSite === 'all' || p.site_id === selectedSite;
      const inRange = p.production_date >= planningDate && p.production_date <= format(nextWeek, 'yyyy-MM-dd');
      const validStatus = [
        'planned',
        'pending_approval',
        'pending_procurement',
        'pending_production',
        'approved'
      ].includes(p.status);
      return matchesSite && inRange && validStatus;
    });

    const needsMap = {};
    relevantProds.forEach(prod => {
      const reservationState = getProductionInventoryState(prod);
      if (reservationState.is_consumed) return;

      const demandLines = reservationState.is_reserved && reservationState.lines.length > 0
        ? reservationState.lines
        : (prod.ingredients_used || []);
      demandLines.forEach(ing => {
        const ingData = ingredients.find(i => i.id === ing.ingredient_id);
        const demandUnit = ingData?.unit || ing.inventory_unit || ing.unit || 'unit';
        const sourceUnit = ing.inventory_unit || ing.unit || demandUnit;
        const plannedQuantity = convertIngredientQuantity(
          ing.desired_quantity
            ?? ing.required_quantity
            ?? ing.yield_adjusted_quantity
            ?? ing.planned_quantity
            ?? ing.adjusted_quantity
            ?? ing.actual_quantity
            ?? 0,
          sourceUnit,
          demandUnit,
          ingData
        );
        const productionReservedQuantity = reservationState.is_reserved
          ? convertIngredientQuantity(
            ing.reserved_quantity ?? ing.committed_quantity ?? 0,
            sourceUnit,
            demandUnit,
            ingData
          )
          : 0;
        if (!needsMap[ing.ingredient_id]) {
          needsMap[ing.ingredient_id] = {
            item_code: getItemCode(ingData, getItemCode(ing)),
            ingredient_id: ing.ingredient_id,
            ingredient_name: ing.ingredient_name,
            unit: demandUnit,
            category: ingData?.category || 'other',
            required_quantity: 0,
            production_reserved_quantity: 0,
            cost_per_unit: ingData?.cost_per_unit || 0
          };
        }
        needsMap[ing.ingredient_id].required_quantity += Math.max(0, plannedQuantity);
        needsMap[ing.ingredient_id].production_reserved_quantity += Math.max(
          0,
          Math.min(plannedQuantity, productionReservedQuantity)
        );
      });
    });

    return Object.values(needsMap).map(need => {
      const siteInventory = inventory.filter(i => selectedSite === 'all' || i.site_id === selectedSite);
      const stock = siteInventory
        .filter(i => i.ingredient_id === need.ingredient_id)
        .reduce((total, item) => {
          const quantities = getInventoryQuantities(item);
          return {
            on_hand_quantity: total.on_hand_quantity + quantities.on_hand_quantity,
            reserved_quantity: total.reserved_quantity + quantities.reserved_quantity,
            available_quantity: total.available_quantity + quantities.available_quantity
          };
        }, { on_hand_quantity: 0, reserved_quantity: 0, available_quantity: 0 });
      const grossWithBuffer = need.required_quantity * (1 + bufferPercent / 100);
      const withBuffer = Math.max(0, grossWithBuffer - need.production_reserved_quantity);
      const toPurchase = Math.max(0, withBuffer - stock.available_quantity);
      const estimatedCost = toPurchase * need.cost_per_unit;
      return {
        ...need,
        currentStock: stock.available_quantity,
        onHandStock: stock.on_hand_quantity,
        reservedStock: stock.reserved_quantity,
        availableStock: stock.available_quantity,
        grossWithBuffer,
        withBuffer,
        toPurchase,
        estimatedCost,
        sufficient: stock.available_quantity >= withBuffer
      };
    }).sort((a, b) => a.ingredient_name.localeCompare(b.ingredient_name));
  }, [productions, ingredients, inventory, selectedSite, planningDate, bufferPercent]);

  const totalEstimatedCost = aggregatedNeeds.reduce((sum, n) => sum + n.estimatedCost, 0);
  const shortageCount = aggregatedNeeds.filter(n => !n.sufficient).length;
  const totalItems = aggregatedNeeds.length;

  const groupByCategory = (catList) => aggregatedNeeds.filter(n => catList.includes(n.category));
  const proteins = groupByCategory(PROTEIN_CATEGORIES);
  const grains = groupByCategory(GRAIN_CATEGORIES);
  const vegetables = groupByCategory(VEG_CATEGORIES);
  const others = aggregatedNeeds.filter(n => ![...PROTEIN_CATEGORIES, ...GRAIN_CATEGORIES, ...VEG_CATEGORIES].includes(n.category));

  const generateMR = async () => {
    const itemsToPurchase = aggregatedNeeds.filter(n => n.toPurchase > 0);
    if (itemsToPurchase.length === 0) return;
    const site = sites.find(s => s.id === selectedSite);
    await createMRMutation.mutateAsync({
      request_number: `MR-PROC-${Date.now()}`,
      site_id: selectedSite === 'all' ? '' : selectedSite,
      site_name: site?.name || 'All Sites',
      request_date: format(new Date(), 'yyyy-MM-dd'),
      period_start: planningDate,
      period_end: format(addDays(new Date(planningDate), 7), 'yyyy-MM-dd'),
      items: itemsToPurchase.map(n => ({
        item_code: n.item_code === '—' ? '' : n.item_code,
        ingredient_id: n.ingredient_id,
        ingredient_name: n.ingredient_name,
        required_quantity: n.withBuffer,
        current_stock: n.currentStock,
        on_hand_stock: n.onHandStock,
        reserved_stock: n.reservedStock,
        available_stock: n.availableStock,
        request_quantity: n.toPurchase,
        unit: n.unit,
        estimated_cost: n.estimatedCost,
        d365_item_code: `ITEM-${n.ingredient_id?.substring(0, 8)}`
      })),
      total_estimated_cost: totalEstimatedCost,
      status: 'pending_chef_approval'
    });
  };

  const exportProcurementPlan = () => {
    const exportRows = aggregatedNeeds.map((need) => ({
      item_code: need.item_code,
      item_name: need.ingredient_name,
      category: need.category,
      on_hand_stock: need.onHandStock,
      reserved_stock: need.reservedStock,
      available_stock: need.availableStock,
      production_reserved_for_plan: need.production_reserved_quantity,
      unreserved_required_with_buffer: need.withBuffer,
      to_purchase: need.toPurchase,
      unit: need.unit,
      estimated_cost: need.estimatedCost,
      status: need.sufficient ? 'Sufficient' : 'Purchase Required'
    }));
    downloadCSV(exportRows, 'procurement_plan');
  };

  const renderIngredientGroup = (items, label, color) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-4">
        <h4 className={`text-sm font-semibold mb-2 px-1 ${color}`}>{label}</h4>
        {items.map((n, idx) => (
          <div key={idx} className={`flex items-center justify-between py-2 px-3 rounded-lg mb-1 ${n.sufficient ? 'bg-slate-50' : 'bg-red-50 border border-red-100'}`}>
            <div className="flex min-w-0 items-center gap-3">
              <span className="min-w-24 font-mono text-xs text-slate-500">{n.item_code}</span>
              <span className="text-sm font-medium text-slate-800">{n.ingredient_name}</span>
              {!n.sufficient && <span className="ml-2 text-xs text-red-600 font-medium">⚠ Short by {n.toPurchase.toFixed(1)} {n.unit}</span>}
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-slate-500">On hand: {n.onHandStock.toFixed(1)} {n.unit}</span>
              <span className="text-violet-700">Reserved: {n.reservedStock.toFixed(1)} {n.unit}</span>
              <span className="text-cyan-700">Available: {n.availableStock.toFixed(1)} {n.unit}</span>
              <span className="font-semibold text-slate-800">Unreserved need: {n.withBuffer.toFixed(1)} {n.unit}</span>
              {n.toPurchase > 0 && <Badge className="bg-orange-100 text-orange-700">Buy: {n.toPurchase.toFixed(1)} {n.unit}</Badge>}
              {n.toPurchase === 0 && <Badge className="bg-emerald-100 text-emerald-700">✓ In Stock</Badge>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader title="Procurement Planning" description="Auto-generate purchase requirements from production plans">
          <Button variant="outline" onClick={exportProcurementPlan}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={generateMR}
            disabled={createMRMutation.isPending || aggregatedNeeds.filter(n => n.toPurchase > 0).length === 0}
          >
            <Send className="w-4 h-4 mr-2" />
            {createMRMutation.isPending ? 'Generating...' : 'Generate Material Request'}
          </Button>
        </PageHeader>

        {/* Controls */}
        <Card className="border-slate-100 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div>
                <Label>Site</Label>
                <Select value={selectedSite} onValueChange={setSelectedSite}>
                  <SelectTrigger className="mt-1 w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sites</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Planning From Date</Label>
                <Input type="date" value={planningDate} onChange={e => setPlanningDate(e.target.value)} className="mt-1 w-[180px]" />
              </div>
              <div>
                <Label>Buffer % (safety stock)</Label>
                <Input type="number" min="0" max="50" value={bufferPercent} onChange={e => setBufferPercent(parseFloat(e.target.value) || 0)} className="mt-1 w-[120px]" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard title="Total Ingredients" value={totalItems} icon={Package} iconBg="bg-blue-50" iconColor="text-blue-600" />
          <StatCard title="Shortages" value={shortageCount} icon={AlertTriangle} iconBg="bg-red-50" iconColor="text-red-600" />
          <StatCard title="Est. Purchase Cost" value={formatCurrency(totalEstimatedCost)} icon={ShoppingCart} iconBg="bg-emerald-50" iconColor="text-emerald-600" />
          <StatCard title="Items to Purchase" value={aggregatedNeeds.filter(n => n.toPurchase > 0).length} icon={CheckCircle2} iconBg="bg-amber-50" iconColor="text-amber-600" />
        </div>

        <Tabs defaultValue="master_list" className="space-y-6">
          <TabsList className="bg-white border border-slate-200">
            <TabsTrigger value="master_list">Master Ingredient Summary</TabsTrigger>
            <TabsTrigger value="table">Detailed Table</TabsTrigger>
            <TabsTrigger value="requests">Material Requests</TabsTrigger>
          </TabsList>

          <TabsContent value="master_list">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-blue-600" /> Master Ingredient Summary
                  <Badge className="ml-2 bg-slate-100 text-slate-700">{planningDate} + 7 days</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {aggregatedNeeds.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <ShoppingCart className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                    <p>No production plans found for the selected period.</p>
                    <p className="text-sm mt-1">Add production plans first to generate procurement requirements.</p>
                  </div>
                ) : (
                  <>
                    {renderIngredientGroup(proteins, '🥩 Proteins', 'text-red-700')}
                    {renderIngredientGroup(grains, '🌾 Grains & Cereals', 'text-yellow-700')}
                    {renderIngredientGroup(vegetables, '🥦 Vegetables & Fruits', 'text-green-700')}
                    {renderIngredientGroup(others, '🫙 Other Ingredients', 'text-slate-700')}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="table">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader><CardTitle>Detailed Procurement Table</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>On Hand</TableHead>
                      <TableHead>Reserved</TableHead>
                      <TableHead>Available</TableHead>
                      <TableHead>Unreserved Required (+{bufferPercent}% buffer)</TableHead>
                      <TableHead>To Purchase</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Est. Cost</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aggregatedNeeds.map((n, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs text-slate-600">{n.item_code}</TableCell>
                        <TableCell className="font-medium">{n.ingredient_name}</TableCell>
                        <TableCell className="text-xs text-slate-500 capitalize">{n.category?.replace(/_/g, ' ')}</TableCell>
                        <TableCell>{n.onHandStock.toFixed(1)}</TableCell>
                        <TableCell className="text-violet-700">{n.reservedStock.toFixed(1)}</TableCell>
                        <TableCell className="text-cyan-700">{n.availableStock.toFixed(1)}</TableCell>
                        <TableCell className="font-semibold">{n.withBuffer.toFixed(1)}</TableCell>
                        <TableCell className={n.toPurchase > 0 ? 'font-bold text-orange-600' : 'text-slate-400'}>{n.toPurchase.toFixed(1)}</TableCell>
                        <TableCell>{n.unit}</TableCell>
                        <TableCell>{formatCurrency(n.estimatedCost)}</TableCell>
                        <TableCell>
                          {n.sufficient
                            ? <Badge className="bg-emerald-100 text-emerald-700">✓ Sufficient</Badge>
                            : <Badge className="bg-red-100 text-red-700">⚠ Purchase Required</Badge>
                          }
                        </TableCell>
                      </TableRow>
                    ))}
                    {aggregatedNeeds.length === 0 && (
                      <TableRow><TableCell colSpan={11} className="text-center text-slate-500 py-8">No data available</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="requests">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader><CardTitle>Generated Material Requests</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request #</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Est. Cost</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {materialRequests.slice(0, 20).map(mr => (
                      <TableRow key={mr.id}>
                        <TableCell className="font-mono text-sm">{mr.request_number}</TableCell>
                        <TableCell>{mr.site_name}</TableCell>
                        <TableCell>{mr.request_date}</TableCell>
                        <TableCell className="text-sm text-slate-500">{mr.period_start} → {mr.period_end}</TableCell>
                        <TableCell>{mr.items?.length || 0}</TableCell>
                        <TableCell>{formatCurrency(mr.total_estimated_cost || 0)}</TableCell>
                        <TableCell>
                          <Badge className={
                            mr.status === 'pm_approved' ? 'bg-emerald-100 text-emerald-700' :
                            mr.status?.includes('rejected') ? 'bg-red-100 text-red-700' :
                            'bg-amber-100 text-amber-700'
                          } >
                            {mr.status?.replace(/_/g, ' ')}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {materialRequests.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center text-slate-500 py-8">No material requests yet</TableCell></TableRow>
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
