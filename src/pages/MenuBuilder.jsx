import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Utensils, Trash2, Calculator, Download, ChefHat } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { formatCurrency, SAR_SYMBOL } from '@/lib/currency';

const CATEGORIES = [
  { value: 'appetizer', label: 'Appetizer', icon: '🥗', color: 'bg-green-100 text-green-700' },
  { value: 'main_course', label: 'Main Course', icon: '🍖', color: 'bg-red-100 text-red-700' },
  { value: 'starch', label: 'Starch', icon: '🍚', color: 'bg-yellow-100 text-yellow-700' },
  { value: 'vegetable', label: 'Vegetable Side', icon: '🥦', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'dessert', label: 'Dessert', icon: '🍮', color: 'bg-pink-100 text-pink-700' },
  { value: 'snack', label: 'Snack', icon: '🧆', color: 'bg-orange-100 text-orange-700' },
  { value: 'beverage', label: 'Beverage', icon: '🥤', color: 'bg-blue-100 text-blue-700' }
];

const UNITS = ['g', 'kg', 'pcs', 'ml', 'l', 'servings'];

const BUFFET_STRUCTURE = [
  { category: 'appetizer', min: 2, max: 3 },
  { category: 'main_course', min: 2, max: 3 },
  { category: 'starch', min: 1, max: 2 },
  { category: 'vegetable', min: 1, max: 1 },
  { category: 'dessert', min: 1, max: 2 }
];

export default function MenuBuilder() {
  const [menuItems, setMenuItems] = useState([]);
  const [covers, setCovers] = useState('');
  const [menuName, setMenuName] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [itemForm, setItemForm] = useState({ category: 'main_course', item_name: '', recipe_id: '', portion: '', unit: 'g', cost_per_unit: '', yield_percent: '100' });

  const { data: recipes = [] } = useQuery({ queryKey: ['recipes'], queryFn: () => base44.entities.Recipe.list() });

  const addItem = () => {
    if (!itemForm.item_name || !itemForm.portion) return;
    const recipe = recipes.find(r => r.id === itemForm.recipe_id);
    setMenuItems(prev => [...prev, {
      ...itemForm,
      id: Date.now(),
      item_code: recipe?.recipe_code || '—',
      recipe_name: recipe?.name || '',
      portion: parseFloat(itemForm.portion),
      cost_per_unit: parseFloat(itemForm.cost_per_unit) || 0,
      yield_percent: parseFloat(itemForm.yield_percent) || 100
    }]);
    setItemForm({ category: 'main_course', item_name: '', recipe_id: '', portion: '', unit: 'g', cost_per_unit: '', yield_percent: '100' });
    setAddOpen(false);
  };

  const removeItem = (id) => setMenuItems(prev => prev.filter(i => i.id !== id));

  const numCovers = parseInt(covers) || 0;

  const projection = useMemo(() => {
    return menuItems.map(item => {
      const required = item.portion * numCovers;
      const yieldFactor = item.yield_percent / 100;
      const rawRequired = yieldFactor > 0 ? required / yieldFactor : required;
      const cost = rawRequired * item.cost_per_unit;
      return { ...item, required, rawRequired, cost };
    });
  }, [menuItems, numCovers]);

  const totalCost = projection.reduce((sum, i) => sum + i.cost, 0);

  const getCatInfo = (val) => CATEGORIES.find(c => c.value === val) || CATEGORIES[0];

  const structureCheck = BUFFET_STRUCTURE.map(rule => {
    const count = menuItems.filter(i => i.category === rule.category).length;
    const ok = count >= rule.min;
    return { ...rule, count, ok };
  });

  const exportMenu = () => {
    const data = projection.map(i => ({
      item_code: i.item_code || '—',
      item_name: i.item_name,
      category: i.category,
      portion: `${i.portion} ${i.unit}`,
      covers: numCovers,
      required: `${i.required} ${i.unit}`,
      raw_required: `${i.rawRequired.toFixed(2)} ${i.unit}`,
      yield_percent: `${i.yield_percent}%`,
      cost: formatCurrency(i.cost)
    }));
    downloadCSV(data, `menu_${menuName || 'builder'}`);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader title="Menu Builder" description="Design buffet menus, set portions and calculate production quantities">
          <Button variant="outline" onClick={exportMenu} disabled={menuItems.length === 0}>
            <Download className="w-4 h-4 mr-2" /> Export Menu
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> Add Menu Item
          </Button>
        </PageHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Config + Structure Check */}
          <div className="space-y-4">
            <Card className="border-slate-100 shadow-sm">
              <CardHeader><CardTitle className="text-base">Menu Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label>Menu Name</Label>
                  <Input value={menuName} onChange={e => setMenuName(e.target.value)} placeholder="e.g. Friday Buffet" className="mt-1" />
                </div>
                <div>
                  <Label>Number of Covers</Label>
                  <Input type="number" min="1" value={covers} onChange={e => setCovers(e.target.value)} placeholder="e.g. 200" className="mt-1" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-100 shadow-sm">
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Utensils className="w-4 h-4" /> Buffet Structure Check</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {structureCheck.map(rule => {
                  const cat = getCatInfo(rule.category);
                  return (
                    <div key={rule.category} className="flex items-center justify-between">
                      <span className="text-sm text-slate-600 capitalize">{cat.icon} {rule.category.replace(/_/g, ' ')}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{rule.count}/{rule.min}-{rule.max}</span>
                        <div className={`w-2 h-2 rounded-full ${rule.ok ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {numCovers > 0 && (
              <Card className="border-emerald-100 bg-emerald-50 shadow-sm">
                <CardHeader><CardTitle className="text-base text-emerald-900 flex items-center gap-2"><Calculator className="w-4 h-4" /> Cost Summary</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Total Food Cost</span>
                      <span className="font-bold text-emerald-700">{formatCurrency(totalCost)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Cost per Cover</span>
                      <span className="font-bold text-emerald-700">{formatCurrency(numCovers > 0 ? (totalCost / numCovers) : 0)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Total Items</span>
                      <span className="font-bold text-slate-900">{menuItems.length}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right: Menu Items + Projection Table */}
          <div className="lg:col-span-2 space-y-4">
            {menuItems.length === 0 ? (
              <Card className="border-slate-100 shadow-sm">
                <CardContent className="p-12 text-center">
                  <ChefHat className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-700 mb-2">No Menu Items Yet</h3>
                  <p className="text-slate-500 mb-4">Add items to build your buffet menu</p>
                  <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setAddOpen(true)}>
                    <Plus className="w-4 h-4 mr-2" /> Add First Item
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Items by Category */}
                {CATEGORIES.map(cat => {
                  const items = menuItems.filter(i => i.category === cat.value);
                  if (items.length === 0) return null;
                  return (
                    <Card key={cat.value} className="border-slate-100 shadow-sm">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cat.color}`}>{cat.icon} {cat.label}</span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Item Code</TableHead>
                              <TableHead>Item Name</TableHead>
                              <TableHead>Portion</TableHead>
                              {numCovers > 0 && <TableHead>Required ({numCovers} covers)</TableHead>}
                              {numCovers > 0 && <TableHead>Raw Qty</TableHead>}
                              <TableHead>Yield%</TableHead>
                              <TableHead></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {items.map(item => {
                              const proj = projection.find(p => p.id === item.id);
                              return (
                                <TableRow key={item.id}>
                                  <TableCell className="font-mono text-xs text-slate-600">{item.item_code || '—'}</TableCell>
                                  <TableCell className="font-medium">{item.item_name}</TableCell>
                                  <TableCell>{item.portion} {item.unit}</TableCell>
                                  {numCovers > 0 && <TableCell className="font-semibold text-emerald-700">{proj?.required.toFixed(1)} {item.unit}</TableCell>}
                                  {numCovers > 0 && <TableCell className="text-orange-600">{proj?.rawRequired.toFixed(2)} {item.unit}</TableCell>}
                                  <TableCell>{item.yield_percent}%</TableCell>
                                  <TableCell>
                                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600" onClick={() => removeItem(item.id)}>
                                      <Trash2 className="w-4 h-4" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                  );
                })}

                {/* Full Projection Table */}
                {numCovers > 0 && (
                  <Card className="border-blue-100 shadow-sm">
                    <CardHeader>
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Calculator className="w-4 h-4 text-blue-600" /> Quantity Projection — {numCovers} Covers
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Item Code</TableHead>
                            <TableHead>Item Name</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead>Portion</TableHead>
                            <TableHead>Covers</TableHead>
                            <TableHead>Required</TableHead>
                            <TableHead>Raw Needed</TableHead>
                            <TableHead>Est. Cost</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {projection.map(item => {
                            const cat = getCatInfo(item.category);
                            return (
                              <TableRow key={item.id}>
                                <TableCell className="font-mono text-xs text-slate-600">{item.item_code || '—'}</TableCell>
                                <TableCell className="font-medium">{item.item_name}</TableCell>
                                <TableCell><Badge className={`text-xs ${cat.color}`}>{cat.icon} {cat.label}</Badge></TableCell>
                                <TableCell>{item.portion} {item.unit}</TableCell>
                                <TableCell>{numCovers}</TableCell>
                                <TableCell className="font-semibold text-emerald-700">{item.required.toFixed(1)} {item.unit}</TableCell>
                                <TableCell className="text-orange-600">{item.rawRequired.toFixed(2)} {item.unit}</TableCell>
                                <TableCell>{formatCurrency(item.cost)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>

        {/* Add Item Dialog */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Menu Item</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label>Category *</Label>
                  <Select value={itemForm.category} onValueChange={v => setItemForm({ ...itemForm, category: v })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(cat => <SelectItem key={cat.value} value={cat.value}>{cat.icon} {cat.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>Item Name *</Label>
                  <Input value={itemForm.item_name} onChange={e => setItemForm({ ...itemForm, item_name: e.target.value })} placeholder="e.g. Beef Sambuusa" className="mt-1" />
                </div>
                <div>
                  <Label>Link to Recipe</Label>
                  <Select value={itemForm.recipe_id} onValueChange={v => setItemForm({ ...itemForm, recipe_id: v })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Optional" /></SelectTrigger>
                    <SelectContent>
                      {recipes.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Unit</Label>
                  <Select value={itemForm.unit} onValueChange={v => setItemForm({ ...itemForm, unit: v })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {UNITS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Portion per person *</Label>
                  <Input type="number" step="0.1" value={itemForm.portion} onChange={e => setItemForm({ ...itemForm, portion: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label>Yield % (after cooking)</Label>
                  <Input type="number" min="1" max="300" value={itemForm.yield_percent} onChange={e => setItemForm({ ...itemForm, yield_percent: e.target.value })} className="mt-1" />
                </div>
                <div className="col-span-2">
                  <Label>{`Cost per unit (${SAR_SYMBOL})`}</Label>
                  <Input type="number" step="0.01" value={itemForm.cost_per_unit} onChange={e => setItemForm({ ...itemForm, cost_per_unit: e.target.value })} placeholder="0.00" className="mt-1" />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button onClick={addItem} className="bg-emerald-600 hover:bg-emerald-700" disabled={!itemForm.item_name || !itemForm.portion}>Add Item</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
