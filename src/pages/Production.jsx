import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import ProductionPlanningDashboard from '@/components/production/ProductionPlanningDashboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertCircle, ArrowLeft, Brain, CheckCircle2, ClipboardList, Factory, FileText, History, PackagePlus, Sparkles, Trash2, Wand2, XCircle } from 'lucide-react';
import { downloadCSV } from '../components/utils/exportData';
import { format } from 'date-fns';
import { usePermissions } from '@/components/auth/usePermissions';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { formatCurrency } from '@/lib/currency';
import StandardDecimalInput from '@/components/recipes/StandardDecimalInput';
import IngredientSearchCombobox from '@/components/ingredients/IngredientSearchCombobox';
import { buildProductionPlanExportRows } from '@/lib/productionPlanning';
import {
  getInventoryQuantities,
  getProductionInventoryState
} from '@/lib/inventoryAvailability';
import { convertIngredientQuantity } from '../../shared/ingredientUnits.js';
import { buildAutomaticProductionYieldSummary } from '../../shared/productionReconciliation.js';
import { formatRecipeQuantity, getRecipeQuantityPrecision, roundStandardDecimal } from '../../shared/recipeNumbers.js';
import { getItemCode } from '../../shared/itemCode.js';
import {
  aggregateProductionIngredientLines,
  buildInventoryReplacementSuggestions,
  buildMenuIssueMealGroups,
  buildMenuPlanIssueItems,
  buildProductionIngredientLine,
  buildProductionIngredientSnapshot,
  buildProductionIngredientsForSubmit,
  buildProductionOverrideAudit,
  finiteProductionNumber,
  getMenuIssueMealGroupKey,
  getProductionIngredientLineKey,
  normalizeIssueMealView,
  PRODUCTION_ISSUE_MEAL_LABELS,
  PRODUCTION_ISSUE_MEAL_TYPES,
  recalculateProductionIngredientSnapshot
} from '@/lib/productionIssue';
import {
  canStartApprovedProduction,
  getPendingAreaApprovalProductions,
  getProductionApprovalHistory,
  getProductionRejectionReturnStatus,
  getProductionStartBlockReason,
  getProductionStatusLabel,
  requiresAreaProductionApproval
} from '../../shared/productionWorkflow.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';
import {
  getMenuCategoryOptions,
  MENU_CUISINE_OPTIONS,
  normalizeMenuCategory,
  normalizeMenuCuisine
} from '../../shared/menuCategories.js';

const MEAL_TYPES = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' }
];

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isAreaApprovalReview(production) {
  return requiresAreaProductionApproval(production);
}

function formatWorkflowTimestamp(value) {
  if (!value) return 'Date and time not recorded';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return String(value);
  return format(timestamp, 'dd MMM yyyy, hh:mm a');
}

function ApprovalHistoryList({ production, emptyMessage = 'No approval actions have been recorded yet.' }) {
  const history = getProductionApprovalHistory(production);
  if (history.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>;
  }

  return (
    <ol className="space-y-2">
      {history.map((entry) => {
        const actor = entry.actor_name || entry.actor_email || 'System';
        const transition = entry.from_status || entry.to_status
          ? `${getProductionStatusLabel(entry.from_status || 'draft')} → ${getProductionStatusLabel(entry.to_status || entry.from_status)}`
          : '';
        return (
          <li key={entry.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">{entry.action_label}</p>
                <p className="text-xs text-slate-600">By {actor}</p>
              </div>
              <time className="text-xs text-slate-500" dateTime={entry.timestamp || undefined}>
                {formatWorkflowTimestamp(entry.timestamp)}
              </time>
            </div>
            {transition ? <p className="mt-1 text-xs text-slate-500">{transition}</p> : null}
            {entry.reason ? (
              <p className="mt-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
                <span className="font-medium">Reason / notes:</span> {entry.reason}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function formatOverrideAction(action) {
  const labels = {
    added: 'Added for production',
    replaced: 'Replaced for production',
    zeroed: 'Zeroed for production',
    quantity_changed: 'Quantity changed'
  };
  return labels[action] || String(action || '').replace(/_/g, ' ');
}

function productionOverrideTone(action) {
  const tones = {
    added: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    replaced: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    zeroed: 'border-red-200 bg-red-50 text-red-700',
    quantity_changed: 'border-amber-200 bg-amber-50 text-amber-700'
  };
  return tones[action] || 'border-slate-200 bg-slate-50 text-slate-700';
}

function ProductionOverrideSummary({ production }) {
  const overrides = Array.isArray(production?.production_overrides)
    ? production.production_overrides
    : (Array.isArray(production?.ingredients_used) ? production.ingredients_used : [])
      .filter((line) => line.production_override_action)
      .map((line, index) => ({
        id: line.line_id || `${line.ingredient_id}-${index}`,
        action: line.production_override_action,
        original_ingredient_name: line.original_ingredient_name,
        original_quantity: line.original_raw_quantity,
        original_unit: line.original_unit,
        final_ingredient_name: line.ingredient_name,
        final_quantity: line.raw_quantity ?? line.required_quantity ?? line.planned_quantity,
        final_unit: line.unit,
        reason: line.production_override_reason || line.ai_suggestion_reason || ''
      }));

  if (overrides.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4">
      <div className="flex items-start gap-2">
        <ClipboardList className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-700" />
        <div>
          <p className="font-medium text-indigo-950">Production-only recipe changes</p>
          <p className="mt-1 text-sm text-indigo-800">
            These changes are stored on this production request only. The master recipe is unchanged.
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {overrides.map((override) => (
          <div key={override.id} className="rounded-lg border border-white/80 bg-white px-3 py-2 text-sm text-slate-700">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={productionOverrideTone(override.action)}>
                {formatOverrideAction(override.action)}
              </Badge>
              <span className="font-medium text-slate-900">
                {override.original_ingredient_name || 'New item'} → {override.final_ingredient_name || 'No item'}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {formatRecipeQuantity(override.original_quantity, override.original_unit || '')} {override.original_unit || ''}
              {' '}→{' '}
              {formatRecipeQuantity(override.final_quantity, override.final_unit || '')} {override.final_unit || ''}
              {override.reason ? ` · ${override.reason}` : ''}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductionIngredientSnapshotEditor({
  title = 'Production recipe snapshot',
  description = 'Editable for this production only. Master recipe quantities remain unchanged.',
  lines = [],
  ingredients = [],
  inventorySiteId = '',
  suggestionsByLine = {},
  suggestionLoadingLine = '',
  estimatedBatchCost = 0,
  estimatedCostPerServing = 0,
  aggregateShortageLines = [],
  onLineQuantityChange,
  onLineIngredientChange,
  onZeroLine,
  onAddIngredient,
  onRemoveLine,
  onRequestSuggestions,
  onApplySuggestion
}) {
  const [addIngredientId, setAddIngredientId] = useState('');
  const [addIngredient, setAddIngredient] = useState(null);
  const [addQuantity, setAddQuantity] = useState('');
  const selectedAddIngredient = addIngredient || ingredients.find((ingredient) => String(ingredient.id) === String(addIngredientId));
  const shortageCount = lines.filter((line) => !line.sufficient).length;
  const overrideCount = lines.filter((line) => line.production_override_action).length;

  const handleAddIngredient = () => {
    if (!selectedAddIngredient || !(Number(addQuantity) > 0)) return;
    onAddIngredient?.({
      ingredient_id: selectedAddIngredient.id,
      ingredient_name: selectedAddIngredient.name || 'Ingredient',
      ingredient: selectedAddIngredient,
      quantity: Number(addQuantity),
      unit: selectedAddIngredient.unit || 'unit'
    });
    setAddIngredientId('');
    setAddIngredient(null);
    setAddQuantity('');
  };

  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50/80 p-4">
      <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-start 2xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-600" />
            <div>
              <h4 className="font-medium text-blue-950">{title}</h4>
              <p className="mt-1 text-sm text-blue-800">{description}</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 2xl:min-w-[560px]">
          <div className="rounded-xl border border-blue-100 bg-white px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-slate-500">Batch cost</p>
            <p className="mt-1 text-lg font-bold text-emerald-700">{formatCurrency(estimatedBatchCost)}</p>
          </div>
          <div className="rounded-xl border border-blue-100 bg-white px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-slate-500">Cost / serving</p>
            <p className="mt-1 text-lg font-bold text-slate-900">{formatCurrency(estimatedCostPerServing)}</p>
          </div>
          <div className="rounded-xl border border-blue-100 bg-white px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-slate-500">Short lines</p>
            <p className={`mt-1 text-lg font-bold ${shortageCount > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{shortageCount}</p>
          </div>
          <div className="rounded-xl border border-blue-100 bg-white px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-slate-500">Overrides</p>
            <p className="mt-1 text-lg font-bold text-indigo-700">{overrideCount}</p>
          </div>
        </div>
      </div>

      {aggregateShortageLines.length > 0 ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="font-semibold">Short after selected meal demand</p>
          <p className="mt-1 text-xs text-red-800">
            These ingredient lines are short after all selected dishes are combined. Use the highlighted lines below to zero out, replace, or adjust quantities for production only.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {aggregateShortageLines.map((line) => (
              <Badge key={`${line.ingredient_id}-${line.unit}`} className="bg-red-600">
                {line.ingredient_name}: short {formatRecipeQuantity(line.shortage, line.inventory_unit || line.unit)} {line.inventory_unit || line.unit}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        {lines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
            No ingredient lines are available for this recipe yet. Add a production-only ingredient below if stock should still be reserved or recorded for this run.
          </div>
        ) : null}
        {lines.map((line, index) => {
          const lineKey = getProductionIngredientLineKey(line, index);
          const lineSuggestions = suggestionsByLine[lineKey] || [];
          const isSuggestionLoading = suggestionLoadingLine === lineKey;
          const isAddedLine = line.production_override_action === 'added';
          return (
            <div
              key={lineKey}
              className={`rounded-xl border bg-white p-4 shadow-sm ${
                line.aggregate_shortage ? 'border-red-300 ring-2 ring-red-100' : 'border-slate-200'
              }`}
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {line.item_code && line.item_code !== '—' ? (
                      <Badge variant="outline" className="font-mono text-[11px] text-slate-600">{line.item_code}</Badge>
                    ) : null}
                    {line.production_override_action ? (
                      <Badge variant="outline" className={productionOverrideTone(line.production_override_action)}>
                        {formatOverrideAction(line.production_override_action)}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">Master recipe line</Badge>
                    )}
                  </div>
                  <p className="mt-2 break-words text-sm font-semibold text-slate-950">{line.ingredient_name}</p>
                  {line.production_override_action === 'replaced' ? (
                    <p className="mt-1 text-xs text-slate-500">
                      Original: {line.original_ingredient_name} · {formatRecipeQuantity(line.original_raw_quantity, line.original_unit)} {line.original_unit}
                    </p>
                  ) : null}
                </div>
                <Badge className={line.sufficient ? 'bg-emerald-600' : 'bg-red-600'}>
                  {line.sufficient
                    ? 'Sufficient'
                    : `${line.aggregate_shortage ? 'Meal short' : 'Short'} ${formatRecipeQuantity(line.shortage, line.inventory_unit)} ${line.inventory_unit}`}
                </Badge>
              </div>

              <div className="mt-4 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
                <div className="grid gap-3 lg:grid-cols-3">
                  <div>
                    <Label className="text-xs text-slate-500">Ingredient used for this production</Label>
                    <IngredientSearchCombobox
                      value={line.ingredient_id || ''}
                      selectedIngredient={ingredients.find((ingredient) => String(ingredient.id) === String(line.ingredient_id)) || null}
                      siteId={inventorySiteId}
                      placeholder="Search replacement ingredient..."
                      className="mt-1"
                      onValueChange={(value, ingredient) => onLineIngredientChange?.(lineKey, value, ingredient)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500">Production quantity</Label>
                    <StandardDecimalInput
                      value={line.raw_quantity}
                      unit={line.unit}
                      precision={getRecipeQuantityPrecision(line.unit)}
                      min={0}
                      allowZero
                      allowEmpty={false}
                      label={`${line.ingredient_name} quantity`}
                      onValueChange={(value) => onLineQuantityChange?.(lineKey, value)}
                      className="mt-1 bg-white"
                    />
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Store availability</p>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-slate-500">On hand</p>
                        <p className="font-semibold text-slate-900">{formatRecipeQuantity(line.on_hand_stock, line.inventory_unit)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Reserved</p>
                        <p className="font-semibold text-slate-900">{formatRecipeQuantity(line.reserved_stock, line.inventory_unit)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Available</p>
                        <p className="font-semibold text-slate-900">{formatRecipeQuantity(line.available_stock, line.inventory_unit)}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{line.inventory_unit}</p>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-slate-500">Yield</p>
                      <p className="font-semibold text-slate-900">{finiteProductionNumber(line.yield_percent, 100).toFixed(2)}%</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Yielded output</p>
                      <p className="font-semibold text-emerald-700">
                        {formatRecipeQuantity(line.yielded_quantity, line.unit)} {line.unit}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Unit cost</p>
                      <p className="font-semibold text-slate-900">{formatCurrency(line.unit_cost)} / {line.cost_unit}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Line cost</p>
                      <p className="font-semibold text-slate-900">{formatCurrency(line.estimated_cost)}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-red-200 text-red-700 hover:bg-red-50"
                  onClick={() => onZeroLine?.(lineKey)}
                >
                  Zero out
                </Button>
                {isAddedLine ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onRemoveLine?.(lineKey)}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Remove added line
                  </Button>
                ) : null}
                {!line.sufficient ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                    disabled={isSuggestionLoading}
                    onClick={() => onRequestSuggestions?.(lineKey, line)}
                  >
                    {isSuggestionLoading ? (
                      <Sparkles className="mr-1.5 h-4 w-4 animate-pulse" />
                    ) : (
                      <Wand2 className="mr-1.5 h-4 w-4" />
                    )}
                    {isSuggestionLoading ? 'Finding replacements...' : 'AI replacement suggestions'}
                  </Button>
                ) : null}
              </div>

              {lineSuggestions.length > 0 ? (
                <div className="mt-3 grid gap-2 lg:grid-cols-2">
                  {lineSuggestions.map((suggestion) => (
                    <div key={`${lineKey}-${suggestion.ingredient_id}`} className="rounded-lg border border-indigo-100 bg-indigo-50/70 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-semibold text-indigo-950">{suggestion.ingredient_name}</p>
                          <p className="mt-1 text-xs text-indigo-800">
                            Available {formatRecipeQuantity(suggestion.available_quantity, suggestion.unit)} {suggestion.unit}
                            {' · '}
                            suggested {formatRecipeQuantity(suggestion.suggested_quantity, suggestion.unit)} {suggestion.unit}
                          </p>
                          <p className="mt-1 text-xs text-slate-600">{suggestion.reason}</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          className="bg-indigo-700 hover:bg-indigo-800"
                          onClick={() => onApplySuggestion?.(lineKey, suggestion)}
                        >
                          Apply
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {onAddIngredient ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <PackagePlus className="h-4 w-4 text-slate-600" />
            <p className="font-medium text-slate-900">Add production-only ingredient</p>
          </div>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_180px_auto] xl:items-end">
            <div>
              <Label className="text-xs text-slate-500">Ingredient</Label>
              <IngredientSearchCombobox
                value={addIngredientId}
                selectedIngredient={selectedAddIngredient}
                siteId={inventorySiteId}
                placeholder="Search ingredient to add..."
                className="mt-1"
                allowClear
                clearLabel="No additional ingredient"
                onValueChange={(value, ingredient) => {
                  setAddIngredientId(value);
                  setAddIngredient(ingredient);
                }}
              />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Quantity</Label>
              <StandardDecimalInput
                value={addQuantity}
                unit={selectedAddIngredient?.unit || 'unit'}
                precision={getRecipeQuantityPrecision(selectedAddIngredient?.unit || 'unit')}
                min={0}
                allowZero={false}
                allowEmpty
                label="Additional ingredient quantity"
                onValueChange={setAddQuantity}
                className="mt-1 bg-white"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleAddIngredient}
              disabled={!selectedAddIngredient || !(Number(addQuantity) > 0)}
            >
              <PackagePlus className="mr-2 h-4 w-4" />
              Add ingredient
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Production() {
  const location = useLocation();
  const navigate = useNavigate();
  const { can, role: currentRole } = usePermissions();
  const { allowedSiteIds, isAdmin, siteId: assignedSiteId } = useSiteContext();
  const canReviewAreaApprovals = can('approve_production')
    || can('reject_area_production')
    || can('request_changes_area_production');
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [formData, setFormData] = useState({
    site_id: '',
    fulfillment_store_id: '',
    production_date: format(new Date(), 'yyyy-MM-dd'),
    meal_type: 'lunch',
    menu_type: 'general',
    menu_category: 'senior',
    recipe_id: '',
    target_servings: null,
    kitchen_station: '',
    notes: ''
  });
  const [calculatedIngredients, setCalculatedIngredients] = useState([]);
  const [inventoryCheck, setInventoryCheck] = useState([]);
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [selectedProduction, setSelectedProduction] = useState(null);
  const [editingProduction, setEditingProduction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [estimatedBatchCost, setEstimatedBatchCost] = useState(0);
  const [estimatedCostPerServing, setEstimatedCostPerServing] = useState(0);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewAction, setReviewAction] = useState('');
  const [reviewFulfillmentStoreId, setReviewFulfillmentStoreId] = useState('');
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionProduction, setCompletionProduction] = useState(null);
  const [completionFulfillmentStoreId, setCompletionFulfillmentStoreId] = useState('');
  const [selectedConsumptionReport, setSelectedConsumptionReport] = useState(null);
  const [reportLoadingId, setReportLoadingId] = useState('');
  const [historyProduction, setHistoryProduction] = useState(null);
  const [inventoryAction, setInventoryAction] = useState(null);
  const [inventoryActionMode, setInventoryActionMode] = useState('adjust');
  const [inventoryActionServings, setInventoryActionServings] = useState(null);
  const [inventoryActionReason, setInventoryActionReason] = useState('');
  const [singleRecipeSuggestions, setSingleRecipeSuggestions] = useState({});
  const [singleRecipeSuggestionLoadingLine, setSingleRecipeSuggestionLoadingLine] = useState('');
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [issueSource, setIssueSource] = useState(null);
  const [issueMealView, setIssueMealView] = useState('all');
  const [issueItems, setIssueItems] = useState([]);
  const [activeIssueItemKey, setActiveIssueItemKey] = useState('');
  const [issueFulfillmentStoreId, setIssueFulfillmentStoreId] = useState('');
  const [issueNotes, setIssueNotes] = useState('');
  const [issueSnapshots, setIssueSnapshots] = useState({});
  const [issueSuggestions, setIssueSuggestions] = useState({});
  const [issueSuggestionLoadingKey, setIssueSuggestionLoadingKey] = useState('');

  const queryClient = useQueryClient();

  const { data: sites = [], error: sitesError } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: recipes = [], error: recipesError } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const { data: ingredients = [], error: ingredientsError } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list()
  });

  const { data: productions = [], isLoading, error: productionsError } = useQuery({
    queryKey: ['productions', selectedDate],
    queryFn: () => base44.entities.Production.filter({
      production_date: selectedDate
    }, '-production_date'),
    enabled: Boolean(selectedDate),
    refetchInterval: 300000
  });

  const {
    data: areaApprovalCandidates = [],
    isLoading: isAreaApprovalQueueLoading,
    error: areaApprovalQueueError
  } = useQuery({
    queryKey: ['productionAreaApprovalQueue'],
    queryFn: async () => {
      const [pending, legacyApproved] = await Promise.all([
        base44.entities.Production.filter({ status: 'pending_production' }, 'production_date', 5000),
        base44.entities.Production.filter({ status: 'approved' }, 'production_date', 5000)
      ]);
      const records = [...pending, ...legacyApproved];
      return [...new Map(records.map((record) => [String(record.id), record])).values()];
    },
    enabled: canReviewAreaApprovals,
    refetchInterval: 300000
  });

  const { data: productionHistory = [] } = useQuery({
    queryKey: ['productionHistoryForWasteInsights'],
    queryFn: () => base44.entities.Production.list('-production_date', 1000)
  });

  const { data: materialRequests = [], error: materialRequestsError } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list(),
    enabled: can('view_material_request') || can('acknowledge_material_request') || can('manage_procurement') || can('approve_procurement'),
    refetchInterval: 300000
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWasteForProduction'],
    queryFn: () => base44.entities.FoodWaste.list('-waste_date', 1000),
    enabled: can('manage_waste')
  });

  const createMutation = useMutation({
    mutationFn: (data) => (
      editingProduction
        ? base44.entities.Production.update(editingProduction.id, data)
        : base44.entities.Production.create(data)
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      setFormOpen(false);
      setEditingProduction(null);
      setActionError('');
      resetForm();
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to create production plan');
    }
  });

  const issueProductionMutation = useMutation({
    mutationFn: async ({ status }) => {
      const selectedItems = issueItems.filter((item) => (
        item.selected
        && !isIssueItemAlreadyIssued(item)
        && Number(item.production_covers) > 0
      ));
      if (selectedItems.length === 0) {
        throw new Error('Select at least one menu item that has not already been issued.');
      }
      const mealGroups = buildMenuIssueMealGroups(selectedItems, {
        snapshotsByItemKey: issueSnapshots,
        ingredients,
        inventory,
        siteId: issueFulfillmentStoreId
      });
      if (mealGroups.length === 0) {
        throw new Error('Select at least one meal group before issuing production.');
      }
      const created = [];
      for (const group of mealGroups) {
        created.push(await base44.entities.Production.create(buildMenuIssueSubmitData(group, status)));
      }
      return created;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      setIssueDialogOpen(false);
      setIssueSource(null);
      setIssueItems([]);
      setIssueSnapshots({});
      setIssueSuggestions({});
      setIssueNotes('');
      setActionError('');
      setActionMessage(`${created.length} meal production request${created.length === 1 ? '' : 's'} issued from the menu plan.`);
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to issue production from the menu plan.');
    }
  });

  const { data: inventory = [], error: inventoryError } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.inventory.getStockOnHand(),
    refetchInterval: 300000
  });

  const {
    data: issuePlanResponse,
    isLoading: issuePlanLoading,
    error: issuePlanError
  } = useQuery({
    queryKey: [
      'issueMenuPlan',
      issueSource?.site_id || '',
      issueSource?.plan_date || '',
      issueSource?.menu_type || '',
      issueSource?.menu_category || ''
    ],
    queryFn: () => base44.menuPlanning.getByDate(issueSource.site_id, issueSource.plan_date, {
      cuisine_type: issueSource.menu_type,
      menu_category: issueSource.menu_category
    }),
    enabled: Boolean(
      issueDialogOpen
      && issueSource?.site_id
      && issueSource?.plan_date
    )
  });

  useEffect(() => {
    const unsubscribeProduction = base44.entities.Production.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'] });
    });
    const unsubscribeRequests = base44.entities.MaterialRequest.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
    });
    const unsubscribeInventory = base44.entities.Inventory.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    });
    return () => {
      unsubscribeProduction();
      unsubscribeRequests();
      unsubscribeInventory();
    };
  }, [queryClient]);

  const visibleSites = useMemo(() => (
    isAdmin
      ? sites
      : sites.filter((site) => allowedSiteIds.includes(site.id))
  ), [allowedSiteIds, isAdmin, sites]);
  const productionSiteOptions = useMemo(() => visibleSites.filter((site) => (
    site.is_active !== false
    && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT
  )), [visibleSites]);
  const selectedProductionSite = useMemo(() => (
    sites.find((site) => String(site.id) === String(formData.site_id)) || null
  ), [formData.site_id, sites]);
  const fulfillmentStoreOptions = useMemo(() => {
    if (!selectedProductionSite) return [];
    return visibleSites.filter((site) => (
      site.is_active !== false
      &&
      normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
      && String(site.parent_site_id || '') === String(selectedProductionSite.id)
    ));
  }, [selectedProductionSite, visibleSites]);
  const canViewAllAccessibleSites = isAdmin || [
    'general_manager',
    'assistant_general_manager',
    'area_manager'
  ].includes(currentRole);
  const issuePlan = issuePlanResponse?.plan || issueSource?.plan || null;
  const issueSite = sites.find((site) => String(site.id) === String(issueSource?.site_id || issuePlan?.site_id || '')) || null;
  const issueFulfillmentStoreOptions = useMemo(() => {
    const siteId = issueSite?.id || issueSource?.site_id || '';
    if (!siteId) return [];
    return visibleSites.filter((site) => (
      site.is_active !== false
      && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
      && String(site.parent_site_id || '') === String(siteId)
    ));
  }, [issueSite?.id, issueSource?.site_id, visibleSites]);
  const issueAlreadyCreatedKeys = useMemo(() => {
    const planId = String(issuePlan?.id || issueSource?.menu_plan_id || '');
    const keys = new Set();
    productions
      .filter((production) => (
        planId
        && production.source_menu_plan_id
        && String(production.source_menu_plan_id) === planId
        && !['cancelled', 'rejected'].includes(String(production.status || '').toLowerCase())
      ))
      .forEach((production) => {
        if (production.source_menu_plan_item_key) {
          keys.add(production.source_menu_plan_item_key);
        }
        if (production.production_issue_group_key) {
          keys.add(production.production_issue_group_key);
        }
        if (production.source_menu_plan_meal_type) {
          keys.add(`${planId}::${production.source_menu_plan_meal_type}`);
        }
        (Array.isArray(production.source_menu_plan_item_keys)
          ? production.source_menu_plan_item_keys
          : []).filter(Boolean).forEach((key) => keys.add(key));
      });
    return keys;
  }, [issuePlan?.id, issueSource?.menu_plan_id, productions]);
  const activeIssueItem = issueItems.find((item) => item.key === activeIssueItemKey) || issueItems[0] || null;
  const activeIssueSnapshot = activeIssueItem ? issueSnapshots[activeIssueItem.key] || [] : [];
  const activeIssueSuggestions = activeIssueItem ? issueSuggestions[activeIssueItem.key] || {} : {};
  const activeIssueSuggestionPrefix = activeIssueItem ? `${activeIssueItem.key}|||` : '';
  const activeIssueSuggestionLoadingLine = activeIssueSuggestionPrefix && issueSuggestionLoadingKey.startsWith(activeIssueSuggestionPrefix)
    ? issueSuggestionLoadingKey.slice(activeIssueSuggestionPrefix.length)
    : '';

  const isIssueItemAlreadyIssued = (item) => (
    issueAlreadyCreatedKeys.has(item.key)
    || issueAlreadyCreatedKeys.has(getMenuIssueMealGroupKey(item))
  );

  useEffect(() => {
    const routeIssueRequest = location.state?.issueProduction;
    if (!routeIssueRequest || routeIssueRequest.source !== 'menu_planning') {
      return;
    }

    setIssueSource(routeIssueRequest);
    setIssueMealView(normalizeIssueMealView(routeIssueRequest.meal_view));
    setIssueDialogOpen(true);
    setIssueFulfillmentStoreId('');
    setIssueNotes('');
    setIssueItems([]);
    setIssueSnapshots({});
    setIssueSuggestions({});
    setActionError('');
    setActionMessage('');
    if (routeIssueRequest.plan_date) {
      setSelectedDate(routeIssueRequest.plan_date);
    }
    if (routeIssueRequest.site_id) {
      setSelectedSite(routeIssueRequest.site_id);
    }
    navigate('/Production', { replace: true, state: {} });
  }, [location.state, navigate]);

  useEffect(() => {
    if (!issueDialogOpen) {
      return;
    }
    const currentStoreIsValid = issueFulfillmentStoreOptions.some(
      (store) => String(store.id) === String(issueFulfillmentStoreId || '')
    );
    if (currentStoreIsValid) {
      return;
    }
    setIssueFulfillmentStoreId(issueFulfillmentStoreOptions.length === 1 ? issueFulfillmentStoreOptions[0].id : '');
  }, [issueDialogOpen, issueFulfillmentStoreId, issueFulfillmentStoreOptions]);

  useEffect(() => {
    if (!issueDialogOpen || !issuePlan) {
      return;
    }
    const items = buildMenuPlanIssueItems(issuePlan, { mealView: issueMealView, recipes });
    setIssueItems((currentItems) => {
      const currentByKey = new Map(currentItems.map((item) => [item.key, item]));
      return items.map((item) => ({
        ...item,
        selected: currentByKey.has(item.key) ? currentByKey.get(item.key).selected : true,
        production_covers: currentByKey.get(item.key)?.production_covers ?? item.production_covers
      }));
    });
    setActiveIssueItemKey((current) => (items.some((item) => item.key === current) ? current : items[0]?.key || ''));
  }, [issueDialogOpen, issueMealView, issuePlan, recipes]);

  useEffect(() => {
    if (!issueDialogOpen || issueItems.length === 0 || !issueFulfillmentStoreId) {
      return;
    }
    setIssueSnapshots((currentSnapshots) => {
      const nextSnapshots = {};
      issueItems.forEach((item) => {
        const existingLines = currentSnapshots[item.key];
        if (Array.isArray(existingLines) && existingLines.length > 0) {
          nextSnapshots[item.key] = recalculateProductionIngredientSnapshot(existingLines, {
            ingredients,
            inventory,
            siteId: issueFulfillmentStoreId
          }).lines;
          return;
        }

        const recipe = recipes.find((entry) => String(entry.id) === String(item.recipe_id));
        nextSnapshots[item.key] = buildProductionIngredientSnapshot({
          recipe,
          recipes,
          ingredients,
          inventory,
          siteId: issueFulfillmentStoreId,
          targetServings: item.production_covers
        }).lines;
      });
      return nextSnapshots;
    });
  }, [ingredients, inventory, issueDialogOpen, issueFulfillmentStoreId, issueItems, recipes]);

  useEffect(() => {
    if (canViewAllAccessibleSites) {
      return;
    }

    const assignedProductionSite = productionSiteOptions.find(
      (site) => String(site.id) === String(assignedSiteId || '')
    );
    const fallbackSiteId = assignedProductionSite?.id || productionSiteOptions[0]?.id || '';
    setSelectedSite((current) => (current === 'all' || !current ? fallbackSiteId : current));
    setFormData((current) => ({
      ...current,
      site_id: current.site_id || fallbackSiteId
    }));
  }, [canViewAllAccessibleSites, assignedSiteId, productionSiteOptions]);

  useEffect(() => {
    if (!formData.site_id) return;
    const currentStoreIsValid = fulfillmentStoreOptions.some(
      (store) => String(store.id) === String(formData.fulfillment_store_id)
    );
    const nextStoreId = currentStoreIsValid
      ? formData.fulfillment_store_id
      : fulfillmentStoreOptions.length === 1
        ? fulfillmentStoreOptions[0].id
        : '';
    if (nextStoreId !== formData.fulfillment_store_id) {
      setFormData((current) => ({ ...current, fulfillment_store_id: nextStoreId }));
    }
  }, [formData.fulfillment_store_id, formData.site_id, fulfillmentStoreOptions]);

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status, fulfillmentStoreId = '' }) => {
      if (status === 'completed') {
        await base44.inventory.completeProduction(id, {
          fulfillment_store_id: fulfillmentStoreId || undefined
        });
        return;
      }

      if (status === 'in_progress') {
        await base44.productionWorkflow.start(id);
        return;
      }

      await base44.entities.Production.update(id, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'] });
      queryClient.invalidateQueries({ queryKey: ['productionConsumptionReports'] });
      queryClient.invalidateQueries({ queryKey: ['producedItemBatches'] });
      setCompletionOpen(false);
      setCompletionProduction(null);
      setCompletionFulfillmentStoreId('');
      setActionError('');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to update production status');
    }
  });

  const inventoryCommitmentMutation = useMutation({
    mutationFn: async ({ production, mode, targetServings, reason }) => {
      if (mode === 'cancel') {
        return base44.productionWorkflow.cancel(production.id, { reason });
      }
      return base44.productionWorkflow.adjustApprovedQuantity(production.id, {
        target_servings: Number(targetServings),
        expected_revision: Number(production.inventory_commitment_revision || 0),
        reason
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'] });
      setInventoryAction(null);
      setInventoryActionReason('');
      setInventoryActionServings(null);
      setActionError('');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to reconcile the approved production inventory reservation.');
    }
  });

  const resetForm = () => {
    setFormData({
      site_id: isAdmin
        ? ''
        : (productionSiteOptions.find((site) => String(site.id) === String(assignedSiteId || ''))?.id
          || productionSiteOptions[0]?.id
          || ''),
      fulfillment_store_id: '',
      production_date: format(new Date(), 'yyyy-MM-dd'),
      meal_type: 'lunch',
      menu_type: 'general',
      menu_category: 'senior',
      recipe_id: '',
      target_servings: null,
      kitchen_station: '',
      notes: ''
    });
    setEditingProduction(null);
    setCalculatedIngredients([]);
    setInventoryCheck([]);
    setEstimatedBatchCost(0);
    setEstimatedCostPerServing(0);
    setReviewFulfillmentStoreId('');
    setCompletionFulfillmentStoreId('');
    setSingleRecipeSuggestions({});
    setSingleRecipeSuggestionLoadingLine('');
  };

  // Calculate required ingredients and check inventory when recipe or servings change
  useEffect(() => {
    if (
      formData.recipe_id
      && formData.target_servings
      && formData.site_id
      && formData.fulfillment_store_id
    ) {
      const recipe = recipes.find(r => r.id === formData.recipe_id);
      const inventorySiteId = formData.fulfillment_store_id || formData.site_id;
      const editingFromSameSnapshot = editingProduction
        && String(editingProduction.recipe_id || '') === String(formData.recipe_id)
        && Number(editingProduction.target_servings || 0) === Number(formData.target_servings || 0)
        && Array.isArray(editingProduction.ingredients_used)
        && editingProduction.ingredients_used.length > 0;
      const snapshot = editingFromSameSnapshot
        ? recalculateProductionIngredientSnapshot(editingProduction.ingredients_used, {
          ingredients,
          inventory,
          siteId: inventorySiteId
        })
        : buildProductionIngredientSnapshot({
          recipe,
          recipes,
          ingredients,
          inventory,
          siteId: inventorySiteId,
          targetServings: formData.target_servings
        });
      const servingCount = Math.max(1, finiteProductionNumber(formData.target_servings, 0));
      setCalculatedIngredients(snapshot.lines);
      setInventoryCheck(snapshot.lines);
      setEstimatedBatchCost(snapshot.estimatedBatchCost || 0);
      setEstimatedCostPerServing(snapshot.estimatedCostPerServing ?? Number(((snapshot.estimatedBatchCost || 0) / servingCount).toFixed(2)));
    } else {
      setCalculatedIngredients([]);
      setInventoryCheck([]);
      setEstimatedBatchCost(0);
      setEstimatedCostPerServing(0);
    }
  }, [
    formData.fulfillment_store_id,
    formData.recipe_id,
    formData.target_servings,
    formData.site_id,
    editingProduction,
    recipes,
    ingredients,
    inventory
  ]);

  const filteredProductions = productions.filter(p => {
    const matchesSite = selectedSite === 'all'
      || p.site_id === selectedSite
      || p.fulfillment_store_id === selectedSite;
    const matchesDate = p.production_date === selectedDate;
    return matchesSite && matchesDate;
  });
  const areaApprovalQueue = getPendingAreaApprovalProductions(
    areaApprovalCandidates,
    isAdmin ? [] : allowedSiteIds
  );

  const materialRequestMap = materialRequests.reduce((map, request) => {
    if (request?.source_production_id && !map[request.source_production_id]) {
      map[request.source_production_id] = request;
    }
    return map;
  }, {});

  const recipeWasteInsights = useMemo(() => {
    const insights = new Map();

    productionHistory.forEach((production) => {
      const key = `${production.site_id || 'unknown'}::${production.recipe_id || 'unknown'}::${production.meal_type || 'unspecified'}`;
      if (!insights.has(key)) {
        insights.set(key, {
          key,
          recipe_id: production.recipe_id,
          recipe_name: production.recipe_name || 'Unknown recipe',
          site_id: production.site_id,
          meal_type: production.meal_type || 'unspecified',
          produced_servings: 0,
          waste_servings: 0,
          waste_cost: 0,
          avoidable_cost: 0
        });
      }
      const row = insights.get(key);
      row.produced_servings += toNumber(production.actual_servings || production.target_servings);
    });

    foodWaste.forEach((waste) => {
      const relatedProduction = waste.production_id
        ? productionHistory.find((production) => production.id === waste.production_id)
        : null;
      const siteId = waste.site_id || relatedProduction?.site_id || 'unknown';
      const recipeId = waste.recipe_id || relatedProduction?.recipe_id || 'unknown';
      const mealType = relatedProduction?.meal_type || 'unspecified';
      const key = `${siteId}::${recipeId}::${mealType}`;
      if (!insights.has(key)) {
        insights.set(key, {
          key,
          recipe_id: recipeId,
          recipe_name: waste.recipe_name || relatedProduction?.recipe_name || 'Unknown recipe',
          site_id: siteId,
          meal_type: mealType,
          produced_servings: 0,
          waste_servings: 0,
          waste_cost: 0,
          avoidable_cost: 0
        });
      }
      const row = insights.get(key);
      row.waste_servings += toNumber(waste.quantity);
      row.waste_cost += toNumber(waste.estimated_cost);
      if (waste.avoidable_type === 'avoidable' || waste.preventable) {
        row.avoidable_cost += toNumber(waste.estimated_cost);
      }
    });

    return insights;
  }, [foodWaste, productionHistory]);

  const selectedRecipeInsight = useMemo(() => {
    if (!formData.recipe_id || !formData.site_id) return null;
    const selectedRecipe = recipes.find((recipe) => recipe.id === formData.recipe_id);
    const key = `${formData.site_id}::${formData.recipe_id}::${formData.meal_type || 'unspecified'}`;
    const row = recipeWasteInsights.get(key);
    if (!row) {
      return {
        key,
        recipe_id: formData.recipe_id,
        recipe_name: selectedRecipe?.name || 'Selected recipe',
        site_id: formData.site_id,
        meal_type: formData.meal_type || 'unspecified',
        waste_servings: 0,
        waste_cost: 0,
        wasteRate: 0,
        recommendation: 'No waste history exists for this recipe at this project yet. Start with the planned serving count, monitor returns closely, and post waste after service so the system can build future reduction guidance.',
        actionTone: 'bg-sky-50 border-sky-200 text-sky-800'
      };
    }
    const wasteRate = row.produced_servings > 0 ? (row.waste_servings / row.produced_servings) * 100 : 0;
    let recommendation = 'Stable output. Maintain current production level.';
    let actionTone = 'bg-emerald-50 border-emerald-200 text-emerald-800';
    if (wasteRate >= 12 || row.avoidable_cost >= 75) {
      recommendation = `Reduce planned servings by 10-20% or split production into smaller batches. Historical waste is ${wasteRate.toFixed(1)}% with ${formatCurrency(row.waste_cost)} waste cost.`;
      actionTone = 'bg-red-50 border-red-200 text-red-800';
    } else if (row.produced_servings >= 50 && wasteRate <= 2 && row.waste_cost <= 15) {
      recommendation = `This recipe is running cleanly. Consider a small increase if demand is rising. Historical waste is only ${wasteRate.toFixed(1)}%.`;
      actionTone = 'bg-emerald-50 border-emerald-200 text-emerald-800';
    } else {
      recommendation = `Monitor this recipe closely. Historical waste is ${wasteRate.toFixed(1)}% with ${formatCurrency(row.waste_cost)} waste cost.`;
      actionTone = 'bg-amber-50 border-amber-200 text-amber-800';
    }
    return {
      ...row,
      wasteRate: Number(wasteRate.toFixed(2)),
      recommendation,
      actionTone
    };
  }, [formData.meal_type, formData.recipe_id, formData.site_id, recipeWasteInsights, recipes]);

  const buildSubmitData = (status) => {
    const site = visibleSites.find((s) => s.id === formData.site_id) || sites.find((s) => s.id === formData.site_id);
    const fulfillmentStore = sites.find((s) => s.id === formData.fulfillment_store_id);
    const recipe = recipes.find(r => r.id === formData.recipe_id);
    const productionOverrides = buildProductionOverrideAudit(calculatedIngredients);

    return {
      ...formData,
      cuisine_type: formData.menu_type,
      site_name: site?.name || '',
      fulfillment_store_id: fulfillmentStore?.id || '',
      fulfillment_store_name: fulfillmentStore?.name || '',
      recipe_name: recipe?.name || '',
      target_servings: Number(formData.target_servings) || 0,
      recipe_snapshot_mode: 'production_only_override',
      recipe_snapshot_locked: true,
      original_recipe_snapshot: calculatedIngredients.map((line, index) => {
        const isAdded = line.production_override_action === 'added';
        return {
          line_id: getProductionIngredientLineKey(line, index),
          ingredient_id: isAdded ? null : (line.original_ingredient_id || line.ingredient_id),
          ingredient_name: isAdded ? null : (line.original_ingredient_name || line.ingredient_name),
          quantity: isAdded ? 0 : (line.original_raw_quantity ?? line.raw_quantity),
          unit: isAdded ? null : (line.original_unit || line.unit)
        };
      }),
      ingredients_used: buildProductionIngredientsForSubmit(calculatedIngredients),
      production_overrides: productionOverrides,
      production_override_count: productionOverrides.length,
      total_calories: recipe?.calories_per_serving 
        ? recipe.calories_per_serving * Number(formData.target_servings)
        : 0,
      estimated_batch_cost: estimatedBatchCost,
      estimated_cost_per_serving: estimatedCostPerServing,
      status
    };
  };

  const handleSubmit = (e, status = 'draft') => {
    e.preventDefault();
    const form = e.currentTarget?.form || e.currentTarget;
    if (typeof form?.checkValidity === 'function' && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (
      !formData.site_id
      || !formData.fulfillment_store_id
      || !formData.production_date
      || !formData.recipe_id
    ) {
      setActionError('Complete the project/site, fulfillment store, production date, recipe, and servings before saving.');
      return;
    }
    if (normalizeSiteType(selectedProductionSite?.type) !== SITE_HIERARCHY_TYPES.PROJECT) {
      setActionError('Select a Project first, then choose its fulfillment Store.');
      return;
    }
    setActionError('');
    createMutation.mutate(buildSubmitData(status));
  };

  const getProductionStoreOptions = (production) => {
    const productionSite = sites.find((site) => String(site.id) === String(production?.site_id || ''));
    if (!productionSite) return [];
    if (normalizeSiteType(productionSite.type) === SITE_HIERARCHY_TYPES.STORE) {
      return productionSite.is_active === false ? [] : [productionSite];
    }
    return visibleSites.filter((site) => (
      site.is_active !== false
      && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
      && String(site.parent_site_id || '') === String(productionSite.id)
    ));
  };

  const buildProductionInventoryCheck = (production, fulfillmentStoreId = '') => {
    const inventorySiteId = fulfillmentStoreId || production?.fulfillment_store_id;
    if (!inventorySiteId) return [];
    const siteInventory = inventory.filter((item) => String(item.site_id) === String(inventorySiteId || ''));

    return production?.ingredients_used?.map((line) => {
      const inventoryItem = siteInventory.find((item) => item.ingredient_id === line.ingredient_id);
      const ingredientData = ingredients.find((ingredient) => ingredient.id === line.ingredient_id);
      const inventoryUnit = inventoryItem?.unit || ingredientData?.unit || line.unit;
      const requiredQuantity = convertIngredientQuantity(
        line.required_quantity
          ?? line.yield_adjusted_quantity
          ?? line.planned_quantity
          ?? line.adjusted_quantity
          ?? line.actual_quantity
          ?? 0,
        line.unit || inventoryUnit,
        inventoryUnit,
        ingredientData
      );
      const stockQuantities = getInventoryQuantities(inventoryItem);
      const availableStock = stockQuantities.available_quantity;
      const shortage = Math.max(0, requiredQuantity - availableStock);

      return {
        item_code: getItemCode(ingredientData, getItemCode(line)),
        ingredient_id: line.ingredient_id,
        ingredient_name: line.ingredient_name,
        adjusted_quantity: roundStandardDecimal(requiredQuantity, getRecipeQuantityPrecision(inventoryUnit)),
        on_hand_stock: roundStandardDecimal(stockQuantities.on_hand_quantity, getRecipeQuantityPrecision(inventoryUnit)),
        reserved_stock: roundStandardDecimal(stockQuantities.reserved_quantity, getRecipeQuantityPrecision(inventoryUnit)),
        available_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
        current_stock: roundStandardDecimal(availableStock, getRecipeQuantityPrecision(inventoryUnit)),
        shortage: roundStandardDecimal(shortage, getRecipeQuantityPrecision(inventoryUnit)),
        unit: inventoryUnit,
        inventory_unit: inventoryUnit,
        sufficient: availableStock >= requiredQuantity
      };
    }) || [];
  };

  const buildApprovedReservationPreview = (production, targetServings) => {
    const revisedServings = Number(targetServings);
    const currentServings = Number(production?.target_servings);
    const inventorySiteId = production?.fulfillment_store_id;
    if (
      !production
      || !inventorySiteId
      || !Number.isFinite(revisedServings)
      || revisedServings <= 0
      || !Number.isFinite(currentServings)
      || currentServings <= 0
    ) {
      return [];
    }

    const state = getProductionInventoryState(production);
    const siteInventory = inventory.filter((item) => String(item.site_id) === String(inventorySiteId));
    const sourceLines = state.lines.length > 0 ? state.lines : (production.ingredients_used || []);
    const servingFactor = revisedServings / currentServings;

    return sourceLines.map((line) => {
      const ingredientData = ingredients.find((ingredient) => String(ingredient.id) === String(line.ingredient_id));
      const inventoryItem = siteInventory.find((item) => String(item.ingredient_id) === String(line.ingredient_id));
      const inventoryUnit = inventoryItem?.unit || line.inventory_unit || ingredientData?.unit || line.unit || 'unit';
      const sourceUnit = line.inventory_unit || line.unit || inventoryUnit;
      const currentRequired = convertIngredientQuantity(
        line.desired_quantity
          ?? line.required_quantity
          ?? line.yield_adjusted_quantity
          ?? line.planned_quantity
          ?? line.adjusted_quantity
          ?? line.actual_quantity
          ?? 0,
        sourceUnit,
        inventoryUnit,
        ingredientData
      );
      const ownReserved = state.is_reserved
        ? convertIngredientQuantity(
          line.reserved_quantity ?? line.committed_quantity ?? 0,
          sourceUnit,
          inventoryUnit,
          ingredientData
        )
        : 0;
      const stock = getInventoryQuantities(inventoryItem);
      const revisedRequired = Math.max(0, currentRequired * servingFactor);
      // Aggregate availability excludes every active reservation. Add this
      // production's reservation back when evaluating its revised capacity.
      const totalCapacity = stock.available_quantity + ownReserved;
      const shortage = Math.max(0, revisedRequired - totalCapacity);
      const additionalReservation = Math.max(0, revisedRequired - ownReserved);
      const releaseQuantity = Math.max(0, ownReserved - revisedRequired);
      const precision = getRecipeQuantityPrecision(inventoryUnit);

      return {
        ingredient_id: line.ingredient_id,
        item_code: getItemCode(ingredientData, getItemCode(line)),
        ingredient_name: line.ingredient_name || ingredientData?.name || 'Ingredient',
        unit: inventoryUnit,
        revised_required: roundStandardDecimal(revisedRequired, precision),
        own_reserved: roundStandardDecimal(ownReserved, precision),
        free_available: roundStandardDecimal(stock.available_quantity, precision),
        total_capacity: roundStandardDecimal(totalCapacity, precision),
        additional_reservation: roundStandardDecimal(additionalReservation, precision),
        release_quantity: roundStandardDecimal(releaseQuantity, precision),
        shortage: roundStandardDecimal(shortage, precision),
        sufficient: shortage <= 0
      };
    });
  };

  const updateSingleRecipeLines = (updater) => {
    const nextLines = typeof updater === 'function' ? updater(calculatedIngredients) : updater;
    const inventorySiteId = formData.fulfillment_store_id || formData.site_id;
    const snapshot = recalculateProductionIngredientSnapshot(nextLines, {
      ingredients,
      inventory,
      siteId: inventorySiteId
    });
    const servingCount = Math.max(1, finiteProductionNumber(formData.target_servings, 0));
    setCalculatedIngredients(snapshot.lines);
    setInventoryCheck(snapshot.lines);
    setEstimatedBatchCost(snapshot.estimatedBatchCost || 0);
    setEstimatedCostPerServing(Number(((snapshot.estimatedBatchCost || 0) / servingCount).toFixed(2)));
  };

  const updateSingleLineQuantity = (lineKey, value) => {
    updateSingleRecipeLines((currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          raw_quantity: finiteProductionNumber(value, 0),
          production_override_source: 'chef',
          production_override_reason: 'Chef adjusted quantity for this production.'
        }
        : line
    )));
  };

  const updateSingleLineIngredient = (lineKey, ingredientId, ingredientRecord = null) => {
    const selectedIngredient = ingredientRecord || ingredients.find((ingredient) => String(ingredient.id) === String(ingredientId));
    if (!selectedIngredient) return;
    updateSingleRecipeLines((currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          ingredient_id: selectedIngredient.id,
          ingredient_name: selectedIngredient.name || line.ingredient_name,
          unit: selectedIngredient.unit || line.unit,
          inventory_unit: selectedIngredient.unit || line.inventory_unit,
          production_override_source: 'chef',
          production_override_reason: 'Chef selected replacement ingredient for this production.'
        }
        : line
    )));
    setSingleRecipeSuggestions((current) => ({ ...current, [lineKey]: [] }));
  };

  const zeroSingleLine = (lineKey) => {
    updateSingleRecipeLines((currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          raw_quantity: 0,
          production_override_action: 'zeroed',
          production_override_source: 'chef',
          production_override_reason: 'Chef zeroed this ingredient for this production.'
        }
        : line
    )));
    setSingleRecipeSuggestions((current) => ({ ...current, [lineKey]: [] }));
  };

  const addSingleIngredientLine = ({ ingredient_id: ingredientId, ingredient: ingredientRecord = null, quantity, unit }) => {
    const selectedIngredient = ingredientRecord || ingredients.find((ingredient) => String(ingredient.id) === String(ingredientId));
    if (!selectedIngredient) return;
    const inventorySiteId = formData.fulfillment_store_id || formData.site_id;
    const addedLine = buildProductionIngredientLine({
      sourceLine: {
        line_id: `added-${selectedIngredient.id}-${Date.now()}`,
        ingredient_id: selectedIngredient.id,
        ingredient_name: selectedIngredient.name || 'Ingredient',
        raw_quantity: quantity,
        unit: unit || selectedIngredient.unit || 'unit',
        original_ingredient_id: null,
        original_ingredient_name: '',
        original_raw_quantity: 0,
        original_unit: unit || selectedIngredient.unit || 'unit',
        production_override_action: 'added',
        production_override_source: 'chef',
        production_override_reason: 'Chef added this ingredient for this production.'
      },
      ingredient: selectedIngredient,
      inventory,
      siteId: inventorySiteId
    });
    updateSingleRecipeLines((currentLines) => [...currentLines, addedLine]);
  };

  const removeSingleIngredientLine = (lineKey) => {
    updateSingleRecipeLines((currentLines) => currentLines.filter((line, index) => (
      getProductionIngredientLineKey(line, index) !== lineKey || line.production_override_action !== 'added'
    )));
  };

  const normalizeReplacementSuggestions = (rawSuggestions, fallbackSuggestions) => {
    const fallbackById = new Map(fallbackSuggestions.map((suggestion) => [String(suggestion.ingredient_id), suggestion]));
    const fallbackByName = new Map(fallbackSuggestions.map((suggestion) => [String(suggestion.ingredient_name || '').trim().toLowerCase(), suggestion]));
    const normalized = (Array.isArray(rawSuggestions) ? rawSuggestions : [])
      .map((suggestion) => {
        const matched = fallbackById.get(String(suggestion.ingredient_id || ''))
          || fallbackByName.get(String(suggestion.ingredient_name || '').trim().toLowerCase());
        if (!matched) return null;
        return {
          ...matched,
          suggested_quantity: finiteProductionNumber(suggestion.suggested_quantity, matched.suggested_quantity),
          confidence: finiteProductionNumber(suggestion.confidence, matched.confidence),
          reason: suggestion.reason || matched.reason,
          warning: suggestion.warning || '',
          source: 'ai'
        };
      })
      .filter(Boolean);
    return normalized.length > 0 ? normalized : fallbackSuggestions;
  };

  const loadReplacementSuggestions = async (line, siteId) => {
    const fallbackSuggestions = buildInventoryReplacementSuggestions({
      line,
      ingredients,
      inventory,
      siteId,
      limit: 4
    });
    if (fallbackSuggestions.length === 0) {
      return [];
    }

    try {
      const result = await base44.integrations.Core.InvokeLLM({
        prompt: [
          'Suggest replacement ingredients for a production-only recipe snapshot in a food production system.',
          'Only choose from the available inventory candidates. Do not invent ingredients.',
          'Prefer culinary similarity, compatible units, and enough available stock. Mention allergy/dietary concerns when likely.',
          `Short ingredient: ${line.ingredient_name}, required ${formatRecipeQuantity(line.raw_quantity, line.unit)} ${line.unit}, shortage ${formatRecipeQuantity(line.shortage, line.inventory_unit)} ${line.inventory_unit}.`,
          `Available candidates: ${fallbackSuggestions.map((candidate) => `${candidate.ingredient_id} | ${candidate.ingredient_name} | ${formatRecipeQuantity(candidate.available_quantity, candidate.unit)} ${candidate.unit} available`).join('; ')}`
        ].join('\n'),
        response_json_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ingredient_id: { type: 'string' },
                  ingredient_name: { type: 'string' },
                  suggested_quantity: { type: 'number' },
                  confidence: { type: 'number' },
                  reason: { type: 'string' },
                  warning: { type: 'string' }
                },
                required: ['ingredient_id', 'ingredient_name', 'suggested_quantity', 'confidence', 'reason', 'warning']
              }
            }
          },
          required: ['suggestions']
        }
      });
      return normalizeReplacementSuggestions(result?.suggestions, fallbackSuggestions);
    } catch (_error) {
      return fallbackSuggestions.map((suggestion) => ({
        ...suggestion,
        reason: `${suggestion.reason} AI service is unavailable, so this fallback uses local inventory similarity.`
      }));
    }
  };

  const requestSingleRecipeSuggestions = async (lineKey) => {
    const line = calculatedIngredients.find((entry, index) => getProductionIngredientLineKey(entry, index) === lineKey);
    const inventorySiteId = formData.fulfillment_store_id || formData.site_id;
    if (!line || !inventorySiteId) return;
    setSingleRecipeSuggestionLoadingLine(lineKey);
    const suggestions = await loadReplacementSuggestions(line, inventorySiteId);
    setSingleRecipeSuggestions((current) => ({ ...current, [lineKey]: suggestions }));
    setSingleRecipeSuggestionLoadingLine('');
  };

  const applySingleRecipeSuggestion = (lineKey, suggestion) => {
    updateSingleRecipeLines((currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          ingredient_id: suggestion.ingredient_id,
          ingredient_name: suggestion.ingredient_name,
          raw_quantity: finiteProductionNumber(suggestion.suggested_quantity, line.raw_quantity),
          unit: suggestion.unit || line.unit,
          inventory_unit: suggestion.unit || line.inventory_unit,
          production_override_source: suggestion.source === 'ai' ? 'ai_suggestion' : 'inventory_similarity',
          production_override_reason: suggestion.reason || 'Replacement selected for this production.',
          ai_suggestion_reason: suggestion.reason || ''
        }
        : line
    )));
    setSingleRecipeSuggestions((current) => ({ ...current, [lineKey]: [] }));
  };

  const recalculateIssueItemSnapshot = (itemKey, nextLines) => {
    const snapshot = recalculateProductionIngredientSnapshot(nextLines, {
      ingredients,
      inventory,
      siteId: issueFulfillmentStoreId
    });
    setIssueSnapshots((current) => ({ ...current, [itemKey]: snapshot.lines }));
  };

  const updateIssueItemSnapshot = (itemKey, updater) => {
    const currentLines = issueSnapshots[itemKey] || [];
    const nextLines = typeof updater === 'function' ? updater(currentLines) : updater;
    recalculateIssueItemSnapshot(itemKey, nextLines);
  };

  const updateIssueLineQuantity = (itemKey, lineKey, value) => {
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          raw_quantity: finiteProductionNumber(value, 0),
          production_override_source: 'chef',
          production_override_reason: 'Chef adjusted quantity for this production.'
        }
        : line
    )));
  };

  const updateIssueLineIngredient = (itemKey, lineKey, ingredientId, ingredientRecord = null) => {
    const selectedIngredient = ingredientRecord || ingredients.find((ingredient) => String(ingredient.id) === String(ingredientId));
    if (!selectedIngredient) return;
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          ingredient_id: selectedIngredient.id,
          ingredient_name: selectedIngredient.name || line.ingredient_name,
          unit: selectedIngredient.unit || line.unit,
          inventory_unit: selectedIngredient.unit || line.inventory_unit,
          production_override_source: 'chef',
          production_override_reason: 'Chef selected replacement ingredient for this production.'
        }
        : line
    )));
    setIssueSuggestions((current) => ({
      ...current,
      [itemKey]: { ...(current[itemKey] || {}), [lineKey]: [] }
    }));
  };

  const zeroIssueLine = (itemKey, lineKey) => {
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          raw_quantity: 0,
          production_override_action: 'zeroed',
          production_override_source: 'chef',
          production_override_reason: 'Chef zeroed this ingredient for this production.'
        }
        : line
    )));
    setIssueSuggestions((current) => ({
      ...current,
      [itemKey]: { ...(current[itemKey] || {}), [lineKey]: [] }
    }));
  };

  const addIssueIngredientLine = (itemKey, { ingredient_id: ingredientId, ingredient: ingredientRecord = null, quantity, unit }) => {
    const selectedIngredient = ingredientRecord || ingredients.find((ingredient) => String(ingredient.id) === String(ingredientId));
    if (!selectedIngredient) return;
    const addedLine = buildProductionIngredientLine({
      sourceLine: {
        line_id: `added-${itemKey}-${selectedIngredient.id}-${Date.now()}`,
        ingredient_id: selectedIngredient.id,
        ingredient_name: selectedIngredient.name || 'Ingredient',
        raw_quantity: quantity,
        unit: unit || selectedIngredient.unit || 'unit',
        original_ingredient_id: null,
        original_ingredient_name: '',
        original_raw_quantity: 0,
        original_unit: unit || selectedIngredient.unit || 'unit',
        production_override_action: 'added',
        production_override_source: 'chef',
        production_override_reason: 'Chef added this ingredient for this production.'
      },
      ingredient: selectedIngredient,
      inventory,
      siteId: issueFulfillmentStoreId
    });
    updateIssueItemSnapshot(itemKey, (currentLines) => [...currentLines, addedLine]);
  };

  const removeIssueIngredientLine = (itemKey, lineKey) => {
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.filter((line, index) => (
      getProductionIngredientLineKey(line, index) !== lineKey || line.production_override_action !== 'added'
    )));
  };

  const requestIssueSuggestions = async (itemKey, lineKey, lineOverride = null) => {
    const line = lineOverride || (issueSnapshots[itemKey] || []).find((entry, index) => getProductionIngredientLineKey(entry, index) === lineKey);
    if (!line || !issueFulfillmentStoreId) return;
    setIssueSuggestionLoadingKey(`${itemKey}|||${lineKey}`);
    const suggestions = await loadReplacementSuggestions(line, issueFulfillmentStoreId);
    setIssueSuggestions((current) => ({
      ...current,
      [itemKey]: {
        ...(current[itemKey] || {}),
        [lineKey]: suggestions
      }
    }));
    setIssueSuggestionLoadingKey('');
  };

  const applyIssueSuggestion = (itemKey, lineKey, suggestion) => {
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          ingredient_id: suggestion.ingredient_id,
          ingredient_name: suggestion.ingredient_name,
          raw_quantity: finiteProductionNumber(suggestion.suggested_quantity, line.raw_quantity),
          unit: suggestion.unit || line.unit,
          inventory_unit: suggestion.unit || line.inventory_unit,
          production_override_source: suggestion.source === 'ai' ? 'ai_suggestion' : 'inventory_similarity',
          production_override_reason: suggestion.reason || 'Replacement selected for this production.',
          ai_suggestion_reason: suggestion.reason || ''
        }
        : line
    )));
    setIssueSuggestions((current) => ({
      ...current,
      [itemKey]: { ...(current[itemKey] || {}), [lineKey]: [] }
    }));
  };

  const handleIssueMealViewChange = (nextMealView) => {
    const normalizedMealView = normalizeIssueMealView(nextMealView);
    setIssueMealView(normalizedMealView);
    setIssueSnapshots({});
    setIssueSuggestions({});
  };

  const updateIssueCovers = (itemKey, value) => {
    const productionCovers = finiteProductionNumber(value, 0);
    setIssueItems((currentItems) => currentItems.map((item) => (
      item.key === itemKey ? { ...item, production_covers: productionCovers } : item
    )));
    const item = issueItems.find((entry) => entry.key === itemKey);
    const recipe = recipes.find((entry) => String(entry.id) === String(item?.recipe_id || ''));
    const snapshot = buildProductionIngredientSnapshot({
      recipe,
      recipes,
      ingredients,
      inventory,
      siteId: issueFulfillmentStoreId,
      targetServings: productionCovers
    });
    setIssueSnapshots((current) => ({ ...current, [itemKey]: snapshot.lines }));
    setIssueSuggestions((current) => ({ ...current, [itemKey]: {} }));
  };

  const toggleIssueItem = (itemKey, selected) => {
    setIssueItems((currentItems) => currentItems.map((item) => (
      item.key === itemKey ? { ...item, selected } : item
    )));
  };

  const getIssueItemSnapshotCost = (itemKey) => (
    (issueSnapshots[itemKey] || []).reduce((sum, line) => sum + finiteProductionNumber(line.estimated_cost, 0), 0)
  );

  const buildOriginalSnapshot = (lines = []) => lines.map((line, index) => {
    const isAdded = line.production_override_action === 'added';
    return {
      line_id: getProductionIngredientLineKey(line, index),
      ingredient_id: isAdded ? null : (line.original_ingredient_id || line.ingredient_id),
      ingredient_name: isAdded ? null : (line.original_ingredient_name || line.ingredient_name),
      quantity: isAdded ? 0 : (line.original_raw_quantity ?? line.raw_quantity),
      unit: isAdded ? null : (line.original_unit || line.unit)
    };
  });

  const buildMenuIssueSubmitData = (group, status) => {
    const firstItem = group.items[0] || {};
    const recipe = recipes.find((entry) => String(entry.id) === String(firstItem.recipe_id)) || {};
    const site = issueSite || visibleSites.find((entry) => String(entry.id) === String(group.site_id || firstItem.site_id));
    const fulfillmentStore = sites.find((entry) => String(entry.id) === String(issueFulfillmentStoreId));
    const lines = group.snapshot_lines || [];
    const estimatedBatchCost = Number((group.estimatedBatchCost || 0).toFixed(2));
    const servingCount = Math.max(1, finiteProductionNumber(group.production_covers, 0));
    const dishNames = group.items.map((item) => item.recipe_name).filter(Boolean);
    const menuIssueItems = group.items.map((item) => {
      const itemLines = issueSnapshots[item.key] || [];
      const itemBatchCost = Number(getIssueItemSnapshotCost(item.key).toFixed(2));
      const itemServingCount = Math.max(1, finiteProductionNumber(item.production_covers, 0));
      return {
        key: item.key,
        source_menu_plan_item_index: item.source_menu_plan_item_index,
        recipe_id: item.recipe_id,
        recipe_name: item.recipe_name,
        meal_type: item.meal_type,
        expected_servings: item.expected_servings,
        production_covers: finiteProductionNumber(item.production_covers, 0),
        planned_total_cost: item.planned_total_cost,
        estimated_batch_cost: itemBatchCost,
        estimated_cost_per_serving: Number((itemBatchCost / itemServingCount).toFixed(2)),
        original_recipe_snapshot: buildOriginalSnapshot(itemLines),
        ingredients_used: buildProductionIngredientsForSubmit(itemLines),
        production_overrides: buildProductionOverrideAudit(itemLines).map((entry) => ({
          ...entry,
          id: `${item.key}-${entry.id}`,
          recipe_id: item.recipe_id,
          recipe_name: item.recipe_name,
          source_menu_plan_item_key: item.key
        }))
      };
    });
    const productionOverrides = menuIssueItems.flatMap((item) => item.production_overrides || []);

    return {
      site_id: site?.id || group.site_id || firstItem.site_id || '',
      site_name: site?.name || group.site_name || firstItem.site_name || '',
      fulfillment_store_id: fulfillmentStore?.id || '',
      fulfillment_store_name: fulfillmentStore?.name || '',
      production_date: group.plan_date || firstItem.plan_date || issueSource?.plan_date || format(new Date(), 'yyyy-MM-dd'),
      meal_type: group.meal_type,
      menu_type: group.menu_type || issueSource?.menu_type || 'general',
      cuisine_type: group.menu_type || issueSource?.menu_type || 'general',
      menu_category: group.menu_category || issueSource?.menu_category || 'senior',
      recipe_id: firstItem.recipe_id,
      recipe_name: `${group.meal_label} Menu Production (${group.items.length} dish${group.items.length === 1 ? '' : 'es'})`,
      target_servings: finiteProductionNumber(group.production_covers, 0),
      kitchen_station: recipe.kitchen_station || recipe.station || '',
      notes: [
        `Issued from menu plan ${issuePlan?.plan_date || group.plan_date || ''} ${group.meal_label}.`,
        dishNames.length ? `Dishes: ${dishNames.join(', ')}` : '',
        issueNotes
      ].filter(Boolean).join('\n'),
      source_type: 'menu_plan',
      source_menu_plan_id: issuePlan?.id || group.source_menu_plan_id || issueSource?.menu_plan_id || '',
      source_menu_plan_item_key: group.key,
      source_menu_plan_item_keys: group.items.map((item) => item.key),
      source_menu_plan_item_index: firstItem.source_menu_plan_item_index,
      source_menu_plan_meal_type: group.meal_type,
      source_menu_plan_expected_servings: group.expected_servings,
      production_issue_grouped: true,
      production_issue_group_key: group.key,
      production_issue_scope: issueMealView,
      production_issue_dish_count: group.items.length,
      menu_issue_items: menuIssueItems,
      recipe_snapshot_mode: 'production_only_override',
      recipe_snapshot_locked: true,
      original_recipe_snapshot: buildOriginalSnapshot(lines),
      ingredients_used: buildProductionIngredientsForSubmit(lines),
      production_overrides: productionOverrides,
      production_override_count: productionOverrides.length,
      total_calories: group.items.reduce((sum, item) => {
        const itemRecipe = recipes.find((entry) => String(entry.id) === String(item.recipe_id)) || {};
        return sum + (itemRecipe?.calories_per_serving
          ? itemRecipe.calories_per_serving * finiteProductionNumber(item.production_covers, 0)
          : 0);
      }, 0),
      estimated_batch_cost: estimatedBatchCost,
      estimated_cost_per_serving: Number((estimatedBatchCost / servingCount).toFixed(2)),
      status
    };
  };

  const handleReview = async (action) => {
    if (!selectedProduction || reviewAction) return;

    if (action !== 'approve' && !reviewNotes.trim()) {
      setActionError('Review notes are required when requesting changes or rejecting production.');
      return;
    }
    if (action === 'approve' && !reviewFulfillmentStoreId) {
      setActionError('Select the fulfillment Store before approving this production request.');
      return;
    }

    setReviewAction(action);
    try {
      const reviewTargets = selectedProduction.is_menu_review_group
        && Array.isArray(selectedProduction.grouped_productions)
        && selectedProduction.grouped_productions.length > 0
        ? selectedProduction.grouped_productions
        : [selectedProduction];

      const reviewOperations = reviewTargets.map((production) => {
        const areaReview = isAreaApprovalReview(production);
        if (action === 'approve' && areaReview) {
          return {
            type: 'area_approval',
            production
          };
        }
        const status = action === 'approve'
          ? 'pending_procurement'
          : action === 'request_changes'
            ? 'changes_requested'
            : getProductionRejectionReturnStatus(production.status);
        if (!status) {
          throw new Error('This production request cannot be returned from its current stage.');
        }
        return {
          type: 'status_update',
          production,
          status
        };
      });

      for (const operation of reviewOperations) {
        if (operation.type === 'area_approval') {
          await base44.productionWorkflow.approveForArea(operation.production.id, {
            notes: reviewNotes || null,
            fulfillment_store_id: reviewFulfillmentStoreId
          });
          continue;
        }
        await base44.entities.Production.update(operation.production.id, {
          status: operation.status,
          review_notes: reviewNotes || null,
          review_action: action === 'approve'
            ? 'approved'
            : action === 'reject'
              ? 'rejected'
              : 'changes_requested',
          ...(action === 'reject' ? { rejection_reason: reviewNotes.trim() } : {}),
          ...(action === 'approve' ? { fulfillment_store_id: reviewFulfillmentStoreId } : {})
        });
      }
      queryClient.invalidateQueries({ queryKey: ['productions'] });
      queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights'] });
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'] });
      setShowApprovalDialog(false);
      setSelectedProduction(null);
      setReviewNotes('');
      setReviewFulfillmentStoreId('');
      setActionError('');
    } catch (error) {
      setActionError(error.message || 'Unable to review the production request.');
    } finally {
      setReviewAction('');
    }
  };

  const openApprovalDialog = (production) => {
    const storeOptions = getProductionStoreOptions(production);
    const fulfillmentStoreId = storeOptions.some(
      (store) => String(store.id) === String(production.fulfillment_store_id || '')
    )
      ? production.fulfillment_store_id
      : storeOptions.length === 1
        ? storeOptions[0].id
        : '';

    setReviewFulfillmentStoreId(fulfillmentStoreId);
    setInventoryCheck(buildProductionInventoryCheck(production, fulfillmentStoreId));
    setActionError('');
    setSelectedProduction(production);
    setReviewNotes('');
    setReviewAction('');
    setShowApprovalDialog(true);
  };

  const openEditDialog = (production) => {
    const menuType = normalizeMenuCuisine(production.menu_type || production.cuisine_type, 'general');
    const menuCategories = getMenuCategoryOptions(menuType);
    const persistedMenuCategory = normalizeMenuCategory(production.menu_category, 'senior');
    setActionError('');
    setEditingProduction(production);
    setFormData({
      site_id: production.site_id || '',
      fulfillment_store_id: production.fulfillment_store_id || '',
      production_date: production.production_date || format(new Date(), 'yyyy-MM-dd'),
      meal_type: production.meal_type || 'lunch',
      menu_type: menuType,
      menu_category: menuCategories.some((option) => option.value === persistedMenuCategory)
        ? persistedMenuCategory
        : menuCategories[0]?.value || 'senior',
      recipe_id: production.recipe_id || '',
      target_servings: Number(production.target_servings) || null,
      kitchen_station: production.kitchen_station || production.assigned_station || production.station || '',
      notes: production.notes || ''
    });
    setFormOpen(true);
  };

  const openCompletionDialog = (production) => {
    const storeOptions = getProductionStoreOptions(production);
    const fulfillmentStoreId = storeOptions.some(
      (store) => String(store.id) === String(production.fulfillment_store_id || '')
    )
      ? production.fulfillment_store_id
      : storeOptions.length === 1
        ? storeOptions[0].id
        : '';
    setCompletionProduction(production);
    setCompletionFulfillmentStoreId(fulfillmentStoreId);
    setActionError('');
    setCompletionOpen(true);
  };

  const openConsumptionReport = async (production) => {
    const reportId = production.consumption_report_id;
    if (!reportId || reportLoadingId) return;
    setReportLoadingId(String(production.id));
    setActionError('');
    try {
      const report = await base44.entities.ProductionConsumptionReport.get(reportId);
      setSelectedConsumptionReport(report);
    } catch (error) {
      setActionError(error.message || 'Unable to load the production consumption report.');
    } finally {
      setReportLoadingId('');
    }
  };

  const openInventoryAction = (production, mode) => {
    setInventoryAction(production);
    setInventoryActionMode(mode);
    setInventoryActionServings(Number(production.target_servings) || null);
    setInventoryActionReason('');
    setActionError('');
  };

  const isStatusActionPending = (production, status) => (
    updateStatusMutation.isPending
    && String(updateStatusMutation.variables?.id || '') === String(production.id)
    && updateStatusMutation.variables?.status === status
  );

  const renderProductionActions = (production) => {
    const approvalHistory = getProductionApprovalHistory(production);
    const startBlockReason = getProductionStartBlockReason(production);
    const productionInventoryState = getProductionInventoryState(production);
    const startActionLabel = productionInventoryState.is_legacy_consumption
      ? 'Start Production (Legacy Stock Already Deducted)'
      : productionInventoryState.is_reserved
        ? 'Start Production & Consume Reserved Stock'
        : 'Start Production & Consume Stock';
    return (
      <div className="grid gap-2 sm:grid-cols-2">
      {['draft', 'planned', 'changes_requested'].includes(production.status) && can('edit_production_request') ? (
        <Button size="sm" variant="outline" className="justify-center whitespace-normal text-xs leading-snug" onClick={() => openEditDialog(production)}>
          Edit Request
        </Button>
      ) : null}
      {['draft', 'planned', 'changes_requested'].includes(production.status) && can('submit_production_request') ? (
        <Button
          size="sm"
          onClick={() => updateStatusMutation.mutate({
            id: production.id,
            status: 'pending_approval',
            production
          })}
          disabled={updateStatusMutation.isPending}
          className="justify-center whitespace-normal bg-amber-600 text-xs leading-snug hover:bg-amber-700"
        >
          Submit to Project Manager
        </Button>
      ) : null}
      {production.status === 'pending_approval'
        && can('review_production_request')
        && (can('approve_production_request') || can('request_changes_production') || can('reject_production_request')) ? (
        <Button size="sm" className="justify-center whitespace-normal bg-green-600 text-xs leading-snug hover:bg-green-700" onClick={() => openApprovalDialog(production)}>
          Review Request
        </Button>
      ) : null}
      {isAreaApprovalReview(production) && canReviewAreaApprovals ? (
        <Button size="sm" className="justify-center whitespace-normal bg-purple-700 text-xs leading-snug hover:bg-purple-800" onClick={() => openApprovalDialog(production)}>
          Area Manager Review
        </Button>
      ) : null}
      {production.status === 'pending_production' && can('start_production') ? (
        <Button size="sm" variant="outline" className="justify-center whitespace-normal text-xs leading-snug" disabled title={startBlockReason}>
          Area Approval Required
        </Button>
      ) : null}
      {production.status === 'approved' && can('start_production') ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateStatusMutation.mutate({
            id: production.id,
            status: 'in_progress',
            production
          })}
          disabled={!canStartApprovedProduction(production) || isStatusActionPending(production, 'in_progress')}
          title={!canStartApprovedProduction(production) ? startBlockReason : undefined}
          className="justify-center whitespace-normal text-xs leading-snug"
        >
          {isStatusActionPending(production, 'in_progress') ? 'Starting & Consuming...' : startActionLabel}
        </Button>
      ) : null}
      {production.status === 'approved' && (can('adjust_approved_production') || can('approve_production')) ? (
        <Button size="sm" variant="outline" className="justify-center whitespace-normal text-xs leading-snug" onClick={() => openInventoryAction(production, 'adjust')}>
          Adjust Approved Quantity
        </Button>
      ) : null}
      {production.status === 'approved' && can('cancel_production') ? (
        <Button
          size="sm"
          variant="outline"
          className="justify-center whitespace-normal border-red-200 text-xs leading-snug text-red-700 hover:bg-red-50"
          onClick={() => openInventoryAction(production, 'cancel')}
        >
          Cancel & Release Reservation
        </Button>
      ) : null}
      {production.status === 'in_progress' && can('complete_production') ? (
        <Button
          size="sm"
          onClick={() => openCompletionDialog(production)}
          disabled={isStatusActionPending(production, 'completed')}
          className="justify-center whitespace-normal bg-emerald-600 text-xs leading-snug hover:bg-emerald-700"
        >
          {isStatusActionPending(production, 'completed') ? 'Completing...' : 'Reconcile & Complete'}
        </Button>
      ) : null}
      {production.status === 'completed' && production.consumption_report_id ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openConsumptionReport(production)}
          disabled={Boolean(reportLoadingId)}
          className="justify-center whitespace-normal text-xs leading-snug"
        >
          <FileText className="mr-1.5 h-4 w-4" />
          {reportLoadingId === String(production.id) ? 'Loading Report...' : 'Consumption Report'}
        </Button>
      ) : null}
      {approvalHistory.length > 0 ? (
        <Button size="sm" variant="ghost" className="justify-center whitespace-normal text-xs leading-snug" onClick={() => setHistoryProduction(production)}>
          <History className="mr-1.5 h-4 w-4" />
          Approval History
        </Button>
      ) : null}
      </div>
    );
  };

  const loadError = actionError
    || productionsError?.message
    || sitesError?.message
    || recipesError?.message
    || ingredientsError?.message
    || inventoryError?.message
    || materialRequestsError?.message
    || issuePlanError?.message
    || '';
  const selectedIsAreaReview = isAreaApprovalReview(selectedProduction);
  const inventoryActionState = getProductionInventoryState(inventoryAction || {});
  const inventoryActionPreview = inventoryActionMode === 'adjust'
    ? buildApprovedReservationPreview(inventoryAction, inventoryActionServings)
    : [];
  const inventoryActionHasShortage = inventoryActionPreview.some((line) => !line.sufficient);
  const inventoryActionReservedLineCount = inventoryActionState.lines.filter(
    (line) => Number(line.reserved_quantity ?? line.committed_quantity ?? 0) > 0
  ).length;
  const selectedReviewStoreOptions = selectedProduction
    ? getProductionStoreOptions(selectedProduction)
    : [];
  const completionStoreOptions = completionProduction
    ? getProductionStoreOptions(completionProduction)
    : [];
  const completionRecipe = recipes.find(
    (recipe) => String(recipe.id) === String(completionProduction?.recipe_id || '')
  ) || {};
  const completionYieldSummary = buildAutomaticProductionYieldSummary({
    production: completionProduction || {},
    recipe: completionRecipe,
    ingredients
  });
  const completionPortionSizeGrams = Number(completionYieldSummary.portion_size_grams);
  const completionExpectedWeightGrams = Number(completionYieldSummary.expected_finished_weight_grams);
  const summarizedYieldServings = Number(completionYieldSummary.expected_yield_servings);
  const completionDerivedServings = Number.isFinite(summarizedYieldServings)
    && summarizedYieldServings > 0
    ? summarizedYieldServings
    : null;
  const completionRawReconciliation = (Array.isArray(completionProduction?.ingredients_used)
    ? completionProduction.ingredients_used
    : []).map((line, index) => ({
    ingredient_id: line.ingredient_id,
    item_code: line.item_code || getItemCode(
      ingredients.find((item) => String(item.id) === String(line.ingredient_id)),
      ''
    ),
    ingredient_name: line.ingredient_name || ingredients.find(
      (item) => String(item.id) === String(line.ingredient_id)
    )?.name || 'Ingredient',
    planned_quantity: Number(
      line.planned_quantity
        ?? line.required_quantity
        ?? line.raw_quantity
        ?? line.adjusted_quantity
        ?? line.cost_quantity
        ?? line.quantity
        ?? 0
    ),
    unit: line.unit || 'unit',
    yield_percent: Number(
      completionYieldSummary.line_weights[index]?.yield_percent
        ?? line.yield_percent
        ?? 100
    ),
    yielded_weight_grams: completionYieldSummary.line_weights[index]?.yielded_weight_grams ?? null,
    reconciliation_source: completionYieldSummary.line_weights[index]?.source || 'automatic_yield_plan'
  }));
  const canRequestSelectedChanges = selectedIsAreaReview
    ? can('request_changes_area_production')
    : can('review_production_request') && can('request_changes_production');
  const canRejectSelected = selectedIsAreaReview
    ? can('reject_area_production')
    : can('review_production_request') && can('reject_production_request');
  const canApproveSelected = selectedIsAreaReview
    ? can('approve_production')
    : can('review_production_request') && can('approve_production_request');
  const siteOptions = canViewAllAccessibleSites
    ? [{ id: 'all', name: 'All Sites' }, ...productionSiteOptions]
    : productionSiteOptions;
  const selectedIssueSubmitItems = issueItems.filter((item) => (
    item.selected
    && !isIssueItemAlreadyIssued(item)
    && Number(item.production_covers) > 0
  ));
  const selectedIssueMealGroups = buildMenuIssueMealGroups(selectedIssueSubmitItems, {
    snapshotsByItemKey: issueSnapshots,
    ingredients,
    inventory,
    siteId: issueFulfillmentStoreId
  });
  const selectedIssueDailyLines = aggregateProductionIngredientLines(
    selectedIssueMealGroups.flatMap((group) => group.snapshot_lines || []),
    {
      ingredients,
      inventory,
      siteId: issueFulfillmentStoreId
    }
  );
  const selectedIssueDailyShortages = selectedIssueDailyLines.filter((line) => !line.sufficient);
  const selectedIssueItemKeys = new Set(selectedIssueSubmitItems.map((item) => item.key));
  const selectedIssueShortagesByItemKey = selectedIssueDailyShortages.reduce((accumulator, line) => {
    const sourceItemKeys = (Array.isArray(line.source_menu_plan_item_keys)
      ? line.source_menu_plan_item_keys
      : []
    ).filter((itemKey) => selectedIssueItemKeys.has(itemKey));
    sourceItemKeys.forEach((itemKey) => {
      accumulator[itemKey] = [...(accumulator[itemKey] || []), line];
    });
    return accumulator;
  }, {});
  const activeIssueAggregateShortageLines = activeIssueItem
    ? selectedIssueShortagesByItemKey[activeIssueItem.key] || []
    : [];
  const activeIssueAggregateShortageByIngredientId = new Map(activeIssueAggregateShortageLines.map((line) => [
    String(line.ingredient_id || ''),
    line
  ]));
  const activeIssueSnapshotForEditor = activeIssueSnapshot.map((line) => {
    const aggregateShortage = activeIssueAggregateShortageByIngredientId.get(String(line.ingredient_id || ''));
    if (!aggregateShortage) return line;
    return {
      ...line,
      sufficient: false,
      shortage: aggregateShortage.shortage ?? line.shortage,
      inventory_unit: aggregateShortage.inventory_unit || aggregateShortage.unit || line.inventory_unit || line.unit,
      on_hand_stock: aggregateShortage.on_hand_stock ?? line.on_hand_stock,
      reserved_stock: aggregateShortage.reserved_stock ?? line.reserved_stock,
      available_stock: aggregateShortage.available_stock ?? line.available_stock,
      current_stock: aggregateShortage.current_stock ?? aggregateShortage.available_stock ?? line.current_stock,
      aggregate_shortage: true,
      aggregate_required_quantity: aggregateShortage.raw_quantity ?? aggregateShortage.required_quantity,
      aggregate_source_recipe_names: aggregateShortage.source_recipe_names || []
    };
  });
  const activeIssueBatchCost = activeIssueItem ? Number(getIssueItemSnapshotCost(activeIssueItem.key).toFixed(2)) : 0;
  const activeIssueCostPerServing = activeIssueItem
    ? Number((activeIssueBatchCost / Math.max(1, finiteProductionNumber(activeIssueItem.production_covers, 0))).toFixed(2))
    : 0;
  const issueSubmitDisabledReason = !can('create_production_request')
    ? 'You need production creation permission to issue production.'
    : !issueFulfillmentStoreId
      ? 'Select the fulfillment Store before issuing production.'
      : selectedIssueMealGroups.length === 0
        ? 'Select at least one planned meal item that has not already been issued.'
        : '';

  return (
    <>
      {actionMessage ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {actionMessage}
        </div>
      ) : null}
      <ProductionPlanningDashboard
        productions={filteredProductions}
        recipes={recipes}
        ingredients={ingredients}
        inventory={inventory}
        sites={siteOptions}
        selectedDate={selectedDate}
        selectedSite={selectedSite}
        onDateChange={setSelectedDate}
        onSiteChange={setSelectedSite}
        materialRequestMap={materialRequestMap}
        isLoading={isLoading}
        errorMessage={loadError}
        canCreate={can('create_production_request')}
        onNewProduction={() => {
          resetForm();
          setActionError('');
          setFormData((current) => ({
            ...current,
            production_date: selectedDate,
            site_id: selectedSite === 'all' ? '' : selectedSite,
            fulfillment_store_id: ''
          }));
          setFormOpen(true);
        }}
        onExport={(dashboard) => downloadCSV(
          buildProductionPlanExportRows(dashboard),
          `production_plan_${selectedDate}`
        )}
        onPrint={() => window.print()}
        renderActions={renderProductionActions}
        showAreaApprovalQueue={canReviewAreaApprovals}
        areaApprovalQueue={areaApprovalQueue}
        isAreaApprovalQueueLoading={isAreaApprovalQueueLoading}
        areaApprovalQueueError={areaApprovalQueueError?.message || ''}
        onReviewAreaApproval={openApprovalDialog}
        onViewApprovalHistory={setHistoryProduction}
      />

        {/* Form Dialog */}
        <Dialog
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) {
              resetForm();
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingProduction ? 'Edit Production Request' : 'Plan New Production'}</DialogTitle>
            </DialogHeader>
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </div>
            ) : null}
            <form onSubmit={(event) => handleSubmit(event, editingProduction ? editingProduction.status || 'draft' : 'draft')} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="site">Project / Production Site *</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData({
                      ...formData,
                      site_id: value,
                      fulfillment_store_id: ''
                    })}
                  >
                    <SelectTrigger id="site" className="mt-1">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {productionSiteOptions.map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="fulfillment_store">Fulfillment Store *</Label>
                  <Select
                    value={formData.fulfillment_store_id}
                    onValueChange={(value) => setFormData({ ...formData, fulfillment_store_id: value })}
                    disabled={!formData.site_id || fulfillmentStoreOptions.length === 0}
                  >
                    <SelectTrigger id="fulfillment_store" className="mt-1">
                      <SelectValue placeholder={
                        !formData.site_id
                          ? 'Select a project first'
                          : fulfillmentStoreOptions.length === 0
                            ? 'No store configured under this project'
                            : 'Select fulfillment store'
                      } />
                    </SelectTrigger>
                    <SelectContent>
                      {fulfillmentStoreOptions.map((store) => (
                        <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formData.site_id && fulfillmentStoreOptions.length === 0 ? (
                    <p className="mt-1 text-xs text-red-600">
                      Add a Store under this Project before creating production.
                    </p>
                  ) : null}
                </div>

                <div>
                  <Label htmlFor="date">Production Date *</Label>
                  <Input
                    id="date"
                    type="date"
                    value={formData.production_date}
                    onChange={(e) => setFormData({ ...formData, production_date: e.target.value })}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="meal_type">Meal Period *</Label>
                  <Select
                    value={formData.meal_type}
                    onValueChange={(value) => setFormData({ ...formData, meal_type: value })}
                  >
                    <SelectTrigger id="meal_type" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEAL_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="menu_type">Menu Type *</Label>
                  <Select
                    value={formData.menu_type}
                    onValueChange={(value) => {
                      const categories = getMenuCategoryOptions(value);
                      setFormData((current) => ({
                        ...current,
                        menu_type: value,
                        menu_category: categories.some((option) => option.value === current.menu_category)
                          ? current.menu_category
                          : categories[0]?.value || 'senior'
                      }));
                    }}
                  >
                    <SelectTrigger id="menu_type" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MENU_CUISINE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="menu_category">Menu Category *</Label>
                  <Select
                    value={formData.menu_category}
                    onValueChange={(value) => setFormData({ ...formData, menu_category: value })}
                  >
                    <SelectTrigger id="menu_category" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getMenuCategoryOptions(formData.menu_type).map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="recipe">Recipe *</Label>
                  <Select
                    value={formData.recipe_id}
                    onValueChange={(value) => {
                      const selectedRecipe = recipes.find((recipe) => recipe.id === value);
                      setFormData({
                        ...formData,
                        recipe_id: value,
                        kitchen_station: formData.kitchen_station
                          || selectedRecipe?.kitchen_station
                          || selectedRecipe?.station
                          || ''
                      });
                    }}
                  >
                    <SelectTrigger id="recipe" className="mt-1">
                      <SelectValue placeholder="Select recipe" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipes.map(recipe => (
                        <SelectItem key={recipe.id} value={recipe.id}>
                          {recipe.name}{recipe.recipe_code ? ` (${recipe.recipe_code})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="servings">Target Servings *</Label>
                  <StandardDecimalInput
                    id="servings"
                    value={formData.target_servings}
                    unit="servings"
                    precision={0}
                    min={0}
                    allowZero={false}
                    allowEmpty={false}
                    label="Target servings"
                    onValueChange={(value) => setFormData((current) => ({ ...current, target_servings: value }))}
                    placeholder="Number of servings to produce"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="kitchen_station">Kitchen Station</Label>
                  <Input
                    id="kitchen_station"
                    value={formData.kitchen_station}
                    onChange={(event) => setFormData({ ...formData, kitchen_station: event.target.value })}
                    placeholder="Optional, e.g. Hot Line, Grill, Cold Prep"
                    className="mt-1"
                  />
                </div>
              </div>

              {selectedRecipeInsight ? (
                <div className={`rounded-lg border px-4 py-3 ${selectedRecipeInsight.actionTone}`}>
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4" />
                    <p className="font-medium">Waste Reduction Intelligence</p>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg bg-white/80 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Historical Waste Rate</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{selectedRecipeInsight.wasteRate}%</p>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Wasted Servings</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{selectedRecipeInsight.waste_servings.toFixed(1)}</p>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Waste Cost</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{formatCurrency(selectedRecipeInsight.waste_cost)}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm">{selectedRecipeInsight.recommendation}</p>
                </div>
              ) : null}

              {/* Calculated Ingredients with Inventory Check */}
              {calculatedIngredients.length > 0 && (
                <ProductionIngredientSnapshotEditor
                  lines={calculatedIngredients}
                  ingredients={ingredients}
                  inventorySiteId={formData.fulfillment_store_id || formData.site_id}
                  suggestionsByLine={singleRecipeSuggestions}
                  suggestionLoadingLine={singleRecipeSuggestionLoadingLine}
                  estimatedBatchCost={estimatedBatchCost}
                  estimatedCostPerServing={estimatedCostPerServing}
                  onLineQuantityChange={updateSingleLineQuantity}
                  onLineIngredientChange={updateSingleLineIngredient}
                  onZeroLine={zeroSingleLine}
                  onAddIngredient={addSingleIngredientLine}
                  onRemoveLine={removeSingleIngredientLine}
                  onRequestSuggestions={requestSingleRecipeSuggestions}
                  onApplySuggestion={applySingleRecipeSuggestion}
                />
              )}
              {calculatedIngredients.length > 0 && (
                <>
                  {calculatedIngredients.some(ing => !ing.sufficient) && (
                    <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-sm text-amber-800">
                        <strong>Note:</strong> A linked material request will be created with this production request and released to procurement after approval.
                      </p>
                    </div>
                  )}
                </>
              )}

              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Additional notes..."
                  className="mt-1"
                  rows={3}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); }}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="border-slate-300"
                  disabled={createMutation.isPending}
                  onClick={(event) => handleSubmit(event, 'draft')}
                >
                  {createMutation.isPending ? 'Saving...' : editingProduction ? 'Save Draft' : 'Create Draft'}
                </Button>
                <Button 
                  type="button" 
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={createMutation.isPending}
                  onClick={(event) => handleSubmit(event, 'pending_approval')}
                >
                  {createMutation.isPending ? 'Submitting...' : editingProduction ? 'Save & Submit' : 'Create & Submit'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Menu Planning Issue Dialog */}
        <Dialog
          open={issueDialogOpen}
          onOpenChange={(open) => {
            setIssueDialogOpen(open);
            if (!open) {
              setIssueSource(null);
              setIssueItems([]);
              setIssueSnapshots({});
              setIssueSuggestions({});
              setIssueNotes('');
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-h-[92vh] w-[96vw] max-w-[1500px] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex flex-col gap-2 text-xl sm:flex-row sm:items-center sm:justify-between">
                <span>Issue Menu Production</span>
                <Badge variant="outline" className="w-fit border-indigo-200 bg-indigo-50 text-indigo-700">
                  Production-only recipe snapshots
                </Badge>
              </DialogTitle>
            </DialogHeader>

            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </div>
            ) : null}

            {issuePlanLoading ? (
              <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 px-6 py-14 text-slate-600">
                <Sparkles className="mr-2 h-5 w-5 animate-pulse text-indigo-600" />
                Loading saved menu plan...
              </div>
            ) : !issuePlan ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
                The saved menu plan could not be loaded. Return to Menu Planning, save the plan, then issue production again.
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
                  <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-3">
                    <div className="rounded-xl bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Project / site</p>
                      <p className="mt-1 break-words font-semibold text-slate-900">{issueSite?.name || issuePlan.site_name || issueSource?.site_name || 'Selected project'}</p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Production date</p>
                      <p className="mt-1 font-semibold text-slate-900">{issuePlan.plan_date || issueSource?.plan_date || selectedDate}</p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Selected scope</p>
                      <p className="mt-1 font-semibold text-slate-900">
                        {issueMealView === 'all' ? 'Breakfast, Lunch, Dinner' : PRODUCTION_ISSUE_MEAL_LABELS[issueMealView]}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <Label htmlFor="issue-fulfillment-store">Fulfillment Store *</Label>
                    <Select
                      value={issueFulfillmentStoreId}
                      onValueChange={(value) => {
                        setIssueFulfillmentStoreId(value);
                        setIssueSnapshots({});
                        setIssueSuggestions({});
                      }}
                      disabled={issueFulfillmentStoreOptions.length === 0}
                    >
                      <SelectTrigger id="issue-fulfillment-store" className="mt-2 bg-white">
                        <SelectValue placeholder={
                          issueFulfillmentStoreOptions.length === 0
                            ? 'No store configured'
                            : 'Select fulfillment store'
                        } />
                      </SelectTrigger>
                      <SelectContent>
                        {issueFulfillmentStoreOptions.map((store) => (
                          <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {issueFulfillmentStoreOptions.length === 0 ? (
                      <p className="mt-2 text-xs text-red-600">Configure an active Store under this Project before issuing production.</p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <p className="font-semibold text-slate-900">Meal scope</p>
                      <p className="mt-1 text-sm text-slate-500">Choose all three meals or focus the issue run on one meal period.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant={issueMealView === 'all' ? 'default' : 'outline'}
                        onClick={() => handleIssueMealViewChange('all')}
                      >
                        All meals
                      </Button>
                      {PRODUCTION_ISSUE_MEAL_TYPES.map((mealType) => (
                        <Button
                          key={mealType}
                          type="button"
                          variant={issueMealView === mealType ? 'default' : 'outline'}
                          onClick={() => handleIssueMealViewChange(mealType)}
                        >
                          {PRODUCTION_ISSUE_MEAL_LABELS[mealType]}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="font-semibold text-indigo-950">Meal review requests to create</p>
                      <p className="mt-1 text-sm text-indigo-800">
                        One review is created per meal type for this production day. Shortage checks below use the same aggregate demand that will appear on the dashboard.
                      </p>
                    </div>
                  <Badge variant="outline" className="w-fit border-indigo-200 bg-white text-indigo-700">
                    {selectedIssueMealGroups.length} review{selectedIssueMealGroups.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                  {selectedIssueMealGroups.length > 0 ? (
                    <div className={`mt-3 rounded-xl border px-3 py-2.5 ${
                      selectedIssueDailyShortages.length > 0
                        ? 'border-red-200 bg-red-50 text-red-900'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    }`}>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold">Selected-day store check</p>
                          <p className="mt-1 text-xs">
                            Aggregates all selected Breakfast, Lunch, and Dinner ingredient demand against the selected fulfillment Store before creating the meal review requests.
                          </p>
                        </div>
                        <Badge className={selectedIssueDailyShortages.length > 0 ? 'bg-red-600' : 'bg-emerald-600'}>
                          {selectedIssueDailyShortages.length > 0
                            ? `${selectedIssueDailyShortages.length} shortage${selectedIssueDailyShortages.length === 1 ? '' : 's'}`
                            : 'No shortages'}
                        </Badge>
                      </div>
                      {selectedIssueDailyShortages.length > 0 ? (
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          {selectedIssueDailyShortages.slice(0, 4).map((line) => {
                            const sourceItemKeys = (Array.isArray(line.source_menu_plan_item_keys)
                              ? line.source_menu_plan_item_keys
                              : []
                            ).filter((itemKey) => selectedIssueItemKeys.has(itemKey));
                            const targetItemKey = sourceItemKeys[0] || '';
                            return (
                              <button
                                key={line.line_id || line.ingredient_id}
                                type="button"
                                disabled={!targetItemKey}
                                onClick={() => setActiveIssueItemKey(targetItemKey)}
                                className="rounded-lg border border-red-100 bg-white/90 px-2.5 py-2 text-left text-xs text-slate-700 transition hover:border-red-300 hover:bg-white disabled:cursor-default disabled:hover:border-red-100"
                              >
                                <p className="font-medium text-slate-900">{line.ingredient_name || 'Ingredient'}</p>
                                <p className="mt-0.5 text-red-700">
                                  Short {formatRecipeQuantity(line.shortage, line.inventory_unit || line.unit)} {line.inventory_unit || line.unit}
                                </p>
                                {Array.isArray(line.source_recipe_names) && line.source_recipe_names.length > 0 ? (
                                  <p className="mt-0.5 truncate text-slate-500">
                                    Dishes: {line.source_recipe_names.join(', ')}
                                  </p>
                                ) : null}
                                {targetItemKey ? (
                                  <p className="mt-1 font-medium text-indigo-700">Click to edit this ingredient</p>
                                ) : null}
                              </button>
                            );
                          })}
                          {selectedIssueDailyShortages.length > 4 ? (
                            <p className="self-center text-xs font-medium text-red-700">
                              +{selectedIssueDailyShortages.length - 4} more shortage line{selectedIssueDailyShortages.length - 4 === 1 ? '' : 's'}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {selectedIssueMealGroups.length > 0 ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {selectedIssueMealGroups.map((group) => (
                        <div key={group.key} className="rounded-xl border border-indigo-100 bg-white px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-slate-950">{group.meal_label}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {group.items.length} dish{group.items.length === 1 ? '' : 'es'} · {formatRecipeQuantity(group.production_covers, 'servings')} covers
                              </p>
                            </div>
                            <Badge className={group.shortageCount > 0 ? 'bg-red-600' : 'bg-emerald-600'}>
                              {group.shortageCount > 0 ? `${group.shortageCount} short` : 'No shortages'}
                            </Badge>
                          </div>
                          <p className="mt-2 text-xs text-slate-500">
                            Est. cost {formatCurrency(group.estimatedBatchCost)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-lg border border-dashed border-indigo-200 bg-white/80 px-3 py-3 text-sm text-indigo-800">
                      Select planned dishes below to prepare meal-level review requests.
                    </p>
                  )}
                </div>

                <div className="grid gap-4 2xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:block 2xl:space-y-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">Planned dishes</p>
                          <p className="mt-1 text-sm text-slate-500">
                            {selectedIssueSubmitItems.length} dishes selected · {selectedIssueMealGroups.length} meal review{selectedIssueMealGroups.length === 1 ? '' : 's'}
                          </p>
                        </div>
                        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
                          {issueMealView === 'all' ? 'All' : PRODUCTION_ISSUE_MEAL_LABELS[issueMealView]}
                        </Badge>
                      </div>
                    </div>

                    {issueItems.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                        No saved menu items with servings were found for this meal scope.
                      </div>
                    ) : issueItems.map((item) => {
                      const alreadyIssued = isIssueItemAlreadyIssued(item);
                      const itemCost = Number(getIssueItemSnapshotCost(item.key).toFixed(2));
                      const isActive = activeIssueItem?.key === item.key;
                      const itemShortageCount = (selectedIssueShortagesByItemKey[item.key] || []).length;
                      return (
                        <div
                          key={item.key}
                          className={`rounded-2xl border bg-white p-4 transition ${
                            isActive ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-slate-200'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 rounded border-slate-300"
                              checked={Boolean(item.selected) && !alreadyIssued}
                              disabled={alreadyIssued}
                              onChange={(event) => toggleIssueItem(item.key, event.target.checked)}
                              aria-label={`Select ${item.recipe_name} for production issue`}
                            />
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => setActiveIssueItemKey(item.key)}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline">{item.meal_label}</Badge>
                                {alreadyIssued ? (
                                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-500">Already issued</Badge>
                                ) : null}
                                {itemShortageCount > 0 ? (
                                  <Badge className="bg-red-600">{itemShortageCount} short</Badge>
                                ) : null}
                              </div>
                              <p className="mt-2 break-words font-semibold text-slate-950">{item.recipe_name}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                Planned {formatRecipeQuantity(item.expected_servings, 'servings')} servings · Est. cost {formatCurrency(itemCost || item.planned_total_cost)}
                              </p>
                            </button>
                          </div>
                          <div className="mt-3">
                            <Label className="text-xs text-slate-500">Production covers</Label>
                            <StandardDecimalInput
                              value={item.production_covers}
                              unit="servings"
                              precision={0}
                              min={0}
                              allowZero={false}
                              allowEmpty={false}
                              label={`${item.recipe_name} production covers`}
                              disabled={alreadyIssued}
                              onValueChange={(value) => updateIssueCovers(item.key, value)}
                              className="mt-1 bg-white"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="min-w-0 2xl:sticky 2xl:top-2 2xl:self-start">
                    {activeIssueItem ? (
                      <ProductionIngredientSnapshotEditor
                        title={`${activeIssueItem.meal_label}: ${activeIssueItem.recipe_name}`}
                        description="Chef changes here are production-only. The original recipe remains untouched."
                        lines={activeIssueSnapshotForEditor}
                        ingredients={ingredients}
                        inventorySiteId={issueFulfillmentStoreId}
                        suggestionsByLine={activeIssueSuggestions}
                        suggestionLoadingLine={activeIssueSuggestionLoadingLine}
                        estimatedBatchCost={activeIssueBatchCost}
                        estimatedCostPerServing={activeIssueCostPerServing}
                        aggregateShortageLines={activeIssueAggregateShortageLines}
                        onLineQuantityChange={(lineKey, value) => updateIssueLineQuantity(activeIssueItem.key, lineKey, value)}
                        onLineIngredientChange={(lineKey, value, ingredient) => updateIssueLineIngredient(activeIssueItem.key, lineKey, value, ingredient)}
                        onZeroLine={(lineKey) => zeroIssueLine(activeIssueItem.key, lineKey)}
                        onAddIngredient={(line) => addIssueIngredientLine(activeIssueItem.key, line)}
                        onRemoveLine={(lineKey) => removeIssueIngredientLine(activeIssueItem.key, lineKey)}
                        onRequestSuggestions={(lineKey, line) => requestIssueSuggestions(activeIssueItem.key, lineKey, line)}
                        onApplySuggestion={(lineKey, suggestion) => applyIssueSuggestion(activeIssueItem.key, lineKey, suggestion)}
                      />
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-14 text-center text-sm text-slate-500">
                        Select a planned dish to review its production recipe snapshot.
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <Label htmlFor="issue-notes">Issue notes</Label>
                  <Textarea
                    id="issue-notes"
                    value={issueNotes}
                    onChange={(event) => setIssueNotes(event.target.value)}
                    placeholder="Optional notes for all production requests created from this menu plan..."
                    className="mt-2"
                    rows={3}
                  />
                </div>

                {issueSubmitDisabledReason ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {issueSubmitDisabledReason}
                  </div>
                ) : null}

                <DialogFooter className="gap-2 sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigate('/MenuPlanning')}
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back to Menu Planning
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={issueProductionMutation.isPending || Boolean(issueSubmitDisabledReason)}
                      onClick={() => issueProductionMutation.mutate({ status: 'draft' })}
                    >
                      {issueProductionMutation.isPending ? 'Saving...' : 'Save Meal Drafts'}
                    </Button>
                    <Button
                      type="button"
                      className="bg-emerald-600 hover:bg-emerald-700"
                      disabled={issueProductionMutation.isPending || Boolean(issueSubmitDisabledReason)}
                      onClick={() => issueProductionMutation.mutate({ status: 'pending_approval' })}
                    >
                      <Factory className="mr-2 h-4 w-4" />
                      {issueProductionMutation.isPending
                        ? 'Issuing...'
                        : `Issue & Submit ${selectedIssueMealGroups.length || ''} Meal Review${selectedIssueMealGroups.length === 1 ? '' : 's'}`}
                    </Button>
                  </div>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Approval Dialog */}
        <Dialog
          open={showApprovalDialog}
          onOpenChange={(open) => {
            if (reviewAction) return;
            setShowApprovalDialog(open);
            if (!open) setActionError('');
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {isAreaApprovalReview(selectedProduction)
                  ? 'Area Manager Production Approval'
                  : 'Project Manager Production Review'}
              </DialogTitle>
            </DialogHeader>
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </div>
            ) : null}
            <div className="space-y-4">
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm font-medium mb-2">Production Details</p>
                <div className="space-y-1 text-sm text-slate-600">
                  <p>Recipe: {selectedProduction?.recipe_name}</p>
                  <p>Site: {selectedProduction?.site_name}</p>
                  <p>Date: {selectedProduction?.production_date}</p>
                  <p>Servings: {formatRecipeQuantity(selectedProduction?.target_servings, 'servings')}</p>
                  <p>Stage: {getProductionStatusLabel(selectedProduction?.status)}</p>
                </div>
              </div>

              {Array.isArray(selectedProduction?.menu_issue_items) && selectedProduction.menu_issue_items.length > 0 ? (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50/70 p-4">
                  <p className="text-sm font-medium text-indigo-950">Planned dishes in this meal review</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {selectedProduction.menu_issue_items.map((item, index) => (
                      <div key={item.key || `${item.recipe_id || 'dish'}-${index}`} className="rounded-lg border border-indigo-100 bg-white px-3 py-2 text-sm">
                        <p className="font-medium text-slate-900">{item.recipe_name || 'Planned dish'}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Covers {formatRecipeQuantity(item.production_covers ?? item.expected_servings, 'servings')} · Est. cost {formatCurrency(item.estimated_batch_cost || 0)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <ProductionOverrideSummary production={selectedProduction} />

              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-900">
                  <History className="h-4 w-4" aria-hidden="true" />
                  Approval History
                </h4>
                <ApprovalHistoryList production={selectedProduction} />
              </div>

              <div>
                <Label htmlFor="review_fulfillment_store">Fulfillment Store (required for approval)</Label>
                <Select
                  value={reviewFulfillmentStoreId}
                  onValueChange={(value) => {
                    setReviewFulfillmentStoreId(value);
                    setInventoryCheck(buildProductionInventoryCheck(selectedProduction, value));
                    setActionError('');
                  }}
                  disabled={Boolean(selectedProduction?.fulfillment_store_id) || selectedReviewStoreOptions.length === 0}
                >
                  <SelectTrigger id="review_fulfillment_store" className="mt-1">
                    <SelectValue placeholder={selectedReviewStoreOptions.length ? 'Select fulfillment store' : 'No accessible Store under this Project'} />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedReviewStoreOptions.map((store) => (
                      <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {canApproveSelected && !reviewFulfillmentStoreId ? (
                  <p className="mt-1 text-xs text-amber-700">Select a fulfillment Store to approve. You can still return or reject the request with a reason.</p>
                ) : null}
              </div>

              <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
                <h4 className="font-medium text-blue-900 mb-3">Inventory Check</h4>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Code</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Required</TableHead>
                        <TableHead>On Hand</TableHead>
                        <TableHead>Reserved</TableHead>
                        <TableHead>Available to Reserve</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inventoryCheck.map((ing, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-xs text-slate-600">{ing.item_code}</TableCell>
                          <TableCell>{ing.ingredient_name}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.adjusted_quantity, ing.unit)} {ing.unit}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.on_hand_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.reserved_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                          <TableCell>{formatRecipeQuantity(ing.available_stock, ing.inventory_unit)} {ing.inventory_unit}</TableCell>
                          <TableCell>
                            {ing.sufficient ? (
                              <Badge className="bg-green-600">✓ OK</Badge>
                            ) : (
                              <Badge className="bg-red-600">Short {formatRecipeQuantity(ing.shortage, ing.inventory_unit)} {ing.inventory_unit}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {inventoryCheck.some(ing => !ing.sufficient) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-900">
                        {isAreaApprovalReview(selectedProduction)
                          ? 'Shortage Review Before Final Approval'
                          : 'Store / Procurement Action Required After PM Approval'}
                      </p>
                      <p className="text-sm text-amber-700 mt-1">
                        {isAreaApprovalReview(selectedProduction)
                          ? 'Final approval is blocked until the Store receives or corrects the remaining shortage. Approval reserves the yield-adjusted quantities; physical stock is deducted only when production starts.'
                          : 'After PM approval, the linked material request moves to the Store Keeper / Procurement Officer. Production then waits for Area Manager approval before it can start.'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor="reviewNotes">Review Notes</Label>
                <Textarea
                  id="reviewNotes"
                  value={reviewNotes}
                  onChange={(event) => setReviewNotes(event.target.value)}
                  placeholder="Add approval notes, rejection reasons, or requested changes..."
                  className="mt-1"
                  rows={3}
                />
              </div>

              <DialogFooter>
                {canRequestSelectedChanges ? (
                    <Button
                      variant="outline"
                      onClick={() => handleReview('request_changes')}
                      className="border-amber-300 text-amber-700 hover:bg-amber-50"
                      disabled={Boolean(reviewAction) || !reviewNotes.trim()}
                    >
                      <AlertCircle className="w-4 h-4 mr-2" />
                      Request Changes
                    </Button>
                ) : null}
                {canRejectSelected ? (
                    <Button
                      variant="outline"
                      onClick={() => handleReview('reject')}
                      className="border-red-300 text-red-700 hover:bg-red-50"
                      disabled={Boolean(reviewAction) || !reviewNotes.trim()}
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      Reject
                    </Button>
                ) : null}
                {canApproveSelected ? (
                  <Button
                    onClick={() => handleReview('approve')}
                    className="bg-green-600 hover:bg-green-700"
                    disabled={
                      Boolean(reviewAction)
                      || !reviewFulfillmentStoreId
                      || (selectedIsAreaReview && inventoryCheck.some((ingredient) => !ingredient.sufficient))
                    }
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    {reviewAction === 'approve'
                      ? 'Approving...'
                      : selectedIsAreaReview
                        ? 'Approve, Reserve Inventory & Mark Ready'
                        : 'Approve & Send to Store / Procurement'}
                  </Button>
                ) : null}
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(historyProduction)}
          onOpenChange={(open) => {
            if (!open) setHistoryProduction(null);
          }}
        >
          <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <History className="h-5 w-5" aria-hidden="true" />
                Production Approval History
              </DialogTitle>
            </DialogHeader>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <p className="font-medium text-slate-900">
                {historyProduction?.recipe_name || historyProduction?.name || 'Production request'}
              </p>
              <p className="mt-0.5 text-xs">
                {historyProduction?.site_name || 'Site not named'} · {historyProduction?.production_date || 'Date not set'}
              </p>
            </div>
            <ApprovalHistoryList production={historyProduction} />
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(inventoryAction)}
          onOpenChange={(open) => {
            if (!open) {
              setInventoryAction(null);
              setInventoryActionReason('');
              setInventoryActionServings(null);
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {inventoryActionMode === 'cancel'
                  ? 'Cancel Production & Release Reservation'
                  : 'Adjust Approved Production Reservation'}
              </DialogTitle>
            </DialogHeader>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              Area Manager approval reserves inventory without deducting physical stock. Before production starts, quantity changes adjust only the reservation and preserve the selected batch, stock-date, expiry, and cost trail.
            </div>
            {inventoryAction ? (
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <p className="font-semibold text-slate-900">{inventoryAction.recipe_name || 'Production request'}</p>
                <p className="text-slate-600">
                  Current approved quantity: {formatRecipeQuantity(inventoryAction.target_servings || 0, 'serving')} servings
                </p>
                <p className="text-xs text-slate-500">
                  Reservation revision {inventoryActionState.revision} · {inventoryActionState.label}
                </p>
              </div>
            ) : null}
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
            ) : null}
            {inventoryActionMode === 'adjust' ? (
              <div>
                <Label htmlFor="approved_target_servings">Revised production servings *</Label>
                <StandardDecimalInput
                  id="approved_target_servings"
                  value={inventoryActionServings}
                  min={0.001}
                  allowZero={false}
                  allowEmpty={false}
                  label="Revised production servings"
                  onValueChange={setInventoryActionServings}
                />
                <p className="mt-1 text-xs text-slate-500">
                  An increase reserves only the additional yield-adjusted ingredients; a reduction releases the difference back to available stock.
                </p>
                {inventoryActionPreview.length > 0 ? (
                  <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ingredient</TableHead>
                          <TableHead>Revised Required</TableHead>
                          <TableHead>Own Reservation</TableHead>
                          <TableHead>Free Available</TableHead>
                          <TableHead>Total Capacity</TableHead>
                          <TableHead>Reservation Change</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inventoryActionPreview.map((line) => (
                          <TableRow key={line.ingredient_id}>
                            <TableCell>
                              <p className="font-medium text-slate-900">{line.ingredient_name}</p>
                              <p className="font-mono text-xs text-slate-500">{line.item_code}</p>
                            </TableCell>
                            <TableCell>{formatRecipeQuantity(line.revised_required, line.unit)} {line.unit}</TableCell>
                            <TableCell className="text-violet-700">
                              {formatRecipeQuantity(line.own_reserved, line.unit)} {line.unit}
                            </TableCell>
                            <TableCell className="text-cyan-700">
                              {formatRecipeQuantity(line.free_available, line.unit)} {line.unit}
                            </TableCell>
                            <TableCell className="font-medium">
                              {formatRecipeQuantity(line.total_capacity, line.unit)} {line.unit}
                            </TableCell>
                            <TableCell>
                              {!line.sufficient ? (
                                <Badge className="bg-red-100 text-red-700">
                                  Short {formatRecipeQuantity(line.shortage, line.unit)} {line.unit}
                                </Badge>
                              ) : line.release_quantity > 0 ? (
                                <Badge className="bg-cyan-100 text-cyan-800">
                                  Release {formatRecipeQuantity(line.release_quantity, line.unit)} {line.unit}
                                </Badge>
                              ) : line.additional_reservation > 0 ? (
                                <Badge className="bg-violet-100 text-violet-800">
                                  Reserve {formatRecipeQuantity(line.additional_reservation, line.unit)} {line.unit}
                                </Badge>
                              ) : (
                                <Badge className="bg-slate-100 text-slate-700">No change</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
                {inventoryActionHasShortage ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                    The revised quantity exceeds free stock plus this production's own reservation. The request will remain blocked from starting until the shortage is reserved.
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                This cancels the request and releases all inventory reserved by this approval
                {inventoryActionReservedLineCount > 0 ? ` across ${inventoryActionReservedLineCount} ingredient line${inventoryActionReservedLineCount === 1 ? '' : 's'}` : ''}.
                {' '}No physical consumption is posted before production starts, and the release remains in the approval history.
              </div>
            )}
            <div>
              <Label htmlFor="inventory_action_reason">Reason *</Label>
              <Textarea
                id="inventory_action_reason"
                value={inventoryActionReason}
                onChange={(event) => setInventoryActionReason(event.target.value)}
                placeholder="Record why the approved quantity is changing"
                className="mt-1"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInventoryAction(null)}>Close</Button>
              <Button
                className={inventoryActionMode === 'cancel' ? 'bg-red-700 hover:bg-red-800' : 'bg-indigo-700 hover:bg-indigo-800'}
                disabled={
                  inventoryCommitmentMutation.isPending
                  || !inventoryActionReason.trim()
                  || (inventoryActionMode === 'adjust' && (!Number.isFinite(Number(inventoryActionServings)) || Number(inventoryActionServings) <= 0))
                }
                onClick={() => inventoryCommitmentMutation.mutate({
                  production: inventoryAction,
                  mode: inventoryActionMode,
                  targetServings: inventoryActionServings,
                  reason: inventoryActionReason.trim()
                })}
              >
                {inventoryCommitmentMutation.isPending
                  ? 'Reconciling...'
                  : inventoryActionMode === 'cancel'
                    ? 'Cancel & Release Reservation'
                    : 'Apply Quantity Change'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={completionOpen}
          onOpenChange={(open) => {
            setCompletionOpen(open);
            if (!open) {
              setCompletionProduction(null);
              setCompletionFulfillmentStoreId('');
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Complete Production Automatically</DialogTitle>
            </DialogHeader>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              Completion is fully automatic. The approved raw ingredient snapshot is reconciled without manual quantities, and its frozen yield-adjusted weight becomes the finished production balance without deducting inventory twice.
            </div>
            {actionError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>
            ) : null}
            <div className="grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Calculated Yielded Weight</p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {Number.isFinite(completionExpectedWeightGrams) && completionExpectedWeightGrams > 0
                    ? `${formatRecipeQuantity(completionExpectedWeightGrams, 'g')} g`
                    : 'Not available'}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Automatic Finished Production</p>
                <p className="mt-1 text-lg font-semibold text-emerald-800">
                  {Number.isFinite(completionExpectedWeightGrams) && completionExpectedWeightGrams > 0
                    ? `${formatRecipeQuantity(completionExpectedWeightGrams, 'g')} g`
                    : 'Not available'}
                </p>
                <p className="text-xs text-slate-500">Set by the approved recipe yield</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Calculated Portion Size</p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {Number.isFinite(completionPortionSizeGrams) && completionPortionSizeGrams > 0
                    ? `${formatRecipeQuantity(completionPortionSizeGrams, 'g')} g`
                    : 'Not available'}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Produced Servings</p>
                <p className="mt-1 text-lg font-semibold text-emerald-800">
                  {completionDerivedServings == null
                    ? 'Not available'
                    : formatRecipeQuantity(completionDerivedServings, 'servings')}
                </p>
                <p className="text-xs text-slate-500">Yield-adjusted weight ÷ portion size</p>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Output source: {String(completionYieldSummary.output_calculation_source || 'automatic yield plan').replaceAll('_', ' ')} · Portion source: {String(completionYieldSummary.portion_size_source || 'automatic yield plan').replaceAll('_', ' ')}. The server independently recalculates these values before posting completion.
            </p>
            {completionYieldSummary.warnings.length > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <p className="font-medium">Automatic calculation notes:</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {completionYieldSummary.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {completionDerivedServings == null ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Automatic completion is unavailable because this approved production snapshot does not contain both a valid yielded weight and portion size. Update the recipe and create a new production request.
              </div>
            ) : null}
            <div>
              <Label htmlFor="completion_fulfillment_store">Inventory Fulfillment Store *</Label>
              <Select
                value={completionFulfillmentStoreId}
                onValueChange={(value) => {
                  setCompletionFulfillmentStoreId(value);
                  setActionError('');
                }}
                disabled={Boolean(completionProduction?.fulfillment_store_id) || completionStoreOptions.length === 0}
              >
                <SelectTrigger id="completion_fulfillment_store" className="mt-1">
                  <SelectValue placeholder={completionStoreOptions.length ? 'Select fulfillment store' : 'No accessible Store under this Project'} />
                </SelectTrigger>
                <SelectContent>
                  {completionStoreOptions.map((store) => (
                    <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!completionFulfillmentStoreId ? (
                <p className="mt-1 text-xs text-red-600">Select the Store whose inventory will be consumed.</p>
              ) : null}
            </div>
            <div className="rounded-lg border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item Code</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead>Approved Raw Issue</TableHead>
                    <TableHead>Yield</TableHead>
                    <TableHead>Yielded Weight</TableHead>
                    <TableHead>Reconciliation</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {completionRawReconciliation.map((line, index) => (
                    <TableRow key={line.ingredient_id || index}>
                      <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                      <TableCell className="font-medium">{line.ingredient_name}</TableCell>
                      <TableCell>{formatRecipeQuantity(line.planned_quantity, line.unit)} {line.unit}</TableCell>
                      <TableCell>{formatRecipeQuantity(line.yield_percent, '%')}%</TableCell>
                      <TableCell>
                        {line.yielded_weight_grams !== null && Number.isFinite(Number(line.yielded_weight_grams))
                          ? `${formatRecipeQuantity(line.yielded_weight_grams, 'g')} g`
                          : 'Unavailable'}
                      </TableCell>
                      <TableCell>
                        {line.yielded_weight_grams !== null ? (
                          <div className="flex items-center gap-2 text-emerald-700">
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            <span className="font-medium">Automatic</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-amber-700">
                            <AlertCircle className="h-4 w-4" aria-hidden="true" />
                            <span className="font-medium">Yield data required</span>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {completionRawReconciliation.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-sm text-slate-500">
                        No approved raw ingredient snapshot is available for reconciliation.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCompletionOpen(false)}>Cancel</Button>
              <Button
                className="bg-emerald-700 hover:bg-emerald-800"
                disabled={updateStatusMutation.isPending
                  || !completionFulfillmentStoreId
                  || completionDerivedServings == null
                  || completionRawReconciliation.length === 0}
                onClick={() => updateStatusMutation.mutate({
                  id: completionProduction.id,
                  status: 'completed',
                  fulfillmentStoreId: completionFulfillmentStoreId
                })}
              >
                {updateStatusMutation.isPending ? 'Completing...' : 'Complete Automatically'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(selectedConsumptionReport)}
          onOpenChange={(open) => {
            if (!open) setSelectedConsumptionReport(null);
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-emerald-700" />
                {selectedConsumptionReport?.report_name || 'Production Consumption Report'}
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="text-xs text-slate-500">Report Number</p><p className="font-semibold">{selectedConsumptionReport?.report_number}</p></div>
              <div><p className="text-xs text-slate-500">Project / Store</p><p className="font-semibold">{selectedConsumptionReport?.requesting_site_name || selectedConsumptionReport?.site_name} / {selectedConsumptionReport?.fulfillment_store_name || selectedConsumptionReport?.site_name}</p></div>
              <div><p className="text-xs text-slate-500">Completed By</p><p className="font-semibold">{selectedConsumptionReport?.completed_by_name || selectedConsumptionReport?.completed_by}</p></div>
              <div><p className="text-xs text-slate-500">Total Consumption Cost</p><p className="font-semibold text-emerald-700">{formatCurrency(selectedConsumptionReport?.total_consumption_cost || 0)}</p></div>
            </div>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Ingredient Consumption</h3>
              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Planned Raw</TableHead>
                      <TableHead>Actual Requested</TableHead>
                      <TableHead>Stock Issued</TableHead>
                      <TableHead>Shortage</TableHead>
                      <TableHead>Basis</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(selectedConsumptionReport?.ingredient_lines || []).map((line, index) => (
                      <TableRow key={`${line.ingredient_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell className="font-medium">{line.ingredient_name}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.planned_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.actual_requested_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.issued_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell className={Number(line.shortage_quantity) > 0 ? 'font-semibold text-red-600' : ''}>{formatRecipeQuantity(line.shortage_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{String(line.quantity_basis || '').replace(/_/g, ' ')}</TableCell>
                        <TableCell>{formatCurrency(line.posted_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Inventory Lots Consumed</h3>
              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Item Code</TableHead><TableHead>Item Name</TableHead><TableHead>Batch</TableHead><TableHead>Expiry</TableHead><TableHead>Quantity</TableHead><TableHead>Cost</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {((selectedConsumptionReport?.sections || []).find((section) => section.key === 'inventory_lot_usage')?.lines || []).map((line, index) => (
                      <TableRow key={`${line.inventory_lot_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell>{line.ingredient_name}</TableCell>
                        <TableCell>{line.batch_number || '—'}</TableCell>
                        <TableCell>{line.expiry_date || '—'}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatCurrency(line.total_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Shortages and Exceptions</h3>
              <div className="rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Item Code</TableHead><TableHead>Item Name</TableHead><TableHead>Requested</TableHead><TableHead>Issued</TableHead><TableHead>Shortage</TableHead><TableHead>Estimated Shortage Cost</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {((selectedConsumptionReport?.sections || []).find((section) => section.key === 'shortages')?.lines || []).map((line, index) => (
                      <TableRow key={`${line.ingredient_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell>{line.ingredient_name}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.actual_requested_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.issued_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell className="font-semibold text-red-600">{formatRecipeQuantity(line.shortage_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatCurrency(line.estimated_shortage_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                    {((selectedConsumptionReport?.sections || []).find((section) => section.key === 'shortages')?.lines || []).length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-emerald-700">No shortages or consumption exceptions were posted.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </section>
          </DialogContent>
        </Dialog>
    </>
  );
}
