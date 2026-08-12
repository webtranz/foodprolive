import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const CATEGORIES = [
  { value: 'proteins', label: 'Proteins' },
  { value: 'vegetables', label: 'Vegetables' },
  { value: 'fruits', label: 'Fruits' },
  { value: 'grains', label: 'Grains' },
  { value: 'dairy', label: 'Dairy' },
  { value: 'oils', label: 'Oils & Fats' },
  { value: 'spices', label: 'Spices' },
  { value: 'condiments', label: 'Condiments' },
  { value: 'beverages', label: 'Beverages' },
  { value: 'other', label: 'Other' }
];

const UNITS = [
  { value: 'kg', label: 'Kilograms (kg)' },
  { value: 'g', label: 'Grams (g)' },
  { value: 'l', label: 'Liters (l)' },
  { value: 'ml', label: 'Milliliters (ml)' },
  { value: 'pieces', label: 'Pieces' }
];

const ALLERGEN_OPTIONS = [
  'dairy',
  'nuts',
  'gluten',
  'eggs',
  'seafood',
  'soy',
  'sesame'
];

export default function IngredientForm({ open, onClose, onSubmit, ingredient, isLoading }) {
  const [formData, setFormData] = useState({
    name: '',
    item_code: '',
    category: 'other',
    unit: 'kg',
    conversion_unit: '',
    conversion_factor: '',
    raw_weight_per_unit: '',
    cooked_weight_per_unit: '',
    cooking_yield_percent: '',
    shrinkage_percent: '',
    calories_per_100g: '',
    protein_per_100g: '',
    carbs_per_100g: '',
    fat_per_100g: '',
    fiber_per_100g: '',
    sodium_per_100g: '',
    sugar_per_100g: '',
    allergens: [],
    cost_per_unit: '',
    supplier: '',
    is_active: true
  });

  useEffect(() => {
    if (ingredient) {
      setFormData({
        name: ingredient.name || '',
        item_code: ingredient.item_code || '',
        category: ingredient.category || 'other',
        unit: ingredient.unit || 'kg',
        conversion_unit: ingredient.conversion_unit || '',
        conversion_factor: ingredient.conversion_factor || '',
        raw_weight_per_unit: ingredient.raw_weight_per_unit || '',
        cooked_weight_per_unit: ingredient.cooked_weight_per_unit || '',
        cooking_yield_percent: ingredient.cooking_yield_percent || '',
        shrinkage_percent: ingredient.shrinkage_percent || '',
        calories_per_100g: ingredient.calories_per_100g || '',
        protein_per_100g: ingredient.protein_per_100g || '',
        carbs_per_100g: ingredient.carbs_per_100g || '',
        fat_per_100g: ingredient.fat_per_100g || '',
        fiber_per_100g: ingredient.fiber_per_100g || '',
        sodium_per_100g: ingredient.sodium_per_100g || '',
        sugar_per_100g: ingredient.sugar_per_100g || '',
        allergens: Array.isArray(ingredient.allergens) ? ingredient.allergens : [],
        cost_per_unit: ingredient.cost_per_unit || '',
        supplier: ingredient.supplier || '',
        is_active: ingredient.is_active !== false
      });
    } else {
      setFormData({
        name: '',
        item_code: '',
        category: 'other',
        unit: 'kg',
        conversion_unit: '',
        conversion_factor: '',
        raw_weight_per_unit: '',
        cooked_weight_per_unit: '',
        cooking_yield_percent: '',
        shrinkage_percent: '',
        calories_per_100g: '',
        protein_per_100g: '',
        carbs_per_100g: '',
        fat_per_100g: '',
        fiber_per_100g: '',
        sodium_per_100g: '',
        sugar_per_100g: '',
        allergens: [],
        cost_per_unit: '',
        supplier: '',
        is_active: true
      });
    }
  }, [ingredient, open]);

  // Auto-calculate yield/shrinkage
  useEffect(() => {
    if (formData.raw_weight_per_unit && formData.cooked_weight_per_unit) {
      const raw = parseFloat(formData.raw_weight_per_unit);
      const cooked = parseFloat(formData.cooked_weight_per_unit);
      if (raw > 0) {
        const yieldPercent = ((cooked / raw) * 100).toFixed(1);
        const shrinkage = (100 - yieldPercent).toFixed(1);
        setFormData(prev => ({
          ...prev,
          cooking_yield_percent: yieldPercent,
          shrinkage_percent: shrinkage
        }));
      }
    }
  }, [formData.raw_weight_per_unit, formData.cooked_weight_per_unit]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const submitData = {
      ...formData,
      raw_weight_per_unit: formData.raw_weight_per_unit ? parseFloat(formData.raw_weight_per_unit) : null,
      cooked_weight_per_unit: formData.cooked_weight_per_unit ? parseFloat(formData.cooked_weight_per_unit) : null,
      cooking_yield_percent: formData.cooking_yield_percent ? parseFloat(formData.cooking_yield_percent) : null,
      shrinkage_percent: formData.shrinkage_percent ? parseFloat(formData.shrinkage_percent) : null,
      calories_per_100g: formData.calories_per_100g ? parseFloat(formData.calories_per_100g) : null,
      protein_per_100g: formData.protein_per_100g ? parseFloat(formData.protein_per_100g) : null,
      carbs_per_100g: formData.carbs_per_100g ? parseFloat(formData.carbs_per_100g) : null,
      fat_per_100g: formData.fat_per_100g ? parseFloat(formData.fat_per_100g) : null,
      fiber_per_100g: formData.fiber_per_100g ? parseFloat(formData.fiber_per_100g) : null,
      sodium_per_100g: formData.sodium_per_100g ? parseFloat(formData.sodium_per_100g) : null,
      sugar_per_100g: formData.sugar_per_100g ? parseFloat(formData.sugar_per_100g) : null,
      allergens: formData.allergens,
      conversion_factor: formData.conversion_factor ? parseFloat(formData.conversion_factor) : null,
      cost_per_unit: formData.cost_per_unit ? parseFloat(formData.cost_per_unit) : null
    };
    onSubmit(submitData);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            {ingredient ? 'Edit Ingredient' : 'Add New Ingredient'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-6">
              <TabsTrigger value="basic">Basic Info</TabsTrigger>
              <TabsTrigger value="weight">Weight & Cooking</TabsTrigger>
              <TabsTrigger value="nutrition">Nutrition</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Ingredient Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Chicken Breast"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="item_code">Item Code</Label>
                  <Input
                    id="item_code"
                    value={formData.item_code}
                    onChange={(e) => setFormData({ ...formData, item_code: e.target.value })}
                    placeholder="e.g., ITM-001"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="category">Category *</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(value) => setFormData({ ...formData, category: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(cat => (
                        <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="unit">Base Unit</Label>
                  <Select
                    value={formData.unit}
                    onValueChange={(value) => setFormData({ ...formData, unit: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {UNITS.map(unit => (
                        <SelectItem key={unit.value} value={unit.value}>{unit.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="conversion_unit">Conversion Unit</Label>
                  <Input
                    id="conversion_unit"
                    value={formData.conversion_unit}
                    onChange={(e) => setFormData({ ...formData, conversion_unit: e.target.value })}
                    placeholder="e.g., pieces, box"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="conversion_factor">Conversion Units per Base Unit</Label>
                  <Input
                    id="conversion_factor"
                    type="number"
                    step="0.01"
                    value={formData.conversion_factor}
                    onChange={(e) => setFormData({ ...formData, conversion_factor: e.target.value })}
                    placeholder="e.g., 1000 g per kg"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="cost">Cost per Unit</Label>
                  <Input
                    id="cost"
                    type="number"
                    step="0.01"
                    value={formData.cost_per_unit}
                    onChange={(e) => setFormData({ ...formData, cost_per_unit: e.target.value })}
                    placeholder="0.00"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="supplier">Supplier</Label>
                  <Input
                    id="supplier"
                    value={formData.supplier}
                    onChange={(e) => setFormData({ ...formData, supplier: e.target.value })}
                    placeholder="Supplier name"
                    className="mt-1"
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="weight" className="space-y-4">
              <div className="bg-slate-50 rounded-xl p-4 mb-4">
                <h4 className="font-medium text-slate-900 mb-2">Weight Tracking</h4>
                <p className="text-sm text-slate-500">
                  Enter raw and cooked weights to automatically calculate cooking yield and shrinkage.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="raw_weight">Raw Weight per Unit (g)</Label>
                  <Input
                    id="raw_weight"
                    type="number"
                    step="0.1"
                    value={formData.raw_weight_per_unit}
                    onChange={(e) => setFormData({ ...formData, raw_weight_per_unit: e.target.value })}
                    placeholder="e.g., 1000"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="cooked_weight">Cooked Weight per Unit (g)</Label>
                  <Input
                    id="cooked_weight"
                    type="number"
                    step="0.1"
                    value={formData.cooked_weight_per_unit}
                    onChange={(e) => setFormData({ ...formData, cooked_weight_per_unit: e.target.value })}
                    placeholder="e.g., 750"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="yield">Cooking Yield (%)</Label>
                  <Input
                    id="yield"
                    type="number"
                    step="0.1"
                    value={formData.cooking_yield_percent}
                    onChange={(e) => setFormData({ ...formData, cooking_yield_percent: e.target.value })}
                    placeholder="Auto-calculated"
                    className="mt-1 bg-slate-50"
                    readOnly
                  />
                </div>

                <div>
                  <Label htmlFor="shrinkage">Shrinkage (%)</Label>
                  <Input
                    id="shrinkage"
                    type="number"
                    step="0.1"
                    value={formData.shrinkage_percent}
                    onChange={(e) => setFormData({ ...formData, shrinkage_percent: e.target.value })}
                    placeholder="Auto-calculated"
                    className="mt-1 bg-slate-50"
                    readOnly
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="nutrition" className="space-y-4">
              <div className="bg-emerald-50 rounded-xl p-4 mb-4">
                <h4 className="font-medium text-emerald-900 mb-2">Nutritional Information</h4>
                <p className="text-sm text-emerald-700">
                  All values should be per 100 grams of the ingredient.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="calories">Calories (per 100g) *</Label>
                  <Input
                    id="calories"
                    type="number"
                    step="0.1"
                    value={formData.calories_per_100g}
                    onChange={(e) => setFormData({ ...formData, calories_per_100g: e.target.value })}
                    placeholder="e.g., 165"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="protein">Protein (g per 100g)</Label>
                  <Input
                    id="protein"
                    type="number"
                    step="0.1"
                    value={formData.protein_per_100g}
                    onChange={(e) => setFormData({ ...formData, protein_per_100g: e.target.value })}
                    placeholder="e.g., 31"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="carbs">Carbohydrates (g per 100g)</Label>
                  <Input
                    id="carbs"
                    type="number"
                    step="0.1"
                    value={formData.carbs_per_100g}
                    onChange={(e) => setFormData({ ...formData, carbs_per_100g: e.target.value })}
                    placeholder="e.g., 0"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="fat">Fat (g per 100g)</Label>
                  <Input
                    id="fat"
                    type="number"
                    step="0.1"
                    value={formData.fat_per_100g}
                    onChange={(e) => setFormData({ ...formData, fat_per_100g: e.target.value })}
                    placeholder="e.g., 3.6"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="fiber">Fiber (g per 100g)</Label>
                  <Input
                    id="fiber"
                    type="number"
                    step="0.1"
                    value={formData.fiber_per_100g}
                    onChange={(e) => setFormData({ ...formData, fiber_per_100g: e.target.value })}
                    placeholder="e.g., 0"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="sodium">Sodium (mg per 100g)</Label>
                  <Input
                    id="sodium"
                    type="number"
                    step="0.1"
                    value={formData.sodium_per_100g}
                    onChange={(e) => setFormData({ ...formData, sodium_per_100g: e.target.value })}
                    placeholder="e.g., 120"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="sugar">Sugar (g per 100g)</Label>
                  <Input
                    id="sugar"
                    type="number"
                    step="0.1"
                    value={formData.sugar_per_100g}
                    onChange={(e) => setFormData({ ...formData, sugar_per_100g: e.target.value })}
                    placeholder="e.g., 4.5"
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <Label>Allergen Tags</Label>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {ALLERGEN_OPTIONS.map((allergen) => {
                    const checked = formData.allergens.includes(allergen);
                    return (
                      <label key={allergen} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => setFormData((current) => ({
                            ...current,
                            allergens: event.target.checked
                              ? [...current.allergens, allergen]
                              : current.allergens.filter((item) => item !== allergen)
                          }))}
                        />
                        <span className="capitalize">{allergen}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button 
              type="submit" 
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={isLoading}
            >
              {isLoading ? 'Saving...' : (ingredient ? 'Update Ingredient' : 'Add Ingredient')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
