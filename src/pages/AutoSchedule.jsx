import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { expandRecipeIngredients } from '../../shared/recipeComposition.js';
import { calculateYieldAdjustedQuantity } from '../../shared/ingredientYield.js';
import { calculateIngredientCost, convertIngredientQuantity } from '../../shared/ingredientUnits.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Calendar, Zap, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { format, addDays, parseISO } from 'date-fns';
import { getItemCodeFromRecords } from '../../shared/itemCode.js';

export default function AutoSchedule() {
  const [selectedSite, setSelectedSite] = useState('');
  const [forecastDays, setForecastDays] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [schedule, setSchedule] = useState(null);

  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.inventory.getStockOnHand()
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const ingredientMap = useMemo(
    () => new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients]
  );

  const { data: menuPlans = [] } = useQuery({
    queryKey: ['menuPlans'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 50)
  });

  // Real-time inventory updates
  useEffect(() => {
    const unsubscribe = base44.entities.Inventory.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      if (schedule) {
        // Regenerate schedule if there's a significant inventory change
        generateSchedule();
      }
    });
    return unsubscribe;
  }, [schedule, queryClient]);

  const siteInventory = useMemo(() => {
    return inventory.filter(i => !selectedSite || i.site_id === selectedSite);
  }, [inventory, selectedSite]);

  const expiringIngredients = useMemo(() => {
    const today = new Date();
    const threshold = addDays(today, 7);
    
    return siteInventory.filter(i => {
      if (!i.expiry_date) return false;
      const expiryDate = parseISO(i.expiry_date);
      return expiryDate <= threshold && i.quantity > 0;
    }).map(i => ({
      ...i,
      item_code: getItemCodeFromRecords([ingredientMap.get(i.ingredient_id), i]),
      daysUntilExpiry: Math.ceil((parseISO(i.expiry_date) - today) / (1000 * 60 * 60 * 24))
    })).sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  }, [ingredientMap, siteInventory]);

  const lowStockItems = useMemo(() => {
    return siteInventory.filter(i => 
      i.status === 'low_stock' || i.status === 'out_of_stock'
    ).map((item) => ({
      ...item,
      item_code: getItemCodeFromRecords([ingredientMap.get(item.ingredient_id), item])
    }));
  }, [ingredientMap, siteInventory]);

  const createProductionMutation = useMutation({
    mutationFn: (productionData) => Promise.all(
      productionData.map((production) => base44.entities.Production.create(production))
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
    }
  });

  const generateSchedule = async () => {
    if (!selectedSite) return;
    
    setGenerating(true);
    try {
      const site = sites.find(s => s.id === selectedSite);
      
      // Get upcoming menu plans for this site
      const upcomingMenus = menuPlans
        .filter(m => m.site_id === selectedSite)
        .slice(0, forecastDays);

      // Build context for AI
      const inventoryContext = siteInventory.map(i => {
        const ing = ingredients.find(ing => ing.id === i.ingredient_id);
        return {
          item_code: getItemCodeFromRecords([ing, i]),
          name: i.ingredient_name,
          quantity: i.quantity,
          unit: i.unit,
          status: i.status,
          expiry_date: i.expiry_date,
          min_stock_level: i.min_stock_level
        };
      });

      const recipesContext = recipes.map(r => ({
        id: r.id,
        name: r.name,
        cuisine_type: r.cuisine_type,
        category: r.category,
        servings: r.servings,
        ingredients: expandRecipeIngredients(r, recipes, ingredients, { aggregate: true }).ingredients,
        sub_recipes: r.sub_recipes || []
      }));

      const prompt = `You are a production planning expert. Create an optimized production schedule.

Site: ${site.name}
Capacity: ${site.capacity} servings/day
Forecast Period: ${forecastDays} days

Current Inventory Status:
${inventoryContext.slice(0, 20).map(i => `- ${i.item_code} ${i.name}: ${i.quantity} ${i.unit} (${i.status})${i.expiry_date ? ` - expires: ${i.expiry_date}` : ''}`).join('\n')}

Priority Ingredients (MUST USE - Expiring Soon):
${expiringIngredients.map(i => `- ${i.item_code} ${i.ingredient_name}: expires in ${i.daysUntilExpiry} days, quantity: ${i.quantity} ${i.unit}`).join('\n') || 'None'}

Low Stock Warnings:
${lowStockItems.map(i => `- ${i.item_code} ${i.ingredient_name}: ${i.quantity} ${i.unit}`).join('\n') || 'None'}

Available Recipes:
${recipesContext.slice(0, 15).map(r => `- ${r.name} (${r.cuisine_type}, ${r.category}) - serves ${r.servings}`).join('\n')}

Upcoming Menu Plans:
${upcomingMenus.map(m => `Date ${m.plan_date}: ${m.meals?.map(meal => meal.recipe_name).join(', ') || 'No meals planned'}`).join('\n') || 'No planned menus'}

Requirements:
1. PRIORITY: Use recipes that consume expiring ingredients first
2. Respect daily capacity limit of ${site.capacity} servings
3. Avoid recipes with low-stock or out-of-stock ingredients
4. Balance meal types (breakfast, lunch, dinner)
5. Consider menu forecasts if available
6. Suggest ${forecastDays} days of production
7. For each day, suggest 3-4 production items

Provide production schedule in JSON format:`;

      const aiResponse = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            schedule: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  productions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        recipe_name: { type: "string" },
                        meal_type: { type: "string" },
                        target_servings: { type: "number" },
                        priority: { type: "string" },
                        reasoning: { type: "string" }
                      }
                    }
                  },
                  total_servings: { type: "number" },
                  capacity_utilization: { type: "number" }
                }
              }
            },
            warnings: {
              type: "array",
              items: { type: "string" }
            },
            optimization_notes: { type: "string" }
          }
        }
      });

      // Match recipes with IDs
      const enrichedSchedule = {
        ...aiResponse,
        schedule: aiResponse.schedule.map(day => ({
          ...day,
          productions: day.productions.map(prod => {
            const recipe = recipes.find(r => 
              r.name.toLowerCase().includes(prod.recipe_name.toLowerCase()) ||
              prod.recipe_name.toLowerCase().includes(r.name.toLowerCase())
            );
            return {
              ...prod,
              recipe_id: recipe?.id,
              recipe: recipe
            };
          })
        }))
      };

      setSchedule(enrichedSchedule);
    } catch (err) {
      console.error('Schedule generation error:', err);
    } finally {
      setGenerating(false);
    }
  };

  const implementSchedule = async () => {
    if (!schedule || !selectedSite) return;

    const productionsToCreate = [];
    const site = sites.find(s => s.id === selectedSite);

    schedule.schedule.forEach(day => {
      day.productions.forEach(prod => {
        if (prod.recipe_id) {
          const recipe = prod.recipe || recipes.find((candidate) => candidate.id === prod.recipe_id);
          const targetServings = Number(prod.target_servings) || 0;
          const multiplier = targetServings / Math.max(1, Number(recipe?.servings) || 1);
          const expanded = expandRecipeIngredients(
            recipe,
            recipes,
            ingredients,
            { multiplier, aggregate: true }
          ).ingredients;
          const productionIngredients = expanded.map((line) => {
            const ingredient = ingredients.find((candidate) => candidate.id === line.ingredient_id) || {};
            const unit = ingredient.unit || line.unit || 'unit';
            const yieldAdjustment = calculateYieldAdjustedQuantity(line.quantity, ingredient);
            const netQuantity = convertIngredientQuantity(line.quantity, line.unit || unit, unit, ingredient);
            const rawQuantity = convertIngredientQuantity(
              yieldAdjustment.required_raw_quantity,
              line.unit || unit,
              unit,
              ingredient
            );
            const unitCost = Number(
              ingredient.cost_per_unit ?? ingredient.last_cost ?? ingredient.average_cost ?? 0
            ) || 0;
            return {
              item_code: getItemCodeFromRecords([ingredient, line]),
              ingredient_id: line.ingredient_id,
              ingredient_name: ingredient.name || line.ingredient_name,
              net_quantity: Number(netQuantity.toFixed(4)),
              planned_quantity: Number(rawQuantity.toFixed(4)),
              required_quantity: Number(rawQuantity.toFixed(4)),
              yield_adjusted_quantity: Number(rawQuantity.toFixed(4)),
              yield_multiplier: Number(yieldAdjustment.yield_multiplier.toFixed(6)),
              yield_percent: Number(yieldAdjustment.yield_percent.toFixed(2)),
              yield_source: yieldAdjustment.yield_source,
              unit,
              unit_cost: unitCost,
              estimated_cost: Number(calculateIngredientCost(
                yieldAdjustment.required_raw_quantity,
                line.unit || unit,
                ingredient,
                unitCost
              ).toFixed(2))
            };
          });
          const estimatedBatchCost = productionIngredients.reduce(
            (total, line) => total + Number(line.estimated_cost || 0),
            0
          );
          productionsToCreate.push({
            site_id: selectedSite,
            site_name: site.name,
            production_date: day.date,
            meal_type: prod.meal_type,
            recipe_id: prod.recipe_id,
            recipe_name: prod.recipe_name,
            target_servings: targetServings,
            kitchen_station: recipe?.kitchen_station || 'Unassigned',
            ingredients_used: productionIngredients,
            estimated_batch_cost: Number(estimatedBatchCost.toFixed(2)),
            estimated_cost_per_serving: targetServings > 0
              ? Number((estimatedBatchCost / targetServings).toFixed(2))
              : 0,
            status: 'planned',
            notes: `Auto-scheduled: ${prod.reasoning}`
          });
        }
      });
    });

    await createProductionMutation.mutateAsync(productionsToCreate);
    setSchedule(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto">
        <PageHeader 
          title="Automated Production Scheduling" 
          description="AI-powered production planning with inventory optimization"
        >
          <div className="flex items-center gap-2 text-indigo-600">
            <Zap className="w-5 h-5" />
            <span className="text-sm font-medium">Smart Scheduling</span>
          </div>
        </PageHeader>

        {/* Alerts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {expiringIngredients.length > 0 && (
            <Alert className="border-amber-200 bg-amber-50">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <AlertDescription>
                <span className="font-medium text-amber-900">
                  {expiringIngredients.length} ingredients expiring soon
                </span>
                <p className="text-sm text-amber-700 mt-1">
                  {expiringIngredients.slice(0, 3).map(i => 
                    `${i.item_code} · ${i.ingredient_name} (${i.daysUntilExpiry}d)`
                  ).join(', ')}
                </p>
              </AlertDescription>
            </Alert>
          )}
          
          {lowStockItems.length > 0 && (
            <Alert className="border-red-200 bg-red-50">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              <AlertDescription>
                <span className="font-medium text-red-900">
                  {lowStockItems.length} low stock items
                </span>
                <p className="text-sm text-red-700 mt-1">
                  {lowStockItems.slice(0, 3).map((item) => (
                    `${item.item_code} · ${item.ingredient_name}`
                  )).join(', ')}
                </p>
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Configuration */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Schedule Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Site</label>
                <Select value={selectedSite} onValueChange={setSelectedSite}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select site" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map(site => (
                      <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <label className="text-sm font-medium mb-2 block">Forecast Days</label>
                <Select value={String(forecastDays)} onValueChange={(v) => setForecastDays(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 Day</SelectItem>
                    <SelectItem value="3">3 Days</SelectItem>
                    <SelectItem value="5">5 Days</SelectItem>
                    <SelectItem value="7">7 Days</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-end">
                <Button 
                  onClick={generateSchedule}
                  disabled={!selectedSite || generating}
                  className="w-full bg-indigo-600 hover:bg-indigo-700"
                >
                  {generating ? (
                    <>
                      <Clock className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 mr-2" />
                      Generate Schedule
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Generated Schedule */}
        {schedule && (
          <div className="space-y-4">
            <Card className="border-green-200">
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Optimized Production Schedule</span>
                  <Button 
                    onClick={implementSchedule}
                    disabled={createProductionMutation.isPending}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    {createProductionMutation.isPending ? 'Implementing...' : 'Implement Schedule'}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-blue-50 rounded-lg p-4 mb-4">
                  <p className="text-sm font-medium text-blue-900 mb-2">Optimization Notes</p>
                  <p className="text-sm text-blue-700">{schedule.optimization_notes}</p>
                </div>

                {schedule.warnings && schedule.warnings.length > 0 && (
                  <Alert className="mb-4 border-amber-200 bg-amber-50">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    <AlertDescription>
                      <ul className="list-disc ml-4 space-y-1">
                        {schedule.warnings.map((warning, idx) => (
                          <li key={idx} className="text-sm text-amber-700">{warning}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-4">
                  {schedule.schedule.map((day, dayIdx) => (
                    <Card key={dayIdx}>
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Calendar className="w-5 h-5 text-indigo-600" />
                            {format(parseISO(day.date), 'EEEE, MMM d, yyyy')}
                          </CardTitle>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">
                              {day.total_servings} servings
                            </Badge>
                            <Badge className={day.capacity_utilization > 90 ? 'bg-green-600' : 'bg-blue-600'}>
                              {day.capacity_utilization}% capacity
                            </Badge>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {day.productions.map((prod, prodIdx) => (
                            <div key={prodIdx} className="bg-slate-50 rounded-lg p-4">
                              <div className="flex items-start justify-between mb-2">
                                <div>
                                  <h4 className="font-medium">{prod.recipe_name}</h4>
                                  <div className="flex items-center gap-2 mt-1">
                                    <Badge variant="outline" className="text-xs">
                                      {prod.meal_type}
                                    </Badge>
                                    <Badge className={
                                      prod.priority === 'high' ? 'bg-red-600' :
                                      prod.priority === 'medium' ? 'bg-amber-600' :
                                      'bg-blue-600'
                                    }>
                                      {prod.priority} priority
                                    </Badge>
                                    <span className="text-sm text-slate-600">
                                      {prod.target_servings} servings
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <p className="text-sm text-slate-600">{prod.reasoning}</p>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
