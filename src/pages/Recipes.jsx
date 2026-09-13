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

function matchesIngredientSearch(row = {}, searchText = '') {
  const query = String(searchText || '').trim().toLowerCase();
  if (!query) return true;
  return [
    row.ingredient_name,
    row.item_code,
    row.ingredient_id
  ].some((value) => String(value || '').toLowerCase().includes(query));
}

function getRecipeSiteIds(recipe = {}) {
  return (Array.isArray(recipe.site_ids) ? recipe.site_ids : [])
    .map((siteId) => String(siteId || '').trim())
    .filter(Boolean);
}

const EMPTY_RECIPE_DELETE_IMPACT = {
  menuPlans: [],
  subRecipes: [],
  menuPlanCount: 0,
  subRecipeCount: 0
};

function normalizeRecipeDeleteImpact(impact = {}) {
  const menuPlans = Array.isArray(impact.menu_plan_examples) ? impact.menu_plan_examples : [];
  const subRecipes = Array.isArray(impact.sub_recipe_examples) ? impact.sub_recipe_examples : [];
  return {
    menuPlans,
    subRecipes,
    menuPlanCount: Number(impact.menu_plan_reference_count || menuPlans.length || 0),
    subRecipeCount: Number(impact.sub_recipe_reference_count || subRecipes.length || 0)
  };
}

function normalizeArrayResponse(value) {
  return Array.isArray(value) ? value : [];
}

function buildSafeUnitSyncPreview({ recipes, ingredients }) {
  try {
    return buildRecipeIngredientUnitSyncPreview({ recipes, ingredients });
  } catch (error) {
    console.error('Recipe ingredient unit sync preview failed:', error);
    return { changes: [], skipped: [] };
  }
}

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
  const [recipeDeleteImpact, setRecipeDeleteImpact] = useState(EMPTY_RECIPE_DELETE_IMPACT);
  const [recipeDeleteImpactLoading, setRecipeDeleteImpactLoading] = useState(false);
  const [recipeDeleteImpactError, setRecipeDeleteImpactError] = useState('');
  const [unitSyncOpen, setUnitSyncOpen] = useState(false);
  const [selectedUnitSyncKeys, setSelectedUnitSyncKeys] = useState(() => new Set());
  const [unitSyncResult, setUnitSyncResult] = useState(null);
  const [unitSyncIngredientSearchDraft, setUnitSyncIngredientSearchDraft] = useState('');
  const [unitSyncIngredientSearch, setUnitSyncIngredientSearch] = useState('');

  const queryClient = useQueryClient();
  const canManageRecipeDeletion = hasAdministratorAccess(currentUser || {});

  const { data: recipesData = [], isLoading, error: recipesError } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredientsData = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: recipeInventoryData = [], isSuccess: recipeInventoryLoaded } = useQuery({
    queryKey: ['recipe-ingredient-stock'],
    queryFn: () => base44.inventory.getStockOnHand()
  });

  const { data: sitesData = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const recipes = useMemo(() => normalizeArrayResponse(recipesData), [recipesData]);
  const ingredients = useMemo(() => normalizeArrayResponse(ingredientsData), [ingredientsData]);
  const recipeInventory = useMemo(() => normalizeArrayResponse(recipeInventoryData), [recipeInventoryData]);
  const sites = useMemo(() => normalizeArrayResponse(sitesData), [sitesData]);

  const visibleSites = useMemo(() => {
    if (isAdmin) {
      return sites;
    }
    if (!Array.isArray(allowedSiteIds) || allowedSiteIds.length === 0) {
      return sites;
    }
    return sites.filter((site) => allowedSiteIds.includes(site.id));
  }, [allowedSiteIds, isAdmin, sites]);
  const canSyncIngredientUnits = canManageRecipeDeletion;
  const unitSyncPreview = useMemo(() => {
    if (!canSyncIngredientUnits) {
      return { changes: [], skipped: [] };
    }
    return buildSafeUnitSyncPreview({ recipes, ingredients });
  }, [canSyncIngredientUnits, ingredients, recipes]);
  const unitSyncRows = Array.isArray(unitSyncPreview.changes) ? unitSyncPreview.changes : [];
  const incompatibleUnitSyncRows = Array.isArray(unitSyncPreview.skipped) ? unitSyncPreview.skipped : [];
  const filteredUnitSyncRows = useMemo(
    () => unitSyncRows.filter((row) => matchesIngredientSearch(row, unitSyncIngredientSearch)),
    [unitSyncIngredientSearch, unitSyncRows]
  );
  const filteredIncompatibleUnitSyncRows = useMemo(
    () => incompatibleUnitSyncRows.filter((row) => matchesIngredientSearch(row, unitSyncIngredientSearch)),
    [incompatibleUnitSyncRows, unitSyncIngredientSearch]
  );
  const selectedUnitSyncRows = unitSyncRows.filter((row) => selectedUnitSyncKeys.has(row.key));
  const allVisibleUnitSyncRowsSelected = filteredUnitSyncRows.length > 0
    && filteredUnitSyncRows.every((row) => selectedUnitSyncKeys.has(row.key));

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
    const matchesSearch = String(recipe.name || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || recipe.category === selectedCategory;
    const matchesCuisine = selectedCuisine === 'all' || recipe.cuisine_type === selectedCuisine;
    const recipeSiteIds = getRecipeSiteIds(recipe);
    const isSpecificRecipe = String(recipe.site_scope || '').toLowerCase() === 'specific';
    const isGlobalRecipe = !isSpecificRecipe && (!recipe.site_scope || recipe.site_scope === 'global');
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

  const handleDelete = async (recipe) => {
    if (!canManageRecipeDeletion) return;
    setRecipeToDelete(recipe);
    setRecipeDeleteImpact(EMPTY_RECIPE_DELETE_IMPACT);
    setRecipeDeleteImpactError('');
    setRecipeDeleteImpactLoading(true);
    deleteMutation.reset();
    setDeleteDialogOpen(true);
    try {
      const impact = await base44.entities.Recipe.deleteImpact(recipe.id);
      setRecipeDeleteImpact(normalizeRecipeDeleteImpact(impact));
    } catch (error) {
      setRecipeDeleteImpactError(error.message || 'Could not load recipe linkage impact.');
    } finally {
      setRecipeDeleteImpactLoading(false);
    }
  };

  const openUnitSyncDialog = () => {
    unitSyncMutation.reset();
    setUnitSyncResult(null);
    setUnitSyncIngredientSearchDraft('');
    setUnitSyncIngredientSearch('');
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

  const toggleAllVisibleUnitSyncRows = (checked) => {
    setSelectedUnitSyncKeys((current) => {
      const next = new Set(current);
      filteredUnitSyncRows.forEach((row) => {
        if (checked) next.add(row.key);
        else next.delete(row.key);
      });
      return next;
    });
  };

  const runUnitSyncIngredientSearch = () => {
    const searchText = unitSyncIngredientSearchDraft.trim();
    setUnitSyncIngredientSearch(searchText);
    const rowsToSelect = unitSyncRows.filter((row) => matchesIngredientSearch(row, searchText));
    setSelectedUnitSyncKeys(new Set(rowsToSelect.map((row) => row.key)));
  };

  const clearUnitSyncIngredientSearch = () => {
    setUnitSyncIngredientSearchDraft('');
    setUnitSyncIngredientSearch('');
    setSelectedUnitSyncKeys(new Set(unitSyncRows.map((row) => row.key)));
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
              disabled={unitSyncRows.length === 0 && incompatibleUnitSyncRows.length === 0}
              title={unitSyncRows.length === 0 && incompatibleUnitSyncRows.length === 0 ? 'No recipe lines need ingredient unit syncing.' : 'Review recipe lines that can be converted to current ingredient units.'}
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

        {recipesError ? (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            <div className="font-semibold">Recipes could not be loaded.</div>
            <div className="mt-1 text-sm">
              {recipesError.message || 'Please refresh the page. If this continues, check the recipe data or server logs.'}
            </div>
          </div>
        ) : null}

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
                sites={sites}
                onEdit={handleEdit}
                onDelete={canManageRecipeDeletion ? handleDelete : null}
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
            setUnitSyncIngredientSearchDraft('');
            setUnitSyncIngredientSearch('');
          }
        }}>
          <DialogContent className="flex max-h-[88vh] max-w-6xl flex-col overflow-hidden">
            <DialogHeader className="shrink-0">
              <DialogTitle>Sync Recipe Ingredient Units</DialogTitle>
              <DialogDescription>
                Review recipe lines where the saved recipe unit differs from the current ingredient master unit. Selected rows will be converted safely before saving.
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {!unitSyncResult ? (
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
                  <div className="flex-1">
                    <label htmlFor="unit-sync-ingredient-search" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Specific ingredient search
                    </label>
                    <Input
                      id="unit-sync-ingredient-search"
                      value={unitSyncIngredientSearchDraft}
                      onChange={(event) => setUnitSyncIngredientSearchDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          runUnitSyncIngredientSearch();
                        }
                      }}
                      placeholder="Search by ingredient name, item code, or ingredient ID"
                      className="mt-1"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={runUnitSyncIngredientSearch}>
                      <Search className="mr-2 h-4 w-4" />
                      Search Ingredient
                    </Button>
                    {unitSyncIngredientSearch ? (
                      <Button type="button" variant="ghost" onClick={clearUnitSyncIngredientSearch}>
                        Clear
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {unitSyncIngredientSearch
                    ? `Showing ${filteredUnitSyncRows.length} compatible and ${filteredIncompatibleUnitSyncRows.length} incompatible recipe line${filteredUnitSyncRows.length + filteredIncompatibleUnitSyncRows.length === 1 ? '' : 's'} for “${unitSyncIngredientSearch}”.`
                    : `Showing all ${unitSyncRows.length} compatible and ${incompatibleUnitSyncRows.length} incompatible recipe line${unitSyncRows.length + incompatibleUnitSyncRows.length === 1 ? '' : 's'}.`}
                </p>
                </div>
              ) : null}

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
              ) : unitSyncRows.length === 0 && incompatibleUnitSyncRows.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                No recipe lines need syncing right now.
                </div>
              ) : (
                <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
                  <div>
                    <p className="font-semibold">{filteredUnitSyncRows.length} safe conversion{filteredUnitSyncRows.length === 1 ? '' : 's'} shown</p>
                    <p className="text-blue-700">Quantities will be converted; units will not be simply relabeled.</p>
                  </div>
                  {filteredUnitSyncRows.length ? (
                    <div className="flex items-center gap-2 rounded-md bg-white px-3 py-2">
                      <Checkbox
                        checked={allVisibleUnitSyncRowsSelected}
                        onCheckedChange={(checked) => toggleAllVisibleUnitSyncRows(checked === true)}
                        id="select-all-unit-sync"
                      />
                      <label htmlFor="select-all-unit-sync" className="cursor-pointer text-sm font-medium">
                        Select all shown
                      </label>
                    </div>
                  ) : null}
                </div>

                <div className="max-h-[34vh] overflow-auto rounded-lg border border-slate-200">
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
                      {filteredUnitSyncRows.map((row) => (
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
                      {!filteredUnitSyncRows.length ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                            No compatible recipe lines match this ingredient search.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4" />
                    Incompatible recipe lines ({filteredIncompatibleUnitSyncRows.length})
                  </div>
                  {filteredIncompatibleUnitSyncRows.length ? (
                    <div className="max-h-56 overflow-auto rounded-md border border-amber-200 bg-white">
                      <table className="w-full min-w-[760px] text-left text-xs">
                        <thead className="sticky top-0 bg-amber-50 uppercase tracking-wide text-amber-800">
                          <tr>
                            <th className="px-3 py-2">Recipe</th>
                            <th className="px-3 py-2">Ingredient</th>
                            <th className="px-3 py-2">Current recipe line</th>
                            <th className="px-3 py-2">Why it cannot sync</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredIncompatibleUnitSyncRows.map((row) => (
                            <tr key={row.key || `${row.recipe_id}-${row.line_index}`} className="border-t border-amber-100">
                              <td className="px-3 py-2 align-top">
                                <p className="font-medium text-slate-900">{row.recipe_name}</p>
                                <p className="text-slate-500">Line {Number(row.line_index) + 1}</p>
                              </td>
                              <td className="px-3 py-2 align-top">
                                <p className="font-medium text-slate-800">{row.ingredient_name}</p>
                                {row.ingredient_id ? <p className="text-slate-500">{row.ingredient_id}</p> : null}
                              </td>
                              <td className="px-3 py-2 align-top">
                                {formatRecipeQuantity(row.current_quantity, row.current_unit)} {row.current_unit || ''}
                              </td>
                              <td className="px-3 py-2 align-top text-amber-800">
                                {row.reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-800">
                      {unitSyncIngredientSearch
                        ? 'No incompatible recipe lines match this ingredient search.'
                        : 'No incompatible recipe lines were found.'}
                    </p>
                  )}
                </div>
                </>
              )}

              {unitSyncMutation.isError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {unitSyncMutation.error?.message || 'Recipe unit sync failed. Please try again.'}
                </div>
              ) : null}
            </div>

            <DialogFooter className="shrink-0 border-t border-slate-100 pt-3">
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
        <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setRecipeToDelete(null);
            setRecipeDeleteImpact(EMPTY_RECIPE_DELETE_IMPACT);
            setRecipeDeleteImpactError('');
            setRecipeDeleteImpactLoading(false);
            deleteMutation.reset();
          }
        }}>
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Recipe</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-left text-slate-600">
                  <p>
                    This will permanently delete "{recipeToDelete?.name}". Only administrators can delete recipes. If this recipe is still linked to project availability, menu planning, or sub-recipes, those areas should be reviewed after deletion.
                  </p>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                    <div className="mb-2 flex items-start gap-2 font-semibold">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      Menu planning linkage warning
                    </div>
                    {recipeDeleteImpactLoading ? (
                      <p>Checking saved menu planning and sub-recipe links…</p>
                    ) : recipeDeleteImpactError ? (
                      <p>
                        {recipeDeleteImpactError} Review linked menu plans before future production if this recipe was previously scheduled.
                      </p>
                    ) : recipeDeleteImpact.menuPlanCount > 0 ? (
                      <>
                        <p>
                          This recipe is still referenced by {recipeDeleteImpact.menuPlanCount} saved menu planning row{recipeDeleteImpact.menuPlanCount === 1 ? '' : 's'}. After deletion, those rows may no longer resolve to an active recipe and should be reviewed before future production.
                        </p>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                          {recipeDeleteImpact.menuPlans.slice(0, 5).map((reference, index) => (
                            <li key={`${reference}-${index}`}>{reference}</li>
                          ))}
                          {recipeDeleteImpact.menuPlanCount > recipeDeleteImpact.menuPlans.length ? (
                            <li>+{recipeDeleteImpact.menuPlanCount - recipeDeleteImpact.menuPlans.length} more menu planning row{recipeDeleteImpact.menuPlanCount - recipeDeleteImpact.menuPlans.length === 1 ? '' : 's'}</li>
                          ) : null}
                        </ul>
                      </>
                    ) : (
                      <p>No saved menu planning rows were found for this recipe.</p>
                    )}
                    {!recipeDeleteImpactLoading && !recipeDeleteImpactError && recipeDeleteImpact.subRecipeCount > 0 ? (
                      <p className="mt-2 text-xs">
                        It is also used as a sub-recipe in {recipeDeleteImpact.subRecipeCount} recipe{recipeDeleteImpact.subRecipeCount === 1 ? '' : 's'}; those recipes may need review.
                      </p>
                    ) : null}
                  </div>
                  {deleteMutation.isError ? (
                    <p className="text-sm font-medium text-red-600">
                      {deleteMutation.error?.message || 'Recipe delete failed.'}
                    </p>
                  ) : null}
                  <p className="font-medium text-red-700">This action cannot be undone.</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  deleteMutation.mutate(recipeToDelete?.id);
                }}
                disabled={!recipeToDelete?.id || deleteMutation.isPending || recipeDeleteImpactLoading}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete Recipe'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
