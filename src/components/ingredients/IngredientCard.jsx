import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreVertical, Pencil, Trash2, Flame, Scale, TrendingDown, Droplets, Candy, ShieldAlert } from 'lucide-react';
import { getItemCode } from '../../../shared/itemCode.js';
import { formatCurrency } from '@/lib/currency';
import { normalizeSourceName } from '../../../shared/sourceNames.js';

const CATEGORY_COLORS = {
  proteins: 'bg-red-100 text-red-700',
  vegetables: 'bg-green-100 text-green-700',
  fruits: 'bg-orange-100 text-orange-700',
  grains: 'bg-amber-100 text-amber-700',
  dairy: 'bg-blue-100 text-blue-700',
  oils: 'bg-yellow-100 text-yellow-700',
  spices: 'bg-purple-100 text-purple-700',
  condiments: 'bg-pink-100 text-pink-700',
  beverages: 'bg-cyan-100 text-cyan-700',
  other: 'bg-slate-100 text-slate-700'
};

const formatQuantity = (value) => Number(value || 0).toLocaleString(undefined, {
  maximumFractionDigits: 3
});

export default function IngredientCard({ ingredient, onEdit, onDelete }) {
  const allergens = Array.isArray(ingredient.allergens) ? ingredient.allergens : [];
  const stock = ingredient.stock_summary || {};

  return (
    <Card className="border-slate-100 shadow-sm hover:shadow-md transition-all duration-300 group">
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {getItemCode(ingredient)}
            </p>
            <h3 className="font-semibold text-slate-900 group-hover:text-emerald-600 transition-colors">
              {ingredient.name}
            </h3>
            <Badge className={`${CATEGORY_COLORS[ingredient.category]} text-xs mt-1`}>
              {ingredient.category?.replace(/_/g, ' ')}
            </Badge>
            <Badge variant="outline" className="ml-2 mt-1 border-slate-200 bg-white text-xs text-slate-700">
              {normalizeSourceName(ingredient.source_name)}
            </Badge>
          </div>
          {typeof onEdit === 'function' || typeof onDelete === 'function' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {typeof onEdit === 'function' ? (
                  <DropdownMenuItem onClick={() => onEdit(ingredient)}>
                    <Pencil className="w-4 h-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {typeof onDelete === 'function' ? (
                  <DropdownMenuItem
                    onClick={() => onDelete(ingredient)}
                    className="text-red-600"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Flame className="w-4 h-4 text-orange-500" />
            <span className="text-slate-600">{ingredient.calories_per_100g || 0}</span>
            <span className="text-slate-400">cal/100g</span>
          </div>

          {ingredient.cooking_yield_percent && (
            <div className="flex items-center gap-2 text-sm">
              <TrendingDown className="w-4 h-4 text-blue-500" />
              <span className="text-slate-600">{ingredient.cooking_yield_percent}%</span>
              <span className="text-slate-400">yield</span>
            </div>
          )}

          {ingredient.cost_per_unit && (
            <div className="flex items-center gap-2 text-sm">
              <Scale className="w-4 h-4 text-emerald-500" />
              <span className="text-slate-600">{formatCurrency(ingredient.cost_per_unit)}</span>
              <span className="text-slate-400">per {ingredient.unit}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-2 text-xs">
            <div>
              <p className="font-medium text-slate-900">{formatQuantity(stock.on_hand_quantity)}</p>
              <p className="text-slate-500">on hand {stock.unit || ingredient.unit || ''}</p>
            </div>
            <div>
              <p className="font-medium text-cyan-800">{formatQuantity(stock.available_quantity)}</p>
              <p className="text-slate-500">available {stock.unit || ingredient.unit || ''}</p>
            </div>
          </div>

          {(ingredient.sodium_per_100g || ingredient.sugar_per_100g) && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <Droplets className="w-4 h-4 text-cyan-600" />
                <span>{ingredient.sodium_per_100g || 0} mg sodium</span>
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Candy className="w-4 h-4 text-pink-500" />
                <span>{ingredient.sugar_per_100g || 0} g sugar</span>
              </div>
            </div>
          )}
        </div>

        {(ingredient.protein_per_100g || ingredient.carbs_per_100g || ingredient.fat_per_100g) && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <div className="flex justify-between text-xs text-slate-500">
              <span>P: {ingredient.protein_per_100g || 0}g</span>
              <span>C: {ingredient.carbs_per_100g || 0}g</span>
              <span>F: {ingredient.fat_per_100g || 0}g</span>
            </div>
          </div>
        )}

        {allergens.length > 0 && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-700">
              <ShieldAlert className="h-3.5 w-3.5" />
              Allergen tags
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allergens.map((allergen) => (
                <Badge key={allergen} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                  {allergen}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
