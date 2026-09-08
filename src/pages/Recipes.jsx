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
import { Plus, Search, Utensils, Download } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { hasAdministratorAccess } from '../../shared/bulkUploadAccess.js';

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
