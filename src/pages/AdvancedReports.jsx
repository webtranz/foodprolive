import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, FileText } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import InventoryTrendChart from '../components/reports/InventoryTrendChart';
import CostBreakdownChart from '../components/reports/CostBreakdownChart';
import ProductionReportChart from '../components/reports/ProductionReportChart';
import WasteAnalysisChart from '../components/reports/WasteAnalysisChart';
import { format, subDays } from 'date-fns';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

export default function AdvancedReports() {
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    siteId: 'all',
    category: 'all',
    cuisineType: 'all'
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: productions = [] } = useQuery({
    queryKey: ['productions'],
    queryFn: () => base44.entities.Production.list('-production_date', 200)
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.entities.Inventory.list()
  });

  const { data: waste = [] } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 200)
  });

  const { data: transactions = [] } = useQuery({
    queryKey: ['inventoryTransactions'],
    queryFn: () => base44.entities.InventoryTransaction.list('-transaction_date', 500)
  });

  // Filtered data
  const filteredData = useMemo(() => {
    const start = new Date(filters.startDate);
    const end = new Date(filters.endDate);

    return {
      productions: productions.filter(p => {
        const date = new Date(p.production_date);
        const matchesSite = filters.siteId === 'all' || p.site_id === filters.siteId;
        const matchesDate = date >= start && date <= end;
        return matchesSite && matchesDate;
      }),
      inventory: inventory.filter(i => 
        (filters.siteId === 'all' || i.site_id === filters.siteId) &&
        (filters.category === 'all' || ingredients.find(ing => ing.id === i.ingredient_id)?.category === filters.category)
      ),
      waste: waste.filter(w => {
        const date = new Date(w.waste_date);
        const matchesSite = filters.siteId === 'all' || w.site_id === filters.siteId;
        const matchesDate = date >= start && date <= end;
        return matchesSite && matchesDate;
      }),
      transactions: transactions.filter(t => {
        const date = new Date(t.transaction_date);
        const matchesSite = filters.siteId === 'all' || t.site_id === filters.siteId;
        const matchesDate = date >= start && date <= end;
        return matchesSite && matchesDate;
      })
    };
  }, [filters, productions, inventory, waste, transactions, ingredients]);

  const exportPDF = async () => {
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    
    pdf.setFontSize(20);
    pdf.text('Advanced Production Report', pageWidth / 2, 20, { align: 'center' });
    
    pdf.setFontSize(10);
    pdf.text(`Date Range: ${filters.startDate} to ${filters.endDate}`, 20, 30);
    pdf.text(`Site: ${filters.siteId === 'all' ? 'All Sites' : sites.find(s => s.id === filters.siteId)?.name || 'N/A'}`, 20, 36);
    
    // Summary statistics
    pdf.setFontSize(14);
    pdf.text('Summary Statistics', 20, 46);
    pdf.setFontSize(10);
    
    const totalProductions = filteredData.productions.length;
    const totalWaste = filteredData.waste.reduce((sum, w) => sum + (w.quantity || 0), 0);
    const avgInventory = filteredData.inventory.reduce((sum, i) => sum + (i.quantity || 0), 0) / (filteredData.inventory.length || 1);
    
    pdf.text(`Total Productions: ${totalProductions}`, 20, 54);
    pdf.text(`Total Waste: ${totalWaste.toFixed(2)} kg`, 20, 60);
    pdf.text(`Average Inventory Level: ${avgInventory.toFixed(2)} units`, 20, 66);
    
    // Try to capture charts
    const charts = document.querySelectorAll('.report-chart');
    let yPos = 76;
    
    for (let i = 0; i < Math.min(charts.length, 2); i++) {
      try {
        const canvas = await html2canvas(charts[i]);
        const imgData = canvas.toDataURL('image/png');
        
        if (yPos + 80 > pdf.internal.pageSize.getHeight()) {
          pdf.addPage();
          yPos = 20;
        }
        
        pdf.addImage(imgData, 'PNG', 20, yPos, 170, 70);
        yPos += 80;
      } catch (err) {
        console.error('Error capturing chart:', err);
      }
    }
    
    pdf.save(`report_${format(new Date(), 'yyyy-MM-dd')}.pdf`);
  };

  const exportDetailedCSV = (type) => {
    switch(type) {
      case 'production':
        downloadCSV(filteredData.productions, `production_report_${filters.startDate}_${filters.endDate}`);
        break;
      case 'inventory':
        downloadCSV(filteredData.inventory, `inventory_report_${filters.startDate}_${filters.endDate}`);
        break;
      case 'waste':
        downloadCSV(filteredData.waste, `waste_report_${filters.startDate}_${filters.endDate}`);
        break;
      case 'transactions':
        downloadCSV(filteredData.transactions, `transactions_report_${filters.startDate}_${filters.endDate}`);
        break;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Advanced Reports" 
          description="Custom reporting with data visualization and export"
        >
          <Button variant="outline" onClick={exportPDF}>
            <FileText className="w-4 h-4 mr-2" />
            Export PDF
          </Button>
        </PageHeader>

        {/* Filters */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Report Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div>
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={filters.startDate}
                  onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>End Date</Label>
                <Input
                  type="date"
                  value={filters.endDate}
                  onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Site</Label>
                <Select value={filters.siteId} onValueChange={(value) => setFilters({ ...filters, siteId: value })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sites</SelectItem>
                    {sites.map(site => (
                      <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select value={filters.category} onValueChange={(value) => setFilters({ ...filters, category: value })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    <SelectItem value="proteins_meat">Proteins - Meat</SelectItem>
                    <SelectItem value="vegetables">Vegetables</SelectItem>
                    <SelectItem value="grains_cereals">Grains & Cereals</SelectItem>
                    <SelectItem value="dairy">Dairy</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Cuisine</Label>
                <Select value={filters.cuisineType} onValueChange={(value) => setFilters({ ...filters, cuisineType: value })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Cuisines</SelectItem>
                    <SelectItem value="continental">Continental</SelectItem>
                    <SelectItem value="desi">Desi</SelectItem>
                    <SelectItem value="italian">Italian</SelectItem>
                    <SelectItem value="chinese">Chinese</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Report Tabs */}
        <Tabs defaultValue="inventory" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="inventory">Inventory Trends</TabsTrigger>
            <TabsTrigger value="costs">Cost Analysis</TabsTrigger>
            <TabsTrigger value="production">Production</TabsTrigger>
            <TabsTrigger value="waste">Waste Analysis</TabsTrigger>
          </TabsList>

          <TabsContent value="inventory" className="space-y-4">
            <div className="report-chart">
              <InventoryTrendChart 
                transactions={filteredData.transactions}
                inventory={filteredData.inventory}
              />
            </div>
            <Button onClick={() => exportDetailedCSV('inventory')} variant="outline">
              <Download className="w-4 h-4 mr-2" />
              Export Inventory Data (CSV)
            </Button>
          </TabsContent>

          <TabsContent value="costs" className="space-y-4">
            <div className="report-chart">
              <CostBreakdownChart 
                recipes={recipes}
                ingredients={ingredients}
                filters={filters}
              />
            </div>
            <Button onClick={() => exportDetailedCSV('production')} variant="outline">
              <Download className="w-4 h-4 mr-2" />
              Export Cost Data (CSV)
            </Button>
          </TabsContent>

          <TabsContent value="production" className="space-y-4">
            <div className="report-chart">
              <ProductionReportChart productions={filteredData.productions} />
            </div>
            <Button onClick={() => exportDetailedCSV('production')} variant="outline">
              <Download className="w-4 h-4 mr-2" />
              Export Production Data (CSV)
            </Button>
          </TabsContent>

          <TabsContent value="waste" className="space-y-4">
            <div className="report-chart">
              <WasteAnalysisChart waste={filteredData.waste} />
            </div>
            <Button onClick={() => exportDetailedCSV('waste')} variant="outline">
              <Download className="w-4 h-4 mr-2" />
              Export Waste Data (CSV)
            </Button>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}