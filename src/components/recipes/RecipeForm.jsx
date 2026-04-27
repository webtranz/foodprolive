import React, { useMemo, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Flame, ShieldAlert } from 'lucide-react';

const ALLERGEN_COLORS = {
  dairy: 'bg-sky-100 text-sky-700',
  nuts: 'bg-amber-100 text-amber-800',
  gluten: 'bg-orange-100 text-orange-700',
  eggs: 'bg-yellow-100 text-yellow-800',
  seafood: 'bg-cyan-100 text-cyan-800',
  soy: 'bg-lime-100 text-lime-800',
  sesame: 'bg-rose-100 text-rose-700'
};

function quantityToGrams(quantity, unit) {
  const numericQuantity = Number(quantity) || 0;
  switch (unit) {
    case 'kg':
      return numericQuantity * 1000;
    case 'g':
      return numericQuantity;
    case 'l':
      return numericQuantity * 1000;
    case 'ml':
      return numericQuantity;
    case 'pieces':
      return numericQuantity * 100;
    default:
      return numericQuantity;
  }
}

function roundValue(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

export default function RecipeForm({ open, onClose, onSubmit, recipe, ingredients = [], sites = [], isLoading }) {
  const [formData, setFormData] = useState({
    name: '',
    recipe_code: '',
    recipe_type: 'full',
    category: '',
    cuisine_type: '',
    description: '',
    prep_time_minutes: '',
    cook_time_minutes: '',
    servings: '1',
    instructions: '',
    ingredients: [],
    is_active: true,
    site_scope: 'global',
    site_ids: []
  });

  useEffect(() => {
    if (recipe) {
      setFormData({
        name: recipe.name || '',
        recipe_code: recipe.recipe_code || '',
        recipe_type: recipe.recipe_type || 'full',
        category: recipe.category || '',
        cuisine_type: recipe.cuisine_type || '',
        description: recipe.description || '',
        prep_time_minutes: recipe.prep_time_minutes || '',
        cook_time_minutes: recipe.cook_time_minutes || '',
        servings: recipe.servings || '1',
        instructions: recipe.instructions || '',
        ingredients: recipe.ingredients || [],
        is_active: recipe.is_active !== false,
        site_scope: recipe.site_scope || 'global',
        site_ids: Array.isArray(recipe.site_ids) ? recipe.site_ids : []
      });
    } else {
      setFormData({
        name: '',
        recipe_code: '',
        recipe_type: 'full',
        category: '',
        cuisine_type: '',
        description: '',
        prep_time_minutes: '',
        cook_time_minutes: '',
        servings: '1',
        instructions: '',
        ingredients: [],
        is_active: true,
        site_scope: 'global',
        site_ids: []
      });
    }
  }, [recipe, open]);

  const calculatedNutrition = useMemo(() => {
    const totals = {
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      sodium: 0,
      sugar: 0
    };
    const allergenSet = new Set();

    formData.ingredients.forEach((ingredientLine) => {
      const ingredientData = ingredients.find((item) => item.id === ingredientLine.ingredient_id);
      if (!ingredientData) {
        return;
      }

      const grams = quantityToGrams(ingredientLine.quantity, ingredientLine.unit);
      const factor = grams / 100;

      totals.calories += (Number(ingredientData.calories_per_100g) || 0) * factor;
      totals.protein += (Number(ingredientData.protein_per_100g) || 0) * factor;
      totals.carbs += (Number(ingredientData.carbs_per_100g) || 0) * factor;
      totals.fat += (Number(ingredientData.fat_per_100g) || 0) * factor;
      totals.sodium += (Number(ingredientData.sodium_per_100g) || 0) * factor;
      totals.sugar += (Number(ingredientData.sugar_per_100g) || 0) * factor;

      const ingredientAllergens = Array.isArray(ingredientData.allergens) ? ingredientData.allergens : [];
      ingredientAllergens.forEach((allergen) => allergenSet.add(allergen));
    });

    const servings = Math.max(1, Number(formData.servings) || 1);

    return {
      total_calories: Math.round(totals.calories),
      total_protein: roundValue(totals.protein),
      total_carbs: roundValue(totals.carbs),
      total_fat: roundValue(totals.fat),
      total_sodium: roundValue(totals.sodium),
      total_sugar: roundValue(totals.sugar),
      calories_per_serving: Math.round(totals.calories / servings),
      protein_per_serving: roundValue(totals.protein / servings),
      carbs_per_serving: roundValue(totals.carbs / servings),
      fat_per_serving: roundValue(totals.fat / servings),
      sodium_per_serving: roundValue(totals.sodium / servings),
      sugar_per_serving: roundValue(totals.sugar / servings),
      allergens: Array.from(allergenSet).sort()
    };
  }, [formData.ingredients, formData.servings, ingredients]);

  const addIngredient = () => {
    setFormData((prev) => ({
      ...prev,
      ingredients: [...prev.ingredients, { ingredient_id: '', ingredient_name: '', quantity: '', unit: 'g' }]
    }));
  };

  const removeIngredient = (index) => {
    setFormData((prev) => ({
      ...prev,
      ingredients: prev.ingredients.filter((_, i) => i !== index)
    }));
  };

  const updateIngredient = (index, field, value) => {
    setFormData((prev) => {
      const nextIngredients = [...prev.ingredients];
      nextIngredients[index] = { ...nextIngredients[index], [field]: value };

      if (field === 'ingredient_id') {
        const selected = ingredients.find((item) => item.id === value);
        if (selected) {
          nextIngredients[index].ingredient_name = selected.name;
          nextIngredients[index].unit = selected.unit || 'g';
        }
      }

      return { ...prev, ingredients: nextIngredients };
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const submitData = {
      ...formData,
      prep_time_minutes: formData.prep_time_minutes ? parseInt(formData.prep_time_minutes, 10) : null,
      cook_time_minutes: formData.cook_time_minutes ? parseInt(formData.cook_time_minutes, 10) : null,
      servings: formData.servings ? parseInt(formData.servings, 10) : 1,
      ...calculatedNutrition,
      site_scope: formData.site_scope,
      site_ids: formData.site_scope === 'specific' ? formData.site_ids : [],
      ingredients: formData.ingredients.map((ingredientLine) => ({
        ...ingredientLine,
        quantity: parseFloat(ingredientLine.quantity) || 0
      }))
    };
    onSubmit(submitData);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            {recipe ? 'Edit Recipe' : 'Create New Recipe'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label htmlFor="name">Recipe Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Grilled Chicken with Vegetables"
                className="mt-1"
                required
              />
            </div>

            <div>
              <Label htmlFor="recipe_code">Recipe Code</Label>
              <Input
                id="recipe_code"
                value={formData.recipe_code}
                onChange={(e) => setFormData({ ...formData, recipe_code: e.target.value })}
                placeholder="e.g., RCP-001"
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="recipe_type">Recipe Type *</Label>
              <Select
                value={formData.recipe_type}
                onValueChange={(value) => setFormData({ ...formData, recipe_type: value })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full (Finished)</SelectItem>
                  <SelectItem value="semi">Semi (Semi-Finished)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="category">Category</Label>
              <Input
                id="category"
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="mt-1"
                placeholder="e.g., lunch"
              />
            </div>

            <div>
              <Label htmlFor="cuisine_type">Cuisine</Label>
              <Input
                id="cuisine_type"
                value={formData.cuisine_type}
                onChange={(e) => setFormData({ ...formData, cuisine_type: e.target.value })}
                className="mt-1"
                placeholder="e.g., middle_eastern"
              />
            </div>

            <div>
              <Label htmlFor="prep_time">Prep Time (minutes)</Label>
              <Input
                id="prep_time"
                type="number"
                value={formData.prep_time_minutes}
                onChange={(e) => setFormData({ ...formData, prep_time_minutes: e.target.value })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="cook_time">Cook Time (minutes)</Label>
              <Input
                id="cook_time"
                type="number"
                value={formData.cook_time_minutes}
                onChange={(e) => setFormData({ ...formData, cook_time_minutes: e.target.value })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="servings">Servings *</Label>
              <Input
                id="servings"
                type="number"
                min="1"
                value={formData.servings}
                onChange={(e) => setFormData({ ...formData, servings: e.target.value })}
                className="mt-1"
                required
              />
            </div>

            <div className="md:col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of the recipe..."
                className="mt-1"
                rows={2}
              />
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <Label className="text-base font-semibold">Ingredients</Label>
              <Button type="button" variant="outline" size="sm" onClick={addIngredient}>
                <Plus className="mr-1 h-4 w-4" />
                Add Ingredient
              </Button>
            </div>

            <div className="space-y-3">
              {formData.ingredients.map((ingredientLine, index) => (
                <div key={index} className="grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-3 md:grid-cols-[1fr_120px_120px_48px]">
                  <div>
                    <Select
                      value={ingredientLine.ingredient_id}
                      onValueChange={(value) => updateIngredient(index, 'ingredient_id', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select ingredient" />
                      </SelectTrigger>
                      <SelectContent>
                        {ingredients.map((ingredientOption) => (
                          <SelectItem key={ingredientOption.id} value={ingredientOption.id}>
                            {ingredientOption.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Input
                      type="number"
                      step="0.1"
                      value={ingredientLine.quantity}
                      onChange={(e) => updateIngredient(index, 'quantity', e.target.value)}
                      placeholder="Qty"
                    />
                  </div>
                  <div>
                    <Select
                      value={ingredientLine.unit}
                      onValueChange={(value) => updateIngredient(index, 'unit', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="kg">kg</SelectItem>
                        <SelectItem value="g">g</SelectItem>
                        <SelectItem value="l">l</SelectItem>
                        <SelectItem value="ml">ml</SelectItem>
                        <SelectItem value="pieces">pcs</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeIngredient(index)}
                    className="text-red-500 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              {formData.ingredients.length === 0 ? (
                <p className="py-4 text-center text-slate-500">
                  No ingredients added. Click "Add Ingredient" to start.
                </p>
              ) : null}
            </div>

            {formData.ingredients.length > 0 ? (
              <div className="mt-4 space-y-4 rounded-xl border border-orange-100 bg-orange-50 p-4">
                <div className="flex items-center gap-2">
                  <Flame className="h-5 w-5 text-orange-500" />
                  <span className="font-medium text-orange-900">Nutrition Summary</span>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <div>
                    <p className="text-sm text-orange-700">Calories / serving</p>
                    <p className="text-2xl font-bold text-orange-900">{calculatedNutrition.calories_per_serving}</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Protein / serving</p>
                    <p className="text-xl font-semibold text-orange-900">{calculatedNutrition.protein_per_serving}g</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Carbs / serving</p>
                    <p className="text-xl font-semibold text-orange-900">{calculatedNutrition.carbs_per_serving}g</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Fat / serving</p>
                    <p className="text-xl font-semibold text-orange-900">{calculatedNutrition.fat_per_serving}g</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <div>
                    <p className="text-sm text-slate-600">Sodium / serving</p>
                    <p className="font-semibold text-slate-900">{calculatedNutrition.sodium_per_serving} mg</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Sugar / serving</p>
                    <p className="font-semibold text-slate-900">{calculatedNutrition.sugar_per_serving} g</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Total calories</p>
                    <p className="font-semibold text-slate-900">{calculatedNutrition.total_calories}</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Servings</p>
                    <p className="font-semibold text-slate-900">{Math.max(1, Number(formData.servings) || 1)}</p>
                  </div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-white p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                    <p className="text-sm font-semibold text-slate-900">Allergen Warning</p>
                  </div>
                  {calculatedNutrition.allergens.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {calculatedNutrition.allergens.map((allergen) => (
                        <Badge key={allergen} className={ALLERGEN_COLORS[allergen] || 'bg-slate-100 text-slate-700'}>
                          {allergen}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No tagged allergens detected from selected ingredients.</p>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <Label htmlFor="instructions">Cooking Instructions</Label>
            <Textarea
              id="instructions"
              value={formData.instructions}
              onChange={(e) => setFormData({ ...formData, instructions: e.target.value })}
              placeholder="Step-by-step cooking instructions..."
              className="mt-1"
              rows={4}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div>
              <Label>Location Availability</Label>
              <Select value={formData.site_scope} onValueChange={(value) => setFormData((current) => ({ ...current, site_scope: value }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global Recipe</SelectItem>
                  <SelectItem value="specific">Specific Locations</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.site_scope === 'specific' ? (
              <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3">
                {sites.map((site) => {
                  const checked = formData.site_ids.includes(site.id);
                  return (
                    <label key={site.id} className="flex items-center gap-3 text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(nextChecked) => setFormData((current) => ({
                          ...current,
                          site_ids: nextChecked
                            ? Array.from(new Set([...current.site_ids, site.id]))
                            : current.site_ids.filter((id) => id !== site.id)
                        }))}
                      />
                      <span>{site.hierarchy_path || site.name}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={isLoading}
            >
              {isLoading ? 'Saving...' : (recipe ? 'Update Recipe' : 'Create Recipe')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
