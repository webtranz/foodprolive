import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import RecipeForm from '@/components/recipes/RecipeForm';
import RecipeCard from '@/components/recipes/RecipeCard';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Search, Utensils, Download, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { hasAdministratorAccess } from '../../shared/bulkUploadAccess.js';
import { formatRecipeQuantity } from '../../shared/recipeNumbers.js';
import { buildRecipeIngredientUnitSyncPreview } from '../../shared/recipeUnitSync.js';

const CATEGORIES = [
  { value: 'all', label: 'All Categories' },
  { value: 'starter_salad_soup', label: 'Starter / Salad / Soup' },
  { value: 'main_course', label: 'Main Course' },
  { value: 'vegetable', label: 'Vegetable' },
  { value: 'dessert', label: 'Dessert' },
  { value: 'beverages', label: 'Beverages' },
  { value: 'side_dish', label: 'Side Dish' }
];

export default function Recipes() {
  const { allowedSiteIds, isAdmin, currentUser } = useSiteContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedCuisine, setSelectedCuisine] = useState('all');
  const [selectedSite, setSelectedSite] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [recipeToDelete, setRecipeToDelete] = useState(null);
  const [unitSyncOpen, setUnitSyncOpen] = useState(false);
  const [selectedUnitSyncKeys, setSelectedUnitSyncKeys] = useState(() => new Set());
  const [unitSyncResult, setUnitSyncResult] = useState(null);

  const queryClient = useQueryClient();

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipeInventory = [], isSuccess: recipeInventoryLoaded } = useQuery({
    queryKey: ['recipe-ingredient-stock'],
    queryFn: () => base44.inventory.getStockOnHand()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const visibleSites = useMemo(() => {
    if (isAdmin) {
      return sites;
    }
    if (!Array.isArray(allowedSiteIds) || allowedSiteIds.length === 0) {
      return sites;
    }
    return sites.filter((site) => allowedSiteIds.includes(site.id));
  }, [allowedSiteIds, isAdmin, sites]);
  const canSyncIngredientUnits = hasAdministratorAccess(currentUser || {});
  const unitSyncPreview = useMemo(
    () => buildRecipeIngredientUnitSyncPreview({ recipes, ingredients }),
    [ingredients, recipes]
  );
  const unitSyncRows = unitSyncPreview.changes;
  const selectedUnitSyncRows = unitSyncRows.filter((row) => selectedUnitSyncKeys.has(row.key));
  const allUnitSyncRowsSelected = unitSyncRows.length > 0 && selectedUnitSyncRows.length === unitSyncRows.length;

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Recipe.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      setFormOpen(false);
    },
    onError: (error) => {
      console.error('Recipe create failed:', error);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Recipe.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      setFormOpen(false);
      setEditingRecipe(null);
    },
    onError: (error) => {
      console.error('Recipe update failed:', error);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Recipe.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      setDeleteDialogOpen(false);
      setRecipeToDelete(null);
    }
  });

  const unitSyncMutation = useMutation({
    mutationFn: (changes) => base44.recipes.syncIngredientUnits({ changes }),
    onSuccess: (result) => {
      setUnitSyncResult(result);
      setSelectedUnitSyncKeys(new Set());
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      queryClient.invalidateQueries({ queryKey: ['ingredients'] });
    }
  });

  const filteredRecipes = recipes.filter(recipe => {
    const matchesSearch = recipe.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || recipe.category === selectedCategory;
    const matchesCuisine = selectedCuisine === 'all' || recipe.cuisine_type === selectedCuisine;
    const recipeSiteIds = Array.isArray(recipe.site_ids) ? recipe.site_ids : [];
    const isGlobalRecipe = !recipe.site_scope || recipe.site_scope === 'global' || recipeSiteIds.length === 0;
    const matchesSite = selectedSite === 'all'
      ? true
      : selectedSite === 'global'
        ? isGlobalRecipe
        : recipeSiteIds.includes(selectedSite) || recipe.site_id === selectedSite;
    return matchesSearch && matchesCategory && matchesCuisine && matchesSite;
  });

  const handleSubmit = async (data) => {
    if (editingRecipe) {
      await updateMutation.mutateAsync({ id: editingRecipe.id, data });
      return;
    }
    await createMutation.mutateAsync(data);
  };

  const handleEdit = (recipe) => {
    setEditingRecipe(recipe);
    setFormOpen(true);
  };

  const handleDelete = (recipe) => {
    setRecipeToDelete(recipe);
    setDeleteDialogOpen(true);
  };

  const openUnitSyncDialog = () => {
    unitSyncMutation.reset();
    setUnitSyncResult(null);
    setSelectedUnitSyncKeys(new Set(unitSyncRows.map((row) => row.key)));
    setUnitSyncOpen(true);
  };

  const toggleUnitSyncRow = (key, checked) => {
    setSelectedUnitSyncKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAllUnitSyncRows = (checked) => {
    setSelectedUnitSyncKeys(checked ? new Set(unitSyncRows.map((row) => row.key)) : new Set());
  };

  const applyUnitSync = () => {
    unitSyncMutation.mutate(selectedUnitSyncRows.map((row) => ({
      recipe_id: row.recipe_id,
      line_index: row.line_index,
      ingredient_id: row.ingredient_id
    })));
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Recipes" 
          description="Manage your menu recipes"
        >
          <Link to={createPageUrl('NutritionAllergen')}>
            <Button variant="outline">
              Nutrition Labels
            </Button>
          </Link>
          {canSyncIngredientUnits ? (
            <Button
              variant="outline"
              onClick={openUnitSyncDialog}
              disabled={unitSyncRows.length === 0}
              title={unitSyncRows.length === 0 ? 'No recipe lines need ingredient unit syncing.' : 'Review recipe lines that can be converted to current ingredient units.'}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Sync Ingredient Units
              {unitSyncRows.length > 0 ? <span className="ml-1">({unitSyncRows.length})</span> : null}
            </Button>
          ) : null}
          <Button 
            variant="outline"
            onClick={() => downloadCSV(filteredRecipes, 'recipes')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            onClick={() => { setEditingRecipe(null); setFormOpen(true); }}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Recipe
          </Button>
        </PageHeader>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search recipes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map(cat => (
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedCuisine} onValueChange={setSelectedCuisine}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Cuisine" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Cuisines</SelectItem>
                <SelectItem value="continental">Continental</SelectItem>
                <SelectItem value="desi">Desi</SelectItem>
                <SelectItem value="italian">Italian</SelectItem>
                <SelectItem value="chinese">Chinese</SelectItem>
                <SelectItem value="japanese">Japanese</SelectItem>
                <SelectItem value="korean">Korean</SelectItem>
                <SelectItem value="thai">Thai</SelectItem>
                <SelectItem value="middle_eastern">Middle Eastern</SelectItem>
                <SelectItem value="mediterranean">Mediterranean</SelectItem>
                <SelectItem value="american">American</SelectItem>
                <SelectItem value="mexican">Mexican</SelectItem>
                <SelectItem value="latin_american">Latin American</SelectItem>
                <SelectItem value="african">African</SelectItem>
                <SelectItem value="seafood">Seafood</SelectItem>
                <SelectItem value="vegetarian">Vegetarian</SelectItem>
                <SelectItem value="vegan">Vegan</SelectItem>
                <SelectItem value="bakery">Bakery</SelectItem>
                <SelectItem value="fusion">Fusion</SelectItem>
              </SelectContent>
            </Select>
            <Select value={selectedSite} onValueChange={setSelectedSite}>
              <SelectTrigger className="w-full sm:w-[220px]">
                <SelectValue placeholder="Project / Location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Projects</SelectItem>
                <SelectItem value="global">Global Recipes</SelectItem>
                {visibleSites.map((site) => (
                  <SelectItem key={site.id} value={site.id}>
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-xl" />
            ))}
          </div>
        ) : filteredRecipes.length === 0 ? (
          <EmptyState
            icon={Utensils}
            title="No recipes found"
            description={searchQuery || selectedCategory !== 'all' 
              ? "Try adjusting your filters" 
              : "Create your first recipe to get started"}
            actionLabel="Add Recipe"
            onAction={() => setFormOpen(true)}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredRecipes.map(recipe => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                recipes={recipes}
                ingredients={ingredients}
                inventory={recipeInventory}
                inventoryLoaded={recipeInventoryLoaded}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {/* Form Dialog */}
        <RecipeForm
          canEditLineWeights={hasAdministratorAccess(currentUser || {})}
          open={formOpen}
          onClose={() => { setFormOpen(false); setEditingRecipe(null); }}
          onSubmit={handleSubmit}
          recipe={editingRecipe}
          recipes={recipes}
          ingredients={ingredients}
          inventory={recipeInventory}
          inventoryLoaded={recipeInventoryLoaded}
          sites={sites}
          isLoading={createMutation.isPending || updateMutation.isPending}
        />

        <Dialog open={unitSyncOpen} onOpenChange={(open) => {
          setUnitSyncOpen(open);
          if (!open) {
            setUnitSyncResult(null);
            setSelectedUnitSyncKeys(new Set());
          }
        }}>
          <DialogContent className="max-h-[88vh] max-w-6xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>Sync Recipe Ingredient Units</DialogTitle>
              <DialogDescription>
                Review recipe lines where the saved recipe unit differs from the current ingredient master unit. Selected rows will be converted safely before saving.
              </DialogDescription>
            </DialogHeader>

            {unitSyncResult ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4" />
                  <div>
                    <p className="font-semibold">
                      Synced {unitSyncResult.lines_changed || 0} recipe line{Number(unitSyncResult.lines_changed) === 1 ? '' : 's'} in {unitSyncResult.recipes_changed || 0} recipe{Number(unitSyncResult.recipes_changed) === 1 ? '' : 's'}.
                    </p>
                    {unitSyncResult.skipped?.length ? (
                      <p className="mt-1">
                        {unitSyncResult.skipped.length} selected row{unitSyncResult.skipped.length === 1 ? '' : 's'} were skipped because the recipe line changed or could not be converted.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : unitSyncRows.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                No recipe lines need syncing right now.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
                  <div>
                    <p className="font-semibold">{unitSyncRows.length} safe conversion{unitSyncRows.length === 1 ? '' : 's'} found</p>
                    <p className="text-blue-700">Quantities will be converted; units will not be simply relabeled.</p>
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-white px-3 py-2">
                    <Checkbox
                      checked={allUnitSyncRowsSelected}
                      onCheckedChange={(checked) => toggleAllUnitSyncRows(checked === true)}
                      id="select-all-unit-sync"
                    />
                    <label htmlFor="select-all-unit-sync" className="cursor-pointer text-sm font-medium">
                      Select all
                    </label>
                  </div>
                </div>

                <div className="max-h-[48vh] overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[920px] text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="w-12 px-3 py-2">Use</th>
                        <th className="px-3 py-2">Recipe</th>
                        <th className="px-3 py-2">Ingredient</th>
                        <th className="px-3 py-2">Current recipe line</th>
                        <th className="px-3 py-2">After sync</th>
                        <th className="px-3 py-2">Ingredient rule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unitSyncRows.map((row) => (
                        <tr key={row.key} className="border-t border-slate-100">
                          <td className="px-3 py-3 align-top">
                            <Checkbox
                              checked={selectedUnitSyncKeys.has(row.key)}
                              onCheckedChange={(checked) => toggleUnitSyncRow(row.key, checked === true)}
                              aria-label={`Sync ${row.ingredient_name} in ${row.recipe_name}`}
                            />
                          </td>
                          <td className="px-3 py-3 align-top">
                            <p className="font-medium text-slate-900">{row.recipe_name}</p>
                            <p className="text-xs text-slate-500">Line {row.line_index + 1}</p>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <p className="font-medium text-slate-800">{row.ingredient_name}</p>
                            {row.item_code ? <p className="text-xs text-slate-500">{row.item_code}</p> : null}
                          </td>
                          <td className="px-3 py-3 align-top">
                            <Badge variant="outline">
                              {formatRecipeQuantity(row.current_quantity, row.current_unit)} {row.current_unit}
                            </Badge>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                              {formatRecipeQuantity(row.proposed_quantity, row.proposed_unit)} {row.proposed_unit}
                            </Badge>
                          </td>
                          <td className="px-3 py-3 align-top text-slate-600">
                            {row.conversion_summary}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {unitSyncPreview.skipped.length ? (
                  <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <summary className="flex cursor-pointer items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      {unitSyncPreview.skipped.length} recipe line{unitSyncPreview.skipped.length === 1 ? '' : 's'} could not be prepared for sync
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                      {unitSyncPreview.skipped.slice(0, 10).map((row) => (
                        <li key={row.key || `${row.recipe_id}-${row.line_index}`}>
                          {row.recipe_name}: {row.ingredient_name} — {row.reason}
                        </li>
                      ))}
                      {unitSyncPreview.skipped.length > 10 ? (
                        <li>{unitSyncPreview.skipped.length - 10} more skipped lines are not shown here.</li>
                      ) : null}
                    </ul>
                  </details>
                ) : null}
              </>
            )}

            {unitSyncMutation.isError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {unitSyncMutation.error?.message || 'Recipe unit sync failed. Please try again.'}
              </div>
            ) : null}

            <DialogFooter>
              {unitSyncResult ? (
                <Button onClick={() => setUnitSyncOpen(false)}>Close</Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setUnitSyncOpen(false)} disabled={unitSyncMutation.isPending}>
                    Cancel
                  </Button>
                  <Button
                    onClick={applyUnitSync}
                    disabled={selectedUnitSyncRows.length === 0 || unitSyncMutation.isPending}
                    className="bg-emerald-600 hover:bg-emerald-700"
                  >
                    {unitSyncMutation.isPending ? 'Syncing…' : `Apply ${selectedUnitSyncRows.length} selected`}
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Recipe</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{recipeToDelete?.name}"? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(recipeToDelete?.id)}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
