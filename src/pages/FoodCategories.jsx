import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const EMPTY_FORM = {
  name: '',
  code: '',
  description: '',
  color: '#10b981',
  status: 'active'
};

function normalizeCategoryName(value) {
  return String(value || '').trim().toLowerCase();
}

export default function FoodCategories() {
  const queryClient = useQueryClient();
  const [editingCategory, setEditingCategory] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [message, setMessage] = useState('');

  const { data: categories = [] } = useQuery({
    queryKey: ['foodCategories'],
    queryFn: () => base44.entities.FoodCategory.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const createMutation = useMutation({
    mutationFn: (payload) => base44.entities.FoodCategory.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodCategories'] });
      setMessage('Food category created successfully.');
      setFormData(EMPTY_FORM);
    },
    onError: (error) => setMessage(error.message || 'Failed to create food category.')
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => base44.entities.FoodCategory.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodCategories'] });
      setMessage('Food category updated successfully.');
      setEditingCategory(null);
      setFormData(EMPTY_FORM);
    },
    onError: (error) => setMessage(error.message || 'Failed to update food category.')
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.FoodCategory.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foodCategories'] });
      setMessage('Food category deleted successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to delete food category.')
  });

  const usageMap = useMemo(() => {
    const counts = new Map();

    ingredients.forEach((ingredient) => {
      const key = normalizeCategoryName(ingredient.category);
      if (!key) return;
      const current = counts.get(key) || { ingredientCount: 0, recipeCount: 0 };
      current.ingredientCount += 1;
      counts.set(key, current);
    });

    recipes.forEach((recipe) => {
      const key = normalizeCategoryName(recipe.category);
      if (!key) return;
      const current = counts.get(key) || { ingredientCount: 0, recipeCount: 0 };
      current.recipeCount += 1;
      counts.set(key, current);
    });

    return counts;
  }, [ingredients, recipes]);

  const mergedCategories = useMemo(() => {
    const explicit = categories.map((category) => ({
      ...category,
      normalizedName: normalizeCategoryName(category.name)
    }));
    const existingKeys = new Set(explicit.map((category) => category.normalizedName));

    const inferred = Array.from(usageMap.entries())
      .filter(([key]) => key && !existingKeys.has(key))
      .map(([key]) => ({
        id: `derived-${key}`,
        name: key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
        code: '',
        description: 'Derived from existing recipe or ingredient usage',
        color: '#94a3b8',
        status: 'derived',
        normalizedName: key
      }));

    return [...explicit, ...inferred].map((category) => {
      const usage = usageMap.get(category.normalizedName) || { ingredientCount: 0, recipeCount: 0 };
      return {
        ...category,
        ingredientCount: usage.ingredientCount,
        recipeCount: usage.recipeCount
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }, [categories, usageMap]);

  const handleEdit = (category) => {
    if (String(category.id).startsWith('derived-')) {
      setMessage('Derived categories can be formalized by creating a new food category with the same name.');
      return;
    }

    setEditingCategory(category);
    setFormData({
      name: category.name || '',
      code: category.code || '',
      description: category.description || '',
      color: category.color || '#10b981',
      status: category.status || 'active'
    });
    setMessage('');
  };

  const handleSave = async () => {
    setMessage('');
    if (!formData.name.trim()) {
      setMessage('Category name is required.');
      return;
    }

    const payload = {
      name: formData.name.trim(),
      code: formData.code.trim() || null,
      description: formData.description.trim() || null,
      color: formData.color || '#10b981',
      status: formData.status || 'active'
    };

    if (editingCategory?.id) {
      await updateMutation.mutateAsync({ id: editingCategory.id, payload });
      return;
    }

    await createMutation.mutateAsync(payload);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          title="Food Categories"
          description="Manage category masters used across recipes, ingredients, and reporting."
        />

        {message ? (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{message}</span>
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <Card className="border-slate-100 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">
                {editingCategory ? 'Edit Food Category' : 'Add Food Category'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="categoryName">Category Name</Label>
                <Input
                  id="categoryName"
                  className="mt-2 bg-white"
                  value={formData.name}
                  onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Main Course"
                />
              </div>
              <div>
                <Label htmlFor="categoryCode">Category Code</Label>
                <Input
                  id="categoryCode"
                  className="mt-2 bg-white"
                  value={formData.code}
                  onChange={(event) => setFormData((current) => ({ ...current, code: event.target.value }))}
                  placeholder="MAIN"
                />
              </div>
              <div>
                <Label htmlFor="categoryDescription">Description</Label>
                <textarea
                  id="categoryDescription"
                  className="mt-2 min-h-24 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-offset-white focus-visible:ring-2 focus-visible:ring-slate-950"
                  value={formData.description}
                  onChange={(event) => setFormData((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Used for lunch and dinner production items"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="categoryColor">Color</Label>
                  <Input
                    id="categoryColor"
                    type="color"
                    className="mt-2 h-11 bg-white"
                    value={formData.color}
                    onChange={(event) => setFormData((current) => ({ ...current, color: event.target.value }))}
                  />
                </div>
                <div>
                  <Label>Status</Label>
                  <Select value={formData.status} onValueChange={(value) => setFormData((current) => ({ ...current, status: value }))}>
                    <SelectTrigger className="mt-2 bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={handleSave}
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {editingCategory ? 'Update Category' : 'Create Category'}
                </Button>
                {editingCategory ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingCategory(null);
                      setFormData(EMPTY_FORM);
                      setMessage('');
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-100 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">Category Registry</CardTitle>
              <Badge variant="outline">{mergedCategories.length} categories</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {mergedCategories.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center text-slate-500">
                  <FolderTree className="mx-auto mb-3 h-12 w-12 text-slate-300" />
                  No food categories found yet.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {mergedCategories.map((category) => (
                    <div key={category.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: category.color || '#94a3b8' }} />
                            <h3 className="truncate font-semibold text-slate-900">{category.name}</h3>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Badge variant="outline">{category.code || 'No code'}</Badge>
                            <Badge className={category.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700'}>
                              {category.status}
                            </Badge>
                          </div>
                        </div>
                        {!String(category.id).startsWith('derived-') ? (
                          <div className="flex gap-1">
                            <Button type="button" variant="ghost" size="icon" onClick={() => handleEdit(category)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              onClick={() => deleteMutation.mutate(category.id)}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : null}
                      </div>

                      <p className="mt-3 text-sm text-slate-600">
                        {category.description || 'No description available.'}
                      </p>

                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-xs uppercase text-slate-500">Ingredients</p>
                          <p className="mt-1 font-semibold text-slate-900">{category.ingredientCount}</p>
                        </div>
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-xs uppercase text-slate-500">Recipes</p>
                          <p className="mt-1 font-semibold text-slate-900">{category.recipeCount}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
