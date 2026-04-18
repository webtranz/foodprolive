import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, Trash2, Flame } from 'lucide-react';

export default function RecipeForm({ open, onClose, onSubmit, recipe, ingredients = [], isLoading }) {
  const [formData, setFormData] = useState({
    name: '',
    recipe_code: '',
    recipe_type: 'full',
    description: '',
    prep_time_minutes: '',
    cook_time_minutes: '',
    instructions: '',
    ingredients: [],
    is_active: true
  });

  const [calculatedCalories, setCalculatedCalories] = useState({ total: 0, perServing: 0 });

  useEffect(() => {
    if (recipe) {
      setFormData({
        name: recipe.name || '',
        recipe_code: recipe.recipe_code || '',
        recipe_type: recipe.recipe_type || 'full',
        description: recipe.description || '',
        prep_time_minutes: recipe.prep_time_minutes || '',
        cook_time_minutes: recipe.cook_time_minutes || '',
        instructions: recipe.instructions || '',
        ingredients: recipe.ingredients || [],
        is_active: recipe.is_active !== false
      });
    } else {
      setFormData({
        name: '',
        recipe_code: '',
        recipe_type: 'full',
        description: '',
        prep_time_minutes: '',
        cook_time_minutes: '',
        instructions: '',
        ingredients: [],
        is_active: true
      });
    }
  }, [recipe, open]);

  // Calculate calories whenever ingredients change
  useEffect(() => {
    let totalCalories = 0;
    formData.ingredients.forEach(ing => {
      const ingredientData = ingredients.find(i => i.id === ing.ingredient_id);
      if (ingredientData && ingredientData.calories_per_100g && ing.quantity) {
        let grams = ing.quantity;
        if (ing.unit === 'kg') grams = ing.quantity * 1000;
        else if (ing.unit === 'g') grams = ing.quantity;
        totalCalories += (ingredientData.calories_per_100g / 100) * grams;
      }
    });
    setCalculatedCalories({ total: Math.round(totalCalories), perServing: Math.round(totalCalories) });
  }, [formData.ingredients, ingredients]);

  const addIngredient = () => {
    setFormData(prev => ({
      ...prev,
      ingredients: [...prev.ingredients, { ingredient_id: '', ingredient_name: '', quantity: '', unit: 'g' }]
    }));
  };

  const removeIngredient = (index) => {
    setFormData(prev => ({
      ...prev,
      ingredients: prev.ingredients.filter((_, i) => i !== index)
    }));
  };

  const updateIngredient = (index, field, value) => {
    setFormData(prev => {
      const newIngredients = [...prev.ingredients];
      newIngredients[index] = { ...newIngredients[index], [field]: value };
      
      // If selecting ingredient, also update name and default unit
      if (field === 'ingredient_id') {
        const selected = ingredients.find(i => i.id === value);
        if (selected) {
          newIngredients[index].ingredient_name = selected.name;
          newIngredients[index].unit = selected.unit || 'g';
        }
      }
      
      return { ...prev, ingredients: newIngredients };
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const submitData = {
      ...formData,
      prep_time_minutes: formData.prep_time_minutes ? parseInt(formData.prep_time_minutes) : null,
      cook_time_minutes: formData.cook_time_minutes ? parseInt(formData.cook_time_minutes) : null,
      total_calories: calculatedCalories.total,
      calories_per_serving: calculatedCalories.total,
      ingredients: formData.ingredients.map(ing => ({
        ...ing,
        quantity: parseFloat(ing.quantity) || 0
      }))
    };
    onSubmit(submitData);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            {recipe ? 'Edit Recipe' : 'Create New Recipe'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
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

            <div className="col-span-2">
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

          {/* Ingredients Section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <Label className="text-base font-semibold">Ingredients</Label>
              <Button type="button" variant="outline" size="sm" onClick={addIngredient}>
                <Plus className="w-4 h-4 mr-1" />
                Add Ingredient
              </Button>
            </div>

            <div className="space-y-3">
              {formData.ingredients.map((ing, index) => (
                <div key={index} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                  <div className="flex-1">
                    <Select
                      value={ing.ingredient_id}
                      onValueChange={(value) => updateIngredient(index, 'ingredient_id', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select ingredient" />
                      </SelectTrigger>
                      <SelectContent>
                        {ingredients.map(ingredient => (
                          <SelectItem key={ingredient.id} value={ingredient.id}>
                            {ingredient.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-24">
                    <Input
                      type="number"
                      step="0.1"
                      value={ing.quantity}
                      onChange={(e) => updateIngredient(index, 'quantity', e.target.value)}
                      placeholder="Qty"
                    />
                  </div>
                  <div className="w-24">
                    <Select
                      value={ing.unit}
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
                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}

              {formData.ingredients.length === 0 && (
                <p className="text-center text-slate-500 py-4">
                  No ingredients added. Click "Add Ingredient" to start.
                </p>
              )}
            </div>

            {/* Calories Display */}
            {formData.ingredients.length > 0 && (
              <div className="mt-4 p-4 bg-orange-50 rounded-lg border border-orange-100">
                <div className="flex items-center gap-2 mb-2">
                  <Flame className="w-5 h-5 text-orange-500" />
                  <span className="font-medium text-orange-900">Calculated Calories</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-orange-700">Total</p>
                    <p className="text-2xl font-bold text-orange-900">{calculatedCalories.total} cal</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Per Serving</p>
                    <p className="text-2xl font-bold text-orange-900">{calculatedCalories.perServing} cal</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Instructions */}
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