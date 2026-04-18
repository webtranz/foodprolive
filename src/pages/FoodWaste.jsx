import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Trash2, AlertTriangle, TrendingDown, DollarSign, Download } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { format } from 'date-fns';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import StatCard from '@/components/ui/StatCard';

const WASTE_CATEGORIES = [
  { value: 'raw_waste', label: 'Raw Waste' },
  { value: 'cooking_loss', label: 'Cooking Loss' },
  { value: 'plate_waste', label: 'Plate Waste' },
  { value: 'expired', label: 'Expired' },
  { value: 'storage_loss', label: 'Storage Loss' },
  { value: 'preparation_waste', label: 'Preparation Waste' }
];

const CATEGORY_COLORS = {
  raw_waste: '#ef4444',
  cooking_loss: '#f97316',
  plate_waste: '#eab308',
  expired: '#8b5cf6',
  storage_loss: '#6366f1',
  preparation_waste: '#ec4899'
};

const CATEGORY_BADGE_COLORS = {
  raw_waste: 'bg-red-100 text-red-700',
  cooking_loss: 'bg-orange-100 text-orange-700',
  plate_waste: 'bg-yellow-100 text-yellow-700',
  expired: 'bg-purple-100 text-purple-700',
  storage_loss: 'bg-indigo-100 text-indigo-700',
  preparation_waste: 'bg-pink-100 text-pink-700'
};

export default function FoodWaste() {
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [formData, setFormData] = useState({
    site_id: '',
    waste_date: format(new Date(), 'yyyy-MM-dd'),
    waste_category: 'plate_waste',
    ingredient_id: '',
    recipe_id: '',
    quantity: '',
    unit: 'kg',
    estimated_cost: '',
    reason: '',
    preventable: false,
    notes: ''
  });

  const queryClient = useQueryClient();

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

  const { data: foodWaste = [], isLoading } = useQuery({
    queryKey: ['foodWaste'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 200)
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.FoodWaste.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodWaste'] });
      setFormOpen(false);
      resetForm();
    }
  });

  const resetForm = () => {
    setFormData({
      site_id: '',
      waste_date: format(new Date(), 'yyyy-MM-dd'),
      waste_category: 'plate_waste',
      ingredient_id: '',
      recipe_id: '',
      quantity: '',
      unit: 'kg',
      estimated_cost: '',
      reason: '',
      preventable: false,
      notes: ''
    });
  };

  const filteredWaste = foodWaste.filter(w => {
    const matchesSite = selectedSite === 'all' || w.site_id === selectedSite;
    const matchesCategory = selectedCategory === 'all' || w.waste_category === selectedCategory;
    return matchesSite && matchesCategory;
  });

  // Calculate stats
  const totalWaste = filteredWaste.reduce((sum, w) => sum + (w.quantity || 0), 0);
  const totalCost = filteredWaste.reduce((sum, w) => sum + (w.estimated_cost || 0), 0);
  const preventableWaste = filteredWaste.filter(w => w.preventable).reduce((sum, w) => sum + (w.quantity || 0), 0);
  const preventablePercent = totalWaste > 0 ? Math.round((preventableWaste / totalWaste) * 100) : 0;

  // Waste by category for chart
  const wasteByCategory = WASTE_CATEGORIES.map(cat => {
    const categoryWaste = filteredWaste
      .filter(w => w.waste_category === cat.value)
      .reduce((sum, w) => sum + (w.quantity || 0), 0);
    return {
      name: cat.label,
      value: categoryWaste,
      category: cat.value
    };
  }).filter(c => c.value > 0);

  const handleSubmit = (e) => {
    e.preventDefault();
    const site = sites.find(s => s.id === formData.site_id);
    const ingredient = ingredients.find(i => i.id === formData.ingredient_id);
    const recipe = recipes.find(r => r.id === formData.recipe_id);

    const submitData = {
      ...formData,
      site_name: site?.name || '',
      ingredient_name: ingredient?.name || '',
      recipe_name: recipe?.name || '',
      quantity: parseFloat(formData.quantity) || 0,
      estimated_cost: formData.estimated_cost ? parseFloat(formData.estimated_cost) : null
    };

    createMutation.mutate(submitData);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Food Waste" 
          description="Track and analyze food waste"
        >
          <Button 
            variant="outline"
            onClick={() => downloadCSV(filteredWaste, 'food_waste')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            onClick={() => setFormOpen(true)}
            className="bg-red-600 hover:bg-red-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Record Waste
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            title="Total Waste"
            value={`${totalWaste.toFixed(1)} kg`}
            icon={Trash2}
            iconBg="bg-red-50"
            iconColor="text-red-600"
          />
          <StatCard
            title="Estimated Cost"
            value={`$${totalCost.toFixed(2)}`}
            icon={DollarSign}
            iconBg="bg-amber-50"
            iconColor="text-amber-600"
          />
          <StatCard
            title="Preventable"
            value={`${preventablePercent}%`}
            subtitle={`${preventableWaste.toFixed(1)} kg could be avoided`}
            icon={AlertTriangle}
            iconBg="bg-orange-50"
            iconColor="text-orange-600"
          />
          <StatCard
            title="Records"
            value={filteredWaste.length}
            icon={TrendingDown}
            iconBg="bg-purple-50"
            iconColor="text-purple-600"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {/* Chart */}
          <Card className="border-slate-100 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Waste by Category</CardTitle>
            </CardHeader>
            <CardContent>
              {wasteByCategory.length > 0 ? (
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={wasteByCategory}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {wasteByCategory.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={CATEGORY_COLORS[entry.category]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => `${value.toFixed(1)} kg`} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-center text-slate-500 py-8">No waste data to display</p>
              )}
            </CardContent>
          </Card>

          {/* Filters & Recent */}
          <Card className="lg:col-span-2 border-slate-100 shadow-sm">
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <CardTitle className="text-lg">Waste Records</CardTitle>
                <div className="flex gap-2">
                  <Select value={selectedSite} onValueChange={setSelectedSite}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sites</SelectItem>
                      {sites.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {WASTE_CATEGORIES.map(cat => (
                        <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}
                </div>
              ) : filteredWaste.length === 0 ? (
                <p className="text-center text-slate-500 py-8">No waste records found</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Site</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Item</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Preventable</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredWaste.slice(0, 10).map(waste => (
                        <TableRow key={waste.id}>
                          <TableCell className="font-medium">
                            {format(new Date(waste.waste_date), 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell>{waste.site_name}</TableCell>
                          <TableCell>
                            <Badge className={CATEGORY_BADGE_COLORS[waste.waste_category]}>
                              {waste.waste_category?.replace(/_/g, ' ')}
                            </Badge>
                          </TableCell>
                          <TableCell>{waste.ingredient_name || waste.recipe_name || '-'}</TableCell>
                          <TableCell>{waste.quantity} {waste.unit}</TableCell>
                          <TableCell>
                            {waste.preventable ? (
                              <Badge className="bg-orange-100 text-orange-700">Yes</Badge>
                            ) : (
                              <span className="text-slate-400">No</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Form Dialog */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Record Food Waste</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="site">Site *</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData({ ...formData, site_id: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {sites.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="date">Date *</Label>
                  <Input
                    type="date"
                    value={formData.waste_date}
                    onChange={(e) => setFormData({ ...formData, waste_date: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div className="col-span-2">
                  <Label htmlFor="category">Waste Category *</Label>
                  <Select
                    value={formData.waste_category}
                    onValueChange={(value) => setFormData({ ...formData, waste_category: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WASTE_CATEGORIES.map(cat => (
                        <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="ingredient">Ingredient</Label>
                  <Select
                    value={formData.ingredient_id}
                    onValueChange={(value) => setFormData({ ...formData, ingredient_id: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Optional" />
                    </SelectTrigger>
                    <SelectContent>
                      {ingredients.map(ing => (
                        <SelectItem key={ing.id} value={ing.id}>{ing.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="recipe">Recipe</Label>
                  <Select
                    value={formData.recipe_id}
                    onValueChange={(value) => setFormData({ ...formData, recipe_id: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Optional" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipes.map(r => (
                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="quantity">Quantity *</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="unit">Unit</Label>
                  <Select
                    value={formData.unit}
                    onValueChange={(value) => setFormData({ ...formData, unit: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="kg">kg</SelectItem>
                      <SelectItem value="g">g</SelectItem>
                      <SelectItem value="l">l</SelectItem>
                      <SelectItem value="ml">ml</SelectItem>
                      <SelectItem value="pieces">pieces</SelectItem>
                      <SelectItem value="servings">servings</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="cost">Estimated Cost</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.estimated_cost}
                    onChange={(e) => setFormData({ ...formData, estimated_cost: e.target.value })}
                    className="mt-1"
                    placeholder="$0.00"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    id="preventable"
                    checked={formData.preventable}
                    onCheckedChange={(checked) => setFormData({ ...formData, preventable: checked })}
                  />
                  <Label htmlFor="preventable">Preventable waste</Label>
                </div>
              </div>

              <div>
                <Label htmlFor="reason">Reason</Label>
                <Input
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  className="mt-1"
                  placeholder="Brief reason for waste"
                />
              </div>

              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="mt-1"
                  placeholder="Additional notes..."
                  rows={2}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); }}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  className="bg-red-600 hover:bg-red-700"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? 'Recording...' : 'Record Waste'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}