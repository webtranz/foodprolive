import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreVertical, Pencil, Trash2, Clock, Users, Flame } from 'lucide-react';

const CATEGORY_COLORS = {
  breakfast: 'bg-amber-100 text-amber-700',
  lunch: 'bg-emerald-100 text-emerald-700',
  dinner: 'bg-blue-100 text-blue-700',
  snack: 'bg-purple-100 text-purple-700',
  dessert: 'bg-pink-100 text-pink-700',
  beverage: 'bg-cyan-100 text-cyan-700',
  side: 'bg-slate-100 text-slate-700'
};

export default function RecipeCard({ recipe, onEdit, onDelete }) {
  const totalTime = (recipe.prep_time_minutes || 0) + (recipe.cook_time_minutes || 0);

  return (
    <Card className="border-slate-100 shadow-sm hover:shadow-md transition-all duration-300 group overflow-hidden">
      {recipe.image_url && (
        <div className="h-40 overflow-hidden">
          <img 
            src={recipe.image_url} 
            alt={recipe.name}
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
            <Badge className={`${CATEGORY_COLORS[recipe.category]} text-xs mt-1`}>
              {recipe.category}
            </Badge>
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
              <DropdownMenuItem 
                onClick={() => onDelete(recipe)}
                className="text-red-600"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {recipe.description && (
          <p className="text-sm text-slate-500 line-clamp-2 mb-3">
            {recipe.description}
          </p>
        )}

        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1 text-slate-600">
            <Users className="w-4 h-4 text-slate-400" />
            <span>{recipe.servings} servings</span>
          </div>
          
          {totalTime > 0 && (
            <div className="flex items-center gap-1 text-slate-600">
              <Clock className="w-4 h-4 text-slate-400" />
              <span>{totalTime} min</span>
            </div>
          )}
          
          {recipe.calories_per_serving > 0 && (
            <div className="flex items-center gap-1 text-orange-600">
              <Flame className="w-4 h-4" />
              <span>{recipe.calories_per_serving} cal</span>
            </div>
          )}
        </div>

        {recipe.ingredients && recipe.ingredients.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-xs text-slate-400 mb-1">{recipe.ingredients.length} ingredients</p>
            <p className="text-xs text-slate-500 truncate">
              {recipe.ingredients.map(i => i.ingredient_name).join(', ')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}