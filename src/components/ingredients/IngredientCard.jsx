import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreVertical, Pencil, Trash2, Flame, Scale, TrendingDown } from 'lucide-react';

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

export default function IngredientCard({ ingredient, onEdit, onDelete }) {
  return (
    <Card className="border-slate-100 shadow-sm hover:shadow-md transition-all duration-300 group">
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 group-hover:text-emerald-600 transition-colors">
              {ingredient.name}
            </h3>
            <Badge className={`${CATEGORY_COLORS[ingredient.category]} text-xs mt-1`}>
              {ingredient.category?.replace(/_/g, ' ')}
            </Badge>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(ingredient)}>
                <Pencil className="w-4 h-4 mr-2" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => onDelete(ingredient)}
                className="text-red-600"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              <span className="text-slate-600">${ingredient.cost_per_unit}</span>
              <span className="text-slate-400">per {ingredient.unit}</span>
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
      </CardContent>
    </Card>
  );
}