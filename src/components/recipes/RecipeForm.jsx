import React, { useMemo, useRef, useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Flame, ShieldAlert, GitBranch, ImagePlus, X, CircleCheck, CircleAlert, RefreshCw } from 'lucide-react';
import IngredientSearchCombobox from '@/components/ingredients/IngredientSearchCombobox';
import StandardDecimalInput from '@/components/recipes/StandardDecimalInput';
import { formatCurrency, formatNumber } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { normalizeIngredientUnit } from '../../../shared/ingredientUnits.js';
import {
  validateRecipeComposition,
  wouldCreateRecipeCycle
} from '../../../shared/recipeComposition.js';
import {
  validateRecipeImageFile,
  validateRecipeImageReference
} from '../../../shared/recipeImage.js';
import { calculateRecipeServingWeight } from '../../../shared/recipeWeight.js';
import { calculateRecipeNutrition } from '../../../shared/recipeNutrition.js';
import { calculateYieldOutputQuantity } from '../../../shared/ingredientYield.js';
import {
  calculateRecipeCostingSnapshot,
  calculateRecipeIngredientLineCost,
  RECIPE_COSTING_METHODS
} from '../../../shared/recipeCosting.js';
import {
  formatRecipeQuantity,
  normalizeRecipeNumericFields,
  standardizeDecimalValue
} from '../../../shared/recipeNumbers.js';
import { getItemCode } from '../../../shared/itemCode.js';
import {
  clearRecipeLineWeight,
  getRecipeLineWeight,
  isExemptProcessingAid
} from '../../../shared/recipeLineWeight.js';
import { calculateFrozenProductionLineWeight } from '../../../shared/productionReconciliation.js';

const RECIPE_CATEGORIES = [
  { value: 'starter_salad_soup', label: 'Starter / Salad / Soup' },
  { value: 'main_course', label: 'Main Course' },
  { value: 'vegetable', label: 'Vegetable' },
  { value: 'dessert', label: 'Dessert' },
  { value: 'beverages', label: 'Beverages' },
  { value: 'side_dish', label: 'Side Dish' }
];

const RECIPE_INGREDIENT_UNITS = Object.freeze([
  { value: 'kg', label: 'kg' },
  { value: 'g', label: 'g' },
  { value: 'l', label: 'l' },
  { value: 'ml', label: 'ml' },
  { value: 'pieces', label: 'pcs' },
  { value: 'ct', label: 'CT' },
  { value: 'ea', label: 'EA' },
  { value: 'bdl', label: 'BDL' },
  { value: 'pak', label: 'PAK' },
  { value: 'cs', label: 'CS' }
]);
const SUPPORTED_RECIPE_INGREDIENT_UNITS = new Set(RECIPE_INGREDIENT_UNITS.map((unit) => unit.value));

const ALLERGEN_COLORS = {
  dairy: 'bg-sky-100 text-sky-700',
  nuts: 'bg-amber-100 text-amber-800',
  gluten: 'bg-orange-100 text-orange-700',
  eggs: 'bg-yellow-100 text-yellow-800',
  seafood: 'bg-cyan-100 text-cyan-800',
  soy: 'bg-lime-100 text-lime-800',
  sesame: 'bg-rose-100 text-rose-700'
};

export default function RecipeForm({ open, onClose, onSubmit, recipe, recipes = [], ingredients = [], inventory = [], inventoryLoaded = false, sites = [], isLoading, canEditLineWeights = false }) {
  const imageInputRef = useRef(null);
  const [formError, setFormError] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const [selectedIngredientsById, setSelectedIngredientsById] = useState({});
  const [numericValidation, setNumericValidation] = useState({});
  const [formData, setFormData] = useState({
    name: '',
    recipe_code: '',
    recipe_type: 'full',
    category: 'main_course',
    cuisine_type: '',
    description: '',
    prep_time_minutes: '',
    cook_time_minutes: '',
    servings: 1,
    portion_size_grams: null,
    batch_yield: 1,
    costing_method: 'average_cost',
    target_selling_price: null,
    instructions: '',
    image_url: '',
    ingredients: [],
    sub_recipes: [],
    declared_allergens: [],
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
        servings: Number(recipe.servings) || 1,
        portion_size_grams: Number(recipe.portion_size_grams) || null,
        batch_yield: Number(recipe.batch_yield) || 1,
        costing_method: recipe.costing_method || 'average_cost',
        target_selling_price: recipe.target_selling_price === null || recipe.target_selling_price === undefined
          ? null
          : Number(recipe.target_selling_price),
        instructions: recipe.instructions || '',
        image_url: recipe.image_url || '',
        ingredients: (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map((line) => ({
          ...line,
          quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : null,
          exempt_processing_aid: isExemptProcessingAid(line)
        })),
        sub_recipes: (Array.isArray(recipe.sub_recipes) ? recipe.sub_recipes : []).map((line) => ({
          ...line,
          quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : null
        })),
        allergens: Array.isArray(recipe.allergens) ? recipe.allergens : [],
        ...(Array.isArray(recipe.declared_allergens) ? { declared_allergens: recipe.declared_allergens } : {}),
        ...(Array.isArray(recipe.legacy_allergens) ? { legacy_allergens: recipe.legacy_allergens } : {}),
        nutrition_calculation_version: recipe.nutrition_calculation_version,
        is_active: recipe.is_active !== false,
        site_scope: recipe.site_scope || 'global',
        site_ids: Array.isArray(recipe.site_ids) ? recipe.site_ids : []
      });
    } else {
      setFormData({
        name: '',
        recipe_code: '',
        recipe_type: 'full',
        category: 'main_course',
        cuisine_type: '',
        description: '',
        prep_time_minutes: '',
        cook_time_minutes: '',
        servings: 1,
        portion_size_grams: null,
        batch_yield: 1,
        costing_method: 'average_cost',
        target_selling_price: null,
        instructions: '',
        image_url: '',
        ingredients: [],
        sub_recipes: [],
        declared_allergens: [],
        is_active: true,
        site_scope: 'global',
        site_ids: []
      });
    }
    setFormError('');
    setImageFile(null);
    setImagePreview(recipe?.image_url || '');
    setImageUploading(false);
    setSelectedIngredientsById({});
    setNumericValidation({});
  }, [recipe, open]);

  const ingredientCatalog = useMemo(() => {
    const scopedSiteIds = formData.site_scope === 'specific' ? new Set(formData.site_ids) : null;
    const stockByIngredient = new Map();
    const averageCostByIngredient = new Map();
    inventory.forEach((stock) => {
      if (!stock?.ingredient_id || (scopedSiteIds && !scopedSiteIds.has(stock.site_id))) return;
      const quantity = Number(stock.quantity) || 0;
      stockByIngredient.set(
        stock.ingredient_id,
        (stockByIngredient.get(stock.ingredient_id) || 0) + quantity
      );
      const rawUnitCost = stock.average_unit_cost ?? stock.unit_cost ?? stock.cost_per_unit;
      const unitCost = rawUnitCost === null || rawUnitCost === undefined || rawUnitCost === ''
        ? NaN
        : Number(rawUnitCost);
      if (quantity > 0 && Number.isFinite(unitCost) && unitCost >= 0) {
        const aggregate = averageCostByIngredient.get(stock.ingredient_id) || { quantity: 0, value: 0 };
        aggregate.quantity += quantity;
        aggregate.value += quantity * unitCost;
        averageCostByIngredient.set(stock.ingredient_id, aggregate);
      }
    });
    const merged = new Map(ingredients.map((ingredient) => {
      const averageAggregate = averageCostByIngredient.get(ingredient.id);
      const catalogCost = ingredient.cost_per_unit;
      return [ingredient.id, {
        ...ingredient,
        standard_cost: ingredient.standard_cost ?? catalogCost,
        last_cost: ingredient.last_cost ?? catalogCost,
        average_cost: averageAggregate?.quantity > 0
          ? averageAggregate.value / averageAggregate.quantity
          : ingredient.average_cost ?? catalogCost,
        ...(inventoryLoaded ? { current_stock: stockByIngredient.get(ingredient.id) || 0 } : {})
      }];
    }));
    Object.values(selectedIngredientsById).forEach((ingredient) => {
      // Search selections are a fallback; refreshed master and scoped inventory data take precedence.
      if (!ingredient?.id || merged.has(ingredient.id)) return;
      merged.set(ingredient.id, {
        ...ingredient,
        cost_per_unit: ingredient.cost_per_unit ?? ingredient.last_cost,
        standard_cost: ingredient.standard_cost ?? ingredient.cost_per_unit,
        last_cost: ingredient.last_cost ?? ingredient.cost_per_unit,
        average_cost: ingredient.average_cost ?? ingredient.cost_per_unit
      });
    });
    return [...merged.values()];
  }, [formData.site_ids, formData.site_scope, ingredients, inventory, inventoryLoaded, selectedIngredientsById]);

  const availableSubRecipes = useMemo(() => recipes.filter((recipeOption) => (
    recipeOption?.id
    && recipeOption.id !== recipe?.id
    && recipeOption.is_active !== false
    && !wouldCreateRecipeCycle(recipe?.id, recipeOption.id, recipes)
  )), [recipe?.id, recipes]);

  const calculatedNutrition = useMemo(
    () => calculateRecipeNutrition(
      { ...formData, id: recipe?.id || null },
      recipes,
      ingredientCatalog
    ),
    [formData, ingredientCatalog, recipe?.id, recipes]
  );

  const calculatedServingWeight = useMemo(
    () => calculateRecipeServingWeight(
      { ...formData, id: recipe?.id || null },
      recipes,
      ingredientCatalog
    ),
    [formData, ingredientCatalog, recipe?.id, recipes]
  );

  const ingredientCostRows = useMemo(() => formData.ingredients.map((line, index) => {
    const ingredient = ingredientCatalog.find((item) => item.id === line.ingredient_id) || null;
    const costing = ingredient
      ? calculateRecipeIngredientLineCost(line, ingredient, formData.costing_method)
      : { normalized_quantity: Number(line.quantity) || 0, item_cost: null, line_cost: null };
    const yieldOutput = ingredient
      ? calculateYieldOutputQuantity(line.quantity, ingredient)
      : null;
    const hasStock = ingredient && Object.prototype.hasOwnProperty.call(ingredient, 'current_stock');
    const currentStock = hasStock ? Number(ingredient.current_stock) || 0 : null;
    const normalizedUnit = normalizeIngredientUnit(line.unit || ingredient?.unit);
    const quantityValidation = standardizeDecimalValue(line.quantity, {
      unit: normalizedUnit,
      min: 0,
      allowZero: false,
      label: `Ingredient ${line.ingredient_name || 'quantity'}`
    });
    const validationError = numericValidation[`ingredient-${index}`]?.error
      || numericValidation[`weight-${index}`]?.error
      || (!line.ingredient_id ? 'Select an ingredient.' : '')
      || (!quantityValidation.valid ? quantityValidation.error : '')
      || (!SUPPORTED_RECIPE_INGREDIENT_UNITS.has(normalizedUnit) ? 'Choose a supported unit.' : '')
      || (costing.incompatible_unit ? 'Choose a unit compatible with this inventory item.' : '')
      || (costing.item_cost === null ? `${RECIPE_COSTING_METHODS[formData.costing_method]} is unavailable.` : '');
    const quantityInBaseUnit = Number(costing.normalized_quantity);
    return {
      ingredient,
      quantityInBaseUnit: Number.isFinite(quantityInBaseUnit) ? quantityInBaseUnit : null,
      unitCost: costing.item_cost,
      amount: costing.line_cost,
      yieldPercent: yieldOutput?.yield_percent ?? null,
      yieldedQuantity: yieldOutput?.yielded_quantity ?? null,
      currentStock,
      autoWeight: calculateFrozenProductionLineWeight({ planned_quantity: 1, unit: line.unit }, ingredient || {}).raw_weight_grams,
      definedWeight: getRecipeLineWeight(line),
      processingAid: isExemptProcessingAid(line),
      shortage: currentStock === null || !Number.isFinite(quantityInBaseUnit) ? null : Math.max(0, quantityInBaseUnit - currentStock),
      validationError
    };
  }), [formData.costing_method, formData.ingredients, ingredientCatalog, numericValidation]);

  const recipeCost = useMemo(() => calculateRecipeCostingSnapshot(
    { ...formData, id: recipe?.id || null },
    ingredientCatalog,
    recipes
  ), [formData, ingredientCatalog, recipe?.id, recipes]);

  const stockShortageCount = ingredientCostRows.filter((row) => Number(row.shortage) > 0).length;
  const knownStockLineCount = ingredientCostRows.filter((row) => row.currentStock !== null).length;

  const addIngredient = () => {
    setFormData((prev) => ({
      ...prev,
      ingredients: [...prev.ingredients, { ingredient_id: '', item_code: '', ingredient_name: '', quantity: null, unit: 'g', exempt_processing_aid: false }]
    }));
  };

  const removeIngredient = (index) => {
    setFormData((prev) => ({
      ...prev,
      ingredients: prev.ingredients.filter((_, i) => i !== index)
    }));
    setNumericValidation((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith('ingredient-') && !key.startsWith('weight-'))
    ));
  };

  const updateIngredient = (index, field, value) => {
    if (field === 'unit' || field === 'ingredient_id') {
      setNumericValidation((current) => ({ ...current, [`weight-${index}`]: {} }));
    }
    setFormData((prev) => {
      const nextIngredients = [...prev.ingredients];
      nextIngredients[index] = { ...nextIngredients[index], [field]: value };
      if (field === 'unit' || field === 'ingredient_id') {
        nextIngredients[index] = clearRecipeLineWeight(nextIngredients[index]);
      }

      if (field === 'ingredient_id') {
        const selected = ingredients.find((item) => item.id === value);
        if (selected) {
          nextIngredients[index].item_code = getItemCode(selected, '');
          nextIngredients[index].ingredient_name = selected.name;
          nextIngredients[index].unit = selected.unit || 'g';
        }
      }

      return { ...prev, ingredients: nextIngredients };
    });
  };

  const selectIngredient = (index, ingredient) => {
    if (!ingredient?.id) return;
    setNumericValidation((current) => ({ ...current, [`weight-${index}`]: {} }));
    setSelectedIngredientsById((current) => ({ ...current, [ingredient.id]: ingredient }));
    setFormData((current) => {
      const nextIngredients = [...current.ingredients];
      nextIngredients[index] = {
        ...clearRecipeLineWeight(nextIngredients[index]),
        ingredient_id: ingredient.id,
        item_code: getItemCode(ingredient, ''),
        ingredient_name: ingredient.name,
        unit: ingredient.unit || nextIngredients[index]?.unit || 'g'
      };
      return { ...current, ingredients: nextIngredients };
    });
  };

  const addSubRecipe = () => {
    setFormData((prev) => ({
      ...prev,
      sub_recipes: [
        ...prev.sub_recipes,
        { recipe_id: '', recipe_name: '', quantity: 1, unit: 'batch' }
      ]
    }));
  };

  const updateLineWeight = (index, value) => {
    if (!canEditLineWeights) return;
    setFormData((current) => ({
      ...current,
      ingredients: current.ingredients.map((line, lineIndex) => lineIndex !== index ? line : {
        ...clearRecipeLineWeight(line),
        ...(value === null ? {} : {
          weight_per_unit_grams: value,
          weight_unit: normalizeIngredientUnit(line.unit),
          weight_ingredient_id: line.ingredient_id
        })
      })
    }));
  };

  const removeSubRecipe = (index) => {
    setFormData((prev) => ({
      ...prev,
      sub_recipes: prev.sub_recipes.filter((_, itemIndex) => itemIndex !== index)
    }));
    setNumericValidation((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith('sub-recipe-'))
    ));
  };

  const updateSubRecipe = (index, field, value) => {
    setFormData((prev) => {
      const nextSubRecipes = [...prev.sub_recipes];
      nextSubRecipes[index] = { ...nextSubRecipes[index], [field]: value };
      if (field === 'recipe_id') {
        const selected = recipes.find((item) => item.id === value);
        nextSubRecipes[index].recipe_name = selected?.name || '';
      }
      return { ...prev, sub_recipes: nextSubRecipes };
    });
  };

  const handleImageChange = (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file) return;
    const validationError = validateRecipeImageFile(file);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImagePreview(String(reader.result || ''));
    reader.readAsDataURL(file);
    setImageFile(file);
    setFormData((current) => ({ ...current, image_url: '' }));
    setFormError('');
  };

  const handleImageUrlChange = (value) => {
    const nextValue = String(value || '').trimStart();
    const validationError = validateRecipeImageReference(nextValue);
    setImageFile(null);
    setFormData((current) => ({ ...current, image_url: nextValue }));
    setImagePreview(validationError ? '' : nextValue.trim());
    setFormError(validationError);
  };

  const resolveUploadedRecipeImageUrl = (uploadResult = {}) => (
    uploadResult.file_url || uploadResult.public_file_url || ''
  );

  const removeImage = () => {
    setImageFile(null);
    setImagePreview('');
    setFormData((current) => ({ ...current, image_url: '' }));
    setFormError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const weightError = Object.entries(numericValidation).find(([key, status]) => key.startsWith('weight-') && status.error);
    if (weightError) {
      setFormError(weightError[1].error);
      return;
    }
    const imageReferenceError = imageFile ? '' : validateRecipeImageReference(formData.image_url);
    if (imageReferenceError) {
      setFormError(imageReferenceError);
      return;
    }
    const numericResult = normalizeRecipeNumericFields(formData);
    if (numericResult.errors.length > 0) {
      setFormError(numericResult.errors[0]);
      return;
    }
    const normalizedForm = numericResult.recipe;
    const normalizedSubRecipes = normalizedForm.sub_recipes.map((line) => ({ ...line, unit: line.unit || 'batch' }));
    const compositionErrors = validateRecipeComposition(
      { ...normalizedForm, id: recipe?.id || null, sub_recipes: normalizedSubRecipes },
      recipes
    );
    if (compositionErrors.length > 0) {
      setFormError(compositionErrors[0]);
      return;
    }
    setFormError('');
    let imageUrl = String(formData.image_url || '').trim();
    if (imageFile) {
      try {
        setImageUploading(true);
        const uploadResult = await base44.integrations.Core.UploadRecipeImage({ file: imageFile });
        imageUrl = resolveUploadedRecipeImageUrl(uploadResult);
        setFormData((current) => ({ ...current, image_url: imageUrl }));
        setImagePreview(imageUrl);
      } catch (error) {
        setFormError(error.message || 'Recipe picture upload failed.');
        setImageUploading(false);
        return;
      }
      setImageUploading(false);
    }
    const finalCost = calculateRecipeCostingSnapshot(
      { ...normalizedForm, id: recipe?.id || null },
      ingredientCatalog,
      recipes
    );
    const submitData = {
      ...normalizedForm,
      image_url: imageUrl,
      prep_time_minutes: formData.prep_time_minutes ? parseInt(formData.prep_time_minutes, 10) : null,
      cook_time_minutes: formData.cook_time_minutes ? parseInt(formData.cook_time_minutes, 10) : null,
      ...calculatedNutrition,
      total_cost: finalCost.total_cost,
      cost_per_serving: finalCost.cost_per_serving,
      cost_per_100g: finalCost.cost_per_100g,
      total_recipe_weight_grams: finalCost.total_recipe_weight_grams,
      margin_per_serving: finalCost.margin_per_serving,
      food_cost_percent: finalCost.food_cost_percent,
      costing_updated_at: new Date().toISOString(),
      site_scope: formData.site_scope,
      site_ids: formData.site_scope === 'specific' ? formData.site_ids : [],
      ingredients: normalizedForm.ingredients,
      sub_recipes: normalizedSubRecipes
    };
    try {
      await onSubmit(submitData);
    } catch (error) {
      setFormError(error.message || 'Recipe could not be saved.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-[1600px] min-w-0 overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            {recipe ? 'Edit Recipe' : 'Create New Recipe'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="min-w-0 space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="md:col-span-2 xl:col-span-4">
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
              <Select value={formData.category || 'main_course'} onValueChange={(value) => setFormData({ ...formData, category: value })}>
                <SelectTrigger id="category" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECIPE_CATEGORIES.map((category) => (
                    <SelectItem key={category.value} value={category.value}>{category.label}</SelectItem>
                  ))}
                  {formData.category && !RECIPE_CATEGORIES.some((category) => category.value === formData.category) ? (
                    <SelectItem value={formData.category}>{formData.category.replace(/_/g, ' ')}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
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
              <StandardDecimalInput
                id="servings"
                value={formData.servings}
                unit="servings"
                precision={0}
                min={0}
                allowZero={false}
                allowEmpty={false}
                label="Servings"
                onValueChange={(value) => setFormData((current) => ({ ...current, servings: value }))}
                onValidationChange={(status) => setNumericValidation((current) => ({ ...current, servings: status }))}
                className="mt-1"
                required
              />
              {numericValidation.servings?.error ? <p className="mt-1 text-xs text-red-600">{numericValidation.servings.error}</p> : null}
            </div>

            <div>
              <Label htmlFor="portion_size_grams">Portion Size (g)</Label>
              <StandardDecimalInput
                id="portion_size_grams"
                value={formData.portion_size_grams}
                unit="g"
                min={0}
                allowZero={false}
                label="Portion size"
                onValueChange={(value) => setFormData((current) => ({ ...current, portion_size_grams: value }))}
                onValidationChange={(status) => setNumericValidation((current) => ({ ...current, portion_size_grams: status }))}
                className="mt-1"
                placeholder={calculatedServingWeight.is_complete ? formatRecipeQuantity(calculatedServingWeight.grams_per_serving, 'g') : 'e.g., 250'}
              />
              {numericValidation.portion_size_grams?.error ? <p className="mt-1 text-xs text-red-600">{numericValidation.portion_size_grams.error}</p> : null}
            </div>

            <div>
              <Label htmlFor="batch_yield">Batch Yield</Label>
              <StandardDecimalInput
                id="batch_yield"
                value={formData.batch_yield}
                unit="batch"
                min={0}
                allowZero={false}
                allowEmpty={false}
                label="Batch yield"
                onValueChange={(value) => setFormData((current) => ({ ...current, batch_yield: value }))}
                onValidationChange={(status) => setNumericValidation((current) => ({ ...current, batch_yield: status }))}
                className="mt-1"
              />
              {numericValidation.batch_yield?.error ? <p className="mt-1 text-xs text-red-600">{numericValidation.batch_yield.error}</p> : null}
            </div>

            <div>
              <Label>Costing Method</Label>
              <Select
                value={formData.costing_method}
                onValueChange={(value) => setFormData((current) => ({ ...current, costing_method: value }))}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(RECIPE_COSTING_METHODS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="target_selling_price">Target Selling Price (⃁ / serving)</Label>
              <StandardDecimalInput
                id="target_selling_price"
                value={formData.target_selling_price}
                precision={2}
                min={0}
                allowZero
                label="Target selling price"
                onValueChange={(value) => setFormData((current) => ({ ...current, target_selling_price: value }))}
                onValidationChange={(status) => setNumericValidation((current) => ({ ...current, target_selling_price: status }))}
                className="mt-1"
                placeholder="0.00"
              />
              {numericValidation.target_selling_price?.error ? <p className="mt-1 text-xs text-red-600">{numericValidation.target_selling_price.error}</p> : null}
            </div>

            <div className="md:col-span-2 xl:col-span-4">
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
            <div className="md:col-span-2 xl:col-span-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              Ingredient quantities are raw inputs. Expected production output applies each ingredient's yield, while costing and inventory issue remain based on the raw quantity.
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <ImagePlus className="h-5 w-5 text-emerald-600" />
                  <Label className="text-base font-semibold">Recipe Picture</Label>
                </div>
                <p className="mt-1 text-sm text-slate-500">Upload a recipe picture from this device. JPG, PNG, WebP, and GIF are supported up to 1 MB.</p>
              </div>
              {imagePreview ? (
                <Button type="button" variant="ghost" size="sm" onClick={removeImage} className="text-red-600 hover:bg-red-50 hover:text-red-700">
                  <X className="mr-1 h-4 w-4" /> Remove
                </Button>
              ) : null}
            </div>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={handleImageChange}
            />
            {imagePreview ? (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="group relative block h-56 w-full overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                <img src={imagePreview} alt="Recipe preview" className="h-full w-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 bg-slate-950/70 px-3 py-2 text-sm font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                  Click to replace picture
                </span>
              </button>
            ) : (
              <Button type="button" variant="outline" onClick={() => imageInputRef.current?.click()} className="h-32 w-full border-dashed bg-white">
                <ImagePlus className="mr-2 h-5 w-5" /> Choose Recipe Picture
              </Button>
            )}
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <Label htmlFor="recipe_image_url">Optional HTTPS image path</Label>
              <Input
                id="recipe_image_url"
                type="text"
                inputMode="url"
                value={formData.image_url}
                onChange={(event) => handleImageUrlChange(event.target.value)}
                placeholder="https://images.example.com/recipes/shrimp-curry.jpg"
                className="mt-1 bg-white"
              />
              <p className="mt-1 text-xs text-slate-500">Direct upload is recommended. Public HTTPS links remain available for already hosted images.</p>
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

            <p className="mb-3 text-sm text-slate-600">
              Weight per unit is the raw weight in grams of one selected unit (one piece, EA, or PAK), not the entire line.
              It scales with quantity and production covers without changing the ingredient master.
              {canEditLineWeights ? ' Enter a verified weight where conversion is missing; leave blank to use the ingredient settings.' : ' Only administrators can define or change this weight.'}
              {' '}Mark Exempt Processing Aid for items consumed during preparation but not included in the finished recipe weight.
            </p>
            <div className="min-w-0 max-w-full overflow-x-auto pb-2">
            <div className="space-y-3 xl:min-w-[1700px]">
              {formData.ingredients.length > 0 ? (
                <div className="hidden grid-cols-[100px_minmax(210px,1.5fr)_100px_80px_140px_72px_110px_110px_110px_120px_140px_160px_42px] gap-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 xl:grid">
                  <span>Item Code</span>
                  <span>Item Name</span>
                  <span>Raw Quantity</span>
                  <span>Unit</span>
                  <span>Weight per unit (g)</span>
                  <span>Yield</span>
                  <span>Expected Output</span>
                  <span>Item Cost</span>
                  <span>Line Cost</span>
                  <span>Stock Impact</span>
                  <span>Validation</span>
                  <span>Processing Aid</span>
                  <span aria-hidden="true" />
                </div>
              ) : null}
              {formData.ingredients.map((ingredientLine, index) => {
                const costRow = ingredientCostRows[index];
                const numericStatus = numericValidation[`ingredient-${index}`] || {};
                const selectedIngredient = costRow?.ingredient || (
                  ingredientLine.ingredient_id
                    ? {
                        id: ingredientLine.ingredient_id,
                        item_code: ingredientLine.item_code,
                        name: ingredientLine.ingredient_name || 'Selected ingredient',
                        unit: ingredientLine.unit
                      }
                    : null
                );
                return (
                  <div key={`${ingredientLine.ingredient_id || 'new'}-${index}`} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-2 xl:grid-cols-[100px_minmax(210px,1.5fr)_100px_80px_140px_72px_110px_110px_110px_120px_140px_160px_42px]">
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Item Code</p>
                    <div className="flex h-10 items-center rounded-md border border-slate-200 bg-white px-2 font-mono text-xs font-medium text-slate-700">
                      {getItemCode(costRow?.ingredient || selectedIngredient || ingredientLine)}
                    </div>
                  </div>
                  <div className="md:col-span-2 xl:col-span-1">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Item Name</p>
                    <IngredientSearchCombobox
                      value={ingredientLine.ingredient_id}
                      selectedIngredient={selectedIngredient}
                      siteId={formData.site_scope === 'specific' ? formData.site_ids[0] || '' : ''}
                      onValueChange={(_value, ingredient) => selectIngredient(index, ingredient)}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Raw Quantity</p>
                    <StandardDecimalInput
                      value={ingredientLine.quantity}
                      unit={ingredientLine.unit}
                      min={0}
                      allowZero={false}
                      label={`${ingredientLine.ingredient_name || 'Ingredient'} quantity`}
                      onValueChange={(value) => updateIngredient(index, 'quantity', value)}
                      onValidationChange={(status) => setNumericValidation((current) => ({ ...current, [`ingredient-${index}`]: status }))}
                      className={cn(costRow?.validationError && 'border-red-300 focus-visible:ring-red-200')}
                      placeholder="Qty"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Unit</p>
                    <Select
                      value={ingredientLine.unit}
                      onValueChange={(value) => updateIngredient(index, 'unit', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RECIPE_INGREDIENT_UNITS.map((unit) => (
                          <SelectItem key={unit.value} value={unit.value}>{unit.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Weight per unit (g)</p>
                    <StandardDecimalInput
                      key={`${ingredientLine.ingredient_id}-${ingredientLine.unit}-weight`}
                      value={costRow?.definedWeight}
                      unit="g"
                      precision={4}
                      max={1000000000}
                      allowZero={false}
                      allowEmpty
                      disabled={!canEditLineWeights || !ingredientLine.ingredient_id || ['g', 'kg'].includes(normalizeIngredientUnit(ingredientLine.unit))}
                      label={`Raw weight in grams per ${ingredientLine.unit || 'unit'} of ${ingredientLine.ingredient_name || 'ingredient'}`}
                      onValueChange={(value) => updateLineWeight(index, value)}
                      onValidationChange={(status) => setNumericValidation((current) => ({ ...current, [`weight-${index}`]: status }))}
                      placeholder={costRow?.autoWeight == null ? 'Not defined' : `${formatRecipeQuantity(costRow.autoWeight, 'g')} auto`}
                      className="bg-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-600 disabled:opacity-100"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      {costRow?.definedWeight != null ? `g per 1 ${ingredientLine.unit}` : costRow?.autoWeight == null ? 'Admin weight needed' : 'From ingredient settings'}
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Yield</p>
                    <div className="flex h-10 items-center rounded-md border border-slate-200 bg-white px-2 text-sm font-medium text-slate-700">
                      {costRow?.yieldPercent == null ? '—' : `${formatNumber(costRow.yieldPercent, 2)}%`}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Expected Output</p>
                    <div className={cn(
                      'flex h-10 items-center rounded-md border px-2 text-sm font-semibold',
                      costRow?.processingAid
                        ? 'border-amber-200 bg-amber-50 text-amber-800'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    )}>
                      {costRow?.processingAid
                        ? 'Excluded'
                        : costRow?.yieldedQuantity == null
                        ? '—'
                        : `${formatRecipeQuantity(costRow.yieldedQuantity, ingredientLine.unit)} ${ingredientLine.unit || ''}`}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Item Cost</p>
                    <div className="flex h-10 items-center rounded-md border border-slate-200 bg-white px-2 text-sm font-medium text-slate-700">
                      {costRow?.unitCost == null ? '—' : formatCurrency(costRow.unitCost)}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">per {costRow?.ingredient?.unit || ingredientLine.unit}</p>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Line Cost</p>
                    <div className="flex h-10 items-center rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-900">
                      {costRow?.amount == null ? '—' : formatCurrency(costRow.amount)}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Stock Impact</p>
                    <div className={cn(
                      'flex h-10 items-center rounded-md border bg-white px-2 text-sm font-medium',
                      Number(costRow?.shortage) > 0 ? 'border-red-300 text-red-700' : 'border-slate-200 text-slate-700'
                    )}>
                      {costRow?.ingredient
                        ? `↓ ${formatRecipeQuantity(costRow.quantityInBaseUnit, costRow.ingredient.unit)} ${costRow.ingredient.unit || ''}`
                        : '—'}
                    </div>
                    {costRow?.currentStock !== null && typeof costRow?.currentStock !== 'undefined' ? (
                      <p className={cn('mt-1 text-[11px]', Number(costRow.shortage) > 0 ? 'font-medium text-red-600' : 'text-slate-500')}>
                        {Number(costRow.shortage) > 0
                          ? `Short ${formatRecipeQuantity(costRow.shortage, costRow.ingredient?.unit)} ${costRow.ingredient?.unit || ''}`
                          : `${formatRecipeQuantity(costRow.currentStock, costRow.ingredient?.unit)} ${costRow.ingredient?.unit || ''} available`}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Validation</p>
                    <div className={cn(
                      'flex min-h-10 items-center gap-1.5 rounded-md border bg-white px-2 text-xs font-medium',
                      costRow?.validationError || Number(costRow?.shortage) > 0
                        ? 'border-red-200 text-red-700'
                        : numericStatus.notice
                          ? 'border-amber-200 text-amber-700'
                          : 'border-emerald-200 text-emerald-700'
                    )}>
                      {costRow?.validationError || Number(costRow?.shortage) > 0 ? <CircleAlert className="h-4 w-4 shrink-0" /> : <CircleCheck className="h-4 w-4 shrink-0" />}
                      <span className="line-clamp-2">
                        {costRow?.validationError || (Number(costRow?.shortage) > 0 ? 'Insufficient stock' : numericStatus.notice || 'Valid')}
                      </span>
                    </div>
                  </div>
                  <div className="md:col-span-2 xl:col-span-1">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 xl:hidden">Processing Aid</p>
                    <label
                      htmlFor={`exempt-processing-aid-${index}`}
                      className={cn(
                        'flex min-h-10 cursor-pointer items-center gap-2 rounded-md border bg-white px-2 text-xs font-medium',
                        costRow?.processingAid
                          ? 'border-amber-200 text-amber-700'
                          : 'border-slate-200 text-slate-600'
                      )}
                    >
                      <Checkbox
                        id={`exempt-processing-aid-${index}`}
                        checked={costRow?.processingAid === true}
                        onCheckedChange={(checked) => updateIngredient(index, 'exempt_processing_aid', checked === true)}
                        className="data-[state=checked]:bg-amber-600 data-[state=checked]:text-white"
                      />
                      <span>Exempt Processing Aid.</span>
                    </label>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeIngredient(index)}
                    className="text-red-500 hover:bg-red-50 hover:text-red-600 xl:mt-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  </div>
                );
              })}

              {formData.ingredients.length === 0 ? (
                <p className="py-4 text-center text-slate-500">
                  No ingredients added. Click "Add Ingredient" to start.
                </p>
              ) : null}
            </div>

            </div>
            {formData.ingredients.length > 0 || formData.sub_recipes.length > 0 ? (
              <div className="mt-4 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-slate-900">Live Cost Summary</p>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                    <RefreshCw className="h-3.5 w-3.5" /> Updating in real time
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-emerald-200 bg-white p-3 md:grid-cols-3 xl:grid-cols-6">
                  <div>
                    <p className="text-xs text-slate-500">Total Recipe Cost</p>
                    <p className="font-semibold text-slate-900">{recipeCost.has_cost ? formatCurrency(recipeCost.total_cost) : 'Missing cost'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Cost per Serving</p>
                    <p className="font-semibold text-slate-900">{recipeCost.has_cost ? formatCurrency(recipeCost.cost_per_serving) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Cost per 100 g</p>
                    <p className="font-semibold text-slate-900">{recipeCost.cost_per_100g == null ? '—' : formatCurrency(recipeCost.cost_per_100g)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Target / Serving</p>
                    <p className="font-semibold text-slate-900">{recipeCost.target_selling_price == null ? '—' : formatCurrency(recipeCost.target_selling_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Margin</p>
                    <p className={cn('font-semibold', Number(recipeCost.margin_per_serving) < 0 ? 'text-red-700' : 'text-emerald-700')}>
                      {recipeCost.margin_per_serving == null ? '—' : formatCurrency(recipeCost.margin_per_serving)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Food Cost %</p>
                    <p className="font-semibold text-slate-900">{recipeCost.food_cost_percent == null ? '—' : `${formatNumber(recipeCost.food_cost_percent, 2)}%`}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
                  <span>{formData.ingredients.length} direct ingredient line{formData.ingredients.length === 1 ? '' : 's'}</span>
                  <span>{recipeCost.missing_cost_count ? `${recipeCost.missing_cost_count} missing cost${recipeCost.missing_cost_count === 1 ? '' : 's'}` : 'All item costs available'}</span>
                  <span className={cn(stockShortageCount ? 'font-medium text-red-700' : knownStockLineCount ? 'text-emerald-700' : '')}>
                    {stockShortageCount
                      ? `${stockShortageCount} stock shortage${stockShortageCount === 1 ? '' : 's'}`
                      : knownStockLineCount ? 'No known stock shortage' : 'Stock availability pending'}
                  </span>
                </div>
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
                  Raw recipe weight: {recipeCost.total_raw_recipe_weight_grams == null ? 'Not available' : `${formatRecipeQuantity(recipeCost.total_raw_recipe_weight_grams, 'g')} g`}
                  {' → '}
                  Expected yielded weight: {recipeCost.expected_yield_weight_grams == null ? 'Not available' : `${formatRecipeQuantity(recipeCost.expected_yield_weight_grams, 'g')} g`}
                </div>
                <div className="flex items-center gap-2">
                  <Flame className="h-5 w-5 text-orange-500" />
                  <span className="font-medium text-orange-900">Nutrition Summary</span>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <div>
                    <p className="text-sm text-orange-700">Calories / serving</p>
                    <p className="text-2xl font-bold text-orange-900">{calculatedNutrition.calories_per_serving ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Protein / serving</p>
                    <p className="text-xl font-semibold text-orange-900">{calculatedNutrition.protein_per_serving ?? '—'} g</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Carbs / serving</p>
                    <p className="text-xl font-semibold text-orange-900">{calculatedNutrition.carbs_per_serving ?? '—'} g</p>
                  </div>
                  <div>
                    <p className="text-sm text-orange-700">Fat / serving</p>
                    <p className="text-xl font-semibold text-orange-900">{calculatedNutrition.fat_per_serving ?? '—'} g</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <div>
                    <p className="text-sm text-slate-600">Sodium / serving</p>
                    <p className="font-semibold text-slate-900">{calculatedNutrition.sodium_per_serving ?? '—'} mg</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Sugar / serving</p>
                    <p className="font-semibold text-slate-900">{calculatedNutrition.sugar_per_serving ?? '—'} g</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Total calories</p>
                    <p className="font-semibold text-slate-900">{calculatedNutrition.total_calories ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-600">Servings</p>
                    <p className="font-semibold text-slate-900">
                      {Math.max(1, Number(formData.servings) || 1)}
                      {' · '}
                      {calculatedServingWeight.is_complete
                        ? formatRecipeQuantity(calculatedServingWeight.grams_per_serving, 'g')
                        : '—'} g each
                    </p>
                  </div>
                </div>
                {!calculatedNutrition.nutrition_complete && (
                  <p className="text-sm text-amber-800">
                    Nutrition incomplete — awaiting ingredient nutrition or weight data.
                    {' '}{calculatedNutrition.nutrition_warnings.slice(0, 3).join(' ')}
                    {calculatedNutrition.nutrition_warnings.length > 3 && ` +${calculatedNutrition.nutrition_warnings.length - 3} more source data gaps.`}
                  </p>
                )}
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
                  ) : calculatedNutrition.allergens_complete ? (
                    <p className="text-sm text-slate-500">No allergens declared in the ingredient or recipe data.</p>
                  ) : null}
                  {!calculatedNutrition.allergens_complete && (
                    <p className="mt-2 text-sm text-amber-800">
                      Allergen information incomplete — awaiting ingredient allergen data.
                      {' '}{calculatedNutrition.allergens_warnings.slice(0, 3).join(' ')}
                      {calculatedNutrition.allergens_warnings.length > 3 && ` +${calculatedNutrition.allergens_warnings.length - 3} more source data gaps.`}
                    </p>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <GitBranch className="h-5 w-5 text-indigo-600" />
                  <Label className="text-base font-semibold text-indigo-950">Sub-recipes</Label>
                </div>
                <p className="mt-1 text-sm text-indigo-700">
                  Reuse another recipe as a component. Its raw ingredients are expanded automatically for cost, nutrition, production, and procurement.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addSubRecipe} className="border-indigo-200 bg-white">
                <Plus className="mr-1 h-4 w-4" />
                Add Sub-recipe
              </Button>
            </div>

            <div className="space-y-3">
              {formData.sub_recipes.map((subRecipeLine, index) => (
                <div key={`${subRecipeLine.recipe_id || 'new'}-${index}`} className="grid grid-cols-1 gap-3 rounded-lg border border-indigo-100 bg-white p-3 md:grid-cols-[1fr_120px_140px_48px]">
                  <Select
                    value={subRecipeLine.recipe_id}
                    onValueChange={(value) => updateSubRecipe(index, 'recipe_id', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select another recipe" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSubRecipes.map((recipeOption) => (
                        <SelectItem key={recipeOption.id} value={recipeOption.id}>
                          {recipeOption.name} ({recipeOption.servings || 1} servings)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div>
                    <StandardDecimalInput
                      value={subRecipeLine.quantity}
                      unit={subRecipeLine.unit || 'batch'}
                      min={0}
                      allowZero={false}
                      label={`${subRecipeLine.recipe_name || 'Sub-recipe'} quantity`}
                      onValueChange={(value) => updateSubRecipe(index, 'quantity', value)}
                      onValidationChange={(status) => setNumericValidation((current) => ({ ...current, [`sub-recipe-${index}`]: status }))}
                      placeholder="Qty"
                    />
                    {numericValidation[`sub-recipe-${index}`]?.error ? (
                      <p className="mt-1 text-xs text-red-600">{numericValidation[`sub-recipe-${index}`].error}</p>
                    ) : null}
                  </div>
                  <Select
                    value={subRecipeLine.unit || 'batch'}
                    onValueChange={(value) => updateSubRecipe(index, 'unit', value)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="batch">Batch(es)</SelectItem>
                      <SelectItem value="servings">Serving(s)</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSubRecipe(index)}
                    className="text-red-500 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {formData.sub_recipes.length === 0 ? (
                <p className="py-3 text-center text-sm text-indigo-600">No sub-recipes added.</p>
              ) : null}
            </div>
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
            {formError ? (
              <p className="mr-auto text-sm font-medium text-red-600">{formError}</p>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={isLoading || imageUploading}
            >
              {imageUploading ? 'Uploading picture...' : isLoading ? 'Saving...' : (recipe ? 'Update Recipe' : 'Create Recipe')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
