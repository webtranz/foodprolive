import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreVertical, Pencil, Trash2, Clock, Users, Flame, ShieldAlert, Candy, Droplets } from 'lucide-react';
import { formatCurrency } from '@/lib/currency';
import { calculateRecipeCostSnapshot } from '@/lib/menuPlanning';
import { calculateRecipeServingWeight } from '../../../shared/recipeWeight.js';
import { calculateRecipeNutritionSnapshot } from '../../../shared/recipeNutrition.js';
import { formatRecipeQuantity } from '../../../shared/recipeNumbers.js';
import { convertIngredientQuantity } from '../../../shared/ingredientUnits.js';
import { getInventoryQuantities } from '@/lib/inventoryAvailability';

const CATEGORY_COLORS = {
  breakfast: 'bg-amber-100 text-amber-700',
  lunch: 'bg-emerald-100 text-emerald-700',
  dinner: 'bg-blue-100 text-blue-700',
  snack: 'bg-purple-100 text-purple-700',
  dessert: 'bg-pink-100 text-pink-700',
  beverage: 'bg-cyan-100 text-cyan-700',
  side: 'bg-slate-100 text-slate-700'
};

function formatNutritionValue(value) {
  return value === null || value === undefined ? '—' : value;
}

function calculateRecipeYieldPercent(weightSnapshot) {
  const rawWeight = Number(weightSnapshot?.raw_total_grams);
  const yieldedWeight = Number(weightSnapshot?.yielded_total_grams);
  if (!Number.isFinite(rawWeight) || rawWeight <= 0 || !Number.isFinite(yieldedWeight)) return null;
  return (yieldedWeight / rawWeight) * 100;
}

function formatRecipeYieldPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Number(value.toFixed(2)).toLocaleString()}%`;
}

function slugifyRecipeImageName(value) {
  return String(value || 'recipe')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 90) || 'recipe';
}

function getRecipeCardImageSource(recipe = {}) {
  const explicitImage = String(recipe.image_url || '').trim();
  if (explicitImage) return explicitImage;
  return `/recipe-images/${slugifyRecipeImageName(recipe.name)}.svg`;
}

export default function RecipeCard({ recipe, recipes = [], ingredients = [], inventory = [], inventoryLoaded = false, sites = [], onEdit, onDelete }) {
  const [imageFailed, setImageFailed] = useState(false);
  const totalTime = (recipe.prep_time_minutes || 0) + (recipe.cook_time_minutes || 0);
  const subRecipes = Array.isArray(recipe.sub_recipes) ? recipe.sub_recipes : [];
  const siteIds = Array.isArray(recipe.site_ids) ? recipe.site_ids.filter(Boolean) : [];
  const isSpecificRecipe = String(recipe.site_scope || '').toLowerCase() === 'specific';
  const isUnassignedRecipe = isSpecificRecipe && siteIds.length === 0;
  const isGlobalRecipe = !isSpecificRecipe && (!recipe.site_scope || recipe.site_scope === 'global');
  const siteNames = useMemo(() => {
    if (!Array.isArray(sites) || siteIds.length === 0) return [];
    const siteNameById = new Map(sites.map((site) => [String(site.id || ''), site.name || site.code || 'Project']));
    return siteIds
      .map((siteId) => siteNameById.get(String(siteId)) || String(siteId))
      .filter(Boolean);
  }, [siteIds, sites]);
  const nutritionSnapshot = useMemo(
    () => calculateRecipeNutritionSnapshot(recipe, recipes, ingredients),
    [ingredients, recipe, recipes]
  );
  const allergens = Array.isArray(nutritionSnapshot.allergens) ? nutritionSnapshot.allergens : [];
  const nutritionWarnings = Array.isArray(nutritionSnapshot.nutrition_warnings) ? nutritionSnapshot.nutrition_warnings : [];
  const allergenWarnings = Array.isArray(nutritionSnapshot.allergens_warnings) ? nutritionSnapshot.allergens_warnings : [];
  const ingredientMap = useMemo(
    () => new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients]
  );
  const availableStockByIngredient = useMemo(() => inventory.reduce((totals, stock) => {
    const ingredientId = String(stock?.ingredient_id || '');
    const ingredient = ingredientMap.get(ingredientId);
    if (!ingredientId || !ingredient) return totals;
    const availableQuantity = getInventoryQuantities(stock).available_quantity;
    const baseUnit = ingredient.unit || stock.unit || 'unit';
    const normalizedQuantity = convertIngredientQuantity(
      availableQuantity,
      stock.unit || baseUnit,
      baseUnit,
      ingredient
    );
    totals.set(ingredientId, (totals.get(ingredientId) || 0) + normalizedQuantity);
    return totals;
  }, new Map()), [ingredientMap, inventory]);
  const costingIngredients = useMemo(() => {
    const valueByIngredient = inventory.reduce((totals, stock) => {
      const ingredientId = String(stock?.ingredient_id || '');
      const ingredient = ingredientMap.get(ingredientId);
      if (!ingredientId || !ingredient) return totals;
      const onHandQuantity = getInventoryQuantities(stock).on_hand_quantity;
      const baseUnit = ingredient.unit || stock.unit || 'unit';
      const baseQuantity = convertIngredientQuantity(
        onHandQuantity,
        stock.unit || baseUnit,
        baseUnit,
        ingredient
      );
      const totalValue = Number(stock.total_value ?? stock.weighted_average_value ?? stock.fifo_total_value);
      if (!(baseQuantity > 0) || !Number.isFinite(totalValue) || totalValue < 0) return totals;
      const current = totals.get(ingredientId) || { quantity: 0, value: 0 };
      current.quantity += baseQuantity;
      current.value += totalValue;
      totals.set(ingredientId, current);
      return totals;
    }, new Map());

    return ingredients.map((ingredient) => {
      const aggregate = valueByIngredient.get(String(ingredient?.id || ''));
      if (!aggregate || !(aggregate.quantity > 0)) return ingredient;
      return {
        ...ingredient,
        average_cost: aggregate.value / aggregate.quantity,
        stock_summary: {
          on_hand_quantity: aggregate.quantity,
          available_quantity: aggregate.quantity,
          reserved_quantity: 0,
          total_value: aggregate.value,
          unit: ingredient.unit || ''
        }
      };
    });
  }, [ingredientMap, ingredients, inventory]);
  const servingWeight = useMemo(
    () => calculateRecipeServingWeight(recipe, recipes, ingredients),
    [ingredients, recipe, recipes]
  );
  const costSnapshot = useMemo(
    () => calculateRecipeCostSnapshot(recipe, costingIngredients, recipes),
    [costingIngredients, recipe, recipes]
  );
  const savedPortionSize = Number(recipe.portion_size_grams);
  const hasSavedPortionSize = Number.isFinite(savedPortionSize) && savedPortionSize > 0;
  const displayServingWeight = servingWeight.grams_per_serving;
  const formattedServingWeight = servingWeight.is_complete
    ? formatRecipeQuantity(displayServingWeight, 'g')
    : '—';
  const recipeYieldPercent = servingWeight.is_complete ? calculateRecipeYieldPercent(servingWeight) : null;
  const formattedYieldPercent = recipeYieldPercent == null ? null : formatRecipeYieldPercent(recipeYieldPercent);
  const servingCount = Number(recipe.servings) || 1;
  const servingWeightTitle = servingWeight.is_complete
      ? 'Yield-adjusted cooked weight per serving'
    : servingWeight.warnings.join(' ') || 'Add ingredient weights and units to calculate grams per serving.';
  const recipeImageSource = useMemo(() => getRecipeCardImageSource(recipe), [recipe.image_url, recipe.name]);

  useEffect(() => {
    setImageFailed(false);
  }, [recipeImageSource]);

  return (
    <Card className="border-slate-100 shadow-sm hover:shadow-md transition-all duration-300 group overflow-hidden">
      {recipeImageSource && !imageFailed && (
        <div className="h-40 overflow-hidden">
          <img 
            src={recipeImageSource}
            alt={recipe.name}
            onError={() => setImageFailed(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        </div>
      )}
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 group-hover:text-emerald-600 transition-colors">
              {recipe.name}
            </h3>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge className={`${CATEGORY_COLORS[recipe.category]} text-xs`}>
                {recipe.category}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {isUnassignedRecipe ? 'Unassigned' : isGlobalRecipe ? 'Global' : 'Project-specific'}
              </Badge>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(recipe)}>
                <Pencil className="w-4 h-4 mr-2" />
                Edit
              </DropdownMenuItem>
              {onDelete ? (
                <DropdownMenuItem
                  onClick={() => onDelete(recipe)}
                  className="text-red-600"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {recipe.description && (
          <p className="text-sm text-slate-500 line-clamp-2 mb-3">
            {recipe.description}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <div className="flex items-center gap-1 text-slate-600">
            <Users className="w-4 h-4 text-slate-400" />
            <span>{formatRecipeQuantity(servingCount, 'servings')} serving{servingCount === 1 ? '' : 's'}</span>
            <span className={servingWeight.is_complete ? 'font-medium text-emerald-700' : 'text-amber-700'} title={servingWeightTitle}>
              · {servingWeight.is_complete ? `${formattedServingWeight} g calculated` : 'Weight incomplete'}
            </span>
            {formattedYieldPercent ? (
              <span className="font-medium text-blue-700" title="Recipe yield = expected yielded weight ÷ raw recipe weight × 100">
                · Yield {formattedYieldPercent}
              </span>
            ) : null}
          </div>
          
          {totalTime > 0 && (
            <div className="flex items-center gap-1 text-slate-600">
              <Clock className="w-4 h-4 text-slate-400" />
              <span>{totalTime} min</span>
            </div>
          )}
          
          <div className="flex items-center gap-1 text-orange-600">
            <Flame className="w-4 h-4" />
            <span>{formatNutritionValue(nutritionSnapshot.calories_per_serving)} cal</span>
          </div>
        </div>

        {hasSavedPortionSize && (
          <p className="mt-2 text-xs text-slate-500">Portion target: {formatRecipeQuantity(savedPortionSize, 'g')} g</p>
        )}
        {!servingWeight.is_complete && (
          <p className="mt-2 text-xs text-amber-700 break-words">{servingWeight.warnings.join(' ')}</p>
        )}

        {costSnapshot.has_cost ? (
          <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/60 p-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium text-slate-600">Per serving cost</p>
              <p className="text-base font-semibold text-slate-900">{formatCurrency(costSnapshot.cost_per_serving)}</p>
            </div>
          </div>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <div><span className="font-semibold">Protein:</span> {formatNutritionValue(nutritionSnapshot.protein_per_serving)} g</div>
          <div><span className="font-semibold">Carbs:</span> {formatNutritionValue(nutritionSnapshot.carbs_per_serving)} g</div>
          <div><span className="font-semibold">Fat:</span> {formatNutritionValue(nutritionSnapshot.fat_per_serving)} g</div>
          <div className="flex items-center gap-1"><Droplets className="h-3 w-3 text-cyan-600" /> {formatNutritionValue(nutritionSnapshot.sodium_per_serving)} mg sodium</div>
          <div className="col-span-2 flex items-center gap-1"><Candy className="h-3 w-3 text-pink-500" /> {formatNutritionValue(nutritionSnapshot.sugar_per_serving)} g sugar</div>
        </div>
        {nutritionSnapshot.nutrition_complete !== true && (
          <p className="mt-2 text-xs text-amber-800 break-words">
            Nutrition incomplete — awaiting ingredient nutrition or weight data.
            {' '}{nutritionWarnings.slice(0, 3).join(' ')}
            {nutritionWarnings.length > 3 && ` +${nutritionWarnings.length - 3} more source data gaps.`}
          </p>
        )}

        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-amber-800">
            <ShieldAlert className="h-3.5 w-3.5" />
            Allergen warning
          </div>
          {allergens.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {allergens.map((allergen) => (
                <Badge key={allergen} variant="outline" className="border-amber-300 bg-white text-amber-700">
                  {allergen}
                </Badge>
              ))}
            </div>
          ) : nutritionSnapshot.allergens_complete === true ? (
            <p className="text-xs text-slate-600">No allergens declared in the ingredient or recipe data.</p>
          ) : null}
          {nutritionSnapshot.allergens_complete !== true && (
            <p className="mt-2 text-xs text-amber-800 break-words">
              Allergen information incomplete — awaiting ingredient allergen data.
              {' '}{allergenWarnings.slice(0, 3).join(' ')}
              {allergenWarnings.length > 3 && ` +${allergenWarnings.length - 3} more source data gaps.`}
            </p>
          )}
        </div>

        {recipe.ingredients && recipe.ingredients.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-xs text-slate-400 mb-1">{recipe.ingredients.length} ingredients</p>
            <div className="space-y-1">
              {recipe.ingredients.slice(0, 3).map((line, index) => {
                const ingredient = ingredientMap.get(line.ingredient_id);
                const unit = line.unit || ingredient?.unit || '';
                const stockUnit = ingredient?.unit || unit;
                const availableStock = availableStockByIngredient.get(String(line.ingredient_id || '')) || 0;
                return (
                  <div key={`${line.ingredient_id || line.ingredient_name}-${index}`} className="flex items-center justify-between gap-2 text-xs">
                    <p className="min-w-0 truncate text-slate-500">
                      {line.ingredient_name || ingredient?.name || 'Ingredient'} · {formatRecipeQuantity(line.quantity, unit)} {unit}
                    </p>
                    {inventoryLoaded ? (
                      <span className={availableStock > 0 ? 'shrink-0 font-medium text-emerald-700' : 'shrink-0 font-medium text-red-600'}>
                        {formatRecipeQuantity(availableStock, stockUnit)} {stockUnit} available
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {recipe.ingredients.length > 3 ? <p className="text-xs text-slate-400">+{recipe.ingredients.length - 3} more</p> : null}
            </div>
          </div>
        )}

        {subRecipes.length > 0 && (
          <div className="mt-2 rounded-lg bg-indigo-50 px-3 py-2">
            <p className="text-xs font-semibold text-indigo-700">{subRecipes.length} sub-recipe{subRecipes.length === 1 ? '' : 's'}</p>
            <p className="truncate text-xs text-indigo-600">
              {subRecipes.map((item) => `${item.recipe_name} · ${formatRecipeQuantity(item.quantity, item.unit || 'batch')} ${item.unit || 'batch'}`).join(', ')}
            </p>
          </div>
        )}

        {!isGlobalRecipe && siteNames.length > 0 && (
          <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            <span className="font-semibold">Projects:</span> {siteNames.join(', ')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
