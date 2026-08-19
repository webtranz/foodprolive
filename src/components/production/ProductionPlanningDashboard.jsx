import React, { useMemo, useState } from 'react';
import { addDays, format } from 'date-fns';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Factory,
  ImageOff,
  Layers3,
  LoaderCircle,
  MapPin,
  Moon,
  PackageOpen,
  Plus,
  Printer,
  Scale,
  Sun,
  Sunrise,
  Users,
  WalletCards
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/currency';
import { buildProductionPlanningDashboard } from '@/lib/productionPlanning';
import { formatRecipeQuantity } from '../../../shared/recipeNumbers.js';
import { getItemCodeFromRecords } from '../../../shared/itemCode.js';

const MEAL_STYLES = {
  breakfast: {
    icon: Sunrise,
    header: 'border-amber-200 bg-amber-50/70',
    iconTone: 'text-amber-600',
    title: 'text-amber-900'
  },
  lunch: {
    icon: Sun,
    header: 'border-sky-200 bg-sky-50/70',
    iconTone: 'text-sky-600',
    title: 'text-sky-900'
  },
  dinner: {
    icon: Moon,
    header: 'border-indigo-200 bg-indigo-50/70',
    iconTone: 'text-indigo-600',
    title: 'text-indigo-900'
  },
  other: {
    icon: Clock3,
    header: 'border-slate-200 bg-slate-50',
    iconTone: 'text-slate-600',
    title: 'text-slate-900'
  }
};

const PREP_STATUS = {
  complete: {
    icon: CheckCircle2,
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500'
  },
  in_progress: {
    icon: LoaderCircle,
    badge: 'border-blue-200 bg-blue-50 text-blue-700',
    dot: 'bg-blue-500'
  },
  pending: {
    icon: Clock3,
    badge: 'border-amber-200 bg-amber-50 text-amber-700',
    dot: 'bg-amber-500'
  },
  at_risk: {
    icon: AlertTriangle,
    badge: 'border-red-200 bg-red-50 text-red-700',
    dot: 'bg-red-500'
  }
};

function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function ProductionImage({ src, alt }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="flex h-20 w-20 flex-none items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-400">
        <ImageOff className="h-6 w-6" aria-hidden="true" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="h-20 w-20 flex-none rounded-lg border border-slate-200 object-cover"
    />
  );
}

function PrepStatusBadge({ status }) {
  const config = PREP_STATUS[status.key] || PREP_STATUS.pending;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`${config.badge} gap-1.5 whitespace-nowrap`}>
      <Icon className={`h-3.5 w-3.5 ${status.key === 'in_progress' ? 'animate-spin' : ''}`} aria-hidden="true" />
      {status.label}
    </Badge>
  );
}

function Metric({ icon: Icon, label, value, title }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2" title={title}>
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        <Icon className="h-3 w-3 flex-none" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 truncate text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function RecipeProductionCard({ item, materialRequest, renderActions }) {
  const portionTitle = item.portion_size.is_complete
    ? 'Yield-adjusted portion size from recipe master data.'
    : item.portion_size.warnings.join(' ') || 'Portion-size data is incomplete in the recipe master.';
  const requiresAcknowledgement = item.workflow_status === 'approved'
    && (!materialRequest || String(materialRequest.status || '').toLowerCase() !== 'acknowledged');

  return (
    <Card className={`overflow-hidden border shadow-none ${item.prep_status.key === 'at_risk' ? 'border-red-300' : 'border-slate-200'}`}>
      <CardContent className="p-3">
        <div className="flex gap-3">
          <ProductionImage src={item.image_url} alt={item.recipe_name} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-950" title={item.recipe_name}>{item.recipe_name}</h3>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                  <MapPin className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                  <span className={item.station === 'Unassigned' ? 'font-medium text-red-600' : ''}>{item.station}</span>
                </div>
              </div>
              <PrepStatusBadge status={item.prep_status} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[10px] capitalize">{titleCase(item.workflow_status)}</Badge>
              {item.production.site_name ? (
                <Badge variant="outline" className="text-[10px] text-slate-600">{item.production.site_name}</Badge>
              ) : null}
              {materialRequest ? (
                <Badge variant="outline" className="border-indigo-200 text-[10px] text-indigo-700">
                  MR {materialRequest.request_number || ''} · {titleCase(materialRequest.status)}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 2xl:grid-cols-3">
          <Metric icon={Users} label="Portions" value={formatRecipeQuantity(item.required_portions, 'servings')} />
          <Metric icon={Scale} label="Portion size" value={item.portion_size.label} title={portionTitle} />
          <Metric icon={Layers3} label="Batch yield" value={`${formatRecipeQuantity(item.batch_yield, 'servings')} portions`} />
          <Metric icon={Factory} label="Batches" value={item.batches_required.toLocaleString()} />
          <Metric icon={WalletCards} label="Est. batch cost" value={formatCurrency(item.estimated_batch_cost)} />
          <Metric icon={MapPin} label="Station" value={item.station} />
        </div>

        {item.shortages.length > 0 ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Ingredient shortage
            </div>
            <p className="mt-1 line-clamp-2">
              {item.shortages.map((shortage) => {
                const code = shortage.item_code && shortage.item_code !== '—' ? `${shortage.item_code} ` : '';
                return `${code}${shortage.ingredient_name} ${formatRecipeQuantity(shortage.shortage_quantity, shortage.unit)} ${shortage.unit} short`;
              }).join(' · ')}
            </p>
          </div>
        ) : null}

        {requiresAcknowledgement ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
            {materialRequest
              ? 'Procurement acknowledgement is required before production can start.'
              : 'A linked material request is required before production can start.'}
          </p>
        ) : null}

        {renderActions ? (
          <div className="production-plan-no-print mt-3 border-t border-slate-100 pt-3">
            {renderActions(item.production, materialRequest)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MealSection({ section, materialRequestMap, renderActions }) {
  const style = MEAL_STYLES[section.key] || MEAL_STYLES.other;
  const Icon = style.icon;
  return (
    <section className="production-meal-section min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className={`border-b px-4 py-3 ${style.header}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Icon className={`mt-0.5 h-5 w-5 ${style.iconTone}`} aria-hidden="true" />
            <div>
              <h2 className={`font-semibold ${style.title}`}>{section.label}</h2>
              <p className="text-xs text-slate-600">{section.time_range}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold text-slate-950">{section.total_portions.toLocaleString()}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">portions</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{section.total_recipes} dishes</p>
          </div>
        </div>
      </header>
      <div className="space-y-3 p-3">
        {section.items.length > 0 ? section.items.map((item) => (
          <RecipeProductionCard
            key={item.id}
            item={item}
            materialRequest={materialRequestMap[item.id] || null}
            renderActions={renderActions}
          />
        )) : (
          <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 text-center">
            <PackageOpen className="mb-2 h-6 w-6 text-slate-300" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-600">No production planned</p>
            <p className="mt-1 text-xs text-slate-400">No {section.label.toLowerCase()} dishes for this date.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function PlanSummary({ dashboard }) {
  const corePeriods = dashboard.sections.filter((section) => ['breakfast', 'lunch', 'dinner'].includes(section.key));
  const otherPeriod = dashboard.sections.find((section) => section.key === 'other');
  return (
    <aside className="production-plan-summary space-y-3 xl:sticky xl:top-4 xl:self-start">
      <Card className="border-slate-200 shadow-none">
        <CardHeader className="pb-3"><CardTitle className="text-base">Plan Summary</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <span className="font-medium text-slate-700">Total Portions</span>
            <span className="text-xl font-bold text-sky-700">{dashboard.summary.total_portions.toLocaleString()}</span>
          </div>
          {corePeriods.map((period) => (
            <div key={period.key} className="flex justify-between text-slate-600">
              <span>{period.label}</span><span className="font-medium text-slate-900">{period.total_portions.toLocaleString()}</span>
            </div>
          ))}
          {otherPeriod ? (
            <div className="flex justify-between text-slate-600">
              <span>{otherPeriod.label}</span><span className="font-medium text-slate-900">{otherPeriod.total_portions.toLocaleString()}</span>
            </div>
          ) : null}
          <div className="mt-3 flex justify-between border-t border-slate-100 pt-3">
            <span className="font-medium text-slate-700">Total Recipes</span>
            <span className="font-semibold text-slate-950">{dashboard.summary.total_recipes}</span>
          </div>
          <div className="flex justify-between">
            <span className="font-medium text-slate-700">Total Batch Cost</span>
            <span className="font-semibold text-slate-950">{formatCurrency(dashboard.summary.total_batch_cost)}</span>
          </div>
        </CardContent>
      </Card>

      <Card className={`shadow-none ${dashboard.shortages.length > 0 ? 'border-red-300' : 'border-slate-200'}`}>
        <CardHeader className="pb-3">
          <CardTitle className={`flex items-center justify-between text-base ${dashboard.shortages.length > 0 ? 'text-red-700' : 'text-slate-900'}`}>
            <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Ingredient Shortages</span>
            <Badge className={dashboard.shortages.length > 0 ? 'bg-red-600' : 'bg-emerald-600'}>{dashboard.shortages.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.shortages.length > 0 ? (
            <div className="space-y-3">
              {dashboard.shortages.map((shortage) => (
                <div key={`${shortage.site_id}-${shortage.ingredient_id}`} className="text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[10px] text-slate-500">{shortage.item_code}</p>
                      <p className="truncate font-medium text-slate-800">{shortage.ingredient_name}</p>
                      <p className="truncate text-slate-500">{shortage.recipe_names.join(', ')}</p>
                      {shortage.site_name ? <p className="text-slate-400">{shortage.site_name}</p> : null}
                    </div>
                    <span className="whitespace-nowrap font-semibold text-red-600">-{formatRecipeQuantity(shortage.shortage_quantity, shortage.unit)} {shortage.unit}</span>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">Required {formatRecipeQuantity(shortage.required_quantity, shortage.unit)} · Available {formatRecipeQuantity(shortage.available_quantity, shortage.unit)} {shortage.unit}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />No ingredient shortages detected.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-none">
        <CardHeader className="pb-3"><CardTitle className="text-base">Labor Load by Meal</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {corePeriods.map((period) => {
            const load = dashboard.labor_loads[period.key];
            return (
              <div key={period.key}>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700">{period.label}</span>
                  <span className="text-slate-500">{load.hours} crew hrs · {load.share_percent}%</span>
                </div>
                <Progress value={load.share_percent} className="h-2 bg-slate-100 [&>div]:bg-sky-600" />
              </div>
            );
          })}
          <p className="text-[10px] leading-relaxed text-slate-400">Estimated from recipe preparation and cooking time multiplied by required batches.</p>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-none">
        <CardHeader className="pb-3"><CardTitle className="text-base">Plan Notes</CardTitle></CardHeader>
        <CardContent>
          {dashboard.summary.plan_notes.length > 0 ? (
            <ul className="space-y-3 text-xs text-slate-600">
              {dashboard.summary.plan_notes.map((entry) => (
                <li key={entry.production_id} className="border-l-2 border-slate-200 pl-3">
                  <span className="font-semibold text-slate-800">{entry.recipe_name}:</span> {entry.note}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">No plan notes for this date.</p>}
        </CardContent>
      </Card>
    </aside>
  );
}

function MasterRecipeSheet({ open, onOpenChange, dashboard, ingredients = [] }) {
  const ingredientMap = useMemo(
    () => new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient])),
    [ingredients]
  );
  const recipes = useMemo(() => {
    const seen = new Set();
    return dashboard.items.filter((item) => {
      const key = item.recipe?.id || item.recipe_name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [dashboard.items]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" />Master Recipe Sheet</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {recipes.length > 0 ? recipes.map((item) => (
            <section key={item.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                <ProductionImage src={item.image_url} alt={item.recipe_name} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold text-slate-950">{item.recipe_name}</h3>
                    {item.recipe?.recipe_code ? <Badge variant="outline">{item.recipe.recipe_code}</Badge> : null}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                    <div><p className="text-slate-400">Portion size</p><p className="font-semibold text-slate-800">{item.portion_size.label}</p></div>
                    <div><p className="text-slate-400">Batch yield</p><p className="font-semibold text-slate-800">{formatRecipeQuantity(item.batch_yield, 'servings')} portions</p></div>
                    <div><p className="text-slate-400">Prep time</p><p className="font-semibold text-slate-800">{item.recipe?.prep_time_minutes || 0} min</p></div>
                    <div><p className="text-slate-400">Cook time</p><p className="font-semibold text-slate-800">{item.recipe?.cook_time_minutes || 0} min</p></div>
                  </div>
                </div>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ingredients</h4>
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
                    {(item.recipe?.ingredients || []).length > 0 ? item.recipe.ingredients.map((ingredient, index) => {
                      const itemCode = getItemCodeFromRecords([
                        ingredientMap.get(String(ingredient.ingredient_id || '')),
                        ingredient
                      ], '');
                      return (
                        <li key={`${ingredient.ingredient_id || ingredient.ingredient_name}-${index}`}>
                          {itemCode ? <span className="mr-2 font-mono text-xs text-slate-500">{itemCode}</span> : null}
                          {ingredient.ingredient_name || 'Ingredient'} — {formatRecipeQuantity(ingredient.quantity, ingredient.unit)} {ingredient.unit}
                        </li>
                      );
                    }) : <li className="text-slate-400">No direct ingredients recorded.</li>}
                  </ul>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Method</h4>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{item.recipe?.instructions || 'No preparation instructions recorded.'}</p>
                </div>
              </div>
            </section>
          )) : (
            <div className="py-12 text-center text-sm text-slate-500">No planned recipes are available for this date.</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ProductionPlanningDashboard({
  productions,
  recipes,
  ingredients,
  inventory,
  sites,
  selectedDate,
  selectedSite,
  onDateChange,
  onSiteChange,
  materialRequestMap = {},
  isLoading = false,
  errorMessage = '',
  canCreate = false,
  onNewProduction,
  onExport,
  onPrint,
  renderActions
}) {
  const [recipeSheetOpen, setRecipeSheetOpen] = useState(false);
  const dashboard = useMemo(() => buildProductionPlanningDashboard({
    productions,
    recipes,
    ingredients,
    inventory
  }), [productions, recipes, ingredients, inventory]);
  const hasItems = dashboard.items.length > 0;
  const shiftDate = (amount) => {
    const base = new Date(`${selectedDate}T00:00:00`);
    onDateChange(format(addDays(base, amount), 'yyyy-MM-dd'));
  };

  return (
    <div className="production-plan-page min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1900px]">
        <header className="mb-5 border-b border-slate-200 pb-4">
          <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-950">Production Planning</h1>
              <p className="mt-1 text-sm text-slate-500">Daily kitchen execution by meal period, batch, station, stock readiness, and preparation status.</p>
            </div>
            <div className="production-plan-no-print flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setRecipeSheetOpen(true)} disabled={!hasItems}>
                <BookOpen className="mr-2 h-4 w-4" />Master Recipe Sheet
              </Button>
              <Button variant="outline" onClick={onPrint} disabled={!hasItems}>
                <Printer className="mr-2 h-4 w-4" />Print Plan
              </Button>
              <Button variant="outline" onClick={() => onExport(dashboard)} disabled={!hasItems}>
                <Download className="mr-2 h-4 w-4" />Export
              </Button>
              <Button onClick={onNewProduction} disabled={!canCreate} className="bg-sky-700 hover:bg-sky-800">
                <Plus className="mr-2 h-4 w-4" />New Production
              </Button>
            </div>
          </div>

          <div className="production-plan-no-print mt-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-end">
            <div>
              <Label htmlFor="production-plan-date">Date</Label>
              <div className="mt-1 flex">
                <Button type="button" variant="outline" size="icon" className="rounded-r-none" onClick={() => shiftDate(-1)} aria-label="Previous production date">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="relative">
                  <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input id="production-plan-date" type="date" value={selectedDate} onChange={(event) => onDateChange(event.target.value)} className="w-[180px] rounded-none pl-9" />
                </div>
                <Button type="button" variant="outline" size="icon" className="rounded-l-none" onClick={() => shiftDate(1)} aria-label="Next production date">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="production-plan-site">Site</Label>
              <Select value={selectedSite} onValueChange={onSiteChange}>
                <SelectTrigger id="production-plan-site" className="mt-1 w-full bg-white sm:w-[260px]"><SelectValue placeholder="Select site" /></SelectTrigger>
                <SelectContent>
                  {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto flex items-center gap-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <span><strong className="text-slate-900">{dashboard.summary.total_recipes}</strong> recipes</span>
              <span><strong className="text-slate-900">{dashboard.summary.total_portions.toLocaleString()}</strong> portions</span>
              {dashboard.summary.at_risk_count > 0 ? <span className="font-semibold text-red-600">{dashboard.summary.at_risk_count} at risk</span> : null}
            </div>
          </div>
        </header>

        {errorMessage ? (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div>
        ) : null}

        {isLoading ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((index) => <Skeleton key={index} className="h-[520px] rounded-xl" />)}
            </div>
            <Skeleton className="h-[620px] rounded-xl" />
          </div>
        ) : (
          <div className="production-plan-layout grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <main className={`production-meal-grid grid min-w-0 gap-4 ${dashboard.sections.length > 3 ? 'md:grid-cols-2' : 'md:grid-cols-2 lg:grid-cols-3'}`}>
              {dashboard.sections.map((section) => (
                <MealSection
                  key={section.key}
                  section={section}
                  materialRequestMap={materialRequestMap}
                  renderActions={renderActions}
                />
              ))}
            </main>
            <PlanSummary dashboard={dashboard} />
          </div>
        )}

        <footer className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-200 pt-4 text-xs text-slate-500">
          <span className="font-medium text-slate-700">Prep status:</span>
          {Object.entries(PREP_STATUS).map(([key, status]) => (
            <span key={key} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />{titleCase(key)}</span>
          ))}
          <span className="ml-auto">Costs and labor load are operational estimates until production completion.</span>
        </footer>
      </div>

      <MasterRecipeSheet open={recipeSheetOpen} onOpenChange={setRecipeSheetOpen} dashboard={dashboard} ingredients={ingredients} />
    </div>
  );
}
