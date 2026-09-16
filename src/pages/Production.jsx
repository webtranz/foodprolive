import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
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
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
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
import {
  buildProductionPlanExportRows,
  isProductionReversedAuditRecord
} from '@/lib/productionPlanning';
import {
  getInventoryQuantities,
  getProductionInventoryState
} from '@/lib/inventoryAvailability';
import { convertIngredientQuantity, isIngredientUnitCompatible } from '../../shared/ingredientUnits.js';
import { buildAutomaticProductionYieldSummary } from '../../shared/productionReconciliation.js';
import { calculateRecipeNutritionSnapshot } from '../../shared/recipeNutrition.js';
import { formatRecipeQuantity, getRecipeQuantityPrecision, roundStandardDecimal } from '../../shared/recipeNumbers.js';
import { calculateRecipeServingWeight } from '../../shared/recipeWeight.js';
import { ingredientForRecipeLine } from '../../shared/recipeLineWeight.js';
import { getItemCode } from '../../shared/itemCode.js';
import {
  formatProductionEventTitle,
  formatProductionItemCountLabel,
  getProductionEventItemCount,
  getProductionEventScopeLabel
} from '../../shared/productionLabels.js';
import {
  aggregateProductionIngredientLines,
  buildMenuPlanIssueLockState,
  buildInventoryReplacementSuggestions,
  buildMenuIssueMealGroups,
  buildMenuPlanIssueItems,
  buildProductionIngredientLine,
  buildProductionIngredientSnapshot,
  buildProductionIngredientsForSubmit,
  buildProductionOverrideAudit,
  finiteProductionNumber,
  getMenuIssueInventoryCheckState,
  getProductionIngredientLineKey,
  isMenuPlanIssueItemAlreadyIssued,
  normalizeIssueMealView,
  PRODUCTION_ISSUE_MEAL_LABELS,
  PRODUCTION_ISSUE_MEAL_TYPES,
  recalculateProductionIngredientSnapshot
} from '@/lib/productionIssue';
import {
  canStartApprovedProduction,
  getProductionApprovalHistory,
  getProductionRejectionReturnStatus,
  getProductionStartBlockReason,
  getProductionStatusLabel
} from '../../shared/productionWorkflow.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';
import { getProductionInventoryContext } from '../../shared/productionFulfillment.js';
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

const MASTER_DATA_QUERY_OPTIONS = {
  staleTime: 10 * 60 * 1000,
  gcTime: 60 * 60 * 1000
};

const OPERATIONAL_QUERY_OPTIONS = {
  staleTime: 30 * 1000,
  gcTime: 10 * 60 * 1000
};

const ACTIVE_COMPLETION_JOB_STATUSES = new Set(['queued', 'processing']);

function getProductionCompletionJobFromRecord(record = {}) {
  const embeddedJob = record?.completion_job || record?.job || null;
  const recordStatus = String(record?.production_status || record?.status || '').trim().toLowerCase();
  const rawStatus = String(
    embeddedJob?.status
    || record?.completion_job_status
    || ''
  ).trim().toLowerCase();
  const status = recordStatus === 'completed' && ACTIVE_COMPLETION_JOB_STATUSES.has(rawStatus)
    ? 'completed'
    : rawStatus;
  const id = String(
    embeddedJob?.id
    || record?.completion_job_id
    || ''
  ).trim();
  if (!id && !status) return null;
  const numericProgress = Number(embeddedJob?.progress ?? record?.completion_job_progress ?? 0);
  return {
    id,
    production_id: embeddedJob?.production_id || record?.id || '',
    status: status || 'queued',
    progress: Number.isFinite(numericProgress)
      ? Math.max(0, Math.min(100, numericProgress))
      : 0,
    message: embeddedJob?.message || record?.completion_job_message || '',
    error: embeddedJob?.error || record?.completion_job_error || '',
    requested_at: embeddedJob?.requested_at || record?.completion_job_requested_at || null,
    started_at: embeddedJob?.started_at || record?.completion_job_started_at || null,
    completed_at: embeddedJob?.completed_at || record?.completion_job_completed_at || null
  };
}

function isActiveProductionCompletionJob(job) {
  return ACTIVE_COMPLETION_JOB_STATUSES.has(String(job?.status || '').trim().toLowerCase());
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveOptionalNumber(value) {
  const numeric = optionalNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function firstPositivePresent(...values) {
  return values.map(positiveOptionalNumber).find((value) => value !== null) ?? null;
}

function formatReportQuantity(quantity, unit) {
  const numeric = optionalNumber(quantity);
  if (numeric === null) return '—';
  return `${formatRecipeQuantity(numeric, unit || '')}${unit ? ` ${unit}` : ''}`.trim();
}

function formatReportWeightFromGrams(value) {
  const grams = optionalNumber(value);
  if (grams === null) return '—';
  if (Math.abs(grams) >= 1000) {
    return `${formatRecipeQuantity(grams / 1000, 'kg')} kg`;
  }
  return `${formatRecipeQuantity(grams, 'g')} g`;
}

function formatReportPercent(value) {
  const numeric = optionalNumber(value);
  return numeric === null ? '—' : `${formatRecipeQuantity(numeric, '%')}%`;
}

function getReportSectionLines(report, key) {
  return ((report?.sections || []).find((section) => section.key === key)?.lines || []);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function sumReportWeights(lines = [], field) {
  const usableLines = arrayValue(lines).filter((line) => optionalNumber(line?.[field]) !== null);
  if (usableLines.length === 0) return null;
  return usableLines.reduce((sum, line) => sum + toNumber(line[field], 0), 0);
}

function sumManifestItemWeight(item = {}, field) {
  const direct = positiveOptionalNumber(item[field]);
  if (direct !== null) return direct;
  if (field === 'raw_weight_grams') {
    const rawTotal = positiveOptionalNumber(item.recipe_raw_weight_grams)
      ?? positiveOptionalNumber(item.total_raw_weight_grams)
      ?? positiveOptionalNumber(item.total_raw_consumption_weight_grams);
    if (rawTotal !== null) return rawTotal;
  }
  if (field === 'yielded_weight_grams') {
    const yieldedTotal = positiveOptionalNumber(item.expected_finished_weight_grams)
      ?? positiveOptionalNumber(item.actual_finished_weight_grams)
      ?? positiveOptionalNumber(item.total_yielded_weight_grams);
    if (yieldedTotal !== null) return yieldedTotal;
  }
  return sumReportWeights(item.ingredients_used, field);
}

function sumManifestItemsWeight(items = [], field) {
  const values = arrayValue(items)
    .map((item) => sumManifestItemWeight(item, field))
    .filter((value) => optionalNumber(value) !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + toNumber(value, 0), 0);
}

function normalizedReportText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getManifestItemMatchKeys(item = {}, index = 0) {
  const recipeName = normalizedReportText(item.recipe_name || item.name);
  const recipeId = String(item.recipe_id || '').trim();
  return [
    item.key,
    item.original_source_menu_plan_item_key,
    item.source_menu_plan_item_key,
    item.menu_plan_item_key,
    recipeId ? `recipe:${recipeId}` : '',
    recipeName ? `name:${recipeName}` : '',
    `${recipeId || recipeName || 'manifest'}:${index}`
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function getManifestItemActionKey(item = {}, index = 0) {
  return getManifestItemMatchKeys(item, index)[0] || `manifest-item-${index}`;
}

function manifestItemHasFilledProduction(item = {}) {
  const rawWeight = sumManifestItemWeight(item, 'raw_weight_grams');
  const yieldedWeight = sumManifestItemWeight(item, 'yielded_weight_grams');
  if (positiveOptionalNumber(item.production_covers) !== null || positiveOptionalNumber(item.expected_servings) !== null) return true;
  if (positiveOptionalNumber(rawWeight) !== null || positiveOptionalNumber(yieldedWeight) !== null) return true;
  return arrayValue(item.ingredients_used).some((line) => (
    firstPositivePresent(
      line.raw_quantity,
      line.required_quantity,
      line.planned_quantity,
      line.adjusted_quantity,
      line.quantity,
      line.raw_weight_grams,
      line.yielded_weight_grams
    ) !== null
  ));
}

function getPartialReversalManifestItems(production = {}) {
  return arrayValue(production?.menu_issue_items)
    .map((item, index) => ({
      ...item,
      key: getManifestItemActionKey(item, index),
      partial_reversal_index: index
    }))
    .filter(manifestItemHasFilledProduction);
}

function mergeManifestItem(reportItem = {}, fallbackItem = {}) {
  const reportLines = arrayValue(reportItem.ingredients_used);
  const fallbackLines = arrayValue(fallbackItem.ingredients_used);
  const mergedLines = reportLines.length > 0 ? reportLines : fallbackLines;
  const rawWeight = sumManifestItemWeight(reportItem, 'raw_weight_grams')
    ?? sumManifestItemWeight(fallbackItem, 'raw_weight_grams');
  const yieldedWeight = sumManifestItemWeight(reportItem, 'yielded_weight_grams')
    ?? sumManifestItemWeight(fallbackItem, 'yielded_weight_grams');

  return {
    ...fallbackItem,
    ...reportItem,
    key: reportItem.key || fallbackItem.key || reportItem.source_menu_plan_item_key || fallbackItem.source_menu_plan_item_key || '',
    recipe_id: reportItem.recipe_id || fallbackItem.recipe_id || null,
    recipe_name: reportItem.recipe_name || fallbackItem.recipe_name || fallbackItem.name || reportItem.name || 'Planned item',
    expected_servings: firstPresent(reportItem.expected_servings, fallbackItem.expected_servings),
    production_covers: firstPresent(
      reportItem.production_covers,
      reportItem.target_servings,
      fallbackItem.production_covers,
      fallbackItem.target_servings,
      fallbackItem.expected_servings
    ),
    estimated_batch_cost: firstPresent(reportItem.estimated_batch_cost, fallbackItem.estimated_batch_cost, fallbackItem.planned_total_cost, 0),
    raw_weight_grams: rawWeight,
    yielded_weight_grams: yieldedWeight,
    ingredients_used: mergedLines
  };
}

function mergeManifestItems(reportItems = [], productionItems = []) {
  const mergedItems = [];
  const usedProductionIndexes = new Set();
  const productionIndexByKey = new Map();

  arrayValue(productionItems).forEach((item, index) => {
    getManifestItemMatchKeys(item, index).forEach((key) => {
      if (!productionIndexByKey.has(key)) {
        productionIndexByKey.set(key, index);
      }
    });
  });

  arrayValue(reportItems).forEach((item, index) => {
    const matchIndex = getManifestItemMatchKeys(item, index)
      .map((key) => productionIndexByKey.get(key))
      .find((candidateIndex) => Number.isInteger(candidateIndex) && !usedProductionIndexes.has(candidateIndex));
    if (Number.isInteger(matchIndex)) {
      usedProductionIndexes.add(matchIndex);
      mergedItems.push(mergeManifestItem(item, productionItems[matchIndex]));
      return;
    }
    mergedItems.push(mergeManifestItem(item, {}));
  });

  arrayValue(productionItems).forEach((item, index) => {
    if (!usedProductionIndexes.has(index)) {
      mergedItems.push(mergeManifestItem({}, item));
    }
  });

  return mergedItems;
}

function getReportSourceRecipeNames(lines = []) {
  return new Set(
    arrayValue(lines)
      .flatMap((line) => arrayValue(line?.source_recipe_names))
      .map((name) => String(name || '').trim())
      .filter(Boolean)
  );
}

function mergeConsumptionReportWithProduction(report = {}, production = {}) {
  const reportMenuItems = arrayValue(report.menu_issue_items);
  const productionMenuItems = arrayValue(production.menu_issue_items);
  const reportIngredientLines = arrayValue(report.ingredient_lines);
  const productionCompletionLines = arrayValue(production.completion_lines);
  const productionIngredientLines = arrayValue(production.ingredients_used);
  const ingredientLines = reportIngredientLines.length > 0
    ? reportIngredientLines
    : productionCompletionLines.length > 0
      ? productionCompletionLines
      : productionIngredientLines;
  const menuIssueItems = mergeManifestItems(reportMenuItems, productionMenuItems);
  const mergedForCount = {
    ...production,
    ...report,
    menu_issue_items: menuIssueItems
  };
  const itemCount = getProductionEventItemCount(mergedForCount, menuIssueItems.length || 0);

  return {
    ...production,
    ...report,
    production_id: report.production_id || production.id || null,
    production_name: report.production_name || production.recipe_name || production.production_name || null,
    original_production_name: report.original_production_name || production.recipe_name || null,
    production_date: report.production_date || production.production_date || null,
    site_id: report.site_id || production.fulfillment_store_id || production.site_id || null,
    site_name: report.site_name || production.fulfillment_store_name || production.site_name || null,
    requesting_site_id: report.requesting_site_id || production.site_id || null,
    requesting_site_name: report.requesting_site_name || production.site_name || null,
    fulfillment_store_id: report.fulfillment_store_id || production.fulfillment_store_id || production.site_id || null,
    fulfillment_store_name: report.fulfillment_store_name || production.fulfillment_store_name || production.site_name || null,
    recipe_name: report.recipe_name || production.recipe_name || null,
    meal_type: report.meal_type || production.meal_type || null,
    menu_type: report.menu_type || production.menu_type || production.cuisine_type || null,
    cuisine_type: report.cuisine_type || report.menu_type || production.menu_type || production.cuisine_type || null,
    menu_category: report.menu_category || production.menu_category || null,
    production_issue_grouped: Boolean(report.production_issue_grouped ?? production.production_issue_grouped),
    production_issue_item_count: itemCount,
    production_issue_dish_count: itemCount,
    menu_issue_items: menuIssueItems,
    target_servings: firstPresent(report.target_servings, production.target_servings, production.produced_servings, 0),
    output_calculation_source: report.output_calculation_source || production.output_calculation_source || null,
    quantity_basis: report.quantity_basis || production.quantity_basis || null,
    recipe_raw_weight_grams: firstPositivePresent(report.recipe_raw_weight_grams, production.recipe_raw_weight_grams),
    expected_finished_weight_grams: firstPositivePresent(
      report.expected_finished_weight_grams,
      production.expected_finished_weight_grams,
      production.actual_finished_weight_grams
    ),
    total_raw_consumption_weight_grams: firstPositivePresent(
      report.total_raw_consumption_weight_grams,
      production.total_raw_consumption_weight_grams,
      production.recipe_raw_weight_grams,
      sumReportWeights(ingredientLines, 'raw_weight_grams'),
      sumManifestItemsWeight(menuIssueItems, 'raw_weight_grams')
    ),
    total_yielded_weight_grams: firstPositivePresent(
      report.total_yielded_weight_grams,
      production.total_yielded_weight_grams,
      production.expected_finished_weight_grams,
      production.actual_finished_weight_grams,
      production.produced_weight_grams,
      sumReportWeights(ingredientLines, 'yielded_weight_grams'),
      sumManifestItemsWeight(menuIssueItems, 'yielded_weight_grams')
    ),
    portion_size_grams: firstPositivePresent(report.portion_size_grams, production.portion_size_grams),
    expected_yield_servings: firstPositivePresent(report.expected_yield_servings, production.expected_yield_servings),
    ingredient_line_count: firstPresent(report.ingredient_line_count, ingredientLines.length),
    ingredient_lines: ingredientLines
  };
}

function formatReportSource(value) {
  return String(value || 'automatic_yield_plan').replace(/_/g, ' ');
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

function getProductionReversalEntries(production = {}) {
  const history = arrayValue(production.production_reversal_history);
  if (history.length > 0) return history;
  return production.reversal_summary ? [production.reversal_summary] : [];
}

function ProductionReversalDetails({ production }) {
  const entries = getProductionReversalEntries(production);
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        No reversal details have been recorded on this production.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, index) => {
        const returnedLines = arrayValue(entry.returned_lines);
        return (
          <section key={`${entry.timestamp || entry.reversed_at || index}`} className="rounded-xl border border-slate-300 bg-slate-50 p-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Reversed at</p>
                <p className="font-semibold text-slate-900">{formatWorkflowTimestamp(entry.timestamp || entry.reversed_at)}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Reversed by</p>
                <p className="font-semibold text-slate-900">{entry.actor_name || entry.reversed_by_name || entry.actor_email || entry.reversed_by || 'Admin'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Returned lines</p>
                <p className="font-semibold text-slate-900">{entry.returned_line_count ?? returnedLines.length ?? 0}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Returned stock value</p>
                <p className="font-semibold text-slate-900">{formatCurrency(entry.returned_total_cost || 0)}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Old consumption report</p>
                <p className="font-semibold text-slate-900">{entry.consumption_report_number || production.reversed_consumption_report_number || 'Reversed'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Old produced batch</p>
                <p className="font-semibold text-slate-900">{entry.produced_item_batch_number || production.reversed_produced_item_batch_number || 'Voided'}</p>
              </div>
            </div>
            {entry.reason ? (
              <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-700">
                <span className="font-medium">Reason:</span> {entry.reason}
              </p>
            ) : null}
            {returnedLines.length > 0 ? (
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Returned Qty</TableHead>
                      <TableHead>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {returnedLines.map((line, lineIndex) => (
                      <TableRow key={`${line.ingredient_id || line.item_code || lineIndex}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell className="font-medium">{line.ingredient_name || line.ingredient_id || 'Ingredient'}</TableCell>
                        <TableCell>{formatReportQuantity(line.returned_quantity, line.unit)}</TableCell>
                        <TableCell>{formatCurrency(line.total_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function formatReversalServings(value) {
  const numeric = optionalNumber(value);
  return numeric === null ? '—' : `${formatRecipeQuantity(numeric, 'servings')} servings`;
}

function formatReversalStatus(value) {
  return String(value || 'open').replace(/_/g, ' ');
}

function formatProducedOutputDependencyQuantity(row = {}) {
  const weight = optionalNumber(row.weight_grams);
  if (weight !== null && Math.abs(weight) > 0) return formatReportWeightFromGrams(weight);
  const servings = optionalNumber(row.servings);
  if (servings !== null && Math.abs(servings) > 0) return formatReversalServings(servings);
  return formatReportQuantity(row.quantity, row.unit);
}

function ReversalDependencyTable({ title, rows, emptyMessage }) {
  const records = arrayValue(rows);
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
        <p className="font-semibold text-slate-900">{title}</p>
        <Badge variant={records.length ? 'destructive' : 'secondary'}>
          {records.length} active
        </Badge>
      </div>
      {records.length === 0 ? (
        <p className="px-3 py-3 text-xs text-emerald-700">{emptyMessage}</p>
      ) : (
        <div className="max-h-56 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((row) => (
                <TableRow key={`${row.type || 'record'}-${row.id || row.reference}`}>
                  <TableCell className="font-mono text-xs text-slate-600">
                    {row.reference || row.id || '—'}
                  </TableCell>
                  <TableCell className="font-medium text-slate-800">
                    {row.recipe_name || row.recipe_id || 'Produced output'}
                    <p className="text-xs font-normal text-slate-500">
                      {[row.date, row.meal_type, row.menu_category].filter(Boolean).join(' · ') || 'Scope not recorded'}
                    </p>
                  </TableCell>
                  <TableCell>{formatProducedOutputDependencyQuantity(row)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {formatReversalStatus(row.status || row.approval_status)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function ProductionReversalBlockersPanel({
  diagnostics,
  isLoading,
  error,
  onRepair,
  repairPending
}) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        Checking Meal Service, Food Waste, and produced-output batch balances...
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Could not load reversal blockers: {error.message || 'Refresh and try again.'}
      </div>
    );
  }
  if (!diagnostics) return null;

  const batch = diagnostics.produced_item_batch || null;
  const balanceBlockers = arrayValue(diagnostics.balance_blockers);
  const statusBlockers = arrayValue(diagnostics.status_blockers);
  const mealRows = arrayValue(diagnostics.active_meal_service_rows);
  const wasteRows = arrayValue(diagnostics.active_food_waste_rows);
  const hasActiveRows = mealRows.length + wasteRows.length > 0;

  return (
    <div className="space-y-3">
      <div className={`rounded-xl border px-4 py-3 ${
        diagnostics.can_reverse
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-semibold">Blocking records</p>
            <p className="mt-1 text-sm">{diagnostics.message}</p>
          </div>
          {diagnostics.can_reverse ? (
            <Badge className="w-fit bg-emerald-600">Ready to reverse</Badge>
          ) : (
            <Badge variant="outline" className="w-fit border-amber-300 text-amber-800">Action needed</Badge>
          )}
        </div>
      </div>

      {statusBlockers.length > 0 ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
          <p className="font-semibold">Status blocker</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {statusBlockers.map((blocker) => (
              <li key={blocker.type}>{blocker.label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {batch ? (
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-slate-900">Produced-output batch balance</p>
              <p className="text-xs text-slate-500">
                {batch.batch_number || batch.id} · {formatReversalStatus(batch.status)}
              </p>
            </div>
            {balanceBlockers.length > 0 ? (
              <Badge variant="destructive">{balanceBlockers.length} balance issue{balanceBlockers.length === 1 ? '' : 's'}</Badge>
            ) : (
              <Badge className="bg-emerald-600">Clean balance</Badge>
            )}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            {[
              ['Produced', formatReportWeightFromGrams(batch.produced_weight_grams), formatReversalServings(batch.produced_servings)],
              ['Remaining', formatReportWeightFromGrams(batch.remaining_weight_grams), formatReversalServings(batch.remaining_servings)],
              ['Served', formatReportWeightFromGrams(batch.served_weight_grams), formatReversalServings(batch.served_servings)],
              ['Wasted', formatReportWeightFromGrams(batch.wasted_weight_grams), formatReversalServings(batch.wasted_servings)]
            ].map(([label, weight, servings]) => (
              <div key={label} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-1 font-semibold text-slate-900">{weight}</p>
                <p className="text-xs text-slate-500">{servings}</p>
              </div>
            ))}
          </div>
          {balanceBlockers.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-amber-800">
              {balanceBlockers.map((blocker) => (
                <li key={blocker.type}>
                  {blocker.label}: {formatReportWeightFromGrams(blocker.weight_grams)} / {formatReversalServings(blocker.servings)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No produced-output batch was found for this production.
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <ReversalDependencyTable
          title="Meal Service records"
          rows={mealRows}
          emptyMessage="No active Meal Service records are using this output."
        />
        <ReversalDependencyTable
          title="Food Waste records"
          rows={wasteRows}
          emptyMessage="No active Food Waste records are using this output."
        />
      </div>

      {diagnostics.can_repair_stale_balance ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
          <p className="font-semibold">Stale batch balance repair available</p>
          <p className="mt-1 text-sm">
            The dependent Meal Service/Waste records are already reversed, but the produced-output batch still has
            used counters. Repairing this resets the batch to its original produced balance so the reversal can proceed.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-3 border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
            disabled={repairPending}
            onClick={onRepair}
          >
            {repairPending ? 'Repairing...' : 'Repair stale batch balance'}
          </Button>
        </div>
      ) : null}

      {!diagnostics.can_reverse && !diagnostics.can_repair_stale_balance && !hasActiveRows && balanceBlockers.length > 0 ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
          This balance cannot be auto-repaired. Review the batch and production report before trying reversal again.
        </div>
      ) : null}
    </div>
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
            These ingredient lines are short after all selected production items are combined. Use the highlighted lines below to zero out, replace, or adjust quantities for production only.
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
          const conversionSummary = line.inventory_conversion_summary;
          const inventoryRequirementUnit = conversionSummary?.inventory_unit || line.inventory_unit || line.unit;
          const lineShortageQuantity = finiteProductionNumber(line.shortage, 0);
          const aggregateShortageQuantity = finiteProductionNumber(line.aggregate_shortage_quantity, 0);
          const displayShortageQuantity = lineShortageQuantity > 0 ? lineShortageQuantity : aggregateShortageQuantity;
          const displayShortageUnit = lineShortageQuantity > 0
            ? (line.inventory_unit || line.unit)
            : (line.aggregate_inventory_unit || line.inventory_unit || line.unit);
          const showAggregateShortageContext = line.aggregate_shortage
            && aggregateShortageQuantity > 0
            && Math.abs(aggregateShortageQuantity - lineShortageQuantity) > 0.000001;
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
                    : `${lineShortageQuantity > 0 ? 'Short' : 'Meal short'} ${formatRecipeQuantity(displayShortageQuantity, displayShortageUnit)} ${displayShortageUnit}`}
                </Badge>
              </div>

              <div className="mt-4 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
                <div className="grid gap-3">
                  <div className="grid gap-3 xl:grid-cols-[minmax(220px,1fr)_minmax(180px,0.75fr)_minmax(260px,0.9fr)]">
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
                      <Label className="text-xs text-slate-500">Production quantity{line.unit ? ` (${line.unit})` : ''}</Label>
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
                      <p className="mt-1 text-xs text-slate-500">Recipe unit: {line.unit || 'unit'}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Store availability</p>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                        <div>
                          <p className="text-slate-500">Required</p>
                          <p className="font-semibold text-slate-900">
                            {formatRecipeQuantity(line.inventory_required_quantity ?? line.raw_quantity, line.inventory_unit || line.unit)} {line.inventory_unit || line.unit}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-500">Available</p>
                          <p className="font-semibold text-slate-900">{formatRecipeQuantity(line.available_stock, line.inventory_unit)} {line.inventory_unit}</p>
                        </div>
                        <div>
                          <p className="text-slate-500">On hand</p>
                          <p className="font-semibold text-slate-900">{formatRecipeQuantity(line.on_hand_stock, line.inventory_unit)} {line.inventory_unit}</p>
                        </div>
                        <div>
                          <p className="text-slate-500">Reserved</p>
                          <p className="font-semibold text-slate-900">{formatRecipeQuantity(line.reserved_stock, line.inventory_unit)} {line.inventory_unit}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {conversionSummary ? (
                    <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-950">
                      <p className="font-semibold">
                        Inventory requirement: {formatRecipeQuantity(conversionSummary.production_quantity, conversionSummary.production_unit)} {conversionSummary.production_unit}
                        {' '}requires {formatRecipeQuantity(conversionSummary.inventory_required_quantity, conversionSummary.inventory_unit)} {inventoryRequirementUnit}.
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-indigo-800">
                        {conversionSummary.package_quantity ? (
                          <span>
                            Package basis: 1 {conversionSummary.inventory_unit} = {formatRecipeQuantity(conversionSummary.package_quantity, conversionSummary.package_unit)} {conversionSummary.package_unit}.
                          </span>
                        ) : null}
                        <span>
                          Available {formatRecipeQuantity(conversionSummary.available_quantity, conversionSummary.inventory_unit)} {conversionSummary.inventory_unit}.
                        </span>
                        {finiteProductionNumber(conversionSummary.shortage_quantity, 0) > 0 ? (
                          <span className="text-red-700">
                            Line short {formatRecipeQuantity(conversionSummary.shortage_quantity, conversionSummary.inventory_unit)} {conversionSummary.inventory_unit}.
                          </span>
                        ) : null}
                      </div>
                      {showAggregateShortageContext ? (
                        <p className="mt-1 text-red-700">
                          Selected meal total short: {formatRecipeQuantity(aggregateShortageQuantity, displayShortageUnit)} {displayShortageUnit}.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
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
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState('all');
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [formData, setFormData] = useState({
    site_id: '',
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
  const singleRecipeSnapshot = useRef({ key: '', lines: [] });
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [selectedProduction, setSelectedProduction] = useState(null);
  const [editingProduction, setEditingProduction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [estimatedBatchCost, setEstimatedBatchCost] = useState(0);
  const [estimatedCostPerServing, setEstimatedCostPerServing] = useState(0);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewAction, setReviewAction] = useState('');
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completionProduction, setCompletionProduction] = useState(null);
  const [completionJob, setCompletionJob] = useState(null);
  const [selectedConsumptionReport, setSelectedConsumptionReport] = useState(null);
  const [reportLoadingId, setReportLoadingId] = useState('');
  const [historyProduction, setHistoryProduction] = useState(null);
  const [deleteProduction, setDeleteProduction] = useState(null);
  const [reverseProduction, setReverseProduction] = useState(null);
  const [reverseReason, setReverseReason] = useState('');
  const [partialReverseProduction, setPartialReverseProduction] = useState(null);
  const [partialReverseReason, setPartialReverseReason] = useState('');
  const [partialReverseLines, setPartialReverseLines] = useState({});
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
  const [issueSnapshotSiteId, setIssueSnapshotSiteId] = useState('');
  const [issueNotes, setIssueNotes] = useState('');
  const [issueSnapshots, setIssueSnapshots] = useState({});
  const [issueSuggestions, setIssueSuggestions] = useState({});
  const [issueSuggestionLoadingKey, setIssueSuggestionLoadingKey] = useState('');
  const [editingIssueProduction, setEditingIssueProduction] = useState(null);
  const [issueAdminReissueEnabled, setIssueAdminReissueEnabled] = useState(false);

  const queryClient = useQueryClient();
  const invalidateCurrentProductionScope = useCallback(({
    approvalQueue = false,
    inventory = false,
    materialRequests = false,
    output = false
  } = {}) => {
    const activeExact = { exact: true, refetchType: 'active' };
    queryClient.invalidateQueries({ queryKey: ['productions', selectedDate], ...activeExact });
    queryClient.invalidateQueries({ queryKey: ['productionHistoryForWasteInsights', selectedDate], ...activeExact });
    queryClient.invalidateQueries({ queryKey: ['foodWasteForProduction', selectedDate], ...activeExact });
    if (approvalQueue) {
      queryClient.invalidateQueries({ queryKey: ['productionAreaApprovalQueue'], ...activeExact });
    }
    if (materialRequests) {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'], ...activeExact });
    }
    if (inventory) {
      queryClient.invalidateQueries({ queryKey: ['inventory'], ...activeExact });
      queryClient.invalidateQueries({ queryKey: ['inventoryLots'], ...activeExact });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'], ...activeExact });
      queryClient.invalidateQueries({ queryKey: ['inventoryMovements'], ...activeExact });
    }
    if (output) {
      queryClient.invalidateQueries({ queryKey: ['productionConsumptionReports'], ...activeExact });
      queryClient.invalidateQueries({ queryKey: ['producedItemBatches'], ...activeExact });
    }
  }, [queryClient, selectedDate]);

  const resetIssueDialogState = () => {
    setIssueSource(null);
    setIssueItems([]);
    setIssueSnapshots({});
    setIssueSuggestions({});
    setIssueNotes('');
    setIssueSnapshotSiteId('');
    setActiveIssueItemKey('');
    setEditingIssueProduction(null);
    setIssueAdminReissueEnabled(false);
  };

  const { data: sites = [], error: sitesError, isPending: sitesLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const { data: recipes = [], error: recipesError, isPending: recipesLoading } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const { data: ingredients = [], error: ingredientsError, isPending: ingredientsLoading } = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => base44.entities.Ingredient.list(),
    ...MASTER_DATA_QUERY_OPTIONS
  });

  const { data: productions = [], isLoading, error: productionsError } = useQuery({
    queryKey: ['productions', selectedDate],
    queryFn: () => base44.entities.Production.filter({
      production_date: selectedDate
    }, '-production_date'),
    enabled: Boolean(selectedDate),
    refetchInterval: 300000,
    ...OPERATIONAL_QUERY_OPTIONS
  });

  const { data: productionHistory = [] } = useQuery({
    queryKey: ['productionHistoryForWasteInsights', selectedDate],
    queryFn: () => base44.entities.Production.filter({ production_date: selectedDate }, '-production_date', 500),
    enabled: Boolean(selectedDate),
    ...OPERATIONAL_QUERY_OPTIONS
  });

  const { data: materialRequests = [], error: materialRequestsError } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list(),
    enabled: can('view_material_request') || can('acknowledge_material_request') || can('manage_procurement') || can('approve_procurement'),
    refetchInterval: 300000
  });

  const { data: foodWaste = [] } = useQuery({
    queryKey: ['foodWasteForProduction', selectedDate],
    queryFn: () => base44.foodWaste.list({
      start_date: selectedDate,
      end_date: selectedDate,
      limit: 1000
    }),
    enabled: can('manage_waste') && Boolean(selectedDate),
    ...OPERATIONAL_QUERY_OPTIONS
  });

  const createMutation = useMutation({
    mutationFn: (data) => (
      editingProduction
        ? base44.entities.Production.update(editingProduction.id, data)
        : base44.entities.Production.create(data)
    ),
    onSuccess: () => {
      invalidateCurrentProductionScope({ materialRequests: true });
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
      if (editingIssueProduction && !can('edit_production_request')) {
        throw new Error('You need production edit permission to update this menu production request.');
      }
      if (status === 'pending_approval' && !can('submit_production_request')) {
        throw new Error('You need production submission permission to submit this request.');
      }
      if (issueSubmitDisabledReason) throw new Error(issueSubmitDisabledReason);
      const selectedItems = selectedIssueSubmitItems;
      if (selectedItems.length === 0) {
        throw new Error('Select at least one menu item that has not already been issued.');
      }
      const mealGroups = buildMenuIssueMealGroups(selectedItems, {
        snapshotsByItemKey: issueSnapshots,
        ingredients,
        inventory,
        siteId: issueInventorySiteId
      });
      if (mealGroups.length === 0) {
        throw new Error('Select at least one meal group before issuing production.');
      }
      if (editingIssueProduction) {
        if (mealGroups.length !== 1) {
          throw new Error('Edit one meal review request at a time. Keep only this meal review selected before saving.');
        }
        const group = mealGroups[0];
        const nextPayload = buildMenuIssueSubmitData(group, status);
        const currentStatus = String(editingIssueProduction.status || 'draft').trim().toLowerCase() || 'draft';
        const contentPayload = {
          ...nextPayload,
          status: currentStatus
        };
        let updated = await base44.entities.Production.update(editingIssueProduction.id, contentPayload);
        if (status === 'pending_approval' && currentStatus !== 'pending_approval') {
          updated = await base44.entities.Production.update(editingIssueProduction.id, { status: 'pending_approval' });
        }
        return { mode: 'updated', records: [updated] };
      }
      const created = [];
      for (const group of mealGroups) {
        created.push(await base44.entities.Production.create(buildMenuIssueSubmitData(group, status)));
      }
      return { mode: 'created', records: created };
    },
    onSuccess: (result) => {
      invalidateCurrentProductionScope({ materialRequests: true });
      setIssueDialogOpen(false);
      resetIssueDialogState();
      setActionError('');
      const records = result?.records || [];
      setActionMessage(result?.mode === 'updated'
        ? 'Menu production request updated.'
        : `${records.length} meal production request${records.length === 1 ? '' : 's'} issued from the menu plan.`);
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to issue production from the menu plan.');
    }
  });

  const { data: inventory = [], error: inventoryError, isFetching: inventoryLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.inventory.getStockOnHand(),
    refetchInterval: 300000
  });

  const {
    data: reversalDiagnostics,
    isFetching: reversalDiagnosticsLoading,
    error: reversalDiagnosticsError,
    refetch: refetchReversalDiagnostics
  } = useQuery({
    queryKey: ['productionReversalDiagnostics', reverseProduction?.id || ''],
    queryFn: () => base44.inventory.getProductionReversalBlockers(reverseProduction.id),
    enabled: Boolean(reverseProduction?.id && isAdmin),
    retry: false
  });

  const completionJobForPolling = completionJob || getProductionCompletionJobFromRecord(completionProduction);
  const shouldPollCompletionJob = Boolean(
    completionOpen
    && completionProduction?.id
    && isActiveProductionCompletionJob(completionJobForPolling)
  );
  const { data: completionJobResponse } = useQuery({
    queryKey: ['productionCompletionJob', completionProduction?.id || ''],
    queryFn: () => base44.inventory.getProductionCompletionJob(completionProduction.id),
    enabled: shouldPollCompletionJob,
    refetchInterval: shouldPollCompletionJob ? 1500 : false,
    retry: false
  });

  useEffect(() => {
    const latestJob = completionJobResponse?.job || null;
    if (!latestJob) return;
    setCompletionJob(latestJob);
    if (latestJob.status === 'completed') {
      invalidateCurrentProductionScope({ inventory: true, output: true });
      setActionMessage('Production completed and finished output is available.');
      setActionError('');
      setCompletionOpen(false);
      setCompletionProduction(null);
      setCompletionJob(null);
    }
    if (latestJob.status === 'failed') {
      setActionError(latestJob.error || latestJob.message || 'Production completion failed.');
    }
  }, [completionJobResponse, invalidateCurrentProductionScope, queryClient]);

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
      invalidateCurrentProductionScope({ approvalQueue: true });
    });
    const unsubscribeRequests = base44.entities.MaterialRequest.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'], exact: true, refetchType: 'active' });
    });
    const unsubscribeInventory = base44.entities.Inventory.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['inventory'], exact: true, refetchType: 'active' });
    });
    return () => {
      unsubscribeProduction();
      unsubscribeRequests();
      unsubscribeInventory();
    };
  }, [invalidateCurrentProductionScope, queryClient]);

  const visibleSites = useMemo(() => (
    isAdmin
      ? sites
      : sites.filter((site) => allowedSiteIds.includes(site.id))
  ), [allowedSiteIds, isAdmin, sites]);
  const productionSiteOptions = useMemo(() => visibleSites.filter((site) => (
    site.is_active !== false
    && [SITE_HIERARCHY_TYPES.PROJECT, SITE_HIERARCHY_TYPES.STORE].includes(normalizeSiteType(site.type))
  )), [visibleSites]);
  const formInventoryContext = getProductionInventoryContext({
    site_id: formData.site_id,
    fulfillment_store_id: String(editingProduction?.site_id || '') === String(formData.site_id)
      ? editingProduction?.fulfillment_store_id
      : undefined
  }, visibleSites);
  const formInventorySiteId = formInventoryContext.siteId;
  const formSnapshotKey = JSON.stringify([
    formData.site_id, formInventorySiteId, formData.recipe_id,
    formData.target_servings, editingProduction?.id || ''
  ]);
  const reviewInventoryContext = getProductionInventoryContext(selectedProduction || {}, visibleSites);
  const reviewInventorySiteId = reviewInventoryContext.siteId;
  const completionInventoryContext = getProductionInventoryContext(completionProduction || {}, visibleSites);
  const completionInventorySiteId = completionInventoryContext.siteId;
  const inventoryDataLoading = sitesLoading || recipesLoading || ingredientsLoading || inventoryLoading;
  const inventoryDataError = sitesError?.message || recipesError?.message || ingredientsError?.message || inventoryError?.message || '';
  const formInventoryReady = Boolean(formInventorySiteId)
    && !inventoryDataLoading && !inventoryDataError
    && singleRecipeSnapshot.current.key === formSnapshotKey
    && calculatedIngredients.length > 0;
  const canViewAllAccessibleSites = isAdmin || [
    'general_manager',
    'assistant_general_manager',
    'area_manager'
  ].includes(currentRole);
  const issuePlan = issuePlanResponse?.plan || issueSource?.plan || null;
  const issueSite = sites.find((site) => String(site.id) === String(issueSource?.site_id || issuePlan?.site_id || '')) || null;
  const issueInventoryContext = useMemo(() => {
    if (!issueSite) {
      return { site: null, siteId: '', error: 'Select a production site.' };
    }
    const siteType = normalizeSiteType(issueSite.type);
    if (siteType === SITE_HIERARCHY_TYPES.AREA) {
      return { site: null, siteId: '', error: 'Production must be assigned to a Project or Store, not an Area.' };
    }
    if (issueSite.is_active === false) {
      return { site: null, siteId: '', error: 'The selected production site is inactive.' };
    }
    return { site: issueSite, siteId: String(issueSite.id), error: '' };
  }, [issueSite]);
  const issueInventorySiteId = issueInventoryContext.siteId;
  const issueAlreadyIssuedLockState = useMemo(() => {
    const planId = String(issuePlan?.id || issueSource?.menu_plan_id || '');
    const editingProductionId = String(editingIssueProduction?.id || '');
    return buildMenuPlanIssueLockState(productions, {
      planId,
      editingProductionId
    });
  }, [editingIssueProduction?.id, issuePlan?.id, issueSource?.menu_plan_id, productions]);
  const visibleIssueItems = issueMealView === 'all'
    ? issueItems
    : issueItems.filter((item) => item.meal_type === issueMealView);
  const activeIssueItem = visibleIssueItems.find((item) => item.key === activeIssueItemKey) || visibleIssueItems[0] || null;
  const activeIssueSnapshot = activeIssueItem ? issueSnapshots[activeIssueItem.key] || [] : [];
  const activeIssueSuggestions = activeIssueItem ? issueSuggestions[activeIssueItem.key] || {} : {};
  const activeIssueSuggestionPrefix = activeIssueItem ? `${activeIssueItem.key}|||` : '';
  const activeIssueSuggestionLoadingLine = activeIssueSuggestionPrefix && issueSuggestionLoadingKey.startsWith(activeIssueSuggestionPrefix)
    ? issueSuggestionLoadingKey.slice(activeIssueSuggestionPrefix.length)
    : '';

  const isIssueItemAlreadyIssued = (item) => isMenuPlanIssueItemAlreadyIssued(item, issueAlreadyIssuedLockState);
  const canAdminReissueIssuedItems = isAdmin && !editingIssueProduction;
  const issueAdminReissueActive = canAdminReissueIssuedItems && issueAdminReissueEnabled;
  const isIssueItemSelectionLocked = (item) => (
    isIssueItemAlreadyIssued(item) && !issueAdminReissueActive
  );

  useEffect(() => {
    const routeIssueRequest = location.state?.issueProduction;
    if (!routeIssueRequest || routeIssueRequest.source !== 'menu_planning') {
      return;
    }

    setIssueSource(routeIssueRequest);
    setIssueMealView(normalizeIssueMealView(routeIssueRequest.meal_view));
    setIssueDialogOpen(true);
    setIssueSnapshotSiteId('');
    setIssueNotes('');
    setIssueItems([]);
    setIssueSnapshots({});
    setIssueSuggestions({});
    setEditingIssueProduction(null);
    setIssueAdminReissueEnabled(false);
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
    if (!issueDialogOpen || !issuePlan || recipesLoading || recipesError) {
      return;
    }
    const items = buildMenuPlanIssueItems(issuePlan, { mealView: 'all', recipes });
    const editingItemKeys = new Set([
      ...(Array.isArray(editingIssueProduction?.source_menu_plan_item_keys)
        ? editingIssueProduction.source_menu_plan_item_keys
        : []),
      ...(Array.isArray(editingIssueProduction?.menu_issue_items)
        ? editingIssueProduction.menu_issue_items.map((item) => item?.key).filter(Boolean)
        : []),
      editingIssueProduction?.source_menu_plan_item_key
    ].filter(Boolean));
    const isEditingIssueRequest = Boolean(editingIssueProduction);
    setIssueItems((currentItems) => {
      const currentByKey = new Map(currentItems.map((item) => [item.key, item]));
      return items.map((item) => ({
        ...item,
        selected: isEditingIssueRequest
          ? editingItemKeys.has(item.key)
          : currentByKey.has(item.key) ? currentByKey.get(item.key).selected : true,
        production_covers: currentByKey.get(item.key)?.production_covers ?? item.production_covers
      }));
    });
    setActiveIssueItemKey((current) => {
      const visibleItems = issueMealView === 'all'
        ? items
        : items.filter((item) => item.meal_type === issueMealView);
      const preferredItems = isEditingIssueRequest
        ? visibleItems.filter((item) => editingItemKeys.has(item.key))
        : visibleItems;
      return visibleItems.some((item) => item.key === current)
        ? current
        : (preferredItems[0] || visibleItems[0])?.key || '';
    });
  }, [editingIssueProduction, issueDialogOpen, issueMealView, issuePlan, recipes, recipesLoading, recipesError]);

  useEffect(() => {
    if (!issueDialogOpen || issueItems.length === 0 || !issueInventorySiteId || inventoryDataLoading || inventoryDataError) {
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
            siteId: issueInventorySiteId
          }).lines;
          return;
        }

        const recipe = recipes.find((entry) => String(entry.id) === String(item.recipe_id));
        nextSnapshots[item.key] = buildProductionIngredientSnapshot({
          recipe,
          recipes,
          ingredients,
          inventory,
          siteId: issueInventorySiteId,
          targetServings: item.production_covers
        }).lines;
      });
      return nextSnapshots;
    });
    setIssueSnapshotSiteId(issueInventorySiteId);
  }, [ingredients, inventory, issueDialogOpen, issueInventorySiteId, issueItems, recipes, inventoryDataLoading, inventoryDataError]);

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

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }) => {
      if (status === 'completed') {
        return base44.inventory.completeProduction(id);
      }

      if (status === 'in_progress') {
        await base44.productionWorkflow.start(id);
        return;
      }

      await base44.entities.Production.update(id, { status });
    },
    onSuccess: (result, variables) => {
      if (variables?.status === 'completed') {
        const job = result?.job || result?.completion_job || getProductionCompletionJobFromRecord(result);
        if (job) setCompletionJob(job);
        if (isActiveProductionCompletionJob(job)) {
          invalidateCurrentProductionScope();
          setActionMessage(job.message || 'Production completion is running in the background.');
          setActionError('');
          return;
        }
        if (job?.status === 'failed') {
          setActionError(job.error || job.message || 'Production completion failed.');
          return;
        }
        invalidateCurrentProductionScope({ inventory: true, output: true });
        setActionMessage('Production completed and finished output is available.');
      } else if (variables?.status === 'in_progress') {
        invalidateCurrentProductionScope({ inventory: true, output: true });
      } else {
        invalidateCurrentProductionScope();
      }
      setCompletionOpen(false);
      setCompletionProduction(null);
      setCompletionJob(null);
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
      invalidateCurrentProductionScope({ approvalQueue: true, inventory: true });
      setInventoryAction(null);
      setInventoryActionReason('');
      setInventoryActionServings(null);
      setActionError('');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to reconcile the approved production inventory reservation.');
    }
  });

  const deleteProductionMutation = useMutation({
    mutationFn: async (production) => {
      if (!production?.id) {
        throw new Error('Select a production request to delete.');
      }
      return base44.entities.Production.delete(production.id);
    },
    onSuccess: () => {
      invalidateCurrentProductionScope({ materialRequests: true });
      setDeleteProduction(null);
      setActionError('');
      setActionMessage('Draft production request deleted.');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to delete this production request.');
    }
  });

  const reverseProductionMutation = useMutation({
    mutationFn: async ({ production, reason }) => {
      if (!production?.id) {
        throw new Error('Select a completed production to reverse.');
      }
      return base44.inventory.reverseCompletedProduction(production.id, { reason });
    },
    onSuccess: () => {
      invalidateCurrentProductionScope({ inventory: true, output: true });
      setReverseProduction(null);
      setReverseReason('');
      setActionError('');
      setActionMessage('Production completion reversed. The old card is now audit-only; create a new admin run for the corrected production.');
    },
    onError: (error, variables) => {
      if (error?.data?.details && variables?.production?.id) {
        queryClient.setQueryData(
          ['productionReversalDiagnostics', variables.production.id],
          error.data.details
        );
      }
      setActionError(error.message || 'Unable to reverse this production completion.');
    }
  });

  const partialReverseProductionMutation = useMutation({
    mutationFn: async ({ production, reason, lines }) => {
      if (!production?.id) {
        throw new Error('Select a completed production to partially reverse.');
      }
      return base44.inventory.partialReverseCompletedProduction(production.id, {
        reason,
        lines
      });
    },
    onSuccess: () => {
      invalidateCurrentProductionScope({ inventory: true, output: true });
      setPartialReverseProduction(null);
      setPartialReverseReason('');
      setPartialReverseLines({});
      setActionError('');
      setActionMessage('Selected production manifest rows were partially reversed. The full reversal action is unchanged and remains available for the remaining production.');
    },
    onError: (error) => {
      setActionError(error.message || 'Unable to partially reverse this production completion.');
    }
  });

  const repairReversalBalanceMutation = useMutation({
    mutationFn: async ({ production, reason }) => {
      if (!production?.id) {
        throw new Error('Select a completed production to repair.');
      }
      return base44.inventory.repairProductionReversalBalance(production.id, { reason });
    },
    onSuccess: (result) => {
      invalidateCurrentProductionScope({ output: true });
      queryClient.setQueryData(
        ['productionReversalDiagnostics', reverseProduction?.id || ''],
        result?.diagnostics || null
      );
      refetchReversalDiagnostics();
      setActionError('');
      setActionMessage('Stale produced-output balance repaired. Review the blocker panel, then reverse the production.');
    },
    onError: (error, variables) => {
      if (error?.data?.details && variables?.production?.id) {
        queryClient.setQueryData(
          ['productionReversalDiagnostics', variables.production.id],
          error.data.details
        );
      }
      setActionError(error.message || 'Unable to repair the produced-output batch balance.');
    }
  });

  const resetForm = () => {
    singleRecipeSnapshot.current = { key: '', lines: [] };
    setFormData({
      site_id: isAdmin
        ? ''
        : (productionSiteOptions.find((site) => String(site.id) === String(assignedSiteId || ''))?.id
          || productionSiteOptions[0]?.id
          || ''),
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
    setEstimatedBatchCost(0);
    setEstimatedCostPerServing(0);
    setSingleRecipeSuggestions({});
    setSingleRecipeSuggestionLoadingLine('');
  };

  // Calculate required ingredients and check inventory when recipe or servings change
  useEffect(() => {
    if (inventoryDataLoading || inventoryDataError) return;
    if (
      formData.recipe_id
      && formData.target_servings
      && formData.site_id
      && formInventorySiteId
    ) {
      const recipe = recipes.find(r => r.id === formData.recipe_id);
      const inventorySiteId = formInventorySiteId;
      const editingFromSameSnapshot = editingProduction
        && String(editingProduction.recipe_id || '') === String(formData.recipe_id)
        && Number(editingProduction.target_servings || 0) === Number(formData.target_servings || 0)
        && Array.isArray(editingProduction.ingredients_used)
        && editingProduction.ingredients_used.length > 0;
      const savedLines = singleRecipeSnapshot.current.key === formSnapshotKey
        ? singleRecipeSnapshot.current.lines
        : editingFromSameSnapshot ? editingProduction.ingredients_used : null;
      const snapshot = savedLines
        ? recalculateProductionIngredientSnapshot(savedLines, {
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
      singleRecipeSnapshot.current = { key: formSnapshotKey, lines: snapshot.lines };
      setCalculatedIngredients(snapshot.lines);
      setEstimatedBatchCost(snapshot.estimatedBatchCost || 0);
      setEstimatedCostPerServing(snapshot.estimatedCostPerServing ?? Number(((snapshot.estimatedBatchCost || 0) / servingCount).toFixed(2)));
    } else {
      singleRecipeSnapshot.current = { key: '', lines: [] };
      setCalculatedIngredients([]);
      setEstimatedBatchCost(0);
      setEstimatedCostPerServing(0);
    }
  }, [
    formSnapshotKey,
    formInventorySiteId,
    inventoryDataLoading,
    inventoryDataError,
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
    const fulfillmentStore = formInventoryContext.site;
    const recipe = recipes.find(r => r.id === formData.recipe_id);
    const nutritionSnapshot = calculateRecipeNutritionSnapshot(recipe, recipes, ingredients);
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
      total_calories: nutritionSnapshot?.calories_per_serving
        ? nutritionSnapshot.calories_per_serving * Number(formData.target_servings)
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
      || !formData.production_date
      || !formData.recipe_id
    ) {
      setActionError('Complete the production site, production date, recipe, and servings before saving.');
      return;
    }
    if (!formInventoryReady) {
      setActionError(formInventoryContext.error || inventoryDataError || 'Wait for the recipe ingredients and inventory check before saving.');
      return;
    }
    setActionError('');
    createMutation.mutate(buildSubmitData(status));
  };

  const buildProductionInventoryCheck = (production, fulfillmentStoreId = '') => {
    const inventorySiteId = fulfillmentStoreId || getProductionInventoryContext(production || {}, visibleSites).siteId;
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
    const inventorySiteId = getProductionInventoryContext(production || {}, visibleSites).siteId;
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
    const inventorySiteId = formInventorySiteId;
    const snapshot = recalculateProductionIngredientSnapshot(nextLines, {
      ingredients,
      inventory,
      siteId: inventorySiteId
    });
    const servingCount = Math.max(1, finiteProductionNumber(formData.target_servings, 0));
    singleRecipeSnapshot.current = { key: formSnapshotKey, lines: snapshot.lines };
    setCalculatedIngredients(snapshot.lines);
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
          unit_cost: undefined,
          estimated_cost: undefined,
          cost_quantity: undefined,
          cost_unit: selectedIngredient.unit || line.cost_unit,
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
    const inventorySiteId = formInventorySiteId;
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
      limit: 8
    });
    if (fallbackSuggestions.length === 0) {
      return [];
    }

    try {
      const result = await base44.integrations.Core.InvokeLLM({
        prompt: [
          'Suggest replacement ingredients for a production-only recipe snapshot in a food production system.',
          'Only choose from the available inventory candidates. Do not invent ingredients.',
          'Compare the full item name, including descriptors and package details, not only the first word or brand.',
          'Prefer culinary similarity, compatible units, and enough available stock. Mention allergy/dietary concerns when likely.',
          `Short ingredient: ${line.ingredient_name}. This production item requires ${formatRecipeQuantity(line.raw_quantity, line.unit)} ${line.unit}.`,
          line.aggregate_shortage
            ? `Selected-meal aggregate shortage context: ${formatRecipeQuantity(line.aggregate_shortage_quantity ?? line.shortage, line.aggregate_inventory_unit || line.inventory_unit)} ${line.aggregate_inventory_unit || line.inventory_unit}. Size the replacement for this production item, not the whole aggregate shortage.`
            : `Shortage: ${formatRecipeQuantity(line.shortage, line.inventory_unit)} ${line.inventory_unit}.`,
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
    const inventorySiteId = formInventorySiteId;
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
          unit_cost: undefined,
          estimated_cost: undefined,
          cost_quantity: undefined,
          cost_unit: suggestion.unit || line.cost_unit,
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
      siteId: issueInventorySiteId
    });
    setIssueSnapshots((current) => ({ ...current, [itemKey]: snapshot.lines }));
  };

  const updateIssueItemSnapshot = (itemKey, updater) => {
    const currentLines = issueSnapshots[itemKey] || [];
    const nextLines = typeof updater === 'function' ? updater(currentLines) : updater;
    recalculateIssueItemSnapshot(itemKey, nextLines);
  };

  const updateIssueLineQuantity = (itemKey, lineKey, value) => {
    const productionQuantity = finiteProductionNumber(value, 0);
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          raw_quantity: productionQuantity,
          production_override_action: productionQuantity > 0 ? '' : 'zeroed',
          production_override_source: 'chef',
          production_override_reason: productionQuantity > 0
            ? 'Chef adjusted quantity for this production.'
            : 'Chef zeroed this ingredient for this production.'
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
          unit_cost: undefined,
          estimated_cost: undefined,
          cost_quantity: undefined,
          cost_unit: selectedIngredient.unit || line.cost_unit,
          production_override_action: '',
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
      siteId: issueInventorySiteId
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
    if (!line || !issueInventorySiteId) return;
    setIssueSuggestionLoadingKey(`${itemKey}|||${lineKey}`);
    const suggestions = await loadReplacementSuggestions(line, issueInventorySiteId);
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
    const suggestedIngredient = ingredients.find((ingredient) => String(ingredient.id) === String(suggestion?.ingredient_id || ''));
    if (!suggestedIngredient) {
      setActionError('This replacement cannot be applied because its Ingredient master record is missing. Choose another replacement from the Ingredient list.');
      return;
    }
    updateIssueItemSnapshot(itemKey, (currentLines) => currentLines.map((line, index) => (
      getProductionIngredientLineKey(line, index) === lineKey
        ? {
          ...line,
          ingredient_id: suggestedIngredient.id,
          ingredient_name: suggestedIngredient.name || suggestion.ingredient_name,
          raw_quantity: finiteProductionNumber(suggestion.suggested_quantity, line.raw_quantity),
          unit: suggestedIngredient.unit || suggestion.unit || line.unit,
          inventory_unit: suggestedIngredient.unit || suggestion.unit || line.inventory_unit,
          unit_cost: undefined,
          estimated_cost: undefined,
          cost_quantity: undefined,
          cost_unit: suggestedIngredient.unit || suggestion.unit || line.cost_unit,
          production_override_action: '',
          production_override_source: suggestion.source === 'ai' ? 'ai_suggestion' : 'inventory_similarity',
          production_override_reason: suggestion.reason || 'Replacement selected for this production.',
          ai_suggestion_reason: suggestion.reason || ''
        }
        : line
    )));
    setActionError('');
    setIssueSuggestions((current) => ({
      ...current,
      [itemKey]: { ...(current[itemKey] || {}), [lineKey]: [] }
    }));
  };

  const handleIssueMealViewChange = (nextMealView) => {
    const normalizedMealView = normalizeIssueMealView(nextMealView);
    setIssueMealView(normalizedMealView);
  };

  const getIssueRecipe = (item = {}) => (
    recipes.find((entry) => String(entry.id) === String(item?.recipe_id || '')) || null
  );

  const getIssueItemServingGrams = (item = {}) => {
    const recipe = getIssueRecipe(item);
    if (!recipe) return 0;
    const weightSnapshot = calculateRecipeServingWeight(recipe, recipes, ingredients);
    const gramsPerServing = finiteProductionNumber(
      weightSnapshot?.yielded_grams_per_serving ?? weightSnapshot?.grams_per_serving,
      0
    );
    return gramsPerServing > 0 ? gramsPerServing : 0;
  };

  const calculateIssueSnapshotProductionKg = (lines = []) => {
    const totalGrams = (Array.isArray(lines) ? lines : []).reduce((sum, line) => {
      const ingredient = ingredients.find((entry) => String(entry.id) === String(line?.ingredient_id || ''));
      if (!ingredient) return sum;
      const effectiveIngredient = ingredientForRecipeLine(line, ingredient);
      const lineUnit = line?.unit || effectiveIngredient.unit;
      const lineQuantity = finiteProductionNumber(
        line?.yielded_quantity ?? line?.raw_quantity ?? line?.planned_quantity,
        0
      );
      if (lineQuantity <= 0 || !isIngredientUnitCompatible(lineUnit, 'g', effectiveIngredient)) {
        return sum;
      }
      const grams = convertIngredientQuantity(lineQuantity, lineUnit, 'g', effectiveIngredient);
      return Number.isFinite(grams) ? sum + grams : sum;
    }, 0);
    return roundStandardDecimal(totalGrams / 1000, 2);
  };

  const getIssueItemProductionSizeKg = (item = {}) => {
    const snapshotKg = calculateIssueSnapshotProductionKg(issueSnapshots[item.key] || []);
    if (snapshotKg > 0) return snapshotKg;
    const covers = finiteProductionNumber(item.production_covers, 0);
    const gramsPerServing = getIssueItemServingGrams(item);
    return covers > 0 && gramsPerServing > 0
      ? roundStandardDecimal((covers * gramsPerServing) / 1000, 2)
      : 0;
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
      siteId: issueInventorySiteId,
      targetServings: productionCovers
    });
    setIssueSnapshots((current) => ({ ...current, [itemKey]: snapshot.lines }));
    setIssueSuggestions((current) => ({ ...current, [itemKey]: {} }));
  };

  const updateIssueProductionSizeKg = (itemKey, value) => {
    const productionSizeKg = finiteProductionNumber(value, 0);
    const item = issueItems.find((entry) => entry.key === itemKey);
    const gramsPerServing = getIssueItemServingGrams(item);
    if (gramsPerServing <= 0) return;
    const productionCovers = (productionSizeKg * 1000) / gramsPerServing;
    updateIssueCovers(itemKey, productionCovers);
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
    const productionStore = issueInventoryContext.site || site;
    const lines = group.snapshot_lines || [];
    const estimatedBatchCost = Number((group.estimatedBatchCost || 0).toFixed(2));
    const servingCount = Math.max(1, finiteProductionNumber(group.production_covers, 0));
    const manifestItemCount = group.items.length;
    const manifestItemNames = group.items.map((item) => item.recipe_name).filter(Boolean);
    const adminReissuedItems = group.items.filter((item) => isIssueItemAlreadyIssued(item));
    const isAdminReissue = issueAdminReissueActive && adminReissuedItems.length > 0;
    const adminReissueRunId = isAdminReissue
      ? `admin-reissue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : '';
    const menuIssueItems = group.items.map((item) => {
      const itemLines = issueSnapshots[item.key] || [];
      const itemBatchCost = Number(getIssueItemSnapshotCost(item.key).toFixed(2));
      const itemServingCount = Math.max(1, finiteProductionNumber(item.production_covers, 0));
      const itemRawWeightGrams = sumReportWeights(itemLines, 'raw_weight_grams');
      const itemYieldedWeightGrams = sumReportWeights(itemLines, 'yielded_weight_grams');
      const itemAlreadyIssued = isIssueItemAlreadyIssued(item);
      return {
        key: item.key,
        original_source_menu_plan_item_key: item.key,
        admin_reissue: isAdminReissue && itemAlreadyIssued,
        admin_reissue_run_id: adminReissueRunId,
        source_menu_plan_item_index: item.source_menu_plan_item_index,
        recipe_id: item.recipe_id,
        recipe_name: item.recipe_name,
        meal_type: item.meal_type,
        expected_servings: item.expected_servings,
        production_covers: finiteProductionNumber(item.production_covers, 0),
        planned_total_cost: item.planned_total_cost,
        estimated_batch_cost: itemBatchCost,
        estimated_cost_per_serving: Number((itemBatchCost / itemServingCount).toFixed(2)),
        raw_weight_grams: itemRawWeightGrams,
        yielded_weight_grams: itemYieldedWeightGrams,
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
    const menuType = group.menu_type || issueSource?.menu_type || 'general';
    const menuCategory = group.menu_category || issueSource?.menu_category || 'senior';
    const productionEventTitle = formatProductionEventTitle({
      meal_type: group.meal_type,
      menu_type: menuType,
      menu_category: menuCategory,
      production_issue_grouped: true,
      production_issue_item_count: manifestItemCount,
      production_issue_dish_count: manifestItemCount
    }, {
      fallback: `${group.meal_label} Menu (${formatProductionItemCountLabel(manifestItemCount)})`
    });

    return {
      site_id: site?.id || group.site_id || firstItem.site_id || '',
      site_name: site?.name || group.site_name || firstItem.site_name || '',
      fulfillment_store_id: productionStore?.id || '',
      fulfillment_store_name: productionStore?.name || '',
      production_date: group.plan_date || firstItem.plan_date || issueSource?.plan_date || format(new Date(), 'yyyy-MM-dd'),
      meal_type: group.meal_type,
      menu_type: menuType,
      cuisine_type: menuType,
      menu_category: menuCategory,
      recipe_id: firstItem.recipe_id,
      recipe_name: productionEventTitle,
      target_servings: finiteProductionNumber(group.production_covers, 0),
      kitchen_station: recipe.kitchen_station || recipe.station || '',
      notes: [
        `Issued from menu plan ${issuePlan?.plan_date || group.plan_date || ''} ${group.meal_label}.`,
        isAdminReissue
          ? `Admin reissue ${adminReissueRunId}: this is an additional production run for already-issued planned item(s).`
          : '',
        manifestItemNames.length ? `Manifest items: ${manifestItemNames.join(', ')}` : '',
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
      production_issue_item_count: manifestItemCount,
      production_issue_dish_count: manifestItemCount,
      production_issue_admin_reissue: isAdminReissue,
      production_issue_reissue_run_id: adminReissueRunId,
      production_issue_reissue_original_group_key: isAdminReissue ? group.key : '',
      production_issue_reissue_original_item_keys: isAdminReissue ? group.items.map((item) => item.key) : [],
      menu_issue_items: menuIssueItems,
      recipe_snapshot_mode: 'production_only_override',
      recipe_snapshot_locked: true,
      original_recipe_snapshot: buildOriginalSnapshot(lines),
      ingredients_used: buildProductionIngredientsForSubmit(lines),
      production_overrides: productionOverrides,
      production_override_count: productionOverrides.length,
      total_calories: group.items.reduce((sum, item) => {
        const itemRecipe = recipes.find((entry) => String(entry.id) === String(item.recipe_id)) || {};
        const nutritionSnapshot = calculateRecipeNutritionSnapshot(itemRecipe, recipes, ingredients);
        return sum + (nutritionSnapshot?.calories_per_serving
          ? nutritionSnapshot.calories_per_serving * finiteProductionNumber(item.production_covers, 0)
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
    if (action === 'approve' && (reviewInventoryContext.error || inventoryDataLoading || inventoryDataError)) {
      setActionError(reviewInventoryContext.error || inventoryDataError || 'Wait for the production inventory check before approving.');
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
        await base44.entities.Production.update(operation.production.id, {
          status: operation.status,
          review_notes: reviewNotes || null,
          review_action: action === 'approve'
            ? 'approved'
            : action === 'reject'
              ? 'rejected'
              : 'changes_requested',
          ...(action === 'reject' ? { rejection_reason: reviewNotes.trim() } : {}),
          ...(action === 'approve' ? { fulfillment_store_id: reviewInventorySiteId } : {})
        });
      }
      invalidateCurrentProductionScope({
        approvalQueue: true,
        inventory: true,
        materialRequests: true
      });
      setShowApprovalDialog(false);
      setSelectedProduction(null);
      setReviewNotes('');
      setActionError('');
    } catch (error) {
      setActionError(error.message || 'Unable to review the production request.');
    } finally {
      setReviewAction('');
    }
  };

  const openApprovalDialog = (production) => {
    setActionError('');
    setSelectedProduction(production);
    setReviewNotes('');
    setReviewAction('');
    setShowApprovalDialog(true);
  };

  const isMenuIssueProduction = (production) => Boolean(
    production?.production_issue_grouped
    || production?.source_menu_plan_id
    || (Array.isArray(production?.menu_issue_items) && production.menu_issue_items.length > 0)
  );

  const openMenuIssueEditDialog = (production) => {
    const savedItems = Array.isArray(production.menu_issue_items) ? production.menu_issue_items : [];
    const itemKeys = Array.isArray(production.source_menu_plan_item_keys)
      ? production.source_menu_plan_item_keys
      : [];
    const mealView = normalizeIssueMealView(production.source_menu_plan_meal_type || production.meal_type || 'all');
    const menuType = normalizeMenuCuisine(production.menu_type || production.cuisine_type, 'general');
    const menuCategory = normalizeMenuCategory(production.menu_category, 'senior');
    const productionDate = production.production_date || selectedDate || format(new Date(), 'yyyy-MM-dd');
    const seededItems = savedItems.map((item, index) => ({
      ...item,
      key: item.key || itemKeys[index] || `${production.source_menu_plan_id || production.id}::${item.meal_type || production.meal_type || 'meal'}::${index}`,
      site_id: production.site_id || item.site_id || '',
      site_name: production.site_name || item.site_name || '',
      plan_date: productionDate,
      meal_type: item.meal_type || production.meal_type || mealView,
      meal_label: PRODUCTION_ISSUE_MEAL_LABELS[item.meal_type || production.meal_type || mealView] || 'Meal',
      menu_type: item.menu_type || menuType,
      menu_category: item.menu_category || menuCategory,
      selected: true,
      production_covers: finiteProductionNumber(item.production_covers ?? item.expected_servings, 0)
    }));
    const seededSnapshots = {};
    seededItems.forEach((item) => {
      if (Array.isArray(item.ingredients_used) && item.ingredients_used.length > 0) {
        seededSnapshots[item.key] = item.ingredients_used;
      }
    });
    if (Object.keys(seededSnapshots).length === 0 && Array.isArray(production.ingredients_used) && production.ingredients_used.length > 0) {
      const fallbackKey = seededItems[0]?.key || production.source_menu_plan_item_key || production.production_issue_group_key || '';
      if (fallbackKey) {
        seededSnapshots[fallbackKey] = production.ingredients_used;
      }
    }

    setActionError('');
    setActionMessage('');
    setEditingIssueProduction(production);
    setIssueSource({
      source: 'menu_planning',
      menu_plan_id: production.source_menu_plan_id || '',
      site_id: production.site_id || '',
      site_name: production.site_name || '',
      plan_date: productionDate,
      meal_view: mealView,
      menu_type: menuType,
      menu_category: menuCategory
    });
    setIssueMealView(mealView);
    setIssueItems(seededItems);
    setIssueSnapshots(seededSnapshots);
    setIssueSuggestions({});
    setIssueSnapshotSiteId('');
    setIssueNotes(production.notes || '');
    setIssueAdminReissueEnabled(false);
    setActiveIssueItemKey(seededItems[0]?.key || '');
    setIssueDialogOpen(true);
    if (productionDate) {
      setSelectedDate(productionDate);
    }
    if (production.site_id) {
      setSelectedSite(production.site_id);
    }
  };

  const openEditDialog = (production) => {
    if (isMenuIssueProduction(production)) {
      openMenuIssueEditDialog(production);
      return;
    }
    const menuType = normalizeMenuCuisine(production.menu_type || production.cuisine_type, 'general');
    const menuCategories = getMenuCategoryOptions(menuType);
    const persistedMenuCategory = normalizeMenuCategory(production.menu_category, 'senior');
    setActionError('');
    setEditingProduction(production);
    setFormData({
      site_id: production.site_id || '',
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
    setCompletionProduction(production);
    setCompletionJob(getProductionCompletionJobFromRecord(production));
    setActionError('');
    setActionMessage('');
    setCompletionOpen(true);
  };

  const openReverseProductionDialog = (production) => {
    setReverseProduction(production);
    setReverseReason('');
    setActionError('');
    setActionMessage('');
  };

  const openPartialReverseProductionDialog = (production) => {
    const manifestItems = getPartialReversalManifestItems(production);
    const initialLines = {};
    manifestItems.forEach((item, index) => {
      const key = getManifestItemActionKey(item, index);
      initialLines[key] = {
        selected: false,
        reverse_weight_grams: ''
      };
    });
    setPartialReverseProduction(production);
    setPartialReverseReason('');
    setPartialReverseLines(initialLines);
    setActionError('');
    setActionMessage('');
  };

  const openConsumptionReport = async (production) => {
    const reportId = production.consumption_report_id;
    if (!reportId || reportLoadingId) return;
    setReportLoadingId(String(production.id));
    setActionError('');
    try {
      const report = await base44.entities.ProductionConsumptionReport.get(reportId);
      setSelectedConsumptionReport(mergeConsumptionReportWithProduction(report, production));
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
    const productionStatus = isProductionReversedAuditRecord(production)
      ? 'reversed'
      : String(production.status || '').toLowerCase();
    const productionCompletionJob = getProductionCompletionJobFromRecord(production);
    const productionCompletionIsActive = isActiveProductionCompletionJob(productionCompletionJob);
    const canDeleteDraftProduction = isAdmin && ['draft', 'planned', 'changes_requested'].includes(productionStatus);
    const startActionLabel = productionInventoryState.is_legacy_consumption
      ? 'Start Production (Legacy Stock Already Deducted)'
      : productionInventoryState.is_reserved
        ? 'Start Production & Consume Reserved Stock'
        : 'Start Production & Consume Stock';
    if (productionStatus === 'reversed' || productionStatus === 'voided') {
      return (
        <div className="grid gap-2">
          <Button
            size="sm"
            variant="outline"
            className="justify-center whitespace-normal border-slate-300 bg-white text-xs leading-snug text-slate-700 hover:bg-slate-50"
            onClick={() => setHistoryProduction(production)}
          >
            <History className="mr-1.5 h-4 w-4" />
            What was reversed
          </Button>
        </div>
      );
    }
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
      {canDeleteDraftProduction ? (
        <Button
          size="sm"
          variant="outline"
          className="justify-center whitespace-normal border-red-200 text-xs leading-snug text-red-700 hover:bg-red-50"
          onClick={() => setDeleteProduction(production)}
          disabled={deleteProductionMutation.isPending && String(deleteProductionMutation.variables?.id || '') === String(production.id)}
        >
          <Trash2 className="mr-1.5 h-4 w-4" />
          Delete Draft
        </Button>
      ) : null}
      {production.status === 'pending_approval'
        && can('review_production_request')
        && (can('approve_production_request') || can('request_changes_production') || can('reject_production_request')) ? (
        <Button size="sm" className="justify-center whitespace-normal bg-green-600 text-xs leading-snug hover:bg-green-700" onClick={() => openApprovalDialog(production)}>
          Review Request
        </Button>
      ) : null}
      {production.status === 'pending_production' && can('start_production') ? (
        <Button size="sm" variant="outline" className="justify-center whitespace-normal text-xs leading-snug" disabled title={startBlockReason}>
          Store / Procurement Approval Required
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
          {productionCompletionIsActive
            ? (productionCompletionJob?.status === 'queued' ? 'Completion Queued...' : 'Completing...')
            : isStatusActionPending(production, 'completed')
              ? 'Starting Completion...'
              : 'Reconcile & Complete'}
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
      {production.status === 'completed' && isAdmin ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openPartialReverseProductionDialog(production)}
          disabled={partialReverseProductionMutation.isPending && String(partialReverseProductionMutation.variables?.production?.id || '') === String(production.id)}
          className="justify-center whitespace-normal border-amber-200 text-xs leading-snug text-amber-700 hover:bg-amber-50"
        >
          <History className="mr-1.5 h-4 w-4" />
          {partialReverseProductionMutation.isPending && String(partialReverseProductionMutation.variables?.production?.id || '') === String(production.id)
            ? 'Partially Reversing...'
            : 'Partial Reverse'}
        </Button>
      ) : null}
      {production.status === 'completed' && isAdmin ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openReverseProductionDialog(production)}
          disabled={reverseProductionMutation.isPending && String(reverseProductionMutation.variables?.production?.id || '') === String(production.id)}
          className="justify-center whitespace-normal border-red-200 text-xs leading-snug text-red-700 hover:bg-red-50"
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          {reverseProductionMutation.isPending && String(reverseProductionMutation.variables?.production?.id || '') === String(production.id)
            ? 'Reversing...'
            : 'Reverse Completion'}
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
  const reviewInventoryReady = Boolean(reviewInventorySiteId) && !inventoryDataLoading && !inventoryDataError;
  const reviewInventoryCheck = reviewInventoryReady ? buildProductionInventoryCheck(selectedProduction) : [];
  const inventoryActionState = getProductionInventoryState(inventoryAction || {});
  const inventoryActionPreview = inventoryActionMode === 'adjust'
    ? buildApprovedReservationPreview(inventoryAction, inventoryActionServings)
    : [];
  const inventoryActionHasShortage = inventoryActionPreview.some((line) => !line.sufficient);
  const inventoryActionReservedLineCount = inventoryActionState.lines.filter(
    (line) => Number(line.reserved_quantity ?? line.committed_quantity ?? 0) > 0
  ).length;
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
  const displayedCompletionJob = completionJob || getProductionCompletionJobFromRecord(completionProduction);
  const completionJobIsActive = isActiveProductionCompletionJob(displayedCompletionJob);
  const completionJobProgress = Math.max(0, Math.min(100, Number(displayedCompletionJob?.progress || 0)));
  const completionJobStatusLabel = displayedCompletionJob?.status === 'queued'
    ? 'Queued'
    : displayedCompletionJob?.status === 'processing'
      ? 'Processing'
      : displayedCompletionJob?.status === 'completed'
        ? 'Completed'
        : displayedCompletionJob?.status === 'failed'
          ? 'Failed'
          : '';
  const canRequestSelectedChanges = can('review_production_request') && can('request_changes_production');
  const canRejectSelected = can('review_production_request') && can('reject_production_request');
  const canApproveSelected = can('review_production_request') && can('approve_production_request');
  const siteOptions = canViewAllAccessibleSites
    ? [{ id: 'all', name: 'All Sites' }, ...productionSiteOptions]
    : productionSiteOptions;
  const visibleAlreadyIssuedIssueItems = visibleIssueItems.filter((item) => isIssueItemAlreadyIssued(item));
  const selectedIssueSubmitItems = visibleIssueItems.filter((item) => (
    item.selected
    && !isIssueItemSelectionLocked(item)
    && Number(item.production_covers) > 0
  ));
  const issueInventoryCheckState = getMenuIssueInventoryCheckState({
    siteId: issueInventorySiteId,
    snapshotSiteId: issueSnapshotSiteId,
    isLoading: inventoryDataLoading || issuePlanLoading,
    error: inventoryDataError || issuePlanError?.message || (!sitesLoading ? issueInventoryContext.error : ''),
    items: selectedIssueSubmitItems,
    snapshotsByItemKey: issueSnapshots
  });
  const issueInventoryReady = issueInventoryCheckState.ready;
  const selectedIssueMealGroups = buildMenuIssueMealGroups(selectedIssueSubmitItems, {
    snapshotsByItemKey: issueSnapshots,
    ingredients,
    inventory,
    siteId: issueInventorySiteId
  });
  const selectedIssueDailyLines = aggregateProductionIngredientLines(
    selectedIssueMealGroups.flatMap((group) => group.snapshot_lines || []),
    {
      ingredients,
      inventory,
      siteId: issueInventorySiteId
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
      on_hand_stock: aggregateShortage.on_hand_stock ?? line.on_hand_stock,
      reserved_stock: aggregateShortage.reserved_stock ?? line.reserved_stock,
      available_stock: aggregateShortage.available_stock ?? line.available_stock,
      current_stock: aggregateShortage.current_stock ?? aggregateShortage.available_stock ?? line.current_stock,
      aggregate_shortage: true,
      aggregate_shortage_quantity: aggregateShortage.shortage ?? 0,
      aggregate_inventory_unit: aggregateShortage.inventory_unit || aggregateShortage.unit || line.inventory_unit || line.unit,
      aggregate_required_quantity: aggregateShortage.raw_quantity ?? aggregateShortage.required_quantity,
      aggregate_source_recipe_names: aggregateShortage.source_recipe_names || []
    };
  });
  const activeIssueBatchCost = activeIssueItem ? Number(getIssueItemSnapshotCost(activeIssueItem.key).toFixed(2)) : 0;
  const activeIssueCostPerServing = activeIssueItem
    ? Number((activeIssueBatchCost / Math.max(1, finiteProductionNumber(activeIssueItem.production_covers, 0))).toFixed(2))
    : 0;
  const issueSubmitDisabledReason = editingIssueProduction && !can('edit_production_request')
      ? 'You need production edit permission to update this menu production request.'
      : !editingIssueProduction && !can('create_production_request')
        ? 'You need production creation permission to issue production.'
        : selectedIssueMealGroups.length === 0
        ? issueAdminReissueActive
          ? 'Enter production covers or production size greater than zero for at least one admin reissue item.'
          : 'Enter production covers greater than zero for at least one planned meal item that has not already been issued.'
        : issueInventoryCheckState.message;
  const issueSubmitForApprovalDisabledReason = issueSubmitDisabledReason
    || (!can('submit_production_request') ? 'You need production submission permission to submit this request.' : '');
  const reportEventTitle = selectedConsumptionReport
    ? formatProductionEventTitle(selectedConsumptionReport, {
      fallback: selectedConsumptionReport.production_name
        || selectedConsumptionReport.recipe_name
        || selectedConsumptionReport.report_name
        || 'Production Consumption Report'
    })
    : 'Production Consumption Report';
  const reportScopeLabel = selectedConsumptionReport
    ? getProductionEventScopeLabel(selectedConsumptionReport)
    : '';
  const reportManifestItems = arrayValue(selectedConsumptionReport?.menu_issue_items);
  const reportItemCount = selectedConsumptionReport
    ? getProductionEventItemCount(selectedConsumptionReport, reportManifestItems.length)
    : 0;
  const reportIngredientLines = selectedConsumptionReport?.ingredient_lines || [];
  const reportSourceRecipeNames = getReportSourceRecipeNames(reportIngredientLines);
  const reportSourceText = [
    selectedConsumptionReport?.quantity_basis,
    selectedConsumptionReport?.reconciliation_mode,
    selectedConsumptionReport?.output_calculation_source,
    ...reportIngredientLines.map((line) => line.quantity_basis || line.weight_calculation_source)
  ].filter(Boolean).join(' ');
  const reportUsedLegacyFallback = /legacy_(?:completion_recipe_expansion|recipe_raw_yield_fallback|recipe_raw_line_yields)|legacy recipe raw yield/i
    .test(reportSourceText);
  const reportManifestCoverageIncomplete = reportManifestItems.length > 0
    && reportSourceRecipeNames.size > 0
    && reportSourceRecipeNames.size < reportManifestItems.length;
  const reportLotLines = getReportSectionLines(selectedConsumptionReport, 'inventory_lot_usage');
  const reportShortageLines = getReportSectionLines(selectedConsumptionReport, 'shortages');
  const reportTotalRawWeightGrams = positiveOptionalNumber(selectedConsumptionReport?.total_raw_consumption_weight_grams)
    ?? positiveOptionalNumber(selectedConsumptionReport?.recipe_raw_weight_grams)
    ?? sumReportWeights(reportIngredientLines, 'raw_weight_grams')
    ?? sumManifestItemsWeight(reportManifestItems, 'raw_weight_grams');
  const reportTotalYieldedWeightGrams = positiveOptionalNumber(selectedConsumptionReport?.total_yielded_weight_grams)
    ?? positiveOptionalNumber(selectedConsumptionReport?.expected_finished_weight_grams)
    ?? positiveOptionalNumber(selectedConsumptionReport?.actual_finished_weight_grams)
    ?? positiveOptionalNumber(selectedConsumptionReport?.produced_weight_grams)
    ?? sumReportWeights(reportIngredientLines, 'yielded_weight_grams')
    ?? sumManifestItemsWeight(reportManifestItems, 'yielded_weight_grams');
  const partialReverseManifestItems = useMemo(
    () => getPartialReversalManifestItems(partialReverseProduction),
    [partialReverseProduction]
  );
  const partialReverseSelectedLines = partialReverseManifestItems
    .map((item, index) => {
      const key = getManifestItemActionKey(item, index);
      const state = partialReverseLines[key] || {};
      const reverseWeight = optionalNumber(state.reverse_weight_grams);
      const availableWeight = sumManifestItemWeight(item, 'yielded_weight_grams');
      return {
        manifest_item_key: key,
        reverse_weight_grams: reverseWeight,
        available_weight_grams: availableWeight,
        selected: Boolean(state.selected),
        name: item.recipe_name || item.name || 'Production item'
      };
    })
    .filter((line) => line.selected);
  const partialReverseTotalWeightGrams = partialReverseSelectedLines.reduce(
    (sum, line) => sum + Math.max(0, toNumber(line.reverse_weight_grams, 0)),
    0
  );
  const partialReverseInvalidLine = partialReverseSelectedLines.find((line) => (
    !Number.isFinite(Number(line.reverse_weight_grams))
    || Number(line.reverse_weight_grams) <= 0
    || (Number.isFinite(Number(line.available_weight_grams))
      && Number(line.reverse_weight_grams) - Number(line.available_weight_grams) > 0.000001)
  ));
  const partialReverseActionBlocked = Boolean(
    partialReverseProduction
    && (
      partialReverseProductionMutation.isPending
      || partialReverseSelectedLines.length === 0
      || partialReverseInvalidLine
      || !partialReverseReason.trim()
    )
  );
  const reverseActionBlocked = Boolean(
    reverseProduction
    && (
      !reversalDiagnostics
      || reversalDiagnosticsLoading
      || reversalDiagnosticsError
      || !reversalDiagnostics.can_reverse
    )
  );

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
          }));
          setFormOpen(true);
        }}
        onExport={(dashboard) => downloadCSV(
          buildProductionPlanExportRows(dashboard),
          `production_plan_${selectedDate}`
        )}
        onPrint={() => window.print()}
        renderActions={renderProductionActions}
        showAreaApprovalQueue={false}
        areaApprovalQueue={[]}
        isAreaApprovalQueueLoading={false}
        areaApprovalQueueError=""
        onReviewAreaApproval={() => {}}
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
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="site">Production Site *</Label>
                  <Select
                    value={formData.site_id}
                    onValueChange={(value) => setFormData({
                      ...formData,
                      site_id: value
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
                  {formData.site_id ? (
                    <p className={`mt-2 text-xs ${formInventoryContext.error ? 'text-amber-700' : 'text-slate-500'}`}>
                      {sitesLoading ? 'Loading production site...' : formInventoryContext.error || `Ingredients will be taken from ${formInventoryContext.site?.name}.`}
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
              {formData.recipe_id && !formInventoryReady ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
                  {inventoryDataError || (inventoryDataLoading ? 'Loading production inventory...' : formInventoryContext.error)
                    || 'Enter production covers and wait for the ingredient requirements to be calculated.'}
                </p>
              ) : null}
              {formInventoryReady && (
                <ProductionIngredientSnapshotEditor
                  lines={calculatedIngredients}
                  ingredients={ingredients}
                  inventorySiteId={formInventorySiteId}
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
              {formInventoryReady && (
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
                  disabled={createMutation.isPending || !formInventoryReady}
                  onClick={(event) => handleSubmit(event, 'draft')}
                >
                  {createMutation.isPending ? 'Saving...' : editingProduction ? 'Save Draft' : 'Create Draft'}
                </Button>
                <Button 
                  type="button" 
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={createMutation.isPending || !formInventoryReady}
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
              resetIssueDialogState();
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-h-[92vh] w-[96vw] max-w-[1500px] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex flex-col gap-2 text-xl sm:flex-row sm:items-center sm:justify-between">
                <span>{editingIssueProduction ? 'Edit Menu Production Draft' : 'Issue Menu Production'}</span>
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
                <div className="space-y-3">
                  <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-3">
                    <div className="rounded-xl bg-white px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Production site</p>
                      <p className="mt-1 break-words font-semibold text-slate-900">{issueSite?.name || issuePlan.site_name || issueSource?.site_name || 'Selected project'}</p>
                      {issueInventoryContext.site ? (
                        <p className="mt-2 text-xs text-slate-500">Inventory and finished production stay in this same site.</p>
                      ) : null}
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
                      <p className="font-semibold text-indigo-950">
                        {editingIssueProduction ? 'Meal review request to update' : 'Meal review requests to create'}
                      </p>
                      <p className="mt-1 text-sm text-indigo-800">
                        {editingIssueProduction
                          ? 'Update the saved planned items and production-only recipe snapshots for this existing request.'
                          : 'One review is created per meal type for this production day. Shortage checks below use the same aggregate demand that will appear on the dashboard.'}
                      </p>
                    </div>
                  <Badge variant="outline" className="w-fit border-indigo-200 bg-white text-indigo-700">
                    {selectedIssueMealGroups.length} review{selectedIssueMealGroups.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                  {!editingIssueProduction && visibleAlreadyIssuedIssueItems.length > 0 ? (
                    <div className={`mt-3 rounded-xl border px-3 py-3 ${
                      issueAdminReissueActive
                        ? 'border-amber-300 bg-amber-50 text-amber-950'
                        : 'border-slate-200 bg-white/80 text-slate-700'
                    }`}>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="flex gap-2">
                          <AlertCircle className={`mt-0.5 h-4 w-4 ${issueAdminReissueActive ? 'text-amber-700' : 'text-slate-500'}`} />
                          <div>
                            <p className="text-sm font-semibold">
                              {visibleAlreadyIssuedIssueItems.length} already-issued item{visibleAlreadyIssuedIssueItems.length === 1 ? '' : 's'} in this meal scope
                            </p>
                            <p className="mt-1 text-xs">
                              Use the existing production card if you are continuing the same run. Admin reissue creates an additional production request from the same planned items.
                            </p>
                          </div>
                        </div>
                        {canAdminReissueIssuedItems ? (
                          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs font-semibold text-amber-900 shadow-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-amber-300"
                              checked={issueAdminReissueActive}
                              onChange={(event) => setIssueAdminReissueEnabled(event.target.checked)}
                            />
                            Create another admin run
                          </label>
                        ) : (
                          <Badge variant="outline" className="w-fit border-slate-200 bg-slate-50 text-slate-600">
                            Admin only
                          </Badge>
                        )}
                      </div>
                    </div>
                  ) : null}
                  {selectedIssueMealGroups.length > 0 ? (
                    <div className={`mt-3 rounded-xl border px-3 py-2.5 ${
                      !issueInventoryReady
                        ? 'border-amber-200 bg-amber-50 text-amber-900'
                        : selectedIssueDailyShortages.length > 0
                        ? 'border-red-200 bg-red-50 text-red-900'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    }`}>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold">Selected-day store check</p>
                          <p className="mt-1 text-xs">
                            {issueInventoryReady
                              ? `Combined ingredient demand is checked against this same production site inventory.`
                              : issueInventoryCheckState.message}
                          </p>
                        </div>
                        <Badge className={!issueInventoryReady ? 'bg-amber-600' : selectedIssueDailyShortages.length > 0 ? 'bg-red-600' : 'bg-emerald-600'}>
                          {!issueInventoryReady ? 'Not checked' : selectedIssueDailyShortages.length > 0
                            ? `${selectedIssueDailyShortages.length} shortage${selectedIssueDailyShortages.length === 1 ? '' : 's'}`
                            : 'No shortages'}
                        </Badge>
                      </div>
                      {issueInventoryReady && selectedIssueDailyShortages.length > 0 ? (
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
                                    Used in: {line.source_recipe_names.join(', ')}
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
                                {formatProductionItemCountLabel(group.items.length)} · {formatRecipeQuantity(group.production_covers, 'servings')} covers
                              </p>
                            </div>
                            <Badge className={!issueInventoryReady ? 'bg-amber-600' : group.shortageCount > 0 ? 'bg-red-600' : 'bg-emerald-600'}>
                              {!issueInventoryReady ? 'Not checked' : group.shortageCount > 0 ? `${group.shortageCount} short` : 'No shortages'}
                            </Badge>
                          </div>
                          <p className="mt-2 text-xs text-slate-500">
                            Est. cost {issueInventoryReady ? formatCurrency(group.estimatedBatchCost) : '—'}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-lg border border-dashed border-indigo-200 bg-white/80 px-3 py-3 text-sm text-indigo-800">
                      Select planned production items below to prepare meal-level review requests.
                    </p>
                  )}
                </div>

                <div className="grid gap-4 2xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:block 2xl:space-y-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">Planned production items</p>
                          <p className="mt-1 text-sm text-slate-500">
                            {selectedIssueSubmitItems.length} items selected · {selectedIssueMealGroups.length} meal review{selectedIssueMealGroups.length === 1 ? '' : 's'}
                          </p>
                        </div>
                        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
                          {issueMealView === 'all' ? 'All' : PRODUCTION_ISSUE_MEAL_LABELS[issueMealView]}
                        </Badge>
                      </div>
                    </div>

                    {visibleIssueItems.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                        No saved menu-planning production lines were found for this meal scope.
                      </div>
                    ) : visibleIssueItems.map((item) => {
                      const alreadyIssued = isIssueItemAlreadyIssued(item);
                      const selectionLocked = isIssueItemSelectionLocked(item);
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
                              checked={Boolean(item.selected) && !selectionLocked}
                              disabled={selectionLocked}
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
                                  <Badge
                                    variant="outline"
                                    className={issueAdminReissueActive
                                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                                      : 'border-slate-200 bg-slate-50 text-slate-500'}
                                  >
                                    {issueAdminReissueActive ? 'Admin reissue' : 'Already issued'}
                                  </Badge>
                                ) : null}
                                {issueInventoryReady && itemShortageCount > 0 ? (
                                  <Badge className="bg-red-600">{itemShortageCount} short</Badge>
                                ) : null}
                                {item.production_blocked_reason ? (
                                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
                                    Needs recipe setup
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="mt-2 break-words font-semibold text-slate-950">{item.recipe_name}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                Planned {formatRecipeQuantity(item.expected_servings, 'servings')} servings · Est. cost {formatCurrency(itemCost || item.planned_total_cost)}
                              </p>
                              {item.production_blocked_reason ? (
                                <p className="mt-1 text-xs font-medium text-amber-700">
                                  {item.production_blocked_reason}
                                </p>
                              ) : null}
                            </button>
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <Label className="text-xs text-slate-500">Production covers</Label>
                              <StandardDecimalInput
                                value={item.production_covers}
                                unit="servings"
                                precision={0}
                                min={0}
                                allowZero
                                allowEmpty={false}
                                label={`${item.recipe_name} production covers`}
                                disabled={selectionLocked}
                                onValueChange={(value) => updateIssueCovers(item.key, value)}
                                className="mt-1 bg-white"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-slate-500">Production Size (Kg)</Label>
                              <StandardDecimalInput
                                value={getIssueItemProductionSizeKg(item)}
                                unit="kg"
                                precision={2}
                                min={0}
                                allowZero
                                allowEmpty={false}
                                label={`${item.recipe_name} production size in kilograms`}
                                disabled={selectionLocked || getIssueItemServingGrams(item) <= 0}
                                onValueChange={(value) => updateIssueProductionSizeKg(item.key, value)}
                                className="mt-1 bg-white"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="min-w-0 2xl:sticky 2xl:top-2 2xl:self-start">
                    {!issueInventoryReady ? (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-8 text-sm text-amber-800" role="status">
                        {issueInventoryCheckState.message}
                      </div>
                    ) : activeIssueItem ? (
                      <ProductionIngredientSnapshotEditor
                        title={`${activeIssueItem.meal_label}: ${activeIssueItem.recipe_name}`}
                        description="Chef changes here are production-only. The original recipe remains untouched."
                        lines={activeIssueSnapshotForEditor}
                        ingredients={ingredients}
                        inventorySiteId={issueInventorySiteId}
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
                        Select a planned production item to review its production recipe snapshot.
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
                    onClick={() => {
                      if (editingIssueProduction) {
                        setIssueDialogOpen(false);
                        resetIssueDialogState();
                        return;
                      }
                      navigate('/MenuPlanning');
                    }}
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    {editingIssueProduction ? 'Cancel Editing' : 'Back to Menu Planning'}
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={issueProductionMutation.isPending || Boolean(issueSubmitDisabledReason)}
                      onClick={() => issueProductionMutation.mutate({ status: 'draft' })}
                    >
                      {issueProductionMutation.isPending ? 'Saving...' : editingIssueProduction ? 'Save Draft' : 'Save Meal Drafts'}
                    </Button>
                    <Button
                      type="button"
                      className="bg-emerald-600 hover:bg-emerald-700"
                      disabled={issueProductionMutation.isPending || Boolean(issueSubmitForApprovalDisabledReason)}
                      title={issueSubmitForApprovalDisabledReason || undefined}
                      onClick={() => issueProductionMutation.mutate({ status: 'pending_approval' })}
                    >
                      <Factory className="mr-2 h-4 w-4" />
                      {issueProductionMutation.isPending
                        ? 'Submitting...'
                        : editingIssueProduction
                          ? 'Save & Submit'
                          : `Issue & Submit ${selectedIssueMealGroups.length || ''} Meal Review${selectedIssueMealGroups.length === 1 ? '' : 's'}`}
                    </Button>
                  </div>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={Boolean(deleteProduction)}
          onOpenChange={(open) => {
            if (!open && !deleteProductionMutation.isPending) {
              setDeleteProduction(null);
            }
          }}
        >
          <AlertDialogContent className="max-w-xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Draft Production Request</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm text-slate-600">
                  <p>
                    Delete “{deleteProduction?.recipe_name || 'this production request'}”
                    {deleteProduction?.site_name ? ` for ${deleteProduction.site_name}` : ''}?
                  </p>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                    This is allowed for administrators only while the production is still draft, planned, or returned for changes.
                    Any linked draft material request will be removed with it.
                  </div>
                  {deleteProduction?.linked_material_request_number || materialRequestMap[deleteProduction?.id] ? (
                    <p>
                      Linked material request:{' '}
                      <span className="font-medium text-slate-900">
                        {deleteProduction?.linked_material_request_number
                          || materialRequestMap[deleteProduction?.id]?.request_number
                          || 'Production material request'}
                      </span>
                    </p>
                  ) : null}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteProductionMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700"
                disabled={deleteProductionMutation.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  deleteProductionMutation.mutate(deleteProduction);
                }}
              >
                {deleteProductionMutation.isPending ? 'Deleting...' : 'Delete Production'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog
          open={Boolean(reverseProduction)}
          onOpenChange={(open) => {
            if (!open && !reverseProductionMutation.isPending && !repairReversalBalanceMutation.isPending) {
              setReverseProduction(null);
              setReverseReason('');
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Reverse Completed Production</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-800">
                <p className="font-semibold">
                  Admin-only direct reversal — no approval workflow will be created.
                </p>
                <p className="mt-2">
                  This will return the consumed inventory to the original lots, void the incorrect produced output,
                  mark the old production consumption report as reversed, and lock this production card as a
                  grey audit record. Create a separate admin reissue run for the corrected production.
                </p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                If any finished output has already been used by Meal Service or Food Waste, reverse those dependent
                records first. The app will block this reversal until the output is unused.
              </div>
              <ProductionReversalBlockersPanel
                diagnostics={reversalDiagnostics}
                isLoading={Boolean(reverseProduction && reversalDiagnosticsLoading)}
                error={reversalDiagnosticsError}
                repairPending={repairReversalBalanceMutation.isPending}
                onRepair={() => repairReversalBalanceMutation.mutate({
                  production: reverseProduction,
                  reason: reverseReason
                })}
              />
              <div>
                <Label htmlFor="production-reversal-reason">Reason / notes</Label>
                <Textarea
                  id="production-reversal-reason"
                  value={reverseReason}
                  onChange={(event) => setReverseReason(event.target.value)}
                  placeholder="Example: Incorrect produced weight posted; admin will complete again with the corrected values."
                  className="mt-2 min-h-[100px]"
                />
              </div>
              {actionError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                  {actionError}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={reverseProductionMutation.isPending || repairReversalBalanceMutation.isPending}
                onClick={() => {
                  setReverseProduction(null);
                  setReverseReason('');
                  setActionError('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="bg-red-600 hover:bg-red-700"
                disabled={reverseProductionMutation.isPending || repairReversalBalanceMutation.isPending || reverseActionBlocked}
                onClick={() => reverseProductionMutation.mutate({
                  production: reverseProduction,
                  reason: reverseReason
                })}
              >
                {reverseProductionMutation.isPending ? 'Reversing...' : 'Reverse Now'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(partialReverseProduction)}
          onOpenChange={(open) => {
            if (!open && !partialReverseProductionMutation.isPending) {
              setPartialReverseProduction(null);
              setPartialReverseReason('');
              setPartialReverseLines({});
              setActionError('');
            }
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Partial Production Reversal</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                <p className="font-semibold">Admin-only partial reversal for selected manifest rows.</p>
                <p className="mt-2">
                  This only reverses the selected production row weight, returns its proportional ingredient stock to the original lots,
                  and reduces the active produced balance. The full Reverse Completion button and full reversal handling remain unchanged.
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="font-semibold text-slate-900">
                  {partialReverseProduction?.recipe_name || 'Completed production'}
                </p>
                <p className="mt-1 text-slate-600">
                  Select only the filled production rows you want to reverse. If the whole production must be reversed, use the existing Reverse Completion action instead.
                </p>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">Reverse</TableHead>
                      <TableHead>Production row</TableHead>
                      <TableHead>Produced weight</TableHead>
                      <TableHead>Estimated cost</TableHead>
                      <TableHead>Weight to reverse (g)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {partialReverseManifestItems.map((item, index) => {
                      const key = getManifestItemActionKey(item, index);
                      const state = partialReverseLines[key] || {};
                      const yieldedWeight = sumManifestItemWeight(item, 'yielded_weight_grams');
                      const isSelected = Boolean(state.selected);
                      const enteredWeight = optionalNumber(state.reverse_weight_grams);
                      const isOverAvailable = isSelected
                        && enteredWeight !== null
                        && yieldedWeight !== null
                        && enteredWeight - yieldedWeight > 0.000001;
                      return (
                        <TableRow key={key} className={isOverAvailable ? 'bg-red-50/70' : ''}>
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setPartialReverseLines((current) => ({
                                  ...current,
                                  [key]: {
                                    ...(current[key] || {}),
                                    selected: checked,
                                    reverse_weight_grams: checked
                                      ? (current[key]?.reverse_weight_grams || (yieldedWeight !== null ? String(Math.round(yieldedWeight * 1000) / 1000) : ''))
                                      : current[key]?.reverse_weight_grams || ''
                                  }
                                }));
                              }}
                              aria-label={`Select ${item.recipe_name || item.name || 'production row'} for partial reversal`}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                          </TableCell>
                          <TableCell>
                            <p className="font-medium text-slate-900">{item.recipe_name || item.name || 'Production item'}</p>
                            <p className="text-xs text-slate-500">
                              {formatReportQuantity(item.production_covers ?? item.expected_servings, 'servings')} · {Array.isArray(item.ingredients_used) ? item.ingredients_used.length : 0} ingredient lines
                            </p>
                          </TableCell>
                          <TableCell>{formatReportWeightFromGrams(yieldedWeight)}</TableCell>
                          <TableCell>{formatCurrency(item.estimated_batch_cost || item.planned_total_cost || 0)}</TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="0"
                              step="0.001"
                              value={state.reverse_weight_grams ?? ''}
                              disabled={!isSelected}
                              onChange={(event) => setPartialReverseLines((current) => ({
                                ...current,
                                [key]: {
                                  ...(current[key] || {}),
                                  selected: true,
                                  reverse_weight_grams: event.target.value
                                }
                              }))}
                              className={isOverAvailable ? 'border-red-300 text-red-700' : ''}
                            />
                            {isOverAvailable ? (
                              <p className="mt-1 text-xs text-red-600">
                                Maximum available: {formatReportWeightFromGrams(yieldedWeight)}
                              </p>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {partialReverseManifestItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-6 text-center text-sm text-slate-500">
                          No filled production manifest rows are available for partial reversal.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-blue-900">
                Selected reversal total: <span className="font-semibold">{formatReportWeightFromGrams(partialReverseTotalWeightGrams)}</span>
              </div>
              <div>
                <Label htmlFor="production-partial-reversal-reason">Reason / notes *</Label>
                <Textarea
                  id="production-partial-reversal-reason"
                  value={partialReverseReason}
                  onChange={(event) => setPartialReverseReason(event.target.value)}
                  placeholder="Example: One manifest item was posted with incorrect production weight."
                  className="mt-2 min-h-[100px]"
                />
              </div>
              {partialReverseInvalidLine ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                  Check the reversal weight for {partialReverseInvalidLine.name}; it must be greater than zero and cannot exceed the row's produced weight.
                </div>
              ) : null}
              {actionError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                  {actionError}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={partialReverseProductionMutation.isPending}
                onClick={() => {
                  setPartialReverseProduction(null);
                  setPartialReverseReason('');
                  setPartialReverseLines({});
                  setActionError('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="bg-amber-600 hover:bg-amber-700"
                disabled={partialReverseActionBlocked}
                onClick={() => partialReverseProductionMutation.mutate({
                  production: partialReverseProduction,
                  reason: partialReverseReason.trim(),
                  lines: partialReverseSelectedLines.map((line) => ({
                    manifest_item_key: line.manifest_item_key,
                    reverse_weight_grams: Number(line.reverse_weight_grams)
                  }))
                })}
              >
                {partialReverseProductionMutation.isPending ? 'Partially Reversing...' : 'Reverse Selected Rows'}
              </Button>
            </DialogFooter>
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
                Project Manager Production Review
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
                  <p className="text-sm font-medium text-indigo-950">Production manifest items in this meal review</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {selectedProduction.menu_issue_items.map((item, index) => (
                      <div key={item.key || `${item.recipe_id || 'item'}-${index}`} className="rounded-lg border border-indigo-100 bg-white px-3 py-2 text-sm">
                        <p className="font-medium text-slate-900">{item.recipe_name || 'Planned item'}</p>
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

              <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
                <h4 className="font-medium text-blue-900 mb-3">Inventory Check</h4>
                <p className="mb-3 text-sm text-slate-600">
                  {inventoryDataError || (inventoryDataLoading ? 'Loading production inventory...' : reviewInventoryContext.error)
                    || `Ingredients are supplied by ${reviewInventoryContext.site?.name}.`}
                </p>
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
                      {reviewInventoryCheck.map((ing, idx) => (
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

              {reviewInventoryCheck.some(ing => !ing.sufficient) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-900">
                        Store / Procurement Action Required After PM Approval
                      </p>
                      <p className="text-sm text-amber-700 mt-1">
                        After PM approval, the linked material request moves to Store / Procurement. Store / Procurement approval reserves the yield-adjusted quantities and marks production ready to start; physical stock is deducted only when production starts.
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
                      || !reviewInventoryReady
                    }
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    {reviewAction === 'approve'
                      ? 'Approving...'
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
                {isProductionReversedAuditRecord(historyProduction)
                  ? 'Production Reversal Details'
                  : 'Production Approval History'}
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
            {isProductionReversedAuditRecord(historyProduction) ? (
              <ProductionReversalDetails production={historyProduction} />
            ) : null}
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
              Store / Procurement approval reserves inventory without deducting physical stock. Before production starts, quantity changes adjust only the reservation and preserve the selected batch, stock-date, expiry, and cost trail.
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
              setCompletionJob(null);
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
            {displayedCompletionJob ? (
              <div className={`rounded-lg border px-4 py-3 text-sm ${
                displayedCompletionJob.status === 'failed'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : displayedCompletionJob.status === 'completed'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-blue-200 bg-blue-50 text-blue-900'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    Completion status{completionJobStatusLabel ? `: ${completionJobStatusLabel}` : ''}
                  </p>
                  <span>{formatRecipeQuantity(completionJobProgress, '%')}%</span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-white/80">
                  <div
                    className={`h-2 rounded-full ${
                      displayedCompletionJob.status === 'failed'
                        ? 'bg-red-500'
                        : displayedCompletionJob.status === 'completed'
                          ? 'bg-emerald-600'
                          : 'bg-blue-600'
                    }`}
                    style={{ width: `${completionJobProgress}%` }}
                  />
                </div>
                <p className="mt-2">
                  {displayedCompletionJob.error || displayedCompletionJob.message || (
                    completionJobIsActive
                      ? 'The server is completing this production in the background.'
                      : 'No completion update is available yet.'
                  )}
                </p>
              </div>
            ) : null}
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
            <p className={`text-sm ${completionInventoryContext.error ? 'text-amber-700' : 'text-slate-600'}`}>
              {completionInventoryContext.error || `Production inventory: ${completionInventoryContext.site?.name}.`}
            </p>
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
                  || completionJobIsActive
                  || !completionInventorySiteId
                  || inventoryDataLoading
                  || Boolean(inventoryDataError)
                  || completionDerivedServings == null
                  || completionRawReconciliation.length === 0}
                onClick={() => {
                  setActionError('');
                  setActionMessage('');
                  updateStatusMutation.mutate({
                    id: completionProduction.id,
                    status: 'completed'
                  });
                }}
              >
                {completionJobIsActive
                  ? (displayedCompletionJob?.status === 'queued' ? 'Queued...' : 'Completing...')
                  : updateStatusMutation.isPending
                    ? 'Starting...'
                    : 'Complete Automatically'}
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
          <DialogContent className="max-h-[90vh] w-[96vw] max-w-[1400px] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-emerald-700" />
                {selectedConsumptionReport?.report_number
                  ? `${selectedConsumptionReport.report_number} · ${reportEventTitle}`
                  : reportEventTitle}
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="text-xs text-slate-500">Report Number</p><p className="font-semibold">{selectedConsumptionReport?.report_number}</p></div>
              <div><p className="text-xs text-slate-500">Project / Store</p><p className="font-semibold">{selectedConsumptionReport?.requesting_site_name || selectedConsumptionReport?.site_name} / {selectedConsumptionReport?.fulfillment_store_name || selectedConsumptionReport?.site_name}</p></div>
              <div><p className="text-xs text-slate-500">Completed By</p><p className="font-semibold">{selectedConsumptionReport?.completed_by_name || selectedConsumptionReport?.completed_by}</p></div>
              <div><p className="text-xs text-slate-500">Total Consumption Cost</p><p className="font-semibold text-emerald-700">{formatCurrency(selectedConsumptionReport?.total_consumption_cost || 0)}</p></div>
            </div>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Production Event Details</h3>
              <div className="grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Event</p>
                  <p className="font-semibold text-slate-950">{reportEventTitle}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Menu Scope</p>
                  <p className="font-semibold text-slate-950">
                    {reportScopeLabel || 'Not classified'}
                    {reportItemCount > 0 ? ` · ${formatProductionItemCountLabel(reportItemCount)}` : ''}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Production Date</p>
                  <p className="font-semibold text-slate-950">{selectedConsumptionReport?.production_date || 'Not recorded'}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Completed At</p>
                  <p className="font-semibold text-slate-950">{formatWorkflowTimestamp(selectedConsumptionReport?.completed_at)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Finished Kg Produced</p>
                  <p className="font-semibold text-emerald-800">{formatReportWeightFromGrams(reportTotalYieldedWeightGrams)}</p>
                  <p className="text-xs text-slate-500">Yielded finished output</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Raw Stock Consumed</p>
                  <p className="font-semibold text-slate-950">{formatReportWeightFromGrams(reportTotalRawWeightGrams)}</p>
                  <p className="text-xs text-slate-500">Before cooking/yield adjustment</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Portion / Serving Size</p>
                  <p className="font-semibold text-slate-950">{formatReportWeightFromGrams(selectedConsumptionReport?.portion_size_grams)}</p>
                  <p className="text-xs text-slate-500">Used to derive produced servings</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Production Covers</p>
                  <p className="font-semibold text-slate-950">{formatReportQuantity(selectedConsumptionReport?.target_servings, 'servings')}</p>
                  <p className="text-xs text-slate-500">Source: {formatReportSource(selectedConsumptionReport?.output_calculation_source)}</p>
                </div>
              </div>
              {reportItemCount > 0 ? (
                <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold text-emerald-900">Full production manifest</p>
                    <p className="text-emerald-700">
                      This production event contains every planned production line, including recipes and non-dish items.
                    </p>
                  </div>
                  <Badge className="w-fit border border-emerald-300 bg-emerald-100 px-4 py-1.5 text-sm font-bold text-emerald-800 hover:bg-emerald-100">
                    {formatProductionItemCountLabel(reportItemCount)}
                  </Badge>
                </div>
              ) : null}
              {reportUsedLegacyFallback || reportManifestCoverageIncomplete ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-semibold">Legacy calculation warning</p>
                  <p className="mt-1">
                    This saved PCR appears to have been posted by an older fallback path. The stock rows may represent only the recipe shown under “Used In,” while the full production manifest is listed below for reverse troubleshooting.
                  </p>
                </div>
              ) : null}
              {reportManifestItems.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Manifest Item</TableHead>
                        <TableHead>Production Covers</TableHead>
                        <TableHead>Estimated Cost</TableHead>
                        <TableHead>Snapshot Lines</TableHead>
                        <TableHead>Raw Weight</TableHead>
                        <TableHead>Yielded Weight</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reportManifestItems.map((item, index) => {
                        const rawWeight = sumManifestItemWeight(item, 'raw_weight_grams');
                        const yieldedWeight = sumManifestItemWeight(item, 'yielded_weight_grams');
                        return (
                          <TableRow key={item.key || `${item.recipe_id || 'item'}-${index}`}>
                            <TableCell className="font-medium text-slate-900">{item.recipe_name || 'Planned item'}</TableCell>
                            <TableCell>{formatReportQuantity(item.production_covers ?? item.expected_servings, 'servings')}</TableCell>
                            <TableCell>{formatCurrency(item.estimated_batch_cost || 0)}</TableCell>
                            <TableCell>{Array.isArray(item.ingredients_used) ? item.ingredients_used.length : '—'}</TableCell>
                            <TableCell>{formatReportWeightFromGrams(rawWeight)}</TableCell>
                            <TableCell>{formatReportWeightFromGrams(yieldedWeight)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold text-slate-900">Ingredient Consumption</h3>
              <p className="text-sm text-slate-500">
                Every row below is what the production posted to stock. Recipe quantities are shown beside the converted inventory quantity so unit changes are visible.
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Used In</TableHead>
                      <TableHead>Recipe Qty</TableHead>
                      <TableHead>Inventory Qty</TableHead>
                      <TableHead>Stock Issued</TableHead>
                      <TableHead>Raw Weight</TableHead>
                      <TableHead>Yield</TableHead>
                      <TableHead>Yielded Weight</TableHead>
                      <TableHead>Shortage</TableHead>
                      <TableHead>Unit / Conversion</TableHead>
                      <TableHead>Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reportIngredientLines.map((line, index) => {
                      const recipeUnit = line.recipe_unit || line.source_unit || line.unit;
                      const inventoryUnit = line.inventory_unit || line.unit;
                      const unitStatus = String(line.unit_status || '').toLowerCase();
                      const hasUnitIssue = unitStatus && unitStatus !== 'ok';
                      return (
                        <TableRow key={`${line.ingredient_id}-${index}`} className={hasUnitIssue ? 'bg-red-50/60' : ''}>
                          <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                          <TableCell className="min-w-[220px] font-medium">{line.ingredient_name}</TableCell>
                          <TableCell className="min-w-[180px] text-xs text-slate-600">
                            {Array.isArray(line.source_recipe_names) && line.source_recipe_names.length > 0
                              ? line.source_recipe_names.join(', ')
                              : reportEventTitle}
                          </TableCell>
                          <TableCell>{formatReportQuantity(line.recipe_quantity ?? line.planned_recipe_quantity ?? line.planned_quantity, recipeUnit)}</TableCell>
                          <TableCell>{formatReportQuantity(line.actual_requested_quantity, inventoryUnit)}</TableCell>
                          <TableCell>{formatReportQuantity(line.issued_quantity, inventoryUnit)}</TableCell>
                          <TableCell>{formatReportWeightFromGrams(line.raw_weight_grams)}</TableCell>
                          <TableCell>{formatReportPercent(line.yield_percent)}</TableCell>
                          <TableCell>{formatReportWeightFromGrams(line.yielded_weight_grams)}</TableCell>
                          <TableCell className={Number(line.shortage_quantity) > 0 ? 'font-semibold text-red-600' : ''}>
                            {formatReportQuantity(line.shortage_quantity, inventoryUnit)}
                          </TableCell>
                          <TableCell className="min-w-[180px]">
                            <Badge
                              variant="outline"
                              className={hasUnitIssue
                                ? 'border-red-200 bg-red-50 text-red-700'
                                : 'border-emerald-200 bg-emerald-50 text-emerald-700'}
                            >
                              {hasUnitIssue ? 'Issue' : 'OK'}
                            </Badge>
                            <p className="mt-1 text-xs text-slate-500">
                              {line.conversion_note || formatReportSource(line.quantity_basis)}
                            </p>
                          </TableCell>
                          <TableCell>{formatCurrency(line.posted_cost || 0)}</TableCell>
                        </TableRow>
                      );
                    })}
                    {reportIngredientLines.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={12} className="py-6 text-center text-sm text-slate-500">
                          No ingredient consumption lines were stored for this report.
                        </TableCell>
                      </TableRow>
                    ) : null}
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
                    {reportLotLines.map((line, index) => (
                      <TableRow key={`${line.inventory_lot_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell>{line.ingredient_name}</TableCell>
                        <TableCell>{line.batch_number || '—'}</TableCell>
                        <TableCell>{line.expiry_date || '—'}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatCurrency(line.total_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                    {reportLotLines.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-slate-500">No inventory lot movements were stored for this report.</TableCell></TableRow>
                    ) : null}
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
                    {reportShortageLines.map((line, index) => (
                      <TableRow key={`${line.ingredient_id}-${index}`}>
                        <TableCell className="font-mono text-xs text-slate-600">{line.item_code || '—'}</TableCell>
                        <TableCell>{line.ingredient_name}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.actual_requested_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatRecipeQuantity(line.issued_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell className="font-semibold text-red-600">{formatRecipeQuantity(line.shortage_quantity, line.unit)} {line.unit}</TableCell>
                        <TableCell>{formatCurrency(line.estimated_shortage_cost || 0)}</TableCell>
                      </TableRow>
                    ))}
                    {reportShortageLines.length === 0 ? (
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
